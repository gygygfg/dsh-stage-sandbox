#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；R28 新登记套件。
/**
 * r28-apply-attributes —— **R28-A：R21-FS-08 apply 属性面（hidden/system + ACL 口径）**
 *
 * 修前（R21 记录 + `r28-probe` 实测）：apply 走 `writeFileAtomicReplacing()`（写临时文件
 * 再 rename 覆盖），新文件**丢失** `FILE_ATTRIBUTE_HIDDEN/SYSTEM`；Node 只映射只读位。
 * 目标：apply 修改/新建真实文件时尽量还原 hidden/system（+既有 readonly）；失败**不吞错**
 * （`attributeWarnings` 如实返回），路径含空格/长路径（≤4095）安全，离线可测。
 *
 * 断言：
 *   A1 modify：真实 hidden 文件（暂存态未显式设置）⇒ apply 后 hidden 保留 + 内容更新
 *   A2 modify：真实 system+readonly ⇒ system+readonly 保留
 *   A3 modify：暂存态显式 H+S（沙箱内改属性）⇒ apply 后与暂存态一致（H+S）
 *   A4 create：暂存态 H+S ⇒ 新文件 H+S
 *   A5 create：普通暂存态 ⇒ 新文件无 H/S（不误加）
 *   A6 普通 modify：属性保持 A（无误改）
 *   A7 路径含空格：hidden 保留
 *   A8 长路径（~600 字，≤4095）：hidden 保留（走 PowerShell 长路径分支）
 *   A9 失败不谎报：注入 attributeIo.set 失败 ⇒ status=applied/内容落盘，但 attributeWarnings 非空、
 *      真实文件**没有**被假装设置 H（不静默"已还原"）
 *   A10 delete 不受影响：hidden 文件删除后真实盘不存在、无 attributeWarnings
 *   A11 ACL 口径（默认继承）：modify apply 前后 icacls 文本不变（继承 ACL 未被重置）
 *   A12 ACL 口径（显式 ACE 边界）：显式 ACE 在 rename-replace 后**不被保留**（继承自父目录）——
 *      如实钉住"ACL 继承不是暂存语义"，不声称 ACL 已还原
 *
 * 红/绿：R28 修前 A1–A4/A7/A8 失败（hidden/system 丢失）；修后全绿。
 * SKIP：非 win32 / attrib 不可用 / icacls 不可用时如实记录。
 *
 * 用法：node tests\r28-apply-attributes.ts
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Workspace } from '../src/workspace.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRATCH = mkdtempSync(join(REPO, '.t', 'r28-apply-attributes-'))
const W = (t) => process.stdout.write(`${t}\n`)
let assertions = 0
let failures = 0
let skips = 0
function check(name, cond, detail) {
  assertions += 1
  if (!cond) failures += 1
  W(`  ${cond ? '✓' : '✗'} ${name}`)
  if (detail !== undefined) W(`      证据: ${detail}`)
}
function skip(name, reason) {
  skips += 1
  W(`  ~ SKIP ${name}`)
  W(`      原因: ${reason}`)
}
function section(t) {
  W('')
  W(`=== ${t} ===`)
}
mkdirSync(SCRATCH, { recursive: true })

const onWindows = process.platform === 'win32'
const attribOk = onWindows && spawnSync('attrib.exe', ['/'], { encoding: 'utf8' }).status !== undefined
const icaclsOk = onWindows && spawnSync('icacls', ['/'], { encoding: 'utf8' }).status !== undefined
const longArg = (p) => (p.length >= 248 && !p.startsWith('\\\\?\\') ? `\\\\?\\${p}` : p)
function readAttrsSync(abs) {
  try {
    if (longArg(abs).startsWith('\\\\?\\')) {
      const q = longArg(abs).replace(/'/g, "''")
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[int][IO.File]::GetAttributes('${q}')`], { encoding: 'utf8', timeout: 15000 })
      const m = /^(\d+)/.exec(String(r.stdout || '').trim())
      if (r.status !== 0 || !m) return { ok: false, hidden: false, system: false, readonly: false }
      const v = Number(m[1])
      return { ok: true, hidden: (v & 0x2) !== 0, system: (v & 0x4) !== 0, readonly: (v & 0x1) !== 0 }
    }
    const r = spawnSync('attrib.exe', [abs], { encoding: 'utf8', timeout: 15000 })
    if (r.status !== 0) return { ok: false, hidden: false, system: false, readonly: false }
    const flagPart = String(r.stdout || '').split(/\r?\n/)[0].slice(0, 20)
    return { ok: true, hidden: /H/.test(flagPart), system: /S/.test(flagPart), readonly: /R/.test(flagPart) }
  } catch {
    return { ok: false, hidden: false, system: false, readonly: false }
  }
}
function setAttrsSync(abs, bits) {
  if (longArg(abs).startsWith('\\\\?\\')) {
    const q = longArg(abs).replace(/'/g, "''")
    const cur = readAttrsSync(abs)
    let v = cur.hidden ? 0x2 : 0
    if (cur.system) v |= 0x4
    v = bits.hidden ? v | 0x2 : v & ~0x2
    v = bits.system ? v | 0x4 : v & ~0x4
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[IO.File]::SetAttributes('${q}', ${v})`], { encoding: 'utf8', timeout: 15000 }).status === 0
  }
  const args = [bits.hidden ? '+H' : '-H', bits.system ? '+S' : '-S', abs]
  return spawnSync('attrib.exe', args, { encoding: 'utf8', timeout: 15000 }).status === 0
}
let seq = 0
function makeWs(tag) {
  const root = join(SCRATCH, `ws-${tag}-${seq++}`)
  mkdirSync(root, { recursive: true })
  const storeDir = join(SCRATCH, `store-${tag}-${seq}`)
  return { ws: new Workspace({ workspaceRoot: root, storeDir, sessionId: `r28-${tag}` }).init({ sessionId: `r28-${tag}` }), root }
}
const content = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch (e) {
    return `ERR:${e.code}`
  }
}
const stagedOf = (ws, rel) => ws.store.stagedPath(rel)
const aclOf = (p) => String(spawnSync('icacls', [p], { encoding: 'utf8' }).stdout || '')

section('R28-A apply 属性面')
if (!onWindows || !attribOk) {
  skip('R28-A 全部用例', `requires win32 + attrib.exe（onWindows=${onWindows} attrib=${attribOk}）`)
} else {
  // A1: hidden 保留（暂存态未显式设置，来自暂存时捕获）
  {
    const { ws, root } = makeWs('hidden')
    const p = join(root, 'hidden.txt')
    writeFileSync(p, 'OLD')
    setAttrsSync(p, { hidden: true, system: false })
    ws.writeFile(p, 'NEW', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const res = ws.applyCandidate(frozen.candidate.id)
    const a = readAttrsSync(p)
    check(
      'A1 modify：真实 hidden 文件（暂存态未显式设置）⇒ apply 后 hidden 保留、内容更新',
      res.status === 'applied' && content(p) === 'NEW' && a.hidden === true,
      JSON.stringify({ status: res.status, content: content(p), hidden: a.hidden, warnings: res.attributeWarnings }),
    )
  }
  // A2: system + readonly 保留
  {
    const { ws, root } = makeWs('sysro')
    const p = join(root, 'sysro.txt')
    writeFileSync(p, 'OLD')
    setAttrsSync(p, { hidden: false, system: true })
    chmodSync(p, 0o444)
    ws.writeFile(p, 'NEW', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const res = ws.applyCandidate(frozen.candidate.id)
    const a = readAttrsSync(p)
    const mode = statSync(p).mode & 0o777
    check(
      'A2 modify：真实 system+readonly ⇒ apply 后 system+readonly 都保留',
      res.status === 'applied' && a.system === true && mode === 0o444,
      JSON.stringify({ system: a.system, mode: mode.toString(8), warnings: res.attributeWarnings }),
    )
    spawnSync('attrib.exe', ['-S', '-R', p], { encoding: 'utf8' })
  }
  // A3: 暂存态显式 H+S 覆盖（沙箱内改属性）
  {
    const { ws, root } = makeWs('staged')
    const p = join(root, 'staged.txt')
    writeFileSync(p, 'OLD')
    ws.writeFile(p, 'NEW', { origin: 'test' })
    const sp = stagedOf(ws, 'staged.txt')
    const setOk = existsSync(sp) && setAttrsSync(sp, { hidden: true, system: true })
    const frozen = ws.freezeCandidate({})
    const res = ws.applyCandidate(frozen.candidate.id)
    const a = readAttrsSync(p)
    check(
      'A3 modify：暂存态显式 H+S（沙箱内 attrib）⇒ apply 后与暂存态一致（hidden+system）',
      setOk && res.status === 'applied' && a.hidden === true && a.system === true,
      JSON.stringify({ stagedExists: existsSync(sp), setOk, hidden: a.hidden, system: a.system, warnings: res.attributeWarnings }),
    )
  }
  // A4: create 按暂存态 H+S
  {
    const { ws, root } = makeWs('createhs')
    const p = join(root, 'created.txt')
    ws.writeFile(p, 'CREATED', { origin: 'test' })
    const sp = stagedOf(ws, 'created.txt')
    const setOk = existsSync(sp) && setAttrsSync(sp, { hidden: true, system: true })
    const frozen = ws.freezeCandidate({})
    const res = ws.applyCandidate(frozen.candidate.id)
    const a = readAttrsSync(p)
    check(
      'A4 create：暂存态 H+S ⇒ 新建真实文件 hidden+system（按暂存态设置）',
      setOk && res.status === 'applied' && existsSync(p) && a.hidden === true && a.system === true,
      JSON.stringify({ exists: existsSync(p), hidden: a.hidden, system: a.system, warnings: res.attributeWarnings }),
    )
  }
  // A5: create 普通暂存态 ⇒ 不误加 H/S
  {
    const { ws, root } = makeWs('createplain')
    const p = join(root, 'plain-created.txt')
    ws.writeFile(p, 'CREATED', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const res = ws.applyCandidate(frozen.candidate.id)
    const a = readAttrsSync(p)
    check(
      'A5 create：普通暂存态 ⇒ 新文件不带 hidden/system（不误加属性）',
      res.status === 'applied' && a.hidden === false && a.system === false,
      JSON.stringify({ hidden: a.hidden, system: a.system, warnings: res.attributeWarnings }),
    )
  }
  // A6: 普通 modify 属性保持 A
  {
    const { ws, root } = makeWs('plainmod')
    const p = join(root, 'plain.txt')
    writeFileSync(p, 'OLD')
    ws.writeFile(p, 'NEW', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const res = ws.applyCandidate(frozen.candidate.id)
    const a = readAttrsSync(p)
    check(
      'A6 普通 modify：属性保持 A（不误加 hidden/system）且内容更新',
      res.status === 'applied' && content(p) === 'NEW' && a.hidden === false && a.system === false,
      JSON.stringify({ hidden: a.hidden, system: a.system, content: content(p), warnings: res.attributeWarnings }),
    )
  }
  // A7: 路径含空格
  {
    const { ws, root } = makeWs('spaces')
    const dir = join(root, 'dir with spaces')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'file name.txt')
    writeFileSync(p, 'OLD')
    setAttrsSync(p, { hidden: true, system: false })
    ws.writeFile(p, 'NEW', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const res = ws.applyCandidate(frozen.candidate.id)
    const a = readAttrsSync(p)
    check(
      'A7 路径含空格：apply 后 hidden 保留（attrib 参数按数组传递，无 shell 注入/空格问题）',
      res.status === 'applied' && a.hidden === true,
      JSON.stringify({ hidden: a.hidden, warnings: res.attributeWarnings }),
    )
  }
  // A8: 长路径（~600 字）hidden 保留（PowerShell 长路径分支）
  {
    const { ws, root } = makeWs('long')
    let d = root
    for (let i = 0; i < 6; i++) d = join(d, `seg-${i}-${'x'.repeat(70)}`)
    mkdirSync(`\\\\?\\${d}`, { recursive: true })
    const p = join(d, 'long-hidden.txt')
    writeFileSync(`\\\\?\\${p}`, 'OLD')
    setAttrsSync(`\\\\?\\${p}`, { hidden: true, system: false })
    ws.writeFile(`\\\\?\\${p}`, 'NEW', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const res = ws.applyCandidate(frozen.candidate.id)
    const a = readAttrsSync(`\\\\?\\${p}`)
    check(
      'A8 长路径（~600 字，≤4095）：apply 后 hidden 保留（走 PowerShell [IO.File] 长路径分支）',
      res.status === 'applied' && a.hidden === true && content(`\\\\?\\${p}`) === 'NEW',
      JSON.stringify({ pathLen: p.length, hidden: a.hidden, status: res.status, warnings: res.attributeWarnings }).slice(0, 320),
    )
  }
  // A9: 失败不谎报（注入 set 失败）
  {
    const { ws, root } = makeWs('fail')
    const p = join(root, 'fail.txt')
    writeFileSync(p, 'OLD')
    setAttrsSync(p, { hidden: true, system: false })
    ws.writeFile(p, 'NEW', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const res = ws.applyCandidate(frozen.candidate.id, {
      attributeIo: { set: () => ({ ok: false, code: 'ATTRIB_SET_FAILED', message: 'forced failure for test' }) },
    })
    const a = readAttrsSync(p)
    check(
      'A9 失败不谎报：attributeIo.set 强制失败 ⇒ 内容照常落盘，但 attributeWarnings 如实返回（真实文件未被假装设置 hidden）',
      res.status === 'applied' &&
        content(p) === 'NEW' &&
        Array.isArray(res.attributeWarnings) &&
        res.attributeWarnings.length > 0 &&
        res.attributeWarnings[0].code === 'ATTRIB_SET_FAILED' &&
        a.hidden === false,
      JSON.stringify({ status: res.status, warnings: res.attributeWarnings, hidden: a.hidden }).slice(0, 320),
    )
  }
  // A10: delete 不受影响
  {
    const { ws, root } = makeWs('delete')
    const p = join(root, 'to-delete.txt')
    writeFileSync(p, 'D')
    setAttrsSync(p, { hidden: true, system: false })
    ws.remove(p, { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const res = ws.applyCandidate(frozen.candidate.id)
    check(
      'A10 delete 不受影响：hidden 文件删除后真实盘不存在，且无属性面警告',
      res.status === 'applied' && !existsSync(p) && (res.attributeWarnings || []).length === 0,
      JSON.stringify({ exists: existsSync(p), warnings: res.attributeWarnings }),
    )
  }
  // A11: ACL 默认继承不变
  if (!icaclsOk) {
    skip('A11 ACL 默认继承口径', 'icacls 不可用')
  } else {
    const { ws, root } = makeWs('acl')
    const p = join(root, 'acl.txt')
    writeFileSync(p, 'OLD')
    const before = aclOf(p)
    ws.writeFile(p, 'NEW', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const res = ws.applyCandidate(frozen.candidate.id)
    const after = aclOf(p)
    check(
      'A11 ACL 口径（默认继承）：modify apply 前后 icacls 文本不变（父目录继承 ACL 未被重置）',
      res.status === 'applied' && before === after && before.length > 0,
      JSON.stringify({ same: before === after }),
    )
  }
  // A12: 显式 ACE 不被保留（如实登记，不声称 ACL 已还原）
  if (!icaclsOk) {
    skip('A12 ACL 显式 ACE 边界', 'icacls 不可用')
  } else {
    const { ws, root } = makeWs('aclexplicit')
    const p = join(root, 'acl-explicit.txt')
    writeFileSync(p, 'OLD')
    const user = process.env.USERNAME || ''
    const grant = spawnSync('icacls', [p, '/grant:r', `${user}:(R)`], { encoding: 'utf8' })
    const before = aclOf(p)
    ws.writeFile(p, 'NEW', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const res = ws.applyCandidate(frozen.candidate.id)
    const after = aclOf(p)
    check(
      'A12 ACL 口径（显式 ACE 边界）：显式 ACE 经 rename-replace 后**不被保留**（新文件继承父目录 ACL）——如实钉住，不声称 ACL 已还原',
      grant.status === 0 && res.status === 'applied' && before !== after,
      JSON.stringify({ grant: grant.status, beforeDiffAfter: before !== after, warnings: res.attributeWarnings }).slice(0, 320),
    )
  }
}

  // ═════════════ R29：（① 显式清除/设置的暂存态语义 + ② 树回滚子项属性）
  // marker 写法与 shim 侧契约一致：staged 文件 ADS `:winstage-attr`，4 字节 LE DWORD。
  const markerWrite = (staged, value) => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(value >>> 0, 0)
    writeFileSync(`${staged}:winstage-attr`, b)
  }
  const markerRead = (p) => {
    try {
      const b = readFileSync(`${p}:winstage-attr`)
      return b.length >= 4 ? b.readUInt32LE(0) : -1
    } catch (e) {
      return e.code
    }
  }
  // R29-A1：显式清除（marker=0x80 NORMAL）⇒ apply 为 NORMAL，不再保留原 hidden
  {
    const { ws, root } = makeWs('r29clear')
    const p = join(root, 'clear.txt')
    writeFileSync(p, 'OLD')
    setAttrsSync(p, { hidden: true, system: false })
    ws.writeFile(p, 'NEW', { origin: 'test' })
    const staged = stagedOf(ws, 'clear.txt')
    markerWrite(staged, 0x80)
    const frozen = ws.freezeCandidate({})
    const res = ws.applyCandidate(frozen.candidate.id)
    const a = readAttrsSync(p)
    check(
      'R29-A1 显式清除：暂存态 marker=0x80(NORMAL) ⇒ apply 后真实文件 NORMAL（hidden/system 不保留）',
      res.status === 'applied' && a.hidden === false && a.system === false && content(p) === 'NEW',
      JSON.stringify({ hidden: a.hidden, system: a.system, warnings: res.attributeWarnings }),
    )
  }
  // R29-A2：显式设置（marker=H|S）仍还原
  {
    const { ws, root } = makeWs('r29set')
    const p = join(root, 'set.txt')
    writeFileSync(p, 'OLD')
    ws.writeFile(p, 'NEW', { origin: 'test' })
    const staged = stagedOf(ws, 'set.txt')
    markerWrite(staged, 0x2 | 0x4)
    const frozen = ws.freezeCandidate({})
    const res = ws.applyCandidate(frozen.candidate.id)
    const a = readAttrsSync(p)
    check(
      'R29-A2 显式设置：暂存态 marker=H|S ⇒ apply 后真实文件 hidden+system（marker 值优先生效）',
      res.status === 'applied' && a.hidden === true && a.system === true,
      JSON.stringify({ hidden: a.hidden, system: a.system, warnings: res.attributeWarnings }),
    )
  }
  // R29-A3：marker 不可用 ⇒ 如实 warning，且不回退旧优先级（不改 H/S）
  {
    const { ws, root } = makeWs('r29unavail')
    const p = join(root, 'unavail.txt')
    writeFileSync(p, 'OLD')
    setAttrsSync(p, { hidden: true, system: false })
    ws.writeFile(p, 'NEW', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const res = ws.applyCandidate(frozen.candidate.id, {
      attributeMarkerIo: { read: () => ({ state: 'error', code: 'ATTRIB_MARKER_UNAVAILABLE', message: 'non-NTFS forced failure' }) },
    })
    const a = readAttrsSync(p)
    check(
      'R29-A3 marker 不可用：attributeWarnings 如实含 ATTRIB_MARKER_UNAVAILABLE，且不静默回退旧优先级（属性未知 ⇒ 不猜测/不保留，如实）',
      res.status === 'applied' &&
        Array.isArray(res.attributeWarnings) &&
        res.attributeWarnings.some((w) => w.code === 'ATTRIB_MARKER_UNAVAILABLE') &&
        a.hidden === false,
      JSON.stringify({ status: res.status, warnings: res.attributeWarnings, hidden: a.hidden }).slice(0, 360),
    )
  }
  // R29-A4：marker 成功消费后清理；真实盘无 ADS 泄漏
  {
    const { ws, root } = makeWs('r29cleanup')
    const p = join(root, 'cleanup.txt')
    writeFileSync(p, 'OLD')
    setAttrsSync(p, { hidden: true, system: false })
    ws.writeFile(p, 'NEW', { origin: 'test' })
    const staged = stagedOf(ws, 'cleanup.txt')
    markerWrite(staged, 0x80)
    const frozen = ws.freezeCandidate({})
    const res = ws.applyCandidate(frozen.candidate.id)
    check(
      'R29-A4 marker 生命周期：apply 后 staged 上的 :winstage-attr 被清理，真实文件上没有该 ADS（不泄漏）',
      res.status === 'applied' && markerRead(staged) === 'ENOENT' && markerRead(p) === 'ENOENT',
      JSON.stringify({ stagedMarker: markerRead(staged), realMarker: markerRead(p) }),
    )
  }
  // R29-A5（C 侧契约，需 injector）：沙箱内 PowerShell SetAttributes(NORMAL) 在 staged 文件上留下 marker=0x80；
  // 沙箱删除后 staged 文件与 marker 均不残留。
  {
    const shimDir = process.env.WINSTAGE_SHIM_OUT
      ? process.env.WINSTAGE_SHIM_OUT
      : existsSync(join(REPO, '.t', 'file-shim', 'out', 'winstage-shim.dll'))
        ? join(REPO, '.t', 'file-shim', 'out')
        : join(REPO, 'shim', 'out')
    const injector = join(shimDir, 'winstage-inject.exe')
    const dll = join(shimDir, 'winstage-shim.dll')
    if (!existsSync(injector) || !existsSync(dll)) {
      skip('R29-A5 shim 侧 marker 契约（需要 canonical injector）', 'shim/out 产物缺失')
    } else {
      const { ws, root } = makeWs('r29shim')
      const stage = join(SCRATCH, `stage-r29shim-${process.pid}`)
      mkdirSync(stage, { recursive: true })
      const p = join(root, 'shim-marker.txt')
      writeFileSync(p, 'OLD')
      setAttrsSync(p, { hidden: true, system: false })
      const cfg = join(SCRATCH, `cfg-r29shim-${process.pid}.json`)
      writeFileSync(cfg, JSON.stringify({ stageRoot: stage, logPath: join(stage, 'shim.log'), failClosed: true, readThrough: true, verbose: false, passthrough: [stage] }))
      const env = { ...process.env, WINSTAGE_STAGE_ROOT: stage, WINSTAGE_SHIM_CONFIG: cfg, WINSTAGE_SHIM_LOG: join(stage, 'shim.log') }
      const q = p.replace(/'/g, "''")
      const psWrite = `[IO.File]::WriteAllText('${q}', 'STAGED'); [IO.File]::SetAttributes('${q}', [IO.FileAttributes]::Normal)`
      const inj1 = spawnSync(injector, ['--dll', dll, '--report', join(SCRATCH, `r-${process.pid}.json`), '--cwd', root, '--', 'powershell.exe', '-NoProfile', '-NonInteractive', '-Command', psWrite], { env, encoding: 'utf8', timeout: 180000 })
      const drive = p[0]
      const rest = p.slice(3)
      const stagedShim = join(stage, 'fs', drive, rest)
      const mv = markerRead(stagedShim)
      const psDelete = `Remove-Item -LiteralPath '${q}' -Force`
      const inj2 = spawnSync(injector, ['--dll', dll, '--report', join(SCRATCH, `r2-${process.pid}.json`), '--cwd', root, '--', 'powershell.exe', '-NoProfile', '-NonInteractive', '-Command', psDelete], { env, encoding: 'utf8', timeout: 180000 })
      check(
        'R29-A5 C 侧契约：沙箱 SetAttributes(NORMAL) 在 staged 文件写 marker=0x80；沙箱删除后 staged 文件与 marker 均不残留',
        inj1.status === 0 && mv === 0x80 && inj2.status === 0 && !existsSync(stagedShim) && markerRead(stagedShim) !== 0x80,
        JSON.stringify({ write: inj1.status, marker: mv, delete: inj2.status, stagedExists: existsSync(stagedShim) }).slice(0, 320),
      )
    }
  }
  // R29-B1：目录树回滚 → 子项 H/S/只读逐项恢复
  {
    const { ws, root } = makeWs('r29tree')
    const tree = join(root, 'a-tree')
    mkdirSync(join(tree, 'sub'), { recursive: true })
    writeFileSync(join(tree, 'hidden-child.txt'), 'H')
    setAttrsSync(join(tree, 'hidden-child.txt'), { hidden: true, system: false })
    writeFileSync(join(tree, 'sys-child.txt'), 'S')
    setAttrsSync(join(tree, 'sys-child.txt'), { hidden: false, system: true })
    chmodSync(join(tree, 'sys-child.txt'), 0o444)
    setAttrsSync(join(tree, 'sub'), { hidden: true, system: false })
    writeFileSync(join(root, 'z-fail.txt'), 'Z0')
    ws.remove(tree, { origin: 'test' })
    ws.writeFile(join(root, 'z-fail.txt'), 'Z1', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const cand = ws.store.loadCandidate(frozen.candidate.id)
    const zChange = cand.changes.find((c) => c.path.endsWith('z-fail.txt'))
    rmSync(ws.store.blobPath(zChange.after.hash), { force: true })
    const res = ws.applyCandidate(frozen.candidate.id)
    const aHidden = readAttrsSync(join(tree, 'hidden-child.txt'))
    const aSys = readAttrsSync(join(tree, 'sys-child.txt'))
    const aSub = readAttrsSync(join(tree, 'sub'))
    const sysMode = statSync(join(tree, 'sys-child.txt')).mode & 0o777
    check(
      'R29-B1 目录树回滚：子文件 hidden、子文件 system+readonly、子目录 hidden 逐项恢复；整体 rolled-back',
      res.status === 'rolled-back' &&
        existsSync(join(tree, 'hidden-child.txt')) &&
        aHidden.hidden === true &&
        aSys.system === true &&
        sysMode === 0o444 &&
        aSub.hidden === true,
      JSON.stringify({ status: res.status, hidden: aHidden.hidden, system: aSys.system, sysMode: sysMode.toString(8), subHidden: aSub.hidden }).slice(0, 360),
    )
    spawnSync('attrib.exe', ['-S', '-R', join(tree, 'sys-child.txt')], { encoding: 'utf8' })
  }
  // R29-B2：回滚属性失败 ⇒ 如实 partially-applied + ROLLBACK_ATTRIBUTE_FAILED（不谎称 rolled-back）
  {
    const { ws, root } = makeWs('r29treefail')
    const tree = join(root, 'a-tree2')
    mkdirSync(join(tree, 'sub'), { recursive: true })
    writeFileSync(join(tree, 'hidden-child.txt'), 'H')
    setAttrsSync(join(tree, 'hidden-child.txt'), { hidden: true, system: false })
    writeFileSync(join(root, 'z-fail2.txt'), 'Z0')
    ws.remove(tree, { origin: 'test' })
    ws.writeFile(join(root, 'z-fail2.txt'), 'Z1', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const cand = ws.store.loadCandidate(frozen.candidate.id)
    const zChange = cand.changes.find((c) => c.path.endsWith('z-fail2.txt'))
    rmSync(ws.store.blobPath(zChange.after.hash), { force: true })
    const res = ws.applyCandidate(frozen.candidate.id, {
      attributeIo: { set: () => ({ ok: false, code: 'ATTRIB_SET_FAILED', message: 'forced rollback attr failure' }) },
    })
    check(
      'R29-B2 回滚属性失败：如实 partially-applied + rollback ok=false / ROLLBACK_ATTRIBUTE_FAILED（不谎称 rolled-back）',
      res.status === 'partially-applied' &&
        res.rolledBack === false &&
        Array.isArray(res.rollback) &&
        res.rollback.some((r) => r.ok === false && r.code === 'ROLLBACK_ATTRIBUTE_FAILED'),
      JSON.stringify({ status: res.status, rolledBack: res.rolledBack, rollback: res.rollback }).slice(0, 400),
    )
  }

W('')
W('='.repeat(64))
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} skips=${skips}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
