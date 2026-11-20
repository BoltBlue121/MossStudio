import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createStudioCapabilityRegistry, CAPABILITY_PROTOCOL_VERSION } from '@shared/capabilities'
import type { Catalog, EngineReadiness, JobRecord, ProjectCanvas } from '@shared/types'
import { createRendererCapabilityHost } from '@renderer/lib/capabilities'
import { removeCanvasFrom } from '@renderer/pages/studio/canvases'
import { registerStudioCapabilities, type StudioCapabilityDeps } from '@renderer/pages/studio/studioCapabilities'
import { canvas, layer } from './fixtures'

interface Harness {
  canvases: () => ProjectCanvas[]
  selectedId: () => string | null
  run: (name: string, args?: Record<string, unknown>, mode?: 'auto' | 'advanced') => Promise<{ ok: boolean; body: Record<string, unknown> }>
  host: ReturnType<typeof createRendererCapabilityHost>
  cancelJob: ReturnType<typeof vi.fn>
  generate: ReturnType<typeof vi.fn>
}

function makeHarness(
  initial: ProjectCanvas[],
  selectedInitial: string | null = initial[0]?.id ?? null,
  overrides: Partial<Omit<StudioCapabilityDeps, 'project'>> = {},
): Harness {
  let canvases = [...initial]
  let selectedId = selectedInitial
  const canvasesRef = {
    get current() {
      return canvases
    },
  }
  const selectedRef = {
    get current() {
      return selectedId
    },
  }
  const cancelJob = vi.fn(async () => undefined)
  const generate = vi.fn(async () => ({ queued: true, jobId: 'job-1' }))

  const catalog: Catalog = {
    source: 'local',
    bundles: [
      {
        id: 'moss-base',
        name: 'MOSS Base',
        recommended: true,
        components: { dit: 'dit-1', textEncoder: 'te-1', vae: 'vae-1' },
      },
      {
        id: 'moss-dmd8',
        name: 'MOSS Fast',
        defaults: { steps: 8, cfg: 1 },
        components: { dit: 'dit-2', textEncoder: 'te-1', vae: 'vae-1' },
      },
    ],
    models: [
      { id: 'dit-1', name: 'DiT 1', role: 'dit', sizeBytes: 1, installed: true },
      { id: 'dit-2', name: 'DiT 2', role: 'dit', sizeBytes: 1, installed: true },
      { id: 'te-1', name: 'TE', role: 'text_encoder', sizeBytes: 1, installed: true },
      { id: 'vae-1', name: 'VAE', role: 'vae', sizeBytes: 1, installed: true },
    ],
    adapters: [{ id: 'anime-style', name: 'Anime', kind: 'lora', path: '/lora/anime.safetensors', sizeBytes: 1, installed: true }],
  } as unknown as Catalog

  const engineReadiness: EngineReadiness = {
    state: 'ready',
    devices: [],
  } as unknown as EngineReadiness

  const deps: StudioCapabilityDeps = {
    project: {
      projectId: 'proj-1',
      projectName: '测试项目',
      canvasesRef,
      selectedRef,
      setCanvases: (next) => {
        canvases = typeof next === 'function' ? next(canvases) : next
      },
      updateCanvas: (id, patch) => {
        canvases = canvases.map((item) => {
          if (item.id !== id) return item
          return typeof patch === 'function' ? patch(item) : { ...item, ...patch }
        })
      },
      select: (id) => {
        selectedId = id
      },
      removeCanvas: (id) => {
        const result = removeCanvasFrom(canvases, id)
        canvases = result.canvases
        if (selectedId === id) selectedId = canvases[0]?.id ?? null
        return result.removedLinks
      },
    },
    generate,
    cancelJob,
    catalog,
    preferredBundleId: 'moss-base',
    engineReadiness,
    settings: null,
    update: null,
    remoteHost: null,
    boardFeatures: {
      preview: true,
      imageInput: true,
      control: true,
      references: true,
      hires: true,
      samplers: true,
      lora: true,
      values: { sampler: ['euler', 'dpmpp_2m'], scheduler: ['moss', 'karras'] },
    },
    controlAdapters: [
      {
        id: 'ctrl-depth',
        name: 'Depth',
        path: '/ctrl/depth.safetensors',
        controlKinds: ['depth'],
        sizeBytes: 1,
        addedAt: '2026-11-20T00:00:00.000Z',
      },
    ],
    controlAdaptersLoaded: true,
    gpuInventory: null,
    jobs: [],
    ...overrides,
  }

  const registry = createStudioCapabilityRegistry()
  const host = createRendererCapabilityHost(registry)
  registerStudioCapabilities(() => deps, host)

  return {
    canvases: () => canvases,
    selectedId: () => selectedId,
    host,
    cancelJob,
    generate,
    run: async (name, args = {}, mode) => {
      const result = await host.execute({ id: `call-${name}`, name, arguments: JSON.stringify(args) }, { mode })
      return { ok: result.ok, body: JSON.parse(result.content) as Record<string, unknown> }
    },
  }
}

describe('studio capability packs', () => {
  it('allows studio_set_prompt on a selected style card while keeping layout-only guards on regions and generation', async () => {
    const styleCard = canvas({ id: 'style-1', kind: 'style', title: '风格 1', prompt: '' })
    const h = makeHarness([styleCard], 'style-1')

    const promptResult = await h.run('studio_set_prompt', { prompt: 'watercolor washes, warm paper texture' })
    expect(promptResult.ok).toBe(true)
    expect(h.canvases()[0]!.prompt).toBe('watercolor washes, warm paper texture')

    // Layout-only tools must still refuse a style card.
    const regionResult = await h.run('studio_add_layer', { label: 'object', caption: 'lamp' })
    expect(regionResult.ok).toBe(false)
    const generateResult = await h.run('studio_generate', {})
    expect(generateResult.ok).toBe(false)
  })

  it('exposes stable layer ids in studio_read_context and full readiness blockers in studio.board.diagnose', async () => {
    const c1 = canvas({
      id: 'c1',
      prompt: '',
      layers: [layer({ id: 'layer-alpha', caption: 'fox' })],
    })
    const h = makeHarness([c1], 'c1')

    const ctx = await h.run('studio_read_context')
    expect(ctx.ok).toBe(true)
    const selected = ctx.body.selected as { layers: Array<{ id: string; index: number }> }
    expect(selected.layers[0]).toMatchObject({ id: 'layer-alpha', index: 1 })

    const diag = await h.run('studio.board.diagnose', { canvasId: 'c1' })
    expect(diag.ok).toBe(true)
    expect(diag.body.ready).toBe(false)
    expect((diag.body.blockers as Array<{ id: string }>).some((b) => b.id === 'prompt')).toBe(true)

    await h.run('studio_set_prompt', { prompt: 'a red fox in winter forest' })
    const readyDiag = await h.run('studio.board.diagnose', { canvasId: 'c1' })
    expect(readyDiag.ok).toBe(true)
    expect(readyDiag.body.ready).toBe(true)
    expect(readyDiag.body.blockers).toEqual([])
  })

  it('creates, duplicates, creates styles and upscales, tidies, and deletes cards', async () => {
    const pic = canvas({
      id: 'img-1',
      kind: 'image',
      title: '参考图',
      imagePath: '/assets/ref.png',
      imageSize: { width: 512, height: 512 },
      width: 512,
      height: 512,
    })
    const res = canvas({
      id: 'res-1',
      kind: 'result',
      title: '结果 1',
      prompt: 'moonlit lake',
      pinned: true,
      outputs: [{ path: '/out/1.png', width: 1024, height: 1024, seed: 12 }],
    })
    const h = makeHarness([pic, res], 'res-1')

    const created = await h.run('studio.cards.create', { title: '封面', prompt: 'spring garden', width: 864, height: 1152 })
    expect(created.ok).toBe(true)
    expect(h.selectedId()).toBe(created.body.id)

    const dup = await h.run('studio.cards.duplicate', { canvasId: 'res-1', select: false })
    expect(dup.ok).toBe(true)
    const dupCard = h.canvases().find((c) => c.id === dup.body.id)!
    expect(dupCard.kind).toBe('layout')
    expect(dupCard.prompt).toBe('moonlit lake')

    const style = await h.run('studio.cards.create_style', {
      title: '胶片风',
      prompt: '35mm film grain',
      adapters: [{ id: 'anime-style', strength: 0.8 }],
    })
    expect(style.ok).toBe(true)
    expect(h.canvases().find((c) => c.id === style.body.id)?.adapters).toEqual([{ id: 'anime-style', strength: 0.8 }])

    const up = await h.run('studio.cards.create_upscale', { sourceCanvasId: 'img-1', scale: 1.5, strength: 0.35 })
    expect(up.ok).toBe(true)
    expect(up.body.width).toBe(768)
    expect(up.body.height).toBe(768)

    const rescaled = await h.run('studio.cards.set_upscale_scale', { canvasId: String(up.body.id), scale: 2 })
    expect(rescaled.ok).toBe(true)
    expect(rescaled.body.width).toBe(1024)

    const tidied = await h.run('studio.cards.tidy', {})
    expect(tidied.ok).toBe(true)
    expect(Number(tidied.body.moved)).toBeGreaterThanOrEqual(2)

    const del = await h.run('studio.cards.delete', { canvasId: String(style.body.id) })
    expect(del.ok).toBe(true)
    expect(h.canvases().some((c) => c.id === style.body.id)).toBe(false)
  })

  it('updates, reorders and removes regions by stable layerId without stealing selection', async () => {
    const c1 = canvas({ id: 'c1', prompt: 'scene 1' })
    const c2 = canvas({
      id: 'c2',
      prompt: 'scene 2',
      layers: [layer({ id: 'L1', caption: 'first' }), layer({ id: 'L2', caption: 'second' })],
    })
    const h = makeHarness([c1, c2], 'c1')

    const upd = await h.run('studio.regions.update_by_id', {
      canvasId: 'c2',
      layerId: 'L2',
      caption: 'updated second',
      opacity: 0.7,
    })
    expect(upd.ok).toBe(true)
    expect(h.selectedId()).toBe('c1')
    expect(h.canvases().find((c) => c.id === 'c2')!.layers[1]!.caption).toBe('updated second')

    const reordered = await h.run('studio.regions.reorder', { canvasId: 'c2', fromLayerId: 'L2', toLayerId: 'L1' })
    expect(reordered.ok).toBe(true)
    expect(reordered.body.order).toEqual(['L2', 'L1'])

    const removed = await h.run('studio.regions.remove_by_id', { canvasId: 'c2', layerId: 'L1' })
    expect(removed.ok).toBe(true)
    expect(
      h
        .canvases()
        .find((c) => c.id === 'c2')!
        .layers.map((l) => l.id),
    ).toEqual(['L2'])
  })

  it('configures model bundle, LoRAs and advanced sampling including hires fix', async () => {
    const c1 = canvas({ id: 'c1', prompt: 'portrait', steps: 20, cfg: 3 })
    const h = makeHarness([c1], 'c1')

    const switched = await h.run('studio.sampling.set_model', { modelBundleId: 'moss-dmd8' })
    expect(switched.ok).toBe(true)
    expect(switched.body).toMatchObject({ modelBundleId: 'moss-dmd8', steps: 8, cfg: 1 })

    const loras = await h.run('studio.sampling.set_loras', { adapters: [{ id: 'anime-style', strength: 1.25 }] })
    expect(loras.ok).toBe(true)
    expect(h.canvases()[0]!.adapters).toEqual([{ id: 'anime-style', strength: 1.25 }])

    const adv = await h.run('studio.sampling.set_advanced', {
      sampler: 'dpmpp_2m',
      scheduler: 'karras',
      hires: { enabled: true, scale: 1.5, steps: 12, strength: 0.45 },
    })
    expect(adv.ok).toBe(true)
    expect(h.canvases()[0]!.sampling).toMatchObject({
      sampler: 'dpmpp_2m',
      scheduler: 'karras',
      hires: { width: 1536, height: 1536, steps: 12, strength: 0.45 },
    })

    const off = await h.run('studio.sampling.set_advanced', { hires: { enabled: false } })
    expect(off.ok).toBe(true)
    expect(h.canvases()[0]!.sampling?.hires).toBeUndefined()
  })

  it('connects, configures, disconnects wires and applies board recipes', async () => {
    const pic = canvas({
      id: 'pic-1',
      kind: 'image',
      imagePath: '/assets/pic.png',
      imageSize: { width: 1024, height: 1024 },
    })
    const style = canvas({ id: 'sty-1', kind: 'style', title: '风格 1', prompt: 'oil painting' })
    const layout = canvas({ id: 'lay-1', kind: 'layout', prompt: 'cat on chair' })
    const h = makeHarness([pic, style, layout], 'lay-1')

    expect((await h.run('studio.wires.connect', { sourceCanvasId: 'pic-1', targetCanvasId: 'lay-1', role: 'init' })).ok).toBe(true)
    expect((await h.run('studio.wires.configure_init', { canvasId: 'lay-1', strength: 0.45, resize: 'fit' })).ok).toBe(true)
    expect(h.canvases().find((c) => c.id === 'lay-1')!.inputs?.init).toMatchObject({ strength: 0.45, resize: 'fit' })

    expect((await h.run('studio.wires.connect', { sourceCanvasId: 'sty-1', targetCanvasId: 'lay-1', role: 'style' })).ok).toBe(true)
    expect((await h.run('studio.wires.configure_control', { canvasId: 'lay-1', adapterId: 'ctrl-depth', loraStrength: 0.9 })).ok).toBe(true)
    expect(
      (await h.run('studio.wires.connect', { sourceCanvasId: 'pic-1', targetCanvasId: 'lay-1', role: 'control', kind: 'depth' })).ok,
    ).toBe(true)
    expect(
      (
        await h.run('studio.wires.configure_control', {
          canvasId: 'lay-1',
          image: { kind: 'depth', strength: 1.2, start: 0.1, end: 0.8 },
        })
      ).ok,
    ).toBe(true)

    expect((await h.run('studio.wires.connect', { sourceCanvasId: 'pic-1', targetCanvasId: 'lay-1', role: 'reference' })).ok).toBe(true)
    expect((await h.run('studio.wires.configure_references', { canvasId: 'lay-1', maxEdge: 768 })).ok).toBe(true)

    // Self-link is refused.
    expect((await h.run('studio.wires.connect', { sourceCanvasId: 'lay-1', targetCanvasId: 'lay-1', role: 'init' })).ok).toBe(false)

    expect((await h.run('studio.wires.disconnect', { targetCanvasId: 'lay-1', role: 'init' })).ok).toBe(true)
    expect(h.canvases().find((c) => c.id === 'lay-1')!.inputs?.init).toBeUndefined()

    const series = await h.run('studio.wires.apply_recipe', { recipe: 'series' })
    expect(series.ok).toBe(true)
    expect((series.body.layoutIds as string[]).length).toBe(3)
  })

  it('pins, unpins, applies settings from, drops, and cancels runs', async () => {
    const layout = canvas({ id: 'lay-1', prompt: 'old prompt', seed: 1 })
    const runFolded = canvas({
      id: 'run-1',
      kind: 'result',
      sourceCanvasId: 'lay-1',
      prompt: 'great prompt',
      seed: 99,
      outputs: [{ path: '/out/1.png', width: 1024, height: 1024, seed: 99 }],
    })
    const runActive = canvas({
      id: 'run-2',
      kind: 'result',
      sourceCanvasId: 'lay-1',
      jobId: 'job-running',
      jobState: 'running',
    })
    const activeJob = { id: 'job-running', state: 'running' } as JobRecord
    const h = makeHarness([layout, runFolded, runActive], 'lay-1', { jobs: [activeJob] })

    const canceled = await h.run('studio.runs.cancel', { canvasId: 'lay-1' })
    expect(canceled.ok).toBe(true)
    expect(h.cancelJob).toHaveBeenCalledWith('job-running')

    expect((await h.run('studio.runs.pin', { runId: 'run-1' })).ok).toBe(true)
    expect(h.canvases().find((c) => c.id === 'run-1')!.pinned).toBe(true)

    // Pinned run cannot be dropped from the filmstrip.
    expect((await h.run('studio.runs.drop', { runId: 'run-1' })).ok).toBe(false)

    expect((await h.run('studio.runs.apply_settings', { layoutCanvasId: 'lay-1', runId: 'run-1' })).ok).toBe(true)
    expect(h.canvases().find((c) => c.id === 'lay-1')!.prompt).toBe('great prompt')
    expect(h.canvases().find((c) => c.id === 'lay-1')!.seed).toBe(99)

    expect((await h.run('studio.runs.unpin', { runId: 'run-1' })).ok).toBe(true)
    expect(h.canvases().find((c) => c.id === 'run-1')!.pinned).toBeUndefined()

    expect((await h.run('studio.runs.drop', { runId: 'run-1' })).ok).toBe(true)
    expect(h.canvases().some((c) => c.id === 'run-1')).toBe(false)
  })

  it('defers canonical mutating actions in advanced mode and applies them via applyPlan', async () => {
    const h = makeHarness([canvas({ id: 'c1', prompt: 'base' })], 'c1')
    const held = await h.run('studio.cards.create', { title: '方案新画面', prompt: 'planned' }, 'advanced')
    expect(held.ok).toBe(true)
    expect(h.canvases()).toHaveLength(1)
    const proposed = held.body.proposed as { tool: string; args: Record<string, unknown>; label: string }
    expect(proposed.tool).toBe('studio.cards.create')

    const applied = await h.host.applyPlan({
      id: 'plan-1',
      kind: 'plan',
      title: '执行方案',
      createdAt: '2026-11-20T00:00:00.000Z',
      steps: [proposed],
    })
    expect(applied.applied).toBe(1)
    expect(h.canvases()).toHaveLength(2)
  })

  it('runs dynamically registered future capability packs without changing host code', async () => {
    const h = makeHarness([canvas({ id: 'c1' })], 'c1')
    h.host.registry.registerBuiltinPack({
      protocolVersion: CAPABILITY_PROTOCOL_VERSION,
      id: 'library.assets',
      title: '作品素材',
      version: '1.0.0',
      requiresPacks: [],
      actions: [
        {
          id: 'library.assets.count',
          title: '统计作品数',
          description: 'Return the total number of saved outputs in Library.',
          inputSchema: z.strictObject({}),
          target: 'renderer',
          scope: 'application',
          effects: ['read'],
          policyFloor: 'auto',
          requires: [],
          headless: 'supported',
          summarize: () => '统计作品',
        },
      ],
      contexts: [],
      skills: [],
    })
    const dispose = h.host.registerPackHandlers('library.assets', {
      'library.assets.count': () => ({ count: 42 }),
    })

    const res = await h.run('library.assets.count', {})
    expect(res.ok).toBe(true)
    expect(res.body).toEqual({ count: 42 })

    dispose()
    const afterDispose = await h.run('library.assets.count', {})
    expect(afterDispose.ok).toBe(false)
  })
})
