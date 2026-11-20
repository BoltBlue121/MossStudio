import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppActionArgs } from '@shared/capabilities'
import { writeFileAtomic } from '../lib/atomicWrite'
import { paths } from '../lib/paths'
import { listControlAdapters } from '../services/controlAdapters'
import { getGpuInventory } from '../services/devices'
import { listDiagnostics } from '../services/diagnostics'
import { getEngineFeatures } from '../services/engineFeatures'
import { engineReadiness } from '../services/engineReadiness'
import { galleryDetail, listGallery, readGalleryFile, trashGalleryItem } from '../services/gallery'
import { openWindow } from '../windows'
import { cancelGbcJob, gbcJobSnapshot, gbcStatus, parseRegions, startGbcJob } from '../services/gbc'
import { deleteSeries, getSeries, listSeries, saveSeries } from '../services/manga'
import {
  cancelDownload,
  deleteModel,
  getCatalog,
  installBundle,
  listDownloads,
  modelSpace,
  pauseDownload,
  startDownload,
} from '../services/models'
import { deleteProject, getProject, listProjects } from '../services/projects'
import { listRemoteDownloads } from '../services/remoteDownloads'
import { getSettings } from '../services/settings'
import { cancelJob, getJob, getJobLogs, listJobs } from '../services/supervisor'
import { autoCaption } from '../services/training/captions'
import { scanDataset, setCaption } from '../services/training/dataset'
import { trainingReadiness } from '../services/training/readiness'
import {
  trainingChooseStep,
  trainingCommand,
  trainingCreate,
  trainingDuplicate,
  trainingGet,
  trainingList,
  trainingRemove,
  trainingSamples,
  trainingStart,
  trainingStop,
  trainingUpdate,
} from '../services/training/run'
import { assertDatasetEditable, getTrainingProject } from '../services/training/store'
import { listCapabilityAudit } from './audit'
import { createMainCapabilityDispatcher, type MainCapabilityDispatcher, type MainCapabilityHandler } from './dispatcher'

/**
 * Built-in main-process capability handlers covering projects, GBC, Library,
 * Models, Manga, Training and System diagnostics/audit.
 */

type AppArgsMap = {
  [K in import('@shared/capabilities').AppActionId]: AppActionArgs<K>
}

function typed<Id extends keyof AppArgsMap>(fn: (args: AppArgsMap[Id]) => unknown | Promise<unknown>): MainCapabilityHandler {
  return (args) => fn(args as AppArgsMap[Id])
}

export function createBuiltinMainHandlers(): Record<string, MainCapabilityHandler> {
  return {
    // ---- studio.projects (headless main operations) ----
    'studio.projects.list': () => ({ projects: listProjects() }),
    'studio.projects.get': typed<'studio.projects.get'>(({ id }) => {
      const project = getProject(id)
      if (!project) throw new Error(`没有这个项目：${id}`)
      return project
    }),
    'studio.projects.delete': typed<'studio.projects.delete'>(({ id }) => {
      deleteProject(id)
      return { deleted: id }
    }),

    // ---- studio.gbc.parse ----
    'studio.gbc.status': typed<'studio.gbc.status'>(({ versionId, fresh }) => gbcStatus(versionId, fresh)),
    'studio.gbc.parse_image': typed<'studio.gbc.parse_image'>(({ runId, path }) => parseRegions(runId, path)),
    'studio.gbc.start_job': typed<'studio.gbc.start_job'>((input) =>
      startGbcJob({
        ...input,
        detector: input.detector ?? 'owlv2',
        versionId: input.versionId ?? undefined,
      }),
    ),
    'studio.gbc.job_snapshot': typed<'studio.gbc.job_snapshot'>(({ jobId }) => gbcJobSnapshot(jobId)),
    'studio.gbc.job_cancel': typed<'studio.gbc.job_cancel'>(({ jobId }) => {
      cancelGbcJob(jobId)
      return { canceled: true, jobId }
    }),

    // ---- library.assets ----
    'library.assets.list': typed<'library.assets.list'>((input) =>
      listGallery(getSettings(), {
        ...input,
        limit: input.limit ?? 48,
      }),
    ),
    'library.assets.get': typed<'library.assets.get'>(({ path }) => galleryDetail(path)),
    'library.assets.read_image': typed<'library.assets.read_image'>(({ path }) => readGalleryFile(path)),
    'library.assets.trash': typed<'library.assets.trash'>(({ path }) => trashGalleryItem(path)),

    // ---- models.catalog ----
    'models.catalog.get': typed<'models.catalog.get'>(({ refresh }) => getCatalog(getSettings(), refresh ?? true)),
    'models.catalog.installed': async () => {
      const catalog = await getCatalog(getSettings())
      const installedModels = catalog.models.filter((model) => model.installed)
      const installedIds = new Set(installedModels.map((model) => model.id))
      const installedBundles = catalog.bundles.filter((bundle) => {
        const needed = [bundle.components.dit, bundle.components.textEncoder, bundle.components.vae, bundle.support].filter(Boolean)
        return needed.every((id) => installedIds.has(id!))
      })
      const installedAdapters = catalog.adapters.filter((adapter) => adapter.installed)
      return { models: installedModels, bundles: installedBundles, adapters: installedAdapters }
    },
    'models.control_adapters.list': () => ({ adapters: listControlAdapters() }),
    'models.downloads.list': () => ({ downloads: [...listDownloads(), ...listRemoteDownloads()] }),
    'models.space.check': typed<'models.space.check'>(({ modelIds }) => ({ disks: modelSpace(getSettings(), modelIds) })),
    'models.bundles.install': typed<'models.bundles.install'>(({ id }) => installBundle(id, getSettings())),
    'models.downloads.start': typed<'models.downloads.start'>(({ kind, id }) => startDownload(kind, id, getSettings())),
    'models.downloads.pause': typed<'models.downloads.pause'>(({ taskId }) => {
      pauseDownload(taskId)
      return { paused: true, taskId }
    }),
    'models.downloads.cancel': typed<'models.downloads.cancel'>(async ({ taskId }) => {
      await cancelDownload(taskId)
      return { canceled: true, taskId }
    }),
    'models.catalog.delete': typed<'models.catalog.delete'>(async ({ kind, id }) => {
      await deleteModel(kind, id, getSettings())
      return { deleted: true, kind, id }
    }),

    // ---- manga.series ----
    'manga.series.list': () => ({ series: listSeries() }),
    'manga.series.get': typed<'manga.series.get'>(({ id }) => {
      const series = getSeries(id)
      if (!series) throw new Error(`没有这部漫画：${id}`)
      return series
    }),
    'manga.series.save': typed<'manga.series.save'>(({ series }) => saveSeries(series)),
    'manga.series.delete': typed<'manga.series.delete'>(({ id }) => {
      deleteSeries(id)
      return { deleted: id }
    }),

    // ---- training.jobs ----
    'training.readiness.get': typed<'training.readiness.get'>(({ hostId }) => trainingReadiness(hostId)),
    'training.projects.list': async () => ({ trainings: await trainingList() }),
    'training.projects.get': typed<'training.projects.get'>(({ id }) => trainingGet(id)),
    'training.projects.create': typed<'training.projects.create'>(({ kind, hostId }) => trainingCreate(kind, hostId)),
    'training.projects.update': typed<'training.projects.update'>(({ id, patch }) => trainingUpdate(id, patch)),
    'training.projects.duplicate': typed<'training.projects.duplicate'>(({ id }) => trainingDuplicate(id)),
    'training.projects.delete': typed<'training.projects.delete'>(async ({ id }) => {
      await trainingRemove(id)
      return { deleted: id }
    }),
    'training.dataset.list': typed<'training.dataset.list'>(async ({ id }) => {
      await getTrainingProject(id)
      return scanDataset(id)
    }),
    'training.dataset.set_caption': typed<'training.dataset.set_caption'>(async ({ id, name, caption }) => {
      await assertDatasetEditable(id)
      return setCaption(id, name, caption)
    }),
    'training.dataset.auto_caption': typed<'training.dataset.auto_caption'>(async ({ id, names }) => {
      await assertDatasetEditable(id)
      return autoCaption(id, names)
    }),
    'training.runs.samples': typed<'training.runs.samples'>(({ id }) => trainingSamples(id)),
    'training.runs.command': typed<'training.runs.command'>(({ id }) => ({ command: trainingCommand(id) })),
    'training.runs.start': typed<'training.runs.start'>(({ id }) => trainingStart(id)),
    'training.runs.stop': typed<'training.runs.stop'>(({ id }) => trainingStop(id)),
    'training.runs.choose_step': typed<'training.runs.choose_step'>(({ id, step }) => trainingChooseStep(id, step)),

    // ---- system.runtime ----
    'system.engine.status': () => engineReadiness(),
    'system.engine.features': typed<'system.engine.features'>((target) => getEngineFeatures(target)),
    'system.gpu.inventory': () => getGpuInventory(),
    'system.jobs.list': async () => ({ jobs: await listJobs() }),
    'system.jobs.get': typed<'system.jobs.get'>(({ id }) => getJob(id)),
    'system.jobs.logs': typed<'system.jobs.logs'>(({ id }) => getJobLogs(id)),
    'system.jobs.cancel': typed<'system.jobs.cancel'>(({ id }) => cancelJob(id)),
    'system.diagnostics.list': () => ({ diagnostics: listDiagnostics() }),
    'system.context.get': async () => {
      const settings = getSettings()
      const [catalog, jobs, engine] = await Promise.all([getCatalog(settings), listJobs(), engineReadiness()])
      const installedModels = catalog.models.filter((model) => model.installed)
      const installedIds = new Set(installedModels.map((model) => model.id))
      const installedBundles = catalog.bundles.filter((bundle) => {
        const needed = [bundle.components.dit, bundle.components.textEncoder, bundle.components.vae, bundle.support].filter(Boolean)
        return needed.every((id) => installedIds.has(id!))
      })
      return {
        projects: listProjects(),
        jobs: jobs.slice(0, 30),
        engine,
        installedBundles: installedBundles.map((bundle) => ({ id: bundle.id, name: bundle.name, recommended: bundle.recommended })),
        installedAdapters: catalog.adapters
          .filter((adapter) => adapter.installed)
          .map((adapter) => ({ id: adapter.id, name: adapter.name })),
        controlAdapters: listControlAdapters().map((adapter) => ({
          id: adapter.id,
          name: adapter.name,
          controlKinds: adapter.controlKinds,
        })),
        enabledFlags: {
          gbcEnabled: settings.gbcEnabled === true,
          trainingEnabled: settings.trainingEnabled === true,
          remoteHostsEnabled: settings.remoteHostsEnabled === true,
        },
      }
    },
    'system.window.focus': typed<'system.window.focus'>(({ route }) => {
      openWindow('studio', route)
      return { focused: true, ...(route ? { route } : {}) }
    }),
    'system.reviews.record': typed<'system.reviews.record'>(async ({ jobId, observations, issues, nextChange }) => {
      const job = await getJob(jobId)
      if (!job) throw new Error(`任务不存在：${jobId}`)
      const review = {
        jobId,
        observations,
        issues,
        nextChange: nextChange ?? '',
        status: 'recorded' as const,
        at: new Date().toISOString(),
      }
      mkdirSync(paths.capabilityReviews(), { recursive: true })
      await writeFileAtomic(join(paths.capabilityReviews(), `${jobId}.json`), JSON.stringify(review, null, 2))
      return review
    }),
    'system.reviews.get': typed<'system.reviews.get'>(({ jobId }) => {
      const file = join(paths.capabilityReviews(), `${jobId}.json`)
      if (!existsSync(file)) return null
      return JSON.parse(readFileSync(file, 'utf8')) as unknown
    }),
    'system.audit.recent': typed<'system.audit.recent'>((query) => ({ entries: listCapabilityAudit(query) })),
  }
}

export function createBuiltinMainDispatcher(): MainCapabilityDispatcher {
  return createMainCapabilityDispatcher({
    mainHandlers: createBuiltinMainHandlers(),
    readFlags: () => {
      const settings = getSettings()
      return {
        gbcEnabled: settings.gbcEnabled === true,
        trainingEnabled: settings.trainingEnabled === true,
        remoteHostsEnabled: settings.remoteHostsEnabled === true,
      }
    },
  })
}
