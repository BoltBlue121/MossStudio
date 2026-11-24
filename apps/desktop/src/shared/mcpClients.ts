export type ManagedClientId = 'codex' | 'claude-code'
export type McpClientId = ManagedClientId | 'dsh'
export const CLIENT_STATES = [
  'not_found',
  'not_configured',
  'configured',
  'conflict',
  'needs_refresh',
  'custom_policy',
  'unsupported',
  'unknown',
  'detected',
] as const
export interface McpClientStatus {
  id: McpClientId
  label: string
  configPath: string
  state: (typeof CLIENT_STATES)[number]
  installMode: 'auto' | 'copy-only'
  detail: string
}
export interface BridgeLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}
