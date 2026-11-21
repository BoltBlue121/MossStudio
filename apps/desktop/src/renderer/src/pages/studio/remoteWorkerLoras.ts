import type { AdapterEntry, CanvasAdapter, Catalog, LoraMetadata, ManagedHost, ModelBundle, RemoteHostBackend } from '@shared/types'
import type { RemoteWorkerLoraItem } from '@shared/remoteWorker'
import { isWorkerLoraId, workerCanvasAdapter } from '@shared/remoteWorker'
import type { BundleChoice } from './readiness'

/**
 * A Worker daemon picked as 运行位置 is used exactly like an SSH host: the
 * same `hostId`, the same LoRA picker. Only the data behind them differs: the
 * Worker owns its model weights and its LoRA inventory, so nothing on this
 * computer has to be downloaded first.
 */

export type WorkerLoraItem = RemoteWorkerLoraItem & LoraMetadata

/** A LoRA of a Worker, shaped as a library entry so the picker and the 画面 rows read it unchanged. */
export type WorkerAdapterEntry = AdapterEntry & LoraMetadata & { workerId: string; registered: boolean }

export function isWorkerDaemonHost(
  host: { remoteBackend?: RemoteHostBackend } | null | undefined,
): host is { remoteBackend: 'worker-daemon' } {
  return host?.remoteBackend === 'worker-daemon'
}

/** Same rule as main's `workerHostProviderId`: the id its connected profile (and model) carries. */
export function workerProviderId(host: Pick<ManagedHost, 'id' | 'workerProviderId'>): string {
  const custom = host.workerProviderId?.trim()
  if (custom && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(custom)) return custom
  return `worker-${host.id}`
}

/**
 * The model a run on a Worker host uses: the one main lists for its connected
 * profile, or the same id when the catalog has not caught up yet. Main routes
 * a `remote-worker:` binding to the Worker and checks the profile again there.
 */
export function workerBundleChoice(
  host: Pick<ManagedHost, 'id' | 'name' | 'workerProviderId'>,
  catalog: Pick<Catalog, 'bundles'> | null | undefined,
): BundleChoice {
  const id = `remote-worker:${workerProviderId(host)}`
  const listed = catalog?.bundles.find((bundle) => bundle.id === id)
  const bundle: ModelBundle = listed ?? {
    id,
    name: host.name,
    description: '使用已连接的远端服务',
    components: { dit: id, textEncoder: id, vae: id },
    support: id,
    custom: true,
  }
  return { bundle, installed: true, unavailable: false }
}

/** What `Ipc.remoteWorkerLoras` answers: a list, or `{ items }`; anything malformed is dropped. */
export function parseWorkerLoras(value: unknown): WorkerLoraItem[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items
      : []
  return rows.filter((row): row is WorkerLoraItem => {
    if (!row || typeof row !== 'object') return false
    const item = row as Partial<WorkerLoraItem>
    return isWorkerLoraId(item.id) && typeof item.name === 'string'
  })
}

export function workerAdapterEntries(items: readonly WorkerLoraItem[]): WorkerAdapterEntry[] {
  return items.map((item) => ({
    ...item,
    id: workerCanvasAdapter(item.id, 1).id,
    workerId: item.id,
    name: item.name || item.id,
    provider: 'local',
    repo: '',
    revision: '',
    kind: 'lora',
    license: '',
    files: [item.id],
    sizeBytes: Number.isFinite(item.sizeBytes) ? item.sizeBytes : 0,
    installedBytes: 0,
    tags: ['remote-worker'],
    // Only a registered LoRA can be sent to the Worker.
    installed: item.registered !== false,
    registered: item.registered !== false,
  }))
}

/** The 画面's LoRA for a Worker LoRA: a portable id, plus its Worker path when the id had to be hashed. */
export function workerAdapterFor(entry: Pick<WorkerAdapterEntry, 'workerId'>, strength: number): CanvasAdapter {
  return workerCanvasAdapter(entry.workerId, strength)
}

/**
 * The chosen LoRA a Worker does not have registered. Unknown (list not read
 * yet, or empty) is never reported: main checks again when the job starts.
 */
export function missingWorkerAdapters(
  adapters: readonly CanvasAdapter[],
  entries: readonly WorkerAdapterEntry[] | null | undefined,
): CanvasAdapter[] {
  if (!entries?.length) return []
  const registered = new Set(entries.filter((entry) => entry.registered).map((entry) => entry.workerId))
  return adapters.filter((adapter) => !registered.has(adapter.path ?? adapter.id))
}
