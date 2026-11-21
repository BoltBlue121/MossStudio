import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { paths } from '@main/lib/paths'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { extractSafetensorsTriggers, saveLoraProfile, mergeLoraMeta, listLoraProfiles } from '@main/services/loraProfiles'

useTempDataRoot()
it.each(['{broken', '{}', '[{"loraId":4}]'])('ignores corrupt optional profiles: %s', async (contents) => {
  await mkdir(paths.root(), { recursive: true })
  await writeFile(paths.loraProfiles(), contents)
  await expect(listLoraProfiles()).resolves.toEqual([])
  await expect(mergeLoraMeta({ id: 'style' })).resolves.toEqual({ id: 'style' })
})
it('extracts only bounded header metadata, ranks suggestions and honors saved overrides', async () => {
  await mkdir(paths.root(), { recursive: true })
  const file = join(paths.root(), 'style.safetensors')
  const header = Buffer.from(
    JSON.stringify({
      __metadata__: { 'modelspec.trigger_word': 'header, exact', ss_tag_frequency: JSON.stringify({ a: { suggested: 10, other: 2 } }) },
    }),
  )
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(BigInt(header.length))
  await writeFile(file, Buffer.concat([length, header]))
  await writeFile(file.replace('.safetensors', '.txt'), 'sidecar')
  expect(await extractSafetensorsTriggers(file)).toEqual({ triggers: ['header', 'exact'], suggestedTriggers: ['suggested', 'other'] })
  await Promise.all([
    saveLoraProfile({ loraId: 'style', triggers: ['manual'], autoInsert: 'prefix' }),
    saveLoraProfile({ loraId: 'other', triggers: [] }),
  ])
  expect(await listLoraProfiles()).toHaveLength(2)
  expect(await mergeLoraMeta({ id: 'style' }, file)).toMatchObject({
    triggers: ['manual'],
    autoInsert: 'prefix',
    suggestedTriggers: ['suggested', 'other'],
  })
})
it('rejects oversized or truncated headers without reading weights', async () => {
  await mkdir(paths.root(), { recursive: true })
  const file = join(paths.root(), 'bad.safetensors')
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(16n * 1024n * 1024n + 1n)
  await writeFile(file, length)
  await expect(extractSafetensorsTriggers(file)).rejects.toThrow()
  length.writeBigUInt64LE(100n)
  await writeFile(file, length)
  await expect(extractSafetensorsTriggers(file)).rejects.toThrow()
})
it('uses sidecars in priority order when the header has no triggers', async () => {
  await mkdir(paths.root(), { recursive: true })
  const file = join(paths.root(), 'side.safetensors')
  const header = Buffer.from('{}')
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(BigInt(header.length))
  await writeFile(file, Buffer.concat([length, header]))
  await writeFile(file.replace('.safetensors', '.civitai.info'), JSON.stringify({ trainedWords: ['Civitai'] }))
  await writeFile(file.replace('.safetensors', '.json'), JSON.stringify({ triggers: ['json'] }))
  expect((await extractSafetensorsTriggers(file)).triggers).toEqual(['Civitai'])
})
