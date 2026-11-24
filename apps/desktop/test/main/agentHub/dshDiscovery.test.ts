import { afterEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({ lstat: vi.fn(), readlink: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  fs.lstat.mockImplementation(actual.lstat)
  fs.readlink.mockImplementation(actual.readlink)
  return { ...actual, ...fs, default: { ...actual, ...fs } }
})
const run = vi.hoisted(() => vi.fn())
vi.mock('@main/lib/run', async (importOriginal) => ({ ...(await importOriginal<typeof import('@main/lib/run')>()), run }))

import { chmodSync, linkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopListeners, desktopPids, pairingFor } from '@main/agentHub/dshDiscovery'
import { useTempDataRoot } from '@test/helpers/tempDir'

const platform = process.platform
const onPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value })
afterEach(() => {
  onPlatform(platform)
  run.mockReset()
})
const output = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false })

describe('desktopPids', () => {
  it('matches the desktop app and its helpers by name, and marks Linux names cut to 15 characters', () => {
    const ps = [
      '  101 /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      '  102 /Applications/DeepSeek Harness.app/Contents/Frameworks/DeepSeek Harness Helper (Plugin).app/Contents/MacOS/DeepSeek Harness Helper (Plugin)',
      '  201 deepseek-harnes',
      '  202 DeepSeek Harnes',
      '  301 deepseek-harness-x',
      '  302 bash',
      'garbage',
    ].join('\n')
    expect(desktopPids(ps)).toEqual([
      { pid: 101, exact: true },
      { pid: 102, exact: true },
      { pid: 201, exact: false },
      { pid: 202, exact: false },
    ])
  })
})

describe('desktopListeners', () => {
  it('on Linux, confirms a cut name by its executable and keeps only loopback listeners', async () => {
    onPlatform('linux')
    fs.readlink.mockImplementation(async (path: string) => {
      if (path === '/proc/201/exe') return '/opt/DeepSeek Harness/deepseek-harness'
      if (path === '/proc/202/exe') return '/usr/bin/impostor'
      throw new Error('EACCES')
    })
    run.mockImplementation(async (command: string) =>
      output(
        command === 'ps'
          ? '  201 deepseek-harnes\n  202 deepseek-harnes\n  203 deepseek-harnes\n'
          : 'p201\nf20\nn127.0.0.1:52497\nn*:6000\nn0.0.0.0:7000\nn192.168.1.2:8000\nn[::1]:52498\n',
      ),
    )
    expect(await desktopListeners(new AbortController().signal)).toEqual([
      { pid: 201, origin: 'http://127.0.0.1:52497' },
      { pid: 201, origin: 'http://[::1]:52498' },
    ])
    expect(run).toHaveBeenLastCalledWith('lsof', ['-nP', '-a', '-p', '201', '-iTCP', '-sTCP:LISTEN', '-Fpn'], expect.anything())
  })

  it('asks for no sockets when no process is the desktop app', async () => {
    onPlatform('linux')
    fs.readlink.mockRejectedValue(new Error('EACCES'))
    run.mockResolvedValue(output('  201 deepseek-harnes\n  302 bash\n'))
    expect(await desktopListeners(new AbortController().signal)).toEqual([])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('on Windows, reads PowerShell rows and drops anything not on loopback', async () => {
    onPlatform('win32')
    run.mockResolvedValue(output('101 127.0.0.1 52497\r\n101 0.0.0.0 6000\r\n102 ::1 52498\r\nbad\r\n'))
    expect(await desktopListeners(new AbortController().signal)).toEqual([
      { pid: 101, origin: 'http://127.0.0.1:52497' },
      { pid: 102, origin: 'http://[::1]:52498' },
    ])
    expect(run.mock.calls[0]![0]).toBe('powershell.exe')
  })
})

describe.runIf(platform !== 'win32')('pairingFor', () => {
  const dir = useTempDataRoot()
  const listeners = [{ pid: 101, origin: 'http://127.0.0.1:52497' }]
  const url = 'http://127.0.0.1:52497/?token=abc'
  const write = (row: object, mode = 0o600, name = 'dsh-desktop-live.json') => {
    const path = join(dir(), name)
    writeFileSync(path, JSON.stringify(row))
    chmodSync(path, mode)
    return path
  }
  const live = { version: 1, pid: 101, pairingUrl: url }

  it('reads the pairing address of the running desktop app from a private file', async () => {
    write(live)
    expect(await pairingFor(listeners)).toBe(url)
  })

  it('refuses a file others can read, a hard link and a symlink', async () => {
    const path = write(live, 0o644)
    expect(await pairingFor(listeners)).toBeUndefined()
    chmodSync(path, 0o600)
    linkSync(path, join(dir(), 'link.json'))
    expect(await pairingFor(listeners)).toBeUndefined()
    unlinkSync(join(dir(), 'link.json'))
    expect(await pairingFor(listeners)).toBe(url)
    renameSync(path, join(dir(), 'elsewhere.json'))
    symlinkSync(join(dir(), 'elsewhere.json'), path)
    expect(await pairingFor(listeners)).toBeUndefined()
  })

  it('refuses a file replaced between the check and the read', async () => {
    const path = write(live)
    const swap = write(live, 0o600, 'swap.json')
    fs.lstat.mockImplementationOnce(async (target: string) => {
      const before = await lstat(target)
      renameSync(swap, path)
      return before
    })
    expect(await pairingFor(listeners)).toBeUndefined()
  })

  it('refuses another process, another port, a remote address and an unknown version', async () => {
    for (const row of [
      { ...live, pid: 202 },
      { ...live, pairingUrl: 'http://127.0.0.1:1/?token=abc' },
      { ...live, pairingUrl: 'http://10.0.0.5:52497/?token=abc' },
      { ...live, version: 2 },
    ]) {
      write(row)
      expect(await pairingFor(listeners)).toBeUndefined()
    }
  })
})
