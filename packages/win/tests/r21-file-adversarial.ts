#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；本套件为 R21 新登记套件。
/**
 * r21-file-adversarial —— **R21 G3 文件侧对抗审计套件**
 *
 * 合同 `.lead/r21-contract.md` §2 G3：① 长路径 `\\?\`（>MAX_PATH、`\\?\UNC\…`）；
 * ② UNC / subst 盘符；③ 8.3 短名（写入/读取/rename）；④ 删除后重建（whiteout→create）；
 * ⑤ ACL/时间戳 apply 后是否被意外改写；⑥ 部分失败回滚（批量 apply 一条失败语义）；
 * ⑦ 并发 apply（两个 applyCandidate 同时/串行化）。
 *
 * A. shim 侧（`shim/src/ws_file.c`；需要 injector；`WINSTAGE_SHIM_OUT` 可指向私有构建）
 *   A1  `\\?\` 前缀（≤MAX_PATH）读写：与普通路径同一暂存键（真实盘零写）；
 *   A2  长路径 >MAX_PATH：**R21 设计边界 = fail-closed**（真实盘零写、暂存树无残留）；
 *       支持它需要 provider（ws_stage.c/ws_util.c）全面加 `\\?\`，超出本轮写域，如实登记；
 *   A3  `\\?\UNC\localhost\C$\…` / `\\localhost\C$\…`：与盘符路径同一暂存键（同一文件
 *       不能有两套 staging key），遮蔽读仍被拒；
 *   A4  subst 盘符（`subst Y: <ws>`）：写入经 Y: 暂存、经盘符读回可见；遮蔽读仍被拒；
 *   A5  8.3 短名：短名写入 → 长名/短名读回同一暂存内容，真实长名文件不变；
 *   A6  删除后重建：write V1 → unlink → write V2 ⇒ 读回 V2（whiteout 必须被清除）。
 *
 * B. workspace.ts 侧（离线，无需注入）
 *   B1  apply 后属性/时间：内容更新；**readonly 位保留**；ACL（icacls 文本）不变；
 *       mtime 变化（内容更新是预期，非"意外改写"——设计口径）；
 *   B2  部分失败：第二条 blob 被移除 ⇒ applied=[a] / failed=[b:BLOB_MISSING] /
 *       remaining=[b]；真实盘 a 新、b 旧；再次 apply **不把已落盘条目误报 STALE**
 *       （R21 幂等快路径修复）；
 *   B3  串行化：被取代候选 apply ⇒ `CANDIDATE_SUPERSEDED_BY_PRUNE`；外部改写后 apply
 *       ⇒ STALE_BASELINE + conflicts，真实盘不被覆盖；同候选二次 apply ⇒ ALREADY_APPLIED；
 *   B4  跨进程并发 apply 同一候选：最终内容必须是候选内容（不出现半写/旧内容），
 *       竞争方要么成功要么 STALE_BASELINE（无锁 → 记录"最后写入者"残余）；
 *   B5  工作区 apply 支持 >MAX_PATH 路径（Node 侧 libuv 自动加 `\\?\`）；
 *   B6  只读文件 apply：内容落盘且只读位保留（R21 属性保留修复）。
 *
 * 判定口径：shim 侧安全方向是 fail-closed / 同一键；workspace 侧不允许"静默丢内容/丢属性"。
 * SKIP 如实记录（非 PASS）。缺 canonical shim 时 A 段整体 SKIP。
 *
 * 用法：
 *   node tests\r21-file-adversarial.ts
 *   WINSTAGE_SHIM_OUT=<dir> node tests\r21-file-adversarial.ts   # 私有构建验证
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { skipSuiteWhenAppControlBlocks } from './_app-control.ts'
import { Workspace } from '../src/workspace.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRATCH = join(REPO, '.t', 'r21-suite', 'file-adversarial')
const SHIMOUT = process.env.WINSTAGE_SHIM_OUT ? resolve(process.env.WINSTAGE_SHIM_OUT) : join(REPO, 'shim', 'out')
const DLL = join(SHIMOUT, 'winstage-shim.dll')
const INJECTOR = join(SHIMOUT, 'winstage-inject.exe')
const CMD = process.env.ComSpec || 'cmd.exe'
const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0
let skips = 0

function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`  ${condition ? '✓' : '✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
}
function skip(name, reason) {
  skips += 1
  W(`  ~ SKIP ${name}\n      原因: ${reason}`)
}
function section(title) {
  W('')
  W(`=== ${title} ===`)
}

// 环境闸门（2026-10-22）：Smart App Control 强制态会拒绝现场编译的探针 exe（Win32 4551）。
if (skipSuiteWhenAppControlBlocks(W, 'r21-file-adversarial')) process.exit(0)
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
const content = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch (e) {
    return `ERR:${e.code}`
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

// ═════════════════════ A. shim 侧（长路径 / UNC / subst / 8.3 / 删除重建） ═════
section('A. shim 侧对抗（injector + 真实磁盘）')

if (process.platform !== 'win32' || !existsSync(DLL) || !existsSync(INJECTOR)) {
  skip('A.* shim 侧全部用例', `requires win32 + shim 产物（dll=${existsSync(DLL)} injector=${existsSync(INJECTOR)} shimout=${SHIMOUT}）`)
} else {
  const STAGE = join(SCRATCH, 'stage')
  const WS = join(SCRATCH, 'ws')
  const MASK = join(SCRATCH, 'session', 'read-deny.mask.json')
  for (const d of [STAGE, WS, join(SCRATCH, 'session')]) mkdirSync(d, { recursive: true })
  const exportMask = spawnSync(process.execPath, [join(REPO, 'src', 'paths.ts'), '--export-mask', MASK], { encoding: 'utf8' })
  if (exportMask.status !== 0) {
    skip('A.* shim 侧全部用例', `mask 导出失败 status=${exportMask.status}`)
  } else {
    let cfgSeq = 0
    function inject(tag, script, timeout = 120000) {
      cfgSeq += 1
      const cfg = join(SCRATCH, `cfg-${tag}-${cfgSeq}.json`)
      writeFileSync(
        cfg,
        JSON.stringify({
          stageRoot: STAGE,
          logPath: join(STAGE, `shim-${tag}.log`),
          failClosed: true,
          readThrough: true,
          verbose: false,
          readDenyFile: MASK,
          readDenyFailClosed: true,
          passthrough: [STAGE],
        }),
      )
      const env = { ...process.env }
      env.WINSTAGE_STAGE_ROOT = STAGE
      env.WINSTAGE_SHIM_CONFIG = cfg
      env.WINSTAGE_SHIM_LOG = join(STAGE, `shim-${tag}.log`)
      const r = spawnSync(
        INJECTOR,
        ['--dll', DLL, '--report', join(SCRATCH, `report-${tag}.json`), '--cwd', SCRATCH, '--', process.execPath, '-e', script],
        { env, encoding: 'utf8', timeout },
      )
      return { status: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}` }
    }
    const stagedHas = (marker) => walkFiles(STAGE).filter((f) => content(f).includes(marker)).length

    // ── A1 `\\?\` 前缀（≤MAX_PATH）与普通路径同键 ──────────────────────────
    {
      const plain = join(WS, 'prefixed-short.txt')
      const prefixed = `\\\\?\\${plain}`
      const w = inject('prefixed-write', `require('fs').writeFileSync(${JSON.stringify(prefixed)},'R21-PREFIXED')`)
      const rPlain = inject('prefixed-read-plain', `try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(plain)},'utf8'))}catch(e){process.stderr.write('ERR:'+e.code);process.exit(9)}`)
      const rPref = inject('prefixed-read-pref', `try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(prefixed)},'utf8'))}catch(e){process.stderr.write('ERR:'+e.code);process.exit(9)}`)
      check(
        'A1.1 `\\\\?\\` 前缀（≤MAX_PATH）写入 ⇒ 暂存（真实盘无文件）且普通/前缀两种读法同键可见',
        w.status === 0 && !existsSync(plain) && rPlain.text.includes('R21-PREFIXED') && rPref.text.includes('R21-PREFIXED'),
        `write=${w.status} realExists=${existsSync(plain)} plainRead=${rPlain.status} prefixedRead=${rPref.status}`,
      )
    }

    // ── A2 长路径 >MAX_PATH：R23 已从 fail-closed 收窄为**写也进暂存** ──────
    {
      let rel = 'longroot'
      for (let i = 0; i < 12; i++) rel = join(rel, `segment-depth-${i}-xxxxxxxxxxxx`)
      const longDirAbs = join(WS, rel)
      const longAbs = join(longDirAbs, 'f.txt')
      const longPref = `\\\\?\\${longAbs}`
      const w = inject('long-write', `const fs=require('fs');try{fs.mkdirSync(${JSON.stringify(`\\\\?\\${longDirAbs}`)},{recursive:true});fs.writeFileSync(${JSON.stringify(longPref)},'R21-LONG');process.stdout.write('WROTE')}catch(e){process.stderr.write('ERR:'+e.code);process.exit(9)}`)
      const back = inject('long-write-back', `try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(longPref)},'utf8'))}catch(e){process.stderr.write('ERR:'+e.code);process.exit(9)}`)
      check(
        'A2.1 长路径 >MAX_PATH：R23 收窄后**写进暂存**（真实盘零写、暂存树有内容、可读回）——不再是 fail-closed 设计边界',
        w.status === 0 && !existsSync(longAbs) && stagedHas('R21-LONG') > 0 && back.text.includes('R21-LONG'),
        `len=${longAbs.length} write=${w.status} realExists=${existsSync(longAbs)} staged=${stagedHas('R21-LONG')} readBack=${back.status} text=${w.text.replace(/\r?\n/g, ' | ').slice(0, 160)}`,
      )
    }

    // ── A2b 长路径 >MAX_PATH：**预先存在的真实文件读透传** ──────────────────
    // gate-runner 独立探针 S2 红：未注入可读、注入后 ERR=3（前缀被剥掉后交给真实 API）。
    // 修法：真实 API 边界补 `\\?\`（ws_api_path）+ intercept 用原始路径重试绝对化。
    {
      let rel = 'longread'
      for (let i = 0; i < 12; i++) rel = join(rel, `read-depth-${i}-yyyyyyyyyyyy`)
      const longDir = join(WS, rel)
      const longAbs = join(longDir, 'normal.txt')
      const longPref = `\\\\?\\${longAbs}`
      mkdirSync(`\\\\?\\${longDir}`, { recursive: true })
      writeFileSync(`\\\\?\\${longAbs}`, 'R21-LONG-READ-NORMAL')
      const viaDrive = inject('longread-drive', `try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(longPref)},'utf8'))}catch(e){process.stderr.write('ERR:'+e.code);process.exit(9)}`)
      check(
        'A2.2 已存在的 >MAX_PATH 真实文件：注入进程经 `\\\\?\\` 读透传必须返回内容（gate-runner S2 红→绿）',
        longAbs.length > 260 && existsSync(longPref) && viaDrive.status === 0 && viaDrive.text.includes('R21-LONG-READ-NORMAL'),
        `len=${longAbs.length} status=${viaDrive.status} text=${viaDrive.text.replace(/\r?\n/g, ' | ').slice(0, 160)}`,
      )
      const relC = longAbs.replace(/^[A-Za-z]:\\/, '')
      const longUnc = `\\\\?\\UNC\\localhost\\C$\\${relC}`
      const viaUnc = inject('longread-unc', `try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(longUnc)},'utf8'))}catch(e){process.stderr.write('ERR:'+e.code);process.exit(9)}`)
      check(
        'A2.3 已存在的 >MAX_PATH 真实文件：经 `\\\\?\\UNC\\localhost\\C$\\…` 读透传同样返回内容',
        viaUnc.status === 0 && viaUnc.text.includes('R21-LONG-READ-NORMAL'),
        `status=${viaUnc.status} text=${viaUnc.text.replace(/\r?\n/g, ' | ').slice(0, 160)}`,
      )
    }

    // ── A2c 读类 API 对 >MAX_PATH 的透传（Lead/gate-runner 要求：读透传、写 fail-closed）──
    {
      const zig = join(REPO, 'tools', 'toolchain', 'zig-0.13.0', 'zig.exe')
      const devProbe = join(SCRATCH, 'r21-readprobe.exe')
      const cSrc = String.raw`#include <windows.h>
#include <winternl.h>
#include <stdio.h>
static int ntcreate(const wchar_t *win, ACCESS_MASK access, ULONG disp, HANDLE *h){
  wchar_t nt[2048]; wcscpy(nt,L"\\??\\"); wcsncat(nt,win,2000-wcslen(nt));
  UNICODE_STRING n; n.Length=(USHORT)(wcslen(nt)*sizeof(WCHAR)); n.MaximumLength=(USHORT)(n.Length+sizeof(WCHAR)); n.Buffer=nt;
  OBJECT_ATTRIBUTES oa; InitializeObjectAttributes(&oa,&n,OBJ_CASE_INSENSITIVE,NULL,NULL);
  IO_STATUS_BLOCK ios; memset(&ios,0,sizeof(ios));
  return (int)NtCreateFile(h,access|SYNCHRONIZE,&oa,&ios,NULL,FILE_ATTRIBUTE_NORMAL,7,disp,0x60,NULL,0);
}
int main(int argc,char**argv){
  if(argc<3) return 2;
  wchar_t p[2048]; MultiByteToWideChar(CP_ACP,0,argv[2],-1,p,2048);
  if(!strcmp(argv[1],"readpath")){
    HANDLE h=CreateFileW(p,GENERIC_READ,7,NULL,OPEN_EXISTING,0,NULL);
    if(h==INVALID_HANDLE_VALUE){printf("ERR CreateFileW=%lu\n",(unsigned long)GetLastError());return 10;}
    char b[256]; DWORD got=0; BOOL ok=ReadFile(h,b,255,&got,NULL); CloseHandle(h);
    if(!ok) return 11; b[got]=0; printf("CONTENT=%s\n",b); return 0;
  }
  if(!strcmp(argv[1],"statpath")){
    DWORD a=GetFileAttributesW(p); WIN32_FILE_ATTRIBUTE_DATA fad;
    BOOL ok=GetFileAttributesExW(p,GetFileExInfoStandard,&fad);
    printf("ATTRS=0x%lx EX=%d SIZE=%lu\n",(unsigned long)a,(int)ok,(unsigned long)(ok?fad.nFileSizeLow:0));
    return (a==INVALID_FILE_ATTRIBUTES)?12:0;
  }
  if(!strcmp(argv[1],"findfirst")){
    WIN32_FIND_DATAW fd; HANDLE h=FindFirstFileW(p,&fd);
    if(h==INVALID_HANDLE_VALUE){printf("ERR FindFirst=%lu\n",(unsigned long)GetLastError());return 13;}
    int n=0; do{printf("ENTRY=%ls\n",fd.cFileName);n++;}while(FindNextFileW(h,&fd));
    FindClose(h); printf("COUNT=%d\n",n); return 0;
  }
  if(!strcmp(argv[1],"ntread")){
    HANDLE h=INVALID_HANDLE_VALUE; if(ntcreate(p,GENERIC_READ,1,&h)<0) return 14;
    char b[256]; DWORD got=0; BOOL ok=ReadFile(h,b,255,&got,NULL); CloseHandle(h);
    if(!ok) return 15; b[got]=0; printf("CONTENT=%s\n",b); return 0;
  }
  if(!strcmp(argv[1],"ntwrite")){
    HANDLE h=INVALID_HANDLE_VALUE; int st=ntcreate(p,GENERIC_WRITE,3,&h);
    printf("NTSTATUS=0x%08lx\n",(unsigned long)st);
    if(st<0) return 0;
    DWORD w=0; WriteFile(h,"R21-READPROBE",13,&w,NULL); CloseHandle(h); return 16;
  }
  return 3;
}
`
      const ready = (() => {
        if (!existsSync(zig)) return false
        writeFileSync(join(SCRATCH, 'r21-readprobe.c'), cSrc, 'utf8')
        for (const d of ['tmp2', 'zigcache2/global', 'zigcache2/local']) mkdirSync(join(SCRATCH, d), { recursive: true })
        const comp = spawnSync(zig, ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-o', devProbe, join(SCRATCH, 'r21-readprobe.c')], {
          env: {
            ...process.env,
            TMP: join(SCRATCH, 'tmp2'),
            TEMP: join(SCRATCH, 'tmp2'),
            ZIG_GLOBAL_CACHE_DIR: join(SCRATCH, 'zigcache2', 'global'),
            ZIG_LOCAL_CACHE_DIR: join(SCRATCH, 'zigcache2', 'local'),
          },
          encoding: 'utf8',
          timeout: 180000,
        })
        return comp.status === 0 && existsSync(devProbe)
      })()
      function injectExe(tag, exe, args) {
        cfgSeq += 1
        const cfg = join(SCRATCH, `cfg-${tag}-${cfgSeq}.json`)
        writeFileSync(cfg, JSON.stringify({ stageRoot: STAGE, logPath: join(STAGE, `shim-${tag}.log`), failClosed: true, readThrough: true, verbose: false, readDenyFile: MASK, readDenyFailClosed: true, passthrough: [STAGE] }))
        const e = { ...process.env, WINSTAGE_STAGE_ROOT: STAGE, WINSTAGE_SHIM_CONFIG: cfg, WINSTAGE_SHIM_LOG: join(STAGE, `shim-${tag}.log`) }
        const r = spawnSync(INJECTOR, ['--dll', DLL, '--report', join(SCRATCH, `report-${tag}.json`), '--cwd', SCRATCH, '--', exe, ...args], { env: e, encoding: 'utf8', timeout: 120000 })
        return { status: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().replace(/\r?\n/g, ' | ') }
      }
      if (!ready) {
        skip('A2.4/A2.5/A2.6 读类 API >MAX_PATH 透传（需 zig 编译原生探针）', 'zig/probe 不可用')
      } else {
        let absDir = join(WS, 'readpath-long')
        for (let i = 0; i < 12; i++) absDir = join(absDir, `rd-${i}-zzzzzzzzzzzz`)
        const longFile = join(absDir, 'target.txt')
        mkdirSync(`\\\\?\\${absDir}`, { recursive: true })
        writeFileSync(`\\\\?\\${longFile}`, 'R21-READ-CLASS')
        const st = injectExe('a2c-stat', devProbe, ['statpath', `\\\\?\\${longFile}`])
        const ff = injectExe('a2c-find', devProbe, ['findfirst', `\\\\?\\${absDir}\\*`])
        check(
          'A2.4 >MAX_PATH 的 GetFileAttributes(Ex)/FindFirstFileW 读类调用 ⇒ 透传真实文件系统（stat 有大小、FindFirst 列出目标）',
          st.status === 0 && st.text.includes('SIZE=14') && ff.status === 0 && ff.text.includes('target.txt'),
          `stat=${st.text.slice(0, 140)} find=${ff.text.slice(0, 140)}`,
        )
        const ntRead = injectExe('a2c-ntread', devProbe, ['ntread', longFile])
        check(
          'A2.5 NtCreateFile **读意图** 经 >MAX_PATH ⇒ 透传成功返回内容（gate-runner S2 同族）',
          ntRead.status === 0 && ntRead.text.includes('R21-READ-CLASS'),
          `status=${ntRead.status} text=${ntRead.text.slice(0, 160)}`,
        )
        const ntTarget = join(absDir, 'nt-write.txt')
        rmSync(`\\\\?\\${ntTarget}`, { force: true })
        const ntWrite = injectExe('a2c-ntwrite', devProbe, ['ntwrite', ntTarget])
        check(
          'A2.6 NtCreateFile **写意图** 经 >MAX_PATH ⇒ fail-closed（0xC0000022），真实盘零写',
          !existsSync(`\\\\?\\${ntTarget}`) && !ntWrite.text.includes('NTSTATUS=0x00000000'),
          `realExists=${existsSync(`\\\\?\\${ntTarget}`)} text=${ntWrite.text.slice(0, 160)}`,
        )
      }
    }

    // ── A3 `\\?\UNC\` / `\\localhost\C$` 与盘符同键 + 遮蔽 ─────────────────
    {
      const rel = WS.replace(/^[A-Za-z]:\\/, '')
      const uncDir = `\\\\localhost\\C$\\${rel}\\unc-dir`
      const prefUncDir = `\\\\?\\UNC\\localhost\\C$\\${rel}\\unc-pref-dir`
      const w = inject('unc-write', `const fs=require('fs');try{fs.mkdirSync(${JSON.stringify(uncDir)},{recursive:true});fs.writeFileSync(${JSON.stringify(`${uncDir}\\u.txt`)},'R21-UNC');fs.mkdirSync(${JSON.stringify(prefUncDir)},{recursive:true});fs.writeFileSync(${JSON.stringify(`${prefUncDir}\\p.txt`)},'R21-UNC-PREF')}catch(e){process.stderr.write('ERR:'+e.code);process.exit(9)}`)
      const viaDrive = join(WS, 'unc-dir', 'u.txt')
      const viaDrivePref = join(WS, 'unc-pref-dir', 'p.txt')
      const rC = inject('unc-read-c', `try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(viaDrive)},'utf8'))}catch(e){process.stderr.write('ERR:'+e.code);process.exit(9)}`)
      const rCPref = inject('unc-pref-read-c', `try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(viaDrivePref)},'utf8'))}catch(e){process.stderr.write('ERR:'+e.code);process.exit(9)}`)
      check(
        'A3.1 `\\\\localhost\\C$\\…` 与 `\\\\?\\UNC\\localhost\\C$\\…` 写入 ⇒ 暂存（真实盘无）且经盘符路径读回可见（同一 staging key）',
        w.status === 0 && !existsSync(viaDrive) && !existsSync(viaDrivePref) && rC.text.includes('R21-UNC') && rCPref.text.includes('R21-UNC-PREF'),
        `write=${w.status} realC=${existsSync(viaDrive)} realPref=${existsSync(viaDrivePref)} readC=${rC.status} readPref=${rCPref.status}`,
      )
      const maskedDir = join(WS, 'unc-mask')
      mkdirSync(maskedDir, { recursive: true })
      writeFileSync(join(maskedDir, '.npmrc'), 'R21-UNC-MASK-SECRET')
      const uncMasked = `\\\\localhost\\C$\\${rel}\\unc-mask\\.npmrc`
      const mr = inject('unc-mask', `try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(uncMasked)},'utf8'))}catch(e){process.stderr.write('DENIED:'+e.code);process.exit(9)}`)
      check(
        'A3.2 经管理共享 UNC 读 `.npmrc` ⇒ 拒绝且无明文（遮蔽判定走 canonical 路径）',
        !mr.text.includes('R21-UNC-MASK-SECRET'),
        `status=${mr.status} leaked=${mr.text.includes('R21-UNC-MASK-SECRET')}`,
      )
    }

    // ── A4 subst 盘符与真实盘符同键 + 遮蔽 ────────────────────────────────
    {
      const sub = spawnSync('subst', ['Y:', WS], { encoding: 'utf8' })
      if (sub.status !== 0) {
        skip('A4.* subst 盘符用例', `subst 不可用 status=${sub.status}`)
      } else {
        try {
          const w = inject('subst-write', `const fs=require('fs');try{fs.mkdirSync('Y:\\\\subst-dir',{recursive:true});fs.writeFileSync('Y:\\\\subst-dir\\\\s.txt','R21-SUBST')}catch(e){process.stderr.write('ERR:'+e.code);process.exit(9)}`)
          const viaDrive = join(WS, 'subst-dir', 's.txt')
          const rC = inject('subst-read-c', `try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(viaDrive)},'utf8'))}catch(e){process.stderr.write('ERR:'+e.code);process.exit(9)}`)
          check(
            'A4.1 subst 盘符写入 ⇒ 暂存（真实盘无）且经真实盘符读回可见（同一 staging key）',
            w.status === 0 && !existsSync(viaDrive) && rC.text.includes('R21-SUBST'),
            `write=${w.status} realExists=${existsSync(viaDrive)} readViaDrive=${rC.status}`,
          )
          mkdirSync(join(WS, 'subst-mask'), { recursive: true })
          writeFileSync(join(WS, 'subst-mask', '.npmrc'), 'R21-SUBST-MASK-SECRET')
          const mr = inject('subst-mask', `try{process.stdout.write(require('fs').readFileSync('Y:\\\\subst-mask\\\\.npmrc','utf8'))}catch(e){process.stderr.write('DENIED:'+e.code);process.exit(9)}`)
          check(
            'A4.2 经 subst 盘符读 `.npmrc` ⇒ 拒绝且无明文',
            !mr.text.includes('R21-SUBST-MASK-SECRET'),
            `status=${mr.status} leaked=${mr.text.includes('R21-SUBST-MASK-SECRET')}`,
          )
        } finally {
          spawnSync('subst', ['Y:', '/D'], { encoding: 'utf8' })
        }
      }
    }

    // ── A5 8.3 短名与长名同键 ─────────────────────────────────────────────
    {
      const d = join(WS, 'short83')
      mkdirSync(d, { recursive: true })
      const longFile = join(d, 'LongFileName-For-ShortName-Test.txt')
      writeFileSync(longFile, 'R21-83-REAL-OLD')
      const dirx = spawnSync(CMD, ['/d', '/c', 'dir', '/x', d], { encoding: 'utf8' })
      const m = String(dirx.stdout || '').match(/^(\S+~1\.TXT)\s+/m)
      const shortPath = join(d, m ? m[1] : 'LONGFI~1.TXT')
      const w = inject('short-write', `require('fs').writeFileSync(${JSON.stringify(shortPath)},'R21-83-STAGED')`)
      const rLong = inject('short-read-long', `try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(longFile)},'utf8'))}catch(e){process.stderr.write('ERR:'+e.code);process.exit(9)}`)
      const rShort = inject('short-read-short', `try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(shortPath)},'utf8'))}catch(e){process.stderr.write('ERR:'+e.code);process.exit(9)}`)
      check(
        'A5.1 8.3 短名写入 ⇒ 长名/短名读回同一暂存内容，真实长名文件内容不变',
        w.status === 0 && content(longFile) === 'R21-83-REAL-OLD' && rLong.text.includes('R21-83-STAGED') && rShort.text.includes('R21-83-STAGED'),
        `write=${w.status} realContent=${JSON.stringify(content(longFile))} longRead=${rLong.status} shortRead=${rShort.status}`,
      )
      // 8.3 祖先目录 + 遮蔽（AppData\Local\Microsoft\Windows\INetCookies 命中 credential-cache 规则）
      const maskDir = join(WS, 'AppData', 'Local', 'Microsoft', 'Windows', 'INetCookies')
      mkdirSync(maskDir, { recursive: true })
      writeFileSync(join(maskDir, 'cookie-secret.txt'), 'R21-83-MASK-SECRET')
      const shortMasked = join(WS, 'AppData', 'Local', 'MICROS~1', 'Windows', 'INETCO~1', 'cookie-secret.txt')
      const rMaskedShort = existsSync(shortMasked)
        ? inject('mask-short83', `try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(shortMasked)},'utf8'))}catch(e){process.stderr.write('DENIED:'+e.code);process.exit(9)}`)
        : null
      check(
        'A5.2 经 8.3 短名祖先路径读被遮蔽文件 ⇒ 拒绝且无明文（遮蔽归一化走 long name）',
        rMaskedShort !== null && !rMaskedShort.text.includes('R21-83-MASK-SECRET'),
        rMaskedShort === null ? `短名路径不可构造：${shortMasked}` : `status=${rMaskedShort.status} leaked=${rMaskedShort.text.includes('R21-83-MASK-SECRET')}`,
      )
    }

    // ── A6 删除后重建（whiteout → create） ────────────────────────────────
    {
      const p = join(WS, 'recreate.txt')
      const r = inject(
        'recreate',
        `const fs=require('fs');const p=${JSON.stringify(p)};fs.writeFileSync(p,'V1');fs.unlinkSync(p);fs.writeFileSync(p,'V2');process.stdout.write('R:'+fs.readFileSync(p,'utf8'))`,
      )
      check(
        'A6.1 write V1 → unlink → write V2 ⇒ 读回 V2（删除后的白障必须被重建清除）',
        r.status === 0 && r.text.includes('R:V2') && !existsSync(p),
        `status=${r.status} text=${JSON.stringify(r.text.trim().slice(0, 80))} realExists=${existsSync(p)}`,
      )
    }
  }
}

// ═════════════════════ B. workspace.ts 侧（apply 属性/部分失败/并发/长路径） ═════
section('B. workspace.ts apply 对抗（离线）')

let seq = 0
function makeWs(tag) {
  const root = join(SCRATCH, `ws-${tag}`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const storeDir = join(SCRATCH, `store-${tag}`)
  rmSync(storeDir, { recursive: true, force: true })
  const ws = new Workspace({ workspaceRoot: root, storeDir, sessionId: `r21-${tag}` }).init({ sessionId: `r21-${tag}` })
  return { ws, root, storeDir }
}

// ── B1 时间戳 / 只读属性 / ACL ─────────────────────────────────────────────
{
  const { ws, root } = makeWs(`attrs-${seq++}`)
  const p = join(root, 'attrs.txt')
  writeFileSync(p, 'BASE')
  const old = new Date('2020-01-02T03:04:05Z')
  utimesSync(p, old, old)
  const before = statSync(p)
  const aclBefore = spawnSync('icacls', [p], { encoding: 'utf8' }).stdout
  ws.writeFile(p, 'MODIFIED', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  const applied = ws.applyCandidate(frozen.candidate.id)
  const after = statSync(p)
  const aclAfter = spawnSync('icacls', [p], { encoding: 'utf8' }).stdout
  check(
    'B1.1 apply 修改内容后：只读位保留、ACL 文本不变；mtime 变化（内容更新是预期，非意外改写）',
    content(p) === 'MODIFIED' &&
      applied.status === 'applied' &&
      after.mode === before.mode &&
      aclBefore === aclAfter &&
      after.mtime.getTime() !== before.mtime.getTime(),
    `content=${content(p)} mode=${before.mode.toString(8)}->${after.mode.toString(8)} aclSame=${aclBefore === aclAfter} mtimeChanged=${after.mtime.getTime() !== before.mtime.getTime()}`,
  )
}

// ── B2 部分失败语义（blob 缺失）─────────────────────────────────────────────
{
  const { ws, root } = makeWs(`partial-${seq++}`)
  writeFileSync(join(root, 'a.txt'), 'A-BASE')
  writeFileSync(join(root, 'b.txt'), 'B-BASE')
  ws.writeFile(join(root, 'a.txt'), 'A-NEW', { origin: 'test' })
  ws.writeFile(join(root, 'b.txt'), 'B-NEW', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  const cand = ws.store.loadCandidate(frozen.candidate.id)
  const bChange = cand.changes.find((c) => c.path.endsWith('b.txt'))
  rmSync(ws.store.blobPath(bChange.after.hash), { force: true })
  const result = ws.applyCandidate(frozen.candidate.id)
  check(
    'B2.1 R24 原子化后：批量 apply 中途失败 ⇒ status=rolled-back、applied=[]、failed=[b:BLOB_MISSING]，真实盘 a/b 都回到原内容（全有或全无）',
    result.status === 'rolled-back' &&
      (result.applied || []).length === 0 &&
      result.failed.some((x) => x.path === 'b.txt' && x.code === 'BLOB_MISSING') &&
      content(join(root, 'a.txt')) === 'A-BASE' &&
      content(join(root, 'b.txt')) === 'B-BASE',
    JSON.stringify({ status: result.status, applied: result.applied, failed: result.failed, a: content(join(root, 'a.txt')), b: content(join(root, 'b.txt')) }).slice(0, 320),
  )
  const again = ws.applyCandidate(frozen.candidate.id)
  check(
    'B2.2 R24 原子化后：再次 apply 仍 rolled-back（失败仍只报 BLOB_MISSING，不误报 STALE），真实盘保持原内容',
    (again.failed || []).length === 1 &&
      again.failed[0].code === 'BLOB_MISSING' &&
      (again.applied || []).length === 0 &&
      again.status === 'rolled-back' &&
      content(join(root, 'a.txt')) === 'A-BASE' &&
      content(join(root, 'b.txt')) === 'B-BASE',
    JSON.stringify({ status: again.status, applied: again.applied, failed: (again.failed || []).map((x) => x.code), remaining: again.remaining }),
  )
}

// ── B3 串行化：supersede / 外部改写冲突 / 幂等 ──────────────────────────────
{
  const { ws, root } = makeWs(`serial-${seq++}`)
  const p = join(root, 's.txt')
  writeFileSync(p, 'S-BASE')
  ws.writeFile(p, 'S-ONE', { origin: 'test' })
  const f1 = ws.freezeCandidate({})
  ws.writeFile(p, 'S-TWO', { origin: 'test' })
  const f2 = ws.freezeCandidate({})
  let supersededError = null
  try {
    ws.applyCandidate(f1.candidate.id)
  } catch (e) {
    supersededError = e
  }
  const r2 = ws.applyCandidate(f2.candidate.id)
  check(
    'B3.1 冻结取代：apply 被取代候选 ⇒ CANDIDATE_SUPERSEDED_BY_PRUNE（串行化，不写盘）；新候选正常 applied',
    supersededError?.code === 'CANDIDATE_SUPERSEDED_BY_PRUNE' && r2.status === 'applied' && content(p) === 'S-TWO',
    `supersededError=${supersededError?.code} r2=${r2.status} real=${JSON.stringify(content(p))}`,
  )
  // external modification after freeze
  ws.writeFile(p, 'S-THREE', { origin: 'test' })
  const f3 = ws.freezeCandidate({})
  writeFileSync(p, 'S-EXTERNAL')
  const r3 = ws.applyCandidate(f3.candidate.id)
  check(
    'B3.2 冻结后真实盘被外部改写 ⇒ 整批 STALE_BASELINE + conflicts，真实盘保持外部内容（不覆盖）',
    r3.status === 'pending' && r3.failed.some((x) => x.code === 'STALE_BASELINE') && r3.conflicts.length > 0 && content(p) === 'S-EXTERNAL',
    JSON.stringify({ status: r3.status, failed: r3.failed.map((x) => x.code), conflicts: r3.conflicts.map((c) => c.changed), real: content(p) }).slice(0, 320),
  )
  // idempotent second apply of an applied candidate
  const r1again = ws.applyCandidate(f2.candidate.id)
  check(
    'B3.3 已 applied 候选二次 apply ⇒ idempotent ALREADY_APPLIED（applied/failed 形状完整）',
    r1again.idempotent === 'ALREADY_APPLIED' && Array.isArray(r1again.applied) && r1again.applied.length === 0,
    JSON.stringify({ idempotent: r1again.idempotent, applied: r1again.applied }),
  )
}

// ── B4 跨进程并发 apply 同一候选 ────────────────────────────────────────────
{
  const { ws, root, storeDir } = makeWs(`conc-${seq++}`)
  const p = join(root, 'conc.txt')
  writeFileSync(p, 'CONC-BASE')
  ws.writeFile(p, 'CONC-NEW', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  const worker = join(SCRATCH, 'conc-worker.mjs')
  const wsUrl = `file:///${join(REPO, 'src', 'workspace.ts').replace(/\\/g, '/')}`
  writeFileSync(
    worker,
    `import { Workspace } from ${JSON.stringify(wsUrl)};
const ws = new Workspace({ workspaceRoot: ${JSON.stringify(root)}, storeDir: ${JSON.stringify(storeDir)} }).init({});
try { const r = ws.applyCandidate(${JSON.stringify(frozen.candidate.id)}); console.log('OK ' + JSON.stringify({status:r.status, failed:(r.failed||[]).map(x=>x.code), idempotent:r.idempotent||null})); }
catch (e) { console.log('THROW ' + (e.code || e.message)); }
`,
  )
  const runner = join(SCRATCH, 'conc-runner.mjs')
  writeFileSync(
    runner,
    `import { spawn } from 'node:child_process';
const out=[];
const run=(tag)=>new Promise((res)=>{const c=spawn(process.execPath,['./conc-worker.mjs'],{cwd:${JSON.stringify(SCRATCH)},stdio:['ignore','pipe','pipe']});let s='';c.stdout.on('data',d=>s+=d);c.stderr.on('data',d=>s+=d);c.on('close',()=>{out.push(tag+':'+s.trim());res()})});
await Promise.all([run('w1'),run('w2')]);console.log(JSON.stringify(out));
`,
  )
  const rr = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 180000 })
  const results = String(rr.stdout || '').trim()
  const reinit = new Workspace({ workspaceRoot: root, storeDir, sessionId: `r21-conc-${seq}` }).init({ sessionId: `r21-conc-${seq}` })
  const corruption = reinit.verifyProjection()
  check(
    'B4.1 跨进程并发 apply 同一候选：最终内容 = 候选内容（无半写/旧内容/损坏）；竞争失败形态只允许 STALE_BASELINE / EPERM(store 文件竞态) / 幂等类 —— **无跨进程锁**，残余见 findings',
    content(p) === 'CONC-NEW' && corruption.length === 0 && !/THROW (?!EPERM|CANDIDATE|STALE)/.test(results),
    JSON.stringify({ real: content(p), corruption: corruption.length, results }).slice(0, 420),
  )
}

// ── B4b 跨进程并发 apply **不同**候选（同一路径）：记录 last-writer-wins 残余 ──
{
  const rootA = join(SCRATCH, 'race-root')
  rmSync(rootA, { recursive: true, force: true })
  mkdirSync(rootA, { recursive: true })
  const p = join(rootA, 'race.txt')
  writeFileSync(p, 'RACE-BASE')
  const mk = (tag) => {
    const storeDir = join(SCRATCH, `race-store-${tag}`)
    rmSync(storeDir, { recursive: true, force: true })
    return new Workspace({ workspaceRoot: rootA, storeDir, sessionId: `r21-race-${tag}` }).init({ sessionId: `r21-race-${tag}` })
  }
  const wsA = mk('a')
  wsA.writeFile(p, 'RACE-A', { origin: 'test' })
  const fA = wsA.freezeCandidate({})
  const wsB = mk('b')
  wsB.writeFile(p, 'RACE-B', { origin: 'test' })
  const fB = wsB.freezeCandidate({})
  const wsUrl = `file:///${join(REPO, 'src', 'workspace.ts').replace(/\\/g, '/')}`
  const workerFor = (tag, storeDir, id) => {
    const w = join(SCRATCH, `race-worker-${tag}.mjs`)
    writeFileSync(
      w,
      `import { Workspace } from ${JSON.stringify(wsUrl)};
const ws = new Workspace({ workspaceRoot: ${JSON.stringify(rootA)}, storeDir: ${JSON.stringify(storeDir)} }).init({});
try { const r = ws.applyCandidate(${JSON.stringify(id)}); console.log('OK ' + JSON.stringify({status:r.status, failed:(r.failed||[]).map(x=>x.code)})); }
catch (e) { console.log('THROW ' + (e.code || e.message)); }
`,
    )
    return w
  }
  const workerA = workerFor('a', join(SCRATCH, 'race-store-a'), fA.candidate.id)
  const workerB = workerFor('b', join(SCRATCH, 'race-store-b'), fB.candidate.id)
  const runner = join(SCRATCH, 'race-runner.mjs')
  writeFileSync(
    runner,
    `import { spawn } from 'node:child_process';
const out=[];
const run=(tag,file)=>new Promise((res)=>{const c=spawn(process.execPath,[file],{cwd:${JSON.stringify(SCRATCH)},stdio:['ignore','pipe','pipe']});let s='';c.stdout.on('data',d=>s+=d);c.stderr.on('data',d=>s+=d);c.on('close',()=>{out.push(tag+':'+s.trim());res()})});
await Promise.all([run('A',${JSON.stringify(workerA)}),run('B',${JSON.stringify(workerB)})]);console.log(JSON.stringify(out));
`,
  )
  const rr = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 180000 })
  const real = content(p)
  check(
    'B4.2 跨进程并发 apply 不同候选同一路径：无损坏、最终内容必是某个候选内容（**无文件锁 ⇒ last-writer-wins 残余**，两个都可能报 applied）',
    real === 'RACE-A' || real === 'RACE-B',
    JSON.stringify({ real, results: String(rr.stdout || '').trim() }).slice(0, 420),
  )
}

// ── B5 工作区 apply 支持 >MAX_PATH ──────────────────────────────────────────
{
  const { ws, root } = makeWs(`longws-${seq++}`)
  let relDir = ''
  for (let i = 0; i < 12; i++) relDir = join(relDir, `seg-${i}-xxxxxxxxxxxx`)
  const dir = join(root, relDir)
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'long.txt')
  ws.writeFile(p, 'LONG-WS', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  const applied = ws.applyCandidate(frozen.candidate.id)
  check(
    'B5.1 workspace apply 支持 >MAX_PATH 路径（Node/libuv 自动加 `\\\\?\\`）：applied 且真实盘内容正确',
    p.length > 260 && applied.status === 'applied' && content(p) === 'LONG-WS',
    `pathLen=${p.length} status=${applied.status} real=${JSON.stringify(content(p))}`,
  )
}

// ── B6 只读文件 apply 保留只读位（R21 修复） ────────────────────────────────
{
  const { ws, root } = makeWs(`ro-${seq++}`)
  const p = join(root, 'readonly.txt')
  writeFileSync(p, 'RO-BASE')
  chmodSync(p, 0o444)
  const modeBefore = statSync(p).mode
  ws.writeFile(p, 'RO-MOD', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  const applied = ws.applyCandidate(frozen.candidate.id)
  const modeAfter = statSync(p).mode
  check(
    'B6.1 只读文件 apply：内容落盘且**只读位保留**（旧行为会静默清掉 +R）',
    applied.status === 'applied' && content(p) === 'RO-MOD' && modeAfter === modeBefore,
    `status=${applied.status} content=${content(p)} mode=${modeBefore.toString(8)}->${modeAfter.toString(8)}`,
  )
  chmodSync(p, 0o666)
}

// ═════════════════════════ 汇总 ═════════════════════════
W('')
W('='.repeat(64))
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} skips=${skips}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
