/**
 * R34-P1 套件：T0/AppContainer 的工具链只读根（pip CA / npm 缓存）。
 *
 * 零子进程、零 ACL 写；只测纯函数 `toolchainReadRoots()` 的收集/过滤/去重。
 * 用法：node tests/toolchain-acl.ts
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { toolchainReadRoots } from '../src/executor.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, label: string, detail?: unknown): void {
  checks += 1
  if (condition) process.stdout.write(`  ✓ ${label}\n`)
  else {
    failures += 1
    process.stdout.write(`  ✗ ${label}${detail === undefined ? '' : ` — ${String(detail)}`}\n`)
  }
}

const root = join(process.cwd(), '.t', `toolchain-acl-${process.pid}-${Date.now()}`)
rmSync(root, { recursive: true, force: true })
const local = join(root, 'Local')
const roaming = join(root, 'Roaming')
const profile = join(root, 'User')
const python = join(local, 'Programs', 'Python')
const npmCache = join(local, 'npm-cache')
const pnpm = join(local, 'pnpm')
const npm = join(roaming, 'npm')
const pipCache = join(profile, '.cache', 'pip')
const uvCache = join(profile, '.cache', 'uv')
const nodeDir = join(root, 'node')
for (const dir of [python, npmCache, pnpm, npm, pipCache, uvCache, nodeDir]) mkdirSync(dir, { recursive: true })

process.stdout.write('=== toolchain-acl ===\n')

const roots = toolchainReadRoots({
  env: { LOCALAPPDATA: local, APPDATA: roaming, USERPROFILE: profile },
  execPath: join(nodeDir, 'node.exe'),
})
for (const [label, path] of [
  ['Node 安装目录', nodeDir],
  ['Python 安装目录', python],
  ['npm 缓存', npmCache],
  ['pnpm 缓存', pnpm],
  ['npm 全局目录', npm],
  ['pip 缓存', pipCache],
  ['uv 缓存', uvCache],
]) {
  ok(roots.includes(path), `包含 ${label}`, JSON.stringify(roots))
}
ok(roots.length === 7, '恰有 7 个存在目录（无重复）', JSON.stringify(roots))

const filtered = toolchainReadRoots({
  env: { LOCALAPPDATA: join(root, 'missing'), APPDATA: '', USERPROFILE: '' },
  execPath: join(root, 'missing', 'node.exe'),
})
ok(filtered.length === 0, '不存在的路径全部过滤', JSON.stringify(filtered))

rmSync(root, { recursive: true, force: true })
process.stdout.write(`\nRESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${checks} failures=${failures}\n`)
process.exit(failures === 0 ? 0 : 1)
