import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { paths } from '../lib/paths'

export async function resolveAcpLaunch(
  command: string,
  args: string[],
  platform: string = process.platform,
): Promise<{ command: string; args: string[] }> {
  if (platform !== 'win32') return { command, args }
  let candidate = command
  if (!existsSync(candidate)) {
    const found = await new Promise<string>((done) =>
      execFile('where.exe', [command], { timeout: 2000, windowsHide: true }, (error, stdout) => done(error ? '' : stdout)),
    )
    const matches = found.trim().split(/\r?\n/).filter(Boolean)
    candidate = matches.find((path) => /\.exe$/i.test(path)) ?? matches.find((path) => /\.cmd$/i.test(path)) ?? command
  }
  if (!/\.(?:exe|cmd)$/i.test(candidate) && existsSync(`${candidate}.cmd`)) candidate += '.cmd'
  if (!/\.cmd$/i.test(candidate)) return { command: candidate, args }
  const contents = readFileSync(candidate, 'utf8')
  const match = /"%dp0%[\\/]([^"\r\n%]+\.(?:js|mjs|cjs))"/i.exec(contents)
  if (!match) throw new Error('此 Windows 命令不是可安全启动的 Node.js shim，请填写脚本入口。')
  const script = resolve(dirname(candidate), match[1]!.replace(/\\/g, '/'))
  if (!existsSync(script)) throw new Error('Agent 的脚本入口不存在，请重新安装命令。')
  const localNode = resolve(dirname(candidate), 'node.exe')
  return { command: existsSync(localNode) ? localNode : process.execPath, args: [script, ...args] }
}
import type {
  AgentBackendInfo,
  AgentDriver,
  AgentHubEvent,
  AgentMessagePage,
  AgentModels,
  AgentSendInput,
  AgentSession,
  AgentSetModelInput,
} from '@shared/agentHub'
import { getMcpServerState } from '../mcp'
function attachmentSummary(input: AgentSendInput): string {
  return [input.text, ...(input.attachments ?? []).map((file) => `${file.name} (${file.mime})${file.path ? `: ${file.path}` : ''}`)].join(
    '\n',
  )
}

const probes = new Map<string, { expires: number; result: Promise<boolean> }>()
export function clearAcpProbeCache(): void {
  probes.clear()
}
export function probeAcpCommand(command: string): Promise<boolean> {
  const cached = probes.get(command)
  if (cached && cached.expires > Date.now()) return cached.result
  const result = new Promise<boolean>((resolve) => {
    execFile(process.platform === 'win32' ? 'where.exe' : 'which', [command], { timeout: 2000, windowsHide: true }, (error) =>
      resolve(!error),
    )
  }).then((found) => {
    // Never stick a stale negative cache so freshly installed ACP Agents appear immediately on refresh.
    if (!found) probes.delete(command)
    return found
  })
  probes.set(command, { expires: Date.now() + 30_000, result })
  return result
}
function buildAcpPromptBlocks(input: AgentSendInput, bodyText: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: bodyText }]
  for (const attachment of input.attachments ?? []) {
    if (attachment.dataUrl) {
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(attachment.dataUrl)
      if (match) {
        const mimeType = match[1] || attachment.mime || 'image/png'
        const data = match[2]!
        try {
          const dir = paths.collabAttachments()
          mkdirSync(dir, { recursive: true })
          const safe = attachment.name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment.png'
          const target = join(dir, `${randomUUID()}-${safe}`)
          const tmp = `${target}.tmp`
          writeFileSync(tmp, Buffer.from(data, 'base64'))
          renameSync(tmp, target)
        } catch {
          // Non-fatal: inline ACP image block still carries the full image bytes.
        }
        blocks.push({ type: 'image', data, mimeType })
      }
    } else if (attachment.path && existsSync(attachment.path)) {
      try {
        const data = readFileSync(attachment.path).toString('base64')
        blocks.push({ type: 'image', data, mimeType: attachment.mime || 'image/png' })
      } catch {
        // Text summary still includes the path.
      }
    }
  }
  return blocks
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
interface McpConnection {
  running: boolean
  url: string | null
  token: string | null
  stdioBridgePath: string
  discoveryPath: string
}

export function createAcpDriver(options: {
  id: string
  label: string
  command?: string
  emit: (event: AgentHubEvent) => void
  getMcpState?: () => McpConnection
  timeoutMs?: number
}): AgentDriver {
  let child: ChildProcessWithoutNullStreams | undefined
  let connected = false
  let httpMcp = false
  let sequence = 0
  let defaultModels: AgentModels = { models: [] }
  const modelStates = new Map<string, AgentModels>()
  const modelOptionIds = new Map<string, string>()
  const parseModels = (value: Record<string, unknown>, sessionId?: string): AgentModels => {
    const state = object(value.models)
    const available = Array.isArray(state.availableModels) ? state.availableModels : []
    const models: AgentModels = {
      models: available
        .map((item) => {
          const model = object(item)
          return { id: text(model.modelId), label: text(model.name) || text(model.modelId) }
        })
        .filter((item) => item.id),
      currentModel: text(state.currentModelId) || undefined,
    }
    const configs = Array.isArray(value.configOptions) ? value.configOptions : []
    for (const raw of configs) {
      const config = object(raw)
      if (config.category !== 'model' && config.id !== 'model') continue
      if (sessionId) modelOptionIds.set(sessionId, text(config.id))
      models.currentModel = text(config.currentValue) || models.currentModel
      if (Array.isArray(config.options))
        models.models = config.options
          .map((rawOption) => {
            const option = object(rawOption)
            return { id: text(option.value), label: text(option.name) || text(option.value) }
          })
          .filter((item) => item.id)
    }
    return models
  }
  const setModel = async (input: AgentSetModelInput): Promise<{ ok: true; model: string; provider?: string; reasoningEffort?: string }> => {
    if (input.provider || input.reasoningEffort) throw new Error('此 ACP 后端暂不支持单独选择供应商或推理强度')
    const configId = modelOptionIds.get(input.sessionId)
    await rpc(
      configId ? 'session/set_config_option' : 'session/set_model',
      configId ? { sessionId: input.sessionId, configId, value: input.model } : { sessionId: input.sessionId, modelId: input.model },
    )
    const state = modelStates.get(input.sessionId) ?? { models: [] }
    state.currentModel = input.model
    modelStates.set(input.sessionId, state)
    const session = sessions.get(input.sessionId)
    if (session) session.info.model = input.model
    return { ok: true, model: input.model }
  }
  let command = options.command
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >()
  const sessions = new Map<string, { info: AgentSession; page: AgentMessagePage; active: boolean; assistant?: number }>()
  const info = (available: boolean): AgentBackendInfo => ({
    id: options.id,
    label: options.label,
    kind: 'acp',
    connected,
    available,
    command,
  })
  const emit = (sessionId: string, event: Omit<AgentHubEvent, 'backendId' | 'sessionId'>) =>
    options.emit({ backendId: options.id, sessionId, ...event })
  const failPending = (error: Error) => {
    for (const item of pending.values()) {
      if (item.timer) clearTimeout(item.timer)
      item.reject(error)
    }
    pending.clear()
  }
  const write = (value: unknown) => {
    if (!child || child.killed || !child.stdin.writable) throw new Error('Agent 尚未连接，请先连接后端')
    child.stdin.write(`${JSON.stringify(value)}\n`)
  }
  const rpc = (method: string, params: unknown, timeoutOverrideMs?: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      const ms = timeoutOverrideMs !== undefined ? timeoutOverrideMs : (options.timeoutMs ?? 120_000)
      const timer =
        ms > 0
          ? setTimeout(() => {
              pending.delete(id)
              reject(new Error('Agent 请求超时，请重新连接'))
              void disconnect()
            }, ms)
          : undefined
      pending.set(id, { resolve, reject, timer })
      try {
        write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        if (timer) clearTimeout(timer)
        pending.delete(id)
        reject(error)
      }
    })
  const update = (params: Record<string, unknown>) => {
    const sessionId = text(params.sessionId)
    const session = sessions.get(sessionId)
    if (!session) return
    const change = object(params.update)
    const kind = text(change.sessionUpdate)
    if (kind === 'agent_message_chunk') {
      const content = object(change.content)
      if (content.type !== 'text') return
      const chunk = text(content.text)
      if (session.assistant === undefined) {
        session.assistant = session.page.messages.length
        session.page.messages.push({ seq: ++session.page.asOfSeq, role: 'assistant', text: '' })
      }
      session.page.messages[session.assistant]!.text += chunk
      emit(sessionId, { type: 'delta', text: chunk })
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      const terminal = change.status === 'completed' || change.status === 'failed'
      emit(sessionId, {
        type: terminal ? 'tool-end' : 'tool-start',
        callId: text(change.toolCallId),
        toolName: text(change.title),
        ...(terminal ? { ok: change.status === 'completed' } : {}),
      })
    } else emit(sessionId, { type: 'status', text: kind })
  }
  async function disconnect(): Promise<void> {
    connected = false
    const current = child
    child = undefined
    failPending(new Error('Agent 已断开连接'))
    sessions.clear()
    modelStates.clear()
    modelOptionIds.clear()
    if (!current || current.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        current.kill('SIGKILL')
        resolve()
      }, 3000)
      current.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      if (process.platform === 'win32' && current.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(current.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => current.kill('SIGKILL'))
      } else {
        try {
          if (current.pid) process.kill(-current.pid, 'SIGKILL')
          else current.kill('SIGKILL')
        } catch {
          current.kill('SIGKILL')
        }
      }
    })
  }
  return {
    id: options.id,
    async probe() {
      return info(command ? await probeAcpCommand(command) : true)
    },
    async connect(input) {
      await disconnect()
      command = input.customCommand ?? options.command
      if (!command) throw new Error('请填写 ACP 命令')
      const launch = await resolveAcpLaunch(command, input.customArgs ?? [])
      child = spawn(launch.command, launch.args, {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'pipe',
        windowsHide: true,
        detached: process.platform !== 'win32',
        shell: false,
      })
      const current = child
      current.stdin.on('error', () => failPending(new Error('Agent 输入通道已关闭')))
      current.stderr.resume()
      current.once('error', () => {
        connected = false
        failPending(new Error('无法启动 Agent，请检查命令是否已安装'))
      })
      current.once('close', () => {
        if (child !== current) return
        connected = false
        failPending(new Error('Agent 进程已退出'))
        for (const [sessionId, session] of sessions)
          if (session.active) {
            session.active = false
            session.info.running = false
            emit(sessionId, { type: 'error', message: 'Agent 进程已退出' })
          }
      })
      const lines = createInterface({ input: current.stdout })
      lines.on('line', (line) => {
        if (line.length > 4 * 1024 * 1024) {
          void disconnect()
          return
        }
        let message: Record<string, unknown>
        try {
          message = object(JSON.parse(line) as unknown)
        } catch {
          return
        }
        if (message.method === 'session/update') update(object(message.params))
        else if (typeof message.method === 'string' && message.id !== undefined) {
          // ACP-side permission and filesystem requests are not a bypass around Studio approval.
          write({
            jsonrpc: '2.0',
            id: message.id,
            ...(message.method === 'session/request_permission'
              ? { result: { outcome: { outcome: 'cancelled' } } }
              : { error: { code: -32601, message: 'Unsupported client method' } }),
          })
        } else if (typeof message.id === 'number') {
          const request = pending.get(message.id)
          if (!request) return
          clearTimeout(request.timer)
          pending.delete(message.id)
          if (message.error) request.reject(new Error(text(object(message.error).message) || 'Agent 请求失败'))
          else request.resolve(message.result)
        }
      })
      try {
        const result = object(
          await rpc('initialize', {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: 'mossstudio', version: app?.getVersion?.() || '2.0.1' },
          }),
        )
        defaultModels = parseModels(result)
        httpMcp = object(object(result.agentCapabilities).mcpCapabilities).http === true
        connected = true
        return info(true)
      } catch (error) {
        await disconnect()
        throw error
      }
    },
    disconnect,
    async listSessions() {
      return [...sessions.values()].map(({ info: session }) => ({ ...session }))
    },
    async createSession(input) {
      if (!connected) throw new Error('请先连接 Agent')
      const mcp = (options.getMcpState ?? (() => getMcpServerState(true)))()
      const mcpServers: unknown[] = []
      if (mcp.running && mcp.url && mcp.token) {
        mcpServers.push(
          httpMcp
            ? { type: 'http', name: 'MossStudio', url: mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }] }
            : {
                name: 'MossStudio',
                command: process.execPath,
                args: [mcp.stdioBridgePath],
                env: [
                  { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
                  { name: 'MOSSSTUDIO_MCP_DISCOVERY', value: mcp.discoveryPath },
                ],
              },
        )
      }
      const result = object(await rpc('session/new', { cwd: input.cwd ?? process.cwd(), mcpServers }))
      const sessionId = text(result.sessionId)
      if (!sessionId) throw new Error('Agent 未返回有效会话')
      sessions.set(sessionId, {
        info: { id: sessionId, title: input.title || 'Agent 会话', cwd: input.cwd, updatedAt: Date.now() },
        page: { messages: [], hasMore: false, asOfSeq: 0 },
        active: false,
      })
      const state = parseModels(result, sessionId)
      modelStates.set(sessionId, state.models.length ? state : defaultModels)
      const session = sessions.get(sessionId)!
      session.info.projectId = input.projectId
      session.info.model = state.currentModel
      if (input.model) await setModel({ backendId: options.id, sessionId, model: input.model, provider: input.provider })
      return { sessionId }
    },
    async models(sessionId) {
      return structuredClone((sessionId ? modelStates.get(sessionId) : undefined) ?? defaultModels)
    },
    setModel,
    async readMessages(sessionId) {
      const session = sessions.get(sessionId)
      if (!session) throw new Error('Agent 会话不存在')
      return { ...session.page, messages: session.page.messages.map((message) => ({ ...message })) }
    },
    async send(input) {
      const session = sessions.get(input.sessionId)
      if (!session) throw new Error('Agent 会话不存在')
      if (session.active) throw new Error('Agent 正在回复，请先停止当前轮')
      session.active = true
      session.info.running = true
      session.assistant = undefined
      session.page.messages.push({ seq: ++session.page.asOfSeq, role: 'user', text: input.text })
      const content = attachmentSummary(input) + (input.studioContext ? `\n\n[Current Studio context]\n${input.studioContext}` : '')
      const promptBlocks = buildAcpPromptBlocks(input, content)
      emit(input.sessionId, { type: 'status', text: '正在思考' })
      // Run session/prompt without a 120s kill-timeout and without blocking IPC so the Stop button remains responsive.
      const promptPromise = rpc('session/prompt', { sessionId: input.sessionId, prompt: promptBlocks }, 0)
      void promptPromise
        .then(() => {
          emit(input.sessionId, { type: 'done' })
        })
        .catch((error: unknown) => {
          emit(input.sessionId, { type: 'error', message: error instanceof Error ? error.message : String(error) })
        })
        .finally(() => {
          session.active = false
          session.info.running = false
          session.info.updatedAt = Date.now()
        })
    },
    async stop(sessionId) {
      write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
    },
  }
}
