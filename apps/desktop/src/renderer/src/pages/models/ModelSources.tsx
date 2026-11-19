import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Ipc } from '@shared/channels'
import type { ModelSource, ModelSourcesView } from '@shared/types'
import { Notice } from '../../components/common/Notice'
import { Button, Group, Row, Spinner } from '../../components/ui'
import { call } from '../../lib/api'

const kindLabels: Record<ModelSource['kind'], string> = {
  comfyui: 'ComfyUI',
  webui: 'Stable Diffusion WebUI',
  forge: 'Forge',
  custom: '自定义目录',
}

export function ModelSources({ reload }: { reload?: string | number }): React.JSX.Element {
  const { pathname } = useLocation()
  const [view, setView] = useState<ModelSourcesView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(
    async (
      channel: typeof Ipc.modelSourcesRefresh | typeof Ipc.modelSourcesAdd | typeof Ipc.modelSourcesRemove,
      input?: { path?: string; kind?: ModelSource['kind']; id?: string; config?: boolean },
    ): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        const result = await call<ModelSourcesView>(channel, input)
        setView(result)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (pathname === '/models' || pathname === '/setup') void run(Ipc.modelSourcesRefresh)
  }, [run, reload, pathname])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button tone="secondary" disabled={busy} onClick={() => void run(Ipc.modelSourcesAdd, {})}>
          添加目录
        </Button>
        <Button tone="secondary" disabled={busy} onClick={() => void run(Ipc.modelSourcesAdd, { config: true })}>
          选择 ComfyUI 配置
        </Button>
        <Button tone="ghost" disabled={busy} onClick={() => void run(Ipc.modelSourcesRefresh)}>
          刷新
        </Button>
      </div>
      {busy ? (
        <p className="flex items-center gap-2 text-ui text-ink-2" role="status">
          <Spinner />
          正在检查模型目录…
        </p>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {view?.sources.length ? (
        <Group>
          {view.sources.map((source) => (
            <Row
              key={source.id}
              title={kindLabels[source.kind]}
              description={
                <span className="flex flex-col gap-1 [overflow-wrap:anywhere]">
                  <span>{source.path}</span>
                  <span>
                    可用 {source.available} 项{source.pending ? '，待检查 ' + source.pending + ' 项' : ''}
                    {source.incompatible ? '，引擎不兼容 ' + source.incompatible + ' 项' : ''}
                  </span>
                  {source.issues.map((issue) => (
                    <span key={issue} className="text-warn">
                      {issue}
                    </span>
                  ))}
                </span>
              }
            >
              <Button
                tone="ghost"
                disabled={busy}
                onClick={() =>
                  void run(Ipc.modelSourcesAdd, {
                    id: source.id,
                    kind: source.kind,
                    config: /\.(?:yaml|yml|json)$/i.test(source.path),
                  })
                }
              >
                更换路径
              </Button>
              <Button tone="ghost" disabled={busy} onClick={() => void run(Ipc.modelSourcesRemove, { id: source.id })}>
                移除来源
              </Button>
            </Row>
          ))}
        </Group>
      ) : null}
      {view?.suggestions.length ? (
        <Group>
          {view.suggestions.map((source) => (
            <Row key={source.id} title={'发现 ' + kindLabels[source.kind]} description={source.path}>
              <Button
                tone="secondary"
                disabled={busy}
                onClick={() => void run(Ipc.modelSourcesAdd, { path: source.path, kind: source.kind })}
              >
                接入
              </Button>
            </Row>
          ))}
        </Group>
      ) : null}
      {view && !view.sources.length && !view.suggestions.length ? (
        <p className="text-ui text-ink-2">选择已有的模型目录，即可使用里面的兼容模型。</p>
      ) : null}
    </div>
  )
}
