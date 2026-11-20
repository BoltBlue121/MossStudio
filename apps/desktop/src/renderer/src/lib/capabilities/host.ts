import type { AgentMode, AiToolCall, AiToolResult } from '@shared/ai'
import type { AgentCard, PlanStep } from '@shared/agent/cards'
import {
  BUILTIN_CAPABILITY_REGISTRY,
  type ActionDescriptor,
  type CapabilityId,
  type CapabilityQuery,
  type CapabilityRegistry,
} from '@shared/capabilities'
import type { ProjectCanvas } from '@shared/types'

/**
 * Renderer-side capability execution host.
 *
 * Replaces the single global `StudioToolApi` callback with pack-scoped handler
 * registrations backed by `CapabilityRegistry`. Every call (legacy `studio_*`
 * alias or canonical `studio.*` id) passes through the same precheck, schema
 * validation, advanced-mode deferral and problem-reporting pipeline.
 */

export interface HostSelectionState {
  hasSelection: boolean
  editable: boolean
  selectedKind?: ProjectCanvas['kind']
}

export interface CapabilityExecutionContext {
  callId: string
  action: ActionDescriptor
  mode?: AgentMode
  conversationId?: string
}

export type CapabilityHandler = (args: Record<string, unknown>, context: CapabilityExecutionContext) => unknown | Promise<unknown>

export interface PackRegistrationOptions {
  /** Live selection/editability probe for actions in this pack. */
  checkState?: () => HostSelectionState
  /** Live problem list reported after mutating or run actions in this pack. */
  readProblems?: () => string[]
}

/** A capability refusing to run for an actionable reason (optionally pointing at another tool). */
export class CapabilityFailure extends Error {
  constructor(
    message: string,
    readonly fix?: { tool: string; args?: Record<string, unknown> },
  ) {
    super(message)
  }
}

export interface ExecuteCapabilityOptions {
  mode?: AgentMode
  conversationId?: string
}

export interface RendererCapabilityHost {
  readonly registry: CapabilityRegistry
  registerPackHandlers(
    packId: CapabilityId,
    handlers: Readonly<Record<string, CapabilityHandler>>,
    options?: PackRegistrationOptions,
  ): () => void
  hasHandler(idOrAlias: string): boolean
  listActiveActions(query?: CapabilityQuery): ActionDescriptor[]
  execute(call: AiToolCall, options?: ExecuteCapabilityOptions): Promise<AiToolResult>
  applyPlan(card: AgentCard): Promise<{ applied: number; problems: string[] }>
}

interface MountedHandler {
  packId: CapabilityId
  handler: CapabilityHandler
  options: PackRegistrationOptions
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function ok(data: unknown, extra?: Record<string, unknown>): AiToolResult {
  const body =
    data && typeof data === 'object' && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), ...extra }
      : { value: data, ...extra }
  return { ok: true, content: JSON.stringify(body) }
}

function fail(error: string, fix?: { tool: string; args?: Record<string, unknown> }): AiToolResult {
  return { ok: false, content: JSON.stringify(fix ? { error, fix } : { error }) }
}

function errorOf(result: AiToolResult): string {
  try {
    return String((JSON.parse(result.content) as { error?: string }).error ?? '没有执行')
  } catch {
    return '没有执行'
  }
}

/** Region handles used to be a single tool; redirect text-layer calls with an explicit fix. */
function replacedTool(name: string, raw: Record<string, unknown>): AiToolResult | null {
  if ((name !== 'studio_add_layer' && name !== 'studio.regions.add') || raw.label !== 'text') return null
  return fail('文字区域请用 studio_add_text_layer：caption 写样式，text 写要显示的文字', { tool: 'studio_add_text_layer' })
}

function isMutatingEffect(descriptor: ActionDescriptor): boolean {
  return descriptor.effects.some((effect) => ['write', 'run', 'delete', 'configure', 'install'].includes(effect))
}

function precheck(descriptor: ActionDescriptor, checkState?: () => HostSelectionState): AiToolResult | null {
  const needsEditable = descriptor.requires.includes('editable')
  const needsEditableOrStyle = descriptor.requires.includes('editable-or-style')
  if (!needsEditable && !needsEditableOrStyle) return null
  if (!checkState) return null
  const state = checkState()
  if (!state.hasSelection) return fail('先在画布上选中一个画面')
  if (needsEditable && !state.editable) return fail('选中的是生成结果，不能修改；请先复制成新画面')
  if (needsEditableOrStyle && !state.editable && state.selectedKind !== 'style') {
    return fail('选中的是生成结果，不能修改；请先复制成新画面')
  }
  return null
}

function readProblemsSafe(readProblems?: () => string[]): string[] {
  if (!readProblems) return []
  try {
    return readProblems()
  } catch {
    return []
  }
}

export function createRendererCapabilityHost(registry: CapabilityRegistry = BUILTIN_CAPABILITY_REGISTRY): RendererCapabilityHost {
  const mounted = new Map<CapabilityId, MountedHandler>()
  const packTokens = new Map<CapabilityId, symbol>()

  function registerPackHandlers(
    packId: CapabilityId,
    handlers: Readonly<Record<string, CapabilityHandler>>,
    options: PackRegistrationOptions = {},
  ): () => void {
    const token = Symbol(packId)
    packTokens.set(packId, token)
    const keys: CapabilityId[] = []
    for (const [idOrAlias, handler] of Object.entries(handlers)) {
      const action = registry.getAction(idOrAlias)
      if (!action) throw new Error(`Cannot register handler for unknown capability: ${idOrAlias}`)
      mounted.set(action.descriptor.id, { packId, handler, options })
      keys.push(action.descriptor.id)
    }
    return () => {
      if (packTokens.get(packId) !== token) return
      packTokens.delete(packId)
      for (const id of keys) {
        if (mounted.get(id)?.packId === packId) mounted.delete(id)
      }
    }
  }

  function resolveMounted(idOrAlias: string): { descriptor: ActionDescriptor; entry: MountedHandler | undefined } | null {
    const registered = registry.getAction(idOrAlias)
    if (!registered) return null
    return { descriptor: registered.descriptor, entry: mounted.get(registered.descriptor.id) }
  }

  function notReadyMessage(descriptor: ActionDescriptor): string {
    if (descriptor.id.startsWith('studio.')) return 'Studio 尚未就绪，请先在创作页打开一个项目'
    return `能力 ${descriptor.title} 尚未就绪`
  }

  async function execute(call: AiToolCall, options: ExecuteCapabilityOptions = {}): Promise<AiToolResult> {
    const resolved = resolveMounted(call.name)
    if (!resolved) return fail(`未知工具 ${call.name}`)
    const { descriptor, entry } = resolved
    if (!entry) return fail(notReadyMessage(descriptor))

    const raw = parseArguments(call.arguments)
    const replaced = replacedTool(call.name, raw)
    if (replaced) return replaced

    try {
      const blocked = precheck(descriptor, entry.options.checkState)
      if (blocked) return blocked
      const validated = registry.validateInput(descriptor.id, raw)
      if (!validated.ok) return fail(validated.error)
      const args = validated.data

      if (options.mode === 'advanced' && isMutatingEffect(descriptor)) {
        const label = registry.summarizeAction(descriptor.id, args)
        return ok({ proposed: { tool: call.name, args, label } satisfies PlanStep })
      }

      const data = await entry.handler(args, {
        callId: call.id,
        action: descriptor,
        mode: options.mode,
        conversationId: options.conversationId,
      })

      if (descriptor.effects.includes('interact')) {
        return ok(data, { summary: registry.summarizeAction(descriptor.id, args) })
      }
      if (!isMutatingEffect(descriptor)) {
        return ok(data)
      }
      return ok(data, {
        summary: registry.summarizeAction(descriptor.id, args),
        problems: readProblemsSafe(entry.options.readProblems),
      })
    } catch (error) {
      if (error instanceof CapabilityFailure) return fail(error.message, error.fix)
      return fail(error instanceof Error ? error.message : String(error))
    }
  }

  async function applyPlan(card: AgentCard): Promise<{ applied: number; problems: string[] }> {
    const steps = card.steps ?? []
    if (steps.length === 0) {
      const anyStudio = [...mounted.values()].find((item) => item.options.readProblems)
      if (!anyStudio && mounted.size === 0) throw new Error('Studio 尚未就绪，请先在创作页打开一个项目')
      return { applied: 0, problems: readProblemsSafe(anyStudio?.options.readProblems) }
    }
    let lastProblemsReader: (() => string[]) | undefined
    for (const [index, step] of steps.entries()) {
      const resolved = resolveMounted(step.tool)
      if (!resolved) throw new Error(`方案里有未知工具 ${step.tool}`)
      const { descriptor, entry } = resolved
      if (!entry) throw new Error(notReadyMessage(descriptor))
      const blocked = precheck(descriptor, entry.options.checkState)
      if (blocked) throw new Error(errorOf(blocked))
      const validated = registry.validateInput(descriptor.id, step.args)
      if (!validated.ok) throw new Error(validated.error)
      await entry.handler(validated.data, {
        callId: `plan-${card.id}-${index}`,
        action: descriptor,
      })
      if (entry.options.readProblems) lastProblemsReader = entry.options.readProblems
    }
    return { applied: steps.length, problems: readProblemsSafe(lastProblemsReader) }
  }

  return {
    registry,
    registerPackHandlers,
    hasHandler: (idOrAlias) => Boolean(resolveMounted(idOrAlias)?.entry),
    listActiveActions: (query) => registry.listActions(query).filter((action) => mounted.has(action.id)),
    execute,
    applyPlan,
  }
}

/** Shared renderer host used by StudioPage and the built-in Studio assistant bridge. */
export const RENDERER_CAPABILITY_HOST = createRendererCapabilityHost()
