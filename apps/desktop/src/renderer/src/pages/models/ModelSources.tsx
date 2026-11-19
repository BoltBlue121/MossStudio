import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Ipc } from '@shared/channels'
import type { ModelSource, ModelSourceFile, ModelSourcesView } from '@shared/types'
import { Notice } from '../../components/common/Notice'
import { Button, Group, Row, Spinner } from '../../components/ui'
import { call } from '../../lib/api'

const kindLabels: Record<ModelSource['kind'], string> = {
  comfyui: 'ComfyUI',
  webui: 'Stable Diffusion WebUI',
  forge: 'Forge',
  custom: '自定义目录',
}

const stateLabels: Record<ModelSourceFile['state'], string> = {
  available: '可用',
  pending: '待检查',
  incompatible: '引擎不兼容',
}

export function SharedWeightList({ files }: { files: ModelSourceFile[] }): React.JSX.Element {
  return (
    <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-caption text-ink-2">
      {files.map((file) => (
        <li key={file.path} className="flex justify-between gap-3" title={file.path}>
          <span className="[overflow-wrap:anywhere]">{file.name}</span>
          <span className="shrink-0">{stateLabels[file.state]}</span>
        </li>
      ))}
    </ul>
  )
}

function SourceFiles({ files }: { files: ModelSourceFile[] }): React.JSX.Element | null {
  if (!files.length) return null
  const models = files.filter((file) => file.role !== 'lora')
  const loras = files.filter((file) => file.role === 'lora')
  const ready = files.filter((file) => file.state === 'available')
  return (
    <div className="mt-1 flex flex-col gap-1">
      {ready.length ? (
        <span className="text-ink">
          {ready
            .slice(0, 3)
            .map((file) => file.name)
            .join('、')}
          {ready.length > 3 ? ' 等 ' + ready.length + ' 项' : ''}
        </span>
      ) : null}
      <details>
        <summary className="w-fit cursor-pointer py-1 text-ink">
          查看扫描结果（模型 {models.length} · LoRA {loras.length}）
        </summary>
        {models.length ? (
          <div className="mb-2">
            <p className="pb-1 text-ink">模型和部件</p>
            <SharedWeightList files={models} />
          </div>
        ) : null}
        {loras.length ? (
          <div>
            <p className="pb-1 text-ink">LoRA</p>
            <SharedWeightList files={loras} />
          </div>
        ) : null}
      </details>
    </div>
  )
}

export function ModelSources({ reload }: { reload?: string | number }): React.JSX.Element {
  const { pathname } = useLocation()
  const [view, setView] = useState<ModelSourcesView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(
    async (
      channel: typeof Ipc.modelSourcesRefresh | typeof Ipc.modelSourcesProbe | typeof Ipc.modelSourcesAdd | typeof Ipc.modelSourcesRemove,
      input?: { path?: string; kind?: ModelSource['kind']; id?: string },
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
        <Button tone="ghost" disabled={busy} onClick={() => void run(Ipc.modelSourcesProbe)}>
          检查本机服务
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
      {view?.services ? (
        <p className="text-ui text-ink-2" role="status">
          {view.services.length
            ? '运行中：' + view.services.map((service) => kindLabels[service.kind] + '（端口 ' + service.port + '）').join('、')
            : '没有在本机端口上找到可识别的服务。'}
        </p>
      ) : null}
      {view?.sources.length ? (
        <Group>
          {view.sources.map((source) => (
            <Row
              key={source.id}
              title={kindLabels[source.kind]}
              description={
                <div className="flex flex-col gap-1 [overflow-wrap:anywhere]">
                  <span>{source.path}</span>
                  <span>
                    <span>可用 {source.available} 项</span>
                    {source.pending ? '，待检查 ' + source.pending + ' 项' : ''}
                    {source.incompatible ? '，引擎不兼容 ' + source.incompatible + ' 项' : ''}
                  </span>
                  {source.issues.map((issue) => (
                    <span key={issue} className="text-warn">
                      {issue}
                    </span>
                  ))}
                  <SourceFiles files={source.files} />
                </div>
              }
            >
              <Button tone="ghost" disabled={busy} onClick={() => void run(Ipc.modelSourcesAdd, { id: source.id })}>
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
