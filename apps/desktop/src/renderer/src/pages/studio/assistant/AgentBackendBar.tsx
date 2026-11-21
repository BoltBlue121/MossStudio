import { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight, Folder, Plus, RefreshCw, X } from 'lucide-react'
import { Popover } from '../../../components/common/Popover'
import { cn, IconButton, StatusDot } from '../../../components/ui'
import { isCustomBackend, type AgentBackendInfo, type AgentSession } from './collabClient'
import { groupByWorkspace } from './sessionBindings'

export type BackendState = 'connected' | 'available' | 'missing'

export function backendState(backend: AgentBackendInfo): BackendState {
  if (backend.connected) return 'connected'
  return backend.available ? 'available' : 'missing'
}

const STATE_LABELS: Record<BackendState, string> = {
  connected: '已连接',
  available: '可连接',
  missing: '未安装',
}

const STATE_DOT = { connected: 'ok', available: 'warn', missing: 'unknown' } as const

/** A connection action of the current Agent (更换连接, 断开连接), offered inside the switcher. */
export interface AgentAction {
  id: string
  label: string
  run: () => void
}

/**
 * Usable Agents first (connected, then ready to connect), the custom command
 * last; Agents not found on this computer are kept apart so they never read
 * as half-built options.
 */
export function orderBackends(backends: readonly AgentBackendInfo[]): { usable: AgentBackendInfo[]; missing: AgentBackendInfo[] } {
  const rank = (backend: AgentBackendInfo): number => (isCustomBackend(backend) ? 2 : backend.connected ? 0 : 1)
  const usable = backends.filter((backend) => backendState(backend) !== 'missing' || isCustomBackend(backend))
  return {
    usable: usable
      .map((backend, index) => ({ backend, index }))
      .sort((a, b) => rank(a.backend) - rank(b.backend) || a.index - b.index)
      .map((row) => row.backend),
    missing: backends.filter((backend) => !usable.includes(backend)),
  }
}

/** One compact trigger naming the current Agent; the list, connection actions and re-detect open from it. */
export function AgentSwitcher({
  backends,
  selectedId,
  onSelect,
  onRefresh,
  refreshing,
  actions = [],
}: {
  backends: readonly AgentBackendInfo[]
  selectedId: string
  onSelect: (id: string) => void
  onRefresh: () => void
  refreshing?: boolean
  actions?: readonly AgentAction[]
}): React.JSX.Element {
  const current = backends.find((backend) => backend.id === selectedId) ?? backends[0]
  const currentState = current ? backendState(current) : 'missing'
  const { usable, missing } = orderBackends(backends)

  const item = (backend: AgentBackendInfo, close: () => void, quiet = false): React.JSX.Element => {
    const state = backendState(backend)
    const selected = backend.id === selectedId
    return (
      <button
        key={backend.id}
        type="button"
        role="radio"
        aria-checked={selected}
        data-agent-backend={backend.id}
        data-agent-state={state}
        title={[backend.label, STATE_LABELS[state], backend.detail].filter(Boolean).join(' · ')}
        onClick={() => {
          onSelect(backend.id)
          close()
        }}
        className={cn(
          'flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left transition-colors hover:bg-well',
          quiet ? 'text-caption text-ink-2' : 'text-ui text-ink',
          selected && 'bg-well-strong font-medium',
        )}
      >
        <StatusDot status={STATE_DOT[state]} />
        <span className="min-w-0 flex-1 truncate">{backend.label}</span>
        <span className="shrink-0 text-caption text-ink-2">{STATE_LABELS[state]}</span>
        {selected ? <Check className="size-3.5 shrink-0" aria-hidden="true" strokeWidth={1.8} /> : null}
      </button>
    )
  }

  return (
    <Popover
      align="start"
      role="dialog"
      label="协同 Agent"
      rootClassName="min-w-0"
      className="w-[min(17rem,calc(100vw-3rem))] gap-0.5 p-1.5"
      trigger={(menu) => (
        <button
          type="button"
          onClick={menu.toggle}
          aria-expanded={menu['aria-expanded']}
          aria-controls={menu['aria-controls']}
          aria-haspopup={menu['aria-haspopup']}
          data-agent-switcher={current?.id}
          data-agent-switcher-state={currentState}
          title={current ? `${current.label} · ${STATE_LABELS[currentState]}，点击切换 Agent` : '选择 Agent'}
          className={cn(
            'inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 text-ui font-medium text-ink transition-colors hover:bg-well',
            menu.open && 'bg-well',
          )}
        >
          <StatusDot status={STATE_DOT[currentState]} />
          <span className="min-w-0 truncate">{current?.label ?? '选择 Agent'}</span>
          <span className="sr-only">（{STATE_LABELS[currentState]}）</span>
          <ChevronDown className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" strokeWidth={1.6} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div role="radiogroup" aria-label="协同 Agent" className="flex flex-col gap-0.5">
            {usable.map((backend) => item(backend, close))}
            {missing.length ? (
              <>
                <span className="px-2.5 pb-0.5 pt-2 text-micro text-ink-3">未检测到</span>
                {missing.map((backend) => item(backend, close, true))}
              </>
            ) : null}
          </div>
          <div aria-hidden="true" className="h-1.5" />
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              data-agent-action={action.id}
              onClick={() => {
                close()
                action.run()
              }}
              className="flex min-h-8 w-full items-center rounded-md px-2.5 text-left text-ui text-ink transition-colors hover:bg-well"
            >
              {action.label}
            </button>
          ))}
          <button
            type="button"
            disabled={refreshing}
            data-agent-refresh
            onClick={onRefresh}
            className="flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-ui text-ink transition-colors enabled:hover:bg-well disabled:opacity-40"
          >
            <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} aria-hidden="true" strokeWidth={1.6} />
            重新检测 Agent
          </button>
        </>
      )}
    </Popover>
  )
}

function sessionLine(session: AgentSession): string {
  return [session.title, session.model, session.running ? '进行中' : ''].filter(Boolean).join(' · ')
}

/**
 * The conversation this project talks in, on one line with refresh and new.
 * The list shows only this project's conversations (started here or chosen
 * for it); any other conversation of the Agent is imported by picking its
 * working folder first, and then stays in this project's list.
 */
export function AgentSessionBar({
  label,
  sessions,
  pinned,
  selectedId,
  creating,
  createLabel,
  onOpenChange,
  onSelect,
  onUnbind,
  onCreate,
  onRefresh,
}: {
  label: string
  /** Every conversation the Agent has; null while loading. */
  sessions: readonly AgentSession[] | null
  /** This project's conversations, in the order they joined it. */
  pinned: readonly AgentSession[]
  selectedId: string
  creating: boolean
  createLabel: string
  onOpenChange: (open: boolean) => void
  onSelect: (id: string) => void
  onUnbind: (id: string) => void
  onCreate: () => void
  onRefresh: () => void
}): React.JSX.Element {
  const [workspaceKey, setWorkspaceKey] = useState<string | null>(null)
  const current = sessions?.find((item) => item.id === selectedId)
  const groups = useMemo(() => groupByWorkspace(sessions ?? []), [sessions])
  const workspace = workspaceKey === null ? null : (groups.find((group) => group.key === workspaceKey) ?? null)
  const pinnedIds = new Set(pinned.map((item) => item.id))

  const row = 'flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-ui text-ink transition-colors hover:bg-well'
  const heading = 'px-2.5 pb-0.5 pt-1 text-micro text-ink-3'

  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5" data-session-picker>
      <Popover
        align="start"
        role="dialog"
        label={label}
        rootClassName="min-w-0 flex-1"
        className="max-h-[min(26rem,70vh)] w-[min(20rem,calc(100vw-3rem))] gap-0.5 overflow-y-auto p-1.5"
        onOpenChange={(open) => {
          if (!open) setWorkspaceKey(null)
          onOpenChange(open)
        }}
        trigger={(menu) => (
          <button
            type="button"
            onClick={menu.toggle}
            disabled={!sessions}
            aria-expanded={menu['aria-expanded']}
            aria-controls={menu['aria-controls']}
            aria-haspopup={menu['aria-haspopup']}
            title={current ? `${label}：${current.title}` : label}
            data-session-trigger={current?.id ?? ''}
            className={cn(
              'inline-flex h-[26px] min-w-0 flex-1 items-center gap-1.5 rounded-md bg-well px-2 text-left text-ui text-ink transition-colors enabled:hover:bg-well-strong disabled:opacity-40',
              menu.open && 'bg-well-strong',
            )}
          >
            <span className={cn('min-w-0 flex-1 truncate', !current && 'text-ink-2')}>{current ? sessionLine(current) : '选择对话'}</span>
            <ChevronDown className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" strokeWidth={1.6} />
          </button>
        )}
      >
        {(close) => (
          <>
            <span className={heading}>当前项目会话</span>
            <div role="radiogroup" aria-label="当前项目会话" className="flex flex-col gap-0.5" data-project-sessions>
              {pinned.length ? (
                pinned.map((item) => (
                  <div key={item.id} className="flex min-w-0 items-center gap-0.5">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={item.id === selectedId}
                      data-project-session={item.id}
                      title={[item.title, item.cwd].filter(Boolean).join(' · ')}
                      onClick={() => {
                        onSelect(item.id)
                        close()
                      }}
                      className={cn(row, 'flex-1', item.id === selectedId && 'bg-well-strong font-medium')}
                    >
                      <span className="min-w-0 flex-1 truncate">{sessionLine(item)}</span>
                      {item.id === selectedId ? <Check className="size-3.5 shrink-0" aria-hidden="true" strokeWidth={1.8} /> : null}
                    </button>
                    <IconButton
                      label={`从当前项目移出「${item.title}」（不删除对话）`}
                      className="size-7"
                      data-session-unbind={item.id}
                      onClick={() => onUnbind(item.id)}
                    >
                      <X className="size-3.5" aria-hidden="true" strokeWidth={1.6} />
                    </IconButton>
                  </div>
                ))
              ) : (
                <span className="px-2.5 py-1 text-caption text-ink-2" data-project-sessions-empty>
                  这个项目还没有对话。点「+」新建，或从下方按工作区导入。
                </span>
              )}
            </div>
            <div aria-hidden="true" className="h-1.5" />
            {workspace ? (
              <div className="flex flex-col gap-0.5" data-session-import={workspace.key}>
                <button type="button" data-session-workspace-back onClick={() => setWorkspaceKey(null)} className={cn(row, 'text-ink-2')}>
                  <ChevronLeft className="size-3.5 shrink-0" aria-hidden="true" strokeWidth={1.6} />
                  <span className="min-w-0 flex-1 truncate" title={workspace.cwd || workspace.label}>
                    {workspace.label}
                  </span>
                </button>
                {workspace.sessions.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-import-session={item.id}
                    title={[item.title, item.cwd].filter(Boolean).join(' · ')}
                    onClick={() => {
                      onSelect(item.id)
                      close()
                    }}
                    className={row}
                  >
                    <span className="min-w-0 flex-1 truncate">{sessionLine(item)}</span>
                    {pinnedIds.has(item.id) ? <span className="shrink-0 text-caption text-ink-2">已在项目中</span> : null}
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-0.5" data-session-workspaces>
                <span className={heading}>按工作区 / 项目导入</span>
                {groups.length ? (
                  groups.map((group) => (
                    <button
                      key={group.key || 'none'}
                      type="button"
                      data-session-workspace={group.key}
                      title={group.cwd || group.label}
                      onClick={() => setWorkspaceKey(group.key)}
                      className={row}
                    >
                      <Folder className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" strokeWidth={1.6} />
                      <span className="min-w-0 flex-1 truncate">{group.label}</span>
                      <span className="shrink-0 text-caption text-ink-2">{group.sessions.length} 个对话</span>
                      <ChevronRight className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" strokeWidth={1.6} />
                    </button>
                  ))
                ) : (
                  <span className="px-2.5 py-1 text-caption text-ink-2">还没有可导入的对话。</span>
                )}
              </div>
            )}
          </>
        )}
      </Popover>
      <IconButton label={`刷新${label}`} className="size-[26px] shrink-0" onClick={onRefresh}>
        <RefreshCw className="size-3.5" strokeWidth={1.6} />
      </IconButton>
      <button
        type="button"
        disabled={creating}
        title={createLabel}
        data-session-create
        onClick={onCreate}
        className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-md text-ink transition-colors enabled:hover:bg-well disabled:opacity-40"
      >
        <Plus className="size-3.5" aria-hidden="true" strokeWidth={1.6} />
        <span className="sr-only">{creating ? '创建中…' : createLabel}</span>
      </button>
    </div>
  )
}
