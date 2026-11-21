import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forwardJsonRpcLine } from './mossstudio-mcp-stdio.mjs'

const env = { MOSSSTUDIO_MCP_URL: 'http://127.0.0.1:4321/mcp', MOSSSTUDIO_MCP_TOKEN: 'test-token' }

test('forwards with a bounded signal and propagates cancellation', async () => {
  const controller = new AbortController()
  let requestSignal
  const result = forwardJsonRpcLine(
    '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    env,
    async (_url, options) => {
      requestSignal = options.signal
      controller.abort()
      options.signal.throwIfAborted()
    },
    controller.signal,
  )
  assert.equal((await result).error.code, -32002)
  assert.equal(requestSignal.aborted, true)
})

test('independent calls do not wait for a slow request', async () => {
  let release
  const slow = forwardJsonRpcLine(
    '{"id":1,"method":"tools/call"}',
    env,
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const fast = await forwardJsonRpcLine('{"id":2,"method":"ping"}', env, async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal)
    return { status: 200, text: async () => '{"id":2,"result":{}}' }
  })
  assert.equal(fast.id, 2)
  release({ status: 200, text: async () => '{"id":1,"result":{}}' })
  assert.equal((await slow).id, 1)
})
