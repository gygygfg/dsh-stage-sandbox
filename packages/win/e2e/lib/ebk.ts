// e2e/lib/ebk.ts —— 对 ephemeral-build-kit（ebk）技能的薄封装。
//
// ebk 技能安装在宿主固定位置（默认 /root/.config/opencode/skills），提供
// probe / compose / wait / capture / collect / cleanup。本文件：
//   1. 解析技能目录（可用 EBK_SKILLS_DIR 覆盖）；
//   2. 动态 import 各技能模块（它们是自包含 .mjs，导出纯函数）；
//   3. 生成 compose 并补上 **USER_PORTS**（dockurr 的 guest 端口转发开关；
//      ebk-compose 目前不发射这个键，但我们需要把 guest 的 dsh web 端口
//      转发到宿主，供宿主 Playwright 直接取 DOM）；
//   4. docker / probe 的子进程封装。
//
// 之所以动态 import 而不是复制 ebk 代码：ebk 是宿主侧工具，保持"单一事实来源"，
// 本仓不维护第二份 compose 生成器。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface CmdResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

export function runCommand(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timer: NodeJS.Timeout | undefined
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGKILL')
      }, opts.timeoutMs)
    }
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code })
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolve({ stdout, stderr: stderr + err.message, exitCode: 1 })
    })
  })
}

export function resolveSkillsDir(): string {
  return process.env.EBK_SKILLS_DIR || '/root/.config/opencode/skills'
}

async function importSkill(skillsDir: string, rel: string): Promise<any> {
  const file = join(skillsDir, rel)
  if (!existsSync(file)) throw new Error(`ebk skill module not found: ${file} (set EBK_SKILLS_DIR)`)
  return import(pathToFileURL(file).href)
}

export interface EbkModules {
  compose: any
  wait: any
  capture: any
  env: any
}

export async function loadEbk(skillsDir = resolveSkillsDir()): Promise<EbkModules> {
  const [compose, wait, capture, env] = await Promise.all([
    importSkill(skillsDir, 'ebk-compose/scripts/ebk-compose.mjs'),
    importSkill(skillsDir, 'ebk-wait/scripts/ebk-wait.mjs'),
    importSkill(skillsDir, 'ebk-capture/scripts/ebk-capture.mjs'),
    importSkill(skillsDir, 'ebk-environment/scripts/ebk-env.mjs'),
  ])
  return { compose, wait, capture, env }
}

export async function probeHost(ebk: EbkModules): Promise<boolean> {
  const probe = ebk.env?.probeHost || ebk.env?.probe
  if (typeof probe === 'function') {
    try {
      return Boolean(await probe())
    } catch {
      return false
    }
  }
  // 回退：直接检查 docker / kvm / tun。
  const docker = await runCommand('docker', ['info'])
  return docker.exitCode === 0 && existsSync('/dev/kvm') && existsSync('/dev/net/tun')
}

export interface ComposeOptions {
  osId: string
  runId: string
  ram?: string
  cpu?: string
  disk?: string
  webPort?: number
  rdpPort?: number
  /** 额外要转发到宿主的 guest 端口（例如 dsh web 的 3085）。 */
  userPorts?: number[]
  testDir?: string
  oemDir?: string
  packageDir?: string
  storageDir?: string
  username?: string
  password?: string
  language?: string
  versionUrl?: string
  debug?: boolean
}

/**
 * 生成 compose YAML 文本。用 ebk-compose 的 buildCompose 作基底，
 * 再补 USER_PORTS（见文件头）。
 */
export function renderCompose(ebk: EbkModules, opts: ComposeOptions): string {
  const os = ebk.compose.findOs(opts.osId)
  if (!os) throw new Error(`unknown os-id "${opts.osId}" (run ebk-catalog for the list)`)
  const yaml: string = ebk.compose.buildCompose({
    os,
    runId: opts.runId,
    resources: { ram: opts.ram, cpu: opts.cpu, disk: opts.disk },
    ports: { web: opts.webPort, rdp: opts.rdpPort },
    extra: {
      username: opts.username,
      password: opts.password,
      language: opts.language,
      versionUrl: opts.versionUrl,
      debug: opts.debug,
    },
    paths: { test: opts.testDir, oem: opts.oemDir, package: opts.packageDir, storage: opts.storageDir },
  })
  if (!opts.userPorts || opts.userPorts.length === 0) return yaml
  return patchUserPorts(yaml, opts.userPorts)
}

/**
 * 在 environment 块里插入 `USER_PORTS: "p1,p2"`。
 * 插入点 = `DISK_SIZE:` 那一行之后（该键必定由 ebk-compose 发射，且在 environment 内）。
 */
export function patchUserPorts(yaml: string, ports: number[]): string {
  const lines = yaml.split('\n')
  const out: string[] = []
  let inserted = false
  for (const line of lines) {
    out.push(line)
    if (!inserted) {
      const m = /^(\s*)DISK_SIZE:\s/.exec(line)
      if (m) {
        out.push(`${m[1]}USER_PORTS: ${JSON.stringify(ports.join(','))}`)
        inserted = true
      }
    }
  }
  if (!inserted) throw new Error('patchUserPorts: DISK_SIZE anchor not found in compose YAML')
  return out.join('\n')
}

export interface UpOptions {
  composeFile: string
  cwd: string
  pull?: boolean
}

export async function composeUp({ composeFile, cwd, pull = false }: UpOptions): Promise<CmdResult> {
  const args = ['compose', '-f', composeFile, 'up', '-d']
  if (pull) args.push('--pull', 'missing')
  return runCommand('docker', args, { cwd })
}

export async function composeDown(composeFile: string, cwd: string): Promise<CmdResult> {
  return runCommand('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], { cwd })
}
