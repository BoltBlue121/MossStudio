import type { ProjectCanvas } from './types'

export const DIMENSION_STEP = 16
export const MIN_DIMENSION = 16
export const MAX_DIMENSION = 4096
export const MAX_PIXELS = 4_200_000
export const PIXEL_BUDGET_MESSAGE = '总像素不能超过 4,200,000，请缩短宽度或高度'

/** A partial size can only be checked for area after the other edge is known. */
export function withinPixelBudget(size: { width?: number; height?: number }): boolean {
  return size.width === undefined || size.height === undefined || size.width * size.height <= MAX_PIXELS
}

export function imageSizeProblem(width: unknown, height: unknown): string | null {
  if (!validEdge(width) || !validEdge(height)) return `宽和高需为 ${MIN_DIMENSION} 到 ${MAX_DIMENSION} 之间的 ${DIMENSION_STEP} 的倍数`
  return withinPixelBudget({ width, height }) ? null : PIXEL_BUDGET_MESSAGE
}

function validEdge(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= MIN_DIMENSION && value <= MAX_DIMENSION && value % DIMENSION_STEP === 0
  )
}

export interface ImageSize {
  width: number
  height: number
}

/** Snap an edited edge, preserving its partner when supplied. */
export function clampDimension(value: number, fallback = 1024, otherEdge?: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  const limit = otherEdge ? Math.min(MAX_DIMENSION, Math.floor(MAX_PIXELS / otherEdge / DIMENSION_STEP) * DIMENSION_STEP) : MAX_DIMENSION
  return Math.max(MIN_DIMENSION, Math.min(limit, Math.round(value / DIMENSION_STEP) * DIMENSION_STEP))
}

/** Fit a calculated or imported size proportionally before snapping to the engine grid. */
export function fitImageSize(width: number, height: number): ImageSize {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)))
  const w = clampDimension(width * scale)
  const h = clampDimension(height * scale)
  // Rounding both edges up can exceed the budget; keep the shorter edge to minimise aspect error.
  return w >= h ? { width: clampDimension(w, w, h), height: h } : { width: w, height: clampDimension(h, h, w) }
}

/** Image and style cards store display dimensions, not the resolution of a generation. */
export function canvasSizeProblem({ kind, width, height }: Pick<ProjectCanvas, 'kind' | 'width' | 'height'>): string | null {
  if (kind === 'layout' || kind === 'result') return imageSizeProblem(width, height)
  return [width, height].every((edge) => Number.isInteger(edge) && edge >= 64 && edge <= 4096) ? null : '卡片尺寸需为 64 到 4096 之间的整数'
}
