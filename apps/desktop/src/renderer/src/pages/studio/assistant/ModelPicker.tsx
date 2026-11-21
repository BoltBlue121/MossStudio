import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn, IconButton, Input, Select, useToast } from '../../../components/ui'
import type { AgentModelCatalog, CollabClient } from './collabClient'

const CUSTOM = '__custom__'

export interface ModelState {
  model?: string
  provider?: string
  reasoningEffort?: string
}

/** The session's model and reasoning level; a typed name when the Agent gives no list. */
export function ModelPicker({
  client,
  backendId,
  sessionId,
  fallbackModel,
  onModelChange,
}: {
  client: CollabClient
  backendId: string
  sessionId: string
  /** What the session list says, shown until the Agent answers. */
  fallbackModel?: string
  onModelChange?: (state: ModelState) => void
}): React.JSX.Element {
  const [catalog, setCatalog] = useState<AgentModelCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const toast = useToast()
  const generation = useRef(0)

  const load = useCallback(async () => {
    const version = ++generation.current
    setLoading(true)
    const next = await client.listModels(backendId, sessionId)
    if (generation.current !== version) return
    setCatalog(next)
    setLoading(false)
  }, [client, backendId, sessionId])

  useEffect(() => {
    // The ref object itself, held for the cleanup: a reply still on its way is dropped.
    const gen = generation
    void load()
    return () => {
      gen.current++
    }
  }, [load])

  const current = catalog?.currentModel ?? fallbackModel
  const effort = catalog?.currentReasoningEffort
  useEffect(() => {
    onModelChange?.({ model: current, provider: catalog?.currentProvider, reasoningEffort: effort })
  }, [current, effort, catalog?.currentProvider, onModelChange])

  async function apply(next: { model: string; provider?: string; reasoningEffort?: string }): Promise<void> {
    const model = next.model.trim()
    if (!model) return
    const previous = catalog
    setCatalog((value) => ({
      models: value?.models ?? [],
      reasoningEfforts: value?.reasoningEfforts ?? [],
      currentModel: model,
      ...((next.provider ?? value?.currentProvider) ? { currentProvider: next.provider ?? value?.currentProvider } : {}),
      ...((next.reasoningEffort ?? value?.currentReasoningEffort)
        ? { currentReasoningEffort: next.reasoningEffort ?? value?.currentReasoningEffort }
        : {}),
    }))
    try {
      const ok = await client.setModel({ backendId, sessionId, ...next, model })
      if (!ok) {
        setCatalog(previous)
        toast.push('这个 Agent 暂时不能在这里切换模型', 'info')
        return
      }
      toast.push(`已切换到 ${model}${next.reasoningEffort ? ` · ${next.reasoningEffort}` : ''}`, 'info')
    } catch (error) {
      setCatalog(previous)
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const models = catalog?.models ?? []
  const listed = current ? models.some((item) => item.id === current) : true
  const efforts = catalog?.reasoningEfforts ?? []

  return (
    <div className="flex min-w-0 items-center gap-1" data-model-picker>
      <span className="shrink-0 text-micro text-ink-2">模型</span>
      {typing || !models.length ? (
        <form
          className="flex min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            setTyping(false)
            void apply({ model: draft })
          }}
        >
          <Input
            aria-label="会话模型"
            value={typing ? draft : (current ?? '')}
            placeholder={loading ? '正在读取…' : '输入模型名，回车切换'}
            spellCheck={false}
            maxLength={200}
            onFocus={() => {
              if (!typing) setDraft(current ?? '')
              setTyping(true)
            }}
            onBlur={() => setTyping(false)}
            onChange={(event) => setDraft(event.target.value)}
            className="h-6 min-w-0 flex-1 text-micro"
          />
        </form>
      ) : (
        <Select
          aria-label="会话模型"
          value={current ?? ''}
          onValueChange={(value) => {
            if (value === CUSTOM) {
              setDraft(current ?? '')
              setTyping(true)
              return
            }
            const option = models.find((item) => item.id === value)
            void apply({ model: value, ...(option?.provider ? { provider: option.provider } : {}) })
          }}
          className="h-6 min-w-0 flex-1 text-micro"
        >
          {!current ? <option value="">选择模型</option> : null}
          {!listed && current ? <option value={current}>{current}</option> : null}
          {models.map((item) => (
            <option key={`${item.provider ?? ''}/${item.id}`} value={item.id}>
              {item.label}
              {item.provider ? ` · ${item.provider}` : ''}
            </option>
          ))}
          <option value={CUSTOM}>手动输入…</option>
        </Select>
      )}
      {efforts.length ? (
        <Select
          aria-label="推理档位"
          value={effort ?? ''}
          onValueChange={(value) => {
            if (current && value) void apply({ model: current, reasoningEffort: value })
          }}
          className="h-6 w-auto max-w-[6rem] shrink-0 text-micro"
        >
          {!effort ? <option value="">推理</option> : null}
          {efforts.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
      ) : null}
      <IconButton label="刷新模型列表" className="size-6" disabled={loading} onClick={() => void load()}>
        <RefreshCw className={cn('size-3', loading && 'animate-spin')} strokeWidth={1.6} />
      </IconButton>
    </div>
  )
}
