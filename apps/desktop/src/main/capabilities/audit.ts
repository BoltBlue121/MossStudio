import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import type { CapabilityAuditEntry, CapabilityAuditQuery } from '@shared/capabilities'
import { paths } from '../lib/paths'

/**
 * Append-only capability execution audit trail (操作留痕).
 *
 * Every capability call routed through the main dispatcher appends one JSON
 * line to `<dataRoot>/logs/capabilities.jsonl` and mirrors it in a bounded
 * memory buffer so humans and agents can inspect recent actions without secrets.
 */

const MAX_MEMORY_ENTRIES = 500
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const memoryEntries: CapabilityAuditEntry[] = []

function loadFromDisk(): CapabilityAuditEntry[] {
  const file = paths.capabilityAudit()
  if (!existsSync(file)) return []
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed: CapabilityAuditEntry[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        parsed.push(JSON.parse(trimmed) as CapabilityAuditEntry)
      } catch {
        // Ignore a truncated trailing line after an abrupt crash.
      }
    }
    return parsed.slice(-MAX_MEMORY_ENTRIES)
  } catch {
    // Unreadable log file: fall back to an empty history rather than breaking tool calls.
    return []
  }
}

export function recordCapabilityAudit(entry: CapabilityAuditEntry): void {
  memoryEntries.push(entry)
  if (memoryEntries.length > MAX_MEMORY_ENTRIES) {
    memoryEntries.splice(0, memoryEntries.length - MAX_MEMORY_ENTRIES)
  }
  try {
    mkdirSync(paths.logs(), { recursive: true })
    appendFileSync(paths.capabilityAudit(), `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (error) {
    console.warn('[capabilities-audit]', error instanceof Error ? error.message : String(error))
  }
}

export function listCapabilityAudit(query: CapabilityAuditQuery = {}): CapabilityAuditEntry[] {
  const source = memoryEntries.length > 0 ? memoryEntries : loadFromDisk()
  const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT))
  const filtered = source.filter((entry) => {
    if (query.conversationId && entry.conversationId !== query.conversationId) return false
    if (query.packId && entry.packId !== query.packId) return false
    if (query.actionId && entry.actionId !== query.actionId) return false
    return true
  })
  return filtered.slice(-limit).reverse()
}

export function resetCapabilityAuditMemory(): void {
  memoryEntries.length = 0
}
