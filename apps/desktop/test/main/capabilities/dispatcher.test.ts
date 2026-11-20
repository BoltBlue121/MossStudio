import { existsSync, readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL_CAPABILITY_PACKS, createBuiltinCapabilityRegistry } from '@shared/capabilities'
import { paths } from '@main/lib/paths'
import {
  createBuiltinMainHandlers,
  createMainCapabilityDispatcher,
  listCapabilityAudit,
  resetCapabilityAuditMemory,
} from '@main/capabilities'
import { useTempDataRoot } from '@test/helpers/tempDir'

useTempDataRoot()

beforeEach(() => {
  resetCapabilityAuditMemory()
})

describe('main/capabilities dispatcher and audit trail', () => {
  it('binds a main-process handler for every target=main action across all 14 built-in packs', () => {
    const registry = createBuiltinCapabilityRegistry()
    const handlers = createBuiltinMainHandlers()
    const mainActions = registry
      .listActions({ enabledFlags: { gbcEnabled: true, trainingEnabled: true } })
      .filter((action) => action.target === 'main')

    expect(ALL_CAPABILITY_PACKS.length).toBe(14)
    expect(mainActions.length).toBeGreaterThanOrEqual(50)
    for (const action of mainActions) {
      expect(typeof handlers[action.id], `missing main handler for ${action.id}`).toBe('function')
    }
  })

  it('executes main-targeted actions headlessly, enforces feature flags and policy floors, and persists JSONL audit records', async () => {
    let flags: Record<string, boolean> = { gbcEnabled: false, trainingEnabled: false }
    const deleted: string[] = []
    const rendererCalls: Array<{ name: string; conversationId?: string }> = []

    const dispatcher = createMainCapabilityDispatcher({
      registry: createBuiltinCapabilityRegistry(),
      readFlags: () => flags,
      mainHandlers: {
        'studio.projects.list': () => ({ projects: [{ id: 'proj-1', name: '海报' }] }),
        'studio.projects.delete': ({ id }) => {
          deleted.push(String(id))
          return { deleted: id }
        },
        'studio.gbc.status': () => ({ ready: true }),
      },
      runInRenderer: async (call, _mode, conversationId) => {
        rendererCalls.push({ name: call.name, conversationId })
        return { ok: true, content: JSON.stringify({ selected: 'c1' }) }
      },
    })

    // 1. Read action succeeds headlessly.
    const listed = await dispatcher.execute({
      name: 'studio.projects.list',
      source: 'external-agent',
      conversationId: 'conv-1',
    })
    expect(listed.ok).toBe(true)
    expect(JSON.parse(listed.content)).toEqual({ projects: [{ id: 'proj-1', name: '海报' }] })

    // 2. Disabled feature flag pack is refused and audited.
    const gbcBlocked = await dispatcher.execute({
      name: 'studio.gbc.status',
      source: 'external-agent',
      conversationId: 'conv-1',
    })
    expect(gbcBlocked.ok).toBe(false)
    expect(gbcBlocked.content).toContain('未开启')

    flags = { gbcEnabled: true, trainingEnabled: false }
    const gbcAllowed = await dispatcher.execute({
      name: 'studio.gbc.status',
      source: 'external-agent',
      conversationId: 'conv-1',
    })
    expect(gbcAllowed.ok).toBe(true)

    // 3. Approval-gated destructive action is blocked without approval, deferred in advanced mode, and runs when approved.
    const unapproved = await dispatcher.execute({
      name: 'studio.projects.delete',
      arguments: { id: 'proj-1' },
      source: 'external-agent',
      conversationId: 'conv-1',
    })
    expect(unapproved.ok).toBe(false)
    expect(JSON.parse(unapproved.content).requiresApproval).toBe(true)
    expect(deleted).toEqual([])

    const deferred = await dispatcher.execute({
      name: 'studio.projects.delete',
      arguments: { id: 'proj-1' },
      mode: 'advanced',
      source: 'assistant',
      conversationId: 'conv-2',
    })
    expect(deferred.ok).toBe(true)
    expect(JSON.parse(deferred.content).proposed).toMatchObject({ tool: 'studio.projects.delete', args: { id: 'proj-1' } })
    expect(deleted).toEqual([])

    const approved = await dispatcher.execute({
      name: 'studio.projects.delete',
      arguments: { id: 'proj-1' },
      approved: true,
      source: 'external-agent',
      conversationId: 'conv-1',
    })
    expect(approved.ok).toBe(true)
    expect(deleted).toEqual(['proj-1'])

    // 4. Renderer-targeted legacy alias delegates with conversationId and is audited.
    const relayed = await dispatcher.execute({
      name: 'studio_read_context',
      source: 'assistant',
      conversationId: 'conv-2',
    })
    expect(relayed.ok).toBe(true)
    expect(rendererCalls).toEqual([{ name: 'studio_read_context', conversationId: 'conv-2' }])

    // 5. Audit trail (操作留痕) is persisted on disk and reloads after memory reset.
    expect(existsSync(paths.capabilityAudit())).toBe(true)
    const lines = readFileSync(paths.capabilityAudit(), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(7)

    resetCapabilityAuditMemory()
    const reloaded = listCapabilityAudit({ conversationId: 'conv-2' })
    expect(reloaded).toHaveLength(2)
    expect(reloaded[0]!.actionId).toBe('studio.board.read_context')
    expect(reloaded[1]!.actionId).toBe('studio.projects.delete')
  })

  it('rejects malformed arguments before invoking handlers and records the failure in audit', async () => {
    const spy = vi.fn()
    const dispatcher = createMainCapabilityDispatcher({
      registry: createBuiltinCapabilityRegistry(),
      mainHandlers: { 'studio.projects.get': spy },
    })

    const bad = await dispatcher.execute({
      name: 'studio.projects.get',
      arguments: { id: '../escape' },
      source: 'ipc',
    })
    expect(bad.ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()

    const entries = listCapabilityAudit({ actionId: 'studio.projects.get' })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.ok).toBe(false)
    expect(entries[0]!.error).toBeTruthy()
  })
})
