import { Copy, Minus, Plus } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { cloverUrl } from '../../lib/clover'
import { usePictureActions } from '../../lib/usePictureActions'
import { Button, IconButton, Modal, ToastProvider, cn, useToast } from '../ui'

interface Picture {
  path: string
  /** A live preview file is rewritten in place; keep the frame that was on the card. */
  seq?: number
  title?: string
  width?: number
  height?: number
  /** Generated artwork supports native copy and save; imported assets are preview-only files. */
  artwork?: boolean
}
interface Preview extends Picture {
  gallery?: readonly Picture[]
}
const usePreview = create<{ images: Picture[]; index: number }>(() => ({ images: [], index: 0 }))
const close = (): void => usePreview.setState({ images: [], index: 0 })
export const isRasterData = (src: string): boolean => /^data:image\/(?:png|jpeg|webp|gif|bmp|avif);base64,/i.test(src)
const previewError = (): string => '图片复制或保存失败，请确认图片仍可读取。'
const allowed = ({ path }: Picture): boolean => isRasterData(path) || /^(?:[a-z]:[\\/]|\/(?![\\/]))/i.test(path)

export function openImagePreview(request: Preview): void {
  if (!allowed(request)) return
  const images = (request.gallery ?? []).filter(allowed)
  let index = images.findIndex((image) => image.path === request.path)
  if (index < 0) index = images.push(request) - 1
  usePreview.setState({ images: images.map(({ title, ...image }) => ({ ...image, title: title?.split(/[\\/]/).at(-1) })), index })
}

export function PreviewButton({
  children,
  className,
  ...request
}: Preview & { children: ReactNode; className?: string }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={`放大预览${request.title ? `：${request.title}` : ''}`}
      className={cn('block size-full cursor-zoom-in', className)}
      onClick={() => openImagePreview(request)}
    >
      {children}
    </button>
  )
}

async function copyPixels(image: HTMLImageElement): Promise<void> {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context || !canvas.width || !canvas.height) throw new Error('Image unavailable')
  context.drawImage(image, 0, 0)
  const png = new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG unavailable'))), 'image/png'),
  )
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

function PictureView({ picture, step }: { picture: Picture; step: (offset: number) => void }): React.JSX.Element {
  const image = useRef<HTMLImageElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const [zoom, setZoom] = useState<number | null>(null),
    [natural, setNatural] = useState(picture.width ?? 0)
  const [failed, setFailed] = useState(false)
  const toast = useToast(),
    pictures = usePictureActions(previewError)
  const data = isRasterData(picture.path),
    artwork = !data && picture.artwork
  const scale = (delta: number): void =>
    setZoom((value) => Math.max(0.25, Math.min(4, (value ?? ((image.current?.width || natural) / natural || 1)) + delta)))
  const copy = async (): Promise<void> => {
    try {
      if (artwork) {
        if (!(await pictures.copy(picture.path))) return
      } else if (image.current?.naturalWidth) await copyPixels(image.current)
      else throw new Error('Image unavailable')
      toast.push('已复制图片', 'success')
    } catch {
      toast.push('没能复制图片，请确认图片已加载后再试。', 'error')
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const dialogs = document.querySelectorAll('dialog[open]')
      if (stage.current?.closest('dialog') !== dialogs[dialogs.length - 1]) return
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') step(e.key === 'ArrowLeft' ? -1 : 1)
      else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
        if (!e.repeat) void copy()
      } else return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div
        ref={stage}
        data-preview-stage
        className="min-h-0 flex-1 overflow-auto rounded-lg bg-well"
        onWheel={(e) => {
          if (e.deltaY) scale(e.deltaY < 0 ? 0.25 : -0.25)
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) close()
        }}
      >
        <div
          className="pointer-events-none flex size-max min-h-full min-w-full items-center justify-center"
          style={zoom === null ? { width: '100%', height: '100%' } : undefined}
        >
          {failed ? (
            <span className="text-ui text-ink-2">图片无法显示，可能已移走或格式不支持。</span>
          ) : (
            <img
              ref={image}
              crossOrigin="anonymous"
              draggable={false}
              alt={picture.title || '图片预览'}
              src={data ? picture.path : cloverUrl(picture.path, picture.seq)}
              className={cn(
                'pointer-events-auto block select-none',
                zoom === null ? 'max-h-full max-w-full' : 'max-w-none cursor-grab active:cursor-grabbing',
              )}
              style={zoom !== null && natural ? { width: natural * zoom } : undefined}
              onLoad={(e) => setNatural(e.currentTarget.naturalWidth)}
              onError={() => setFailed(true)}
              onPointerDown={(e) => {
                const el = stage.current
                if (zoom === null || !el || e.button !== 0) return
                drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop }
                e.currentTarget.setPointerCapture(e.pointerId)
              }}
              onPointerMove={(e) => {
                const d = drag.current
                if (d && stage.current) stage.current.scrollTo(d.left + d.x - e.clientX, d.top + d.y - e.clientY)
              }}
              onLostPointerCapture={() => {
                drag.current = null
              }}
            />
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-2" aria-label="图片操作">
        <IconButton label="缩小" onClick={() => scale(-0.25)}>
          <Minus className="size-4" strokeWidth={1.6} />
        </IconButton>
        <span className="tabular text-caption text-ink-2">{zoom === null ? '适应' : `${Math.round(zoom * 100)}%`}</span>
        <IconButton label="放大" onClick={() => scale(0.25)}>
          <Plus className="size-4" strokeWidth={1.6} />
        </IconButton>
        <Button onClick={() => setZoom(1)}>100%</Button>
        <Button onClick={() => setZoom(null)}>适应屏幕</Button>
        {artwork ? <Button onClick={() => void pictures.saveAs(picture.path)}>另存为…</Button> : null}
        <Button tone="primary" onClick={() => void copy()}>
          <Copy className="size-4" strokeWidth={1.6} />
          复制图片
        </Button>
      </div>
    </div>
  )
}

export function ImageLightbox(): React.JSX.Element | null {
  const { images, index } = usePreview(),
    picture = images[index]
  // The shell keys this host by route, including navigation through React Router's history API.
  useEffect(() => close, [])
  if (!picture) return null
  const step = (offset: number): void => usePreview.setState({ index: (index + offset + images.length) % images.length })
  return (
    <Modal
      open
      onClose={close}
      title={`${picture.title || '图片预览'}${images.length > 1 ? ` · ${index + 1} / ${images.length}` : ''}`}
      width="h-full max-h-full max-w-none [&>div]:overflow-hidden"
    >
      <ToastProvider>
        <PictureView key={picture.path} picture={picture} step={step} />
      </ToastProvider>
    </Modal>
  )
}
