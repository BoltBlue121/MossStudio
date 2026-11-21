import { randomUUID } from 'node:crypto'
import { Events } from '@shared/channels'
import type { CapabilityApprovalRequest, PendingCapabilityApproval } from '@shared/agentHub'

export function createCapabilityApprovalQueue(options: {
  emit: (channel: string, payload: { pending: PendingCapabilityApproval[] }) => void
  timeoutMs?: number
}) {
  const pending = new Map<
    string,
    { info: PendingCapabilityApproval; settle: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >()
  const listPending = (): PendingCapabilityApproval[] => [...pending.values()].map(({ info }) => ({ ...info }))
  const broadcast = () => options.emit(Events.capabilityApproval, { pending: listPending() })
  const resolve = (id: string, decision: 'approve' | 'reject'): boolean => {
    const item = pending.get(id)
    if (!item) return false
    pending.delete(id)
    clearTimeout(item.timer)
    item.settle(decision === 'approve')
    broadcast()
    return true
  }
  return {
    listPending,
    resolve,
    requestApproval(info: CapabilityApprovalRequest): Promise<boolean> {
      const id = randomUUID()
      return new Promise<boolean>((settle) => {
        const timer = setTimeout(() => resolve(id, 'reject'), options.timeoutMs ?? 120_000)
        timer.unref?.()
        pending.set(id, { info: { ...info, id, createdAt: new Date().toISOString() }, settle, timer })
        broadcast()
      })
    },
    clear(): void {
      for (const item of pending.values()) {
        clearTimeout(item.timer)
        item.settle(false)
      }
      pending.clear()
      broadcast()
    },
  }
}
