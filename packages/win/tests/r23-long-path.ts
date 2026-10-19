#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；R23 新登记套件。
/**
 * r23-long-path —— **R23-B：>MAX_PATH 写/建目录/rename/delete 暂存化**
 *
 * R21-FS-06 收窄：R21 只让 >MAX_PATH **读**透传；写/建目录/rename/delete 一律
 * fail-closed（ERR5/0xC0000022）。R23 让 `\\?\` 长路径的这些**写类操作也进暂存**
 * （真实盘零写），无法安全暂存时保持 fail-closed。
 *
 * 本套件用 zig 编译的 native 探针（CreateFileW/CreateDirectoryW/MoveFileExW/
 * DeleteFileW/GetFileAttributesW）与 node 载体验证：
 *   A1 控制组：未注入时长路径四个写类 API 都成功（证明是 shim 拦截，不是 API 限制）；
 *   A2/A3 注入写：视图可读回、真实盘零写、暂存树上出现 >MAX_PATH 的暂存文件；
 *   A4 注入建目录：视图 DIR、真实盘零写、暂存目录存在；
 *   A5 rename：真实源不动/真实目标不出现、视图新名可读旧名消失（CoW+移动）；
 *   A6 delete：视图消失、真实文件仍在、whiteout 标记落盘（跨进程 A12 再验）；
 *   A7 长路径遮蔽读仍拒绝（prefixed/unprefixed 两种，无明文）；
 *   A8 `\\?\UNC\localhost\C$\<长>` 写入口径（视图可读回、真实盘零写）；
 *   A9 短路径回归（普通写/读/删除不被长路径改动破坏）；
 *   A10 node/libuv 载体：注入 node 写长路径 → 暂存 + 可读回 + 真实盘零写；
 *   A11 暂存文件被**干净进程**用 `\\?\` 直接读出（证明不是内存假象、暂存路径 >MAX_PATH）；
 *   A12 delete 后新注入进程读 ENOENT（whiteout 跨进程持久）。
 *
 * 红/绿：R22 及更早 canonical（provider 未改）跑 ⇒ A2–A6/A8/A10/A11/A12 失败（ERR5）；
 * R23 私有/最终 canonical ⇒ 全绿。缺 injector/zig 时 SKIP。
 *
 * 用法：node tests\r23-long-path.ts
 *       WINSTAGE_SHIM_OUT=<dir> node tests\r23-long-path.ts
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
// Per-process scratch: a parallel gate/verify run must not share `.t/r23-long-path`.
const SCRATCH = join(REPO, '.t', `r23-long-path-${process.pid}`)
const SHIMOUT = process.env.WINSTAGE_SHIM_OUT ? resolve(process.env.WINSTAGE_SHIM_OUT) : join(REPO, 'shim', 'out')
const DLL = join(SHIMOUT, 'winstage-shim.dll')
const INJECTOR = join(SHIMOUT, 'winstage-inject.exe')
const ZIG = join(REPO, 'tools', 'toolchain', 'zig-0.13.0', 'zig.exe')
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
  WCHAR p1[2048],p2[2048];
  if(!wid(argv[2],p1,2048)) return 2;
  if(argc>=4&&!wid(argv[3],p2,2048)) return 2;
  const char *m=argv[1];
  if(!strcmp(m,"write")){
    HANDLE h=CreateFileW(p1,GENERIC_WRITE,0,NULL,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);
    if(h==INVALID_HANDLE_VALUE){printf("ERR CreateFileW=%lu\n",(unsigned long)GetLastError());return 10;}
    const char *mk=(argc>=4)?argv[3]:"R23-LONG-WRITE";DWORD w=0;BOOL ok=WriteFile(h,mk,(DWORD)strlen(mk),&w,NULL);
    CloseHandle(h);printf("WRITE ok=%d wrote=%lu\n",(int)ok,(unsigned long)w);return ok?0:11;
  }
  if(!strcmp(m,"mkdir")){
    if(!CreateDirectoryW(p1,NULL)){printf("ERR CreateDirectoryW=%lu\n",(unsigned long)GetLastError());return 12;}
    printf("MKDIR ok=1\n");return 0;
  }
  if(!strcmp(m,"rename")){
    if(!MoveFileExW(p1,p2,0)){printf("ERR MoveFileExW=%lu\n",(unsigned long)GetLastError());return 13;}
    printf("RENAME ok=1\n");return 0;
  }
  if(!strcmp(m,"delete")){
    if(!DeleteFileW(p1)){printf("ERR DeleteFileW=%lu\n",(unsigned long)GetLastError());return 14;}
    printf("DELETE ok=1\n");return 0;
  }
  if(!strcmp(m,"stat")){
    DWORD a=GetFileAttributesW(p1);
    if(a==INVALID_FILE_ATTRIBUTES){printf("ERR GetFileAttributesW=%lu\n",(unsigned long)GetLastError());return 17;}
    printf("ATTRS=0x%lx DIR=%d\n",(unsigned long)a,(a&FILE_ATTRIBUTE_DIRECTORY)?1:0);return 0;
  }
  if(!strcmp(m,"read")){
    HANDLE h=CreateFileW(p1,GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,0,NULL);
    if(h==INVALID_HANDLE_VALUE){printf("ERR CreateFileW=%lu\n",(unsigned long)GetLastError());return 15;}
    char b[512];DWORD got=0;BOOL ok=ReadFile(h,b,sizeof(b)-1,&got,NULL);CloseHandle(h);
    if(!ok){printf("ERR ReadFile=%lu\n",(unsigned long)GetLastError());return 16;}
    b[got]=0;printf("CONTENT=%s\n",b);return 0;
  }
  return 2;
}
`

const STAGE = join(SCRATCH, 'stage')
const MASK = join(SCRATCH, 'session', 'read-deny.mask.json')
const PROBE = join(SCRATCH, 'probe-longfs.exe')

if (process.platform !== 'win32' || !existsSync(DLL) || !existsSync(INJECTOR)) {
  section('R23-B >MAX_PATH 写面')
  skip('R23-B 全部用例', `requires win32 + shim 产物（dll=${existsSync(DLL)} injector=${existsSync(INJECTOR)} shimout=${SHIMOUT}）`)
} else if (!existsSync(ZIG)) {
  section('R23-B >MAX_PATH 写面')
  skip('R23-B 全部用例', `zig 不可用（${ZIG}）`)
} else {
  const tmp = join(SCRATCH, 'zigtmp')
  const gcache = join(SCRATCH, 'zigcache', 'global')
  const lcache = join(SCRATCH, 'zigcache', 'local')
  for (const d of [tmp, gcache, lcache, STAGE, join(SCRATCH, 'session')]) mkdirSync(d, { recursive: true })
  const comp = spawnSync(ZIG, ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-o', PROBE, '-x', 'c', '-', '-lntdll'], {
    input: PROBE_C,
    env: { ...process.env, TMP: tmp, TEMP: tmp, ZIG_GLOBAL_CACHE_DIR: gcache, ZIG_LOCAL_CACHE_DIR: lcache },
    encoding: 'utf8',
    timeout: 180000,
  })
  const maskExport = spawnSync(process.execPath, [join(REPO, 'src', 'paths.ts'), '--export-mask', MASK], { encoding: 'utf8' })
  section('R23-B >MAX_PATH 写面')
  if (comp.status !== 0 || !existsSync(PROBE) || maskExport.status !== 0) {
    skip('R23-B 全部用例', `探针/mask 构建失败（compile=${comp.status} mask=${maskExport.status}）`)
  } else {
    const cfg = join(SCRATCH, 'cfg.json')
    writeFileSync(
      cfg,
      JSON.stringify({ stageRoot: STAGE, logPath: join(STAGE, 'shim.log'), failClosed: true, readThrough: true, verbose: false, readDenyFile: MASK, readDenyFailClosed: true, passthrough: [STAGE] }),
    )
    const env = { ...process.env, WINSTAGE_STAGE_ROOT: STAGE, WINSTAGE_SHIM_CONFIG: cfg, WINSTAGE_SHIM_LOG: join(STAGE, 'shim.log') }
    const direct = (args, cwd) => {
      const r = spawnSync(PROBE, args, { encoding: 'utf8', timeout: 120000, cwd: cwd || SCRATCH })
      return { status: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
    }
    let seq = 0
    const inj = (args, cwd) => {
      seq += 1
      const r = spawnSync(INJECTOR, ['--dll', DLL, '--report', join(SCRATCH, `r-${seq}.json`), '--cwd', cwd || SCRATCH, '--', PROBE, ...args], { env, encoding: 'utf8', timeout: 120000 })
      return { status: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
    }
    const injNode = (script, cwd) => {
      seq += 1
      const r = spawnSync(INJECTOR, ['--dll', DLL, '--report', join(SCRATCH, `rn-${seq}.json`), '--cwd', cwd || SCRATCH, '--', process.execPath, '-e', script], { env, encoding: 'utf8', timeout: 120000 })
      return { status: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
    }
    const content = (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch (e) {
        return `ERR:${e.code}`
      }
    }

    // fixture: >MAX_PATH tree (real files exist for rename/delete/mask controls)
    const WS = join(SCRATCH, 'ws')
    let longDir = WS
    for (let i = 0; i < 14; i++) longDir = join(longDir, `longdir-${String(i).padStart(2, '0')}-abcdef`)
    mkdirSync(`\\\\?\\${longDir}`, { recursive: true })
    writeFileSync(`\\\\?\\${join(longDir, 'existing.txt')}`, 'R23-EXISTING')
    writeFileSync(`\\\\?\\${join(longDir, 'delete-me.txt')}`, 'R23-DELETE-ME')
    writeFileSync(`\\\\?\\${join(longDir, '.npmrc')}`, 'R23-MASK-NPMRC')
    const rel = longDir.replace(/^[A-Za-z]:\\/, '')
    const stagedOf = (name) => join(STAGE, 'fs', 'C', rel, name)
    const woOf = (name) => join(STAGE, 'wo', 'C', rel, name)
    const longPref = (name) => `\\\\?\\${join(longDir, name)}`
    const realExists = (name) => existsSync(`\\\\?\\${join(longDir, name)}`)
    const viewRead = (name) => inj(['read', longPref(name)])

    // A1 control: all four APIs work without the shim
    const ctlW = direct(['write', longPref('ctl-new.txt'), 'CTL'])
    const ctlM = direct(['mkdir', longPref('ctl-dir')])
    writeFileSync(`\\\\?\\${join(longDir, 'ctl-existing.txt')}`, 'R23-CTL-EXISTING')
    writeFileSync(`\\\\?\\${join(longDir, 'ctl-delete.txt')}`, 'R23-CTL-DELETE')
    const ctlR = direct(['rename', longPref('ctl-existing.txt'), longPref('ctl-renamed.txt')])
    const ctlD = direct(['delete', longPref('ctl-delete.txt')])
    check(
      'A1 控制组：未注入时 >MAX_PATH 的 write/mkdir/rename/delete 四 API 都直接成功（证明确实是 shim 的拦截面）',
      ctlW.status === 0 && ctlM.status === 0 && ctlR.status === 0 && ctlD.status === 0,
      `write=${ctlW.status} mkdir=${ctlM.status} rename=${ctlR.status} delete=${ctlD.status}`,
    )

    // A2/A3 write staged
    const w = inj(['write', longPref('new.txt'), 'R23-LONG-WRITE'])
    const rb = viewRead('new.txt')
    check(
      'A2 注入写 >MAX_PATH：写成功、视图可读回内容、真实盘零写',
      w.status === 0 && !realExists('new.txt') && rb.status === 0 && rb.text.includes('CONTENT=R23-LONG-WRITE'),
      `write=${w.status} realExists=${realExists('new.txt')} read=${rb.status} ${rb.text.slice(0, 80)}`,
    )
    const stagedNew = stagedOf('new.txt')
    const stagedOk = (() => {
      try {
        return existsSync(`\\\\?\\${stagedNew}`) && statSync(`\\\\?\\${stagedNew}`).isFile() && content(`\\\\?\\${stagedNew}`) === 'R23-LONG-WRITE'
      } catch {
        return false
      }
    })()
    check(
      'A3 暂存树出现 >MAX_PATH 的暂存文件（路径长度>260、内容正确）——证明是 provider 落盘而非内存假象',
      stagedOk && stagedNew.length > 260,
      `stagedLen=${stagedNew.length} exists=${(() => { try { return existsSync(`\\\\?\\${stagedNew}`) } catch { return false } })()}`,
    )

    // A4 mkdir staged
    const m = inj(['mkdir', longPref('newdir')])
    const st = inj(['stat', longPref('newdir')])
    check(
      'A4 注入建目录 >MAX_PATH：视图 DIR=1、暂存目录存在、真实盘零写',
      m.status === 0 && realExists('newdir') === false && st.text.includes('DIR=1') && existsSync(`\\\\?\\${stagedOf('newdir')}`),
      `mkdir=${m.status} real=${realExists('newdir')} stat=${st.text} staged=${(() => { try { return existsSync(`\\\\?\\${stagedOf('newdir')}`) } catch { return false } })()}`,
    )

    // A5 rename via copy-up + move
    const rn = inj(['rename', longPref('existing.txt'), longPref('existing-renamed.txt')])
    const newRb = viewRead('existing-renamed.txt')
    const oldRb = viewRead('existing.txt')
    check(
      'A5 注入 rename >MAX_PATH：视图新名可读、视图旧名 ENOENT，真实源文件不动、真实目标不出现',
      rn.status === 0 && newRb.text.includes('CONTENT=R23-EXISTING') && oldRb.text.includes('ERR CreateFileW=2') && realExists('existing.txt') && !realExists('existing-renamed.txt'),
      `rename=${rn.status} new=${newRb.text.slice(0, 60)} old=${oldRb.text.slice(0, 40)} realOld=${realExists('existing.txt')} realNew=${realExists('existing-renamed.txt')}`,
    )

    // A6 delete -> whiteout + real untouched
    const dl = inj(['delete', longPref('delete-me.txt')])
    const delView = viewRead('delete-me.txt')
    check(
      'A6 注入 delete >MAX_PATH：视图 ENOENT、真实文件仍在、whiteout 标记落盘',
      dl.status === 0 && delView.text.includes('ERR CreateFileW=2') && realExists('delete-me.txt') && existsSync(`\\\\?\\${woOf('delete-me.txt')}`),
      `delete=${dl.status} view=${delView.text.slice(0, 50)} real=${realExists('delete-me.txt')} wo=${(() => { try { return existsSync(`\\\\?\\${woOf('delete-me.txt')}`) } catch { return false } })()}`,
    )

    // A7 masked read still denied
    const maskPref = viewRead('.npmrc')
    const maskPlain = inj(['read', join(longDir, '.npmrc')])
    check(
      'A7 长路径遮蔽读仍拒绝（prefixed / unprefixed 两种形态），无明文',
      !maskPref.text.includes('R23-MASK-NPMRC') && !maskPlain.text.includes('R23-MASK-NPMRC'),
      `prefixed=${maskPref.status}/${maskPref.text.slice(0, 40)} plain=${maskPlain.status}/${maskPlain.text.slice(0, 40)}`,
    )

    // A8 `\\?\UNC\localhost\C$\<long>` entry
    const uncLong = `\\\\?\\UNC\\localhost\\C$\\${rel}\\unc-new.txt`
    const uncW = inj(['write', uncLong, 'R23-UNC-LONG'])
    const uncRb = inj(['read', uncLong])
    check(
      'A8 `\\\\?\\\\UNC\\\\localhost\\\\C$\\<长>` 写入口径：视图可读回、真实盘零写',
      uncW.status === 0 && !realExists('unc-new.txt') && uncRb.text.includes('CONTENT=R23-UNC-LONG'),
      `write=${uncW.status} real=${realExists('unc-new.txt')} read=${uncRb.status}/${uncRb.text.slice(0, 60)}`,
    )

    // A9 short-path regression
    const shortDir = join(SCRATCH, 'short')
    mkdirSync(shortDir, { recursive: true })
    const sp = join(shortDir, 'n.txt')
    const sW = inj(['write', sp, 'R23-SHORT'])
    const sR = inj(['read', sp])
    const sD = inj(['delete', sp])
    const sR2 = inj(['read', sp])
    check(
      'A9 短路径回归：注入写/读/删除仍按原语义工作（真实盘零写）',
      sW.status === 0 && sR.text.includes('CONTENT=R23-SHORT') && sD.status === 0 && sR2.text.includes('ERR CreateFileW=2') && !existsSync(sp),
      `write=${sW.status} read=${sR.text.slice(0, 40)} del=${sD.status} readAfter=${sR2.text.slice(0, 30)} real=${existsSync(sp)}`,
    )

    // A10 node/libuv carrier
    const nodeLong = longPref('node-long.txt')
    const nodeW = injNode(`require('fs').writeFileSync(${JSON.stringify(nodeLong)},'R23-NODE-LONG');process.stdout.write('WROTE')`)
    const nodeR = viewRead('node-long.txt')
    check(
      'A10 node/libuv 载体：注入后写 >MAX_PATH 走暂存（视图可读回）且真实盘零写',
      nodeW.status === 0 && !realExists('node-long.txt') && nodeR.text.includes('CONTENT=R23-NODE-LONG'),
      `nodeWrite=${nodeW.status}/${nodeW.text.slice(0, 60)} real=${realExists('node-long.txt')} read=${nodeR.text.slice(0, 60)}`,
    )

    // A11 staged file readable from a clean process (out-of-injector)
    const cleanStaged = `\\\\?\\${stagedOf('new.txt')}`
    const cleanRb = (() => {
      const r = spawnSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(cleanStaged)},'utf8'))`], { encoding: 'utf8' })
      return { status: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
    })()
    check(
      'A11 干净进程（未注入）用 `\\\\?\\` 直接读暂存文件成功 ⇒ 长路径暂存是真实落盘、且暂存路径本身 >MAX_PATH',
      cleanRb.status === 0 && cleanRb.text === 'R23-LONG-WRITE' && cleanStaged.length > 260,
      `stagedLen=${cleanStaged.length} status=${cleanRb.status} text=${cleanRb.text.slice(0, 40)}`,
    )

    // A12 whiteout persists across processes
    const freshView = inj(['read', longPref('delete-me.txt')])
    check(
      'A12 delete 后的 whiteout 跨进程持久：新注入进程读仍 ENOENT，真实文件未被删',
      freshView.text.includes('ERR CreateFileW=2') && realExists('delete-me.txt'),
      `fresh=${freshView.text.slice(0, 40)} real=${realExists('delete-me.txt')}`,
    )

    // A13 长 **stage 根** + 短真实路径：`stageRoot + 映射路径` >MAX_PATH 也必须可暂存
    // （gate-runner 第一版夹具用 ~150 字 stage 根时短路径 mkdir ERR206；本项钉住已修）
    {
      let longStage = join(SCRATCH, 'longstage')
      for (let i = 0; i < 6; i++) longStage = join(longStage, `stage-${i}-abcdefghijklmno`)
      mkdirSync(longStage, { recursive: true })
      const cfg2 = join(SCRATCH, 'cfg-longstage.json')
      writeFileSync(cfg2, JSON.stringify({ stageRoot: longStage, logPath: join(longStage, 'shim.log'), failClosed: true, readThrough: true, verbose: false, readDenyFile: MASK, readDenyFailClosed: true, passthrough: [longStage] }))
      const env2 = { ...process.env, WINSTAGE_STAGE_ROOT: longStage, WINSTAGE_SHIM_CONFIG: cfg2, WINSTAGE_SHIM_LOG: join(longStage, 'shim.log') }
      const shortWs = join(SCRATCH, 'shortws')
      mkdirSync(shortWs, { recursive: true })
      const shortPath = join(shortWs, 'x.txt')
      const run2 = (args) => {
        const r = spawnSync(INJECTOR, ['--dll', DLL, '--report', join(SCRATCH, 'r-longstage.json'), '--cwd', shortWs, '--', PROBE, ...args], { env: env2, encoding: 'utf8', timeout: 120000 })
        return { status: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().replace(/\r?\n/g, ' | ') }
      }
      const w2 = run2(['write', shortPath, 'R23-LONG-STAGE-ROOT'])
      const r2 = run2(['read', shortPath])
      const staged2 = join(longStage, 'fs', 'C', shortPath.replace(/^[A-Za-z]:\\/, ''))
      check(
        'A13 长 stage 根（root+映射路径 >MAX_PATH）时短路径写/读仍正常走暂存、真实盘零写',
        w2.status === 0 && !existsSync(shortPath) && r2.text.includes('CONTENT=R23-LONG-STAGE-ROOT') && staged2.length > 260,
        `stagedLen=${staged2.length} write=${w2.status} read=${r2.text.slice(0, 60)} real=${existsSync(shortPath)}`,
      )
    }
  }
}

W('')
W('='.repeat(64))
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} skips=${skips}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
