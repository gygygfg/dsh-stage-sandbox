#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；R22 新登记套件。
/**
 * r22-file-advex —— **R22-B：`NtQueryDirectoryFileEx` 枚举过滤（R19 残余）**
 *
 * 背景：R19 只 hook 了 `NtQueryDirectoryFile`；Win10+ 的 Ex 变体
 * （`NtQueryDirectoryFileEx`，带 `QueryFlags`）未 hook ⇒ 任何走 Ex 的载体仍能
 * 枚举出被遮蔽名（`.npmrc`、`.git-credentials`）。
 *
 * 本套件用**静态 IAT 导入**的 native 探针（`probe-dirqex`，zig 编译）证明：
 *   A1 未注入 Ex 控制组能列出遮蔽名（证明 API 真被调用，不是推断）；
 *   A2 修复后注入 Ex 不泄漏、普通条目（a.txt/b.txt）不丢；
 *   A3 既有 classic `NtQueryDirectoryFile` 仍过滤（R19 回归）；
 *   A4 6 个常见 `FileInformationClass`（1/2/3/12/37/38）逐一覆盖；
 *   A5 `SL_RETURN_SINGLE_ENTRY`（逐项重试路径）；
 *   A6 文件名 pattern（`*.txt`）语义不被破坏；
 *   A7 未知 info class（55）**不改写**（注入与直接调用状态一致）+ shim 日志有 breadcrumb；
 *   A8 未知 QueryFlags（`SL_INDEX_SPECIFIED`）原样透传（状态一致，不崩）。
 *   B1–B3 node/cmd/PowerShell 三载体注入后 readdir 不再泄漏、普通条目完整；
 *   C1 shim 日志存在 `NtQueryDirectoryFileEx` 命中记录（证明 hook 真生效）。
 *
 * 红/绿：canonical（R20/R21 构建，无 Ex 目标）跑 ⇒ A1/A2 等 Ex 断言失败（红）；
 * 私有/最终 canonical（含 Lead 中央目标 + ws_file.c 实现）⇒ 全绿。
 * SKIP 如实记录（缺 injector/zig 时）。
 *
 * 用法：node tests\r22-file-advex.ts
 *       WINSTAGE_SHIM_OUT=<dir> node tests\r22-file-advex.ts
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRATCH = join(REPO, '.t', 'r22-file-advex')
const SHIMOUT = process.env.WINSTAGE_SHIM_OUT ? resolve(process.env.WINSTAGE_SHIM_OUT) : join(REPO, 'shim', 'out')
const DLL = join(SHIMOUT, 'winstage-shim.dll')
const INJECTOR = join(SHIMOUT, 'winstage-inject.exe')
const ZIG = join(REPO, 'tools', 'toolchain', 'zig-0.13.0', 'zig.exe')
const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0
let skips = 0

function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`  ${condition ? '✓' : '✗'} ${name}`)
  if (detail !== undefined) W(`      证据: ${detail}`)
}
function skip(name, reason) {
  skips += 1
  W(`  ~ SKIP ${name}`)
  W(`      原因: ${reason}`)
}
function section(title) {
  W('')
  W(`=== ${title} ===`)
}

rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

const PROBE_C = String.raw`#include <windows.h>
#include <winternl.h>
#include <stdio.h>
NTSTATUS NTAPI NtQueryDirectoryFile(HANDLE, HANDLE, PIO_APC_ROUTINE, PVOID, PIO_STATUS_BLOCK, PVOID,
                                    ULONG, FILE_INFORMATION_CLASS, BOOLEAN, PUNICODE_STRING, BOOLEAN);
NTSTATUS NTAPI NtQueryDirectoryFileEx(HANDLE, HANDLE, PIO_APC_ROUTINE, PVOID, PIO_STATUS_BLOCK, PVOID,
                                      ULONG, FILE_INFORMATION_CLASS, ULONG, PUNICODE_STRING);
static int layout(ULONG cls, ULONG *lo, ULONG *no){
  switch(cls){case 1:*lo=60;*no=64;return 1;case 2:*lo=60;*no=68;return 1;case 3:*lo=60;*no=94;return 1;
  case 12:*lo=8;*no=12;return 1;case 37:*lo=60;*no=104;return 1;case 38:*lo=60;*no=80;return 1;default:return 0;}
}
static void narrow(const WCHAR *w,int cch,char *out,int cb){memset(out,0,(size_t)cb);
  int n=WideCharToMultiByte(CP_UTF8,0,w,cch,out,cb-1,NULL,NULL);if(n<0||n>cb-1)n=0;out[n]=0;}
int main(int argc,char**argv){
  if(argc<3) return 2;
  const char *mode=argv[1]; WCHAR dir[1024];
  if(!MultiByteToWideChar(CP_ACP,0,argv[2],-1,dir,1024)) return 2;
  HANDLE h=CreateFileW(dir,FILE_LIST_DIRECTORY|SYNCHRONIZE,7,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,NULL);
  if(h==INVALID_HANDLE_VALUE){printf("ERR CreateFileW=%lu\n",(unsigned long)GetLastError());return 3;}
  ULONG cls=37, flags=0x1; const char *pattern=NULL; int useEx=1;
  if(!strcmp(mode,"classic")) useEx=0;
  if(!strcmp(mode,"ex-single")) flags|=0x2;
  if(!strcmp(mode,"ex-class")&&argc>=4) cls=(ULONG)atoi(argv[3]);
  if(!strcmp(mode,"ex-flags")&&argc>=4) flags=(ULONG)atoi(argv[3]);
  if(!strcmp(mode,"ex-pattern")&&argc>=4) pattern=argv[3];
  const ULONG kBuf=64*1024; BYTE *buf=(BYTE*)HeapAlloc(GetProcessHeap(),0,kBuf);
  if(!buf) return 4;
  int count=0; ULONG it=0;
  for(;;){
    if(++it>10000){printf("ERR loop-guard\n");break;}
    IO_STATUS_BLOCK ios; memset(&ios,0,sizeof(ios));
    UNICODE_STRING pat; UNICODE_STRING *patp=NULL; WCHAR wp[512];
    if(pattern&&it==1){MultiByteToWideChar(CP_ACP,0,pattern,-1,wp,512);pat.Buffer=wp;
      pat.Length=(USHORT)(wcslen(wp)*sizeof(WCHAR));pat.MaximumLength=(USHORT)(pat.Length+sizeof(WCHAR));patp=&pat;}
    NTSTATUS st;
    if(useEx) st=NtQueryDirectoryFileEx(h,NULL,NULL,NULL,&ios,buf,kBuf,(FILE_INFORMATION_CLASS)cls,flags,patp);
    else st=NtQueryDirectoryFile(h,NULL,NULL,NULL,&ios,buf,kBuf,(FILE_INFORMATION_CLASS)cls,
                                 (flags&0x2)?TRUE:FALSE,patp,(flags&0x1)?TRUE:FALSE);
    flags &= ~0x1UL;
    if(st==(NTSTATUS)0x80000006L){printf("NO_MORE_FILES\n");break;}
    if(st<0){printf("ERR status=0x%08lx\n",(unsigned long)st);break;}
    ULONG info=ios.Information, lo=0, no=0;
    if(!layout(cls,&lo,&no)||info<no||info>kBuf){printf("RAW class=%lu info=%lu\n",(unsigned long)cls,(unsigned long)info);count++;break;}
    ULONG pos=0;
    while(pos+no<=info){BYTE *e=buf+pos;ULONG next=*(ULONG*)e;ULONG len=*(ULONG*)(e+lo);
      if(next!=0&&next>info-pos)break;
      if(len>0&&len<=info-pos-no){char out[1200];narrow((WCHAR*)(e+no),(int)(len/sizeof(WCHAR)),out,sizeof(out));printf("NAME=%s\n",out);count++;}
      if(!next)break;pos+=next;}
  }
  HeapFree(GetProcessHeap(),0,buf); CloseHandle(h); printf("COUNT=%d\n",count); return 0;
}
`

// ── environment ─────────────────────────────────────────────────────────────
const WS = join(SCRATCH, 'ws')
const STAGE = join(SCRATCH, 'stage')
const SESSION = join(SCRATCH, 'session')
const MASK = join(SESSION, 'read-deny.mask.json')
const PROBE = join(SCRATCH, 'probe-dirqex.exe')

if (process.platform !== 'win32' || !existsSync(DLL) || !existsSync(INJECTOR)) {
  section('R22-B NtQueryDirectoryFileEx 枚举过滤')
  skip('R22-B 全部用例', `requires win32 + shim 产物（dll=${existsSync(DLL)} injector=${existsSync(INJECTOR)} shimout=${SHIMOUT}）`)
} else if (!existsSync(ZIG)) {
  section('R22-B NtQueryDirectoryFileEx 枚举过滤')
  skip('R22-B 全部用例', `zig 不可用（${ZIG}）`)
} else {
  for (const d of [WS, STAGE, SESSION]) mkdirSync(d, { recursive: true })
  writeFileSync(join(WS, 'a.txt'), 'R22-A')
  writeFileSync(join(WS, 'b.txt'), 'R22-B')
  writeFileSync(join(WS, '.npmrc'), 'R22-MASK-NPMRC')
  writeFileSync(join(WS, '.git-credentials'), 'R22-MASK-GITCREDS')
  const maskExport = spawnSync(process.execPath, [join(REPO, 'src', 'paths.ts'), '--export-mask', MASK], { encoding: 'utf8' })
  const tmp = join(SCRATCH, 'zigtmp')
  const gcache = join(SCRATCH, 'zigcache', 'global')
  const lcache = join(SCRATCH, 'zigcache', 'local')
  for (const d of [tmp, gcache, lcache]) mkdirSync(d, { recursive: true })
  const compile = spawnSync(
    ZIG,
    ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-o', PROBE, '-x', 'c', '-', '-lntdll'],
    {
      input: PROBE_C,
      env: { ...process.env, TMP: tmp, TEMP: tmp, ZIG_GLOBAL_CACHE_DIR: gcache, ZIG_LOCAL_CACHE_DIR: lcache },
      encoding: 'utf8',
      timeout: 180000,
    },
  )
  const probeReady = maskExport.status === 0 && compile.status === 0 && existsSync(PROBE)

  section('R22-B NtQueryDirectoryFileEx 枚举过滤')
  if (!probeReady) {
    skip('R22-B 全部用例', `探针/mask 构建失败（mask=${maskExport.status} compile=${compile.status}）`)
  } else {
    const cfg = join(SCRATCH, 'cfg.json')
    writeFileSync(
      cfg,
      JSON.stringify({
        stageRoot: STAGE,
        logPath: join(STAGE, 'shim.log'),
        failClosed: true,
        readThrough: true,
        verbose: false,
        readDenyFile: MASK,
        readDenyFailClosed: true,
        passthrough: [STAGE],
      }),
    )
    const env = { ...process.env, WINSTAGE_STAGE_ROOT: STAGE, WINSTAGE_SHIM_CONFIG: cfg, WINSTAGE_SHIM_LOG: join(STAGE, 'shim.log') }
    const runDirect = (args) => {
      const r = spawnSync(PROBE, args, { encoding: 'utf8', timeout: 120000, cwd: WS })
      return { status: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
    }
    let seq = 0
    const runInjected = (args) => {
      seq += 1
      const r = spawnSync(INJECTOR, ['--dll', DLL, '--report', join(SCRATCH, `r-${seq}.json`), '--cwd', WS, '--', PROBE, ...args], { env, encoding: 'utf8', timeout: 120000 })
      return { status: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
    }
    const names = (text) => text.split(/\r?\n/).filter((l) => l.startsWith('NAME=')).map((l) => l.slice(5))
    const leaked = (text) => names(text).filter((n) => n === '.npmrc' || n === '.git-credentials')
    const shimLog = () => {
      try {
        return readFileSync(join(STAGE, 'shim.log'), 'utf8')
      } catch {
        return ''
      }
    }

    // A1 control: the un-injected Ex API really lists the masked names
    const direct = runDirect(['ex', WS])
    check(
      'A1 控制组：未注入时 NtQueryDirectoryFileEx 能列出遮蔽名（证明 API 真被调用，不是推断）',
      direct.status === 0 && leaked(direct.text).length === 2 && names(direct.text).includes('a.txt'),
      `status=${direct.status} names=${JSON.stringify(names(direct.text))}`,
    )

    // A2 green: injected Ex filters both masked names, keeps normal entries
    const ex = runInjected(['ex', WS])
    check(
      'A2 注入后 Ex 变体不泄漏（.npmrc/.git-credentials 消失），普通条目 a.txt/b.txt 不丢',
      ex.status === 0 && leaked(ex.text).length === 0 && names(ex.text).includes('a.txt') && names(ex.text).includes('b.txt'),
      `status=${ex.status} names=${JSON.stringify(names(ex.text))}`,
    )

    // A3 classic variant regression (R19)
    const classic = runInjected(['classic', WS])
    check(
      'A3 classic NtQueryDirectoryFile 仍过滤（R19 行为不被本次重构破坏）',
      classic.status === 0 && leaked(classic.text).length === 0 && names(classic.text).includes('a.txt'),
      `status=${classic.status} names=${JSON.stringify(names(classic.text))}`,
    )

    // A4 all common info classes
    const classes = [1, 2, 3, 12, 37, 38]
    const classResults = classes.map((cls) => {
      const r = runInjected(['ex-class', WS, String(cls)])
      return { cls, status: r.status, leaked: leaked(r.text).length, hasA: names(r.text).includes('a.txt') }
    })
    check(
      'A4 Ex 变体覆盖 6 个常见 FileInformationClass（1/2/3/12/37/38）均不泄漏且普通条目不丢',
      classResults.every((r) => r.status === 0 && r.leaked === 0 && r.hasA),
      JSON.stringify(classResults),
    )

    // A5 SL_RETURN_SINGLE_ENTRY (per-entry retry loop)
    const single = runInjected(['ex-single', WS])
    check(
      'A5 Ex + SL_RETURN_SINGLE_ENTRY（逐项重试路径）不泄漏、普通条目不丢',
      single.status === 0 && leaked(single.text).length === 0 && names(single.text).includes('a.txt'),
      `status=${single.status} names=${JSON.stringify(names(single.text))}`,
    )

    // A6 pattern semantics
    const pattern = runInjected(['ex-pattern', WS, '*.txt'])
    check(
      'A6 Ex 文件名 pattern（*.txt）语义保持：只返回 a.txt/b.txt，无遮蔽名',
      pattern.status === 0 && leaked(pattern.text).length === 0 && names(pattern.text).sort().join(',') === 'a.txt,b.txt',
      `status=${pattern.status} names=${JSON.stringify(names(pattern.text))}`,
    )

    // A7 unknown info class: pass-through unchanged + breadcrumb
    const direct55 = runDirect(['ex-class', WS, '55'])
    const inj55 = runInjected(['ex-class', WS, '55'])
    check(
      'A7 未知 FileInformationClass(55) ⇒ 不改写（注入与直接调用状态一致）+ shim 日志有 unsupported 类 breadcrumb',
      direct55.status === inj55.status && direct55.text.includes('ERR status=') === inj55.text.includes('ERR status=') && shimLog().includes('unsupported FileInformationClass'),
      `direct=${direct55.status}/${JSON.stringify(direct55.text.trim().slice(0, 60))} injected=${inj55.status} breadcrumb=${shimLog().includes('unsupported FileInformationClass')}`,
    )

    // A8 unknown QueryFlags: pass-through unchanged
    const directFlags = runDirect(['ex-flags', WS, '4'])
    const injFlags = runInjected(['ex-flags', WS, '4'])
    check(
      'A8 未知 QueryFlags(SL_INDEX_SPECIFIED=4) ⇒ 原样透传（注入与直接调用状态一致，不崩）',
      injFlags.status === directFlags.status && injFlags.text.includes('ERR status=') === directFlags.text.includes('ERR status='),
      `direct=${directFlags.status} injected=${injFlags.status}`,
    )

    // B1 node readdir carrier
    // (injected node uses the injector directly, not the probe)
    seq += 1
    const node = spawnSync(
      INJECTOR,
      ['--dll', DLL, '--report', join(SCRATCH, `r-node-${seq}.json`), '--cwd', WS, '--', process.execPath, '-e', `process.stdout.write(require('fs').readdirSync(${JSON.stringify(WS)}).join(','))`],
      { env, encoding: 'utf8', timeout: 120000 },
    )
    const nodeText = `${node.stdout ?? ''}${node.stderr ?? ''}`
    check(
      'B1 node fs.readdirSync 载体：注入后遮蔽名不出现、普通条目完整',
      (node.status ?? -1) === 0 && !nodeText.includes('.npmrc') && !nodeText.includes('.git-credentials') && nodeText.includes('a.txt') && nodeText.includes('b.txt'),
      `status=${node.status} out=${nodeText.trim().slice(0, 160)}`,
    )

    // B2 cmd dir carrier
    const CMD = process.env.ComSpec || 'cmd.exe'
    const cmd = spawnSync(INJECTOR, ['--dll', DLL, '--report', join(SCRATCH, 'r-cmd.json'), '--cwd', WS, '--', CMD, '/d', '/c', 'dir', '/a', '/b', WS], { env, encoding: 'utf8', timeout: 120000 })
    const cmdText = `${cmd.stdout ?? ''}${cmd.stderr ?? ''}`
    check(
      'B2 cmd `dir /a /b` 载体：注入后遮蔽名不出现、普通条目完整',
      (cmd.status ?? -1) === 0 && !cmdText.includes('.npmrc') && !cmdText.includes('.git-credentials') && cmdText.includes('a.txt') && cmdText.includes('b.txt'),
      `status=${cmd.status} out=${cmdText.trim().split(/\r?\n/).slice(0, 8).join(' | ')}`,
    )

    // B3 PowerShell Get-ChildItem carrier
    const PS = 'powershell.exe'
    const ps = spawnSync(INJECTOR, ['--dll', DLL, '--report', join(SCRATCH, 'r-ps.json'), '--cwd', WS, '--', PS, '-NoProfile', '-NonInteractive', '-Command', `(Get-ChildItem -Force -Name ${JSON.stringify(WS)}) -join ','`], { env, encoding: 'utf8', timeout: 180000 })
    const psText = `${ps.stdout ?? ''}${ps.stderr ?? ''}`
    check(
      'B3 PowerShell `Get-ChildItem -Force` 载体：注入后遮蔽名不出现、普通条目完整',
      (ps.status ?? -1) === 0 && !psText.includes('.npmrc') && !psText.includes('.git-credentials') && psText.includes('a.txt') && psText.includes('b.txt'),
      `status=${ps.status} out=${psText.trim().slice(0, 160)}`,
    )

    // C1 hook really active
    const log = shimLog()
    check(
      'C1 shim 日志出现 NtQueryDirectoryFileEx 命中/过滤记录（hook 真生效，非推断）',
      log.includes('NtQueryDirectoryFileEx') && (log.includes('hit NtQueryDirectoryFileEx') || log.includes('NtQueryDirectoryFileEx filtered response')),
      `logHasEx=${log.includes('NtQueryDirectoryFileEx')} hit=${log.includes('hit NtQueryDirectoryFileEx')} filtered=${log.includes('NtQueryDirectoryFileEx filtered response')}`,
    )
  }
}

W('')
W('='.repeat(64))
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} skips=${skips}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
