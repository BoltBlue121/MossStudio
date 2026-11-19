import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { z } from 'zod'
import { basename, extname, join } from 'node:path'
import type {
  AdapterEntry,
  ControlAdapterEntry,
  ModelEntry,
  ModelSource,
  ModelSourceFile,
  ModelSourceStatus,
  ModelSourcesView,
  ScannedModel,
  Settings,
} from '@shared/types'
import { writeFileAtomic } from '../lib/atomicWrite'
import { isInside, paths } from '../lib/paths'
import { withEngineRequests, type EngineRequest } from '../lib/probeEngine'
import { localServerPath } from './engineInstalls'
import { inspectDiffusersFolder } from './modelImports'
import { legacyModelReady } from './modelReadiness'
import { scanModelDirectory } from './modelScan'
import { guessModelSourceKind, modelPathKey, nearbyModelSources, sourceRoots } from './modelSourcePaths'
import { getSettings, updateSettings } from './settings'

const inspectionSchema = z.object({
  role: z.enum(['dit', 'text_encoder', 'vae', 'full', 'lora', 'control_adapter']),
  precision: z.string(),
  base: z.string().optional(),
  controlKinds: z.array(z.string()).optional(),
})
const cacheEntrySchema = z.object({ size: z.number(), mtimeMs: z.number(), value: z.union([inspectionSchema, z.string()]) })
const sourceKind = z.enum(['comfyui', 'webui', 'forge', 'custom'])
const discoveredSourceSchema = z.object({ kind: sourceKind, path: z.string() })
const scanFileSchema = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
  layout: z.enum(['comfyui-single-file', 'diffusers-folder', 'unknown']),
})
const sourceStatusSchema = discoveredSourceSchema.extend({
  id: z.string(),
  roots: z.array(z.string()),
  available: z.number(),
  pending: z.number(),
  incompatible: z.number(),
  issues: z.array(z.string()),
  files: z.array(
    scanFileSchema.pick({ path: true, name: true, size: true }).extend({
      role: z.enum(['dit', 'text_encoder', 'vae', 'support', 'full', 'lora', 'control_adapter']),
      state: z.enum(['available', 'pending', 'incompatible']),
    }),
  ),
})
const indexSchema = z.object({
  engine: z.string(),
  files: z.record(z.string(), cacheEntrySchema),
  snapshot: z
    .object({
      key: z.string(),
      statuses: z.array(sourceStatusSchema),
      weights: z.array(z.object({ file: scanFileSchema, inspection: inspectionSchema, sourceIds: z.array(z.string()) })),
    })
    .optional(),
})
const discoverySchema = z.object({ sources: z.array(discoveredSourceSchema) })
type Inspection = z.infer<typeof inspectionSchema>

interface SharedWeight {
  file: z.infer<typeof scanFileSchema>
  inspection: Inspection
  sourceIds: Set<string>
}

let inventory = new Map<string, SharedWeight>()
let statuses: ModelSourceStatus[] = []
let ongoing: Promise<void> | null = null
let scanGeneration = 0
let cachedEngine: string | null = null
let inventoryEngine = ''
const inspected = new Map<string, z.infer<typeof cacheEntrySchema>>()

async function loadIndex(engine: string): Promise<void> {
  const file = paths.sharedModelIndex()
  const key = file + '\0' + engine
  if (key === cachedEngine) return
  cachedEngine = key
  inspected.clear()
  if (!engine) return
  const index = await readSharedIndex()
  if (index?.engine === engine) {
    for (const [path, value] of Object.entries(index.files)) inspected.set(path, value)
  }
}

async function readSharedIndex(): Promise<z.infer<typeof indexSchema> | undefined> {
  try {
    const parsed = indexSchema.safeParse(JSON.parse(await readFile(paths.sharedModelIndex(), 'utf8')))
    if (parsed.success) return parsed.data
  } catch {
    // 缓存不可读时从共享文件重新检查。
  }
}

function idFor(path: string): string {
  return 'shared-' + createHash('sha256').update(modelPathKey(path)).digest('hex').slice(0, 24)
}

function storageRoots(settings: Settings): string[] {
  return [
    paths.models(settings.modelsRoot),
    ...Object.values(settings.modelDirectories ?? {}).filter((path): path is string => Boolean(path)),
  ]
}

function overlaps(a: string, b: string): boolean {
  return modelPathKey(a) === modelPathKey(b) || isInside(a, b) || isInside(b, a)
}

async function managedRoots(settings: Settings): Promise<string[]> {
  return Promise.all(storageRoots(settings).map((path) => realpath(path).catch(() => path)))
}

export async function assertSharedStorage(settings: Settings): Promise<void> {
  const writable = await managedRoots(settings)
  for (const source of settings.modelSources ?? []) {
    const { roots } = await sourceRoots(source)
    if (roots.some((root) => writable.some((target) => overlaps(root, target)))) {
      throw new Error('共享模型目录与下载位置重叠，请为 Moss Studio 选择单独的下载位置')
    }
  }
}

async function inspectWeight(file: ScannedModel, request: EngineRequest | null): Promise<Inspection | string | null> {
  if (file.layout === 'diffusers-folder') {
    const dir = await inspectDiffusersFolder(file.path)
    if (!dir) return '模型文件夹不完整'
    try {
      const index = JSON.parse(await readFile(join(file.path, 'model_index.json'), 'utf8')) as { _class_name?: unknown }
      if (typeof index._class_name !== 'string' || !/moss.?image/i.test(index._class_name)) return '此模型文件夹不是 MOSS-Image'
      if (dir.dtype === 'fp16') return '当前引擎不支持此 FP16 主模型'
      if (!(await legacyModelReady(file.path))) return '模型文件夹缺少运行配置或权重分片'
      return { role: 'full', precision: dir.dtype ?? 'local' }
    } catch {
      return '读不到模型配置'
    }
  }
  if (extname(file.path).toLowerCase() !== '.safetensors') return '当前引擎无法直接加载此格式'
  const key = modelPathKey(file.path)
  const cached = inspected.get(key)
  if (cached?.size === file.size && cached.mtimeMs === file.mtimeMs) return cached.value
  if (!request) return null
  try {
    const result = await request('inspect', { path: file.path })
    const kind = result.kind
    const base = typeof result.base_model === 'string' && result.base_model ? result.base_model : undefined
    let value: Inspection | string
    if (
      result.loadable === true &&
      (kind === 'dit' || kind === 'text_encoder' || kind === 'vae' || kind === 'lora' || kind === 'control_adapter')
    ) {
      const precision = typeof result.precision === 'string' ? result.precision : 'local'
      value = {
        role: kind,
        precision: precision === 'w4a4' ? 'int4' : precision,
        base,
        controlKinds: Array.isArray(result.control_kinds)
          ? result.control_kinds.filter((item): item is string => typeof item === 'string')
          : [],
      }
    } else {
      value = '当前引擎无法使用此权重'
    }
    inspected.set(key, { size: file.size, mtimeMs: file.mtimeMs, value })
    return value
  } catch {
    // 引擎或磁盘暂时无法读取时保留待检查状态，下一次刷新可以重试。
    return null
  }
}

async function sharedEngine(): Promise<{ server: string | null; key: string }> {
  const server = localServerPath()
  const info = server ? await stat(server).catch(() => null) : null
  return { server, key: server && info ? server + ':' + info.mtimeMs : '' }
}

function snapshotKey(sources: ModelSource[], writable: string[]): string {
  const locations = sources.map(({ id, kind, path }) => [id, kind, modelPathKey(path)])
  return createHash('sha256')
    .update(JSON.stringify([locations, writable.map(modelPathKey)]))
    .digest('hex')
}

/** 用上次清单恢复选择器。文件使用前仍检查真实路径、大小和修改时间。 */
export async function restoreModelSources(settings: Settings): Promise<void> {
  const sources = settings.modelSources ?? []
  if (!sources.length) return
  const [index, writable, engine] = await Promise.all([readSharedIndex(), managedRoots(settings), sharedEngine()])
  const snapshot = index?.snapshot
  if (!index || !snapshot || snapshot.key !== snapshotKey(sources, writable)) {
    await refreshModelSources(settings)
    return
  }
  const engineChanged = index.engine !== engine.key
  inventoryEngine = engine.key
  const compatible = snapshot.weights.filter(({ file }) => !engineChanged || file.layout === 'diffusers-folder')
  inventory = new Map(
    compatible.map(({ file, inspection, sourceIds }) => [idFor(file.path), { file, inspection, sourceIds: new Set(sourceIds) }]),
  )
  statuses = engineChanged
    ? snapshot.statuses.map((source) => {
        const available = source.files.filter((file) => inventory.has(idFor(file.path))).length
        return {
          ...source,
          available,
          pending: source.files.length - available,
          incompatible: 0,
          files: source.files.map((file) => ({ ...file, state: inventory.has(idFor(file.path)) ? 'available' : 'pending' })),
          issues: [...source.issues, '引擎已变更，请点击自动扫描重新检查共享权重'],
        }
      })
    : snapshot.statuses
}

async function scanSources(settings: Settings, generation: number, changed: boolean): Promise<void> {
  const sources = settings.modelSources ?? []
  const [writable, { server, key: engineKey }] = await Promise.all([managedRoots(settings), sharedEngine()])
  const unchanged = new Map<string, ModelSourceStatus>()
  if (changed && inventoryEngine === engineKey) {
    for (const source of sources) {
      const last = statuses.find((status) => status.id === source.id && status.path === source.path && status.kind === source.kind)
      if (last && !last.roots.some((root) => writable.some((target) => overlaps(root, target)))) unchanged.set(source.id, last)
    }
  }
  const roots = await Promise.all(sources.map((source) => (unchanged.has(source.id) ? Promise.resolve(null) : sourceRoots(source))))
  const readable = roots.map((item) => item?.roots.filter((root) => !writable.some((target) => overlaps(root, target))) ?? [])
  const allRoots = [...new Set([...readable.flat(), ...[...unchanged.values()].flatMap((source) => source.roots)])]
  const scans = new Map<string, Awaited<ReturnType<typeof scanModelDirectory>>>()
  await loadIndex(engineKey)
  const next = new Map<string, SharedWeight>()
  for (const [id, weight] of inventory) {
    const sourceIds = new Set([...weight.sourceIds].filter((sourceId) => unchanged.has(sourceId)))
    if (sourceIds.size) next.set(id, { ...weight, sourceIds })
  }
  const nextStatuses: ModelSourceStatus[] = []
  const groups: Array<{ status: ModelSourceStatus; files: Map<string, ScannedModel> }> = []
  for (const [index, source] of sources.entries()) {
    if (generation !== scanGeneration) return
    const kept = unchanged.get(source.id)
    if (kept) {
      nextStatuses.push(kept)
      continue
    }
    const resolved = roots[index]!
    const sourceRoots = readable[index]!
    const status: ModelSourceStatus = {
      ...source,
      roots: sourceRoots,
      available: 0,
      pending: 0,
      incompatible: 0,
      files: [],
      issues: [...resolved.issues],
    }
    nextStatuses.push(status)
    if (sourceRoots.length !== resolved.roots.length) status.issues.push('已跳过与 Moss Studio 下载位置重叠的目录')
    const files = new Map<string, ScannedModel>()
    for (const root of sourceRoots) {
      try {
        let scan = scans.get(root)
        if (!scan) {
          scan = await scanModelDirectory(root, allRoots)
          scans.set(root, scan)
        }
        const role = resolved.roles.get(root)
        for (const file of scan.candidates) {
          const id = idFor(file.path)
          if (role && file.layout !== 'diffusers-folder') files.set(id, { ...file, role })
          else if (!files.has(id)) files.set(id, file)
        }
        for (const item of scan.skipped)
          status.issues.push(item.reason.includes('已停止') ? item.reason : '部分文件夹无法读取：' + item.path)
      } catch {
        status.issues.push('读不到模型目录：' + root)
      }
    }
    groups.push({ status, files })
  }

  async function inspectGroups(request: EngineRequest | null): Promise<void> {
    const results = new Map<string, Inspection | string | null>()
    for (const { status, files } of groups) {
      status.available = status.pending = status.incompatible = 0
      status.files = []
      for (const [id, file] of files) {
        if (generation !== scanGeneration) return
        if (!results.has(id)) results.set(id, await inspectWeight(file, request))
        const result = results.get(id)
        const entry: ModelSourceFile = { path: file.path, name: file.name, size: file.size, role: file.role, state: 'pending' }
        if (typeof result === 'string') entry.state = 'incompatible'
        else if (result) {
          entry.state = 'available'
          entry.role = result.role
          const { path, name, size, mtimeMs, layout } = file
          const sourceIds = next.get(id)?.sourceIds ?? new Set<string>()
          sourceIds.add(status.id)
          next.set(id, { file: { path, name, size, mtimeMs, layout }, inspection: result, sourceIds })
        }
        status[entry.state]++
        status.files.push(entry)
      }
    }
  }

  if (generation !== scanGeneration) return
  const needsEngine = groups.some(({ files }) =>
    [...files.values()].some((file) => {
      const cached = inspected.get(modelPathKey(file.path))
      return (
        file.layout !== 'diffusers-folder' &&
        extname(file.path).toLowerCase() === '.safetensors' &&
        (cached?.size !== file.size || cached.mtimeMs !== file.mtimeMs)
      )
    }),
  )
  if (engineKey && server && needsEngine) await withEngineRequests(server, inspectGroups).catch(() => inspectGroups(null))
  else await inspectGroups(null)
  if (generation !== scanGeneration) return
  inventory = next
  inventoryEngine = engineKey
  statuses = nextStatuses
  const currentKeys = new Set(nextStatuses.flatMap((source) => source.files.map((file) => modelPathKey(file.path))))
  for (const key of inspected.keys()) if (!currentKeys.has(key)) inspected.delete(key)
  try {
    await mkdir(paths.cache(), { recursive: true })
    await writeFileAtomic(
      paths.sharedModelIndex(),
      JSON.stringify({
        engine: engineKey,
        files: Object.fromEntries(inspected),
        snapshot: {
          key: snapshotKey(sources, writable),
          statuses: nextStatuses,
          weights: [...next.values()].map((weight) => ({ ...weight, sourceIds: [...weight.sourceIds] })),
        },
      }),
    )
  } catch (error) {
    console.warn('[model-sources] 无法保存模型检查索引', error)
  }
}

/** 同时打开多个界面时只执行一次扫描，配置变动会废弃正在运行的扫描。 */
export async function refreshModelSources(settings: Settings, changed = false): Promise<void> {
  if (changed) {
    const generation = ++scanGeneration
    const active = new Set((settings.modelSources ?? []).map((source) => source.id))
    const previousPaths = new Map(statuses.map((source) => [source.id, source.path]))
    for (const source of settings.modelSources ?? []) if (previousPaths.get(source.id) !== source.path) active.delete(source.id)
    inventory = new Map([...inventory].filter(([, value]) => [...value.sourceIds].some((id) => active.has(id))))
    if (ongoing) await ongoing
    if (generation !== scanGeneration) return
    settings = getSettings()
  } else if (ongoing) return ongoing
  if (!(settings.modelSources?.length || statuses.length || inventory.size)) return
  const run = scanSources(settings, scanGeneration, changed)
  ongoing = run
  try {
    await run
  } finally {
    if (ongoing === run) ongoing = null
  }
}

let discoveryTask: { force: boolean; promise: ReturnType<typeof nearbyModelSources> } | null = null

async function discoverModelSources(force: boolean): Promise<Awaited<ReturnType<typeof nearbyModelSources>>> {
  const current = discoveryTask
  if (current) {
    if (!force || current.force) return current.promise
    await current.promise
    return discoverModelSources(true)
  }
  const cacheFile = paths.modelSourceDiscovery()
  const task = (async () => {
    if (!force) {
      try {
        const parsed = discoverySchema.safeParse(JSON.parse(await readFile(cacheFile, 'utf8')))
        if (parsed.success) return parsed.data
      } catch {
        // 首次打开或缓存损坏时才进行自动发现。
      }
    }
    const discovery = await nearbyModelSources(force)
    try {
      await mkdir(paths.cache(), { recursive: true })
      // 服务在线状态只显示在点击扫描的那次。原始历史记录不会写入缓存。
      await writeFileAtomic(cacheFile, JSON.stringify({ sources: discovery.sources }))
    } catch (error) {
      console.warn('[model-sources] 无法保存目录发现缓存', error)
    }
    return discovery
  })()
  discoveryTask = { force, promise: task }
  try {
    return await task
  } finally {
    if (discoveryTask?.promise === task) discoveryTask = null
  }
}

export async function modelSourcesView(settings: Settings, mode: 'cached' | 'connected' | 'scan' = 'cached'): Promise<ModelSourcesView> {
  const sources = settings.modelSources ?? []
  const paths = new Set(sources.map((source) => modelPathKey(source.path)))
  const discovery = mode === 'connected' ? { sources: [] } : await discoverModelSources(mode === 'scan')
  return {
    sources: sources.map(
      (source) =>
        statuses.find((status) => status.id === source.id && status.path === source.path) ?? {
          ...source,
          roots: [],
          available: 0,
          pending: 0,
          incompatible: 0,
          files: [],
          issues: [],
        },
    ),
    services: discovery.services,
    suggestions: discovery.sources
      .filter((source) => !paths.has(modelPathKey(source.path)))
      .map((source) => ({ ...source, id: idFor(source.path) })),
  }
}

export async function addModelSource(path: string, kind?: ModelSource['kind'], id?: string): Promise<Settings> {
  const actual = await realpath(path).catch(() => null)
  if (!actual) throw new Error('找不到此位置，请重新选择')
  const sourceKind = kind ?? (await guessModelSourceKind(actual))
  const existing = getSettings().modelSources ?? []
  const source = { id: id ?? randomUUID(), kind: sourceKind, path: actual }
  if (id && !existing.some((entry) => entry.id === id)) throw new Error('找不到要更换的共享目录')
  if (existing.some((entry) => entry.id !== id && modelPathKey(entry.path) === modelPathKey(actual))) {
    if (id) throw new Error('这个位置已经接入')
    return getSettings()
  }
  const modelSources = id ? existing.map((entry) => (entry.id === id ? source : entry)) : [...existing, source]
  await assertSharedStorage({ ...getSettings(), modelSources })
  // 校验期间另一窗口可能更新来源，写入时以最新设置为准。
  const current = getSettings().modelSources ?? []
  if (current !== existing && (current.length || existing.length)) throw new Error('共享目录已更新，请刷新后重试')
  return updateSettings({ modelSources })
}

export function removeModelSource(id: string): Settings {
  return updateSettings({ modelSources: (getSettings().modelSources ?? []).filter((source) => source.id !== id) })
}

export function isSharedWeight(id: string): boolean {
  return id.startsWith('shared-')
}

export async function resolveSharedWeight(id: string): Promise<string | null> {
  const entry = inventory.get(id)
  if (!entry) return null
  const { file } = entry
  try {
    if (modelPathKey(await realpath(file.path)) !== modelPathKey(file.path)) return null
    if (file.layout === 'diffusers-folder') {
      const current = await inspectDiffusersFolder(file.path)
      return current?.size === file.size && current.mtimeMs === file.mtimeMs ? file.path : null
    }
    const current = await stat(file.path)
    return current.isFile() && current.size === file.size && current.mtimeMs === file.mtimeMs ? file.path : null
  } catch {
    return null
  }
}

export function sharedModels(known: readonly ModelEntry[]): ModelEntry[] {
  const importedPaths = new Set(known.filter((entry) => entry.provider === 'local').map((entry) => modelPathKey(entry.repo)))
  return [...inventory].flatMap(([id, { file, inspection }]) => {
    if (inspection.role === 'lora' || inspection.role === 'control_adapter' || importedPaths.has(modelPathKey(file.path))) return []
    return [
      {
        id,
        name: file.name,
        role: inspection.role,
        repo: file.path,
        provider: 'local',
        localPath: file.path,
        revision: 'local',
        family: 'moss-image',
        precision: inspection.precision,
        format: file.layout === 'diffusers-folder' ? 'diffusers' : 'comfyui',
        files: [basename(file.path)],
        license: 'local',
        tags: ['shared-directory'],
        notes: '共享目录 · ' + file.path,
        sizeBytes: file.size,
        installedBytes: file.size,
        installed: true,
        installState: 'ready',
      },
    ]
  })
}

export function sharedAdapters(): AdapterEntry[] {
  return [...inventory].flatMap(([id, { file, inspection }]) =>
    inspection.role === 'lora'
      ? [
          {
            id,
            name: file.name,
            provider: 'local',
            repo: file.path,
            revision: 'local',
            kind: 'lora',
            base: inspection.base,
            license: 'local',
            files: [basename(file.path)],
            sizeBytes: file.size,
            installedBytes: file.size,
            tags: ['shared-directory'],
            notes: '共享目录 · ' + file.path,
            installed: true,
          },
        ]
      : [],
  )
}

export function sharedControlAdapters(): ControlAdapterEntry[] {
  return [...inventory].flatMap(([id, { file, inspection }]) =>
    inspection.role === 'control_adapter'
      ? [
          {
            id,
            name: file.name,
            path: file.path,
            sizeBytes: file.size,
            controlKinds: inspection.controlKinds ?? [],
            baseModel: inspection.base,
            addedAt: new Date(file.mtimeMs).toISOString(),
          },
        ]
      : [],
  )
}
