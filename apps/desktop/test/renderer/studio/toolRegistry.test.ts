import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { settingsFixture } from '@test/mocks/backend'
import { boardTools } from '@renderer/pages/studio/builtinBoardTools'
import { RECIPES } from '@renderer/pages/studio/recipes'
import { ToolHub } from '@renderer/pages/studio/ToolHub'
import { createToolRegistry, type ToolContext } from '@renderer/pages/studio/toolRegistry'
import { StudioPanels } from '@renderer/pages/studio/StudioPanels'

const ctx: ToolContext = { recipes: [], parseBlocker: null, pictureId: 'cat' }

describe('board registry', () => {
  it('refuses duplicate contributions before any tool can be used', () => {
    const first = boardTools.list('hub', ctx)[0]!.tool
    expect(() => createToolRegistry([first, first])).toThrow('Duplicate board action ID')
  })

  it('routes a picker choice to a typed command and re-evaluates a recipe while the menu is open', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const host = document.createElement('div')
    const root = createRoot(host)
    const execute = vi.fn()
    const render = (context: ToolContext): void => {
      act(() => root.render(createElement(ToolHub, { context, execute })))
    }
    const row = (text: string) =>
      [...host.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find((el) => el.textContent?.includes(text))
    try {
      render({ ...ctx, recipes: RECIPES })
      act(() => host.querySelector('button')!.click())
      expect(row('改一张图')?.disabled).toBe(false)
      render({ ...ctx, recipes: RECIPES.map((recipe) => ({ ...recipe, disabled: '引擎未就绪' })) })
      expect(row('改一张图')?.textContent).toContain('引擎未就绪')
      expect(row('改一张图')?.disabled).toBe(true)
      act(() => row('改一张图')!.click())
      expect(execute).not.toHaveBeenCalled()
      render({ ...ctx, recipes: [], parseBlocker: undefined })
      expect(row('改一张图')).toBeUndefined()
      expect(row('解析')).toBeUndefined()
      act(() => row('新建风格')!.click())
      expect(execute).toHaveBeenCalledExactlyOnceWith({ type: 'create', node: 'style' })
      expect(host.querySelector('[role=menu]')).toBeNull()
    } finally {
      act(() => root.unmount())
      vi.unstubAllGlobals()
    }
  })

  it('keeps the picker open between items but closes it when focus reaches another toolbar button', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const toolbar = document.body.appendChild(document.createElement('div'))
    const root = createRoot(toolbar)
    try {
      act(() =>
        root.render([
          createElement(ToolHub, { key: 'hub', context: ctx, execute: vi.fn() }),
          createElement('button', { key: 'pan' }, '平移'),
        ]),
      )
      const trigger = toolbar.querySelector<HTMLButtonElement>('[aria-haspopup]')!
      act(() => {
        trigger.focus()
        trigger.click()
      })
      const [first, second] = toolbar.querySelectorAll<HTMLButtonElement>('[role=menuitem]')
      act(() => first!.focus())
      act(() => second!.focus())
      expect(document.activeElement).toBe(second)
      expect(toolbar.querySelector('[role=menu]')).not.toBeNull()

      const pan = toolbar.lastElementChild as HTMLButtonElement
      act(() => pan.focus())
      expect(document.activeElement).toBe(pan)
      expect(toolbar.querySelector('[role=menu]')).toBeNull()
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
    } finally {
      act(() => root.unmount())
      toolbar.remove()
      vi.unstubAllGlobals()
    }
  })

  it('offers direct creation only for blank layouts, styles and imported pictures', () => {
    const tools = boardTools.list('hub', { ...ctx, recipes: RECIPES }).map(({ tool }) => tool)
    expect(tools.filter(({ command }) => command.type === 'create').map(({ label, command }) => [label, command])).toEqual([
      ['新建画面', { type: 'create', node: 'layout' }],
      ['新建风格', { type: 'create', node: 'style' }],
      ['导入图片…', { type: 'create', node: 'image' }],
    ])
    expect(tools.find(({ actionId }) => actionId === 'recipe.upscale')?.command).toEqual({ type: 'recipe', recipe: 'upscale' })
  })

  it('never dispatches an unknown, hidden or disabled command', () => {
    const run = vi.fn()
    const off = { ...ctx, parseBlocker: undefined }
    for (const id of ['unknown', 'gbc.open', 'gbc.split', 'recipe.edit']) expect(boardTools.invoke(id, off, run)).toBe(false)
    expect(boardTools.list('hub', off).some(({ tool }) => tool.group === 'picture')).toBe(false)
    const blank = { ...ctx, pictureId: null }
    expect(boardTools.list('hub', blank).find(({ tool }) => tool.actionId === 'gbc.split')?.state).toEqual({
      kind: 'disabled',
      reason: '先选择一张有图片的卡片',
    })
    expect(boardTools.invoke('gbc.split', blank, run)).toBe(false)
    expect(boardTools.invoke('gbc.split', { ...ctx, parseBlocker: '还没有安装' }, run)).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(boardTools.invoke('gbc.split', ctx, run)).toBe(true)
    expect(run).toHaveBeenCalledWith({ type: 'split' })
  })

  it('offers the switch only as an opt-in and does not enable GBC with it', () => {
    expect(settingsFixture().toolHubEnabled).toBe(false)
    expect(settingsFixture({ toolHubEnabled: true }).gbcEnabled).toBe(false)
  })

  it('hides the same assistant subtree while the parser exclusively owns the right side', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const render = (active: 'assistant' | 'gbc' | null): void =>
      act(() =>
        root.render(
          createElement(StudioPanels, {
            active,
            assistant: createElement('textarea'),
            gbc: createElement('output'),
          }),
        ),
      )
    try {
      render('assistant')
      const draft = host.querySelector('textarea')!
      draft.value = '未发送'
      expect(host.querySelector('output')).toBeNull()
      render('gbc')
      expect(draft.closest('[hidden]')).not.toBeNull()
      expect(host.querySelector('output')).not.toBeNull()
      render(null)
      expect(host.querySelector('output')).toBeNull()
      render('assistant')
      expect(host.querySelector('textarea')).toBe(draft)
      expect(draft.value).toBe('未发送')
      expect(draft.closest('[hidden]')).toBeNull()
    } finally {
      act(() => root.unmount())
      vi.unstubAllGlobals()
    }
  })
})
