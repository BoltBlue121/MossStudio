import { useCallback, useEffect, useState } from 'react'
import type { AgentProject } from '@shared/agentHub'
import { Button, Select } from '../../../components/ui'
import type { AgentSession } from './collabClient'

export function useWorkspaceChoice(projectId: string | null) {
  const key = `mossstudio.collab.workspace.dsh-desktop.${projectId ?? 'unsaved'}`
  const [choice, setChoice] = useState(() => {
    try {
      const workspace = localStorage.getItem(key) ?? ''
      return { workspace, session: localStorage.getItem(`${key}.session.${workspace}`) ?? '' }
    } catch {
      return { workspace: '', session: '' }
    }
  })
  const chooseWorkspace = useCallback(
    (workspace: string, session?: string) => {
      if (session === undefined) {
        try {
          session = localStorage.getItem(`${key}.session.${workspace}`) ?? ''
        } catch {
          session = ''
        }
      }
      setChoice({ workspace, session })
    },
    [key],
  )
  const chooseSession = useCallback((session: string) => setChoice((old) => (old.session === session ? old : { ...old, session })), [])
  // The project's first save changes the storage key but not its board session.
  useEffect(() => {
    try {
      if (choice.workspace) {
        localStorage.setItem(key, choice.workspace)
        if (choice.session) localStorage.setItem(`${key}.session.${choice.workspace}`, choice.session)
      } else localStorage.removeItem(key)
    } catch {
      /* Storage is optional. */
    }
  }, [key, choice])
  return { workspaceId: choice.workspace, sessionId: choice.session, chooseWorkspace, chooseSession }
}

export function DesktopSessionBar({
  projects,
  project,
  sessions,
  sessionId,
  onProject,
  onSession,
  onCreate,
  onRefresh,
}: {
  projects: readonly AgentProject[]
  project?: AgentProject
  sessions: readonly AgentSession[]
  sessionId: string
  onProject: (id: string) => void
  onSession: (id: string) => void
  onCreate: () => void
  onRefresh: () => void
}) {
  return (
    <div className="grid gap-1.5">
      <Select
        aria-label="DSH 工作区"
        value={project?.id ?? ''}
        onValueChange={onProject}
        options={[{ value: '', label: '先选择工作区' }, ...projects.map((p) => ({ value: p.id, label: `${p.title} · ${p.cwd}` }))]}
      />
      <div className="flex items-center gap-1">
        <Select
          aria-label="工作区对话"
          className="min-w-0 flex-1"
          value={sessionId}
          disabled={!project || !sessions.length}
          onValueChange={onSession}
          options={[
            { value: '', label: project && !sessions.length ? '这个工作区还没有对话' : '选择对话' },
            ...sessions.map((s) => ({ value: s.id, label: s.title })),
          ]}
        />
        <Button size="xs" onClick={onCreate} data-session-create>
          新建对话
        </Button>
        <Button tone="ghost" size="xs" onClick={onRefresh}>
          刷新
        </Button>
      </div>
    </div>
  )
}
