import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startRequestedEngineJob } from '@main/services/engineJobStart'
import { updateSettings } from '@main/services/settings'
import { getJob, settleJobWrites } from '@main/services/supervisor'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { pngBytes } from './training/pictures'
import {
  disconnectWorkerHost,
  probeWorkerHost,
  workerDaemonSupports,
  workerEngineFeatures,
  workerHostDevices,
  workerHostProfile,
  type WorkerHostConfig,
} from '@main/services/workerHostManager'

const host: WorkerHostConfig = {
  id: 'windows-worker',
  name: 'Worker',
  kind: 'ssh',
  host: 'worker.example',
  user: 'runner',
  trainerRoot: '',
  status: 'unchecked',
  remoteBackend: 'worker-daemon',
  workerDiscoveryPath: 'C:\\Worker\\discovery.json',
}
function probe(response: unknown) {
  return probeWorkerHost(host, true, {
    readRemoteFile: async (_, path) =>
      path === host.workerDiscoveryPath
        ? JSON.stringify({ url: 'http://127.0.0.1:42000', token_file: 'C:\\Worker\\daemon-token' })
        : 'test-token-only-in-memory',
    allocateLocalPort: async () => 41000,
    startTunnel: async () => ({ isAlive: () => true, stop: async () => {} }),
    fetchImpl: async () => Response.json(response),
  })
}
afterEach(() => disconnectWorkerHost(host.id))

const gpu = 'NVIDIA RTX 5000 Ada Generation Laptop GPU'
const daemon = {
  version: 1,
  daemon: 'moss-worker-daemon',
  engine: {
    protocol_version: 2,
    server: 'moss-server',
    version: '2.3.0',
    capabilities: { lora: true, samplers: true, image_input: true, hires: true, preview: true },
    values: { sampler: ['euler', 'dpmpp_2m'], scheduler: ['moss', 'karras'], step_cache: ['off', 'fbcache'], resize: ['fit'] },
    probe: { devices: [{ index: 0, name: gpu, total_memory_bytes: 17170956288 }] },
  },
}

describe('Worker capability negotiation', () => {
  it('reads the Windows daemon 2.3.0 engine hello from the capabilities response', async () => {
    expect(await probe(daemon)).toMatchObject({ online: true, gpu, version: '2.3.0' })
    expect(workerHostDevices(host)).toMatchObject([{ name: gpu, memoryBytes: 17170956288, source: 'remote' }])
    const features = await workerEngineFeatures(host)
    expect(features).toMatchObject({ lora: true, samplers: true })
    expect(features?.values).toEqual({ sampler: ['euler', 'dpmpp_2m'], scheduler: ['moss', 'karras'] })
  })

  it('updates an open session when a fresh capabilities response changes or removes the remote profile', async () => {
    await probe({ ...daemon, profile: 'previous-wf' })
    for (const profile of ['next-wf', undefined]) {
      const refreshed = await probeWorkerHost(host, false, { fetchImpl: async () => Response.json({ ...daemon, profile }) })
      expect(refreshed.online).toBe(true)
      expect(workerHostProfile(host).workflow).toBe(profile)
    }
  })

  it('uses the daemon for models and downloads only when its capabilities name them', async () => {
    await probe(daemon)
    expect([workerDaemonSupports(host.id, 'models'), workerDaemonSupports(host.id, 'downloads')]).toEqual([false, false])
    await probe({ ...daemon, features: { lora: true, models: true } })
    expect([workerDaemonSupports(host.id, 'models'), workerDaemonSupports(host.id, 'downloads')]).toEqual([true, false])
  })

  it('never enables picture inputs, previews or hires even when the engine advertises them', async () => {
    await probe({ engine: { capabilities: { ...daemon.engine.capabilities, control: true, references: true } } })
    expect(await workerEngineFeatures(host)).toMatchObject({
      preview: false,
      imageInput: false,
      control: false,
      references: false,
      hires: false,
    })
  })

  it('prefers flat fields without merging nested grants or enum values', async () => {
    expect(
      await probe({ features: { samplers: true }, values: {}, engine: { ...daemon.engine, devices: [{ name: 'Flat GPU' }] } }),
    ).toMatchObject({ gpu: 'Flat GPU' })
    const features = await workerEngineFeatures(host)
    expect(features).toMatchObject({ lora: false, samplers: true })
    expect(features?.values).toEqual({})
  })

  it('falls back for empty devices and non-object feature and enum fields', async () => {
    expect(await probe({ features: [], values: 'invalid', engine: { ...daemon.engine, devices: [] } })).toMatchObject({ gpu })
    expect(await workerEngineFeatures(host)).toMatchObject({ lora: true, samplers: true, values: { scheduler: ['moss', 'karras'] } })
  })

  it.each([
    {},
    { probe: null, capabilities: 1, values: 'invalid' },
    { probe: 'invalid', capabilities: [], values: null },
    { probe: { devices: {} }, capabilities: { lora: 'true', samplers: 1 }, values: { sampler: ['euler'] } },
  ])('keeps malformed or missing engine fields inert: %j', async (engine) => {
    expect(await probe({ engine })).toMatchObject({ online: true, gpu: '' })
    expect(workerHostDevices(host)).toEqual([])
    expect(await workerEngineFeatures(host)).toMatchObject({ lora: false, samplers: false, values: {} })
  })

  it('bounds nested device, version and enum data just like flat data', async () => {
    const long = 'x'.repeat(300)
    const sampler = ['x'.repeat(65), ...Array.from({ length: 65 }, (_, i) => String(i))]
    const extra = Object.fromEntries(Array.from('abcdefghijklmnop', (key) => [key, ['ok']]))
    const info = await probe({
      engine: {
        version: long,
        probe: { devices: Array.from({ length: 65 }, () => ({ name: long })) },
        capabilities: { samplers: true },
        values: { sampler, ...extra, scheduler: ['moss'] },
      },
    })
    expect(info.version).toBe('x'.repeat(128))
    const devices = workerHostDevices(host)
    expect(devices).toHaveLength(64)
    expect(devices[0].name).toBe('x'.repeat(256))
    const values = (await workerEngineFeatures(host))?.values
    // The enum-key limit is applied before projection, so a scheduler past that boundary is not granted.
    expect(Object.keys(values ?? {})).toEqual(['sampler'])
    expect(values).not.toHaveProperty('scheduler')
    expect(values?.sampler).toEqual(Array.from({ length: 64 }, (_, i) => String(i)))
  })
})

describe('Worker job submission', () => {
  const dataRoot = useTempDataRoot()
  afterEach(settleJobWrites)

  it('forwards the sampler from a nested hello to the daemon job request', async () => {
    updateSettings({ remoteHostsEnabled: true, workerHostsEnabled: true })
    writeFileSync(join(dataRoot(), 'hosts.json'), JSON.stringify([host]))
    await probe({ engine: { capabilities: { samplers: true }, values: { sampler: ['euler'] } } })
    const submissions: unknown[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === 'http://127.0.0.1:41000/v1/jobs' && init?.method === 'POST') {
        submissions.push(JSON.parse(String(init.body)))
        return Response.json({ id: 'remote-job', status: 'queued' })
      }
      if (url === 'http://127.0.0.1:41000/v1/jobs/remote-job') return Response.json({ id: 'remote-job', status: 'succeeded' })
      if (url === 'http://127.0.0.1:41000/v1/jobs/remote-job/image') return new Response(new Uint8Array(pngBytes(64, 64)))
      throw new Error(`Unexpected Worker request: ${url}`)
    })
    const job = await startRequestedEngineJob({
      hostId: host.id,
      prompt: 'a cat',
      width: 64,
      height: 64,
      steps: 2,
      cfg: 3,
      seed: 1,
      sampling: { sampler: 'euler' },
    })
    await vi.waitFor(async () => expect(await getJob(job.id)).toMatchObject({ state: 'succeeded', exitCode: 0 }))
    expect(submissions).toEqual([
      {
        request_id: job.id,
        prompt: 'a cat',
        negative_prompt: '',
        width: 64,
        height: 64,
        steps: 2,
        cfg: 3,
        seed: 1,
        sampler: 'euler',
        loras: [],
      },
    ])
  })
})
