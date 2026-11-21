import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Collapse } from '../../../components/motion'
import { cn, Pill, StatusDot } from '../../../components/ui'
import { duration } from '../../../lib/format'

export type StepStatus = 'running' | 'done' | 'error'

export interface ProgressStep {
  id: string
  title: string
  status: StepStatus
  detail?: string
  error?: string
  startedAt?: number
  endedAt?: number
}

const STATUS_LABELS: Record<StepStatus, string> = { running: '进行中', done: '已完成', error: '失败' }
const STATUS_TONES = { running: 'accent', done: 'ok', error: 'danger' } as const

/** How long a running turn has taken, worded as every other duration (`duration` in lib/format). */
export function elapsedLabel(ms: number): string {
  return duration(new Date(0).toISOString(), new Date(Math.max(0, ms)).toISOString())
}

/** Merge steps by id, keeping the order they first appeared in; a later report of a step wins. */
export function mergeSteps(...lists: ReadonlyArray<readonly ProgressStep[]>): ProgressStep[] {
  const order: string[] = []
  const byId = new Map<string, ProgressStep>()
  for (const list of lists) {
    for (const step of list) {
      if (!byId.has(step.id)) order.push(step.id)
      byId.set(step.id, { ...byId.get(step.id), ...step })
    }
  }
  return order.map((id) => byId.get(id)!)
}

function StepCard({ step, index }: { step: ProgressStep; index: number }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const detail = step.detail?.trim()
  return (
    <li className="flex flex-col gap-1 rounded-md bg-panel px-2.5 py-2" data-step={step.id} data-step-status={step.status}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="tabular shrink-0 text-micro text-ink-2">{index + 1}</span>
        <span className="min-w-0 flex-1 truncate text-ui text-ink" title={step.title}>
          {step.title}
        </span>
        <Pill tone={STATUS_TONES[step.status]}>{STATUS_LABELS[step.status]}</Pill>
      </div>
      {step.status === 'error' && step.error ? (
        <p role="status" className="text-caption text-danger [overflow-wrap:anywhere]">
          {step.error}
        </p>
      ) : null}
      {detail ? (
        <div>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="-mx-1 flex items-center gap-0.5 rounded-md px-1 text-caption text-ink-2 transition-colors hover:text-ink"
          >
            <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} aria-hidden="true" strokeWidth={1.6} />
            查看详情
          </button>
          <Collapse open={open}>
            <p className="selectable mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded bg-well p-1.5 text-micro text-ink-2">
              {detail}
            </p>
          </Collapse>
        </div>
      ) : null}
    </li>
  )
}

/**
 * What the Agent is doing now, docked above the input: a one-line progress bar
 * while it works, with the step cards one click away.
 */
export function StepProgressDock({
  steps,
  running,
  startedAt,
  status,
}: {
  steps: readonly ProgressStep[]
  running: boolean
  /** When the current turn began, for the elapsed time. */
  startedAt: number | null
  /** The Agent's own line about what it is doing, when it sends one. */
  status?: string
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])

  if (!steps.length && !running) return null
  const current = [...steps].reverse().find((step) => step.status === 'running') ?? steps.at(-1)
  const failed = steps.filter((step) => step.status === 'error').length
  const stillRunning = steps.some((step) => step.status === 'running')
  const effectiveRunning = running || stillRunning
  const stepNo = current ? steps.indexOf(current) + 1 : steps.length + 1
  const doing = effectiveRunning
    ? status || (current?.status === 'running' ? `正在${current.title}` : '正在思考…')
    : failed
      ? `${steps.length} 步完成，${failed} 步失败`
      : `${steps.length} 步全部完成`
  const elapsed = effectiveRunning && startedAt ? ` · ${elapsedLabel(now - startedAt)}` : ''

  return (
    <section className="flex shrink-0 flex-col gap-1" aria-label="步骤进展" data-step-progress>
      {steps.length ? (
        <Collapse open={open}>
          <ol className="flex max-h-[min(40vh,18rem)] flex-col gap-1 overflow-y-auto pb-1" data-step-list>
            {steps.map((step, index) => (
              <StepCard key={step.id} step={step} index={index} />
            ))}
          </ol>
        </Collapse>
      ) : null}
      <div className="flex h-7 min-w-0 items-center gap-1.5 rounded-md bg-well px-2 text-caption" data-step-bar data-running={running}>
        <StatusDot status={running ? 'ok' : failed ? 'error' : 'unknown'} className={cn(running && 'animate-pulse')} />
        <span className="min-w-0 flex-1 truncate text-ink" title={`${running ? `第 ${stepNo} 步 · ` : ''}${doing}${elapsed}`}>
          {running ? `第 ${stepNo} 步 · ` : ''}
          {doing}
          <span className="tabular text-ink-2">{elapsed}</span>
        </span>
        {steps.length ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="flex shrink-0 items-center gap-0.5 rounded px-1 text-micro text-ink-2 transition-colors hover:text-ink"
          >
            进展详情
            <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} aria-hidden="true" strokeWidth={1.6} />
          </button>
        ) : null}
      </div>
    </section>
  )
}
