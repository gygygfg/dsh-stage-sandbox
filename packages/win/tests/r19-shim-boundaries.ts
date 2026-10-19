#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；本套件为 R19 新登记套件。
/**
 * r19-shim-boundaries —— **R19 C 侧（shim）边界回归套件**
 *
 * 存在理由：R19 的 3 个 P0/P1 修复落在 **C shim**（`shim/src/ws_file.c`、`ws_mask.c`）：
 *   · A1 写意图 open（r+/ReadWrite/MemoryMappedFile）跳过读掩码 ⇒ CoW 把明文搬进 overlay；
 *   · A2 `CopyFileW/A` 无 mask 检查 ⇒ `.NET File.Copy` 把明文复制进暂存树；
 *   · A5 ADS 流名（`:stream`/`:$DATA`）绕过 leaf 锚定遮蔽规则。
 * 这些行为只有在**真实注入的子进程**里才能验证；离线套件只能做静态断言。本套件用
 * canonical `shim\out` 的注入器驱动 node 子进程，把三条安全结局钉成硬断言：
 *   S1 敏感文件 `r+` open + 读 ⇒ 拒绝（或至少不返回明文），暂存树无明文；
 *   S2 `fs.copyFileSync(敏感文件 → 工作区)` ⇒ 拒绝，真实目标不存在、暂存树无明文；
 *   S3 命名 ADS 读 ⇒ 拒绝且无明文；
 *   S4 robocopy 复制敏感文件 ⇒ 真实目标不存在（fail-closed 也算通过）、暂存树无明文；
 *   S5 对照：普通文件可读、普通写进暂存（真实盘无文件）——证明本套件有判定力。
 *
 * 判定口径：**"拒绝且无明文" 与 "操作失败且无明文" 都算 PASS**（安全方向是 fail-closed）；
 * 只有"明文出现在 stdout/暂存树/真实盘"才 FAIL。
 *
 * 跳过条件（如实 SKIP，不是 PASS）：非 win32 / `shim\out` 三件缺失 / 注入器不可执行。
 * 用法：node tests\r19-shim-boundaries.ts
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRATCH = join(REPO, '.t', 'r19-suite', 'shim-boundaries')
const OUT = join(REPO, 'shim', 'out')
const DLL = join(OUT, 'winstage-shim.dll')
const INJECTOR = join(OUT, 'winstage-inject.exe')
const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0
let skips = 0

function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`  ${condition ? '✓' : '✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
}
function skipAll(reason) {
  W('')
  W(`RESULT: SKIP checks=0 failures=0 reason=${reason}`)
  process.exit(0)
}
function section(title) {
  W('')
  W(`=== ${title} ===`)
}

if (process.platform !== 'win32') skipAll('requires-win32')
for (const [label, path] of [['dll', DLL], ['injector', INJECTOR]]) {
  if (!existsSync(path)) skipAll(`missing-${label}-${path}`)
}

const MASK = join(SCRATCH, 'session', 'read-deny.mask.json')
const STAGE = join(SCRATCH, 'stage')
const WS = join(SCRATCH, 'ws')
const SENS = join(WS, 'sens')
const ADV = join(WS, 'adv')
const CMD = process.env.ComSpec || 'cmd.exe'
const MARK = 'R19-SHIM-LEAK'
const NORMAL = 'R19-SHIM-NORMAL'

rmSync(SCRATCH, { recursive: true, force: true })
for (const d of [STAGE, ADV, SENS, join(SCRATCH, 'session')]) mkdirSync(d, { recursive: true })
writeFileSync(join(SENS, '.npmrc'), `${MARK}-NPMRC`)
writeFileSync(join(SENS, 'normal.txt'), NORMAL)

// 用产品同一份 MASK_CLASSES 导出遮蔽清单（`paths.ts --export-mask`）
const exported = spawnSync(process.execPath, [join(REPO, 'src', 'paths.ts'), '--export-mask', MASK], { encoding: 'utf8' })
if (exported.status !== 0) skipAll(`mask-export-failed-${exported.status}`)

function cfg(tag) {
  const path = join(SCRATCH, `${tag}.config.json`)
  writeFileSync(
    path,
    JSON.stringify({
      stageRoot: STAGE,
      logPath: join(STAGE, `shim-${tag}.log`),
      failClosed: true,
      readThrough: true,
      verbose: true,
      traceStagedOps: true,
      readDenyFile: MASK,
      readDenyFailClosed: true,
      passthrough: [STAGE],
    }),
  )
  return path
}

/** 在注入器里跑一个子进程（node/powershell/cmd 由 case 决定） */
function inject(tag, exe, args, timeout = 60000) {
  const env = { ...process.env }
  env.WINSTAGE_STAGE_ROOT = STAGE
  env.WINSTAGE_SHIM_CONFIG = cfg(tag)
  env.WINSTAGE_SHIM_LOG = join(STAGE, `shim-${tag}.log`)
  const r = spawnSync(INJECTOR, ['--dll', DLL, '--report', join(SCRATCH, `report-${tag}.json`), '--cwd', SCRATCH, '--', exe, ...args], {
    env,
    encoding: 'utf8',
    timeout,
  })
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const reportPath = join(SCRATCH, `report-${tag}.json`)
  let reportOk = null
  try {
    reportOk = JSON.parse(readFileSync(reportPath, 'utf8')).ok === true
  } catch {
    reportOk = null
  }
  return { status: r.status ?? -1, text, reportOk }
}

function walkFiles(dir) {
  const out = []
  const walk = (current) => {
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(full)
    }
  }
  walk(dir)
  return out
}
function stagedLeaks(text) {
  return walkFiles(STAGE).filter((file) => {
    try {
      return statSync(file).size < 4 * 1024 * 1024 && readFileSync(file, 'utf8').includes(MARK)
    } catch {
      return false
    }
  })
}
const containsMark = (text) => text.includes(MARK)

section('S1 写意图 open（r+）读遮蔽文件 ⇒ 拒绝/无明文')
{
  const script = `const fs=require('fs');const p=${JSON.stringify(join(SENS, '.npmrc'))};try{const fd=fs.openSync(p,'r+');const b=Buffer.alloc(64);const n=fs.readSync(fd,b,0,64,0);fs.closeSync(fd);process.stdout.write(b.subarray(0,n).toString('utf8'))}catch(e){process.stderr.write('OPEN-DENIED:'+e.code);process.exit(9)}`
  const r = inject('s1-rw-open', process.execPath, ['-e', script])
  check(
    'S1.1 敏感 r+ open/read 不返回明文（拒绝或失败均可）',
    !containsMark(r.text) && stagedLeaks().length === 0,
    `status=${r.status} leaks=${containsMark(r.text)} stagedLeak=${stagedLeaks().length} text=${r.text.slice(0, 120)}`,
  )
}

section('S2 CopyFileW（.NET/node 复制）读遮蔽文件 ⇒ 拒绝且无明文')
{
  const dest = join(ADV, 'copy-probe.txt')
  rmSync(dest, { force: true })
  const script = `const fs=require('fs');try{fs.copyFileSync(${JSON.stringify(join(SENS, '.npmrc'))},${JSON.stringify(dest)});process.stdout.write('COPIED')}catch(e){process.stderr.write('COPY-DENIED:'+e.code);process.exit(9)}`
  const r = inject('s2-copyfile', process.execPath, ['-e', script])
  check(
    'S2.1 敏感文件复制被拒/失败，真实目标不存在，暂存树无明文',
    !existsSync(dest) && !containsMark(r.text) && stagedLeaks().length === 0,
    `status=${r.status} realExists=${existsSync(dest)} leaks=${containsMark(r.text)} stagedLeak=${stagedLeaks().length}`,
  )
}

section('S3 命名 ADS 读遮蔽文件 ⇒ 拒绝且无明文')
{
  const stream = 'r19suite'
  const cmdEcho = spawnSync(CMD, ['/d', '/c', 'echo', `${MARK}-ADS`, `>${join(SENS, '.npmrc')}:${stream}`], { encoding: 'utf8' })
  const streamPath = `${join(SENS, '.npmrc')}:${stream}`
  const existsOutside = (() => {
    try {
      return readFileSync(streamPath, 'utf8').includes(MARK)
    } catch {
      return false
    }
  })()
  if (!existsOutside) {
    skips += 1
    W('  ~ SKIP S3 ADS：本机未能创建命名流（cmd echo 失败）')
  } else {
    const script = `const fs=require('fs');try{process.stdout.write(fs.readFileSync(${JSON.stringify(streamPath)},'utf8'))}catch(e){process.stderr.write('ADS-DENIED:'+e.code);process.exit(9)}`
    const r = inject('s3-ads', process.execPath, ['-e', script])
    check(
      'S3.1 命名 ADS 读被拒/失败且不返回明文',
      !containsMark(r.text) && stagedLeaks().length === 0,
      `status=${r.status} leaks=${containsMark(r.text)} text=${r.text.slice(0, 120)}`,
    )
  }
}

section('S4 robocopy 复制遮蔽文件 ⇒ 真实盘零写/无明文')
{
  const destDir = join(ADV, 'robo')
  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })
  // robocopy 必须在**注入器内**启动（否则就是普通进程，不能证明 shim 边界）。
  const injected = inject('s4-robo-inj', CMD, ['/d', '/c', `robocopy "${SENS}" "${destDir}" .npmrc /NJH /NJS /NP /R:0 /W:0`], 90000)
  const realDest = join(destDir, '.npmrc')
  check(
    'S4.1 robocopy 后真实目标不存在、暂存树无明文（fail-closed 亦通过）',
    !existsSync(realDest) && stagedLeaks().length === 0,
    `status=${injected.status} realExists=${existsSync(realDest)} stagedLeak=${stagedLeaks().length}`,
  )
}

section('S5 对照：普通文件可读、普通写进暂存（证明本套件有判定力）')
{
  const readScript = `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(SENS, 'normal.txt'))},'utf8'))`
  const read = inject('s5-read', process.execPath, ['-e', readScript])
  check('S5.1 普通文件读返回内容', read.status === 0 && read.text.includes(NORMAL), `status=${read.status} text=${read.text.slice(0, 80)}`)

  const outReal = join(ADV, 'normal-out.txt')
  const writeScript = `require('fs').writeFileSync(${JSON.stringify(outReal)},'R19-SHIM-WRITE');process.stdout.write('WROTE')`
  const write = inject('s5-write', process.execPath, ['-e', writeScript])
  const stagedWritten = walkFiles(STAGE).some((file) => {
    try {
      return readFileSync(file, 'utf8').includes('R19-SHIM-WRITE')
    } catch {
      return false
    }
  })
  check(
    'S5.2 普通写进暂存、真实盘无文件',
    write.status === 0 && !existsSync(outReal) && stagedWritten,
    `status=${write.status} realExists=${existsSync(outReal)} staged=${stagedWritten}`,
  )
}

W('')
W('='.repeat(64))
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} skips=${skips}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
