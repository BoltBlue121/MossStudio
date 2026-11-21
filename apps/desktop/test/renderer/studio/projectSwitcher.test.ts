import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ProjectSwitcher } from '@renderer/pages/studio/ProjectSwitcher'
import type { StudioProject } from '@renderer/pages/studio/useStudioProject'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function unsavedProject(rename: (name: string) => void): StudioProject {
  return {
    projectId: null,
    projectName: '未命名项目 2',
    projects: [],
    saveStatus: 'idle',
    saveError: null,
    rename,
    newProject: vi.fn(async () => undefined),
    openProject: vi.fn(async () => undefined),
    deleteProject: vi.fn(async () => undefined),
  } as unknown as StudioProject
}

function click(element: Element | null | undefined): void {
  if (!element) throw new Error('element not found')
  act(() => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    ;(element as HTMLElement).click()
  })
}

describe('ProjectSwitcher', () => {
  it('keeps the trigger and its menu out of the title bar drag area', () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(createElement(ProjectSwitcher, { project: unsavedProject(vi.fn()) })))

    const trigger = document.querySelector('[data-project-switcher]')
    expect(trigger?.classList.contains('no-drag')).toBe(true)
    expect(trigger?.parentElement?.classList.contains('no-drag')).toBe(true)
    click(trigger)
    const menu = document.querySelector('[role="menu"]')
    expect(menu?.closest('.no-drag')).not.toBeNull()
    expect(menu?.classList.contains('no-drag')).toBe(true)
  })

  it('renames a new project that has not been saved yet', () => {
    const rename = vi.fn()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(createElement(ProjectSwitcher, { project: unsavedProject(rename) })))

    click(document.querySelector('[data-project-switcher]'))
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent === '重命名')
    expect(item?.hasAttribute('disabled')).toBe(false)
    click(item)

    const dialog = document.querySelector('dialog')
    expect(dialog?.textContent).toContain('重命名项目')
    const input = dialog!.querySelector('input')!
    expect(input.value).toBe('未命名项目 2')
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(input, '海边分镜')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click([...dialog!.querySelectorAll('button')].find((node) => node.textContent === '保存'))
    expect(rename).toHaveBeenCalledWith('海边分镜')
  })
})
