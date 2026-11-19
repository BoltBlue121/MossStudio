import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { ModelSource, ModelSourceKind } from '@shared/types'

const modelKeys = new Set([
  'checkpoints',
  'diffusion_models',
  'unet',
  'text_encoders',
  'text_encoder',
  'clip',
  'vae',
  'loras',
  'lora',
  'lycoris',
  'diffusers',
  'controlnet',
])
const configNames = ['extra_model_paths.yaml', 'extra_models_config.yaml']

export function modelPathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

async function readConfig(file: string): Promise<string> {
  const info = await stat(file)
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('配置文件不可读或太大')
  return readFile(file, 'utf8')
}

function expandBase(path: string): string {
  return path
    .replace(/^~(?=$|[\\/])/, homedir())
    .replace(
      /\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z_0-9]*)|%([^%]+)%/g,
      (match: string, braced?: string, plain?: string, windows?: string) => process.env[braced ?? plain ?? windows ?? ''] ?? match,
    )
}

export function comfyModelPaths(file: string, yaml: string): string[] {
  const result: string[] = []
  for (const section of Object.values(record(parseYaml(yaml, { maxAliasCount: 20 })))) {
    const config = record(section)
    const base = typeof config.base_path === 'string' ? resolve(dirname(file), expandBase(config.base_path)) : dirname(file)
    for (const [key, value] of Object.entries(config)) {
      if (!modelKeys.has(key) || typeof value !== 'string') continue
      for (const line of value.split(/\r?\n/)) {
        if (line.trim()) result.push(resolve(base, line.trim()))
      }
    }
  }
  return result
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

export async function sourceRoots(source: Pick<ModelSource, 'kind' | 'path'>): Promise<{ roots: string[]; issues: string[] }> {
  const roots: string[] = []
  const issues: string[] = []
  const info = await stat(source.path).catch(() => null)
  if (!info) return { roots, issues: ['找不到此位置，请检查磁盘连接或更换路径'] }
  const configs: string[] = []
  if (info.isFile() && source.kind === 'comfyui') {
    configs.push(source.path)
  } else if (info.isDirectory()) {
    if (source.kind === 'custom' || /^models$/i.test(basename(source.path))) roots.push(source.path)
    else {
      const nested = source.kind === 'comfyui' ? 'ComfyUI' : 'webui'
      for (const base of [source.path, join(source.path, nested)]) {
        const models = join(base, 'models')
        if (await exists(models)) roots.push(models)
        if (source.kind === 'comfyui') {
          for (const name of configNames) {
            const file = join(base, name)
            if (await exists(file)) configs.push(file)
          }
        }
      }
      if (source.kind === 'comfyui') {
        const desktopSettings = /comfyui-desktop-2$/i.test(basename(source.path)) ? 'settings.json' : 'config.json'
        const file = join(source.path, desktopSettings)
        if (await exists(file)) configs.push(file)
      }
      if (!roots.length && !configs.length) roots.push(source.path)
    }
  } else {
    issues.push('请选择模型目录或 ComfyUI 的模型配置文件')
  }

  for (const file of configs) {
    try {
      const contents = await readConfig(file)
      if (/\.ya?ml$/i.test(file)) roots.push(...comfyModelPaths(file, contents))
      else {
        const config = record(JSON.parse(contents))
        if (Array.isArray(config.modelsDirs)) {
          roots.push(...config.modelsDirs.filter((path): path is string => typeof path === 'string' && isAbsolute(path)))
        }
        if (typeof config.basePath === 'string' && isAbsolute(config.basePath)) roots.push(join(config.basePath, 'models'))
      }
    } catch {
      issues.push('读不到配置文件，或配置格式有误：' + file)
    }
  }

  const unique = new Map<string, string>()
  for (const path of new Set(roots)) {
    try {
      const actual = await realpath(path)
      if (!(await stat(actual)).isDirectory()) throw new Error()
      unique.set(modelPathKey(actual), actual)
    } catch {
      issues.push('读不到模型目录：' + path)
    }
  }
  if (!unique.size && !issues.length) issues.push('这个位置没有配置模型目录')
  return { roots: [...unique.values()], issues }
}

export async function guessModelSourceKind(path: string): Promise<ModelSourceKind> {
  if (/\.(?:yaml|yml|json)$/i.test(path) || /comfy/i.test(path)) return 'comfyui'
  if (/forge/i.test(path)) return 'forge'
  if (/webui/i.test(path)) return 'webui'
  if (await exists(join(path, 'folder_paths.py'))) return 'comfyui'
  if (await exists(join(path, 'launch.py'))) return 'webui'
  return 'custom'
}

export async function nearbyModelSources(): Promise<Array<Pick<ModelSource, 'kind' | 'path'>>> {
  const home = homedir()
  const config =
    process.platform === 'win32'
      ? process.env.APPDATA
      : process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? join(home, '.config'))
  const candidates: Array<Pick<ModelSource, 'kind' | 'path'>> = config
    ? ['ComfyUI', 'comfyui-desktop-2'].map((name) => ({ kind: 'comfyui', path: join(config, name) }))
    : []
  const places = [home, join(home, 'Documents'), join(home, 'Downloads'), parse(home).root]
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) places.push(join(process.env.LOCALAPPDATA, 'Programs'))
    places.push(...['D:\\', 'E:\\', 'F:\\'])
  }
  const commonInstall = /^(comfyui($|[-_])|stable-diffusion-webui($|[-_])|webui[-_]forge($|[-_]))/
  for (const place of new Set(places)) {
    for (const entry of await readdir(place, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      const name = entry.name.toLowerCase()
      if (!commonInstall.test(name)) continue
      const path = join(place, entry.name)
      candidates.push({ kind: await guessModelSourceKind(name), path })
      for (const nested of await readdir(path, { withFileTypes: true }).catch(() => [])) {
        if (nested.isDirectory() && commonInstall.test(nested.name.toLowerCase())) {
          candidates.push({ kind: await guessModelSourceKind(nested.name), path: join(path, nested.name) })
        }
      }
    }
  }
  const found = await Promise.all(candidates.map(async (source) => ({ source, resolved: await sourceRoots(source) })))
  return found
    .filter(({ source, resolved }) => resolved.roots.some((root) => modelPathKey(root) !== modelPathKey(source.path)))
    .map(({ source }) => source)
}
