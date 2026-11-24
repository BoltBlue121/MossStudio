import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ImageLightbox, openImagePreview } from '@renderer/components/common/ImageLightbox'
import { Ipc } from '@shared/channels'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLElement, trigger: HTMLButtonElement, root: Root
const invoke = vi.fn(async () => ({ ok: true, data: true }))
const first = { path: '/pictures/first.png', title: '第一张', artwork: true, width: 200, height: 100 }
const second = { ...first, path: '/pictures/second.png', title: '第二张' }
const open = (): void => act(() => openImagePreview({ ...first, gallery: [first, second] }))
const image = (): HTMLImageElement => document.querySelector('dialog img')!
const key = (key: string, ctrlKey = false): void => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true }))
}
const button = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(
    (el) => el.getAttribute('aria-label') === label || el.textContent === label,
  )!
beforeEach(() => {
  host = document.createElement('div')
  trigger = document.createElement('button')
  document.body.append(host, trigger)
  root = createRoot(host)
  act(() => root.render(createElement(ImageLightbox)))
  trigger.focus()
  vi.stubGlobal('clover', { invoke })
  invoke.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  trigger.remove()
  vi.unstubAllGlobals()
})
it('opens only when requested, and restores focus after Escape or pressing the background', () => {
  expect(document.querySelector('dialog')).toBeNull()
  open()
  expect(image().src).toBe('clover://local?path=%2Fpictures%2Ffirst.png')
  act(() => key('Escape'))
  expect(document.querySelector('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  open()
  act(() => document.querySelector<HTMLElement>('[data-preview-stage]')!.click())
  expect(document.querySelector('dialog')).toBeNull()
})
it('uses actual image size at 100%, clamps wheel and button zoom and fits again', () => {
  open()
  act(() => button('100%').click())
  expect(image().style.width).toBe('200px')
  act(() => button('放大').click())
  expect(image().style.width).toBe('250px')
  for (let i = 0; i < 20; i++)
    act(() => {
      image().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
    })
  expect(image().style.width).toBe('800px')
  for (let i = 0; i < 20; i++) act(() => button('缩小').click())
  expect(image().style.width).toBe('50px')
  act(() => button('适应屏幕').click())
  expect(image().style.width).toBe('')
})
it('copies the current image through native IPC by button and Ctrl+C, not the previous gallery entry', async () => {
  open()
  await act(async () => button('复制图片').click())
  expect(invoke).toHaveBeenLastCalledWith(Ipc.galleryCopyImage, { path: first.path })
  expect(document.querySelector('dialog')?.textContent).toContain('已复制图片')
  act(() => key('ArrowRight'))
  expect(image().alt).toBe(second.title)
  await act(async () => key('c', true))
  expect(invoke).toHaveBeenLastCalledWith(Ipc.galleryCopyImage, { path: second.path })
  act(() => key('ArrowLeft'))
  await act(async () => button('另存为…').click())
  expect(invoke).toHaveBeenLastCalledWith(Ipc.gallerySaveAs, { path: first.path })
  act(() => key('Escape'))
  act(() => key('c', true))
  expect(invoke).toHaveBeenCalledTimes(3)
})
it.each([
  'https://example.org/image.png',
  '//server/share/image.png',
  '\\\\server\\share\\photo.png',
  'file:///tmp/sample.jpg',
  'data:text/html;base64,AAAA',
  'data:image/svg+xml;base64,AAAA',
])('never opens an external or unsupported source: %s', (path) => {
  act(() => openImagePreview({ path }))
  expect(document.querySelector('dialog')).toBeNull()
  expect(invoke).not.toHaveBeenCalled()
})
it('pans enlarged pixels only during a captured drag, without closing the picture', () => {
  open()
  const img = image(),
    stage = document.querySelector<HTMLElement>('[data-preview-stage]')!
  img.setPointerCapture = vi.fn()
  const scroll = vi.spyOn(stage, 'scrollTo')
  stage.scrollLeft = 10
  stage.scrollTop = 40
  const point = (type: string, x: number, y: number): void => {
    img.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: y }))
  }
  act(() => {
    point('pointerdown', 100, 150)
    point('pointermove', 50, 100)
  })
  expect(scroll).not.toHaveBeenCalled()
  act(() => button('放大').click())
  act(() => {
    point('pointerdown', 100, 150)
    point('pointermove', 50, 100)
    point('lostpointercapture', 50, 100)
    point('pointermove', 0, 0)
  })
  expect(scroll.mock.calls).toEqual([[60, 90]])
  expect(image()).toBe(img)
})
it('does not report success or expose a filesystem path when native copy fails', async () => {
  invoke.mockRejectedValueOnce(new Error('EPERM /secret/album/file.png'))
  open()
  await act(async () => key('c', true))
  const text = document.querySelector('dialog')!.textContent
  expect(text).not.toContain('/secret')
  expect(text).not.toContain('已复制图片')
  expect(text).toContain('失败')
})
it('does not echo directory names if a caller supplied a filename as the title', () => {
  act(() => openImagePreview({ path: '/private/work/first.png', title: '/private/work/first.png' }))
  expect(image().alt).toBe('first.png')
  expect(document.querySelector('dialog')?.textContent).not.toContain('/private')
})
it('does not send a data preview to gallery IPC or offer file export', async () => {
  act(() => openImagePreview({ path: 'data:image/png;base64,AAAA' }))
  expect(image().src).toBe('data:image/png;base64,AAAA')
  expect(button('另存为…')).toBeUndefined()
  await act(async () => key('c', true))
  expect(invoke).not.toHaveBeenCalled()
  expect(document.querySelector('dialog')?.textContent).not.toContain('已复制图片')
})
