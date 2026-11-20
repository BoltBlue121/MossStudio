import type { AgentMode, AiToolCall, AiToolResult } from '@shared/ai'
import { makeCard, type AgentCard } from '@shared/agent/cards'
import type { ToolArgs, ToolName } from '@shared/agent/schemas'
import { CapabilityFailure, RENDERER_CAPABILITY_HOST, type CapabilityHandler } from '../capabilities'
import type { StudioToolApi } from './types'

/**
 * Legacy Studio tool executor backed by `RENDERER_CAPABILITY_HOST`.
 *
 * Keeps the exhaustive `ToolName` handler table and `StudioToolApi` contract
 * intact while routing execution, validation, prechecks and plan application
 * through the unified capability host.
 */

let live: StudioToolApi | null = null
let disposeLegacyPacks: (() => void)[] = []

type Handler<N extends ToolName> = (args: ToolArgs<N>, api: StudioToolApi) => unknown | Promise<unknown>

const HANDLERS: { [N in ToolName]: Handler<N> } = {
  studio_read_context: (_args, api) => api.readContext(),

  studio_select_canvas: ({ id }, api) => api.selectCanvas(id),

  studio_read_canvas: ({ id }, api) => api.readCanvas(id),

  // Asking is a card in the chat, not a blocked tool call: the main process
  // attaches it to this turn, and the answer arrives as the next user message.
  studio_ask_user: ({ question, why, multiple, allowFreeText, options }) => ({
    shown: true,
    card: makeCard({ kind: 'choice', title: question, why, multiple, allowFreeText, options }),
  }),

  studio_ask_approval: ({ question, why, approveLabel, rejectLabel }) => {
    // A confirm card only holds 批准/拒绝; an either-or question needs the choice card.
    if (/还是|\bor\b/i.test(question)) {
      throw new CapabilityFailure('确认卡只能问是/否，两个方案二选一要用 studio_ask_user 出选择卡', { tool: 'studio_ask_user' })
    }
    return {
      shown: true,
      card: makeCard({
        kind: 'confirm',
        title: question,
        why,
        options: [
          { id: 'approve', label: approveLabel ?? '批准' },
          { id: 'reject', label: rejectLabel ?? '拒绝' },
        ],
      }),
    }
  },

  studio_set_prompt: ({ prompt }, api) => api.setPrompt(prompt),

  studio_set_sampler: (args, api) => {
    if (Object.values(args).every((value) => value === undefined)) throw new CapabilityFailure('没有可更新的字段')
    return api.setSampler(args)
  },

  studio_add_layer: ({ label, caption, bbox }, api) => api.addLayer({ label, caption, bbox }),

  studio_add_text_layer: ({ caption, text, bbox }, api) => api.addTextLayer({ caption, text, bbox }),

  studio_update_layer: ({ index, ...patch }, api) => api.updateLayer({ index, patch }),

  studio_remove_layer: ({ index }, api) => api.removeLayer(index),

  studio_generate: async ({ prompt }, api) => (await api.generate(prompt)) ?? { queued: true },

  studio_create_scenes: ({ scenes }, api) => api.createScenes(scenes),
}

function bindHandler<N extends ToolName>(name: N, api: StudioToolApi): CapabilityHandler {
  const handler = HANDLERS[name]
  return (args) => handler(args as ToolArgs<N>, api)
}

function clearLegacyPacks(): void {
  for (const dispose of disposeLegacyPacks) dispose()
  disposeLegacyPacks = []
}

export function setStudioApi(next: StudioToolApi | null, options: { mountLegacyPacks?: boolean } = {}): void {
  clearLegacyPacks()
  live = next
  if (!next || options.mountLegacyPacks === false) return
  const hostOptions = {
    checkState: () => next.state(),
    readProblems: () => next.problems(),
  }
  disposeLegacyPacks = [
    RENDERER_CAPABILITY_HOST.registerPackHandlers(
      'studio.board.read',
      {
        studio_read_context: bindHandler('studio_read_context', next),
        studio_select_canvas: bindHandler('studio_select_canvas', next),
        studio_read_canvas: bindHandler('studio_read_canvas', next),
      },
      hostOptions,
    ),
    RENDERER_CAPABILITY_HOST.registerPackHandlers(
      'studio.ask',
      {
        studio_ask_user: bindHandler('studio_ask_user', next),
        studio_ask_approval: bindHandler('studio_ask_approval', next),
      },
      hostOptions,
    ),
    RENDERER_CAPABILITY_HOST.registerPackHandlers(
      'studio.board.cards',
      {
        studio_set_prompt: bindHandler('studio_set_prompt', next),
        studio_create_scenes: bindHandler('studio_create_scenes', next),
      },
      hostOptions,
    ),
    RENDERER_CAPABILITY_HOST.registerPackHandlers(
      'studio.board.regions',
      {
        studio_add_layer: bindHandler('studio_add_layer', next),
        studio_add_text_layer: bindHandler('studio_add_text_layer', next),
        studio_update_layer: bindHandler('studio_update_layer', next),
        studio_remove_layer: bindHandler('studio_remove_layer', next),
      },
      hostOptions,
    ),
    RENDERER_CAPABILITY_HOST.registerPackHandlers(
      'studio.board.sampling',
      {
        studio_set_sampler: bindHandler('studio_set_sampler', next),
      },
      hostOptions,
    ),
    RENDERER_CAPABILITY_HOST.registerPackHandlers(
      'studio.board.runs',
      {
        studio_generate: bindHandler('studio_generate', next),
      },
      hostOptions,
    ),
  ]
}

export function getStudioApi(): StudioToolApi | null {
  return live
}

/**
 * Run the steps of a plan card through the unified capability host, in the
 * order they were planned.
 */
export async function applyPlan(card: AgentCard): Promise<{ applied: number; problems: string[] }> {
  return RENDERER_CAPABILITY_HOST.applyPlan(card)
}

export interface ExecuteOptions {
  mode?: AgentMode
  conversationId?: string
}

export async function executeStudioTool(call: AiToolCall, options: ExecuteOptions = {}): Promise<AiToolResult> {
  return RENDERER_CAPABILITY_HOST.execute(call, options)
}
