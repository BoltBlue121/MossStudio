import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'

const readImageHeader = vi.hoisted(() => vi.fn())
vi.mock('@main/services/imageHeaders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/services/imageHeaders')>()
  readImageHeader.mockImplementation(actual.readImageHeader)
  return { ...actual, readImageHeader }
})
import { createDshDriver } from '@main/agentHub/dshDriver'
import { createAgentHub } from '@main/agentHub/hub'
import type { AgentHubEvent } from '@shared/agentHub'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const sessionId = 'session-demo'
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR42mNkYPjPwMDAxMDAgKAAEkIBBUEppJMAAAAASUVORK5CYII='
async function desktop() {
  const rpc: Array<{ method: string; args: Record<string, unknown> }> = []
  const mux = new WebSocketServer({ noServer: true })
  const follows = new Map<string, (frame: unknown) => void>()
  const cookie = 'dsh-auth-demo=v2.fake_peer.fake_signature'
  const server = createServer((req, res) => {
    void (async () => {
      if (req.url === '/connect?token=operator_demo&interactions=none') {
        res.writeHead(302, { Location: '/api/remote.mux', 'Set-Cookie': cookie + '; HttpOnly; Path=/' }).end()
        return
      }
      if (req.headers.cookie !== cookie) {
        res.writeHead(401).end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const { type, rpcId, method, payload } = JSON.parse(Buffer.concat(chunks).toString())
      if (req.url !== `/api/${method}` || type !== 'client-request') {
        res.writeHead(400).end()
        return
      }
      rpc.push({ method, args: payload.args })
      const value =
        method === 'workspace/create'
          ? { workspace: { workspaceId: 'work-B', title: 'Created', path: payload.args.request.path, sessionIds: [] } }
          : method === 'session/list'
            ? { items: [{ sessionId, cwd: '/work', projections: { values: { title: 'Poster' } } }] }
            : method === 'session/create'
              ? { sessionId }
              : method === 'session/page'
                ? {
                    records: [
                      {
                        type: 'event',
                        event: {
                          type: 'assistant/message',
                          seq: 5,
                          data: {
                            message: {
                              content: [
                                { type: 'text', text: 'history' },
                                { type: 'image', mediaType: 'image/png', data: image },
                                { type: 'image', mediaType: 'image/svg+xml', data: 'AAAA' },
                              ],
                            },
                          },
                        },
                      },
                    ],
                    cursor: 5,
                    hasMore: false,
                  }
                : { accepted: true }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }))
    })().catch(() => res.destroy())
  })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/api/remote.mux' || req.headers.cookie !== cookie) {
      socket.destroy()
      return
    }
    mux.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (raw) => {
        const { type, streamId, endpoint, payload } = JSON.parse(raw.toString())
        if (type !== 'open') return
        const item = (value: unknown) => ws.send(JSON.stringify({ type: 'item', streamId, value }))
        if (endpoint === 'workspace/follow')
          item({
            type: 'baseline',
            value: {
              items: [
                { workspaceId: 'work-A', title: 'A', path: '/work', sessionIds: [sessionId] },
                { workspaceId: 'work-empty', title: 'Empty', path: '/empty', sessionIds: [] },
              ],
            },
          })
        if (endpoint === 'session/follow' && payload.args.request.address.sessionId === sessionId && payload.args.request.assistantStream) {
          follows.set(sessionId, item)
          item({ type: 'snapshot', records: [], cursor: 5 })
        }
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  let closed = false
  const closeServer = async () => {
    if (closed) return
    closed = true
    for (const ws of mux.clients) ws.terminate()
    mux.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  cleanup.push(closeServer)
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const events: AgentHubEvent[] = []
  const driver = createDshDriver(
    (event) => events.push(event),
    async () => [{ origin, pid: 101 }],
  )
  cleanup.push(() => driver.disconnect())
  return { driver, hub: createAgentHub([driver]), pairingUrl: origin + '/?token=operator_demo', events, rpc, follows, closeServer }
}

describe('DSH Desktop native Agent', () => {
  it('discovers without authenticating or reading a session and prefers the available native driver', async () => {
    const { hub, rpc, driver } = await desktop()
    expect(await hub.backends()).toMatchObject([{ id: 'dsh-desktop', preferred: true, available: true, connected: false }])
    await expect(driver.listSessions()).rejects.toThrow()
    expect(rpc).toEqual([])
  })
  it('pairs only with the verified loopback owner; a foreign launch token or closed connection cannot send prompts', async () => {
    const { driver, pairingUrl, rpc } = await desktop()
    for (const url of ['https://remote.invalid/?token=secret', 'http://127.0.0.1:1/?token=secret', pairingUrl.replace('/?', '/other?')]) {
      await expect(driver.connect({ backendId: driver.id, pairingUrl: url })).rejects.toThrow()
    }
    await driver.connect({ backendId: driver.id, pairingUrl })
    await driver.disconnect()
    await expect(driver.send({ backendId: driver.id, sessionId, text: 'hey' })).rejects.toThrow()
    expect(rpc).toEqual([])
  })
  it('round trips projects including empty ones, sessions, history, native image blocks and real mux text deltas', async () => {
    const { hub, driver, pairingUrl, rpc, follows, events } = await desktop()
    const backendId = driver.id
    expect(await hub.connect({ backendId, pairingUrl })).toMatchObject({ connected: true })
    expect(await hub.projects(backendId)).toEqual([
      { id: 'work-A', title: 'A', cwd: '/work', sessionIds: [sessionId] },
      { id: 'work-empty', title: 'Empty', cwd: '/empty', sessionIds: [] },
    ])
    expect(await hub.sessions(backendId)).toMatchObject([{ id: sessionId, cwd: '/work', title: 'Poster' }])
    expect(await hub.createSession({ backendId, workspaceId: 'work-A', title: 'Poster' })).toEqual({ sessionId })
    expect(rpc).toContainEqual({ method: 'session/create', args: { request: { workspaceId: 'work-A' } } })
    await driver.createSession({ backendId, cwd: '/choice' })
    expect(rpc).toContainEqual({ method: 'workspace/create', args: { request: { path: '/choice' } } })
    expect(rpc.at(-1)).toEqual({ method: 'session/create', args: { request: { workspaceId: 'work-B' } } })
    expect(await hub.messages(backendId, sessionId)).toMatchObject({
      messages: [{ role: 'assistant', text: 'history', images: [`data:image/png;base64,${image}`] }],
      asOfSeq: 5,
    })
    // A poll that repeats the history does not decode its pictures again.
    const decoded = readImageHeader.mock.calls.length
    expect((await hub.messages(backendId, sessionId)).messages[0]?.images).toEqual([`data:image/png;base64,${image}`])
    expect(readImageHeader.mock.calls.length).toBe(decoded)
    expect(events).toEqual([])
    await hub.send({
      backendId,
      sessionId,
      text: 'Edit',
      requestId: 'req1',
      attachments: [{ name: '图.png', mime: 'image/png', dataUrl: 'data:image/png;base64,' + image }],
    })
    expect(rpc.at(-1)).toMatchObject({
      method: 'session/prompt',
      args: {
        request: {
          requestId: 'req1',
          content: [
            { type: 'text', text: 'Edit' },
            { type: 'image', name: '图.png', mediaType: 'image/png', data: image },
          ],
        },
      },
    })
    const push = follows.get(sessionId)!
    push({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'Hi' } } })
    push({ type: 'event', event: { type: 'turn/end', seq: 7, data: { outcome: 'completed' } } })
    await vi.waitFor(() =>
      expect(events.filter((e) => e.type === 'delta' || e.type === 'done')).toEqual([
        { backendId, sessionId, type: 'delta', text: 'Hi' },
        { backendId, sessionId, type: 'done' },
      ]),
    )
    await hub.stop(backendId, sessionId)
    expect(rpc.at(-1)).toEqual({ method: 'session/cancel', args: { request: { sessionId } } })
  })

  it('auto-reconnects to a restarted DSH Desktop via loopback discovery and stops after manual disconnect', async () => {
    const first = await desktop()
    const second = await desktop()
    let active = first
    const driver = createDshDriver(
      () => undefined,
      async () => [{ origin: new URL(active.pairingUrl).origin, pid: 101 }],
      async () => active.pairingUrl,
    )
    cleanup.push(() => driver.disconnect())

    expect(await driver.connect({ backendId: driver.id })).toMatchObject({ connected: true })
    expect(await driver.listSessions()).toHaveLength(1)

    // First Desktop shuts down and a restarted instance listens on another loopback port.
    active = second
    await first.closeServer()
    expect(await driver.listSessions()).toHaveLength(1)
    expect(second.rpc).toContainEqual({ method: 'session/list', args: { _request: {} } })

    // Once DSH is gone, failed polls look for it again at most every 10 seconds.
    let scans = 0
    const gone = createDshDriver(
      () => undefined,
      async () => (scans++ ? [] : [{ origin: new URL(second.pairingUrl).origin, pid: 101 }]),
      async () => second.pairingUrl,
    )
    cleanup.push(() => gone.disconnect())
    await gone.connect({ backendId: gone.id })
    await second.closeServer()
    await expect(gone.listSessions()).rejects.toThrow()
    await expect(gone.listSessions()).rejects.toThrow()
    expect(scans).toBe(2)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 11_000)
    await expect(gone.listSessions()).rejects.toThrow()
    expect(scans).toBe(3)
    clock.mockRestore()

    // Manual disconnect turns auto-reconnect off.
    await driver.disconnect()
    await expect(driver.listSessions()).rejects.toThrow()
  })
})
