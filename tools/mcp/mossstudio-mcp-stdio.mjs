#!/usr/bin/env node
/**
 * Zero-dependency stdio-to-Streamable-HTTP MCP bridge for MossStudio.
 *
 * Reads newline-delimited JSON-RPC 2.0 messages from stdin, discovers the
 * running MossStudio loopback MCP server via `<dataRoot>/mcp-server.json`
 * (or MOSSSTUDIO_MCP_DISCOVERY / MOSSSTUDIO_MCP_URL + MOSSSTUDIO_MCP_TOKEN),
 * forwards requests with Bearer authentication, and prints JSON-RPC
 * responses to stdout.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

export function defaultDiscoveryPaths(env = process.env, platform = process.platform) {
  if (env.MOSSSTUDIO_MCP_DISCOVERY?.trim()) return [env.MOSSSTUDIO_MCP_DISCOVERY.trim()]
  const candidates = []
  if (env.MOSSSTUDIO_DATA_ROOT?.trim()) candidates.push(join(env.MOSSSTUDIO_DATA_ROOT.trim(), 'mcp-server.json'))
  if (env.MOSSSTUDIO_DATA?.trim()) candidates.push(join(env.MOSSSTUDIO_DATA.trim(), 'mcp-server.json'))
  if (env.CLOVER_DATA_DIR?.trim()) candidates.push(join(env.CLOVER_DATA_DIR.trim(), 'mcp-server.json'))
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const appData = env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    candidates.push(join(localAppData, 'Programs', 'MossStudio', 'data', 'mcp-server.json'))
    candidates.push(join(localAppData, 'MossStudio', 'data', 'mcp-server.json'))
    candidates.push(join(localAppData, 'MossStudio', 'mcp-server.json'))
    candidates.push(join(appData, 'MossStudio', 'mcp-server.json'))
    candidates.push(join(appData, '@clover', 'desktop', 'mcp-server.json'))
  } else if (platform === 'darwin') {
    candidates.push(join(homedir(), 'Library', 'Application Support', 'MossStudio', 'data', 'mcp-server.json'))
    candidates.push(join(homedir(), 'Library', 'Application Support', 'MossStudio', 'mcp-server.json'))
  } else {
    const xdgData = env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
    const xdgConfig = env.XDG_CONFIG_HOME || join(homedir(), '.config')
    candidates.push(join(xdgData, 'MossStudio', 'data', 'mcp-server.json'))
    candidates.push(join(xdgData, 'mossstudio', 'mcp-server.json'))
    candidates.push(join(xdgConfig, 'MossStudio', 'mcp-server.json'))
  }
  return candidates
}

async function resolveTarget(env = process.env) {
  if (env.MOSSSTUDIO_MCP_URL?.trim() && env.MOSSSTUDIO_MCP_TOKEN?.trim()) {
    return { url: env.MOSSSTUDIO_MCP_URL.trim(), token: env.MOSSSTUDIO_MCP_TOKEN.trim() }
  }
  let fallback = null
  for (const file of defaultDiscoveryPaths(env)) {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'))
      if (typeof raw?.url === 'string' && typeof raw?.token === 'string' && raw.token.length >= 16) {
        const parsed = new URL(raw.url)
        if (parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) {
          const entry = { url: raw.url, token: raw.token }
          if (isProcessAlive(raw.pid)) return entry
          if (!fallback) fallback = entry
        }
      }
    } catch {
      // Try next discovery candidate.
    }
  }
  return fallback
}

function writeOut(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

export async function forwardJsonRpcLine(line, env = process.env, fetchImpl = fetch, signal) {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON input on stdin' } }
  }
  const id = parsed && typeof parsed === 'object' && 'id' in parsed ? parsed.id : null
  const isNotification = parsed && typeof parsed === 'object' && !('id' in parsed)

  const target = await resolveTarget(env)
  if (!target) {
    if (isNotification) return null
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32001,
        message: 'MossStudio MCP server is not running. Launch MossStudio first so mcp-server.json is published.',
      },
    }
  }

  try {
    const response = await fetchImpl(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${target.token}`,
      },
      body: JSON.stringify(parsed),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
    })
    if (response.status === 202 || response.status === 204) return null
    const text = await response.text()
    if (!text.trim()) return null
    return JSON.parse(text)
  } catch (error) {
    if (isNotification) return null
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32002,
        message: `Failed to reach MossStudio MCP server at ${target.url}: ${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }
}

const isCliEntry = Boolean(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
if (isCliEntry) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const shutdown = new AbortController()
  let initBarrier = Promise.resolve()
  const inflight = new Set()

  const runLine = async (line) => {
    const reply = await forwardJsonRpcLine(line, process.env, fetch, shutdown.signal)
    if (reply !== null) writeOut(reply)
  }

  rl.on('line', (line) => {
    let method = ''
    try {
      const parsed = JSON.parse(line.trim())
      if (parsed && typeof parsed.method === 'string') method = parsed.method
    } catch {
      // Malformed JSON still gets a -32700 error reply.
    }

    if (method === 'initialize') {
      const prev = initBarrier
      const p = prev.then(() => runLine(line)).catch(() => undefined)
      initBarrier = p
      inflight.add(p)
      p.finally(() => inflight.delete(p))
    } else {
      // Wait for any in-flight initialize, then forward independent requests concurrently so slow tools never starve ping/control traffic.
      const barrier = initBarrier
      const p = barrier.then(() => runLine(line)).catch(() => undefined)
      inflight.add(p)
      p.finally(() => inflight.delete(p))
    }
  })

  rl.on('close', () => {
    shutdown.abort()
    void Promise.allSettled([...inflight])
  })
}
