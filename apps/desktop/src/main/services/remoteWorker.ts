import { mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AdapterResolutionError, type ResolvedLora } from '@shared/adapters'
import { isWorkerLoraId, parseWorkerSelection, type RemoteWorkerProfile, type RemoteWorkerLoraItem } from '@shared/remoteWorker'
import type { JobParams } from '@shared/types'
import { codedError } from '../lib/codedError'
import { renameWithRetry } from '../lib/atomicWrite'
import { readImageHeader } from './imageHeaders'

export interface WorkerRequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  fetchImpl?: typeof fetch
  timeoutMs?: number
  bytes?: boolean
}
const memoryTokens = new Map<string, string>()
export function setMemoryWorkerToken(providerId: string, token: string | null): void {
  if (token?.trim()) memoryTokens.set(providerId, token.trim())
  else memoryTokens.delete(providerId)
}
export function getMemoryWorkerToken(providerId: string): string | undefined {
  return memoryTokens.get(providerId)
}

export async function requestWorkerDaemon<T = unknown>(
  profile: RemoteWorkerProfile,
  path: string,
  options: WorkerRequestOptions = {},
): Promise<T> {
  const base = new URL(profile.baseUrl)
  if (
    profile.kind !== 'worker-daemon' ||
    base.protocol !== 'http:' ||
    base.hostname !== '127.0.0.1' ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    !/^\/v1\//.test(path) ||
    path.includes('\\')
  )
    throw codedError('E_WORKER_CONFIG', '远端连接配置无效，请重新连接主机')
  const url = new URL(path, base)
  if (url.origin !== base.origin) throw codedError('E_WORKER_CONFIG', '远端请求地址无效')
  const token = getMemoryWorkerToken(profile.id)
  if (!token) throw codedError('E_WORKER_CREDENTIAL', '请先连接远程主机')
  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(url.href, {
      method: options.method ?? 'GET',
      redirect: 'error',
      headers: { authorization: `Bearer ${token}`, ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    })
  } catch {
    throw codedError('E_WORKER_NETWORK', '远端请求失败或超时，请检查连接')
  }
  if (!response.ok) throw codedError('E_WORKER_HTTP', `远端请求失败（HTTP ${response.status}）`)
  const limit = options.bytes ? 128 * 1024 * 1024 : 8 * 1024 * 1024
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) {
          await reader.cancel()
          throw codedError('E_WORKER_RESPONSE', '远端响应超过大小限制')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  const bytes = Buffer.concat(chunks)
  if (options.bytes) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as T
  try {
    return JSON.parse(bytes.toString('utf8')) as T
  } catch {
    throw codedError('E_WORKER_RESPONSE', '远端返回了无法识别的响应')
  }
}

const badInventory = () => codedError('E_WORKER_LORA', '远端 LoRA 清单无效，请刷新或检查配置')
export async function listRemoteWorkerLoras(
  profile: RemoteWorkerProfile,
  candidates = false,
  fetchImpl?: typeof fetch,
): Promise<{ items: RemoteWorkerLoraItem[] }> {
  const response = await requestWorkerDaemon<{ items?: unknown }>(profile, candidates ? '/v1/loras/candidates' : '/v1/loras', {
    fetchImpl,
    timeoutMs: 8000,
  })
  const rows = response?.items
  if (!Array.isArray(rows) || rows.length > 8192) throw badInventory()
  const seen = new Set<string>()
  return {
    items: rows.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || !('id' in entry) || !isWorkerLoraId(entry.id) || seen.has(entry.id)) throw badInventory()
      const bytes = 'bytes' in entry ? entry.bytes : 0
      if (
        typeof bytes !== 'number' ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        (candidates && (!('registered' in entry) || typeof entry.registered !== 'boolean'))
      )
        throw badInventory()
      seen.add(entry.id)
      return {
        id: entry.id,
        name: entry.id.split('/').at(-1)!,
        sizeBytes: bytes,
        registered: !candidates || ('registered' in entry && entry.registered === true),
      }
    }),
  }
}
export async function changeRemoteWorkerLora(
  profile: RemoteWorkerProfile,
  id: string,
  action: 'register' | 'unregister',
  fetchImpl?: typeof fetch,
): Promise<{ id: string; registered: boolean }> {
  if (!isWorkerLoraId(id) || !['register', 'unregister'].includes(action)) throw badInventory()
  const row = await requestWorkerDaemon<{ id?: unknown; registered?: unknown }>(profile, `/v1/loras/${action}`, {
    method: 'POST',
    body: { id },
    fetchImpl,
  })
  if (row?.id !== id || row.registered !== (action === 'register')) throw badInventory()
  return { id, registered: row.registered }
}
export async function resolveRemoteWorkerAdapters(
  profile: RemoteWorkerProfile,
  input: unknown,
  fetchImpl?: typeof fetch,
): Promise<ResolvedLora[]> {
  const adapters = parseWorkerSelection(input === undefined ? [] : input)
  if (!adapters.length) return []
  const { items } = await listRemoteWorkerLoras(profile, false, fetchImpl)
  const allowed = new Set(items.map((item) => item.id))
  return adapters.map((adapter) => {
    const path = adapter.path ?? adapter.id
    if (!allowed.has(path)) throw new AdapterResolutionError('所选 LoRA 尚未在远端登记，请刷新后重新选择')
    return { path, strength: adapter.strength }
  })
}

interface WorkerJob {
  id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  progress?: { phase?: string; step?: number; total_steps?: number; fraction?: number; eta_seconds?: number }
}
const active = new Map<string, { profile: RemoteWorkerProfile; remoteId: string; fetchImpl?: typeof fetch }>()
export async function cancelRemoteWorkerJob(jobId: string): Promise<boolean> {
  const job = active.get(jobId)
  if (!job) return false
  await requestWorkerDaemon(job.profile, `/v1/jobs/${encodeURIComponent(job.remoteId)}/cancel`, {
    method: 'POST',
    body: {},
    fetchImpl: job.fetchImpl,
  })
  return true
}
export async function cancelAllRemoteWorkerJobs(): Promise<void> {
  await Promise.all([...active.keys()].map(cancelRemoteWorkerJob))
}
export interface RunRemoteWorkerJobOptions {
  profile: RemoteWorkerProfile
  jobId: string
  params: JobParams
  output: string
  fetchImpl?: typeof fetch
  pollMs?: number
  deadlineMs?: number
  onEvent: (event: Record<string, unknown>) => void
}
export async function runRemoteWorkerJob(options: RunRemoteWorkerJobOptions): Promise<number> {
  const { profile, jobId, params, output, fetchImpl, onEvent } = options
  const deadline = Date.now() + (options.deadlineMs ?? 30 * 60_000)
  if (params.initImage || params.mask || params.control || params.references || params.visionReferences || params.sampling?.hires)
    throw codedError('E_WORKER_UNSUPPORTED', '远端暂不支持此任务的图片输入或二次采样，请使用文生图')
  if (active.has(jobId)) throw codedError('E_WORKER_JOB', '任务已经在运行，请勿重复提交')
  const loras = await resolveRemoteWorkerAdapters(
    profile,
    (params.adapters ?? []).map((item) => ({ id: item.path, strength: item.strength })),
    fetchImpl,
  )
  const remote = await requestWorkerDaemon<WorkerJob>(profile, '/v1/jobs', {
    method: 'POST',
    fetchImpl,
    body: {
      request_id: jobId,
      prompt: params.prompt,
      negative_prompt: params.negativePrompt,
      width: params.width,
      height: params.height,
      steps: params.steps,
      cfg: params.cfg,
      seed: params.seed,
      ...(params.sampling ?? {}),
      profile: profile.workflow?.trim() || undefined,
      loras: loras.map(({ path, strength }) => ({ id: path, strength })),
    },
  })
  if (!remote || typeof remote.id !== 'string' || !remote.id || remote.id.length > 256)
    throw codedError('E_WORKER_RESPONSE', '远端没有返回有效任务编号')
  active.set(jobId, { profile, remoteId: remote.id, fetchImpl })
  let terminal = false
  try {
    onEvent({ type: 'ready' })
    for (;;) {
      if (Date.now() >= deadline) throw codedError('E_WORKER_TIMEOUT', '远端任务超时，已请求取消')
      const job = await requestWorkerDaemon<WorkerJob>(profile, `/v1/jobs/${encodeURIComponent(remote.id)}`, {
        fetchImpl,
        timeoutMs: Math.max(1, Math.min(30_000, deadline - Date.now())),
      })
      if (!job || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(job.status))
        throw codedError('E_WORKER_RESPONSE', '远端任务状态无效')
      if (job.progress) {
        const p = job.progress
        onEvent({
          type: 'progress',
          stage: p.phase === 'text_encoder' ? 'text' : p.phase === 'dit_load' ? 'load' : p.phase === 'decode' ? 'decode' : 'denoise',
          current: p.step ?? 0,
          total: p.total_steps ?? params.steps,
          percent: (p.fraction ?? 0) * 100,
          ...(p.eta_seconds !== undefined ? { eta_ms: p.eta_seconds * 1000 } : {}),
        })
      }
      if (job.status === 'failed') {
        terminal = true
        onEvent({ type: 'error', code: 'E_WORKER_JOB', message: '远端生成失败，请检查远端服务' })
        return 1
      }
      if (job.status === 'cancelled') {
        terminal = true
        onEvent({ type: 'canceled', at_stage: 'idle' })
        return 130
      }
      if (job.status === 'succeeded') {
        terminal = true
        const bytes = Buffer.from(
          await requestWorkerDaemon<ArrayBuffer>(profile, `/v1/jobs/${encodeURIComponent(remote.id)}/image`, {
            fetchImpl,
            bytes: true,
            timeoutMs: 180_000,
          }),
        )
        const image = readImageHeader(bytes)
        if (image?.format !== 'png' || image.width !== params.width || image.height !== params.height)
          throw codedError('E_WORKER_RESPONSE', '远端未返回尺寸符合任务的 PNG')
        await mkdir(dirname(output), { recursive: true })
        const temporary = `${output}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, bytes)
          await renameWithRetry(temporary, output)
        } finally {
          await rm(temporary, { force: true })
        }
        onEvent({ type: 'result', images: [{ path: output, width: params.width, height: params.height, seed: params.seed }] })
        return 0
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(options.pollMs ?? 500, Math.max(1, deadline - Date.now()))))
    }
  } finally {
    if (!terminal) {
      try {
        await cancelRemoteWorkerJob(jobId)
      } catch {
        /* The remote service may be offline; never retry submission. */
      }
    }
    active.delete(jobId)
  }
}
