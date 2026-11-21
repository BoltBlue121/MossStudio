import type { AgentMode, AiToolDefinition } from '../ai'
import type { ActionDescriptor, ActionEffect, ActionTarget, CapabilityId, CapabilitySurface, PolicyGate, SkillAudience } from './protocol'
import type { CapabilityRegistry, SynthesizedSkill } from './registry'

/**
 * Tool Profile projection and capability audit trail contracts.
 *
 * One registry projects tailored toolsets and matching Markdown skills for
 * different agents and safety postures without duplicating tool definitions.
 */

export type ToolProfileId = 'compact' | 'atomic' | 'proposal-only' | 'custom'

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

export const COMPACT_PROFILE_PACKS: readonly CapabilityId[] = [
  'studio.board.read',
  'studio.ask',
  'studio.board.cards',
  'studio.board.regions',
  'studio.board.sampling',
  'studio.board.wires',
  'studio.board.runs',
  'studio.projects',
  'models.catalog',
  'library.assets',
  'system.runtime',
  'remote.hosts',
]

const MUTATING_EFFECTS: readonly ActionEffect[] = ['write', 'run', 'delete', 'export', 'install', 'configure']

/** Project actions, provider tool schemas and synchronized Skill markdown for a Tool Profile. */
export function projectCapabilities(registry: CapabilityRegistry, options: ToolProfileOptions): ProjectedToolset {
  const actions = registry.listActions({
    surface: options.surface,
    enabledFlags: options.enabledFlags,
    enabledPacks: options.enabledPacks ?? (options.profile === 'compact' ? COMPACT_PROFILE_PACKS : undefined),
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
