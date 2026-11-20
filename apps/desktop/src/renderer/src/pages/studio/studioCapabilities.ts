import type {
  Catalog,
  ControlAdapterEntry,
  EngineFeatures,
  EngineReadiness,
  GpuInventorySnapshot,
  JobRecord,
  ManagedHost,
  ProjectCanvas,
  ProjectLayer,
  Settings,
} from '@shared/types'
import type { UpdaterState } from '@shared/update'
import { normalizeCanvasAdapters } from '@shared/adapters'
import { cliGpuUuids, generationGpus } from '@shared/bundleFit'
import { activeCanvasBranchIds } from '@shared/canvasJobBranch'
import { makeCard } from '@shared/agent/cards'
import type { AppActionArgs, StudioActionArgs } from '@shared/capabilities'
import { Ipc } from '@shared/channels'
import type { AddedLayer, LayerBox, StudioToolApi } from '../../lib/agentTools'
import { call } from '../../lib/api'
import { CapabilityFailure, RENDERER_CAPABILITY_HOST, type CapabilityHandler, type RendererCapabilityHost } from '../../lib/capabilities'
import { clampBox } from '../../lib/layout'
import {
  addRegion,
  canvasFromPicture,
  copyAsLayout,
  createImageCanvas,
  createLayoutCanvas,
  defaultSettings,
  editLayer,
  reorderLayers,
  resizeCanvas,
  sceneCanvas,
  settingsFrom,
  type RegionInput,
} from './canvases'
import { canConnect } from './connect'
import { clampDimension, isSeedLocked, nearestQuality, qualityPreset, samplingForBundle, SEED_MAX } from './defaults'
import { resolveJobInputs } from './jobInputs'
import { ACTIVE_JOB_STATES } from './jobStatus'
import { linksOf, patchControl, patchControlImage, patchInit, patchReferences, removeLink, setControlAdapter, setLink } from './links'
import {
  createStyleCanvas,
  generationCanvas,
  nodeBlockers,
  seriesFromStyle,
  styleLoraNote,
  upscaleFromPicture,
  upscaleProblem,
  withUpscaleScale,
  withUpscaleSize,
} from './nodes'
import { canvasDescription, compileCanvasPrompt, withDescription } from './prompt'
import { deriveReadiness, resolveBundle } from './readiness'
import {
  boardCanvases,
  canDropRun,
  canUnpin,
  dropRun,
  givesPicture,
  keepCardsShown,
  pictureLink,
  pinRun,
  unpinRun,
  withRunSettings,
} from './runs'
import { clampHiresDimension, withHiresPatch, withHiresScale, withSampling } from './sampling'
import { tidyPlaces } from './selection'
import type { StudioProject } from './useStudioProject'

/**
 * Studio capability handler bindings.
 *
 * Pure factory that wires all seven Studio capability packs (38 actions) onto
 * a `RendererCapabilityHost` using the existing pure Studio domain functions,
 * so the board logic stays testable without mounting React.
 */

export interface StudioCapabilityDeps {
  project: Pick<
    StudioProject,
    'projectId' | 'projectName' | 'canvasesRef' | 'selectedRef' | 'setCanvases' | 'updateCanvas' | 'select' | 'removeCanvas'
  > &
    Partial<Pick<StudioProject, 'openProject' | 'newProject' | 'rename' | 'saveNow'>>
  importImageFile?: (projectId: string, path: string) => Promise<{ path: string; width: number; height: number }>
  generate: (canvasId?: string) => Promise<{ queued: boolean; canvasId?: string; jobId?: string; error?: string }>
  cancelJob: (jobId: string) => Promise<unknown>
  catalog: Catalog | null
  preferredBundleId: string | null
  engineReadiness: EngineReadiness | null
  settings: Settings | null
  update: UpdaterState | null
  remoteHost: ManagedHost | null
  boardFeatures: EngineFeatures | null | undefined
  controlAdapters: readonly ControlAdapterEntry[]
  controlAdaptersLoaded: boolean
  gpuInventory: GpuInventorySnapshot | null
  jobs: readonly JobRecord[]
}

export function registerStudioCapabilities(
  getDeps: () => StudioCapabilityDeps,
  host: RendererCapabilityHost = RENDERER_CAPABILITY_HOST,
): { api: StudioToolApi; dispose: () => void } {
  const current = (): ProjectCanvas | null => {
    const { project } = getDeps()
    return project.canvasesRef.current.find((canvas) => canvas.id === project.selectedRef.current) ?? null
  }

  const findCanvas = (canvasId?: string): ProjectCanvas => {
    const { project } = getDeps()
    if (!canvasId) {
      const selected = current()
      if (!selected) throw new CapabilityFailure('先在画布上选中一个画面')
      return selected
    }
    const found = project.canvasesRef.current.find((canvas) => canvas.id === canvasId)
    if (!found) throw new CapabilityFailure(`没有这个画面：${canvasId}`)
    return found
  }

  const editable = (canvasId?: string): ProjectCanvas => {
    const canvas = findCanvas(canvasId)
    if (canvas.kind === 'style') throw new CapabilityFailure('选中的是风格，只能改它的描述或 LoRA')
    if (canvas.kind !== 'layout') throw new CapabilityFailure('选中的是生成结果，不能修改；请先复制成新画面')
    return canvas
  }

  const ensureNotRunning = (canvas: ProjectCanvas): void => {
    if (canvas.jobState && ACTIVE_JOB_STATES.has(canvas.jobState)) {
      throw new CapabilityFailure('这张画面正在生成，尺寸和采样先别改；等它跑完，或者先取消')
    }
  }

  const pixelsOf = (value: LayerBox, canvas: ProjectCanvas): [number, number, number, number] =>
    clampBox(
      [value.x * canvas.width, value.y * canvas.height, (value.x + value.w) * canvas.width, (value.y + value.h) * canvas.height],
      canvas.width,
      canvas.height,
    )

  const layerAt = (canvas: ProjectCanvas, index: number): ProjectLayer => {
    const layer = canvas.layers[index - 1]
    if (!layer) throw new CapabilityFailure(`没有第 ${index} 个区域；先用 studio_read_context 看一遍画面`)
    return layer
  }

  const layerById = (canvas: ProjectCanvas, layerId: string): ProjectLayer => {
    const layer = canvas.layers.find((item) => item.id === layerId)
    if (!layer) throw new CapabilityFailure(`没有这个区域：${layerId}`)
    return layer
  }

  const addOne = (input: RegionInput): AddedLayer => {
    const canvas = editable()
    if (canvas.upscale) throw new CapabilityFailure('放大按原图重画，没有区域')
    const { canvas: next, region } = addRegion(canvas, input)
    getDeps().project.updateCanvas(canvas.id, () => next)
    return { added: region.id, bbox: region.bbox, index: canvas.layers.length + 1 }
  }

  const viewOf = (canvas: ProjectCanvas) => ({
    id: canvas.id,
    kind: canvas.kind,
    title: canvas.title,
    width: canvas.width,
    height: canvas.height,
    steps: canvas.steps,
    cfg: canvas.cfg,
    seed: isSeedLocked(canvas) ? canvas.seed : 'random',
    prompt: canvasDescription(canvas),
    negative: canvas.negative,
    ...(canvas.modelBundleId ? { modelBundleId: canvas.modelBundleId } : {}),
    ...(canvas.upscale ? { upscale: canvas.upscale } : {}),
    ...(canvas.adapters?.length ? { adapters: canvas.adapters } : {}),
    ...(canvas.sampling ? { sampling: canvas.sampling } : {}),
    ...(canvas.inputs ? { inputs: linksOf(canvas) } : {}),
    layers: canvas.layers.map((layer, index) => ({
      id: layer.id,
      index: index + 1,
      label: layer.kind,
      caption: layer.caption,
      text: layer.text,
      bbox: layer.bbox.map((value) => Math.round(value)),
      visible: layer.visible !== false,
    })),
  })

  const diagnoseCanvas = (canvas: ProjectCanvas | null) => {
    const deps = getDeps()
    const canvases = deps.project.canvasesRef.current
    const busyIds = activeCanvasBranchIds(canvases, [...deps.jobs])
    if (!canvas) {
      return {
        ready: false,
        busy: false,
        canvasId: null,
        blockers: [{ id: 'selection', message: '先在画布上选中一个画面' }],
        features: deps.boardFeatures ?? null,
      }
    }
    const busy = busyIds.has(canvas.id)
    if (canvas.kind !== 'layout') {
      return {
        ready: false,
        busy,
        canvasId: canvas.id,
        kind: canvas.kind,
        blockers: [{ id: 'kind', message: canvas.kind === 'style' ? '风格不能单独生成，把它接到画面上' : '只有可编辑的画面才能生成' }],
        features: deps.boardFeatures ?? null,
      }
    }
    const generating = generationCanvas(canvas, canvases)
    const bundle = resolveBundle(deps.catalog, canvas.modelBundleId, deps.preferredBundleId)
    const inputBlockers = [
      ...nodeBlockers(generating, canvases),
      ...resolveJobInputs(generating, {
        canvases,
        features: deps.boardFeatures,
        controlAdapters: deps.controlAdapters,
        controlAdaptersLoaded: deps.controlAdaptersLoaded,
      }).blockers,
    ]
    const gpus = canvas.deviceUuid
      ? (deps.gpuInventory?.devices.filter((device) => device.uuid === canvas.deviceUuid) ?? [])
      : generationGpus(deps.gpuInventory?.devices, deps.settings)
    const derived = deriveReadiness({
      canvas: generating,
      catalog: deps.catalog,
      bundle,
      engine: deps.engineReadiness,
      setupDone: deps.settings ? deps.settings.onboardingState === 'completed' || deps.settings.onboardingState === 'dismissed' : true,
      remote: deps.remoteHost ? { name: deps.remoteHost.name, modelPath: deps.remoteHost.modelPath } : null,
      inputBlockers,
      update: deps.update,
      features: deps.boardFeatures,
      gpus,
      cliGpus: cliGpuUuids(deps.engineReadiness),
    })
    const loraNote = styleLoraNote(canvas, canvases)
    const blockers = derived.blockers.map((blocker) =>
      loraNote && ['adapters', 'remote-adapters', 'lora-unsupported'].includes(blocker.id)
        ? { ...blocker, message: `${blocker.message}${loraNote}` }
        : blocker,
    )
    return {
      ready: !busy && blockers.length === 0,
      busy,
      canvasId: canvas.id,
      kind: canvas.kind,
      bundleId: bundle.bundle?.id ?? null,
      blockers: blockers.map((blocker) => ({
        id: blocker.id,
        message: blocker.message,
        ...(blocker.action ? { action: blocker.action } : {}),
      })),
      features: deps.boardFeatures ?? null,
    }
  }

  const api: StudioToolApi = {
    state: () => {
      const canvas = current()
      return { hasSelection: canvas !== null, editable: canvas?.kind === 'layout', selectedKind: canvas?.kind }
    },
    readContext: () => {
      const { project } = getDeps()
      const canvas = current()
      return {
        project: { id: project.projectId, name: project.projectName },
        canvases: project.canvasesRef.current.map((item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title,
          width: item.width,
          height: item.height,
          jobState: item.jobState ?? 'idle',
          outputs: item.outputs?.length ?? 0,
        })),
        selected: canvas ? viewOf(canvas) : null,
        notes:
          'prompt is the overall description; the final prompt is compiled from it plus the visible regions. bbox is [x1,y1,x2,y2] in canvas pixels; the tools take normalised 0-1 x/y/w/h. steps snap to 8 (fast), 20 (standard) or 50 (fine). A text region needs both strings: caption is the lettering style, text is exactly what is rendered.',
      }
    },
    readCanvas: (id) => {
      const { project } = getDeps()
      const canvas = project.canvasesRef.current.find((item) => item.id === id)
      if (!canvas) throw new CapabilityFailure(`没有这个画面：${id}`)
      return { ...viewOf(canvas), selected: project.selectedRef.current === id }
    },
    snapshot: () => {
      const canvas = current()
      if (!canvas) return null
      const { project } = getDeps()
      return {
        title: canvas.title,
        description: canvasDescription(canvas),
        width: canvas.width,
        height: canvas.height,
        regions: canvas.layers.map((layer) => ({
          kind: layer.kind,
          caption: layer.caption,
          text: layer.text,
          visible: layer.visible !== false,
        })),
        project: {
          name: project.projectName,
          selectedId: canvas.id,
          canvases: project.canvasesRef.current.map((item) => ({
            id: item.id,
            title: item.title,
            kind: item.kind,
            width: item.width,
            height: item.height,
            jobState: item.jobState ?? 'idle',
          })),
        },
      }
    },
    setPrompt: (value) => {
      const selectedStyle = current()
      const canvas = selectedStyle?.kind === 'style' ? selectedStyle : editable()
      getDeps().project.updateCanvas(canvas.id, (item) => withDescription(item, value))
      return { written: value.length }
    },
    setSampler: (patch) => {
      const canvas = editable()
      ensureNotRunning(canvas)
      if (canvas.upscale && (patch.width !== undefined || patch.height !== undefined)) {
        throw new CapabilityFailure('放大的尺寸跟着原图走，只能改放大倍数')
      }
      let next = canvas
      if (patch.width !== undefined || patch.height !== undefined) {
        next = resizeCanvas(
          next,
          clampDimension(patch.width ?? next.width, next.width),
          clampDimension(patch.height ?? next.height, next.height),
        )
      }
      if (patch.steps !== undefined) {
        const preset = qualityPreset(nearestQuality(patch.steps))
        next = { ...next, steps: preset.steps, cfg: patch.cfg === undefined ? preset.cfg : next.cfg }
      }
      if (patch.cfg !== undefined) next = { ...next, cfg: Math.min(20, Math.max(0, patch.cfg)) }
      if (patch.seed !== undefined) next = { ...next, seed: Math.min(SEED_MAX, Math.max(0, Math.round(patch.seed))), seedLocked: true }
      getDeps().project.updateCanvas(canvas.id, () => next)
      return { width: next.width, height: next.height, steps: next.steps, cfg: next.cfg, seed: isSeedLocked(next) ? next.seed : 'random' }
    },
    addLayer: ({ label, caption, bbox }) => addOne({ kind: label, caption, bbox }),
    addTextLayer: ({ caption, text, bbox }) => addOne({ kind: 'text', caption, text, bbox }),
    updateLayer: ({ index, patch }) => {
      const canvas = editable()
      const layer = layerAt(canvas, index)
      const next = editLayer(layer, { ...patch, bbox: patch.bbox ? pixelsOf(patch.bbox, canvas) : undefined }, canvas)
      getDeps().project.updateCanvas(canvas.id, (item) => ({
        ...item,
        layers: item.layers.map((entry) => (entry.id === layer.id ? next : entry)),
      }))
      return { updated: layer.id, index }
    },
    removeLayer: (index) => {
      const canvas = editable()
      const layer = layerAt(canvas, index)
      getDeps().project.updateCanvas(canvas.id, (item) => ({
        ...item,
        layers: item.layers.filter((entry) => entry.id !== layer.id),
      }))
      return { removed: layer.id, index }
    },
    createScenes: (scenes) => {
      const { project } = getDeps()
      const base = settingsFrom(current())
      const made: ProjectCanvas[] = []
      for (const scene of scenes) {
        made.push(sceneCanvas(scene, [...project.canvasesRef.current, ...made], base))
      }
      project.setCanvases([...project.canvasesRef.current, ...made])
      const last = made[made.length - 1]
      if (last) project.select(last.id)
      return { created: made.map((item) => ({ id: item.id, title: item.title })) }
    },
    selectCanvas: (id) => {
      const { project } = getDeps()
      const canvas = project.canvasesRef.current.find((item) => item.id === id)
      if (!canvas) throw new CapabilityFailure(`没有这个画面：${id}`)
      project.select(id)
      return { selected: id, title: canvas.title }
    },
    generate: async (value) => {
      const canvas = editable()
      if (value?.trim()) getDeps().project.updateCanvas(canvas.id, (item) => withDescription(item, value))
      const result = await getDeps().generate(canvas.id)
      if (!result.queued) throw new CapabilityFailure(result.error ?? '没有开始生成')
      return result
    },
    problems: () => {
      const canvas = current()
      if (!canvas) return []
      const compiled = compileCanvasPrompt(canvas)
      return compiled.ok ? [] : compiled.errors
    },
  }

  const hostOptions = {
    checkState: () => api.state(),
    readProblems: () => api.problems(),
  }

  const typed = <Id extends keyof StudioActionArgsMap>(
    fn: (args: StudioActionArgs<Id>) => unknown | Promise<unknown>,
  ): CapabilityHandler => {
    return (args) => fn(args as StudioActionArgs<Id>)
  }

  const disposers = [
    host.registerPackHandlers(
      'studio.board.read',
      {
        'studio.board.read_context': () => api.readContext(),
        'studio.board.select_canvas': typed<'studio.board.select_canvas'>(({ id }) => api.selectCanvas(id)),
        'studio.board.read_canvas': typed<'studio.board.read_canvas'>(({ id }) => api.readCanvas(id)),
        'studio.board.diagnose': typed<'studio.board.diagnose'>(({ canvasId }) => {
          const canvas = canvasId ? findCanvas(canvasId) : current()
          return diagnoseCanvas(canvas)
        }),
      },
      hostOptions,
    ),
    host.registerPackHandlers(
      'studio.ask',
      {
        'studio.ask.user': typed<'studio.ask.user'>(({ question, why, multiple, allowFreeText, options }) => ({
          shown: true,
          card: makeCard({ kind: 'choice', title: question, why, multiple, allowFreeText, options }),
        })),
        'studio.ask.approval': typed<'studio.ask.approval'>(({ question, why, approveLabel, rejectLabel }) => {
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
        }),
      },
      hostOptions,
    ),
    host.registerPackHandlers(
      'studio.board.cards',
      {
        'studio.board.set_prompt': typed<'studio.board.set_prompt'>(({ prompt }) => api.setPrompt(prompt)),
        'studio.board.create_scenes': typed<'studio.board.create_scenes'>(({ scenes }) => api.createScenes(scenes)),
        'studio.cards.create': typed<'studio.cards.create'>(({ title, prompt, width, height, modelBundleId, select = true }) => {
          const { project, catalog } = getDeps()
          const base = settingsFrom(current())
          if (modelBundleId && catalog && !catalog.bundles.some((item) => item.id === modelBundleId)) {
            throw new CapabilityFailure(`模型库里没有这个模型：${modelBundleId}`)
          }
          let created = createLayoutCanvas(project.canvasesRef.current, {
            ...base,
            ...(width !== undefined ? { width: clampDimension(width, base.width) } : {}),
            ...(height !== undefined ? { height: clampDimension(height, base.height) } : {}),
            ...(modelBundleId ? { modelBundleId } : {}),
          })
          if (title) created = { ...created, title }
          if (prompt !== undefined) created = withDescription(created, prompt)
          project.setCanvases([...project.canvasesRef.current, created])
          if (select) project.select(created.id)
          return { id: created.id, title: created.title, width: created.width, height: created.height }
        }),
        'studio.cards.duplicate': typed<'studio.cards.duplicate'>(({ canvasId, select = true }) => {
          const { project } = getDeps()
          const source = findCanvas(canvasId)
          if (source.kind === 'image' || source.kind === 'style') {
            throw new CapabilityFailure('只有画面或生成结果可以复制为新画面')
          }
          const copy = copyAsLayout(source, project.canvasesRef.current)
          project.setCanvases([...project.canvasesRef.current, copy])
          if (select) project.select(copy.id)
          return { id: copy.id, title: copy.title, sourceId: source.id }
        }),
        'studio.cards.create_style': typed<'studio.cards.create_style'>(({ title, prompt, adapters, select = false }) => {
          const { project } = getDeps()
          let created = createStyleCanvas(project.canvasesRef.current)
          if (title) created = { ...created, title }
          if (prompt !== undefined) created = withDescription(created, prompt)
          if (adapters) created = { ...created, adapters: normalizeCanvasAdapters(adapters) }
          project.setCanvases([...project.canvasesRef.current, created])
          if (select) project.select(created.id)
          return { id: created.id, title: created.title }
        }),
        'studio.cards.create_upscale': typed<'studio.cards.create_upscale'>(({ sourceCanvasId, scale, strength, select = true }) => {
          const { project } = getDeps()
          const canvases = project.canvasesRef.current
          const source = findCanvas(sourceCanvasId)
          if (!givesPicture(source, canvases)) throw new CapabilityFailure('这张卡片还没有可用的图片，不能放大')
          const link = pictureLink(canvases, { canvasId: sourceCanvasId })
          const problem = upscaleProblem(canvases, link)
          if (problem) throw new CapabilityFailure(problem)
          const built = upscaleFromPicture(canvases, sourceCanvasId, { fallback: settingsFrom(current()) })
          if (!built) throw new CapabilityFailure('这张图片无法创建放大节点')
          let created = built.created
          if (scale !== undefined) created = withUpscaleScale(created, scale, built.canvases)
          if (strength !== undefined) created = patchInit(created, { strength })
          const nextCanvases = built.canvases.map((item) => (item.id === created.id ? created : item))
          project.setCanvases(nextCanvases)
          if (select) project.select(created.id)
          return { id: created.id, title: created.title, width: created.width, height: created.height, scale: created.upscale?.scale ?? 2 }
        }),
        'studio.cards.set_upscale_scale': typed<'studio.cards.set_upscale_scale'>(({ canvasId, scale }) => {
          const { project } = getDeps()
          const canvas = editable(canvasId)
          if (!canvas.upscale) throw new CapabilityFailure('这张画面不是放大节点')
          ensureNotRunning(canvas)
          const next = withUpscaleScale(canvas, scale, project.canvasesRef.current)
          project.updateCanvas(canvas.id, () => next)
          return { id: next.id, scale: next.upscale?.scale ?? scale, width: next.width, height: next.height }
        }),
        'studio.cards.delete': typed<'studio.cards.delete'>(({ canvasId }) => {
          const { project } = getDeps()
          const target = findCanvas(canvasId)
          const removedLinks = project.removeCanvas(target.id)
          return { deleted: target.id, title: target.title, removedLinks }
        }),
        'studio.cards.tidy': typed<'studio.cards.tidy'>(({ canvasIds }) => {
          const { project } = getDeps()
          const visible = boardCanvases(project.canvasesRef.current)
          const targetCards = canvasIds ? visible.filter((item) => canvasIds.includes(item.id)) : visible
          if (targetCards.length < 2) return { moved: 0 }
          const places = new Map(tidyPlaces(targetCards).map((item) => [item.id, item]))
          project.setCanvases((previous) =>
            previous.map((item) => {
              const spot = places.get(item.id)
              return spot ? { ...item, x: spot.x, y: spot.y } : item
            }),
          )
          return { moved: places.size }
        }),
      },
      hostOptions,
    ),
    host.registerPackHandlers(
      'studio.board.regions',
      {
        'studio.regions.add': typed<'studio.regions.add'>(({ label, caption, bbox }) => api.addLayer({ label, caption, bbox })),
        'studio.regions.add_text': typed<'studio.regions.add_text'>(({ caption, text, bbox }) => api.addTextLayer({ caption, text, bbox })),
        'studio.regions.update': typed<'studio.regions.update'>(({ index, ...patch }) => api.updateLayer({ index, patch })),
        'studio.regions.remove': typed<'studio.regions.remove'>(({ index }) => api.removeLayer(index)),
        'studio.regions.update_by_id': typed<'studio.regions.update_by_id'>(({ canvasId, layerId, ...patch }) => {
          const canvas = editable(canvasId)
          if (canvas.upscale) throw new CapabilityFailure('放大按原图重画，没有区域')
          const layer = layerById(canvas, layerId)
          const next = editLayer(layer, { ...patch, bbox: patch.bbox ? pixelsOf(patch.bbox, canvas) : undefined }, canvas)
          getDeps().project.updateCanvas(canvas.id, (item) => ({
            ...item,
            layers: item.layers.map((entry) => (entry.id === layer.id ? next : entry)),
          }))
          return { canvasId: canvas.id, updated: layer.id }
        }),
        'studio.regions.remove_by_id': typed<'studio.regions.remove_by_id'>(({ canvasId, layerId }) => {
          const canvas = editable(canvasId)
          const layer = layerById(canvas, layerId)
          getDeps().project.updateCanvas(canvas.id, (item) => ({
            ...item,
            layers: item.layers.filter((entry) => entry.id !== layer.id),
          }))
          return { canvasId: canvas.id, removed: layer.id }
        }),
        'studio.regions.reorder': typed<'studio.regions.reorder'>(({ canvasId, fromLayerId, toLayerId }) => {
          const canvas = editable(canvasId)
          layerById(canvas, fromLayerId)
          layerById(canvas, toLayerId)
          const reordered = reorderLayers(canvas.layers, fromLayerId, toLayerId)
          getDeps().project.updateCanvas(canvas.id, (item) => ({ ...item, layers: reordered }))
          return { canvasId: canvas.id, order: reordered.map((layer) => layer.id) }
        }),
      },
      hostOptions,
    ),
    host.registerPackHandlers(
      'studio.board.sampling',
      {
        'studio.sampling.set': typed<'studio.sampling.set'>((args) => {
          if (Object.values(args).every((value) => value === undefined)) throw new CapabilityFailure('没有可更新的字段')
          return api.setSampler(args)
        }),
        'studio.sampling.set_model': typed<'studio.sampling.set_model'>(({ canvasId, modelBundleId }) => {
          const { project, catalog } = getDeps()
          const canvas = editable(canvasId)
          ensureNotRunning(canvas)
          const bundle = catalog?.bundles.find((item) => item.id === modelBundleId)
          if (catalog && !bundle) throw new CapabilityFailure(`模型库里没有这个模型：${modelBundleId}`)
          const fromBundle = canvas.modelBundleId ? catalog?.bundles.find((item) => item.id === canvas.modelBundleId) : undefined
          const sampled = bundle ? samplingForBundle(canvas, fromBundle, bundle) : null
          const next: ProjectCanvas = {
            ...canvas,
            modelBundleId,
            ...(sampled ? { steps: sampled.steps, cfg: sampled.cfg } : {}),
          }
          project.updateCanvas(canvas.id, () => next)
          return { canvasId: canvas.id, modelBundleId, steps: next.steps, cfg: next.cfg }
        }),
        'studio.sampling.set_loras': typed<'studio.sampling.set_loras'>(({ canvasId, adapters }) => {
          const target = findCanvas(canvasId)
          if (target.kind !== 'layout' && target.kind !== 'style') {
            throw new CapabilityFailure('只有画面或风格可以配置 LoRA')
          }
          const normalized = normalizeCanvasAdapters(adapters)
          getDeps().project.updateCanvas(target.id, (item) => ({ ...item, adapters: normalized }))
          return { canvasId: target.id, adapters: normalized }
        }),
        'studio.sampling.set_advanced': typed<'studio.sampling.set_advanced'>(
          ({ canvasId, sampler, scheduler, shift, stepCache, cfgTruncation, hires }) => {
            const canvas = editable(canvasId)
            ensureNotRunning(canvas)
            if (canvas.upscale && hires?.enabled) throw new CapabilityFailure('放大节点不支持再叠加高清修复')
            let next = canvas
            const patch: Partial<NonNullable<ProjectCanvas['sampling']>> = {}
            if (sampler !== undefined) patch.sampler = sampler || undefined
            if (scheduler !== undefined) patch.scheduler = scheduler || undefined
            if (shift !== undefined) patch.shift = shift ?? undefined
            if (stepCache !== undefined) patch.stepCache = stepCache || undefined
            if (cfgTruncation !== undefined) patch.cfgTruncation = cfgTruncation ?? undefined
            if (Object.keys(patch).length > 0) next = withSampling(next, patch)
            if (hires !== undefined) {
              if (!hires.enabled) {
                next = withSampling(next, { hires: undefined })
              } else {
                if (hires.scale !== undefined) {
                  next = withHiresScale(next, hires.scale)
                } else if (hires.width !== undefined || hires.height !== undefined) {
                  const currentHires = next.sampling?.hires
                  next = withSampling(next, {
                    hires: {
                      ...currentHires,
                      width: clampHiresDimension(hires.width ?? currentHires?.width ?? next.width, next.width),
                      height: clampHiresDimension(hires.height ?? currentHires?.height ?? next.height, next.height),
                    },
                  })
                } else if (!next.sampling?.hires) {
                  next = withHiresScale(next, 1.5)
                }
                if (hires.steps !== undefined || hires.strength !== undefined) {
                  next = withHiresPatch(next, {
                    ...(hires.steps !== undefined ? { steps: hires.steps } : {}),
                    ...(hires.strength !== undefined ? { strength: hires.strength } : {}),
                  })
                }
              }
            }
            getDeps().project.updateCanvas(canvas.id, () => next)
            return { canvasId: canvas.id, sampling: next.sampling ?? null }
          },
        ),
      },
      hostOptions,
    ),
    host.registerPackHandlers(
      'studio.board.wires',
      {
        'studio.wires.connect': typed<'studio.wires.connect'>(({ sourceCanvasId, targetCanvasId, role, kind, output }) => {
          const { project } = getDeps()
          const canvases = project.canvasesRef.current
          const source = findCanvas(sourceCanvasId)
          const target = editable(targetCanvasId)
          if (role === 'style') {
            if (source.kind !== 'style') throw new CapabilityFailure('风格端口只能连接风格卡片')
            if (target.upscale) throw new CapabilityFailure('放大节点不能连接风格')
          } else {
            if (source.kind === 'style') throw new CapabilityFailure('风格卡片只能连接到风格端口')
            if (!givesPicture(source, canvases)) throw new CapabilityFailure('源卡片还没有可用的图片')
            if (role === 'control' && !kind) throw new CapabilityFailure('控制图连线需要指定 kind（如 depth / canny / pose）')
            if (target.upscale && role !== 'init') throw new CapabilityFailure('放大节点只能连接原图（init）')
          }
          const check = canConnect(canvases, source.id, target)
          if (!check.ok) throw new CapabilityFailure(check.reason ?? '不能这样连线')
          const rawLink = { canvasId: source.id, ...(output !== undefined ? { output } : {}) }
          const resolvedLink = role === 'style' ? { canvasId: source.id } : pictureLink(canvases, rawLink)
          const pinned = role === 'style' ? [...canvases] : pinRun(canvases, resolvedLink.canvasId)
          let updatedTarget = setLink(target, role, resolvedLink, kind)
          if (updatedTarget.upscale && role === 'init') updatedTarget = withUpscaleSize(updatedTarget, pinned)
          project.setCanvases(pinned.map((item) => (item.id === target.id ? updatedTarget : item)))
          return { targetCanvasId: target.id, sourceCanvasId: resolvedLink.canvasId, role, ...(kind ? { kind } : {}) }
        }),
        'studio.wires.disconnect': typed<'studio.wires.disconnect'>(({ targetCanvasId, role, kind, index }) => {
          const { project } = getDeps()
          const before = project.canvasesRef.current
          const target = editable(targetCanvasId)
          const which = role === 'control' ? (kind ?? index) : index
          if ((role === 'reference' || role === 'style') && which === undefined) {
            throw new CapabilityFailure(`断开 ${role} 连线需要提供 0-based index`)
          }
          if (role === 'control' && which === undefined) {
            throw new CapabilityFailure('断开控制图连线需要提供 kind 或 index')
          }
          const updatedTarget = removeLink(target, role, which)
          const after = before.map((item) => (item.id === target.id ? updatedTarget : item))
          project.setCanvases(keepCardsShown(before, after))
          return { targetCanvasId: target.id, role, disconnected: updatedTarget !== target }
        }),
        'studio.wires.configure_init': typed<'studio.wires.configure_init'>(({ canvasId, strength, resize }) => {
          const canvas = editable(canvasId)
          if (!canvas.inputs?.init) throw new CapabilityFailure('这张画面还没有连接起始图')
          const patch: { strength?: number; resize?: 'crop' | 'fit' | 'stretch' | undefined } = {}
          if (strength !== undefined) patch.strength = strength
          if (resize !== undefined) patch.resize = resize ?? undefined
          const next = patchInit(canvas, patch)
          getDeps().project.updateCanvas(canvas.id, () => next)
          return { canvasId: canvas.id, init: next.inputs?.init ?? null }
        }),
        'studio.wires.configure_control': typed<'studio.wires.configure_control'>(({ canvasId, adapterId, loraStrength, image }) => {
          const canvas = editable(canvasId)
          let next = canvas
          if (adapterId !== undefined) next = setControlAdapter(next, adapterId)
          if (loraStrength !== undefined) {
            if (!next.inputs?.control) throw new CapabilityFailure('先选择一个控制适配器再调整强度')
            next = patchControl(next, { loraStrength: loraStrength ?? undefined })
          }
          if (image) {
            if (!next.inputs?.control) throw new CapabilityFailure('这张画面还没有连接控制图')
            const { kind, ...patch } = image
            next = patchControlImage(next, kind, patch)
          }
          getDeps().project.updateCanvas(canvas.id, () => next)
          return { canvasId: canvas.id, control: next.inputs?.control ?? null }
        }),
        'studio.wires.configure_references': typed<'studio.wires.configure_references'>(({ canvasId, maxEdge }) => {
          const canvas = editable(canvasId)
          if (!canvas.inputs?.references) throw new CapabilityFailure('这张画面还没有连接参考图')
          const next = patchReferences(canvas, { maxEdge: maxEdge ?? undefined })
          getDeps().project.updateCanvas(canvas.id, () => next)
          return { canvasId: canvas.id, references: next.inputs?.references ?? null }
        }),
        'studio.wires.apply_recipe': typed<'studio.wires.apply_recipe'>(({ recipe, sourceCanvasId, select = true }) => {
          const { project } = getDeps()
          const canvases = project.canvasesRef.current
          const base = current() ? settingsFrom(current()) : defaultSettings()
          if (recipe === 'series') {
            const built = seriesFromStyle(canvases, base)
            project.setCanvases(built.canvases)
            if (select) project.select(built.style.id)
            return { recipe, styleId: built.style.id, layoutIds: built.layouts.map((item) => item.id) }
          }
          if (!sourceCanvasId) throw new CapabilityFailure(`配方 ${recipe} 需要提供 sourceCanvasId`)
          const source = findCanvas(sourceCanvasId)
          if (!givesPicture(source, canvases)) throw new CapabilityFailure('源卡片还没有可用的图片')
          if (recipe === 'upscale') {
            const built = upscaleFromPicture(canvases, source.id, { fallback: base })
            if (!built) throw new CapabilityFailure('这张图片无法套用放大配方')
            project.setCanvases(built.canvases)
            if (select) project.select(built.created.id)
            return { recipe, createdId: built.created.id }
          }
          const built = canvasFromPicture(canvases, source.id, {
            role: recipe === 'edit' ? 'init' : 'reference',
            fallback: base,
          })
          if (!built) throw new CapabilityFailure('这张图片无法套用该配方')
          project.setCanvases(built.canvases)
          if (select) project.select(built.created.id)
          return { recipe, createdId: built.created.id }
        }),
      },
      hostOptions,
    ),
    host.registerPackHandlers(
      'studio.board.runs',
      {
        'studio.runs.generate': typed<'studio.runs.generate'>(async ({ prompt }) => (await api.generate(prompt)) ?? { queued: true }),
        'studio.runs.cancel': typed<'studio.runs.cancel'>(async ({ canvasId, jobId }) => {
          const deps = getDeps()
          const targetJobId =
            jobId ??
            (() => {
              const canvas = canvasId ? findCanvas(canvasId) : current()
              if (!canvas) throw new CapabilityFailure('先选中一个画面或指定 jobId')
              if (canvas.jobId && canvas.jobState && ACTIVE_JOB_STATES.has(canvas.jobState)) return canvas.jobId
              const activeChild = deps.project.canvasesRef.current.find(
                (item) => item.sourceCanvasId === canvas.id && item.jobId && item.jobState && ACTIVE_JOB_STATES.has(item.jobState),
              )
              return activeChild?.jobId
            })()
          if (!targetJobId) throw new CapabilityFailure('当前没有正在运行的生成任务')
          await deps.cancelJob(targetJobId)
          return { canceled: true, jobId: targetJobId }
        }),
        'studio.runs.pin': typed<'studio.runs.pin'>(({ runId }) => {
          const { project } = getDeps()
          const target = findCanvas(runId)
          if (target.kind !== 'result') throw new CapabilityFailure('只有生成结果可以固定到画板')
          project.setCanvases(pinRun(project.canvasesRef.current, runId))
          return { pinned: runId }
        }),
        'studio.runs.unpin': typed<'studio.runs.unpin'>(({ runId }) => {
          const { project } = getDeps()
          const canvases = project.canvasesRef.current
          const target = findCanvas(runId)
          if (!canUnpin(target, canvases)) throw new CapabilityFailure('这张结果卡片不能收回（未固定，或源画面已不存在）')
          project.setCanvases(unpinRun(canvases, runId))
          return { unpinned: runId }
        }),
        'studio.runs.apply_settings': typed<'studio.runs.apply_settings'>(({ layoutCanvasId, runId }) => {
          const { project } = getDeps()
          const run = findCanvas(runId)
          const layout = layoutCanvasId ? editable(layoutCanvasId) : run.sourceCanvasId ? editable(run.sourceCanvasId) : editable()
          if (run.id === layout.id) throw new CapabilityFailure('不能把画面的设置套用到自己身上')
          const next = withRunSettings(layout, run)
          project.updateCanvas(layout.id, () => next)
          return { layoutCanvasId: layout.id, fromRunId: run.id }
        }),
        'studio.runs.drop': typed<'studio.runs.drop'>(({ runId }) => {
          const { project } = getDeps()
          const canvases = project.canvasesRef.current
          findCanvas(runId)
          if (!canDropRun(canvases, runId)) throw new CapabilityFailure('这张运行已被固定或正在被其他画面使用，不能从胶片条删除')
          project.setCanvases(dropRun(canvases, runId))
          return { dropped: runId }
        }),
      },
      hostOptions,
    ),
    host.registerPackHandlers(
      'studio.projects',
      {
        'studio.projects.open': typedApp<'studio.projects.open'>(async ({ id }) => {
          const { project } = getDeps()
          if (!project.openProject) throw new CapabilityFailure('当前环境不支持切换项目')
          await project.openProject(id)
          return { opened: id }
        }),
        'studio.projects.create': typedApp<'studio.projects.create'>(async ({ name }) => {
          const { project } = getDeps()
          if (!project.newProject) throw new CapabilityFailure('当前环境不支持新建项目')
          await project.newProject()
          if (name && project.rename) project.rename(name)
          return { created: true, name: name ?? project.projectName }
        }),
        'studio.projects.rename': typedApp<'studio.projects.rename'>(({ name }) => {
          const { project } = getDeps()
          if (!project.rename) throw new CapabilityFailure('当前环境不支持重命名项目')
          project.rename(name)
          return { renamed: name }
        }),
        'studio.projects.save': typedApp<'studio.projects.save'>(async () => {
          const { project } = getDeps()
          if (!project.saveNow) throw new CapabilityFailure('当前环境不支持立即保存')
          const saved = await project.saveNow()
          return { saved: Boolean(saved), id: saved?.id ?? project.projectId, updatedAt: saved?.updatedAt ?? null }
        }),
        'studio.projects.import_image': typedApp<'studio.projects.import_image'>(async ({ path, select = true }) => {
          const deps = getDeps()
          const { project } = deps
          let projectId = project.projectId
          if (!projectId && project.saveNow) {
            const saved = await project.saveNow()
            projectId = saved?.id ?? null
          }
          if (!projectId) throw new CapabilityFailure('项目还没保存好，图片暂时放不进来')
          const importer =
            deps.importImageFile ??
            ((pid: string, sourcePath: string) =>
              call<{ path: string; width: number; height: number }>(Ipc.studioImportImage, { projectId: pid, path: sourcePath }))
          const imported = await importer(projectId, path)
          const created = createImageCanvas(project.canvasesRef.current, imported)
          project.setCanvases([...project.canvasesRef.current, created])
          if (select) project.select(created.id)
          return { id: created.id, title: created.title, path: imported.path, width: imported.width, height: imported.height }
        }),
      },
      hostOptions,
    ),
  ]

  return {
    api,
    dispose: () => {
      for (const dispose of disposers) dispose()
    },
  }
}

type StudioActionArgsMap = {
  [K in import('@shared/capabilities').StudioActionId]: StudioActionArgs<K>
}

type AppActionArgsMap = {
  [K in import('@shared/capabilities').AppActionId]: AppActionArgs<K>
}

function typedApp<Id extends keyof AppActionArgsMap>(fn: (args: AppActionArgs<Id>) => unknown | Promise<unknown>): CapabilityHandler {
  return (args) => fn(args as AppActionArgs<Id>)
}
