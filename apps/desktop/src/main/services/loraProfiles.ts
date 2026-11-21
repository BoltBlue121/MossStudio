import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import type { LoraMetadata, LoraProfile } from '@shared/types'
import { schemas } from '@shared/schemas'
import { paths } from '../lib/paths'
import { writeFileAtomic } from '../lib/atomicWrite'

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
function words(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\r\n]+/) : []
  return [
    ...new Set(
      values
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item.length <= 200),
    ),
  ].slice(0, 64)
}
export function sanitizeLoraMetadata(value: unknown): LoraMetadata {
  const row = object(value)
  return {
    ...(row.triggers !== undefined ? { triggers: words(row.triggers) } : {}),
    ...(row.suggestedTriggers !== undefined ? { suggestedTriggers: words(row.suggestedTriggers).slice(0, 8) } : {}),
    ...(row.negativeTriggers !== undefined ? { negativeTriggers: words(row.negativeTriggers) } : {}),
    ...(typeof row.defaultStrength === 'number' && Number.isFinite(row.defaultStrength) && Math.abs(row.defaultStrength) <= 4
      ? { defaultStrength: row.defaultStrength }
      : {}),
    ...(['manual', 'prefix', 'suffix'].includes(String(row.autoInsert))
      ? { autoInsert: row.autoInsert as LoraMetadata['autoInsert'] }
      : {}),
    ...(typeof row.notes === 'string' ? { notes: row.notes.slice(0, 4000) } : {}),
  }
}
async function sidecar(file: string): Promise<string | undefined> {
  try {
    const handle = await open(file, 'r')
    try {
      if ((await handle.stat()).size > 1024 * 1024) return undefined
      return await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
export async function extractSafetensorsTriggers(filePath: string): Promise<LoraMetadata> {
  if (extname(filePath).toLowerCase() !== '.safetensors') throw new Error('请选择 safetensors 文件。')
  const handle = await open(filePath, 'r')
  let metadata: Record<string, unknown>
  try {
    const prefix = Buffer.alloc(8)
    if ((await handle.read(prefix, 0, 8, 0)).bytesRead !== 8) throw new Error('LoRA 文件头不完整。')
    const length = prefix.readBigUInt64LE()
    if (length < 2n || length > 16n * 1024n * 1024n) throw new Error('LoRA 文件头大小无效。')
    const header = Buffer.alloc(Number(length))
    if ((await handle.read(header, 0, header.length, 8)).bytesRead !== header.length) throw new Error('LoRA 文件头不完整。')
    metadata = object(object(JSON.parse(header.toString('utf8')) as unknown).__metadata__)
  } finally {
    await handle.close()
  }
  let triggers: string[] = []
  for (const key of ['modelspec.trigger_word', 'trigger_word', 'trigger_words']) {
    triggers = words(metadata[key])
    if (triggers.length) break
  }
  const stem = filePath.slice(0, -extname(filePath).length)
  for (const suffix of ['.civitai.info', '.json', '.txt']) {
    if (triggers.length) break
    const value = await sidecar(stem + suffix)
    if (value === undefined) continue
    if (suffix === '.txt') {
      triggers = words(value)
      continue
    }
    try {
      const row = object(JSON.parse(value) as unknown)
      for (const key of suffix === '.civitai.info' ? ['trainedWords'] : ['triggers', 'trainedWords', 'activation text']) {
        triggers = words(row[key])
        if (triggers.length) break
      }
    } catch {
      /* Malformed optional sidecars do not hide lower-priority metadata. */
    }
  }
  const frequencies = new Map<string, number>()
  try {
    const raw =
      typeof metadata.ss_tag_frequency === 'string' ? (JSON.parse(metadata.ss_tag_frequency) as unknown) : metadata.ss_tag_frequency
    for (const group of Object.values(object(raw)))
      for (const [tag, count] of Object.entries(object(group))) {
        if (words([tag]).length && typeof count === 'number' && Number.isFinite(count) && count > 0)
          frequencies.set(tag.trim(), (frequencies.get(tag.trim()) ?? 0) + count)
      }
  } catch {
    /* Training frequency is only a suggestion, never an explicit trigger. */
  }
  return {
    triggers,
    suggestedTriggers: [...frequencies]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([tag]) => tag),
  }
}
export async function listLoraProfiles(): Promise<LoraProfile[]> {
  try {
    const rows: unknown = JSON.parse(await readFile(paths.loraProfiles(), 'utf8'))
    const parsed = schemas.loraProfilesSave.array().safeParse(rows)
    return parsed.success ? parsed.data : []
  } catch (error) {
    // Optional metadata must not make the model inventory unavailable.
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
export async function getLoraProfile(loraId: string): Promise<LoraProfile | undefined> {
  return (await listLoraProfiles()).find((row) => row.loraId === loraId)
}
let writeQueue: Promise<unknown> = Promise.resolve()
export function saveLoraProfile(input: LoraProfile): Promise<LoraProfile> {
  const profile = schemas.loraProfilesSave.parse(input)
  const task = writeQueue.then(async () => {
    const rows = await listLoraProfiles()
    const existing = rows.find((row) => row.loraId === profile.loraId)
    const merged = { ...existing, ...profile }
    await mkdir(dirname(paths.loraProfiles()), { recursive: true })
    await writeFileAtomic(paths.loraProfiles(), JSON.stringify([...rows.filter((row) => row.loraId !== profile.loraId), merged], null, 2))
    return merged
  })
  writeQueue = task.catch(() => undefined)
  return task
}
export async function mergeLoraMeta<T extends { id: string }>(item: T, filePath?: string): Promise<T & LoraMetadata> {
  let extracted: LoraMetadata = {}
  if (filePath) {
    try {
      extracted = await extractSafetensorsTriggers(filePath)
    } catch {
      /* Inventory remains usable for legacy or malformed files. */
    }
  }
  const profile = await getLoraProfile(item.id)
  return { ...item, ...sanitizeLoraMetadata(item), ...extracted, ...sanitizeLoraMetadata(profile) }
}
