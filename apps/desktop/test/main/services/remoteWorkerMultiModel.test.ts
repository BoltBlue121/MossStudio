import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import type { RemoteWorkerProfile } from '@shared/remoteWorker'
import {
  controlRemoteWorkerDownload,
  deleteRemoteWorkerModels,
  listRemoteWorkerDownloads,
  listRemoteWorkerModels,
  resolveRemoteWorkerAdapters,
  runRemoteWorkerJob,
  setMemoryWorkerToken,
  startRemoteWorkerDownload,
} from '../../../src/main/services/remoteWorker'

const PROFILE: RemoteWorkerProfile = {
  id: 'worker-gpu-1',
  kind: 'worker-daemon',
  label: 'GPU Worker',
  hostId: 'ssh-gpu-1',
  baseUrl: 'http://127.0.0.1:53877',
  workflow: 'standard',
}

function fakePng(width: number, height: number): Uint8Array {
  const buf = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12)
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

describe('remoteWorker multi-model, downloads, legacy 404 fallback, and strength=0 LoRA bypass', () => {
  afterEach(() => {
    setMemoryWorkerToken(PROFILE.id, null)
  })

  it('skips strength=0 LoRAs without calling /v1/loras or failing on unregistered ones', async () => {
    setMemoryWorkerToken(PROFILE.id, 'secret-token-1234567890')
    const fetchSpy = vi.fn<typeof fetch>()
    const resolved = await resolveRemoteWorkerAdapters(
      PROFILE,
      [
        { id: 'unregistered_a.safetensors', strength: 0 },
        { id: 'unregistered_b.safetensors', strength: 0 },
      ],
      fetchSpy,
    )
    expect(resolved).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('resolves only active (>0) LoRAs while ignoring strength=0 LoRAs', async () => {
    setMemoryWorkerToken(PROFILE.id, 'secret-token-1234567890')
    const fetchSpy = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ items: [{ id: 'registered.safetensors', bytes: 1024 }] }), { status: 200 }),
    )
    const resolved = await resolveRemoteWorkerAdapters(
      PROFILE,
      [
        { id: 'registered.safetensors', strength: 0.8 },
        { id: 'disabled_unregistered.safetensors', strength: 0 },
      ],
      fetchSpy,
    )
    expect(resolved).toEqual([{ path: 'registered.safetensors', strength: 0.8 }])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('lists and rescans real models from /v1/models and /v1/models/rescan', async () => {
    setMemoryWorkerToken(PROFILE.id, 'secret-token-1234567890')
    const calls: Array<{ url: string; method?: string }> = []
    const fetchSpy = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: String(url), method: init?.method })
      return new Response(
        JSON.stringify({
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
              sizeBytes: 9_600_000_000,
              defaults: { steps: 16, cfg: 3 },
            },
          ],
          components: [{ id: 'moss-sft-comfy-int8_convrot', installed: true, path: '/srv/worker/models/sft.safetensors' }],
        }),
        { status: 200 },
      )
    })

    const inv = await listRemoteWorkerModels(PROFILE, false, fetchSpy)
    expect(inv.unsupported).toBeUndefined()
    expect(inv.defaultModelId).toBe('moss-sft')
    expect(inv.models.map((m) => m.id)).toEqual(['moss-sft', 'moss-sft-int8'])
    expect(inv.models[1]?.defaults).toEqual({ steps: 16, cfg: 3 })
    expect(inv.components).toHaveLength(1)
    expect(calls[0]).toEqual({ url: 'http://127.0.0.1:53877/v1/models', method: 'GET' })

    await listRemoteWorkerModels(PROFILE, true, fetchSpy)
    expect(calls[1]).toEqual({ url: 'http://127.0.0.1:53877/v1/models/rescan', method: 'POST' })
  })

  it('falls back gracefully on HTTP 404 for legacy daemons without /v1/models or /v1/downloads', async () => {
    setMemoryWorkerToken(PROFILE.id, 'secret-token-1234567890')
    const fetch404 = vi.fn<typeof fetch>(async () => new Response('not found', { status: 404 }))

    const inv = await listRemoteWorkerModels(PROFILE, false, fetch404)
    expect(inv).toEqual({ models: [], components: [], defaultModelId: null, unsupported: true })

    const downloads = await listRemoteWorkerDownloads(PROFILE, fetch404)
    expect(downloads).toEqual([])

    await expect(
      startRemoteWorkerDownload(
        PROFILE,
        { targetId: 'moss-sft-comfy-int4_convrot', label: 'INT4', kind: 'model', repo: 'OpenMOSS-Team/MOSS-Image-SFT' },
        fetch404,
      ),
    ).rejects.toMatchObject({ code: 'E_WORKER_UNSUPPORTED' })

    await expect(deleteRemoteWorkerModels(PROFILE, ['moss-sft-comfy-int4_convrot'], fetch404)).rejects.toMatchObject({
      code: 'E_WORKER_UNSUPPORTED',
    })
  })

  it('starts, lists, controls downloads and deletes models via daemon API', async () => {
    setMemoryWorkerToken(PROFILE.id, 'secret-token-1234567890')
    const sampleTask = {
      id: 'wdown-abc123',
      kind: 'model',
      targetId: 'moss-sft-comfy-int4_convrot',
      label: 'MOSS-Image SFT INT4',
      state: 'running',
      bytes: 100,
      totalBytes: 1000,
      speedBps: 50,
      filesDone: 0,
      filesTotal: 1,
      updatedAt: '2026-11-22T00:00:00Z',
    }
    const fetchSpy = vi.fn<typeof fetch>(async (url, init) => {
      const href = String(url)
      if (href.endsWith('/v1/downloads') && init?.method === 'POST') {
        return new Response(JSON.stringify(sampleTask), { status: 202 })
      }
      if (href.endsWith('/v1/downloads') && init?.method === 'GET') {
        return new Response(JSON.stringify({ items: [sampleTask] }), { status: 200 })
      }
      if (href.endsWith('/v1/downloads/wdown-abc123/pause') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ...sampleTask, state: 'paused' }), { status: 200 })
      }
      if (href.endsWith('/v1/models/delete') && init?.method === 'POST') {
        return new Response(JSON.stringify({ removed: ['/srv/worker/models/a.safetensors'], kept: [] }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })

    const created = await startRemoteWorkerDownload(
      PROFILE,
      { targetId: 'moss-sft-comfy-int4_convrot', label: 'MOSS-Image SFT INT4', kind: 'model', repo: 'OpenMOSS-Team/MOSS-Image-SFT' },
      fetchSpy,
    )
    expect(created.hostId).toBe('ssh-gpu-1')
    expect(created.id).toBe('wdown-abc123')

    const listed = await listRemoteWorkerDownloads(PROFILE, fetchSpy)
    expect(listed).toHaveLength(1)

    const afterPause = await controlRemoteWorkerDownload(PROFILE, 'wdown-abc123', 'pause', fetchSpy)
    expect(afterPause).toHaveLength(1)

    const deleted = await deleteRemoteWorkerModels(PROFILE, ['moss-sft-comfy-int4_convrot'], fetchSpy)
    expect(deleted.removed).toHaveLength(1)
  })

  it('passes model id and omits forced profile when running a specific model on the worker', async () => {
    setMemoryWorkerToken(PROFILE.id, 'secret-token-1234567890')
    let submittedBody: Record<string, unknown> | undefined
    const output = join(tmpdir(), `worker-model-test-${Date.now()}.png`)
    const fetchSpy = vi.fn<typeof fetch>(async (url, init) => {
      const href = String(url)
      if (href.endsWith('/v1/jobs') && init?.method === 'POST') {
        submittedBody = JSON.parse(String(init.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ id: 'remote-job-1', status: 'queued' }), { status: 202 })
      }
      if (href.endsWith('/v1/jobs/remote-job-1')) {
        return new Response(JSON.stringify({ id: 'remote-job-1', status: 'succeeded' }), { status: 200 })
      }
      if (href.endsWith('/v1/jobs/remote-job-1/image')) {
        return new Response(Buffer.from(fakePng(512, 512)), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })

    try {
      const code = await runRemoteWorkerJob({
        profile: PROFILE,
        jobId: 'local-job-1',
        model: 'moss-sft-int8',
        params: {
          prompt: 'hello',
          negativePrompt: '',
          width: 512,
          height: 512,
          steps: 20,
          cfg: 3.5,
          seed: 42,
          profile: 'base',
          adapters: [{ path: 'disabled.safetensors', strength: 0 }],
        },
        output,
        pollMs: 1,
        fetchImpl: fetchSpy,
        onEvent: () => undefined,
      })
      expect(code).toBe(0)
      expect(submittedBody?.model).toBe('moss-sft-int8')
      expect(submittedBody?.profile).toBeUndefined()
      expect(submittedBody?.loras).toEqual([])
    } finally {
      await rm(output, { force: true })
    }
  })
})
