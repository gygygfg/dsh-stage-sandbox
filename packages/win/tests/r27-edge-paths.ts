#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；R27 新登记套件。
/**
 * r27-edge-paths —— **R27-A：边缘路径（>4096 极端路径 / rename 跨卷 / 真实远端 SMB）**
 *
 * 合同 `.lead/r27-contract.md` §2 R27-A：
 *   1. >4096 极端路径（4096/8192/16000/32000，`\\?\`，读写/建/rename/delete）：
 *      先记录当前行为；若只是内部定长缓冲限制则扩大，否则 **fail-closed + 可归因**，
 *      绝不静默写真实盘。
 *   2. rename 跨卷（MoveFileExW + MOVEFILE_COPY_ALLOWED）：能安全表达则实现
 *      （copy-up+whiteout+新条目），否则 fail-closed；不得出现"源已动、目标没建"半态。
 *   3. 真实远端 SMB UNC：本机无第二台 SMB/无管理员建共享 ⇒ 如实登记环境缺口；
 *      不得把 `\\?\UNC\localhost\C$\...`（回环）写成"真实远端 SMB 已验证"。
 *
 * 本套件断言（真机，私有构建）：
 *   A. 4096/8192/16000/32000 字路径：write/mkdir/read/stat/delete/rename 全部
 *      fail-closed（ERR5），真实盘零写（新建不存在、删除文件仍在、rename 源在/目标无）；
 *      shim 日志含 `R27 edge` 归因 breadcrumb。
 *   B. 近边界：~2k–3.8k 字路径**可正常进暂存**（真盘零写+读回）；~4k 起 fail-closed
 *      （边界 = stage 根长度 + 内部 4096 缓冲共同决定，如实记录）。
 *   C. 跨卷 rename（C: 工作区 → D: 目标，MOVEFILE_COPY_ALLOWED=2）：注入后视图
 *      dst 内容正确、src ENOENT；真实 C: 源仍在、真实 D: 目标不存在（无半态）；
 *      flags=0 同形：要么同样安全成功，要么 fail-closed 且真实盘零变化（无半态）。
 *   D. 远端 SMB：无第二台 SMB/无远端共享 ⇒ 环境缺口；
 *      - 未暂存的远端读必须失败（网络错误），不得返回内容；
 *      - 对远端路径的**写**在 overlay 中暂存（不触真实网络），读回仅来自暂存；
 *      - 回环 `\\?\UNC\localhost\C$` 可用但**明确标注为回环，不是远端验证**。
 *
 * 红/绿：R26 canonical（无 R27 显式 guard）上 A 组 stat/日志归因/C 组跨卷等会红；
 * 私有（R27 guard）应全绿。SKIP 如实记录（缺 injector/zig/D: 卷）。
 *
 * 用法：node tests\r27-edge-paths.ts
 *       WINSTAGE_SHIM_OUT=<dir> node tests\r27-edge-paths.ts
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRATCH = join(REPO, '.t', 'r27-edge-paths')
const SHIMOUT = process.env.WINSTAGE_SHIM_OUT ? resolve(process.env.WINSTAGE_SHIM_OUT) : join(REPO, 'shim', 'out')
const DLL = join(SHIMOUT, 'winstage-shim.dll')
const INJECTOR = join(SHIMOUT, 'winstage-inject.exe')
const ZIG = join(REPO, 'tools', 'toolchain', 'zig-0.13.0', 'zig.exe')
const PROBE = join(SCRATCH, 'probe-edge.exe')
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
rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

const PROBE_C = String.raw`#include <windows.h>
#include <stdio.h>
static int wid(const char *in, WCHAR *out, int cch){return MultiByteToWideChar(CP_ACP,0,in,-1,out,cch)?1:0;}
int main(int argc,char**argv){
  if(argc<3) return 2;
  WCHAR p1[36000],p2[36000];
  if(!wid(argv[2],p1,36000)) return 2;
  if(argc>=4&&!wid(argv[3],p2,36000)) return 2;
  const char*m=argv[1];
  if(!strcmp(m,"write")){
    const char*mk=(argc>=4)?argv[3]:"R27-W";
    HANDLE h=CreateFileW(p1,GENERIC_WRITE,0,NULL,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);
    if(h==INVALID_HANDLE_VALUE){printf("ERR CreateFileW=%lu\n",(unsigned long)GetLastError());return 10;}
    DWORD w=0;BOOL ok=WriteFile(h,mk,(DWORD)strlen(mk),&w,NULL);CloseHandle(h);
    printf("WRITE ok=%d wrote=%lu\n",(int)ok,(unsigned long)w);return ok?0:11;
  }
  if(!strcmp(m,"read")){
    HANDLE h=CreateFileW(p1,GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,0,NULL);
    if(h==INVALID_HANDLE_VALUE){printf("ERR CreateFileW=%lu\n",(unsigned long)GetLastError());return 12;}
    char b[512];DWORD got=0;BOOL ok=ReadFile(h,b,sizeof(b)-1,&got,NULL);CloseHandle(h);
    if(!ok){printf("ERR ReadFile=%lu\n",(unsigned long)GetLastError());return 13;}
    b[got]=0;printf("CONTENT=%s\n",b);return 0;
  }
  if(!strcmp(m,"mkdir")){
    if(!CreateDirectoryW(p1,NULL)){printf("ERR CreateDirectoryW=%lu\n",(unsigned long)GetLastError());return 14;}
    printf("MKDIR ok=1\n");return 0;
  }
  if(!strcmp(m,"delete")){
    if(!DeleteFileW(p1)){printf("ERR DeleteFileW=%lu\n",(unsigned long)GetLastError());return 15;}
    printf("DELETE ok=1\n");return 0;
  }
  if(!strcmp(m,"stat")){
    DWORD a=GetFileAttributesW(p1);
    if(a==INVALID_FILE_ATTRIBUTES){printf("ERR GetFileAttributes=%lu\n",(unsigned long)GetLastError());return 16;}
    printf("ATTRS=0x%lx DIR=%d\n",(unsigned long)a,(a&FILE_ATTRIBUTE_DIRECTORY)?1:0);return 0;
  }
  if(!strcmp(m,"rename")){
    if(argc<4) return 2;
    DWORD flags=(argc>=5)?(DWORD)strtoul(argv[4],NULL,0):0;
    if(!MoveFileExW(p1,p2,flags)){printf("ERR MoveFileExW=%lu flags=%lu\n",(unsigned long)GetLastError(),(unsigned long)flags);return 17;}
    printf("RENAME ok=1 flags=%lu\n",(unsigned long)flags);return 0;
  }
  if(!strcmp(m,"writegen")){
    if(argc<4) return 2;
    WCHAR base[32768]; if(!wid(argv[2],base,32768)) return 2;
    long need=strtol(argv[3],NULL,10);
    WCHAR p[36000]; wcscpy(p,base);
    int idx=0;
    while((long)wcslen(p)<need&&wcslen(p)+90<36000){
      WCHAR comp[96];
      swprintf(comp,96,L"\\g%03d-%s",idx++,L"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
      wcscat(p,comp);
    }
    if((long)wcslen(p)<need) return 2;
    HANDLE h=CreateFileW(p,GENERIC_WRITE,0,NULL,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);
    if(h==INVALID_HANDLE_VALUE){printf("ERR CreateFileW=%lu len=%lu\n",(unsigned long)GetLastError(),(unsigned long)wcslen(p));return 10;}
    DWORD w=0;BOOL ok=WriteFile(h,"R27-GEN",7,&w,NULL);CloseHandle(h);
    printf("WRITE ok=%d wrote=%lu len=%lu\n",(int)ok,(unsigned long)w,(unsigned long)wcslen(p));return ok?0:11;
  }
  if(!strcmp(m,"renamegen")){
    WCHAR dir[34000]; if(argc<3||!wid(argv[2],dir,34000)) return 2;
    DWORD flags=(argc>=4)?(DWORD)strtoul(argv[3],NULL,0):0;
    WCHAR a[36000],b[36000];
    wcscpy(a,dir); wcscat(a,L"\\gen-src.txt");
    wcscpy(b,dir); wcscat(b,L"\\gen-dst.txt");
    if(!MoveFileExW(a,b,flags)){printf("ERR MoveFileExW=%lu flags=%lu len=%lu\n",(unsigned long)GetLastError(),(unsigned long)flags,(unsigned long)wcslen(a));return 17;}
    printf("RENAME ok=1 flags=%lu\n",(unsigned long)flags);return 0;
  }
  return 2;
}
`

section('R27-A 边缘路径')
if (process.platform !== 'win32' || !existsSync(DLL) || !existsSync(INJECTOR)) {
  skip('R27-A 全部用例', `requires win32 + shim 产物（dll=${existsSync(DLL)} injector=${existsSync(INJECTOR)} shimout=${SHIMOUT}）`)
} else if (!existsSync(ZIG)) {
  skip('R27-A 全部用例', `zig 不可用（${ZIG}）`)
} else {
  const tmp = join(SCRATCH, 'zigtmp')
  const gcache = join(SCRATCH, 'zigcache', 'global')
  const lcache = join(SCRATCH, 'zigcache', 'local')
  const STAGE = join(SCRATCH, 'stage')
  for (const d of [tmp, gcache, lcache, STAGE]) mkdirSync(d, { recursive: true })
  const comp = spawnSync(ZIG, ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-o', PROBE, '-x', 'c', '-', '-lntdll'], {
    input: PROBE_C,
    env: { ...process.env, TMP: tmp, TEMP: tmp, ZIG_GLOBAL_CACHE_DIR: gcache, ZIG_LOCAL_CACHE_DIR: lcache },
    encoding: 'utf8',
    timeout: 180000,
  })
  if (comp.status !== 0 || !existsSync(PROBE)) {
    skip('R27-A 全部用例', `探针编译失败 status=${comp.status}`)
  } else {
    const cfg = join(SCRATCH, 'cfg.json')
    writeFileSync(cfg, JSON.stringify({ stageRoot: STAGE, logPath: join(STAGE, 'shim.log'), failClosed: true, readThrough: true, verbose: false, passthrough: [STAGE] }))
    const env = { ...process.env, WINSTAGE_STAGE_ROOT: STAGE, WINSTAGE_SHIM_CONFIG: cfg, WINSTAGE_SHIM_LOG: join(STAGE, 'shim.log') }
    let seq = 0
    const inj = (args, cwd) => {
      seq += 1
      const r = spawnSync(INJECTOR, ['--dll', DLL, '--report', join(SCRATCH, `r-${seq}.json`), '--cwd', cwd || SCRATCH, '--', PROBE, ...args], { env, encoding: 'utf8', timeout: 180000 })
      return { status: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().replace(/\r?\n/g, ' | ') }
    }
    const long = (p) => `\\\\?\\${p}`
    const real = (p) => existsSync(long(p))
    const contentOf = (p) => {
      try {
        return readFileSync(long(p), 'utf8')
      } catch (e) {
        return `ERR:${e.code}`
      }
    }
    const logText = () => {
      try {
        return readFileSync(join(STAGE, 'shim.log'), 'utf8')
      } catch {
        return ''
      }
    }
    const makeDir = (tag, targetLen) => {
      let dir = join(SCRATCH, `${tag}-${targetLen}`)
      let i = 0
      while (dir.length < targetLen - 10) dir = join(dir, `s${String(i++).padStart(3, '0')}-${'a'.repeat(70)}`)
      mkdirSync(long(dir), { recursive: true })
      return dir
    }

    // ── A. >4096：全部 fail-closed + 真盘零写 + 日志归因 ─────────────────────
    for (const L of [4096, 8192, 16000, 32000]) {
      const dir = makeDir('big', L)
      const writePath = join(dir, 'w.txt')
      const mkdirPath = join(dir, 'mdir')
      const realRead = join(dir, 'real.txt')
      writeFileSync(long(realRead), 'R27-REAL')
      const w = inj(['write', long(writePath), 'R27-W'])
      const wReal = real(writePath)
      const m = inj(['mkdir', long(mkdirPath)])
      const mReal = real(mkdirPath)
      const rd = inj(['read', long(realRead)])
      const st = inj(['stat', long(realRead)])
      const renSrc = join(dir, 'ren.txt')
      writeFileSync(long(renSrc), 'R27-REN')
      const ren = L >= 32000 ? inj(['renamegen', dir, '0']) : inj(['rename', long(renSrc), long(join(dir, 'ren-dst.txt')), '0'])
      const renRealSrc = real(renSrc)
      const renRealDst = real(join(dir, 'ren-dst.txt'))
      const delPath = join(dir, 'del.txt')
      writeFileSync(long(delPath), 'R27-DEL')
      const del = inj(['delete', long(delPath)])
      const delReal = real(delPath)
      const trace = `${writePath.length}`
      check(
        `A.${L} >4096 路径（pathLen≈${trace}）：write/mkdir/read/stat/delete/rename 全部 fail-closed，真实盘零写`,
        w.status !== 0 &&
          w.text.includes('=5') &&
          !wReal &&
          m.status !== 0 &&
          m.text.includes('=5') &&
          !mReal &&
          rd.status !== 0 &&
          rd.text.includes('=5') &&
          st.status !== 0 &&
          st.text.includes('=5') &&
          ren.status !== 0 &&
          ren.text.includes('=5') &&
          renRealSrc &&
          !renRealDst &&
          del.status !== 0 &&
          del.text.includes('=5') &&
          delReal,
        JSON.stringify({ write: w.status, wReal, mkdir: m.status, mReal, read: rd.status, stat: st.status, rename: ren.status, renRealSrc, renRealDst, delete: del.status, delReal }).slice(0, 380),
      )
    }
    check('A.5 >4096 拒绝在 shim 日志里有可归因 breadcrumb（`R27 edge`）', logText().includes('R27 edge'), `has=${logText().includes('R27 edge')} count=${(logText().match(/R27 edge/g) || []).length}`)
    const beforeGen = (logText().match(/R27 edge/g) || []).length
    const gen = inj(['writegen', SCRATCH, '33000'])
    const afterGen = (logText().match(/R27 edge/g) || []).length
    check(
      'A.6 >32767 字路径（NT 上限之外，探针在内存构造 33000 字）⇒ 同样 fail-closed + 可归因，真实盘零写',
      gen.status !== 0 && afterGen > beforeGen && !/WRITE ok=1/.test(gen.text),
      JSON.stringify({ status: gen.status, text: gen.text.slice(0, 100), logBefore: beforeGen, logAfter: afterGen }),
    )

    // ── B. 近边界：~2k–3.8k 可暂存；~4k 起 fail-closed（边界依赖 stage 根长度）───
    const supported = []
    for (const L of [1000, 2000, 3000, 3800]) {
      const dir = makeDir('near', L)
      const p = join(dir, 'w.txt')
      const w = inj(['write', long(p), 'NEAR-OK'])
      const rd = inj(['read', long(p)])
      supported.push({ L, w: w.status, real: real(p), read: rd.text.includes('CONTENT=NEAR-OK') })
    }
    check(
      'B.1 近边界（1k/2k/3k/3.8k 字）仍可**正常进暂存**（写成功、真实盘零写、读回正确）',
      supported.every((x) => x.w === 0 && !x.real && x.read),
      JSON.stringify(supported),
    )
    {
      const dir = makeDir('near', 4000)
      const p = join(dir, 'w.txt')
      const w = inj(['write', long(p), 'NEAR-DENY'])
      check(
        'B.2 ~4k 字（stage 根 + 映射后 >4096）fail-closed 且真实盘零写（边界=stage 根长度+内部缓冲，如实记录）',
        w.status !== 0 && !real(p),
        JSON.stringify({ pathLen: p.length, status: w.status, real: real(p) }),
      )
    }

    // ── C. rename 跨卷（C: 工作区 → D: 目标）────────────────────────────────
    const dRoot = 'D:\\\\r27-edge-suite'
    let dReady = false
    try {
      mkdirSync(dRoot, { recursive: true })
      writeFileSync(join(dRoot, 'probe.txt'), 'D-OK')
      dReady = true
    } catch (e) {
      dReady = false
    }
    if (!dReady) {
      skip('C.* rename 跨卷', '本机无可用第二卷（D:）或不可写')
    } else {
      const cDir = join(SCRATCH, 'crossvol')
      mkdirSync(cDir, { recursive: true })
      const src = join(cDir, 'cv.txt')
      const dst = join(dRoot, `cv-${process.pid}.txt`)
      writeFileSync(src, 'R27-CROSSVOL')
      const before = inj(['read', long(src)])
      const ren = inj(['rename', long(src), long(dst), '2'])
      const dstView = inj(['read', long(dst)])
      const srcView = inj(['read', long(src)])
      check(
        'C.1 跨卷 rename（MOVEFILE_COPY_ALLOWED=2）：视图 dst 内容正确、src 消失；真实 C: 源仍在、真实 D: 目标不存在（无半态）',
        ren.status === 0 && dstView.text.includes('CONTENT=R27-CROSSVOL') && srcView.text.includes('ERR CreateFileW=2') && existsSync(src) && !existsSync(dst),
        JSON.stringify({ before: before.text.slice(0, 30), rename: ren.status, dstView: dstView.text.slice(0, 40), srcView: srcView.text.slice(0, 40), realSrc: existsSync(src), realDst: existsSync(dst) }).slice(0, 380),
      )
      // flags=0 同形：要么安全成功（视图正确、真盘零变化），要么 fail-closed（真盘零变化）
      const src2 = join(cDir, 'cv2.txt')
      const dst2 = join(dRoot, `cv2-${process.pid}.txt`)
      writeFileSync(src2, 'R27-CROSSVOL-NOFLAG')
      const ren2 = inj(['rename', long(src2), long(dst2), '0'])
      const dst2View = inj(['read', long(dst2)])
      const okNoHalf = ren2.status !== 0 ? existsSync(src2) && !existsSync(dst2) : existsSync(src2) && !existsSync(dst2) && dst2View.text.includes('CONTENT=R27-CROSSVOL-NOFLAG')
      check(
        'C.2 跨卷 rename 不带 COPY_ALLOWED（flags=0）：要么安全成功、要么 fail-closed，**两种形态都必须真实盘零变化、无半态**',
        okNoHalf,
        JSON.stringify({ rename: ren2.status, dstView: dst2View.text.slice(0, 46), realSrc: existsSync(src2), realDst: existsSync(dst2) }).slice(0, 320),
      )
      // 同卷 rename 回归（暂存语义）
      const sm = join(cDir, 'same-a.txt')
      const sd = join(cDir, 'same-b.txt')
      writeFileSync(sm, 'SAME-VOL')
      const ren3 = inj(['rename', long(sm), long(sd), '0'])
      const sdView = inj(['read', long(sd)])
      check(
        'C.3 同卷 rename 回归：仍进暂存（视图新名可读、真实源不动/真实目标不出现）',
        ren3.status === 0 && sdView.text.includes('CONTENT=SAME-VOL') && existsSync(sm) && !existsSync(sd),
        JSON.stringify({ rename: ren3.status, view: sdView.text.slice(0, 40), realSrc: existsSync(sm), realDst: existsSync(sd) }),
      )
    }

    // ── D. 真实远端 SMB：环境缺口 + 未暂存远端读必须失败 + 回环明确标注 ──────
    const remote = '\\\\r27-no-such-host-xyz\\share\\probe.txt'
    const remoteRead = inj(['read', remote])
    check(
      'D.1 真实远端 SMB 环境缺口：未暂存的远端读必须失败（网络错误），不得返回内容',
      remoteRead.status !== 0 && !remoteRead.text.includes('CONTENT='),
      `status=${remoteRead.status} text=${remoteRead.text.slice(0, 120)}`,
    )
    const remoteW = inj(['write', remote, 'R27-REMOTE-STAGED'])
    const remoteWRead = inj(['read', remote])
    check(
      'D.2 对远端路径的写只在 overlay 暂存（不返回真实网络写成功），读回内容仅来自暂存；**不代表真实远端 SMB 已验证**',
      remoteW.status === 0 && remoteWRead.text.includes('CONTENT=R27-REMOTE-STAGED'),
      JSON.stringify({ write: remoteW.status, read: remoteWRead.text.slice(0, 60) }).slice(0, 240),
    )
    const rel = SCRATCH.replace(/^[A-Za-z]:\\/, '')
    const loopback = `\\\\?\\UNC\\localhost\\C$\\${rel}\\loop.txt`
    const loopW = inj(['write', loopback, 'R27-LOOPBACK'])
    const loopR = inj(['read', loopback])
    check(
      'D.3 回环 `\\\\?\\UNC\\localhost\\C$\\…` 可用（写入暂存/读回正确），但**明确标注为回环，不是真实远端 SMB 验证**',
      loopW.status === 0 && loopR.text.includes('CONTENT=R27-LOOPBACK'),
      JSON.stringify({ write: loopW.status, read: loopR.text.slice(0, 60) }).slice(0, 240),
    )
    const netUse = spawnSync('net', ['use'], { encoding: 'utf8', timeout: 30000 })
    const netUseOut = `${netUse.stdout ?? ''}${netUse.stderr ?? ''}`
    check(
      'D.4 环境事实：本机无已连接远端 SMB（`net use` 无远端映射）⇒ 真实远端 SMB UNC 属环境缺口，未验证',
      netUse.status === 0 && !/\\\\[A-Za-z0-9._-]+\\/i.test(netUseOut),
      JSON.stringify({ status: netUse.status, out: netUseOut.trim().slice(0, 160) }),
    )
  }
}

W('')
W('='.repeat(64))
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} skips=${skips}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
