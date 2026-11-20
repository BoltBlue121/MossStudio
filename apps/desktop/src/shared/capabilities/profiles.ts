import type { AgentMode, AiToolDefinition } from '../ai'
import type { ActionDescriptor, ActionEffect, ActionTarget, CapabilityId, CapabilitySurface, PolicyGate, SkillAudience } from './protocol'
import type { CapabilityRegistry, SynthesizedSkill } from './registry'

/**
 * Tool Profile projection and capability audit trail contracts.
 *
 * One registry projects tailored toolsets and matching Markdown skills for
 * different agents and safety postures without duplicating tool definitions.
 */

export type ToolProfileId = 'atomic' | 'proposal-only' | 'custom'

export interface ToolProfileOptions {
  profile: ToolProfileId
  surface?: CapabilitySurface
  enabledFlags?: Readonly<Record<string, boolean>>
  enabledPacks?: readonly CapabilityId[]
  includeExternal?: boolean
  headlessOnly?: boolean
  audience?: readonly SkillAudience[]
  nameStyle?: 'legacy-or-id' | 'canonical'
}

export interface ProjectedToolset {
  profile: ToolProfileId
  actions: ActionDescriptor[]
  tools: AiToolDefinition[]
  skill: SynthesizedSkill
}

const MUTATING_EFFECTS: readonly ActionEffect[] = ['write', 'run', 'delete', 'export', 'install', 'configure']

/** Project actions, provider tool schemas and synchronized Skill markdown for a Tool Profile. */
export function projectCapabilities(registry: CapabilityRegistry, options: ToolProfileOptions): ProjectedToolset {
  const actions = registry.listActions({
    surface: options.surface,
    enabledFlags: options.enabledFlags,
    enabledPacks: options.profile === 'custom' ? options.enabledPacks : options.enabledPacks,
    includeExternal: options.includeExternal,
    headlessOnly: options.headlessOnly,
    ...(options.profile === 'proposal-only' ? { excludeEffects: MUTATING_EFFECTS } : {}),
  })
  const tools = registry.toToolDefinitions(actions, { nameStyle: options.nameStyle ?? 'canonical' })
  const skill = registry.synthesizeSkill({
    actions,
    audience: options.audience,
  })
  return {
    profile: options.profile,
    actions,
    tools,
    skill,
  }
}

export type CapabilityCallSource = 'assistant' | 'ipc' | 'external-agent' | 'system'

/** Append-only audit record emitted for every capability execution (no secrets). */
export interface CapabilityAuditEntry {
  id: string
  timestamp: string
  source: CapabilityCallSource
  conversationId?: string
  actionId: CapabilityId
  packId: CapabilityId
  target: ActionTarget
  effects: readonly ActionEffect[]
  policyFloor: PolicyGate
  mode: AgentMode
  approved: boolean
  summary: string
  ok: boolean
  durationMs: number
  error?: string
}

export interface CapabilityAuditQuery {
  limit?: number
  conversationId?: string
  packId?: string
  actionId?: string
}
