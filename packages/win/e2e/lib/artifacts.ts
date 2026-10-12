// e2e/lib/artifacts.ts —— e2e 流程的产物落盘与结果标记工具。
//
// 约定（与 ebk 技能一致）：guest 把结果写成 `RESULT_<runId>.json|txt|log` 到共享目录，
// 值匹配 pass|success|ok|0（词边界）即视为成功。本文件在本仓侧生成同形状的结果，
// 并统一处理目录、sha256、JSON 读写，避免每个脚本各写一份。

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function writeJson(file: string, value: unknown): string {
  ensureDir(join(file, '..'))
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
  return file
}

export function writeText(file: string, text: string): string {
  ensureDir(join(file, '..'))
  writeFileSync(file, text, 'utf8')
  return file
}

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export const RESULT_MARKER_RE = /^RESULT[\w.-]*\.(log|json|txt)$/i

export interface ResultMarker {
  name: string
  path: string
  content: string
  success: boolean
}

/** 在目录里找 RESULT_* 标记；返回全部匹配（含内容与 pass/fail 判定）。 */
export function findResultMarkers(dir: string): ResultMarker[] {
  if (!existsSync(dir)) return []
  const out: ResultMarker[] = []
  for (const name of readdirSync(dir)) {
    if (!RESULT_MARKER_RE.test(name)) continue
    const path = join(dir, name)
    const content = readFileSync(path, 'utf8')
    out.push({ name, path, content, success: /(^|\W)(pass|success|ok|0)(\W|$)/i.test(content) })
  }
  return out
}

export interface RunContext {
  runId: string
  workdir: string
  sharedDir: string
  artifactsDir: string
  screenshotsDir: string
  domDir: string
  reportDir: string
}

export function makeRunContext(workdir: string, runId: string): RunContext {
  const base = ensureDir(join(workdir, runId))
  return {
    runId,
    workdir: base,
    sharedDir: ensureDir(join(base, 'shared')),
    artifactsDir: ensureDir(join(base, 'artifacts')),
    screenshotsDir: ensureDir(join(base, 'artifacts', 'screenshots')),
    domDir: ensureDir(join(base, 'artifacts', 'dom')),
    reportDir: ensureDir(join(base, 'artifacts', 'report')),
  }
}

export function makeRunId(prefix = 'r'): string {
  const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  const rand = Math.random().toString(16).slice(2, 8)
  return `${prefix}-${ts}-${rand}`
}
