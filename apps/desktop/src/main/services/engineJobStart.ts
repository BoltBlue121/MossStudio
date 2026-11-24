import { CLI_ENGINE_LABEL } from '@shared/cliEngine'
import { isWorkerSamplingKey } from '@shared/remoteWorker'
import { isSharedModelId } from '@shared/sharedModels'
import type { JobRecord, JobSampling } from '@shared/types'
import { codedError } from '../lib/codedError'
import { resolveCanvasAdapters } from './adapterResolution'
import { listControlAdapters } from './controlAdapters'
import { resolveSharedWeight } from './modelSources'
import { getEngineFeatures } from './engineFeatures'
import { galleryRoots } from './gallery'
import { pickJobInputs, validateJobInputs } from './jobInputs'
import { PROJECT_ID_PATTERN, projectAssetsDir } from './projects'
import { getSettings } from './settings'
import { startEngineJob } from './supervisor'
import { getTrainingHost } from './trainingHosts'
import { connectWorkerHost, isWorkerDaemonHost, listActiveWorkerProfiles, workerEngineFeatures } from './workerHostManager'
import { resolveRemoteWorkerAdapters } from './remoteWorker'
import { assertGenerationAllowed } from '../update/gate'

const INPUT_KEYS = new Set(['initImage', 'mask', 'control', 'references', 'visionReferences', 'sampling'])

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

function workerSampling(raw: Record<string, unknown>): Pick<JobSampling, 'sampler' | 'scheduler'> | undefined {
  if (Object.keys(pickJobInputs(raw)).some((key) => key !== 'sampling') || raw['init'] != null || raw['styles'] != null)
    throw codedError('E_WORKER_UNSUPPORTED', '远端服务暂不支持图像输入，请移除后再生成')
  const sampling = raw['sampling']
  if (sampling === undefined) return undefined

  const unsupported = () => codedError('E_WORKER_UNSUPPORTED', '远端服务仅支持选择采样器和调度器，请移除其他采样设置')
  if (typeof sampling !== 'object' || sampling === null || Array.isArray(sampling)) throw unsupported()
  const entries: [string, unknown][] = Object.entries(sampling)
  if (!entries.length || entries.some(([key, value]) => !isWorkerSamplingKey(key) || typeof value !== 'string' || !value))
    throw unsupported()
  return Object.fromEntries(entries)
}

/**
 * The one way a generation request from outside main (IPC, the local HTTP
 * backend the Studio and the LAN web UI post to) becomes a job: blocked while an
 * update is required (minimumVersion), then LoRA ids are
 * resolved to files, and image inputs are validated and canonicalized before
 * anything is queued.
 */
export async function startRequestedEngineJob(raw: Record<string, unknown>): Promise<JobRecord> {
  // Clients below the feed's minimumVersion must update first (必须更新).
  assertGenerationAllowed()
  const settings = getSettings()
  const hostId = text(raw['hostId'])
  const binding = raw['modelBinding'] as { bundleId?: unknown } | undefined
  const bundleId = text(binding?.bundleId)
  let host = hostId ? getTrainingHost(settings, hostId) : undefined
  if ((host && isWorkerDaemonHost(host)) || bundleId?.startsWith('remote-worker:')) {
    const profileId = bundleId?.startsWith('remote-worker:') ? bundleId.slice('remote-worker:'.length) : undefined
    if (!hostId && profileId) {
      const targetId = listActiveWorkerProfiles().find((profile) => profile.id === profileId)?.hostId
      host = targetId ? getTrainingHost(settings, targetId) : undefined
    }
    if (!host || !isWorkerDaemonHost(host)) throw codedError('E_WORKER_CONFIG', '请选择已连接的远端服务主机')
    const sampling = workerSampling(raw)
    const profile = await connectWorkerHost(host)
    if (profileId && profile.id !== profileId) throw codedError('E_WORKER_CONFIG', '所选模型与远端服务不匹配')
    if (sampling) {
      const features = await workerEngineFeatures(host)
      if (!features?.samplers || Object.entries(sampling).some(([key, value]) => !features.values[key]?.includes(value)))
        throw codedError('E_WORKER_UNSUPPORTED', '远端服务不支持所选采样器或调度器，请重新选择')
    }
    const adapters = await resolveRemoteWorkerAdapters(profile, raw['adapters'])
    return startEngineJob({ ...raw, sampling, hostId: host.id, deviceUuid: undefined, adapters } as never)
  }
  const adapters = await resolveCanvasAdapters(settings, raw['adapters'], { hostId })
  const base = Object.fromEntries(Object.entries(raw).filter(([key]) => !INPUT_KEYS.has(key)))
  const wantsInputs = Object.keys(pickJobInputs(raw)).length > 0
  // A plain job asks the engine nothing; LoRAs and pictures are checked against what it can do.
  if (!wantsInputs && !adapters.length) return startEngineJob({ ...base, adapters } as never)
  const features = await getEngineFeatures({ deviceUuid: text(raw['deviceUuid']), hostId }).catch(() => null)
  if (adapters.length && features && !features.lora) {
    const engine = features.cli ? `${CLI_ENGINE_LABEL[features.cli]}引擎` : '当前引擎'
    throw codedError('E_NOT_SUPPORTED', `${engine}不支持 LoRA，请移除 LoRA 后再生成`)
  }
  if (!wantsInputs) return startEngineJob({ ...base, adapters } as never)

  const projectId = text(raw['projectId'])
  const imageRoots = await galleryRoots(settings)
  if (projectId && PROJECT_ID_PATTERN.test(projectId)) imageRoots.push(projectAssetsDir(projectId))
  const controlAdapters = (
    await Promise.all(
      listControlAdapters().map(async (entry) => (!isSharedModelId(entry.id) || (await resolveSharedWeight(entry.id)) ? entry : null)),
    )
  ).filter((entry) => entry !== null)
  const inputs = await validateJobInputs(raw, {
    imageRoots,
    controlAdapters,
    features,
    remote: Boolean(hostId),
  })
  return startEngineJob({ ...base, ...inputs, adapters } as never)
}
