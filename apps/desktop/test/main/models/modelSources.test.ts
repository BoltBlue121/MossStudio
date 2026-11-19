import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'
import { installerLogLocations, terminalInstallations } from '@main/services/modelSourceDiscovery'
import { comfyModelPaths, findModelSources, guessModelSourceKind, sourceRoots } from '@main/services/modelSourcePaths'
import { probeLocalModelServices } from '@main/services/modelSourceServices'
import {
  addModelSource,
  modelSourcesView,
  refreshModelSources,
  restoreModelSources,
  resolveSharedWeight,
  sharedModels,
  sharedAdapters,
  sharedControlAdapters,
} from '@main/services/modelSources'

const mocks = vi.hoisted(() => ({ server: null as string | null, inspect: vi.fn(), discover: vi.fn() }))
vi.mock('@main/services/modelSourcePaths', async (load) => ({
  ...(await load<typeof import('@main/services/modelSourcePaths')>()),
  nearbyModelSources: mocks.discover,
}))
vi.mock('@main/services/engineInstalls', () => ({ localServerPath: () => mocks.server }))
vi.mock('@main/lib/probeEngine', () => ({
  withEngineRequests: async (server: string, task: (request: (method: string, params: unknown) => Promise<unknown>) => Promise<unknown>) =>
    task((method, params) => mocks.inspect(server, method, params)),
}))

const temp = useTempDir('moss-shared-sources-')

describe('共享目录路径', () => {
  it('从历史和安装日志提取产品路径，不把原始记录当成路径', () => {
    const base = temp()
    const home = join(base, '主页')
    const renamed = join(base, '自定义名称')
    const history = [
      "cd '" + base + "'",
      'git clone https://github.com/Comfy-Org/ComfyUI.git "自定义名称"',
      'echo something unrelated',
      "Set-Location -LiteralPath '" + renamed + "'",
      'python main.py',
      "python '" + join(base, '另一个工具', 'webui.py') + "'",
    ].join('\n')
    expect(terminalInstallations(history, home)).toEqual([join(base, '另一个工具'), renamed])
    expect(
      installerLogLocations(String.raw`[Installer] Extracted "D:\AI\ComfyUI\resources\app.asar"
[Installer] Extracted "D:\AI\Unrelated\config.json"
[Installer] Installed "E:\工具\sd-webui-forge-classic\webui.bat"`),
    ).toEqual([String.raw`E:\工具\sd-webui-forge-classic`, String.raw`D:\AI\ComfyUI`])
  })

  it('用本机服务响应识别 ComfyUI 和未开启 API 的 WebUI', async () => {
    const path = join(temp(), '自定义名称')
    const hosts = [
      createServer((_, response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ system: { comfyui_version: 'fixture', argv: [join(path, 'main.py')] }, devices: [] }))
      }),
      createServer((request, response) => {
        if (request.url !== '/') {
          response.writeHead(404).end()
          return
        }
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<title>Stable Diffusion</title><script>window.gradio_config = {}</script>')
      }),
    ]
    try {
      const ports = await Promise.all(
        hosts.map(
          (host) =>
            new Promise<number>((resolve, reject) => {
              host.once('error', reject)
              host.listen(0, '127.0.0.1', () => {
                const address = host.address()
                if (address && typeof address === 'object') resolve(address.port)
                else reject(new Error('未获得本机测试端口'))
              })
            }),
        ),
      )
      expect(await probeLocalModelServices(ports)).toEqual([
        { kind: 'comfyui', port: ports[0], paths: [path] },
        { kind: 'webui', port: ports[1], paths: [] },
      ])
    } finally {
      for (const host of hosts) {
        host.close()
        host.closeAllConnections()
      }
    }
  })

  it('在限定位置识别改名的源码、便携包和整合包，排除备份及同名非程序目录', async () => {
    const location = join(temp(), '下载')
    const clone = join(location, '绘画工具')
    const portable = join(location, '免安装', 'ComfyUI')
    const forge = join(location, '图像整合包', 'sd-webui-forge-classic')
    const backup = join(location, 'ComfyUI_backup')
    const falseHit = join(location, 'ComfyUI-资料')
    const registered = join(temp(), '任意安装目录', 'Stable')
    const outOfScope = join(temp(), '其他', '手动接入')
    for (const path of [clone, portable, forge, backup, falseHit, registered, outOfScope]) {
      await mkdir(join(path, 'models'), { recursive: true })
    }
    for (const path of [clone, portable, backup, outOfScope]) {
      await writeFile(join(path, 'main.py'), '')
      await writeFile(join(path, 'folder_paths.py'), '')
    }
    for (const path of [forge, registered]) {
      await writeFile(join(path, 'launch.py'), '')
      await writeFile(join(path, 'webui.py'), '')
    }
    await mkdir(join(forge, 'modules_forge'))
    const found = await findModelSources([location], [registered, portable], [])
    expect(found).toHaveLength(4)
    expect(found).toEqual(
      expect.arrayContaining([
        { path: registered, kind: 'webui' },
        { path: clone, kind: 'comfyui' },
        { path: join(location, '免安装'), kind: 'comfyui' },
        { path: join(location, '图像整合包'), kind: 'forge' },
      ]),
    )
    expect(await guessModelSourceKind(join(clone, 'models'))).toBe('comfyui')
    expect(await guessModelSourceKind(join(forge, 'models'))).toBe('forge')
    expect(await guessModelSourceKind(outOfScope)).toBe('comfyui')
  })

  it('选择 ComfyUI 的 models 仍会读取安装旁的额外配置', async () => {
    const base = temp()
    const primary = join(base, 'models')
    const extras = join(base, '外部权重')
    await Promise.all([primary, extras].map((path) => mkdir(path)))
    await writeFile(join(base, 'extra_model_paths.yaml'), 'shared:\n  loras: 外部权重\n')
    expect(await guessModelSourceKind(primary)).toBe('comfyui')
    const result = await sourceRoots({ kind: 'comfyui', path: primary }, [])
    expect(result.roots).toEqual([primary, extras])
    expect(result.roles.get(extras)).toBe('lora')
  })

  it('读取 Forge 与 WebUI 的默认目录和启动参数里的外置目录，无需执行脚本', async () => {
    const base = temp()
    const webui = join(base, 'webui')
    const models = join(webui, 'models')
    const checkpoint = join(base, '主模型文件')
    const loras = join(webui, '素材 库')
    const vae = join(webui, '附加组件')
    await Promise.all([models, checkpoint, loras, vae].map((path) => mkdir(path, { recursive: true })))
    await writeFile(
      join(webui, 'webui-user.bat'),
      '@echo off\nset "COMMANDLINE_ARGS=--ckpt-dir "' + checkpoint + '" --lora-dir="素材 库" --vae-dir "%~dp0附加组件""\n',
    )
    for (const kind of ['forge', 'webui'] as const) {
      const result = await sourceRoots({ kind, path: base }, [])
      expect(result.roots).toEqual([models, checkpoint, loras, vae])
      expect(result.roles.get(loras)).toBe('lora')
      expect(result.roles.get(checkpoint)).toBe('dit')
      expect(result.issues).toEqual([])
    }
  })

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

  it('识别新版 Comfy Desktop 的安装目录并读到对应用户配置', async () => {
    const base = temp()
    const desktop = join(base, '下载', '自定义桌面安装')
    const profile = join(base, 'comfyui-desktop-2')
    const models = join(base, '模型库')
    await Promise.all([join(desktop, 'resources'), profile, models].map((path) => mkdir(path, { recursive: true })))
    await writeFile(join(desktop, 'Comfy Desktop.exe'), '')
    await writeFile(join(desktop, 'resources', 'app.asar'), '')
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ modelsDirs: [models] }))
    expect(await findModelSources([join(base, '下载')], [], [profile])).toEqual([{ kind: 'comfyui', path: desktop }])
    expect((await sourceRoots({ kind: 'comfyui', path: desktop }, [profile])).roots).toEqual([models])
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

  it('第一次发现后复用候选缓存，手动扫描才更新结果和在线服务', async () => {
    const settings = settingsFixture()
    const first = { path: join(temp(), '首个来源'), kind: 'comfyui' }
    const second = { path: join(temp(), '下一个来源'), kind: 'forge' }
    mocks.discover.mockReset()
    mocks.discover.mockResolvedValueOnce({ sources: [first] })
    mocks.discover.mockResolvedValueOnce({ sources: [first, second], services: [{ kind: 'comfyui', port: 8188 }] })
    expect((await modelSourcesView(settings)).suggestions).toMatchObject([first])
    expect((await modelSourcesView(settings)).suggestions).toMatchObject([first])
    expect(mocks.discover.mock.calls).toEqual([[false]])
    const fresh = await modelSourcesView(settings, 'scan')
    expect(fresh.suggestions).toMatchObject([first, second])
    expect(fresh.services).toEqual([{ kind: 'comfyui', port: 8188 }])
    const reopened = await modelSourcesView(settings)
    expect(reopened.suggestions).toMatchObject([first, second])
    expect(reopened.services).toBeUndefined()
    expect(mocks.discover.mock.calls).toEqual([[false], [true]])
    const cache = await readFile(join(data(), 'cache', 'model-source-discovery.json'), 'utf8')
    expect(JSON.parse(cache)).toEqual({ sources: [first, second] })
  })

  it('允许手动添加两套同类软件，更换路径只更新指定来源', async () => {
    const roots = ['Comfy One', 'Comfy Two', 'Comfy Three'].map((name) => join(temp(), name))
    await Promise.all(roots.map((root) => mkdir(join(root, 'models'), { recursive: true })))
    const first = (await addModelSource(roots[0]!, 'comfyui')).modelSources![0]!
    const combined = (await addModelSource(roots[1]!, 'comfyui')).modelSources!
    expect(combined.map((source) => source.path)).toEqual(roots.slice(0, 2))
    expect(combined[1]!.id).not.toBe(first.id)
    const changed = (await addModelSource(roots[2]!, 'comfyui', first.id)).modelSources!
    expect(changed).toEqual([{ ...first, path: roots[2] }, combined[1]])
  })

  it('重新启动用原清单，只有手动扫描才发现新文件', async () => {
    const root = join(temp(), '共享')
    const server = join(temp(), 'moss-server')
    const old = join(root, 'old.safetensors')
    const added = join(root, 'added.safetensors')
    await mkdir(root)
    await writeFile(server, 'engine')
    await writeFile(old, 'weight')
    mocks.server = server
    mocks.inspect.mockClear()
    mocks.inspect.mockResolvedValue({ kind: 'dit', loadable: true })
    const settings = settingsFixture({
      modelsRoot: join(temp(), '内置'),
      modelSources: [{ id: 'source', kind: 'custom', path: root }],
    })
    await refreshModelSources(settings)
    await writeFile(added, 'new weight')
    await restoreModelSources(settings)
    expect(sharedModels([]).map((file) => file.name)).toEqual(['old.safetensors'])
    expect(mocks.inspect).toHaveBeenCalledTimes(1)
    await refreshModelSources(settings)
    expect(
      sharedModels([])
        .map((file) => file.name)
        .sort(),
    ).toEqual(['added.safetensors', 'old.safetensors'])
    expect(mocks.inspect).toHaveBeenCalledTimes(2)
    mocks.inspect.mockClear()
  })

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
  it('保留共享 LoRA 文件名并区分可用、待检查和不兼容', async () => {
    const base = temp()
    const root = join(base, '应用')
    const folder = join(base, '自定义命名')
    const server = join(base, 'moss-server')
    await Promise.all([root, folder].map((path) => mkdir(path)))
    await writeFile(join(root, 'extra_model_paths.yaml'), 'shared:\n  loras: ../自定义命名\n')
    await writeFile(server, 'engine')
    for (const name of ['ready.safetensors', 'unavailable.safetensors', 'pending.safetensors']) {
      await writeFile(join(folder, name), 'weight')
    }
    mocks.server = server
    mocks.inspect.mockImplementation(async (_server: string, _method: string, { path }: { path: string }) => {
      if (path.endsWith('pending.safetensors')) throw new Error('引擎暂不可用')
      return { kind: 'lora', loadable: path.endsWith('ready.safetensors') }
    })
    const settings = settingsFixture({
      modelsRoot: join(base, 'moss-studio'),
      modelSources: [{ id: 'lora', kind: 'comfyui', path: root }],
    })
    await refreshModelSources(settings)
    const [status] = (await modelSourcesView(settings, 'connected')).sources
    expect(status).toMatchObject({ available: 1, pending: 1, incompatible: 1 })
    expect(status?.files).toEqual(
      expect.arrayContaining([
        { path: join(folder, 'ready.safetensors'), name: 'ready.safetensors', size: 6, role: 'lora', state: 'available' },
        { path: join(folder, 'pending.safetensors'), name: 'pending.safetensors', size: 6, role: 'lora', state: 'pending' },
        { path: join(folder, 'unavailable.safetensors'), name: 'unavailable.safetensors', size: 6, role: 'lora', state: 'incompatible' },
      ]),
    )
    expect(sharedAdapters().map(({ name }) => name)).toEqual(['ready.safetensors'])
    mocks.inspect.mockClear()
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
