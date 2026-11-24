import { describe, expect, it } from 'vitest'
import { Ipc } from '@shared/channels'
import { useApp } from '../support/app'
import { expectVisualRules } from '../support/visual'

describe('fullscreen preview', () => {
  const app = useApp()
  it('encodes the previewed training sample at full resolution as PNG without sending its path to file IPC', async () => {
    const page = await app.open({ scenario: 'trainings', route: '/training/tp-juzi' })
    await page.locator('[data-sample-row] button[aria-label^="放大预览"]').first().click()
    const dialog = page.getByRole('dialog'),
      img = dialog.getByRole('img')
    await img.evaluate(async (el) => {
      await (el as HTMLImageElement).decode()
    })
    // Capture the write in this window instead of replacing the person's clipboard. Blob and ClipboardItem are Chromium's own.
    const png = page.evaluate(
      () =>
        new Promise<{ type: string; signature: number[]; width: number; height: number }>((resolve) => {
          Object.defineProperty(navigator.clipboard, 'write', {
            configurable: true,
            value: async ([item]: ClipboardItem[]) => {
              const blob = await item!.getType('image/png')
              const bitmap = await createImageBitmap(blob)
              resolve({
                type: blob.type,
                signature: Array.from(new Uint8Array(await blob.slice(0, 8).arrayBuffer())),
                width: bitmap.width,
                height: bitmap.height,
              })
              bitmap.close()
            },
          })
        }),
    )
    await dialog.getByRole('button', { name: '复制图片' }).click()
    const size = await img.evaluate((el) => ({
      width: (el as HTMLImageElement).naturalWidth,
      height: (el as HTMLImageElement).naturalHeight,
    }))
    expect(await png).toEqual({ type: 'image/png', signature: [137, 80, 78, 71, 13, 10, 26, 10], ...size })
    expect(await app.calls(Ipc.galleryCopyImage)).toEqual([])
    expect(await dialog.getByRole('button', { name: '另存为…' }).count()).toBe(0)
  })
  it.each(['light', 'dark'] as const)('keeps library selection and keyboard focus in %s mode', async (theme) => {
    const page = await app.open({ scenario: 'ready', route: '/library', theme, defer: true })
    await page.evaluate(() => {
      window.__mock.state.gallery = [0, 1].map((i) => window.__mock.fixtures.galleryItemFixture(i))
    })
    await app.start()
    await page.locator('[data-library-item]').first().click()
    const detail = page.getByRole('complementary', { name: '作品详情' })
    const trigger = detail.getByRole('button', { name: '放大预览作品' })
    await trigger.click()
    const dialog = page.getByRole('dialog')
    await page.keyboard.press('ArrowRight')
    await dialog.getByRole('img', { name: 'moss_0001.png' }).waitFor()
    await page.keyboard.press('Control+c')
    await expect.poll(() => app.calls(Ipc.galleryCopyImage)).toEqual([{ path: '/fixture/outputs/moss_0001.png' }])
    await dialog.getByText('已复制图片').waitFor()
    await expectVisualRules(page, `图片预览 ${theme}`)
    await app.screenshot(`lightbox-${theme}`)
    await page.keyboard.press('Escape')
    await expect.poll(() => dialog.count()).toBe(0)
    expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true)
    expect(await detail.getByText('1 / 2').isVisible()).toBe(true)
    await trigger.click()
    await page.evaluate(() => {
      location.hash = '/studio'
    })
    await expect.poll(() => dialog.count()).toBe(0)
  })
})
