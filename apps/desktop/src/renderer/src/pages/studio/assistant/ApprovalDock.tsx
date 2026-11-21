import { ChevronDown, ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { BUILTIN_CAPABILITY_REGISTRY } from '@shared/capabilities'
import { Collapse } from '../../../components/motion'
import { Button, cn, FieldLabel, Pill, useToast } from '../../../components/ui'
import type { ApprovalSource, CollabClient, PendingApproval } from './collabClient'

const SOURCE_LABELS: Record<ApprovalSource, string> = {
  'external-agent': '外部 Agent',
  assistant: '助手',
  ipc: '应用内',
  system: '系统',
}

/** Shows at most this many cards; the rest wait behind a count. */
const SHOWN = 3

function actionTitle(item: PendingApproval): string {
  return BUILTIN_CAPABILITY_REGISTRY.getAction(item.actionId)?.descriptor.title ?? item.title
}

export function prettyArgs(preview: string): string {
  try {
    return JSON.stringify(JSON.parse(preview), null, 2)
  } catch {
    return preview
  }
}

/**
 * How many open 协同 panels show the queue inline. While one does, the
 * app-wide overlay stays out of the way so a request never shows twice.
 */
let inlineDocks = 0
const dockListeners = new Set<() => void>()
const changeDocks = (delta: number): void => {
  inlineDocks += delta
  for (const listener of dockListeners) listener()
}

export function useInlineApprovalDock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    changeDocks(1)
    return () => changeDocks(-1)
  }, [active])
}

export function useInlineApprovalDockShown(): boolean {
  return useSyncExternalStore(
    (listener) => {
      dockListeners.add(listener)
      return () => dockListeners.delete(listener)
    },
    () => inlineDocks > 0,
  )
}

/** The approval queue: one read on mount, then every change the main process pushes. */
export function useApprovals(client: CollabClient, enabled: boolean) {
  const [pending, setPending] = useState<PendingApproval[]>([])
  const [resolving, setResolving] = useState<ReadonlySet<string>>(new Set())
  const toast = useToast()

  useEffect(() => {
    if (!enabled) return
    let active = true
    const off = client.onApprovals((next) => {
      if (active) setPending(next)
    })
    void client.listApprovals().then((next) => {
      if (active) setPending(next)
    })
    return () => {
      active = false
      off()
    }
  }, [client, enabled])

  const resolve = useCallback(
    async (id: string, decision: 'approve' | 'reject') => {
      setResolving((current) => new Set(current).add(id))
      try {
        const applied = await client.resolveApproval(id, decision)
        setPending((current) => current.filter((item) => item.id !== id))
        if (applied === false) {
          toast.push('该审批已过期或已被处理', 'info')
        } else {
          toast.push(decision === 'approve' ? '已批准执行' : '已拒绝这次操作', 'info')
        }
      } catch (error) {
        toast.push(error instanceof Error ? error.message : String(error), 'error')
      } finally {
        setResolving((current) => {
          const next = new Set(current)
          next.delete(id)
          return next
        })
      }
    },
    [client, toast],
  )

  return { pending, resolving, resolve }
}

function ApprovalCard({
  item,
  busy,
  onResolve,
}: {
  item: PendingApproval
  busy: boolean
  onResolve: (decision: 'approve' | 'reject') => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const args = item.argsPreview.trim()
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-raised p-2.5 shadow-float" data-approval-id={item.id}>
      <div className="flex min-w-0 items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" strokeWidth={1.6} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="min-w-0 text-control text-ink [overflow-wrap:anywhere]">{actionTitle(item)}</span>
            <Pill tone="warn">{SOURCE_LABELS[item.source]}</Pill>
          </div>
          {item.summary ? <p className="text-caption text-ink-2 [overflow-wrap:anywhere]">{item.summary}</p> : null}
        </div>
      </div>
      {args ? (
        <div>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="-mx-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-caption text-ink-2 transition-colors hover:text-ink"
          >
            {open ? '收起参数' : '查看参数'}
            <ChevronDown className={cn('size-3.5 text-ink-3 transition-transform', open && 'rotate-180')} strokeWidth={1.6} />
          </button>
          <Collapse open={open}>
            <pre className="selectable mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-well p-2 font-mono text-micro text-ink">
              {prettyArgs(args)}
            </pre>
          </Collapse>
        </div>
      ) : null}
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-micro text-ink-2" title={item.actionId}>
          {item.actionId}
        </span>
        <Button size="xs" tone="ghost" disabled={busy} onClick={() => onResolve('reject')} data-approval-reject>
          拒绝
        </Button>
        <Button size="xs" tone="primary" disabled={busy} onClick={() => onResolve('approve')} data-approval-approve>
          批准执行
        </Button>
      </div>
    </div>
  )
}

/** High-risk operations an external tool asked for, docked above the message box until answered. */
export function ApprovalDock({
  pending,
  resolving,
  onResolve,
}: {
  pending: readonly PendingApproval[]
  resolving: ReadonlySet<string>
  onResolve: (id: string, decision: 'approve' | 'reject') => void
}): React.JSX.Element | null {
  if (!pending.length) return null
  const rest = pending.length - SHOWN
  return (
    <section className="flex shrink-0 flex-col gap-1.5" aria-label="待你批准的操作" data-approval-dock>
      <FieldLabel value={`${pending.length} 项`}>待你批准</FieldLabel>
      <div className="flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto">
        {pending.slice(0, SHOWN).map((item) => (
          <ApprovalCard key={item.id} item={item} busy={resolving.has(item.id)} onResolve={(decision) => onResolve(item.id, decision)} />
        ))}
      </div>
      {rest > 0 ? <span className="text-caption text-ink-2">还有 {rest} 项在排队</span> : null}
    </section>
  )
}
