import type { RemoteWorkerModelItem } from '@shared/remoteWorker'
import type { AdapterEntry, Catalog, DownloadTask, ModelEntry, TrainingHost } from '@shared/types'
import { codedError } from '../lib/codedError'
import { posixQuote, remoteAbsolute, sshExec } from './ssh'
import { startRemoteDownload } from './remoteDownloads'
import { assertSafeSteps, planRemoteDelete, type RemoteEntryFiles } from './remoteModelDelete'
import { deleteRemoteWorkerModels, listRemoteWorkerLoras, listRemoteWorkerModels } from './remoteWorker'
import { connectWorkerHost, isWorkerDaemonHost } from './workerHostManager'

export async function prepareRemoteDefaultModel(
  host: TrainingHost,
  repo = 'OpenMOSS-Team/MOSS-Image-SFT',
  revision = 'main',
): Promise<DownloadTask> {
  return startRemoteDownload(host, { id: 'default-sft', name: '默认 MOSS-Image SFT', repo, revision, files: [], sizeBytes: 0 })
}

export async function prepareRemoteModel(host: TrainingHost, model: ModelEntry | AdapterEntry): Promise<DownloadTask> {
  return startRemoteDownload(host, model, 'role' in model ? 'model' : 'adapter')
}

export interface RemoteModelInventoryEntry {
  id: string
  installed: boolean
  path?: string
}

export interface RemoteModelInventory {
  root: string
  files: number
  models: RemoteModelInventoryEntry[]
  adapters: RemoteModelInventoryEntry[]
  workerModels?: RemoteWorkerModelItem[]
  defaultModelId?: string | null
}

function modelMatches(entry: ModelEntry, files: string[]): string | undefined {
  const repoToken = `models--${entry.repo.replace('/', '--')}`
  const expected = entry.files?.filter(Boolean) ?? []
  const candidates = files.filter((file) => file.includes(repoToken))
  const snapshots = [
    ...new Set(candidates.map((file) => file.match(/^(.*?\/snapshots\/[^/]+)/)?.[1]).filter((path): path is string => Boolean(path))),
  ]
  for (const snapshot of snapshots) {
    const relative = candidates.filter((file) => file.startsWith(`${snapshot}/`)).map((file) => file.slice(snapshot.length + 1))
    // Match every component glob within one revision, rather than treating a
    // single file (or files from different snapshots) as an installed model.
    if (
      !expected.every((pattern) =>
        pattern.endsWith('/*') ? relative.some((file) => file.startsWith(pattern.slice(0, -1))) : relative.includes(pattern),
      )
    )
      continue
    if (entry.format !== 'comfyui' && ['dit', 'text_encoder', 'vae'].includes(entry.role)) {
      const prefix = entry.subfolder ? `${entry.subfolder}/` : ''
      const weights = relative.filter((file) => file.startsWith(prefix) && file.endsWith('.safetensors'))
      if (!relative.includes(`${prefix}config.json`) || !weights.length) continue
      const complete = weights.every((file) => {
        const shard = file.match(/^(.*-)(\d+)-of-(\d+)\.safetensors$/)
        if (!shard) return true
        const count = Number(shard[3])
        return (
          count > 0 &&
          count <= weights.length &&
          Array.from(
            { length: count },
            (_, index) => `${shard[1]}${String(index + 1).padStart(shard[2]!.length, '0')}-of-${shard[3]}.safetensors`,
          ).every((name) => relative.includes(name))
        )
      })
      if (!complete) continue
      if (
        entry.role === 'text_encoder' &&
        (!relative.includes('tokenizer/tokenizer_config.json') ||
          !(
            relative.includes('tokenizer/tokenizer.json') ||
            (relative.includes('tokenizer/vocab.json') && relative.includes('tokenizer/merges.txt'))
          ))
      )
        continue
    }
    if (entry.role === 'support' && !relative.includes('scheduler/scheduler_config.json')) continue
    if (entry.role === 'full' && !relative.includes('model_index.json')) continue
    return snapshot
  }
  return undefined
}

/**
 * Where an adapter's files are: an HF snapshot or a plain `<repo>/` folder
 * that holds EVERY listed file (one stray file is not an installed adapter).
 */
function adapterMatches(entry: AdapterEntry, files: string[]): string | undefined {
  const expected = entry.files.filter(Boolean)
  if (!expected.length) return undefined
  const repoToken = `models--${entry.repo.replace('/', '--')}`
  const marker = `/${entry.repo}/`
  const bases = new Set<string>()
  for (const file of files) {
    const snapshot = file.includes(repoToken) ? file.match(/^(.*?\/snapshots\/[^/]+)\//)?.[1] : undefined
    if (snapshot) bases.add(snapshot)
    const index = file.indexOf(marker)
    if (index >= 0) bases.add(file.slice(0, index + marker.length - 1))
  }
  const present = new Set(files)
  return [...bases].find((base) => expected.every((name) => present.has(`${base}/${name}`)))
}

async function listRemoteModelFiles(host: TrainingHost, modelsRoot?: string): Promise<{ root: string; files: string[] }> {
  const root = await remoteAbsolute(host, modelsRoot || host.modelsRoot || '~/.mossstudio/models')
  const command = `test -d ${posixQuote(root)} && find ${posixQuote(root)} -maxdepth 8 -type f -size +0c \\( -name '*.safetensors' -o -name '*.json' -o -name '*.py' -o -name '*.txt' -o -name '*.jinja' \\) -printf '%p\\n' 2>/dev/null | head -n 20000 || true`
  const result = await sshExec(host, command, 120_000)
  return {
    root,
    files: result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  }
}

function inventoryFrom(catalog: Catalog, files: string[]): Pick<RemoteModelInventory, 'models' | 'adapters'> {
  const models = catalog.models.map((entry) => {
    const path = modelMatches(entry, files)
    return { id: entry.id, installed: Boolean(path), path }
  })
  const adapters = catalog.adapters.map((entry) => {
    const path = adapterMatches(entry, files)
    return { id: entry.id, installed: Boolean(path), path }
  })
  return { models, adapters }
}

async function scanWorkerDaemonModels(host: TrainingHost, catalog: Catalog): Promise<RemoteModelInventory> {
  const profile = await connectWorkerHost(host)
  const [workerInventory, lorasResult] = await Promise.all([
    listRemoteWorkerModels(profile, false),
    listRemoteWorkerLoras(profile, true).catch(() => ({ items: [] })),
  ])
  if (workerInventory.unsupported) {
    throw codedError('E_WORKER_UNSUPPORTED', '该远端 Worker 服务暂不支持模型清单接口，请升级远端 Worker 守护进程')
  }
  const installedComponents = new Map<string, string | undefined>()
  for (const component of workerInventory.components) {
    if (component.installed) installedComponents.set(component.id, component.path)
  }
  // If a full BF16 text encoder (qwen35-encoder) is already present on the worker,
  // it satisfies the text-encoder requirement for single-file ComfyUI bundles too.
  const hasFullTe = installedComponents.has('qwen35-encoder')
  const fullTePath = installedComponents.get('qwen35-encoder')
  const installedBundleIds = new Set(workerInventory.models.map((item) => item.catalogBundleId).filter((id): id is string => Boolean(id)))
  const satisfiedByBundle = new Set<string>()
  for (const bundle of catalog.bundles) {
    if (!installedBundleIds.has(bundle.id)) continue
    for (const part of [bundle.components.dit, bundle.components.textEncoder, bundle.components.vae, bundle.support]) {
      if (part) satisfiedByBundle.add(part)
    }
  }
  const models: RemoteModelInventoryEntry[] = catalog.models.map((entry) => {
    if (installedComponents.has(entry.id)) {
      return { id: entry.id, installed: true, path: installedComponents.get(entry.id) }
    }
    if (hasFullTe && entry.role === 'text_encoder' && entry.format === 'comfyui') {
      return { id: entry.id, installed: true, path: fullTePath }
    }
    if (satisfiedByBundle.has(entry.id)) {
      return { id: entry.id, installed: true, path: workerInventory.root }
    }
    return { id: entry.id, installed: false }
  })
  const loraNames = new Set(lorasResult.items.map((item) => item.name.toLowerCase()))
  const adapters: RemoteModelInventoryEntry[] = catalog.adapters.map((entry) => {
    const matched = entry.files.length > 0 && entry.files.every((file) => loraNames.has(file.split('/').at(-1)!.toLowerCase()))
    return { id: entry.id, installed: matched, path: matched ? entry.files[0] : undefined }
  })
  return {
    root: workerInventory.root ?? '',
    files: workerInventory.models.length + workerInventory.components.length,
    models,
    adapters,
    workerModels: workerInventory.models,
    defaultModelId: workerInventory.defaultModelId ?? null,
  }
}

export async function scanRemoteModels(host: TrainingHost, catalog: Catalog, modelsRoot?: string): Promise<RemoteModelInventory> {
  if (isWorkerDaemonHost(host)) return scanWorkerDaemonModels(host, catalog)
  const { root, files } = await listRemoteModelFiles(host, modelsRoot)
  return { root, files: files.length, ...inventoryFrom(catalog, files) }
}

/**
 * Deletes catalog entries (models or LoRAs) from an SSH host, removing only
 * the files each one owns and keeping anything an entry that stays installed
 * needs (see `planRemoteDelete`). Returns what was removed and what was kept.
 */
export async function deleteRemoteModels(
  host: TrainingHost,
  catalog: Catalog,
  ids: readonly string[],
): Promise<{ removed: string[]; kept: string[] }> {
  if (isWorkerDaemonHost(host)) {
    const profile = await connectWorkerHost(host)
    return deleteRemoteWorkerModels(profile, ids)
  }
  const { root, files } = await listRemoteModelFiles(host)
  const inventory = inventoryFrom(catalog, files)
  const located: Array<RemoteEntryFiles & { installed: boolean }> = [
    ...catalog.models
      .map((entry, index) => ({ entry, found: inventory.models[index]! }))
      .map(({ entry, found }) => ({
        id: entry.id,
        base: found.path ?? '',
        patterns: entry.files?.filter(Boolean) ?? [],
        installed: found.installed,
      })),
    ...catalog.adapters
      .map((entry, index) => ({ entry, found: inventory.adapters[index]! }))
      .map(({ entry, found }) => ({
        id: entry.id,
        base: found.path ?? '',
        patterns: entry.files.filter(Boolean),
        installed: found.installed,
      })),
  ].filter((entry) => entry.base)
  const wanted = new Set(ids)
  const remove = located.filter((entry) => wanted.has(entry.id))
  if (!remove.length) throw new Error('在这台主机上找不到要删除的文件')
  const keep = located.filter((entry) => !wanted.has(entry.id) && entry.installed)
  const plan = planRemoteDelete(remove, keep, files)
  assertSafeSteps(
    plan.steps,
    root,
    remove.map((entry) => entry.base),
  )
  if (plan.steps.length) {
    const folders = plan.steps.filter((step) => step.recursive).map((step) => posixQuote(step.path))
    const single = plan.steps.filter((step) => !step.recursive).map((step) => posixQuote(step.path))
    const bases = [...new Set(remove.map((entry) => entry.base))].map(posixQuote)
    const script = [
      folders.length ? `rm -rf -- ${folders.join(' ')}` : '',
      single.length ? `rm -f -- ${single.join(' ')}` : '',
      // Tidy folders the deletion emptied, never the folders themselves when something is left.
      `for d in ${bases.join(' ')}; do test -d "$d" && find "$d" -depth -type d -empty -delete; done; true`,
    ]
      .filter(Boolean)
      .join(' && ')
    const result = await sshExec(host, script, 120_000)
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().slice(-1200) || '删除失败')
  }
  return { removed: plan.steps.map((step) => step.path), kept: plan.kept }
}
