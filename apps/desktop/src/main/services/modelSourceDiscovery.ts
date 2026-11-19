import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { run } from '../lib/run'

interface WindowsModelLocations {
  places: string[]
  installations: string[]
  ports: number[]
}

const productName = /comfyui|comfy[-_ ]desktop|stable[-_ ]diffusion|sd[-_ ]webui|webui[-_ ]forge|(?:^|[\\/])forge(?:$|[-_ ])/i
const launchFile =
  /^(?:comfyui\.exe|comfy desktop\.exe|folder_paths\.py|launch\.py|webui\.(?:py|bat|sh)|webui-user\.(?:bat|sh)|run_(?:nvidia_gpu|cpu).*\.bat)$/i

const query = String.raw`
$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$products='(?i)comfyui|comfy[-_ ]desktop|stable[- _]diffusion|sd[-_ ]webui|webui[-_ ]forge|^forge($|[-_ ])'
$launch='(?i)^(comfyui\.exe|comfy desktop\.exe|folder_paths\.py|launch\.py|webui\.(py|bat|sh)|webui-user\.(bat|sh)|run_(nvidia_gpu|cpu).*\.bat)$'
$installations=[Collections.Generic.List[string]]::new()
$ports=[Collections.Generic.List[int]]::new()
function Add-Location($value) {
  if ($value -is [string]) {
    $path=[Environment]::ExpandEnvironmentVariables($value.Trim('"'))
    if ($path -match '^[a-zA-Z]:[\\/]') { $installations.Add($path) }
  }
}
# 仅读取卷列表，定位各卷上固定名称的安装目录。
$places=foreach ($drive in [IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady }) {
  [IO.Path]::Combine($drive.Name,'Program Files')
  [IO.Path]::Combine($drive.Name,'Program Files (x86)')
}
$places+=@([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('MyDocuments'))
@{ places=@($places|Where-Object { $_ }) } | ConvertTo-Json -Compress
foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
  Get-ItemProperty -Path $key | Where-Object DisplayName -Match $products | ForEach-Object {
    Add-Location $_.InstallLocation
  }
}
$wsh=New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Programs'),[Environment]::GetFolderPath('CommonPrograms'),[Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Recent'))) {
  if (!$folder) { continue }
  Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -File -Recurse -Depth 1 |
    Where-Object { $_.BaseName -match $products -or $_.BaseName -match $launch -or $_.BaseName -match '(?i)^webui-user$|^run_(cpu|nvidia_gpu)' } |
    Select-Object -First 80 | ForEach-Object {
      $shortcut=$wsh.CreateShortcut($_.FullName)
      Add-Location $shortcut.WorkingDirectory
      if ($shortcut.TargetPath) {
        Add-Location $shortcut.TargetPath
        Add-Location (Split-Path -Parent $shortcut.TargetPath)
      }
    }
}
$recent=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\RunMRU'
if ($recent) {
  foreach ($entry in $recent.PSObject.Properties) {
    if ($entry.Name -cmatch '^[a-z]$' -and $entry.Value -match $products) {
      $command=$entry.Value -replace '\\1$',''
      Add-Location $command
      foreach ($m in [regex]::Matches($command, '"([a-zA-Z]:[\\/][^"]+)"|([a-zA-Z]:[\\/][^\s"]+)')) {
        $candidate=$m.Groups[1].Value+$m.Groups[2].Value
        Add-Location $candidate
        Add-Location (Split-Path -Parent $candidate)
      }
    }
  }
}
@{ installations=@($installations|Select-Object -Unique) } | ConvertTo-Json -Compress
Get-CimInstance Win32_Process -Filter "Name='ComfyUI.exe' OR Name='Comfy Desktop.exe' OR Name='python.exe' OR Name='pythonw.exe'" |
  Where-Object { $_.Name -in @('ComfyUI.exe','Comfy Desktop.exe') -or $_.CommandLine -match $products -or $_.CommandLine -match '(?i)(^|[\\/\s"])(launch|webui)\.py(?=[\s"]|$)' } |
  Select-Object -First 32 | ForEach-Object {
    if ($_.ExecutablePath) {
      $directory=Split-Path -Parent $_.ExecutablePath
      for ($i=0; $i -lt 3 -and $directory; $i++) {
        Add-Location $directory
        $directory=Split-Path -Parent $directory
      }
    }
    foreach ($m in [regex]::Matches([string]$_.CommandLine,'(?i)"([a-z]:[\\/][^"]*[\\/](?:main|launch|webui)\.py)"|([a-z]:[\\/][^\s"]*[\\/](?:main|launch|webui)\.py)(?=[\s"]|$)')) {
      Add-Location (Split-Path -Parent ($m.Groups[1].Value+$m.Groups[2].Value))
    }
    if ($_.CommandLine -match '(?i)(?:^|\s)--port[=\s]+"?(\d{1,5})(?=[\s"]|$)') { $ports.Add([int]$Matches[1]) }
  }
@{ installations=@($installations|Select-Object -Unique);ports=@($ports|Select-Object -Unique) } | ConvertTo-Json -Compress
`

function absolutePaths(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && isAbsolute(item)) : []
}

export async function windowsModelLocations(): Promise<WindowsModelLocations> {
  const locations: WindowsModelLocations = { places: [], installations: [], ports: [] }
  if (process.platform !== 'win32') return locations
  try {
    const system = process.env.SystemRoot ?? process.env.WINDIR
    if (!system) return locations
    const shell = join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const encoded = Buffer.from(query, 'utf16le').toString('base64')
    const result = await run(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeoutMs: 6000 })
    // 如果较慢的进程查询超时，仍可使用已写出的安装位置和 Windows 历史。
    for (const line of result.stdout.trim().split(/\r?\n/)) {
      if (!line.startsWith('{') || !line.endsWith('}')) continue
      const data = JSON.parse(line) as { places?: unknown; installations?: unknown; ports?: unknown }
      if (data.places) locations.places = absolutePaths(data.places)
      if (data.installations) locations.installations = absolutePaths(data.installations)
      if (Array.isArray(data.ports)) {
        locations.ports = data.ports.filter((port): port is number => Number.isInteger(port) && port > 0 && port <= 65535)
      }
    }
    return locations
  } catch {
    // 系统查询不可用时，仍可读取标准用户位置和手动选择的目录。
    return locations
  }
}

function tokens(line: string): string[] {
  return [...line.matchAll(/"[^"]*"|'[^']*'|[^\s;&|]+/g)].map(([token]) => token.replace(/^(['"])(.*)\1$/, '$2'))
}

function scriptDirectory(path: string): string {
  const folder = dirname(path)
  return /^(?:\.venv|venv|python_embeded)$/i.test(basename(folder)) ? dirname(folder) : folder
}

export function terminalInstallations(history: string, home: string): string[] {
  const result = new Set<string>()
  let cwd: string | undefined
  for (const line of history.split(/\r?\n/)) {
    for (const command of line.split(/\s*(?:&&|;)\s*/)) {
      const [first, ...rest] = tokens(command.trim())
      if (!first) continue
      const args = rest.filter((arg) => !/^\/(?:d)$/i.test(arg) && !/^-literalpath$|^-path$/i.test(arg))
      if (/^(?:cd|chdir|pushd|sl|set-location)$/i.test(first) && args[0]) {
        const next = args[0].replace(/^~(?=$|[\\/])/, home)
        cwd = isAbsolute(next) ? next : cwd && resolve(cwd, next)
        if (cwd && productName.test(cwd)) result.add(cwd)
        continue
      }
      if (/^(?:git|git\.exe)$/i.test(first) && args[0] === 'clone') {
        const urlIndex = args.findIndex((arg) => /^(?:https?:\/\/|ssh:\/\/|git@)/.test(arg) && productName.test(arg))
        const url = args[urlIndex]
        if (!url) continue
        const name =
          args[urlIndex + 1] ??
          url
            .split('/')
            .pop()
            ?.replace(/\.git$/, '')
        if (name && isAbsolute(name)) result.add(name)
        else if (name && cwd) result.add(resolve(cwd, name))
        continue
      }
      for (const arg of tokens(command)) {
        const path = arg.replace(/^~(?=$|[\\/])/, home)
        const leaf = basename(path)
        if (isAbsolute(path) && (launchFile.test(leaf) || (productName.test(path) && /^main\.py$/i.test(leaf)))) {
          result.add(scriptDirectory(path))
        } else if (cwd && !isAbsolute(path) && (launchFile.test(leaf) || /^main\.py$/i.test(leaf))) {
          result.add(scriptDirectory(resolve(cwd, path)))
        }
      }
    }
  }
  return [...result].reverse()
}

export function installerLogLocations(contents: string): string[] {
  const candidates = new Set<string>()
  for (const line of contents.split(/\r?\n/)) {
    if (!productName.test(line)) continue
    for (const match of line.matchAll(/(?:[A-Za-z]:[\\/])[^"<>|,;\r\n]+/g)) {
      const path = match[0].trim()
      const parts = path.split(/[\\/]/)
      const trailing = [...parts].reverse().findIndex((part) => productName.test('\\' + part) && !/\.(?:log|zip|7z|msi|exe)$/i.test(part))
      if (trailing !== -1) candidates.add(parts.slice(0, parts.length - trailing).join('\\'))
    }
  }
  return [...candidates].reverse()
}

async function recentText(file: string): Promise<string> {
  const handle = await open(file, 'r').catch(() => null)
  if (!handle) return ''
  try {
    const info = await handle.stat()
    if (!info.isFile()) return ''
    const size = Math.min(info.size, 128 * 1024)
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(size), 0, size, info.size - size)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return ''
  } finally {
    await handle.close()
  }
}

export async function localHistoryInstallations(): Promise<string[]> {
  const home = homedir()
  const historyFiles = ['.bash_history', '.zsh_history'].map((name) => join(home, name))
  const appData = process.env.APPDATA
  if (appData) {
    historyFiles.push(join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'))
  }
  const local = process.env.LOCALAPPDATA
  const logs: string[] = []
  if (local) {
    const wingetLogs = join(local, 'Packages', 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe', 'LocalState', 'DiagOutputDir')
    const names = (await readdir(wingetLogs).catch(() => []))
      .filter((name) => /^WinGet-.*\.log$/i.test(name))
      .sort()
      .slice(-6)
    logs.push(join(local, 'SquirrelTemp', 'SquirrelSetup.log'), ...names.map((name) => join(wingetLogs, name)))
  }
  const [histories, installs] = await Promise.all([Promise.all(historyFiles.map(recentText)), Promise.all(logs.map(recentText))])
  return [
    ...new Set([...histories.flatMap((history) => terminalInstallations(history, home)), ...installs.flatMap(installerLogLocations)]),
  ].slice(0, 80)
}
