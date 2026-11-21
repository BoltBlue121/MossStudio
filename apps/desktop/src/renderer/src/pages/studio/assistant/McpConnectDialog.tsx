import { useCallback, useEffect, useState } from 'react'
import { Copy, Download, RefreshCw, Trash2 } from 'lucide-react'
import { composeOfficialGuide, type GuideTopic } from '@shared/capabilities'
import { Notice } from '../../../components/common/Notice'
import { Button, FieldLabel, IconButton, LoadingRow, Modal, Pill, cn, useCopyText, useToast } from '../../../components/ui'
import { PROFILE_LABELS, projectedToolset, type ToolProfileState } from './CollabToolbar'
import { mcpConfigJson, normalizeMcpClients, type CollabClient, type McpClientStatus, type McpConfigKind } from './collabClient'

export const PROMPTCRAFT_SKILL_URI = 'mossstudio://skill/promptcraft'
export const LAYOUT_SKILL_URI = 'mossstudio://skill/layout'

type ClientState = 'installed' | 'detected' | 'missing'

export function mcpClientState(status: McpClientStatus): ClientState {
  if (status.installed) return 'installed'
  return status.detected ? 'detected' : 'missing'
}

const STATE_LABEL: Record<ClientState, string> = { installed: '已接入', detected: '已检测到配置', missing: '未配置' }
const STATE_TONE = { installed: 'ok', detected: 'accent', missing: 'neutral' } as const

interface SkillRow {
  topic: Exclude<GuideTopic, 'all'>
  title: string
  detail: string
}

/**
 * Connect another Agent to MossStudio in one place: write its MCP config, copy
 * the Skills it should read, or copy the raw MCP JSON for anything else.
 */
export function McpConnectDialog({
  open,
  onClose,
  client,
  profile,
}: {
  open: boolean
  onClose: () => void
  client: CollabClient
  profile: ToolProfileState
}): React.JSX.Element {
  const copyText = useCopyText()
  const toast = useToast()
  const [clients, setClients] = useState<McpClientStatus[] | null | undefined>(undefined)
  const [busy, setBusy] = useState<string | null>(null)
  const projected = projectedToolset(profile)

  const load = useCallback(async () => {
    setClients(undefined)
    setClients(await client.mcpClients())
  }, [client])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  async function change(status: McpClientStatus, action: 'install' | 'uninstall'): Promise<void> {
    if (busy) return
    setBusy(status.id)
    try {
      const next = action === 'install' ? await client.installMcpClient(status.id) : await client.uninstallMcpClient(status.id)
      setClients((list) => list?.map((item) => (item.id === next.id ? next : item)) ?? list)
      const backup = next.backupPath ? `，原配置已备份到 ${next.backupPath}` : ''
      toast.push(
        action === 'install'
          ? `已把 MossStudio 接入 ${next.label}${backup}。重启它后生效。`
          : `已从 ${next.label} 移除 MossStudio${backup}`,
        'success',
      )
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function copyConfig(kind: McpConfigKind): Promise<void> {
    const connection = await client.mcpConnection()
    if (!connection) {
      toast.push('本机 MCP 服务未启动', 'error')
      return
    }
    const name = kind === 'http' ? 'Streamable HTTP' : kind === 'stdio' ? 'stdio' : '完整'
    await copyText(mcpConfigJson(connection, kind), `已复制 ${name} MCP 配置（${connection.toolCount} 个工具）`)
  }

  async function copySkill(topic: GuideTopic): Promise<void> {
    const request = { topic, profile: profile.mode, ...(profile.mode === 'custom' ? { enabledPacks: profile.packs } : {}) }
    const served = await client.readGuide(request)
    if (served) {
      await copyText(served, topic === 'all' ? '已复制完整合并 Skill（工具 + 提示词 + Layout）' : `已复制${titleOf(topic)}`)
      return
    }
    // The MCP server is not running: the same Skills are built here from the shared registry.
    const local = composeOfficialGuide(projected.skill.markdown, topic)
    await copyText(local, topic === 'all' ? '已复制完整合并 Skill（工具 + 提示词 + Layout）' : `已复制${titleOf(topic)}`)
  }

  const skills: SkillRow[] = [
    {
      topic: 'tools',
      title: '工具层 Skill',
      detail: `${PROFILE_LABELS[profile.mode]} · ${projected.actions.length} 项能力，随工具集即时更新`,
    },
    { topic: 'promptcraft', title: 'MOSS 官方提示词 Skill', detail: PROMPTCRAFT_SKILL_URI },
    { topic: 'layout', title: 'MOSS 官方 Layout 设计 Skill', detail: LAYOUT_SKILL_URI },
  ]

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="接入外部 Agent"
      description="让 Codex、Claude Code 或任何支持 MCP 的 Agent 通过本机 MCP 操作画板，并读到 MossStudio 的 Skill。"
      width="max-w-2xl"
      footer={
        <Button tone="ghost" size="md" data-dialog-initial-focus onClick={onClose}>
          完成
        </Button>
      }
    >
      <div className="flex min-w-0 flex-col gap-5" data-mcp-connect-dialog>
        <section className="flex min-w-0 flex-col gap-2">
          <FieldLabel
            as="h3"
            value={
              <IconButton label="重新检测" className="size-7" disabled={clients === undefined} onClick={() => void load()}>
                <RefreshCw className={cn('size-3.5', clients === undefined && 'animate-spin')} strokeWidth={1.6} />
              </IconButton>
            }
          >
            一键接入
          </FieldLabel>
          {clients === undefined ? (
            <LoadingRow label="正在检测本机 Agent…" />
          ) : (
            <>
              {clients === null ? (
                <Notice>这个版本还不能自动写入 Agent 配置。可以复制下面的 MCP 配置，粘贴到 Agent 的 MCP 设置里。</Notice>
              ) : null}
              <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                {(clients ?? normalizeMcpClients([])).map((status) => {
                  const state = mcpClientState(status)
                  const working = busy === status.id
                  return (
                    <div
                      key={status.id}
                      className="flex min-w-0 flex-col gap-2 rounded-lg bg-well p-3"
                      data-mcp-client={status.id}
                      data-mcp-client-state={state}
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-ui font-medium text-ink">{status.label}</span>
                        <Pill tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Pill>
                      </div>
                      <span
                        className="truncate text-caption text-ink-2"
                        title={status.configPath || undefined}
                        data-mcp-client-path={status.configPath}
                      >
                        {status.configPath || '没有找到配置文件'}
                      </span>
                      {status.detail ? <span className="text-caption text-ink-2 [overflow-wrap:anywhere]">{status.detail}</span> : null}
                      <div className="mt-auto flex flex-wrap gap-1">
                        {status.installMode === 'copy-only' ? (
                          <Button size="xs" data-mcp-copy-client={status.id} onClick={() => void copyConfig('http')}>
                            <Copy className="size-3" aria-hidden="true" strokeWidth={1.6} />
                            复制配置
                          </Button>
                        ) : (
                          <>
                            <Button
                              size="xs"
                              disabled={busy !== null}
                              data-mcp-install={status.id}
                              onClick={() => void change(status, 'install')}
                            >
                              <Download className="size-3" aria-hidden="true" strokeWidth={1.6} />
                              {working ? '处理中…' : status.installed ? '更新' : '一键安装'}
                            </Button>
                            {status.installed ? (
                              <Button
                                tone="ghost-danger"
                                size="xs"
                                disabled={busy !== null}
                                data-mcp-uninstall={status.id}
                                onClick={() => void change(status, 'uninstall')}
                              >
                                <Trash2 className="size-3" aria-hidden="true" strokeWidth={1.6} />
                                卸载
                              </Button>
                            ) : null}
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-2">
          <FieldLabel
            as="h3"
            value={
              <Button size="xs" data-copy-skill="all" onClick={() => void copySkill('all')}>
                <Copy className="size-3" aria-hidden="true" strokeWidth={1.6} />
                复制完整合并 Skill
              </Button>
            }
          >
            向 Agent 暴露的 Skill
          </FieldLabel>
          <div className="flex min-w-0 flex-col gap-1 rounded-lg bg-well p-1.5">
            {skills.map((row) => (
              <div key={row.topic} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5" data-skill-row={row.topic}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-ui text-ink">{row.title}</span>
                  <span className="truncate text-caption text-ink-2" title={row.detail}>
                    {row.detail}
                  </span>
                </span>
                <Button tone="ghost" size="xs" data-copy-skill={row.topic} onClick={() => void copySkill(row.topic)}>
                  <Copy className="size-3" aria-hidden="true" strokeWidth={1.6} />
                  复制
                </Button>
              </div>
            ))}
          </div>
        </section>

        <section className="flex min-w-0 flex-col gap-2">
          <FieldLabel as="h3">MCP 连接配置</FieldLabel>
          <p className="text-caption text-ink-2">其他 Agent 可粘贴这段标准 mcpServers 配置。里面带本机访问令牌，请不要发给别人。</p>
          <div className="flex flex-wrap gap-1.5">
            <Button size="xs" data-copy-mcp-kind="http" onClick={() => void copyConfig('http')}>
              <Copy className="size-3" aria-hidden="true" strokeWidth={1.6} />
              Streamable HTTP
            </Button>
            <Button size="xs" data-copy-mcp-kind="stdio" onClick={() => void copyConfig('stdio')}>
              <Copy className="size-3" aria-hidden="true" strokeWidth={1.6} />
              stdio
            </Button>
            <Button size="xs" data-copy-mcp-kind="all" onClick={() => void copyConfig('all')}>
              <Copy className="size-3" aria-hidden="true" strokeWidth={1.6} />
              两种都复制
            </Button>
          </div>
        </section>
      </div>
    </Modal>
  )
}

function titleOf(topic: Exclude<GuideTopic, 'all'>): string {
  return topic === 'tools' ? '工具层 Skill' : topic === 'promptcraft' ? 'MOSS 官方提示词 Skill' : 'MOSS 官方 Layout 设计 Skill'
}
