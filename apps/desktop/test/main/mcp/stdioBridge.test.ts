import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { createMainCapabilityDispatcher } from '../../../src/main/capabilities'
import { createMcpServer } from '../../../src/main/mcp/server'
import { useTempDataRoot } from '../../helpers/tempDir'

const root = useTempDataRoot()
const file = () => join(root(), 'mcp-server.json')
const script = new URL('../../../../../tools/mcp/mossstudio-mcp-stdio.mjs', import.meta.url)
const direct = { MOSSSTUDIO_MCP_URL: 'http://127.0.0.1:50101/mcp', MOSSSTUDIO_MCP_TOKEN: 'test-token-first-endpoint' }
const pin = () => ({ MOSSSTUDIO_MCP_DISCOVERY: file() })
const line = (method: string, id?: string | number, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', method, id, params })
const changes = ['prompts', 'resources', 'tools'].map((name) => ({ jsonrpc: '2.0', method: `notifications/${name}/list_changed` }))
const capabilities = { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } }
interface Packet {
  jsonrpc: string
  id?: string | number
  method?: string
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}
interface Bridge {
  handleLine(input: string): Promise<void>
  close(): Promise<unknown>
}
const {
  createBridge,
  forwardJsonRpcLine,
}: {
  createBridge(options: { env: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; write(packet: Packet): void }): Bridge
  forwardJsonRpcLine(input: string, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<Packet | null>
} = await import(script.href)

function serve(readFlags = () => ({})) {
  return createMcpServer({ discoveryPath: file(), dispatcher: createMainCapabilityDispatcher({ mainHandlers: {}, readFlags }) })
}
async function expectChanges(packets: Packet[]) {
  await vi.waitFor(() => expect(packets).toHaveLength(3), { timeout: 4000 })
  expect(packets.splice(0)).toEqual(expect.arrayContaining(changes))
}

it('keeps the stdio session alive from offline initialize through the first real tool list, then exits on EOF', async () => {
  const child = spawn(process.execPath, [fileURLToPath(script)], {
    env: { ...process.env, ...pin(), MOSSSTUDIO_MCP_URL: '', MOSSSTUDIO_MCP_TOKEN: '' },
    windowsHide: true,
  })
  const exited = once(child, 'exit')
  const packets: Packet[] = []
  createInterface({ input: child.stdout }).on('line', (text) => packets.push(JSON.parse(text)))
  const send = (method: string, id?: string | number, params?: unknown) => child.stdin.write(line(method, id, params) + '\n')
  const request = async (method: string, id: string | number, params?: unknown) => {
    send(method, id, params)
    await vi.waitFor(() => expect(packets[0]?.id).toBe(id))
    return packets.shift()!
  }
  let server: Awaited<ReturnType<typeof serve>> | undefined
  try {
    expect(await request('initialize', 0, { protocolVersion: '2025-06-18' })).toMatchObject({
      jsonrpc: '2.0',
      result: { protocolVersion: '2025-06-18', capabilities, serverInfo: { name: expect.any(String), version: expect.any(String) } },
    })
    send('notifications/initialized')
    for (const [method, result] of Object.entries({
      ping: {},
      'tools/list': { tools: [] },
      'resources/list': { resources: [] },
      'resources/templates/list': { resourceTemplates: [] },
      'prompts/list': { prompts: [] },
    }))
      expect(await request(method, method)).toEqual({ jsonrpc: '2.0', id: method, result })
    expect(await request('tools/call', 'write')).toMatchObject({ id: 'write', error: { message: expect.stringMatching(/launch|start/i) } })
    server = await serve()
    await expectChanges(packets)
    const actual = await request('tools/list', 'live')
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}` },
      body: line('tools/list', 'live'),
    })
    expect(actual).toEqual(await response.json())
    expect(actual.result!.tools).toContainEqual(expect.objectContaining({ name: 'models__catalog__installed' }))
    child.stdin.end()
    await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 2000 })
  } finally {
    if (child.exitCode === null) child.kill()
    await exited
    await server?.stop()
  }
}, 10000)

it('notifies on replacement, profile, live feature flags and loss of reachability even with stale discovery', async () => {
  let remoteHostsEnabled = false
  let server: Awaited<ReturnType<typeof serve>> | undefined
  const packets: Packet[] = []
  const bridge = createBridge({ env: pin(), write: (packet) => packets.push(packet) })
  const ask = async (method: string) => {
    await bridge.handleLine(line(method, 0))
    return packets.pop()
  }
  try {
    await ask('initialize')
    await bridge.handleLine(line('notifications/initialized'))
    server = await serve(() => ({ remoteHostsEnabled }))
    await expectChanges(packets)
    const online = await forwardJsonRpcLine(line('initialize', 0), pin())
    expect(online?.result).toMatchObject({ capabilities, instructions: expect.stringContaining('MossStudio') })
    const first = server
    const oldFile = await readFile(file(), 'utf8')
    await first.stop()
    server = await serve(() => ({ remoteHostsEnabled }))
    expect(server.url).not.toBe(first.url)
    expect(server.token).not.toBe(first.token)
    await expectChanges(packets)
    expect((await ask('tools/list'))?.result?.tools).toContainEqual(expect.objectContaining({ name: 'models__catalog__installed' }))
    server.setProfile('atomic')
    await expectChanges(packets)
    const snapshot = await readFile(file(), 'utf8')
    remoteHostsEnabled = true
    await expectChanges(packets)
    expect(await readFile(file(), 'utf8')).toBe(snapshot)
    expect((await ask('tools/list'))?.result?.tools).toContainEqual(expect.objectContaining({ name: 'remote__hosts__list' }))
    await server.stop()
    await writeFile(file(), oldFile)
    await expectChanges(packets)
    expect(await ask('tools/list')).toEqual({ jsonrpc: '2.0', id: 0, result: { tools: [] } })
    expect(await ask('ping')).toMatchObject({ result: {} })
    expect(await ask('initialize')).toMatchObject({ result: { capabilities } })
  } finally {
    await bridge.close()
    await server?.stop()
  }
}, 16000)

it('notifies if the server that answered initialize stops before the first health check', async () => {
  const server = await serve()
  const packets: Packet[] = []
  const bridge = createBridge({ env: pin(), write: (packet) => packets.push(packet) })
  try {
    await bridge.handleLine(line('initialize', 1))
    expect(packets.pop()?.result?.instructions).toEqual(expect.stringContaining('MossStudio'))
    await server.stop()
    await bridge.handleLine(line('notifications/initialized'))
    await expectChanges(packets)
  } finally {
    await bridge.close()
    await server.stop()
  }
})

it.each(['401', 'non-rpc', 'connection refused'])('rereads the pinned file once after %s during a list request', async (failure) => {
  const old = { url: direct.MOSSSTUDIO_MCP_URL, token: direct.MOSSSTUDIO_MCP_TOKEN }
  const fresh = { url: 'http://127.0.0.1:50102/mcp', token: 'test-token-second-endpoint' }
  await writeFile(file(), JSON.stringify(old))
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === old.url) {
      await writeFile(file(), JSON.stringify(fresh))
      if (failure === 'connection refused') throw new TypeError('fetch failed')
      return failure === '401' ? Response.json({ error: 'Unauthorized' }, { status: 401 }) : Response.json({})
    }
    expect([String(url), new Headers(init?.headers).get('authorization')]).toEqual([fresh.url, `Bearer ${fresh.token}`])
    return Response.json({ jsonrpc: '2.0', id: 'list', result: { tools: [{ name: 'fresh' }] } })
  })
  expect(await forwardJsonRpcLine(line('tools/list', 'list'), pin(), fetchImpl)).toEqual({
    jsonrpc: '2.0',
    id: 'list',
    result: { tools: [{ name: 'fresh' }] },
  })
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})

it.each(['401', 'non-rpc'])('preserves the %s list error when discovery vanishes before the retry', async (failure) => {
  await writeFile(file(), JSON.stringify({ url: direct.MOSSSTUDIO_MCP_URL, token: direct.MOSSSTUDIO_MCP_TOKEN }))
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    await rm(file())
    return failure === '401' ? new Response(null, { status: 401 }) : Response.json({})
  })
  expect(await forwardJsonRpcLine(line('resources/list', 'res'), pin(), fetchImpl)).toEqual({
    jsonrpc: '2.0',
    id: 'res',
    error: { code: expect.any(Number), message: expect.any(String) },
  })
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it.each(['initialize', 'ping', 'tools/call', 'resources/read', 'prompts/get'])(
  'does not retry %s when the pinned endpoint rejects the request',
  async (method) => {
    await writeFile(file(), JSON.stringify({ url: direct.MOSSSTUDIO_MCP_URL, token: direct.MOSSSTUDIO_MCP_TOKEN }))
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }))
    expect(await forwardJsonRpcLine(line(method, 0), pin(), fetchImpl)).toEqual({
      jsonrpc: '2.0',
      id: 0,
      error: { code: expect.any(Number), message: expect.stringContaining('401') },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  },
)

it.each([
  ['unauthorized', () => Response.json({ error: 'Unauthorized' }, { status: 401 })],
  ['HTTP error with a success envelope', () => Response.json({ jsonrpc: '2.0', id: 'original', result: {} }, { status: 500 })],
  ['HTML', () => new Response('<html>Offline</html>')],
  ['empty 202', () => new Response(null, { status: 202 })],
  ['empty 204', () => new Response(null, { status: 204 })],
  ['wrong ID', () => Response.json({ jsonrpc: '2.0', id: 1, result: {} })],
  ['invalid error', () => Response.json({ jsonrpc: '2.0', id: 'original', error: 'unauthorized' })],
  ['ambiguous envelope', () => Response.json({ jsonrpc: '2.0', id: 'original', result: {}, error: { code: -1, message: 'bad' } })],
  [
    'connection lost',
    () => {
      throw new TypeError('fetch failed')
    },
  ],
] as const)(
  'returns a correlated error for %s without ever replaying a tool call or replying to a notification',
  async (failure, response) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response())
    const packet = await forwardJsonRpcLine(line('tools/call', 'original', { name: 'create' }), direct, fetchImpl)
    expect(packet).toEqual({ jsonrpc: '2.0', id: 'original', error: { code: expect.any(Number), message: expect.any(String) } })
    if (failure === 'unauthorized') expect(packet?.error?.message).toContain('401')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(await forwardJsonRpcLine(line('notifications/initialized'), direct, fetchImpl)).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  },
)

it('does not retain completed requests for cancellation on EOF', async () => {
  const signals: AbortSignal[] = []
  const fetchImpl: typeof fetch = async (_url, options) => {
    signals.push(options!.signal!)
    return Response.json({ jsonrpc: '2.0', id: 1, result: {} })
  }
  const bridge = createBridge({ env: direct, fetchImpl, write: vi.fn() })
  const lateAbort = vi.fn()
  try {
    for (let i = 0; i < 20; i++) await bridge.handleLine(line('tools/call', 1))
    for (const signal of signals) signal.addEventListener('abort', lateAbort)
  } finally {
    await bridge.close()
  }
  expect(signals).toHaveLength(20)
  expect(lateAbort).not.toHaveBeenCalled()
})

it('never monitors before initialized or after close, aborts an outstanding probe and never creates a second timer', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
  let probe: AbortSignal | null | undefined
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.body) return new Response(null, { status: 202 })
    probe = init?.signal
    return new Promise((_resolve, reject) => probe?.addEventListener('abort', () => reject(new Error('closed'))))
  })
  const write = vi.fn()
  const bridge = createBridge({ env: direct, fetchImpl, write })
  try {
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchImpl).not.toHaveBeenCalled()
    const init = bridge.handleLine(line('notifications/initialized'))
    await vi.advanceTimersByTimeAsync(6000)
    const duplicate = bridge.handleLine(line('notifications/initialized'))
    await vi.advanceTimersByTimeAsync(6000)
    expect(fetchImpl.mock.calls.filter(([, options]) => !options?.body)).toHaveLength(1)
    expect(probe?.aborted).toBe(false)
    await bridge.close()
    await Promise.all([init, duplicate])
    expect(probe?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    const calls = fetchImpl.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchImpl).toHaveBeenCalledTimes(calls)
    expect(write).not.toHaveBeenCalled()
  } finally {
    await bridge.close()
    vi.useRealTimers()
  }
})

it('does not escape an explicit discovery pin, even if a different file and direct endpoint are available', async () => {
  const server = await serve()
  const missing = join(root(), 'absent.json')
  const env = {
    MOSSSTUDIO_MCP_DISCOVERY: missing,
    MOSSSTUDIO_DATA_ROOT: root(),
    MOSSSTUDIO_MCP_URL: server.url,
    MOSSSTUDIO_MCP_TOKEN: server.token,
  }
  const fetchImpl = vi.fn(fetch)
  const write = vi.fn()
  const bridge = createBridge({ env, fetchImpl, write })
  try {
    await bridge.handleLine(line('notifications/initialized'))
    await bridge.handleLine(line('tools/list', 1))
    expect(write).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(env.MOSSSTUDIO_MCP_DISCOVERY).toBe(missing)
  } finally {
    await bridge.close()
    await server.stop()
  }
})

it('sticks with the discovery file already selected by default resolution while it is absent', async () => {
  const env = { MOSSSTUDIO_DATA_ROOT: root(), MOSSSTUDIO_DATA: join(root(), 'other') }
  const server = await serve()
  const fetchImpl = vi.fn(fetch)
  const write = vi.fn()
  const bridge = createBridge({ env, fetchImpl, write })
  try {
    await bridge.handleLine(line('tools/list', 0))
    expect(write.mock.lastCall?.[0].result.tools.length).toBeGreaterThan(0)
    const other = await createMcpServer({ discoveryPath: join(env.MOSSSTUDIO_DATA, 'mcp-server.json') })
    try {
      await rm(file())
      fetchImpl.mockClear()
      await bridge.handleLine(line('tools/list', 1))
      expect(write.mock.lastCall?.[0]).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      await other.stop()
    }
  } finally {
    await bridge.close()
    await server.stop()
  }
})
