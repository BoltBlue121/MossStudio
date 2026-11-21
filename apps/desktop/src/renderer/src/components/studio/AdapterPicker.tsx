import { Check, FilePlus2, ListChecks, Search } from 'lucide-react'
import { Notice } from '../common/Notice'
import { useEffect, useMemo, useState } from 'react'
import type { AdapterEntry, CanvasAdapter } from '@shared/types'
import { Ipc } from '@shared/channels'
import { adapterStatuses, isSelectableAdapter } from '@shared/adapters'
import { Button, Input, Modal, Spinner, cn } from '../ui'
import { bytes } from '../../lib/format'
import { call } from '../../lib/api'
import { parseWorkerLoras, type WorkerLoraItem } from '../../pages/studio/remoteWorkerLoras'
import { LoraProfileHint } from './LoraTriggerBar'
import { mergeEntryLoraProfile, useLoraProfiles } from './loraProfilesClient'

interface Props {
  open: boolean
  selected: readonly CanvasAdapter[]
  catalog: readonly AdapterEntry[] | null | undefined
  onClose: () => void
  onToggle: (id: string) => void
  onImport: () => Promise<void>
  /**
   * The Worker host picked as 运行位置: the list is that Worker's registered
   * LoRA (`catalog` then holds them) and 管理登记 replaces 导入文件.
   */
  remoteWorker?: RemoteWorkerSource
}

export interface RemoteWorkerSource {
  host: { id: string; name: string }
  loading: boolean
  error: string | null
  /** The Worker's registrations changed: read its list again. */
  onChanged: () => void
}

/**
 * Multi-select over the model library. Selection applies immediately, so the
 * sampler row behind the dialog always shows what the next job will send.
 */
export function AdapterPicker({ open, selected, catalog, onClose, onToggle, onImport, remoteWorker }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [importing, setImporting] = useState(false)
  const [managing, setManaging] = useState(false)
  const workerHostId = remoteWorker?.host.id
  // Another host, or none: the picker opens on the LoRA list again.
  useEffect(() => setManaging(false), [workerHostId, open])
  const profiles = useLoraProfiles()
  const chosen = useMemo(() => new Set(selected.map((item) => item.id)), [selected])
  const selectable = useMemo(() => (catalog ?? []).filter(isSelectableAdapter), [catalog])
  const hiddenDmd = useMemo(() => (catalog ?? []).filter((entry) => entry.installed && entry.kind === 'dmd').length, [catalog])
  // A project can reference adapters that were uninstalled later; surface them so
  // the user can drop them instead of hunting for a missing entry.
  // A Worker list not read yet (or empty) says nothing about what is missing.
  const known = !remoteWorker || Boolean(catalog?.length)
  const orphans = useMemo(
    () => (known ? adapterStatuses(selected, catalog).filter((row) => !row.installed) : []),
    [known, selected, catalog],
  )
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const rows = needle
      ? selectable.filter(
          (entry) =>
            entry.name.toLowerCase().includes(needle) ||
            entry.id.toLowerCase().includes(needle) ||
            entry.base?.toLowerCase().includes(needle),
        )
      : selectable
    return [...rows].sort((a, b) => Number(chosen.has(b.id)) - Number(chosen.has(a.id)) || a.name.localeCompare(b.name, 'zh-CN'))
  }, [selectable, query, chosen])

  async function importFiles(): Promise<void> {
    setImporting(true)
    try {
      await onImport()
    } finally {
      setImporting(false)
    }
  }

  return (
    <Modal
      open={open}
      title={remoteWorker ? `选择 LoRA · ${remoteWorker.host.name}` : '选择 LoRA'}
      description={
        remoteWorker
          ? `用「${remoteWorker.host.name}」上已登记的 LoRA；强度在左侧面板里逐个调整。`
          : '给这个画面叠加 LoRA；强度在左侧面板里逐个调整。'
      }
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          {remoteWorker ? (
            <Button tone="secondary" size="md" onClick={() => setManaging((value) => !value)} data-worker-lora-manage>
              <ListChecks className="size-4" strokeWidth={1.6} />
              {managing ? '返回选择' : '管理登记'}
            </Button>
          ) : (
            <Button tone="secondary" size="md" onClick={() => void importFiles()} disabled={importing}>
              {importing ? <Spinner className="size-4" /> : <FilePlus2 className="size-4" strokeWidth={1.6} />}
              导入文件
            </Button>
          )}
          <Button tone="ghost" size="md" data-dialog-initial-focus onClick={onClose}>
            完成
          </Button>
        </>
      }
    >
      {remoteWorker && managing ? (
        <WorkerRegistrations source={remoteWorker} />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3"
              aria-hidden="true"
              strokeWidth={1.6}
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名称"
              className="pl-9"
              aria-label="搜索 LoRA"
            />
          </div>

          <div className="max-h-[46vh] min-h-24 overflow-y-auto rounded-xl bg-panel p-1.5">
            {visible.length === 0 ? (
              <div className="px-4 py-8 text-center text-ui text-ink-2">
                {remoteWorker && remoteWorker.loading && !catalog ? (
                  <Spinner className="mx-auto size-4" />
                ) : remoteWorker && remoteWorker.error && !catalog ? (
                  <>
                    没能读取「{remoteWorker.host.name}」上的 LoRA：{remoteWorker.error}
                  </>
                ) : selectable.length === 0 && remoteWorker ? (
                  <>「{remoteWorker.host.name}」上还没有登记 LoRA。用下面的「管理登记」把它上面的 .safetensors 文件登记进来。</>
                ) : selectable.length === 0 ? (
                  <>模型库里还没有 LoRA。用下面的「导入文件」把电脑上的 .safetensors 文件加进来。</>
                ) : (
                  <>没有名称包含「{query.trim()}」的 LoRA。</>
                )}
              </div>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {visible.map((entry) => {
                  const active = chosen.has(entry.id)
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => onToggle(entry.id)}
                        aria-pressed={active}
                        data-adapter-option={entry.id}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                          active ? 'bg-well-strong' : 'hover:bg-well',
                        )}
                      >
                        <span
                          className={cn(
                            'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px]',
                            active ? 'bg-accent text-on-accent' : 'bg-well-strong',
                          )}
                        >
                          {active ? <Check className="size-3" aria-hidden="true" strokeWidth={1.6} /> : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-control text-ink">{entry.name}</span>
                          {entry.base ? <span className="block truncate text-caption text-ink-2">适用于 {entry.base}</span> : null}
                          <LoraProfileHint profile={mergeEntryLoraProfile(profileKey(entry), entry, profiles[profileKey(entry)])} />
                        </span>
                        <span className="tabular w-16 shrink-0 text-right text-caption text-ink-2">{bytes(entry.sizeBytes)}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {orphans.length ? (
            <Notice tone="warn">
              <div className="flex flex-col gap-2">
                <span>
                  {remoteWorker
                    ? `下面的 LoRA 没有在「${remoteWorker.host.name}」上登记，生成前需要移除：`
                    : '下面的 LoRA 已经不在模型库里，生成前需要移除：'}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {orphans.map((row) => (
                    <Button key={row.adapter.id} size="xs" onClick={() => onToggle(row.adapter.id)}>
                      移除「{row.name}」
                    </Button>
                  ))}
                </div>
              </div>
            </Notice>
          ) : null}

          <p className="text-caption text-ink-2">
            按选择顺序叠加，强度 0–2，默认 1（记过推荐强度的按推荐值）。
            {hiddenDmd ? '「快速」质量自带的加速组件会自动启用，不在这里列出。' : ''}
          </p>
        </div>
      )}
    </Modal>
  )
}

/** A Worker LoRA's triggers are saved under its Worker path, as main reads them. */
function profileKey(entry: AdapterEntry): string {
  return 'workerId' in entry && typeof entry.workerId === 'string' ? entry.workerId : entry.id
}

/** 管理登记: every .safetensors file the Worker found, each registered or not with one click. */
function WorkerRegistrations({ source }: { source: RemoteWorkerSource }): React.JSX.Element {
  const hostId = source.host.id
  const [items, setItems] = useState<WorkerLoraItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [round, setRound] = useState(0)

  useEffect(() => {
    let alive = true
    setError(null)
    call<unknown>(Ipc.remoteWorkerLoras, { hostId, candidates: true })
      .then((value) => {
        if (alive) setItems(parseWorkerLoras(value))
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      alive = false
    }
  }, [hostId, round])

  async function change(item: WorkerLoraItem): Promise<void> {
    setBusy(item.id)
    setError(null)
    try {
      await call(Ipc.remoteWorkerLoraRegister, { hostId, id: item.id, action: item.registered ? 'unregister' : 'register' })
      setRound((value) => value + 1)
      source.onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-3" data-worker-lora-registry>
      {error ? <Notice tone="warn">{error}</Notice> : null}
      <div className="max-h-[46vh] min-h-24 overflow-y-auto rounded-xl bg-panel p-1.5">
        {items === null ? (
          <div className="px-4 py-8 text-center text-ui text-ink-2">{error ? null : <Spinner className="mx-auto size-4" />}</div>
        ) : items.length === 0 ? (
          <div className="px-4 py-8 text-center text-ui text-ink-2">「{source.host.name}」的 LoRA 文件夹里还没有 .safetensors 文件。</div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 rounded-lg px-3 py-2" data-worker-lora={item.id}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-control text-ink">{item.name || item.id}</span>
                  <span className="block truncate text-caption text-ink-2">{item.registered ? '已登记' : '未登记'}</span>
                </span>
                <span className="tabular w-16 shrink-0 text-right text-caption text-ink-2">{bytes(item.sizeBytes)}</span>
                <Button size="xs" tone={item.registered ? 'ghost' : 'secondary'} disabled={busy !== null} onClick={() => void change(item)}>
                  {busy === item.id ? <Spinner className="size-3.5" /> : null}
                  {item.registered ? '取消登记' : '登记'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-caption text-ink-2">登记后的 LoRA 才能在「{source.host.name}」上使用；文件留在那台机器上，不会下载到这台电脑。</p>
    </div>
  )
}
