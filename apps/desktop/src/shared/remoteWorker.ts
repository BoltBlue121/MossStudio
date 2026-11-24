import { ADAPTERS_PER_CANVAS_MAX, isAdapterId } from './adapters'
import type { CanvasAdapter } from './types'

export function isWorkerSamplingKey(key: string): key is 'sampler' | 'scheduler' {
  return key === 'sampler' || key === 'scheduler'
}

export interface RemoteWorkerProfile {
  id: string
  kind: 'worker-daemon'
  label: string
  baseUrl: string
  hostId: string
  workflow?: string
}

export interface RemoteWorkerLoraItem {
  id: string
  name: string
  sizeBytes: number
  registered: boolean
}

/** Only portable, worker-relative identifiers cross the registry boundary. */
export function isWorkerLoraId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 1024 &&
    /\.safetensors$/i.test(value) &&
    value.split('/').at(-1)?.toLowerCase() !== '.safetensors' &&
    !/[\\:<>"|?*]/u.test(value) &&
    !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    value
      .split('/')
      .every(
        (part) =>
          part.length > 0 && part.length <= 255 && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
}

export function workerCanvasAdapter(workerId: string, strength: number): CanvasAdapter {
  if (!isWorkerLoraId(workerId)) throw new Error('LoRA 必须使用远端清单中的相对名称')
  if (!Number.isFinite(strength) || strength < 0 || strength > 2) throw new Error('LoRA 强度必须在 0 到 2 之间')
  const portableKey: boolean = isAdapterId(workerId)
  if (portableKey) return { id: workerId, strength }
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < workerId.length; index++)
    hash = BigInt.asUintN(64, (hash ^ BigInt(workerId.charCodeAt(index))) * 0x100000001b3n)
  return { id: `worker-${hash.toString(16)}`, path: workerId, strength }
}

export function parseWorkerSelection(input: unknown): CanvasAdapter[] {
  if (!Array.isArray(input) || input.length > ADAPTERS_PER_CANVAS_MAX) throw new Error('LoRA 选择无效或数量超限')
  const seen = new Set<string>()
  return input.map((row: unknown) => {
    if (!row || typeof row !== 'object' || !('id' in row) || typeof row.id !== 'string') throw new Error('LoRA 选择缺少名称')
    const remote = 'path' in row ? row.path : row.id
    if (!isWorkerLoraId(remote) || ('path' in row && !isAdapterId(row.id)) || seen.has(remote)) throw new Error('LoRA 名称无效或重复')
    seen.add(remote)
    const strength = 'strength' in row ? row.strength : 1
    if (typeof strength !== 'number') throw new Error('LoRA 强度必须是数字')
    return workerCanvasAdapter(remote, strength)
  })
}
