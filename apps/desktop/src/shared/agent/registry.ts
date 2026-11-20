import type { AgentMode, AiToolDefinition } from '../ai'
import {
  BUILTIN_CAPABILITY_REGISTRY,
  LEGACY_TOOL_ORDER,
  type ActionDescriptor,
  type ActionRequirement,
  type LegacyAgentPack,
} from '../capabilities'
import type { ToolName } from './schemas'

export type { AgentMode }

/**
 * Legacy Studio assistant tool rack, derived from `BUILTIN_CAPABILITY_REGISTRY`.
 *
 * The canonical capability packs live in `shared/capabilities/`; this module
 * preserves the exact 13 `studio_*` view, JSON Schema projection and prompt
 * rules expected by the built-in Studio assistant.
 */

export type AgentPack = LegacyAgentPack

/** read: only looks. write: changes the canvas. run: starts a job. ask: asks the user. */
export type ToolRisk = 'read' | 'write' | 'run' | 'ask'

/** What must be true before a tool can run; checked once, in the executor. */
export type ToolRequirement = 'selection' | 'editable' | 'editable-or-style' | 'engine'

export interface AgentTool {
  name: ToolName
  /** Canonical capability id behind this legacy tool name. */
  capabilityId: ActionDescriptor['id']
  /** Short Chinese name, used on the tool line in the chat. */
  title: string
  pack: AgentPack
  /** English, for the model: what it does and when not to use it. */
  description: string
  risk: ToolRisk
  requires: readonly ToolRequirement[]
  /** One line for the chat, built from the arguments rather than from a JSON dump. */
  summarize(args: Record<string, unknown>): string
}

function riskOf(descriptor: ActionDescriptor): ToolRisk {
  if (descriptor.effects.includes('interact')) return 'ask'
  if (descriptor.effects.includes('run')) return 'run'
  if (descriptor.effects.some((effect) => ['write', 'delete', 'export', 'install', 'configure'].includes(effect))) {
    return 'write'
  }
  return 'read'
}

function requirementsOf(requires: readonly ActionRequirement[]): ToolRequirement[] {
  return requires.filter(
    (item): item is ToolRequirement => item === 'selection' || item === 'editable' || item === 'editable-or-style' || item === 'engine',
  )
}

export const AGENT_TOOLS: AgentTool[] = LEGACY_TOOL_ORDER.map((name) => {
  const registered = BUILTIN_CAPABILITY_REGISTRY.getAction(name)
  if (!registered || !registered.legacyPack) {
    throw new Error(`Built-in capability registry is missing legacy tool: ${name}`)
  }
  const { descriptor } = registered
  return {
    name,
    capabilityId: descriptor.id,
    title: descriptor.title,
    pack: registered.legacyPack,
    description: descriptor.description,
    risk: riskOf(descriptor),
    requires: requirementsOf(descriptor.requires),
    summarize: (args) => BUILTIN_CAPABILITY_REGISTRY.summarizeAction(name, args),
  }
})

export const AGENT_TOOL_NAMES: readonly ToolName[] = AGENT_TOOLS.map((tool) => tool.name)

export function toolByName(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name)
}

/** JSON Schema for one tool, without the `$schema` key some providers reject. */
export function toolSchema(name: ToolName): Record<string, unknown> {
  const registered = BUILTIN_CAPABILITY_REGISTRY.getAction(name)
  if (!registered) throw new Error(`Unknown agent tool: ${name}`)
  return { ...registered.descriptor.input }
}

/** The tool list a provider receives. */
export function toolDefinitions(tools: readonly AgentTool[] = AGENT_TOOLS): AiToolDefinition[] {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: toolSchema(tool.name) }))
}

export interface ToolsetInput {
  mode?: AgentMode
  /** Which screen the assistant sits on; only the Studio can change a Canvas today. */
  page?: 'studio' | 'library' | 'models' | 'training'
  /** False for providers that cannot call tools at all (the local Ollama path). */
  toolsSupported?: boolean
}

/**
 * Which packs are mounted right now. Both modes mount the same canvas and ask
 * tools; the mode changes how a write is applied (at once, or through a plan
 * card the user confirms), not what the model can see.
 */
export function resolveToolset(input: ToolsetInput = {}): AgentTool[] {
  if (input.toolsSupported === false) return []
  const page = input.page ?? 'studio'
  return AGENT_TOOLS.filter((tool) => {
    if (tool.pack === 'canvas.read' || tool.pack === 'ask') return true
    if (tool.pack === 'canvas.write' || tool.pack === 'storyboard') return page === 'studio'
    return false
  })
}

/** Rules about the tools themselves, kept next to their definitions. */
export const TOOL_RULES = `How to work:
- Read studio_read_context before changing anything you have not just seen.
- Words in the picture go through studio_add_text_layer: caption describes the lettering (style, weight, colour, placement), text holds exactly the characters to render. Never put the words in caption, and never leave text empty.
- Objects and characters go through studio_add_layer.
- Fix a region with studio_update_layer, addressed by its 1-based index from studio_read_context, instead of adding another one; delete it with studio_remove_layer.
- Ask with studio_ask_user when the picture depends on a choice only the user can make: composition, how a character looks, the exact wording, a size. One question, two to five concrete options. After asking, stop and say in one line what you are waiting for; the answer arrives as the next message.
- Before starting a generation the user did not just ask for, or any step that spends GPU time on several pictures, ask with studio_ask_approval: approve, reject, or change it. Never start a batch on your own.
- studio_ask_approval is a yes/no card. If the answer is a choice between options ("只跑镜 6，还是 6 镜一起"), that is studio_ask_user with those options, not a confirm card.
- A go-ahead is a card, not a sentence: when the only thing missing is permission, call studio_ask_approval instead of writing the question. Once the user approves, or answers 需要 / 好 / 可以, do the step — never ask for the same permission twice.
- A set of pictures (a series, a storyboard, "一套图") goes through studio_create_scenes: plan every scene, then build them in one call. Use studio_select_canvas to move between the new canvases and refine the ones that need it.
- To look at another picture of a set without leaving the canvas you are on, read it with studio_read_canvas by id; the project summary on every turn lists the ids.
- Every write result ends with problems: what still blocks generation. Clear them before calling studio_generate.
- studio_generate returns immediately with a job id; call it once per request and do not wait for the picture.
- Report the sampler values that were actually used, never values you made up.`

/** How the two modes differ, appended to the base prompt on every turn. */
export const MODE_RULES: Record<AgentMode, string> = {
  auto: `The user picked 自动模式. Make the changes yourself and describe them in one or two sentences. Only ask when the answer really decides the picture and you cannot pick a sensible default.`,
  advanced: `The user picked 高级模式. Every studio_* tool that changes the canvas is shown to them as a plan card and only applied when they confirm it, so:
- Put related edits in one turn, so the user confirms one plan instead of five.
- Make the plan concrete: exact captions, exact words, exact sizes. Say what will change in one sentence.
- If they asked for several pictures or a set, plan all of them before applying anything.
- Ask with studio_ask_user when a choice would change the result; do not guess on their behalf.
- Do not ask for approval before a write: the plan card is the approval. studio_ask_approval is for a step the plan does not cover, like spending GPU time on another canvas.`,
}
