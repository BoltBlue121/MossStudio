/**
 * Plain-language presets for the Studio parameters panel. Pure data and helpers,
 * no React, so the mapping between what the user picks and what the engine
 * receives is unit tested.
 */

import type { ModelBundle } from '@shared/types'
import { MIN_DIMENSION, clampDimension, fitImageSize, type ImageSize } from '@shared/imageGeometry'

export {
  MIN_DIMENSION,
  MAX_DIMENSION,
  DIMENSION_STEP,
  MAX_PIXELS,
  clampDimension,
  fitImageSize,
  type ImageSize,
} from '@shared/imageGeometry'

export const DEFAULT_NEGATIVE = 'nsfw, worst quality, bad anatomy, watermark, jpeg artifact'

export type SizePresetId = '1:1' | '4:3' | '3:4' | '3:2' | '2:3' | '16:9' | '9:16' | 'custom'

export interface SizePreset {
  id: Exclude<SizePresetId, 'custom'>
  width: number
  height: number
}

export const MP_TIERS = [0.5, 1, 1.5, 2, 3, 4] as const

/** About one megapixel each, every side a multiple of 16. */
export const SIZE_PRESETS: readonly SizePreset[] = [
  { id: '1:1', width: 1024, height: 1024 },
  { id: '4:3', width: 1152, height: 864 },
  { id: '3:4', width: 864, height: 1152 },
  { id: '3:2', width: 1248, height: 832 },
  { id: '2:3', width: 832, height: 1248 },
  { id: '16:9', width: 1280, height: 720 },
  { id: '9:16', width: 720, height: 1280 },
]

export const DEFAULT_SIZE = { width: 1024, height: 1024 } as const

export type MegapixelTier = (typeof MP_TIERS)[number]

/** The 1 MP tier retains the original sizes; the other tiers target decimal megapixels. */
export function sizeForMegapixels(ratio: SizePreset['id'] | ImageSize, mp: MegapixelTier): ImageSize {
  const preset = typeof ratio === 'string' ? SIZE_PRESETS.find((item) => item.id === ratio)! : ratio
  const { width, height } = preset
  if (mp === 1 && typeof ratio === 'string') return { width, height }
  const scale = Math.sqrt((mp * 1_000_000) / (width * height))
  return fitImageSize(width * scale, height * scale)
}

const tierPresets = SIZE_PRESETS.flatMap(({ id }) => MP_TIERS.map((mp) => ({ id, mp, ...sizeForMegapixels(id, mp) })))

/** Match stored dimensions, not merely a nearby ratio or rounded pixel count. */
export function sizeChoiceFor(width: number, height: number) {
  return tierPresets.find((preset) => preset.width === width && preset.height === height)
}

/** Which preset a size matches; anything else is shown as 自定义. */
export function sizePresetFor(width: number, height: number): SizePresetId {
  return sizeChoiceFor(width, height)?.id ?? 'custom'
}

/**
 * One size step down for a picture the GPU could not fit: three quarters of
 * each side (about half the pixels), on the engine grid. Null when it is
 * already as small as the engine goes.
 */
export function smallerSize(width: number, height: number): { width: number; height: number } | null {
  // An edge already under the floor stays as it is: a step down never grows one.
  const next = {
    width: Math.min(width, clampDimension(width * 0.75, MIN_DIMENSION)),
    height: Math.min(height, clampDimension(height * 0.75, MIN_DIMENSION)),
  }
  return next.width < width || next.height < height ? next : null
}

export type QualityId = 'fast' | 'standard' | 'fine'
export type SamplerProfile = 'dmd8' | 'base'

export interface QualityPreset {
  id: QualityId
  label: string
  steps: number
  /** Sampler profile sent with the job. 快速 is the 8-step DMD profile. */
  profile: SamplerProfile
  /** CFG the preset is tuned for; picking a preset resets CFG to this. */
  cfg: number
  hint: string
}

export const QUALITY_PRESETS: readonly QualityPreset[] = [
  { id: 'fast', label: '快速', steps: 8, profile: 'dmd8', cfg: 1, hint: '8 步，几秒出图' },
  { id: 'standard', label: '标准', steps: 20, profile: 'base', cfg: 3, hint: '20 步，细节和速度兼顾' },
  { id: 'fine', label: '精细', steps: 50, profile: 'base', cfg: 3, hint: '50 步，最慢但细节最多' },
]

export const DEFAULT_QUALITY: QualityId = 'standard'

export function qualityPreset(id: QualityId): QualityPreset {
  return QUALITY_PRESETS.find((preset) => preset.id === id) ?? QUALITY_PRESETS[1]
}

/** The preset a step count was chosen from, or 'custom' for older canvases. */
export function qualityFor(steps: number): QualityId | 'custom' {
  return QUALITY_PRESETS.find((preset) => preset.steps === steps)?.id ?? 'custom'
}

/** Quality as it reads everywhere (panel and viewer): "标准 · 20 步", or "自定义 · 28 步". */
export function qualityLabel(steps: number): string {
  const id = qualityFor(steps)
  return `${id === 'custom' ? '自定义' : qualityPreset(id).label} · ${steps} 步`
}

/** Nearest preset, for values that arrive from outside the panel (e.g. the assistant). */
export function nearestQuality(steps: number): QualityId {
  let best = QUALITY_PRESETS[0]
  for (const preset of QUALITY_PRESETS) {
    if (Math.abs(preset.steps - steps) < Math.abs(best.steps - steps)) best = preset
  }
  return best.id
}

/**
 * Sampler profile for a run. A preset step count carries the profile the user
 * picked with it; step counts saved by older versions keep their old meaning
 * (8 steps or fewer ran the DMD profile).
 */
export function profileFor(steps: number): SamplerProfile {
  const quality = qualityFor(steps)
  if (quality !== 'custom') return qualityPreset(quality).profile
  return steps <= 8 ? 'dmd8' : 'base'
}

/**
 * Steps and CFG after switching models. A few-step model brings its own (8
 * steps, CFG 1); going from one back to a normal model restores 标准 when the
 * canvas still has the few-step values, so it does not keep drawing in 8 steps.
 */
export function samplingForBundle(
  current: { steps: number; cfg: number },
  from: Pick<ModelBundle, 'defaults'> | null | undefined,
  to: Pick<ModelBundle, 'defaults'> | null | undefined,
): { steps: number; cfg: number } {
  if (to?.defaults) return { steps: to.defaults.steps ?? current.steps, cfg: to.defaults.cfg ?? current.cfg }
  const left = from?.defaults
  if (left && (left.steps ?? current.steps) === current.steps && (left.cfg ?? current.cfg) === current.cfg) {
    const standard = qualityPreset(DEFAULT_QUALITY)
    return { steps: standard.steps, cfg: standard.cfg }
  }
  return { steps: current.steps, cfg: current.cfg }
}

/** Seeds are stored as non-negative 31-bit integers (the project schema requires int). */
export const SEED_MAX = 2 ** 31 - 1

export function randomSeed(random: () => number = Math.random): number {
  return Math.floor(random() * SEED_MAX)
}

/** The seed every canvas had before 随机 existed; nobody chose it on purpose. */
export const LEGACY_DEFAULT_SEED = 42

/**
 * Whether a canvas keeps its seed. Canvases saved before the lock existed
 * (`seedLocked` undefined) always reused their seed; one the user changed from
 * the old default of 42 counts as deliberately chosen and stays locked, while
 * the untouched default becomes random like every new canvas.
 */
export function isSeedLocked(canvas: { seed: number; seedLocked?: boolean }): boolean {
  return canvas.seedLocked ?? canvas.seed !== LEGACY_DEFAULT_SEED
}

/** Seed the next run uses: the kept seed when locked, a fresh one otherwise. */
export function seedForRun(canvas: { seed: number; seedLocked?: boolean }, random: () => number = Math.random): number {
  return isSeedLocked(canvas) ? canvas.seed : randomSeed(random)
}

/** Parse a typed seed; empty or invalid text yields null. */
export function parseSeed(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  return Math.min(SEED_MAX, Number(trimmed))
}

/** Next free "画面 N" title. Older projects named them "Canvas N"; both count. */
/** `${prefix} N` after the highest N in use, as 画面 are numbered: 风格 1, 放大 2. */
export function nextNodeTitle(prefix: string, titles: readonly string[]): string {
  let highest = 0
  const pattern = new RegExp(`^${prefix} (\\d+)$`)
  for (const title of titles) {
    const match = pattern.exec(title)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return `${prefix} ${highest + 1}`
}

export function nextCanvasTitle(titles: readonly string[]): string {
  let highest = 0
  for (const title of titles) {
    const match = /^(?:画面|Canvas) (\d+)$/.exec(title)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return `画面 ${highest + 1}`
}

export const UNTITLED_PROJECT = '未命名项目'

/** Untitled name that does not collide with an existing project. */
export function nextProjectName(names: readonly string[]): string {
  const used = new Set(names)
  if (!used.has(UNTITLED_PROJECT)) return UNTITLED_PROJECT
  let index = 2
  while (used.has(`${UNTITLED_PROJECT} ${index}`)) index += 1
  return `${UNTITLED_PROJECT} ${index}`
}
