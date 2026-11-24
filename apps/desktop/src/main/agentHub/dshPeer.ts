import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { z } from 'zod'
import { codedError } from '../lib/codedError'
import type { DesktopListener } from './dshDiscovery'

const error = () => codedError('E_DSH_DISCONNECTED', 'DSH 连接已断开，请重新连接桌面端')
const MAX_REPLY = 16 * 1024 * 1024
const reply = z.object({
  type: z.literal('server-response'),
  rpcId: z.string(),
  result: z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.unknown() }), z.object({ ok: z.literal(false) })]),
})
interface Stream {
  onItem: (item: unknown) => void
  onEnd: (reason: Error) => void
}

/** Calls and streams share one independent API Peer. Never attach the browser cookie or follow redirects. */
export async function pairDesktop(raw: string | undefined, listeners: DesktopListener[], lifetime: AbortSignal) {
  if (!raw) throw codedError('E_DSH_PAIRING_REQUIRED', '已发现桌面端，请提供 DSH 的本机配对地址')
  const token = /^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):\d{1,5}\/\?token=([\w-]{1,512})$/.exec(raw)?.[1]
  if (!token) throw codedError('E_DSH_PAIRING_URL', '请使用桌面端提供的本机配对地址')
  // Always dial the enumerated numeric loopback, even for a printed localhost URL.
  const target = new URL(raw)
  const owner = listeners.find(
    ({ origin }) => origin === target.origin || (target.hostname === 'localhost' && origin === `http://127.0.0.1:${target.port}`),
  )
  if (!owner) throw codedError('E_DSH_PAIRING_URL', '配对地址不属于正在运行的 DSH 桌面端')
  const { origin } = owner
  const local = new AbortController(),
    signal = AbortSignal.any([lifetime, local.signal])
  const expired = () => AbortSignal.any([signal, AbortSignal.timeout(15000)])
  const res = await fetch(`${origin}/connect?token=${token}&interactions=none`, { signal: expired(), redirect: 'manual' }).catch(() => {
    throw error()
  })
  await res.body?.cancel()
  const location = res.headers.get('location'),
    cookie = res.headers
      .getSetCookie()
      .map((s) => s.split(';')[0])
      .find((s) => /^dsh-auth-[\w-]+=v2\.[\w-]+\.[\w-]+$/.test(s ?? ''))
  if (
    res.status !== 302 ||
    !location ||
    !URL.canParse(location, origin) ||
    new URL(location, origin).href !== origin + '/api/remote.mux' ||
    !cookie
  )
    throw codedError('E_DSH_PAIRING_REJECTED', '配对未获授权，请重新获取桌面端配对地址')
  signal.throwIfAborted()
  const socket = new WebSocket(origin.replace(/^http:/, 'ws:') + '/api/remote.mux', {
    headers: { cookie, origin },
    handshakeTimeout: 10000,
    followRedirects: false,
    maxPayload: MAX_REPLY,
    perMessageDeflate: false,
  })
  const streams = new Map<string, Stream>()
  const close = () => {
    if (!local.signal.aborted) local.abort()
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
  }
  socket.on('error', close)
  signal.addEventListener('abort', close, { once: true })
  socket.once('close', () => {
    local.abort()
    for (const stream of streams.values()) stream.onEnd(error())
    streams.clear()
  })
  socket.on('message', (data, binary) => {
    try {
      if (binary) throw error()
      const frame = JSON.parse(data.toString()) as { type: string; streamId: string; value?: unknown }
      const stream = streams.get(frame.streamId)
      if (!stream) return
      if (frame.type === 'item') stream.onItem(frame.value)
      else {
        streams.delete(frame.streamId)
        stream.onEnd(error())
      }
    } catch {
      close()
    }
  })
  await new Promise<void>((resolve, reject) => {
    const fail = () => reject(error())
    socket.once('close', fail)
    socket.once('open', () => {
      socket.off('close', fail)
      resolve()
    })
  })
  return {
    get connected() {
      return !signal.aborted && socket.readyState === WebSocket.OPEN
    },
    close,
    async rpc(method: string, args: object = {}) {
      const rpcId = randomUUID(),
        deadline = expired()
      const response = await fetch(`${origin}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
        signal: deadline,
        redirect: 'error',
      }).catch(() => {
        throw error()
      })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        if (response.status === 401 || response.status === 403) close()
        throw error()
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = []
      let length = 0
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.length
        if (length > MAX_REPLY) {
          await reader.cancel()
          throw error()
        }
        chunks.push(part.value)
      }
      const frame = reply.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (frame.rpcId !== rpcId || !frame.result.ok) throw codedError('E_DSH_RPC', 'DSH 没有接受这个请求，请检查会话、模型及桌面端状态')
      return frame.result.value
    },
    async follow(endpoint: string, args: object, onItem: Stream['onItem'], onEnd: Stream['onEnd']) {
      signal.throwIfAborted()
      const streamId = randomUUID()
      const cancel = () => {
        if (streams.delete(streamId) && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId }))
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(error()), 10000)
          streams.set(streamId, {
            onItem(item) {
              clearTimeout(timer)
              try {
                onItem(item)
                resolve()
              } catch {
                reject(error())
                cancel()
                onEnd(error())
              }
            },
            onEnd(reason) {
              clearTimeout(timer)
              reject(reason)
              onEnd(reason)
            },
          })
          socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
        })
        return cancel
      } catch (reason) {
        cancel()
        throw reason
      }
    },
  }
}
