import { describe, expect, it } from 'vitest'
import type { RemoteWorkerModelInventory } from '@shared/remoteWorker'
import type { ModelBundle, ModelEntry } from '@shared/types'
import { bundleBlocker } from '../../../src/renderer/src/pages/models/logic'
import { applyLoraAutoTriggers } from '../../../src/renderer/src/pages/studio/prompt'
import { missingWorkerAdapters, resolveWorkerBundle, workerAdapterEntries } from '../../../src/renderer/src/pages/studio/remoteWorkerLoras'

const HOST = { id: 'ssh-gpu-1', name: 'GPU Worker', workerProviderId: 'worker-gpu-1' }

const WORKER_INVENTORY: RemoteWorkerModelInventory = {
  root: '/srv/worker/models',
  defaultModelId: 'moss-sft',
  models: [
    {
      id: 'moss-sft',
      name: 'MOSS-Image SFT',
      variant: ['BF16'],
      tier: 'reference',
      profile: 'standard',
      catalogBundleId: 'moss-sft',
      sizeBytes: 27_000_000_000,
    },
    {
      id: 'moss-sft-int8',
      name: 'MOSS-Image SFT INT8',
      variant: ['INT8'],
      tier: 'high',
      profile: 'standard',
      catalogBundleId: 'moss-sft-int8',
      defaults: { steps: 16, cfg: 3 },
      sizeBytes: 9_600_000_000,
    },
  ],
  components: [],
}

describe('Worker real model resolution and strength=0 LoRAs', () => {
  it('ignores strength=0 LoRAs in missingWorkerAdapters', () => {
    const entries = workerAdapterEntries([
      { id: 'registered.safetensors', name: 'registered.safetensors', sizeBytes: 10, registered: true },
    ])
    const missing = missingWorkerAdapters(
      [
        { id: 'registered.safetensors', strength: 0.9 },
        { id: 'unregistered_zero.safetensors', strength: 0 },
        { id: 'unregistered_active.safetensors', strength: 0.5 },
      ],
      entries,
    )
    expect(missing.map((m) => m.id)).toEqual(['unregistered_active.safetensors'])
  })

  it('skips auto-inserting trigger words for strength=0 LoRAs', () => {
    const prompt = applyLoraAutoTriggers(
      'a portrait',
      [
        { id: 'disabled.safetensors', strength: 0 },
        { id: 'active.safetensors', strength: 0.8 },
      ],
      {
        'disabled.safetensors': { triggers: ['@disabled_style'], autoInsert: 'prefix' },
        'active.safetensors': { triggers: ['@active_style'], autoInsert: 'prefix' },
      },
    )
    expect(prompt).toBe('@active_style, a portrait')
  })

  it('resolves real models from worker inventory and falls back cleanly for legacy daemons', () => {
    const legacyPlaceholder = resolveWorkerBundle(HOST, WORKER_INVENTORY, 'remote-worker:worker-gpu-1', null, null)
    expect(legacyPlaceholder.bundle?.id).toBe('moss-sft')

    const explicit = resolveWorkerBundle(HOST, WORKER_INVENTORY, 'moss-sft-int8', null, null)
    expect(explicit.bundle?.id).toBe('moss-sft-int8')
    expect(explicit.bundle?.tier).toBe('high')
    expect(explicit.bundle?.defaults).toEqual({ steps: 16, cfg: 3 })

    const unsupported = resolveWorkerBundle(HOST, { models: [], components: [], unsupported: true }, undefined, null, null)
    expect(unsupported.bundle?.id).toBe('remote-worker:worker-gpu-1')
    expect(unsupported.installed).toBe(true)
  })

  it('allows single-file catalog bundles on worker-daemon hosts while still blocking them on plain SSH hosts', () => {
    const int8Bundle: ModelBundle = {
      id: 'moss-sft-int8',
      name: 'MOSS-Image SFT INT8',
      description: 'INT8',
      tier: 'high',
      certified: true,
      components: { dit: 'moss-sft-comfy-int8_convrot', textEncoder: 'qwen35-comfy-int8_convrot', vae: 'flux2-vae-comfy-small' },
      support: 'moss-runtime-config',
    }
    const models: ModelEntry[] = [
      {
        id: 'moss-sft-comfy-int8_convrot',
        name: 'SFT INT8',
        provider: 'hf',
        repo: 'OpenMOSS-Team/MOSS-Image-SFT',
        revision: 'main',
        role: 'dit',
        precision: 'int8',
        format: 'comfyui',
        sizeBytes: 9_600_000_000,
        license: 'apache-2.0',
        tags: [],
        installed: false,
        installedBytes: 0,
      },
    ]
    expect(bundleBlocker(int8Bundle, models, { remote: true, workerDaemon: true, gpus: [] })).toBeNull()
    expect(bundleBlocker(int8Bundle, models, { remote: true, workerDaemon: false, gpus: [] })).toContain('只能在这台电脑上使用')
  })
})
