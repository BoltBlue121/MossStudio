import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentCreateSessionInput, AgentDriver } from '@shared/agentHub'
import { createAgentHub } from '../../../src/main/agentHub/hub'

function fakeDriver(seen: AgentCreateSessionInput[]): AgentDriver {
  const unused = async (): Promise<never> => {
    throw new Error('not used in this test')
  }
  return {
    id: 'codex-acp',
    probe: unused,
    connect: unused,
    disconnect: async () => undefined,
    listSessions: async () => [],
    async createSession(input) {
      seen.push(input)
      return { sessionId: 'new-session' }
    },
    readMessages: unused,
    send: unused,
    stop: unused,
    models: unused,
    setModel: unused,
  }
}

let directory = ''
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = ''
})

describe('agent hub createSession', () => {
  it('creates the new project folder before the Agent starts in it', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent-hub-'))
    const folder = join(directory, 'projects', 'poster')
    const seen: AgentCreateSessionInput[] = []
    const hub = createAgentHub([fakeDriver(seen)])
    await expect(hub.createSession({ backendId: 'codex-acp', cwd: folder, createCwd: true, title: 'T' })).resolves.toEqual({
      sessionId: 'new-session',
    })
    expect((await stat(folder)).isDirectory()).toBe(true)
    expect(seen).toEqual([{ backendId: 'codex-acp', cwd: folder, title: 'T' }])
  })

  it('leaves an existing folder alone when no new one was asked for', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent-hub-'))
    const folder = join(directory, 'missing')
    const seen: AgentCreateSessionInput[] = []
    await createAgentHub([fakeDriver(seen)]).createSession({ backendId: 'codex-acp', cwd: folder })
    await expect(stat(folder)).rejects.toThrow()
    expect(seen).toEqual([{ backendId: 'codex-acp', cwd: folder }])
  })

  it('refuses a relative folder or one that climbs out with ..', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent-hub-'))
    const seen: AgentCreateSessionInput[] = []
    const hub = createAgentHub([fakeDriver(seen)])
    await expect(hub.createSession({ backendId: 'codex-acp', cwd: 'relative/poster', createCwd: true })).rejects.toThrow(
      '新项目文件夹必须是完整路径',
    )
    await expect(hub.createSession({ backendId: 'codex-acp', cwd: `${directory}/../escape`, createCwd: true })).rejects.toThrow(
      '新项目文件夹的路径不能包含 ..',
    )
    await expect(hub.createSession({ backendId: 'codex-acp', cwd: `/${'a'.repeat(4100)}`, createCwd: true })).rejects.toThrow(
      '新项目文件夹的路径无效',
    )
    await expect(stat(join(directory, '..', 'escape'))).rejects.toThrow()
    expect(seen).toEqual([])
  })
})

describe('agent hub default backend', () => {
  const probing = (id: string, available: boolean): AgentDriver => ({
    ...fakeDriver([]),
    id,
    probe: async () => ({ id, label: id, kind: 'acp', available, connected: false }),
  })
  const preferred = async (codex: boolean, dsh: boolean) =>
    (await createAgentHub([probing('codex-acp', codex), probing('dsh-desktop', dsh), probing('custom-acp', true)]).backends()).find(
      (b) => b.preferred,
    )?.id

  it('keeps the first Agent found the default, and never the custom command', async () => {
    expect(await preferred(true, true)).toBe('codex-acp')
    expect(await preferred(false, true)).toBe('dsh-desktop')
    expect(await preferred(false, false)).toBeUndefined()
  })
})
