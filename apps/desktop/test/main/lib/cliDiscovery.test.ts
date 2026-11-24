import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { findCli } from '@main/lib/cliDiscovery'
import { useTempDir } from '@test/helpers/tempDir'

const temp = useTempDir()

it('finds native Claude Code under the Windows user profile without PATH', () => {
  const profile = join(temp(), 'user profile')
  const bin = join(profile, '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  const cli = join(bin, 'claude.exe')
  writeFileSync(cli, '')
  const search = { platform: 'win32' as const, home: temp(), env: { USERPROFILE: profile } }
  expect(findCli('claude', search)).toEqual({ kind: 'ready', path: cli })

  // Adding the native fallback must not switch an existing Volta installation.
  const volta = join(temp(), '.volta', 'bin')
  mkdirSync(volta, { recursive: true })
  writeFileSync(join(volta, 'claude.exe'), '')
  expect(findCli('claude', search)).toEqual({ kind: 'ready', path: join(volta, 'claude.exe') })
})
