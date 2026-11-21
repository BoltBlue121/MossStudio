import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { getMcpServerState } from './server'

/**
 * Universal MCP client installer shipped inside MossStudio.
 *
 * Registers MossStudio's own zero-dependency stdio MCP bridge
 * (`tools/mcp/mossstudio-mcp-stdio.mjs`) into external Agent clients
 * (Codex CLI, Claude Code) without requiring any
 * agent-specific standalone plugin. Always writes timestamped backups
 * before mutating any existing user configuration file.
 */

export type McpClientId = 'codex' | 'claude-code'

export interface McpClientStatus {
  id: McpClientId
  label: string
  configPath: string
  detected: boolean
  installed: boolean
  installMode: 'auto' | 'copy-only'
  detail: string
  backupPath?: string
}

export interface McpClientInstallerOptions {
  homeDir?: string
  env?: NodeJS.ProcessEnv
  stdioBridgePath?: string
  discoveryPath?: string
  fallbackExecPath?: string
  platform?: NodeJS.Platform
}

interface ResolvedPaths {
  home: string
  env: NodeJS.ProcessEnv
  stdioBridgePath: string
  discoveryPath: string
  fallbackExecPath: string
  platform: NodeJS.Platform
}

function resolvePaths(options: McpClientInstallerOptions = {}): ResolvedPaths {
  const state = getMcpServerState(false)
  return {
    home: options.homeDir ?? homedir(),
    env: options.env ?? process.env,
    stdioBridgePath: options.stdioBridgePath ?? state.stdioBridgePath,
    discoveryPath: options.discoveryPath ?? state.discoveryPath,
    fallbackExecPath: options.fallbackExecPath ?? process.execPath,
    platform: options.platform ?? process.platform,
  }
}

/** Pure-FS PATH scan (no child process) so freshly installed CLIs are detected even before first run. */
export function findExecutableOnPath(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const hasExplicitPath = 'PATH' in env || 'Path' in env
  const rawPath = hasExplicitPath ? (env.PATH ?? env.Path ?? '') : (process.env.PATH ?? process.env.Path ?? '')
  if (!rawPath) return null
  const sep = platform === 'win32' ? ';' : delimiter
  const dirs = rawPath
    .split(sep)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
  const exts =
    platform === 'win32'
      ? (env.PATHEXT ?? process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .map((ext) => ext.trim())
          .filter(Boolean)
      : ['']
  for (const dir of dirs) {
    for (const name of names) {
      const hasExt = platform === 'win32' && /\.[a-z0-9]+$/i.test(name)
      const candidates = hasExt ? [name] : exts.map((ext) => `${name}${ext}`)
      for (const candidate of candidates) {
        const full = join(dir, candidate)
        if (existsSync(full)) return full
      }
      if (platform === 'win32') {
        const bare = join(dir, name)
        if (existsSync(bare)) return bare
      }
    }
  }
  return null
}

function resolveBridgeRuntime(resolved: ResolvedPaths): { command: string; env: Record<string, string> } {
  if (findExecutableOnPath(['node'], resolved.env, resolved.platform)) {
    return { command: 'node', env: { MOSSSTUDIO_MCP_DISCOVERY: resolved.discoveryPath } }
  }
  return {
    command: resolved.fallbackExecPath,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      MOSSSTUDIO_MCP_DISCOVERY: resolved.discoveryPath,
    },
  }
}

function writeAtomicSync(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmpPath, content, 'utf8')
  renameSync(tmpPath, filePath)
}

function backupIfExists(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${filePath}.bak-${stamp}`
  copyFileSync(filePath, backupPath)
  return backupPath
}

function codexConfigPath(home: string): string {
  return join(home, '.codex', 'config.toml')
}

function claudeConfigPath(home: string): string {
  return join(home, '.claude.json')
}

/**
 * Parse a TOML table header segment list from a standalone header line
 * (outside of any multiline string), handling quoted keys and trailing `#` comments.
 * Returns null if the line is not a TOML table header (e.g. array items like `["x"],`).
 */
function parseTomlTableHeader(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('[')) return null
  const isArrayTable = trimmed.startsWith('[[')
  const start = isArrayTable ? 2 : 1
  const closeToken = isArrayTable ? ']]' : ']'
  let i = start
  let quote: '"' | "'" | null = null
  let escaped = false
  let closeIdx = -1
  while (i < trimmed.length) {
    const ch = trimmed[i]!
    if (quote) {
      if (quote === '"' && ch === '\\' && !escaped) {
        escaped = true
        i++
        continue
      }
      if (ch === quote && !escaped) quote = null
      escaped = false
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      i++
      continue
    }
    if (ch === '#') return null
    if (trimmed.slice(i, i + closeToken.length) === closeToken) {
      closeIdx = i
      break
    }
    i++
  }
  if (closeIdx < 0) return null
  const trailing = trimmed.slice(closeIdx + closeToken.length).trim()
  if (trailing && !trailing.startsWith('#')) return null
  const inner = trimmed.slice(start, closeIdx).trim()
  if (!inner) return null
  const parts: string[] = []
  let cur = ''
  let q: '"' | "'" | null = null
  let esc = false
  for (let k = 0; k < inner.length; k++) {
    const ch = inner[k]!
    if (q) {
      if (q === '"' && ch === '\\' && !esc) {
        esc = true
        continue
      }
      if (ch === q && !esc) {
        q = null
        continue
      }
      esc = false
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      q = ch
      continue
    }
    if (ch === '.') {
      parts.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  parts.push(cur.trim())
  return parts.every(Boolean) ? parts : null
}

function isMossStudioCodexTable(parts: string[]): boolean {
  return parts.length >= 2 && parts[0] === 'mcp_servers' && parts[1] === 'mossstudio'
}

/** Update multiline TOML string state (`"""` or `'''`) across a single line. */
function advanceTomlMultilineState(line: string, state: '"""' | "'''" | null): '"""' | "'''" | null {
  let active = state
  let inlineQuote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (active) {
      if (active === '"""' && ch === '\\' && !escaped) {
        escaped = true
        continue
      }
      if (!escaped && line.slice(i, i + 3) === active) {
        active = null
        i += 2
      }
      escaped = false
      continue
    }
    if (inlineQuote) {
      if (inlineQuote === '"' && ch === '\\' && !escaped) {
        escaped = true
        continue
      }
      if (!escaped && ch === inlineQuote) inlineQuote = null
      escaped = false
      continue
    }
    if (ch === '#') break
    if (line.slice(i, i + 3) === '"""') {
      active = '"""'
      i += 2
      continue
    }
    if (line.slice(i, i + 3) === "'''") {
      active = "'''"
      i += 2
      continue
    }
    if (ch === '"' || ch === "'") inlineQuote = ch
  }
  return active
}

/** Remove `[mcp_servers.mossstudio]` (bare or quoted) and nested sub-tables without mutating unrelated lines or multiline strings. */
function stripCodexMossSection(toml: string): { content: string; removed: boolean } {
  const eol = toml.includes('\r\n') ? '\r\n' : '\n'
  const lines = toml.split(/\r?\n/)
  const out: string[] = []
  let multiline: '"""' | "'''" | null = null
  let skipping = false
  let removed = false

  for (const line of lines) {
    if (!multiline) {
      const header = parseTomlTableHeader(line)
      if (header) {
        if (isMossStudioCodexTable(header)) {
          skipping = true
          removed = true
          continue
        }
        skipping = false
      }
    }
    if (!skipping) out.push(line)
    multiline = advanceTomlMultilineState(line, multiline)
  }

  while (out.length && out[out.length - 1] === '') out.pop()
  return { content: out.length ? `${out.join(eol)}${eol}` : '', removed }
}

function hasCodexMossSection(toml: string): boolean {
  let multiline: '"""' | "'''" | null = null
  for (const line of toml.split(/\r?\n/)) {
    if (!multiline) {
      const header = parseTomlTableHeader(line)
      if (header && isMossStudioCodexTable(header)) return true
    }
    multiline = advanceTomlMultilineState(line, multiline)
  }
  return false
}

function buildCodexMossSection(resolved: ResolvedPaths): string {
  const runtime = resolveBridgeRuntime(resolved)
  return [
    '[mcp_servers.mossstudio]',
    `command = ${JSON.stringify(runtime.command)}`,
    `args = [${JSON.stringify(resolved.stdioBridgePath)}]`,
    '',
    '[mcp_servers.mossstudio.env]',
    ...Object.entries(runtime.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
  ].join('\n')
}

function readCodexStatus(resolved: ResolvedPaths, backupPath?: string): McpClientStatus {
  const configPath = codexConfigPath(resolved.home)
  const dirExists = existsSync(dirname(configPath))
  const fileExists = existsSync(configPath)
  const binaryPath = findExecutableOnPath(['codex'], resolved.env, resolved.platform)
  let installed = false
  if (fileExists) {
    try {
      installed = hasCodexMossSection(readFileSync(configPath, 'utf8'))
    } catch {
      installed = false
    }
  }
  return {
    id: 'codex',
    label: 'Codex CLI',
    configPath,
    detected: fileExists || dirExists || Boolean(binaryPath),
    installed,
    installMode: 'auto',
    detail: installed
      ? '已注册 [mcp_servers.mossstudio]，可直接调用全部画板工具与官方 Skill'
      : fileExists || dirExists
        ? '已检测到 Codex 配置目录，可一键写入 MossStudio MCP'
        : binaryPath
          ? '已检测到 Codex CLI 可执行程序（尚未生成配置文件），可一键写入 MossStudio MCP'
          : '尚未检测到 ~/.codex，点击一键安装将自动创建配置文件',
    ...(backupPath ? { backupPath } : {}),
  }
}

function readClaudeStatus(resolved: ResolvedPaths, backupPath?: string): McpClientStatus {
  const configPath = claudeConfigPath(resolved.home)
  const fileExists = existsSync(configPath)
  const dirExists = existsSync(join(resolved.home, '.claude'))
  const binaryPath = findExecutableOnPath(['claude'], resolved.env, resolved.platform)
  let installed = false
  let parseError = false
  if (fileExists) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { mcpServers?: Record<string, unknown> }
      installed = Boolean(parsed?.mcpServers && typeof parsed.mcpServers === 'object' && parsed.mcpServers.mossstudio)
    } catch {
      parseError = true
    }
  }
  return {
    id: 'claude-code',
    label: 'Claude Code',
    configPath,
    detected: fileExists || dirExists || Boolean(binaryPath),
    installed,
    installMode: 'auto',
    detail: parseError
      ? '检测到 ~/.claude.json 但 JSON 格式无法解析，请先手动检查文件后再安装'
      : installed
        ? '已注册 mcpServers.mossstudio，可直接读取画板工具与 MOSS 官方 Skill'
        : fileExists || dirExists
          ? '已检测到 Claude Code 配置，可一键写入 MossStudio MCP'
          : binaryPath
            ? '已检测到 Claude Code 可执行程序（尚未生成配置文件），可一键写入 MossStudio MCP'
            : '尚未检测到 Claude Code，点击一键安装将创建 ~/.claude.json',
    ...(backupPath ? { backupPath } : {}),
  }
}

export function getMcpClientsStatus(options: McpClientInstallerOptions = {}): McpClientStatus[] {
  const resolved = resolvePaths(options)
  return [readCodexStatus(resolved), readClaudeStatus(resolved)]
}

export function installMcpClient(clientId: McpClientId, options: McpClientInstallerOptions = {}): McpClientStatus {
  const resolved = resolvePaths(options)

  if (clientId === 'codex') {
    const configPath = codexConfigPath(resolved.home)
    const backupPath = backupIfExists(configPath)
    const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
    const { content: cleaned } = stripCodexMossSection(existing)
    const block = buildCodexMossSection(resolved)
    const next = cleaned ? `${cleaned.trimEnd()}\n\n${block}\n` : `${block}\n`
    writeAtomicSync(configPath, next)
    return readCodexStatus(resolved, backupPath)
  }

  if (clientId === 'claude-code') {
    const configPath = claudeConfigPath(resolved.home)
    const backupPath = backupIfExists(configPath)
    let parsed: Record<string, unknown> = {}
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('~/.claude.json 根节点不是有效的 JSON 对象，已中止写入以保护原有配置')
      }
      parsed = raw as Record<string, unknown>
    }
    const existingServers =
      parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
        ? (parsed.mcpServers as Record<string, unknown>)
        : {}
    const runtime = resolveBridgeRuntime(resolved)
    parsed.mcpServers = {
      ...existingServers,
      mossstudio: {
        command: runtime.command,
        args: [resolved.stdioBridgePath],
        env: runtime.env,
      },
    }
    writeAtomicSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`)
    return readClaudeStatus(resolved, backupPath)
  }

  throw new Error('不支持的客户端')
}

export function uninstallMcpClient(clientId: McpClientId, options: McpClientInstallerOptions = {}): McpClientStatus {
  const resolved = resolvePaths(options)

  if (clientId === 'codex') {
    const configPath = codexConfigPath(resolved.home)
    if (!existsSync(configPath)) return readCodexStatus(resolved)
    const existing = readFileSync(configPath, 'utf8')
    const { content, removed } = stripCodexMossSection(existing)
    if (!removed) return readCodexStatus(resolved)
    const backupPath = backupIfExists(configPath)
    writeAtomicSync(configPath, content)
    return readCodexStatus(resolved, backupPath)
  }

  if (clientId === 'claude-code') {
    const configPath = claudeConfigPath(resolved.home)
    if (!existsSync(configPath)) return readClaudeStatus(resolved)
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('~/.claude.json 根节点不是有效的 JSON 对象，已中止卸载')
    }
    const parsed = raw as Record<string, unknown>
    const servers =
      parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
        ? ({ ...(parsed.mcpServers as Record<string, unknown>) } as Record<string, unknown>)
        : null
    if (!servers || !('mossstudio' in servers)) return readClaudeStatus(resolved)
    const backupPath = backupIfExists(configPath)
    delete servers.mossstudio
    parsed.mcpServers = servers
    writeAtomicSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`)
    return readClaudeStatus(resolved, backupPath)
  }

  throw new Error('不支持的客户端')
}
