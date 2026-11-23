import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  AgentBackendInfo,
  AgentDriver,
  AgentHubEvent,
  AgentMessagePage,
  AgentProject,
  AgentSendInput,
  AgentSetModelInput,
} from '@shared/agentHub'
import { codedError } from '../lib/codedError'
import { readImageHeader } from '../services/imageHeaders'
import { desktopListeners, pairingFor } from './dshDiscovery'
import { pairDesktop } from './dshPeer'

const id = 'dsh-desktop'
const object = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const text = (v: unknown) => (typeof v === 'string' ? v : undefined)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
function blocks(input: AgentSendInput) {
  let total = 0
  const pics = (input.attachments ?? []).map(({ name, mime, dataUrl }) => {
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([a-z\d+/]+={0,2})$/i.exec(dataUrl ?? '')
    if (!m || m[1] !== mime || (total += m[2]!.length) > 14_000_000) throw new Error('附件格式或大小不受支持，请重新选择图片')
    const bytes = Buffer.from(m[2]!, 'base64'),
      header = readImageHeader(bytes)
    if (!header || `image/${header.format}` !== mime || bytes.toString('base64') !== m[2]) throw new Error('附件不是有效图片')
    return { type: 'image', mediaType: mime, name, data: m[2] }
  })
  return [
    {
      type: 'text',
      text: [input.text, input.studioContext && `[Current Studio context]\n${input.studioContext}`].filter(Boolean).join('\n\n'),
    },
    ...pics,
  ]
}
function page(value: unknown): AgentMessagePage {
  const raw = object(value),
    messages: AgentMessagePage['messages'] = []
  let last = 0
  let remaining = 24_000_000 // Across the entire IPC reply, not per event.
  for (const row of list(raw.records)) {
    const e = object(object(row).event),
      data = object(e.data),
      seq = e.seq
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) continue
    last = Math.max(last, seq)
    if (e.type !== 'user/message' && e.type !== 'assistant/message') continue
    const parts = list(object(data.message).content ?? data.content).map(object)
    const content = parts
      .filter((p) => p.type === 'text')
      .map((p) => text(p.text) ?? '')
      .join('\n')
    // Only inline raster blocks from this bounded page; never resolve a path or load an Agent URL.
    const images = parts
      .filter((p) => p.type === 'image')
      .slice(0, 4)
      .flatMap(({ mediaType, data }) => {
        if (
          typeof data !== 'string' ||
          data.length > Math.min(remaining, 14_000_000) ||
          !['image/jpeg', 'image/png', 'image/webp'].includes(String(mediaType))
        )
          return []
        const bytes = Buffer.from(data, 'base64')
        if (`image/${readImageHeader(bytes)?.format}` !== mediaType || bytes.toString('base64') !== data) return []
        remaining -= data.length
        return [`data:${mediaType};base64,${data}`]
      })
    if (content || images.length)
      messages.push({ seq, role: e.type === 'user/message' ? 'user' : 'assistant', text: content, ...(images.length ? { images } : {}) })
  }
  return { messages, hasMore: raw.hasMore === true, asOfSeq: typeof raw.cursor === 'number' ? raw.cursor : last }
}
const workspace = z.object({ workspaceId: z.string(), title: z.string(), path: z.string(), sessionIds: z.array(z.string()) })

export function createDshDriver(emit: (event: AgentHubEvent) => void, discover = desktopListeners, pairing = pairingFor): AgentDriver {
  let owner = new AbortController(),
    connection: Awaited<ReturnType<typeof pairDesktop>> | undefined,
    wantsAutoReconnect = false,
    reconnecting: Promise<Awaited<ReturnType<typeof pairDesktop>>> | undefined
  const isDisconnectError = (err: unknown): boolean =>
    Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'E_DSH_DISCONNECTED')
  const peer = () => {
    if (!connection?.connected) throw codedError('E_DSH_DISCONNECTED', '请先连接 DSH Desktop')
    return connection
  }
  async function reconnect(): Promise<Awaited<ReturnType<typeof pairDesktop>>> {
    if (reconnecting) return reconnecting
    reconnecting = (async () => {
      try {
        const { signal } = owner
        const listeners = await discover(signal)
        if (!listeners.length) throw codedError('E_DSH_DISCONNECTED', 'DSH 连接已断开，请重新连接桌面端')
        const target = await pairing(listeners)
        signal.throwIfAborted()
        const next = await pairDesktop(target, listeners, signal)
        signal.throwIfAborted()
        connection?.close()
        connection = next
        for (const key of watches.keys()) forget(key)
        return next
      } catch (err) {
        connection?.close()
        connection = undefined
        throw err
      }
    })()
    try {
      return await reconnecting
    } finally {
      reconnecting = undefined
    }
  }
  async function withPeer<T>(fn: (p: Awaited<ReturnType<typeof pairDesktop>>) => Promise<T>): Promise<T> {
    if (!connection?.connected && wantsAutoReconnect) {
      await reconnect()
    }
    try {
      return await fn(peer())
    } catch (err) {
      if (wantsAutoReconnect && isDisconnectError(err)) {
        const next = await reconnect()
        return await fn(next)
      }
      throw err
    }
  }
  const info = (available: boolean): AgentBackendInfo => ({
    id,
    kind: id,
    label: 'DSH Desktop',
    available,
    connected: !!connection?.connected,
    resumable: true,
  })
  const watches = new Map<string, { ready: Promise<() => void>; timer: ReturnType<typeof setTimeout> }>()
  const forget = (sessionId: string) => {
    const w = watches.get(sessionId)
    if (w) {
      watches.delete(sessionId)
      clearTimeout(w.timer)
      void w.ready.then(
        (close) => close(),
        () => undefined,
      )
    }
  }
  async function watch(sessionId: string) {
    const p = peer(),
      existing = watches.get(sessionId)
    if (existing) {
      existing.timer.refresh()
      await existing.ready
      return
    }
    if (watches.size >= 16) forget(watches.keys().next().value!)
    const timer = setTimeout(() => forget(sessionId), 10 * 60000)
    const send = (event: Omit<AgentHubEvent, 'backendId' | 'sessionId'>) => emit({ backendId: id, sessionId, ...event })
    const ready = p.follow(
      'session/follow',
      { request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 1 } },
      (item) => {
        if (p !== connection) return
        timer.refresh()
        const frame = object(item),
          inner = object(frame.frame),
          chunk = object(inner.chunk),
          event = object(frame.event)
        if (frame.type === 'assistant-stream' && inner.type === 'chunk' && chunk.type === 'text-delta' && typeof chunk.text === 'string')
          send({ type: 'delta', text: chunk.text })
        if (frame.type === 'event' && event.type === 'turn/end') send({ type: 'done' })
        if (frame.type === 'event' && event.type === 'turn/start') send({ type: 'status' })
      },
      () => {
        if (connection === p) {
          forget(sessionId)
          send({ type: 'error', message: 'DSH 消息流已中断，请重新连接' })
        }
      },
    )
    watches.set(sessionId, { ready, timer })
    try {
      await ready
    } catch (error) {
      forget(sessionId)
      throw error
    }
  }
  const disconnect = (manual = false) => {
    if (manual) wantsAutoReconnect = false
    connection?.close()
    connection = undefined
    owner.abort()
    owner = new AbortController()
    for (const key of watches.keys()) forget(key)
  }
  async function setModel(input: AgentSetModelInput) {
    const selected = object(
      object(
        await withPeer((p) =>
          p.rpc('session/selectModel', {
            request: { sessionId: input.sessionId, model: input.model, provider: input.provider, reasoningEffort: input.reasoningEffort },
          }),
        ),
      ).selected,
    )
    return {
      ok: true as const,
      model: z.string().parse(selected.model),
      provider: text(selected.provider),
      reasoningEffort: text(selected.reasoningEffort),
    }
  }
  return {
    id,
    async probe() {
      return info(!!connection?.connected || !!(await discover(owner.signal)).length)
    },
    async connect(input) {
      disconnect(false)
      const { signal } = owner
      const listeners = await discover(signal)
      if (!listeners.length) throw new Error('没有检测到正在运行的 DSH Desktop')
      const target = input.pairingUrl ?? (await pairing(listeners))
      signal.throwIfAborted()
      const next = await pairDesktop(target, listeners, signal)
      signal.throwIfAborted()
      connection = next
      wantsAutoReconnect = !input.pairingUrl
      return info(true)
    },
    async disconnect() {
      disconnect(true)
    },
    async listProjects() {
      return withPeer(async (p) => {
        let answer: AgentProject[] | undefined
        const cancel = await p.follow(
          'workspace/follow',
          {},
          (item) => {
            const frame = object(item)
            if (frame.type === 'baseline')
              answer = z
                .array(workspace)
                .parse(object(frame.value).items)
                .map((w) => ({ id: w.workspaceId, title: w.title, cwd: w.path, sessionIds: w.sessionIds }))
          },
          () => {},
        )
        cancel()
        if (!answer) throw new Error('无法读取 DSH 项目列表')
        return answer
      })
    },
    async listSessions() {
      return list(object(await withPeer((p) => p.rpc('session/list', { _request: {} }))).items)
        .map(object)
        .flatMap((s) => {
          if (typeof s.sessionId !== 'string' || s.origin === 'subagent' || s.formatStatus === 'migration-required') return []
          const v = object(object(s.projections).values),
            selection = object(v.modelSelection),
            route = object(selection.next ?? selection.lastUsed)
          return [
            {
              id: s.sessionId,
              title: text(v.title) ?? 'DSH 会话',
              cwd: text(s.cwd),
              running: s.running === true,
              updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : undefined,
              model: text(route.model),
              provider: text(route.provider),
              reasoningEffort: text(route.reasoningEffort),
              agentPreset: text(v.agentPreset),
            },
          ]
        })
    },
    async createSession({ workspaceId, cwd, agentPreset, title, model, provider }) {
      return withPeer(async (p) => {
        const request = { workspaceId, cwd, agentPreset }
        if (cwd && !workspaceId) {
          request.workspaceId = workspace.parse(object(await p.rpc('workspace/create', { request: { path: cwd } })).workspace).workspaceId
          delete request.cwd
        }
        const sessionId = z
          .string()
          .min(1)
          .parse(object(await p.rpc('session/create', { request })).sessionId)
        if (title) await p.rpc('session/rename', { request: { sessionId, title } })
        if (model && provider) await p.rpc('session/selectModel', { request: { sessionId, model, provider } })
        return { sessionId }
      })
    },
    async readMessages(sessionId) {
      return withPeer(async (p) => {
        await watch(sessionId)
        return page(await p.rpc('session/page', { request: { address: { kind: 'session', sessionId }, maxMessages: 50 } }))
      })
    },
    async send(input) {
      const content = blocks(input)
      const requestId = input.requestId ?? randomUUID()
      await withPeer(async (p) => {
        await watch(input.sessionId)
        await p.rpc('session/prompt', {
          request: { sessionId: input.sessionId, requestId, mode: 'queue', content },
        })
      })
    },
    async stop(sessionId) {
      await withPeer((p) => p.rpc('session/cancel', { request: { sessionId } }))
    },
    async models(sessionId) {
      return withPeer(async (p) => {
        const catalog = object(await p.rpc('session/modelCatalog'))
        const selection = sessionId
          ? object(object(object(await p.rpc('session/projections', { request: { sessionId } })).values).modelSelection)
          : {}
        const route = object(selection.next ?? selection.lastUsed ?? catalog.default)
        return {
          models: list(catalog.groups)
            .map(object)
            .flatMap((g) =>
              list(g.models)
                .map(object)
                .flatMap((m) =>
                  typeof m.id === 'string'
                    ? [
                        {
                          id: m.id,
                          label: text(m.name) ?? m.id,
                          provider: text(g.id),
                          reasoningEfforts: list(object(m.reasoning).efforts)
                            .map((s) => text(object(s).id))
                            .filter((s): s is string => !!s),
                        },
                      ]
                    : [],
                ),
            ),
          currentModel: text(route.model),
          currentProvider: text(route.provider),
          currentReasoningEffort: text(route.reasoningEffort),
        }
      })
    },
    setModel,
  }
}
