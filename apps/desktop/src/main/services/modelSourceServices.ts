import { dirname, isAbsolute } from 'node:path'
import type { ModelSourceKind } from '@shared/types'

type RunningService = { kind: Exclude<ModelSourceKind, 'custom'>; port: number; paths: string[] }

async function textAt(port: number, path: string, type: 'application/json' | 'text/html'): Promise<string | null> {
  try {
    const response = await fetch('http://127.0.0.1:' + port + path, { redirect: 'error', signal: AbortSignal.timeout(900) })
    if (!response.ok || !response.headers.get('content-type')?.includes(type) || !response.body) {
      await response.body?.cancel()
      return null
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let received = 0
    let body = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = 64 * 1024 - received
      if (value.byteLength > remaining) {
        await reader.cancel()
        return type === 'text/html' ? body + decoder.decode(value.subarray(0, remaining)) : null
      }
      received += value.byteLength
      body += decoder.decode(value, { stream: true })
    }
    return body + decoder.decode()
  } catch {
    return null
  }
}

async function jsonAt(port: number, path: string): Promise<Record<string, unknown> | null> {
  try {
    const data: unknown = JSON.parse((await textAt(port, path, 'application/json')) ?? 'null')
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function probePort(port: number): Promise<RunningService | null> {
  const comfy = await jsonAt(port, '/system_stats')
  const system = comfy?.system
  if (Array.isArray(comfy?.devices) && system && typeof system === 'object' && 'comfyui_version' in system) {
    const argv = 'argv' in system && Array.isArray(system.argv) ? system.argv : []
    const scripts = argv.filter((arg): arg is string => typeof arg === 'string' && isAbsolute(arg) && /[\\/]main\.py$/i.test(arg))
    return { kind: 'comfyui', port, paths: scripts.map(dirname) }
  }
  const flags = await jsonAt(port, '/sdapi/v1/cmd-flags')
  if (typeof flags?.api !== 'boolean' || !('ckpt_dir' in flags) || !('data_dir' in flags)) {
    const html = await textAt(port, '/', 'text/html')
    if (!html || !/<title>\s*Stable Diffusion(?: WebUI)?\s*<\/title>/i.test(html) || !/window\.gradio_config\s*=/.test(html)) return null
    return { kind: 'webui', port, paths: [] }
  }
  const paths = [flags.data_dir, flags.models_dir, flags.ckpt_dir]
    .filter((path): path is string => typeof path === 'string' && isAbsolute(path))
    .flatMap((path) => [path, dirname(path), dirname(dirname(path))])
  return { kind: 'forge_ref_a1111_home' in flags ? 'forge' : 'webui', port, paths }
}

export async function probeLocalModelServices(candidatePorts: number[]): Promise<RunningService[]> {
  const ports = [...new Set(candidatePorts)].filter((port) => Number.isInteger(port) && port > 0 && port <= 65535)
  const found = await Promise.all(ports.slice(0, 14).map(probePort))
  return found.filter((service): service is RunningService => service !== null)
}
