import { randomUUID } from 'node:crypto'
import type { AgentMode, AiToolCall, AiToolResult } from '@shared/ai'
import type { PlanStep } from '@shared/agent/cards'
import {
  BUILTIN_CAPABILITY_REGISTRY,
  projectCapabilities,
  type ActionDescriptor,
  type CapabilityAuditEntry,
  type CapabilityCallSource,
  type CapabilityId,
  type CapabilityRegistry,
  type CapabilitySurface,
  type ProjectedToolset,
  type SkillAudience,
  type SynthesizedSkill,
  type ToolProfileId,
} from '@shared/capabilities'
import { recordCapabilityAudit } from './audit'

/**
 * Unified Main-process capability dispatcher.
 *
 * Routes `target: 'main'` capabilities directly to main services (headless safe)
 * and `target: 'renderer'` capabilities to the active Studio window, enforcing
 * feature flags, Zod input validation, policy floors and append-only audit logs.
 */

export type MainCapabilityHandler = (
  args: Record<string, unknown>,
  context: {
    callId: string
    action: ActionDescriptor
    source: CapabilityCallSource
    conversationId?: string
  },
) => unknown | Promise<unknown>

export interface DispatchRequest {
  callId?: string
  name: string
  arguments?: Record<string, unknown> | string
  mode?: AgentMode
  source?: CapabilityCallSource
  conversationId?: string
  approved?: boolean
  runInRenderer?: (call: AiToolCall, mode: AgentMode, conversationId?: string) => Promise<AiToolResult>
}

export interface ListCapabilitiesInput {
  profile?: ToolProfileId
  surface?: CapabilitySurface
  enabledPacks?: readonly CapabilityId[]
  headlessOnly?: boolean
  includeExternal?: boolean
  audience?: readonly SkillAudience[]
  nameStyle?: 'legacy-or-id' | 'canonical'
}

export interface MainCapabilityDispatcher {
  readonly registry: CapabilityRegistry
  list(input?: ListCapabilitiesInput): ProjectedToolset
  skill(input?: ListCapabilitiesInput): SynthesizedSkill
  execute(request: DispatchRequest): Promise<AiToolResult>
}

export interface MainCapabilityDispatcherOptions {
  registry?: CapabilityRegistry
  mainHandlers: Readonly<Record<string, MainCapabilityHandler>>
  readFlags?: () => Readonly<Record<string, boolean>>
  runInRenderer?: (call: AiToolCall, mode: AgentMode, conversationId?: string) => Promise<AiToolResult>
  audit?: (entry: CapabilityAuditEntry) => void
}

function parseRawArgs(raw: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw !== 'string') return raw
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function serializeResult(data: unknown, extra?: Record<string, unknown>): AiToolResult {
  const body =
    data && typeof data === 'object' && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), ...extra }
      : { value: data, ...extra }
  return { ok: true, content: JSON.stringify(body) }
}

function fail(error: string, extra?: Record<string, unknown>): AiToolResult {
  return { ok: false, content: JSON.stringify({ error, ...extra }) }
}

function isMutating(descriptor: ActionDescriptor): boolean {
  return descriptor.effects.some((effect) => ['write', 'run', 'delete', 'export', 'install', 'configure'].includes(effect))
}

function extractError(result: AiToolResult): string | undefined {
  if (result.ok) return undefined
  try {
    const body = JSON.parse(result.content) as { error?: unknown }
    return typeof body.error === 'string' ? body.error : result.content.slice(0, 200)
  } catch {
    return result.content.slice(0, 200)
  }
}

export function createMainCapabilityDispatcher(options: MainCapabilityDispatcherOptions): MainCapabilityDispatcher {
  const registry = options.registry ?? BUILTIN_CAPABILITY_REGISTRY
  const readFlags: () => Readonly<Record<string, boolean>> = options.readFlags ?? (() => ({}))
  const audit = options.audit ?? recordCapabilityAudit

  function list(input: ListCapabilitiesInput = {}): ProjectedToolset {
    return projectCapabilities(registry, {
      profile: input.profile ?? 'atomic',
      surface: input.surface,
      enabledFlags: readFlags(),
      enabledPacks: input.enabledPacks,
      includeExternal: input.includeExternal,
      headlessOnly: input.headlessOnly,
      audience: input.audience,
      nameStyle: input.nameStyle ?? 'canonical',
    })
  }

  function skill(input: ListCapabilitiesInput = {}): SynthesizedSkill {
    return list(input).skill
  }

  async function execute(request: DispatchRequest): Promise<AiToolResult> {
    const startedAt = Date.now()
    const callId = request.callId ?? `cap-${randomUUID().slice(0, 8)}`
    const mode: AgentMode = request.mode ?? 'auto'
    const source: CapabilityCallSource = request.source ?? 'ipc'
    const approved = request.approved === true
    const rawArgs = parseRawArgs(request.arguments)
    const registered = registry.getAction(request.name)

    const record = (descriptor: ActionDescriptor, result: AiToolResult): AiToolResult => {
      audit({
        id: callId,
        timestamp: new Date().toISOString(),
        source,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        actionId: descriptor.id,
        packId: descriptor.packId,
        target: descriptor.target,
        effects: descriptor.effects,
        policyFloor: descriptor.policyFloor,
        mode,
        approved,
        summary: registry.summarizeAction(descriptor.id, rawArgs),
        ok: result.ok,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(result.ok ? {} : { error: extractError(result) }),
      })
      return result
    }

    if (!registered) {
      return fail(`未知工具 ${request.name}`)
    }

    const { descriptor } = registered
    const pack = registry.getPack(descriptor.packId)
    if (pack?.featureFlag) {
      const flags = readFlags()
      if (flags[pack.featureFlag] !== true) {
        return record(descriptor, fail(`功能「${pack.title}」未开启，请先在设置 › 功能中启用`))
      }
    }

    if (descriptor.policyFloor === 'human-only') {
      return record(descriptor, fail(`操作「${descriptor.title}」需要你在界面中手动完成`))
    }

    // Renderer-targeted actions delegate to the live RendererCapabilityHost (which owns Studio prechecks and plan deferral).
    if (descriptor.target === 'renderer') {
      if (descriptor.policyFloor === 'approval' && mode === 'auto' && !approved) {
        return record(descriptor, fail(`操作「${descriptor.title}」需要你的确认后才能执行`, { requiresApproval: true }))
      }
      const runner = request.runInRenderer ?? options.runInRenderer
      if (!runner) {
        return record(descriptor, fail('Studio 窗口尚未就绪，请先打开创作页'))
      }
      const rawText = typeof request.arguments === 'string' ? request.arguments : JSON.stringify(rawArgs)
      try {
        const result = await runner({ id: callId, name: request.name, arguments: rawText }, mode, request.conversationId)
        return record(descriptor, result)
      } catch (error) {
        return record(descriptor, fail(error instanceof Error ? error.message : String(error)))
      }
    }

    // Main-targeted actions validate, enforce policy gates and execute directly in the main process.
    const validated = registry.validateInput(descriptor.id, rawArgs)
    if (!validated.ok) {
      return record(descriptor, fail(validated.error))
    }

    const summary = registry.summarizeAction(descriptor.id, validated.data)
    if (mode === 'advanced' && isMutating(descriptor)) {
      const proposed: PlanStep = { tool: request.name, args: validated.data, label: summary }
      return record(descriptor, serializeResult({ proposed }))
    }
    if (descriptor.policyFloor === 'approval' && !approved) {
      return record(descriptor, fail(`操作「${descriptor.title}」需要你的确认后才能执行`, { requiresApproval: true }))
    }

    const handler = options.mainHandlers[descriptor.id]
    if (!handler) {
      return record(descriptor, fail(`能力 ${descriptor.title} 尚未绑定主进程处理器`))
    }

    try {
      const data = await handler(validated.data, {
        callId,
        action: descriptor,
        source,
        conversationId: request.conversationId,
      })
      if (!isMutating(descriptor)) return record(descriptor, serializeResult(data))
      return record(descriptor, serializeResult(data, { summary }))
    } catch (error) {
      return record(descriptor, fail(error instanceof Error ? error.message : String(error)))
    }
  }

  return {
    registry,
    list,
    skill,
    execute,
  }
}
