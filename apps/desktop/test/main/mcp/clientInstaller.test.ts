import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getMcpClientsStatus, installMcpClient, uninstallMcpClient } from '@main/mcp/clientInstaller'

let tempHome = ''

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'moss-mcp-installer-'))
})

afterEach(() => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true })
})

describe('main/mcp/clientInstaller', () => {
  const opts = () => ({
    homeDir: tempHome,
    stdioBridgePath: join(tempHome, 'mossstudio-mcp-stdio.mjs'),
    discoveryPath: join(tempHome, 'mcp-server.json'),
  })

  it('installs, idempotently updates, backs up, and cleanly uninstalls Codex TOML without touching other entries', () => {
    const codexDir = join(tempHome, '.codex')
    const codexToml = join(codexDir, 'config.toml')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(
      codexToml,
      ['model = "gpt-5.4"', '', '[mcp_servers.other]', 'command = "npx"', 'args = ["other-mcp"]', ''].join('\n'),
      'utf8',
    )

    const before = getMcpClientsStatus(opts()).find((item) => item.id === 'codex')!
    expect(before.detected).toBe(true)
    expect(before.installed).toBe(false)

    const installed = installMcpClient('codex', opts())
    expect(installed.installed).toBe(true)
    expect(installed.backupPath && existsSync(installed.backupPath)).toBe(true)

    const written = readFileSync(codexToml, 'utf8')
    expect(written).toContain('model = "gpt-5.4"')
    expect(written).toContain('[mcp_servers.other]')
    expect(written).toContain('[mcp_servers.mossstudio]')
    expect(written).toContain('mossstudio-mcp-stdio.mjs')

    // Re-installing stays idempotent (no duplicate [mcp_servers.mossstudio] header)
    installMcpClient('codex', opts())
    const secondWrite = readFileSync(codexToml, 'utf8')
    expect(secondWrite.match(/\[mcp_servers\.mossstudio\]/g)).toHaveLength(1)

    const uninstalled = uninstallMcpClient('codex', opts())
    expect(uninstalled.installed).toBe(false)
    const afterUninstall = readFileSync(codexToml, 'utf8')
    expect(afterUninstall).toContain('model = "gpt-5.4"')
    expect(afterUninstall).toContain('[mcp_servers.other]')
    expect(afterUninstall).not.toContain('[mcp_servers.mossstudio]')
  })

  it('preserves multiline TOML strings containing header-like text and handles quoted mossstudio tables with comments', () => {
    const codexDir = join(tempHome, '.codex')
    const codexToml = join(codexDir, 'config.toml')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(
      codexToml,
      [
        '[mcp_servers.keep]',
        'notes = """',
        '[mcp_servers.mossstudio]',
        'inside multiline string must survive',
        '"""',
        'command = "keep"',
        '',
        '[mcp_servers."mossstudio"] # old quoted entry',
        'command = "old-node"',
        '',
      ].join('\n'),
      'utf8',
    )

    const before = getMcpClientsStatus(opts()).find((item) => item.id === 'codex')!
    expect(before.installed).toBe(true)

    const installed = installMcpClient('codex', opts())
    expect(installed.installed).toBe(true)
    const afterInstall = readFileSync(codexToml, 'utf8')
    expect(afterInstall).toContain('inside multiline string must survive')
    expect(afterInstall).toContain('command = "keep"')
    expect(afterInstall).not.toContain('command = "old-node"')
    expect(afterInstall).not.toContain('[mcp_servers."mossstudio"]')
    expect(afterInstall).toContain('[mcp_servers.mossstudio]')
  })

  it('installs, backs up, and uninstalls Claude Code JSON while preserving existing mcpServers and settings', () => {
    const claudeJson = join(tempHome, '.claude.json')
    writeFileSync(
      claudeJson,
      JSON.stringify({ theme: 'dark', mcpServers: { existing: { command: 'uvx', args: ['demo'] } } }, null, 2),
      'utf8',
    )

    const installed = installMcpClient('claude-code', opts())
    expect(installed.installed).toBe(true)
    expect(installed.backupPath && existsSync(installed.backupPath)).toBe(true)

    const parsed = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
      theme: string
      mcpServers: Record<string, { command: string; args: string[] }>
    }
    expect(parsed.theme).toBe('dark')
    expect(parsed.mcpServers.existing?.command).toBe('uvx')
    expect(parsed.mcpServers.mossstudio?.command).toBe('node')
    expect(parsed.mcpServers.mossstudio?.args[0]).toContain('mossstudio-mcp-stdio.mjs')

    const uninstalled = uninstallMcpClient('claude-code', opts())
    expect(uninstalled.installed).toBe(false)
    const after = JSON.parse(readFileSync(claudeJson, 'utf8')) as { theme: string; mcpServers: Record<string, unknown> }
    expect(after.theme).toBe('dark')
    expect(after.mcpServers.existing).toBeDefined()
    expect(after.mcpServers.mossstudio).toBeUndefined()
  })

  it('detects freshly installed Codex and Claude CLIs on PATH even when HOME has zero config files yet', () => {
    const binDir = join(tempHome, 'fresh-bin')
    mkdirSync(binDir, { recursive: true })
    const ext = process.platform === 'win32' ? '.cmd' : ''
    writeFileSync(join(binDir, `codex${ext}`), '', 'utf8')
    writeFileSync(join(binDir, `claude${ext}`), '', 'utf8')

    const statuses = getMcpClientsStatus({ ...opts(), env: { PATH: binDir } })
    const codex = statuses.find((item) => item.id === 'codex')!
    const claude = statuses.find((item) => item.id === 'claude-code')!
    expect(codex.detected).toBe(true)
    expect(codex.installed).toBe(false)
    expect(claude.detected).toBe(true)
    expect(claude.installed).toBe(false)
  })

  it('falls back to ELECTRON_RUN_AS_NODE runtime when global node is missing on a fresh machine', () => {
    const fallbackExec = join(tempHome, 'MossStudio.exe')
    const noNodeOpts = { ...opts(), env: { PATH: '' }, fallbackExecPath: fallbackExec }

    installMcpClient('codex', noNodeOpts)
    const toml = readFileSync(join(tempHome, '.codex', 'config.toml'), 'utf8')
    expect(toml).toContain(`command = ${JSON.stringify(fallbackExec)}`)
    expect(toml).toContain('ELECTRON_RUN_AS_NODE = "1"')

    installMcpClient('claude-code', noNodeOpts)
    const claude = JSON.parse(readFileSync(join(tempHome, '.claude.json'), 'utf8')) as {
      mcpServers: { mossstudio: { command: string; env: Record<string, string> } }
    }
    expect(claude.mcpServers.mossstudio.command).toBe(fallbackExec)
    expect(claude.mcpServers.mossstudio.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})
