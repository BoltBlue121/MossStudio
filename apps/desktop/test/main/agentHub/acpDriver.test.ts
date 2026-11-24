import { describe, expect, it } from 'vitest'
import type { AgentHubEvent } from '@shared/agentHub'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAcpDriver, resolveAcpLaunch } from '../../../src/main/agentHub/acpDriver'

const script = `
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const req = JSON.parse(line);
 if(req.method==='initialize') send({jsonrpc:'2.0',id:req.id,result:{protocolVersion:1,agentCapabilities:{mcpCapabilities:{http:true}}}});
 if(req.method==='session/new') {
  const mcp=req.params.mcpServers[0];
  if(mcp.url!=='http://127.0.0.1:1234/mcp'||mcp.headers[0].value!=='Bearer test-token') process.exit(3);
  send({jsonrpc:'2.0',id:req.id,result:{sessionId:'mock-session',models:{availableModels:[{modelId:'m1',name:'Model One'},{modelId:'m2',name:'Model Two'}],currentModelId:'m1'}}});
 }
 if(req.method==='session/set_model') send({jsonrpc:'2.0',id:req.id,result:{}});
 if(req.method==='session/prompt') {
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'mock-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Hello'}}}});
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'mock-session',update:{sessionUpdate:'tool_call',toolCallId:'t1',title:'Read',status:'in_progress'}}});
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'mock-session',update:{sessionUpdate:'tool_call_update',toolCallId:'t1',status:'completed'}}});
  send({jsonrpc:'2.0',id:req.id,result:{stopReason:'end_turn'}});
 }
});`

describe('ACP stdio driver', () => {
  it('resolves npm cmd shims without invoking a shell', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'acp-shim-'))
    try {
      const cmd = join(directory, 'agent.cmd')
      const entry = join(directory, 'entry.mjs')
      await writeFile(entry, '')
      await writeFile(
        cmd,
        String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\entry.mjs" %*`,
      )
      const launch = await resolveAcpLaunch(cmd, ['hello & calc'], 'win32')
      expect(launch.command).toBe(process.execPath)
      expect(launch.args).toEqual([entry, 'hello & calc'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('handshakes, injects MCP, streams, stores history and cleans up', async () => {
    const events: AgentHubEvent[] = []
    const driver = createAcpDriver({
      id: 'custom-acp',
      label: 'Test',
      emit: (event) => events.push(event),
      getMcpState: () => ({
        running: true,
        url: 'http://127.0.0.1:1234/mcp',
        token: 'test-token',
        stdioBridgePath: '/bridge.mjs',
        discoveryPath: '/discovery.json',
      }),
    })
    try {
      expect((await driver.connect({ backendId: driver.id, customCommand: process.execPath, customArgs: ['-e', script] })).connected).toBe(
        true,
      )
      const { sessionId } = await driver.createSession({ backendId: driver.id, cwd: process.cwd() })
      expect((await driver.models(sessionId)).currentModel).toBe('m1')
      expect((await driver.models(sessionId)).models).toHaveLength(2)
      await driver.setModel({ backendId: driver.id, sessionId, model: 'm2' })
      expect((await driver.models(sessionId)).currentModel).toBe('m2')
      await driver.send({
        backendId: driver.id,
        sessionId,
        text: 'Hi',
        attachments: [{ name: 'ref.png', mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
      })
      const deadline = Date.now() + 5000
      while (!events.some((event) => event.type === 'done') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['delta', 'tool-start', 'tool-end', 'done']))
      expect((await driver.readMessages(sessionId)).messages.map((message) => message.text)).toEqual(['Hi', 'Hello'])
    } finally {
      await driver.disconnect()
    }
    expect((await driver.probe()).connected).toBe(false)
    await expect(driver.listSessions()).resolves.toEqual([])
  })
})
