#!/usr/bin/env node
/**
 * Assemble the source tree that `--phase audit` hands to the model.
 *
 * Why a bundle at all: the audit phase tells the model, in plain words, that it
 * is inside a virtualised Windows box and gives it this mechanism's source. The
 * model then attacks the mechanism instead of the machine, and every claim it
 * makes can be re-checked on the host (the un-injected cmd.exe).
 *
 * What goes in — and what deliberately does not:
 *   + the whole shim (injector, hooks, file/registry/SCM/process layers)
 *   + the Node-side launcher (in-process CreateProcess + injection)
 *   + the plugin executor that sets the staging root and collects output
 *   - the harness (`ai-redteam-agent.ts`), the API key, the build scripts
 *     and the deployment paths: those are the test rig, not the product.
 *
 * Output: <out>/winstage-src/ (tree) and <out>/audit-src.tar (what gets
 * shipped to the guest; Windows 10 has bsdtar at C:\Windows\System32\tar.exe,
 * so no zip dependency is needed on either side).
 *
 *   node tools/audit-src-bundle.ts --out dist/audit-src
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = dirname(HERE)

const FILES = [
  'docs/审计说明-交给模型.md',
  'shim/include/winstage_shim.h',
  'shim/include/winstage_stage_api.h',
  'shim/src/winstage_internal.h',
  'shim/src/ws_entry.c',
  'shim/src/ws_hook.c',
  'shim/src/ws_util.c',
  'shim/src/ws_stage.c',
  'shim/src/ws_file.c',
  'shim/src/ws_mask.c',
  'shim/src/ws_reg.c',
  'shim/src/ws_t3reg.c',
  'shim/src/ws_regstore.c',
  'shim/src/ws_scm.c',
  'shim/src/ws_proc.c',
  'shim/injector/ws_launch.h',
  'shim/injector/ws_launch.c',
  'shim/injector/winstage-inject.c',
  'shim/addon/winstage-addon.c',
  'src/executor.ts',
  'dsh-plugin/shell-executor.ts',
  'src/service-side.ts',
]

const argOf = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? String(process.argv[i + 1] ?? fallback) : fallback
}
const OUT = argOf('out', join(PKG, 'dist', 'audit-src'))
const TREE = join(OUT, 'winstage-src')
const TAR = join(OUT, 'audit-src.tar')

/* ---------------------------------------------------------------- tree ---- */
rmSync(TREE, { recursive: true, force: true })
let count = 0
let bytes = 0
for (const rel of FILES) {
  const src = join(PKG, rel)
  let dstRel = rel
  if (rel.startsWith('docs/')) dstRel = 'README.md'
  if (rel.startsWith('src/')) dstRel = 'plugin/' + rel.slice(4)
  if (rel.startsWith('dsh-plugin/')) dstRel = 'plugin/' + rel.slice('dsh-plugin/'.length)
  const dst = join(TREE, dstRel)
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  count += 1
  bytes += statSync(src).size
}

/* ----------------------------------------------------------------- tar ---- */
/** Minimal ustar writer: regular files only, forward slashes, no PAX. */
function header(name: string, size: number, mode = 0o644): Buffer {
  const buf = Buffer.alloc(512, 0)
  const oct = (value: number, width: number) => value.toString(8).padStart(width - 1, '0') + '\0'
  buf.write(name, 0, 100, 'utf8')
  buf.write(oct(mode, 8), 100, 8, 'ascii')
  buf.write(oct(0, 8), 108, 8, 'ascii')
  buf.write(oct(0, 8), 116, 8, 'ascii')
  buf.write(oct(size, 12), 124, 12, 'ascii')
  buf.write(oct(Math.floor(Date.now() / 1000), 12), 136, 12, 'ascii')
  buf.write('        ', 148, 8, 'ascii')
  buf.write('0', 156, 1, 'ascii')
  buf.write('ustar\0', 257, 6, 'ascii')
  buf.write('00', 263, 2, 'ascii')
  let sum = 0
  for (let i = 0; i < 512; i += 1) sum += buf[i]
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return buf
}

const parts: Buffer[] = []
const walk = (dir: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) { walk(abs); continue }
    const name = relative(OUT, abs).split('\\').join('/')
    /* ustar name field is 100 bytes; every path here is far shorter. */
    if (Buffer.byteLength(name) > 99) throw new Error(`tar name too long: ${name}`)
    const data = readFileSync(abs)
    parts.push(header(name, data.length), data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad, 0))
  }
}
walk(TREE)
parts.push(Buffer.alloc(1024, 0))
const tar = Buffer.concat(parts)
writeFileSync(TAR, tar)

console.log(`tree   ${TREE}  (${count} files, ${(bytes / 1024).toFixed(0)} KiB)`)
console.log(`tar    ${TAR}  (${(tar.length / 1024).toFixed(0)} KiB)`)
