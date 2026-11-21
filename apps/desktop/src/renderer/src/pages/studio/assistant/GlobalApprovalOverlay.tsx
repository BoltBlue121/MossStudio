import { useMemo } from 'react'
import { ApprovalDock, useApprovals, useInlineApprovalDockShown } from './ApprovalDock'
import { createCollabClient } from './collabClient'

/**
 * High-risk requests from external Agents, answerable from any page: with the
 * 协同 panel closed, an Agent working over MCP would otherwise wait unseen
 * until its request timed out.
 */
export function GlobalApprovalOverlay(): React.JSX.Element | null {
  const client = useMemo(() => createCollabClient(), [])
  const approvals = useApprovals(client, true)
  const inline = useInlineApprovalDockShown()
  if (!approvals.pending.length || inline) return null
  return (
    <div
      role="region"
      aria-label="待你批准的操作"
      className="absolute bottom-4 right-4 z-40 w-[min(24rem,calc(100%-2rem))] rounded-xl bg-panel p-2.5 shadow-float"
      data-global-approval-overlay
    >
      <ApprovalDock
        pending={approvals.pending}
        resolving={approvals.resolving}
        onResolve={(id, decision) => void approvals.resolve(id, decision)}
      />
    </div>
  )
}
