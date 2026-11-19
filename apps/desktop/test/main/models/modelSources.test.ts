import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'
import { comfyModelPaths, sourceRoots } from '@main/services/modelSourcePaths'
import { refreshModelSources, resolveSharedWeight, sharedModels, sharedAdapters, sharedControlAdapters } from '@main/services/modelSources'

const mocks = vi.hoisted(() => ({ server: null as string | null, inspect: vi.fn() }))
vi.mock('@main/services/engineInstalls', () => ({ localServerPath: () => mocks.server }))
vi.mock('@main/lib/probeEngine', () => ({
  withEngineRequests: async (server: string, task: (request: (method: string, params: unknown) => Promise<unknown>) => Promise<unknown>) =>
    task((method, params) => mocks.inspect(server, method, params)),
}))

const temp = useTempDir('moss-shared-sources-')

describe('共享目录路径', () => {
  it('同时解析默认目录、额外配置、相对路径及 YAML 多行值', async () => {
    const parent = temp()
    const base = join(parent, '便携版')
    const comfy = join(base, 'ComfyUI')
    const primary = join(comfy, 'models')
    const a = join(base, '共享模型', 'unet')
    const b = join(base, '共享模型', 'extra dit')
    await Promise.all([primary, a, b].map((path) => mkdir(path, { recursive: true })))
    await writeFile(
      join(comfy, 'extra_model_paths.yaml'),
      'studio:\n  base_path: ../共享模型\n  diffusion_models: |\n    unet\n    extra dit\n  custom_nodes: .\n',
    )
    const outcome = await sourceRoots({ kind: 'comfyui', path: base })
    expect(outcome.roots).toEqual([primary, a, b])
    expect(outcome.issues).toEqual([])
  })

  it('保留默认模型目录并报告损坏的额外配置', async () => {
    const primary = join(temp(), 'models')
    await mkdir(primary)
    await writeFile(join(temp(), 'extra_model_paths.yaml'), 'models: [')
    const result = await sourceRoots({ kind: 'comfyui', path: temp() })
    expect(result.roots).toEqual([primary])
    expect(result.issues).toEqual([expect.stringContaining('配置格式有误')])
  })

  it('读取 Comfy Desktop 配置及 WebUI 和 Forge 整合包的模型目录', async () => {
    const base = temp()
    const managed = join(base, 'comfyui-desktop-2')
    const shared = join(base, '库')
    const models = join(base, 'webui', 'models')
    await Promise.all([managed, shared, models].map((path) => mkdir(path, { recursive: true })))
    await writeFile(join(managed, 'settings.json'), JSON.stringify({ modelsDirs: [shared] }))
    expect((await sourceRoots({ kind: 'comfyui', path: managed })).roots).toEqual([shared])
    expect((await sourceRoots({ kind: 'forge', path: base })).roots).toEqual([models])
    expect((await sourceRoots({ kind: 'webui', path: base })).roots).toEqual([models])
    expect(comfyModelPaths(join(base, 'extra.yaml'), 'one:\n  clip: ./库\n')).toEqual([shared])
  })
})

describe('共享模型索引', () => {
  const data = useTempDataRoot()

  it('识别具备运行配置的完整 Diffusers 模型并直接返回文件夹路径', async () => {
    const base = temp()
    const root = join(base, '完整模型')
    const paths = ['transformer', 'text_encoder', 'vae', 'scheduler', 'tokenizer']
    await Promise.all(paths.map((path) => mkdir(join(root, path), { recursive: true })))
    await writeFile(join(root, 'model_index.json'), JSON.stringify({ _class_name: 'MOSSImagePipeline' }))
    await writeFile(join(root, 'pipeline_moss_image.py'), 'configuration')
    await writeFile(join(root, 'scheduler', 'scheduler_config.json'), '{}')
    await writeFile(join(root, 'tokenizer', 'tokenizer_config.json'), '{}')
    await writeFile(join(root, 'tokenizer', 'tokenizer.json'), '{}')
    for (const part of paths.slice(0, 3)) {
      await writeFile(join(root, part, 'config.json'), '{}')
      await writeFile(join(root, part, 'model.safetensors'), 'fixture')
    }
    mocks.server = null
    const settings = settingsFixture({ modelsRoot: join(base, 'moss-studio'), modelSources: [{ id: 'full', kind: 'custom', path: root }] })
    await refreshModelSources(settings)
    const model = sharedModels([])[0]!
    expect(model.role).toBe('full')
    expect(await resolveSharedWeight(model.id)).toBe(root)
  })
  it('在原路径复用权重，去重，并在断开后恢复相同的 ID', async () => {
    const base = temp()
    const root = join(base, '用户目录')
    const sub = join(root, 'weights')
    const server = join(base, 'moss-server')
    await mkdir(sub, { recursive: true })
    await writeFile(server, 'engine')
    const weight = join(sub, '主模型.safetensors')
    await writeFile(weight, 'existing bytes')
    const lo = join(sub, 'lo.safetensors')
    const ctrl = join(sub, 'ctrl.safetensors')
    for (const file of [lo, ctrl]) await writeFile(file, 'existing bytes')
    await symlink(sub, join(root, 'linked'), 'junction')

    mocks.server = server
    mocks.inspect.mockImplementation(async (_server: string, _command: string, { path }: { path: string }) => ({
      kind: path === weight ? 'dit' : path === lo ? 'lora' : 'control_adapter',
      precision: 'int8',
      loadable: true,
      control_kinds: ['depth'],
    }))
    const settings = settingsFixture({
      modelsRoot: join(base, 'moss-studio'),
      modelSources: [
        { id: 'a', kind: 'custom', path: root },
        { id: 'b', kind: 'custom', path: sub },
      ],
    })
    await refreshModelSources(settings)
    expect(mocks.inspect).toHaveBeenCalledTimes(3)
    expect(await readFile(join(data(), 'cache', 'shared-models.json'), 'utf8')).toContain('mtimeMs')
    expect(sharedModels([])).toHaveLength(1)
    expect(sharedAdapters()).toHaveLength(1)
    expect(sharedControlAdapters()).toHaveLength(1)
    const id = sharedModels([])[0]!.id
    expect(await resolveSharedWeight(id)).toBe(weight)

    const moved = join(base, '临时拔掉')
    await rename(root, moved)
    expect(await resolveSharedWeight(id)).toBeNull()
    await refreshModelSources(settings)
    expect(sharedModels([])).toEqual([])
    await rename(moved, root)
    await refreshModelSources(settings)
    expect(sharedModels([])[0]!.id).toBe(id)
    expect(await readFile(weight, 'utf8')).toBe('existing bytes')
  })
})
