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
import { posix, resolve, win32 } from 'node:path'
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
  const { join } = platform === 'win32' ? win32 : posix
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

async function resolveTarget(env, selection) {
  if (!env.MOSSSTUDIO_MCP_DISCOVERY?.trim() && env.MOSSSTUDIO_MCP_URL?.trim() && env.MOSSSTUDIO_MCP_TOKEN?.trim()) {
    return { url: env.MOSSSTUDIO_MCP_URL.trim(), token: env.MOSSSTUDIO_MCP_TOKEN.trim() }
  }
  let fallback = null
  for (const file of selection?.file ? [selection.file] : defaultDiscoveryPaths(env)) {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'))
      if (typeof raw?.url === 'string' && typeof raw?.token === 'string' && raw.token.length >= 16) {
        const parsed = new URL(raw.url)
        if (parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) {
          const { url, token, skillDigest, profile } = raw
          const entry = { file, url, token, skillDigest, profile }
          if (isProcessAlive(raw.pid)) {
            fallback = entry
            break
          }
          if (!fallback) fallback = entry
        }
      }
    } catch {
      // Try next discovery candidate.
    }
  }
  // Once selected, track that file through restarts rather than switching to a different install.
  if (selection && fallback) {
    selection.file ??= fallback.file
    if (selection.file !== fallback.file) return resolveTarget(env, selection)
  }
  return fallback
}

/** A signal aborted by any of `signals`; AbortSignal.any needs Node 20.3, and the bridge runs on the person's own node. */
export function anySignal(signals) {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

function writeOut(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

const listKeys = {
  'tools/list': 'tools',
  'resources/list': 'resources',
  'resources/templates/list': 'resourceTemplates',
  'prompts/list': 'prompts',
}
const changes = { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } }
const catalogKey = (target, health = target) => JSON.stringify([target, health.profile, health.skillDigest])

function offlineResult(method, version) {
  if (method === 'initialize')
    return {
      protocolVersion: ['2024-11-05', '2025-06-18'].includes(version) ? version : '2025-03-26',
      capabilities: changes,
      serverInfo: { name: 'mossstudio', version: 'stdio' },
    }
  if (method === 'ping') return {}
  if (Object.hasOwn(listKeys, method)) return { [listKeys[method]]: [] }
}

export async function forwardJsonRpcLine(line, env = process.env, fetchImpl = fetch, signal, selection = {}) {
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

  const { method, params } = parsed ?? {}
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
  if (parsed?.jsonrpc !== '2.0' || typeof method !== 'string') return error(-32600, 'Invalid JSON-RPC request')
  const isList = Object.hasOwn(listKeys, method)
  let status
  const send = async (target) => {
    const timeout = AbortSignal.timeout(isList || method === 'initialize' || method === 'ping' ? 1500 : 300_000)
    const response = await fetchImpl(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${target.token}`,
      },
      body: JSON.stringify(parsed),
      redirect: 'manual',
      signal: signal ? anySignal([signal, timeout]) : timeout,
    })
    status = response.status
    const text = await response.text()
    if (isNotification) return null
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`)
    const rpc = JSON.parse(text)
    const validError = Number.isInteger(rpc?.error?.code) && typeof rpc.error.message === 'string'
    if (rpc?.jsonrpc !== '2.0' || rpc.id !== id || ('result' in rpc ? 'error' in rpc : !validError))
      throw new Error('Invalid JSON-RPC reply')
    if (method === 'initialize' && rpc.result?.capabilities) {
      Object.assign(rpc.result.capabilities, changes)
      selection.catalog = catalogKey(target)
    }
    return rpc
  }
  let target = await resolveTarget(env, selection)
  for (let attempt = 0; target; attempt++) {
    try {
      return await send(target)
    } catch {
      if (!isList || !target.file || attempt || isNotification || signal?.aborted) break
      target = await resolveTarget(env, selection)
    }
  }
  if (isNotification) return null
  if (status !== undefined || signal?.aborted)
    return error(-32002, `MossStudio MCP: ${status === undefined ? 'request aborted' : `invalid response (HTTP ${status})`}`)
  const result = offlineResult(method, params?.protocolVersion)
  return result ? { jsonrpc: '2.0', id, result } : error(-32001, 'MossStudio is not running. Launch MossStudio and retry.')
}

/**
 * The bridge's line handling, without stdin and stdout: requests run
 * concurrently once `initialize` is through, and `notifications/cancelled`
 * (sent by a client whose tool call timed out) aborts the matching request, so
 * MossStudio drops an approval nobody is waiting for any more.
 */
export function createBridge({ env = process.env, fetchImpl = fetch, write = writeOut } = {}) {
  const shutdown = new AbortController()
  const requests = new Map()
  const inflight = new Set()
  let initBarrier = Promise.resolve()
  const selection = { catalog: null }
  let timer, probing, probe
  const poll = async () => {
    let current = null
    probe = new AbortController()
    try {
      const target = await resolveTarget(env, selection)
      if (target && !shutdown.signal.aborted) {
        const health = await fetchImpl(new URL('/health', target.url), {
          headers: { authorization: `Bearer ${target.token}` },
          redirect: 'manual',
          signal: anySignal([probe.signal, AbortSignal.timeout(1500)]),
        })
        const body = await health.json()
        if (health.ok && body?.ok && body.protocol === 'mcp') current = catalogKey(target, body)
      }
    } catch {
      // A stale file, bad token or dead listener projects the same empty catalog as no file.
    }
    probe = null
    if (!shutdown.signal.aborted && current !== selection.catalog) {
      selection.catalog = current
      for (const name of Object.keys(changes)) write({ jsonrpc: '2.0', method: `notifications/${name}/list_changed` })
    }
  }
  const tick = () => {
    probing ??= poll().finally(() => {
      probing = null
    })
  }

  const track = (promise) => {
    inflight.add(promise)
    void promise.finally(() => inflight.delete(promise))
    return promise
  }

  const handleLine = (line) => {
    let parsed = null
    try {
      parsed = JSON.parse(line.trim())
    } catch {
      // Malformed JSON still gets a -32700 error reply.
    }
    const method = parsed && typeof parsed.method === 'string' ? parsed.method : ''
    if (method === 'notifications/cancelled') {
      const requestId = parsed.params?.requestId
      requests.get(JSON.stringify(requestId ?? null))?.abort()
    }
    const key = parsed && typeof parsed === 'object' && 'id' in parsed ? JSON.stringify(parsed.id) : null
    const controller = new AbortController()
    if (key !== null) requests.set(key, controller)
    const run = async () => {
      const abort = () => controller.abort()
      shutdown.signal.addEventListener('abort', abort, { once: true })
      try {
        if (shutdown.signal.aborted) return
        if (method === 'notifications/initialized' && parsed.jsonrpc === '2.0' && key === null && !timer) {
          timer = setInterval(tick, 1500).unref()
          tick()
        }
        const reply = await forwardJsonRpcLine(line, env, fetchImpl, controller.signal, selection)
        // A cancelled request gets no reply: the client has already moved on.
        if (reply !== null && !controller.signal.aborted) write(reply)
      } finally {
        shutdown.signal.removeEventListener('abort', abort)
        if (key !== null && requests.get(key) === controller) requests.delete(key)
      }
    }
    if (method === 'initialize') {
      initBarrier = initBarrier.then(run).catch(() => undefined)
      return track(initBarrier)
    }
    // Independent requests run side by side, so a slow tool never starves ping or control traffic.
    return track(initBarrier.then(run).catch(() => undefined))
  }

  const close = () => {
    clearInterval(timer)
    probe?.abort()
    shutdown.abort()
    return Promise.allSettled([...inflight, probing])
  }

  return { handleLine, close }
}

const isCliEntry = Boolean(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
if (isCliEntry) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const bridge = createBridge()
  rl.on('line', (line) => void bridge.handleLine(line))
  rl.on('close', () => void bridge.close())
}
