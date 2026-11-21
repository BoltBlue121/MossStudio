import { normalizeCanvasAdapters } from '@shared/adapters'
import { toolByName } from '@shared/agent/registry'
import { BUILTIN_CAPABILITY_REGISTRY } from '@shared/capabilities'
import type { ProjectCanvas, ProjectLayer } from '@shared/types'
import { dimensions } from '../../../lib/format'
import { canvasDescription } from '../prompt'

/** What the collab panel knows of the board, read when a message is sent. */
export interface CollabBoardContext {
  projectId: string | null
  projectName: string
  canvas: ProjectCanvas | null
  modelName?: string
  /** The region selected on the canvas, if any. */
  selectedRegionId?: string | null
}

/** The parts of the board context a person can leave out with the chips above the message box. */
export type ContextPart = 'canvas' | 'model' | 'prompt' | 'regions' | 'selection'
/** `false` leaves a part out; anything else keeps it. */
export type ContextFilter = Partial<Record<ContextPart, boolean>>

export interface ContextChip {
  part: ContextPart
  label: string
  /** The value behind the chip, shown as its tooltip. */
  detail: string
}

function regionLine(layer: ProjectLayer): string {
  return `${layer.kind}: ${layer.caption.slice(0, 100)}${layer.text ? ` [${layer.text.slice(0, 100)}]` : ''}${layer.visible === false ? ' (hidden)' : ''}`
}

function selectedRegion(board: CollabBoardContext): ProjectLayer | undefined {
  if (!board.canvas || !board.selectedRegionId) return undefined
  return board.canvas.layers.find((layer) => layer.id === board.selectedRegionId)
}

/** One chip per part that has something to send for the current board. */
export function contextChips(board: CollabBoardContext): ContextChip[] {
  const { canvas } = board
  if (!canvas) return []
  const adapters = normalizeCanvasAdapters(canvas.adapters)
  const chips: ContextChip[] = [
    {
      part: 'canvas',
      label: canvas.title.slice(0, 24) || '当前画面',
      detail: `${canvas.title} · ${dimensions(canvas.width, canvas.height)}`,
    },
    {
      part: 'model',
      label: '模型与 LoRA',
      detail: [board.modelName ?? canvas.modelBundleId ?? '未选模型', adapters.length ? `${adapters.length} 个 LoRA` : '']
        .filter(Boolean)
        .join(' · '),
    },
    { part: 'prompt', label: '描述', detail: canvasDescription(canvas).slice(0, 200) || '（空）' },
  ]
  if (canvas.layers.length) {
    chips.push({
      part: 'regions',
      label: `区域 ${canvas.layers.length}`,
      detail: canvas.layers
        .map((layer) => layer.caption)
        .join('、')
        .slice(0, 200),
    })
  }
  const region = selectedRegion(board)
  if (region) chips.push({ part: 'selection', label: `选区 · ${region.caption.slice(0, 12) || region.kind}`, detail: regionLine(region) })
  return chips
}

/** The board facts sent with a message: never file paths, only what the person can see. */
export function formatBoardContext(board: CollabBoardContext, filter: ContextFilter = {}): string {
  const { projectId, projectName, canvas, modelName } = board
  const project = `Studio project: ${projectName.slice(0, 160)} (${projectId ?? 'unsaved'})`
  const workbenchRule = [
    `Workbench rule (projectId=${projectId ?? 'unsaved'}${canvas ? `, canvasId=${canvas.id}` : ''}):`,
    '- You are replying inside the live MossStudio workbench sidebar. ALWAYS create/edit cards, prompts, LoRAs, and run generation through MossStudio MCP tools (studio__cards__create, studio__board__set_prompt, studio__sampling__set, studio__sampling__set_loras, studio__runs__generate, remote__hosts__*) so every prompt, running job, and output appears live in the Studio UI.',
    '- Do not bypass MossStudio with standalone shell or external drawing scripts when MossStudio can generate on the canvas.',
    '- If an external post-processing step (such as background removal) produces a final image outside MossStudio, import it back onto the open canvas with studio__projects__import_image({ path }).',
  ].join('\n')
  if (!canvas) return `${project}\nNo canvas selected.\n${workbenchRule}`.slice(0, 3500)
  const keep = (part: ContextPart): boolean => filter[part] !== false
  const lines = [project]
  if (keep('canvas')) {
    lines.push(
      `Selected canvas: ${canvas.title.slice(0, 160)} (${canvas.id}, ${canvas.kind})`,
      `Size: ${dimensions(canvas.width, canvas.height)}`,
    )
  }
  if (keep('model')) {
    const model = [modelName, canvas.modelBundleId].filter(Boolean).join(' · ')
    const adapters = normalizeCanvasAdapters(canvas.adapters)
      .map((item) => `${item.id} (${item.strength})`)
      .join(', ')
    lines.push(`Model: ${model.slice(0, 250) || 'none'}`, `LoRAs: ${adapters.slice(0, 600) || 'none'}`)
  }
  if (keep('prompt')) lines.push(`Prompt: ${canvasDescription(canvas).slice(0, 1500) || '(empty)'}`)
  if (keep('regions')) lines.push(`Regions: ${canvas.layers.slice(0, 20).map(regionLine).join('; ') || 'none'}`)
  const region = keep('selection') ? selectedRegion(board) : undefined
  if (region) lines.push(`Selected region: ${regionLine(region)} @ ${region.bbox.join(',')}`)
  const omitted = (['canvas', 'model', 'prompt', 'regions'] as const).filter((part) => !keep(part))
  if (omitted.length) lines.push(`Left out by the user: ${omitted.join(', ')}`)
  lines.push(workbenchRule)
  return lines.join('\n').slice(0, 3500)
}

/** Plain-language name of a capability (`studio.cards.create`) or a built-in tool. */
export function capabilityLabel(name: string): string {
  return BUILTIN_CAPABILITY_REGISTRY.getAction(name)?.descriptor.title ?? toolByName(name)?.title ?? name
}
