// @ts-nocheck —— 宿主侧编排脚本（Node 直跑；含对 ebk 技能模块的动态 import，类型从宽）。
/**
 * tools/ebk-sandbox-test.ts —— WinStage 沙箱 · Windows E2E 测试流程脚本。
 *
 * 一条命令走完：
 *   probe → 准备共享/插件 → 生成 compose → up → wait ready → 并发录制 →
 *   旅客机引导（装 DSH + 插件 + 起 dsh web + 前后真值读数）→
 *   宿主 Playwright 取**面板 DOM/截图/可达性**并驱动审批 →
 *   等 RESULT 标记 → 收集产物 → 清理 → 写缺陷/判据报告。
 *
 * 判据（docs/round16/00-测试协议.md）：
 *   1 loader 无告警（stderr 0B）  2 暂存面在工作  3 真实工作区零污染
 *   4 lane 真的是 TS             5 隔离只由沙箱外进程读数判（本脚本的做法：
 *     旅客机内**不在 WinStage 沙箱内**的 PowerShell 取工作区前后读数）
 *
 * 依赖：宿主 docker + /dev/kvm + /dev/net/tun；ebk 技能（EBK_SKILLS_DIR）；
 *       Playwright+Chromium（默认取 ebk-capture 技能内的那份）。
 *
 * 用法：
 *   node tools/ebk-sandbox-test.ts --os-id win11 --run-id r1 \
 *     [--ram 8G --cpu 4 --disk 64G] [--web-port 8066] [--rdp-port 3390] [--dsh-port 3085] \
 *     [--dsh-exe <exe>] [--keep] [--no-capture] [--no-video] \
 *     [--wait-timeout-min 90] [--test-timeout-min 40] [--screenshot-every-sec 30] \
 *     [--attach]        # 复用已存在的容器（配合 --keep），只重跑宿主驱动
 *     [--workdir <dir>] # 默认 .t/ebk
 *
 * 退出码：0 = 判据全过；1 = 有失败/超时；2 = 环境错误。
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  makeRunContext,
  makeRunId,
  writeJson,
  writeText,
  ensureDir,
  sha256File,
  findResultMarkers,
} from '../e2e/lib/artifacts.ts'
import { loadEbk, probeHost, renderCompose, composeUp, composeDown, runCommand, resolveSkillsDir } from '../e2e/lib/ebk.ts'
import { openWebSession } from '../e2e/lib/web-gui.ts'

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..')

const PROMPT = [
  'Create a file named staged-probe.txt in the workspace with the content HELLO.',
  'Then create a second file named staged-probe2.txt with the content WORLD.',
  'Do not ask any questions.',
  'Then list the workspace directory and report what you see.',
].join(' ')

interface Args {
  osId: string
  runId: string
  ram: string
  cpu: string
  disk: string
  webPort: number
  rdpPort: number
  dshPort: number
  dshExe?: string
  keep: boolean
  capture: boolean
  video: boolean
  waitTimeoutMin: number
  testTimeoutMin: number
  screenshotEverySec: number
  attach: boolean
  workdir: string
  username: string
  password: string
  language: string
  iso?: string
  storage?: string
  dryRun: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const a: any = {}
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    const next = () => argv[++i]
    switch (t) {
      case '--os-id': a.osId = next(); break
      case '--run-id': a.runId = next(); break
      case '--ram': a.ram = next(); break
      case '--cpu': a.cpu = next(); break
      case '--disk': a.disk = next(); break
      case '--web-port': a.webPort = Number(next()); break
      case '--rdp-port': a.rdpPort = Number(next()); break
      case '--dsh-port': a.dshPort = Number(next()); break
      case '--dsh-exe': a.dshExe = next(); break
      case '--iso': a.iso = next(); break
      case '--storage': a.storage = next(); break
      case '--workdir': a.workdir = next(); break
      case '--username': a.username = next(); break
      case '--password': a.password = next(); break
      case '--language': a.language = next(); break
      case '--wait-timeout-min': a.waitTimeoutMin = Number(next()); break
      case '--test-timeout-min': a.testTimeoutMin = Number(next()); break
      case '--screenshot-every-sec': a.screenshotEverySec = Number(next()); break
      case '--keep': a.keep = true; break
      case '--no-capture': a.capture = false; break
      case '--no-video': a.video = false; break
      case '--attach': a.attach = true; break
      case '--dry-run': a.dryRun = true; break
      case '--help': case '-h': a.help = true; break
      default: break
    }
  }
  return {
    osId: a.osId || 'win11',
    runId: a.runId || makeRunId('ebk'),
    ram: a.ram || '8G',
    cpu: a.cpu || '4',
    disk: a.disk || '64G',
    webPort: a.webPort || 8066,
    rdpPort: a.rdpPort || 3390,
    dshPort: a.dshPort || 3085,
    dshExe: a.dshExe,
    keep: Boolean(a.keep),
    capture: a.capture !== false,
    video: a.video !== false,
    waitTimeoutMin: a.waitTimeoutMin || 90,
    testTimeoutMin: a.testTimeoutMin || 40,
    screenshotEverySec: a.screenshotEverySec || 30,
    attach: Boolean(a.attach),
    workdir: a.workdir || join(REPO, '.t', 'ebk'),
    username: a.username || 'Docker',
    password: a.password || 'admin',
    language: a.language || 'en-US',
    iso: a.iso,
    storage: a.storage,
    dryRun: Boolean(a.dryRun),
    help: Boolean(a.help),
  }
}

const started = Date.now()
const stamp = () => `[+${((Date.now() - started) / 1000).toFixed(0)}s]`
const log = (m: string) => process.stdout.write(`${stamp()} ${m}\n`)
const warn = (m: string) => process.stderr.write(`${stamp()} WARN ${m}\n`)
const logger = { info: (m: string) => log(m), warn: (m: string) => warn(m), error: (m: string) => warn(m) }

function findDshExe(args: Args): string | undefined {
  if (args.dshExe) return args.dshExe
  const candidates = [
    join(REPO, '.t', 'r17', 'win-shared', 'dsh-latest-windows-x64.exe'),
    join(REPO, '.t', 'ebk', 'assets', 'dsh-latest-windows-x64.exe'),
  ]
  return candidates.find((p) => existsSync(p))
}

function buildPluginTgz(ctxWork: string): { tgz: string; sha: string } {
  const out = join(ctxWork, 'pkg')
  ensureDir(out)
  const tgz = join(out, 'dsh-winstage-sandbox.tgz')

  // 优先 `npm pack`：它按 package.json 的 `files` 白名单打包（只含 dist/plugin/dsh-plugin/src
  // 与 shim 源码），并在 prepack 里构建 dist。手工 tar 很容易把 docs 证据 / 工具链 / 缓存
  // 一并打进去（首版就这样打出过 211MB 的包）。
  const pack = spawnSync('npm', ['pack', '--pack-destination', out], { cwd: REPO, encoding: 'utf8' })
  if (pack.status === 0) {
    const name = (pack.stdout || '').trim().split('\n').filter(Boolean).pop()
    if (name) {
      const produced = join(out, name)
      if (existsSync(produced)) copyFileSync(produced, tgz)
    }
  }
  if (!existsSync(tgz)) {
    // 回退：tar，收紧排除面（含工具链与历史证据）。
    const build = spawnSyncNode('tools/build-plugin.ts', REPO)
    if (build.exitCode !== 0) throw new Error(`plugin build failed: ${build.stderr.slice(-400)}`)
    const excludes = [
      '--exclude=node_modules', '--exclude=.t', '--exclude=.git', '--exclude=.dshstage',
      '--exclude=shim/out', '--exclude=esc', '--exclude=filemod', '--exclude=retest',
      '--exclude=.lead', '--exclude=_sandbox-tests', '--exclude=_r3',
      '--exclude=tools/toolchain', '--exclude=.npmcache', '--exclude=.pnpm-store',
      '--exclude=docs/archive', '--exclude=dist',
    ]
    const tar = spawnSync('tar', [...excludes, '-czf', tgz, '.'], { cwd: REPO, encoding: 'utf8' })
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr.slice(-400)}`)
  }
  return { tgz, sha: sha256File(tgz) }
}

function spawnSyncNode(script: string, cwd: string, tarArgs?: string[]) {
  if (tarArgs) {
    const r = spawnSync('tar', tarArgs, { cwd, encoding: 'utf8' })
    return { exitCode: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' }
  }
  const r = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' })
  return { exitCode: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' }
}

/**
 * 把本地 ISO 放进 storage 目录并命名为 `custom.iso`。
 * dockurr 的 `detectCustom`（install.sh:1287）优先认 `custom.iso`/`boot.iso`，
 * 命中即完全跳过 VERSION 解析与网络下载 —— 这正是被 IP 拦截时的正确本地路径。
 * 优先硬链接（同盘零拷贝）；跨设备回退拷贝。
 */
function seedStorage(iso: string, storageDir: string): void {
  ensureDir(storageDir)
  const dest = join(storageDir, 'custom.iso')
  if (existsSync(dest) && statSync(dest).size > 0) return
  const hl = spawnSync('ln', [resolve(iso), dest])
  if (hl.status !== 0) copyFileSync(iso, dest)
}

async function prepareShared(args: Args, ctx: ReturnType<typeof makeRunContext>) {
  const shared = ctx.sharedDir
  const oem = ensureDir(join(ctx.workdir, 'oem'))
  const guest = join(REPO, 'e2e', 'guest')

  // 1) 插件包
  const { tgz, sha } = buildPluginTgz(ctx.workdir)
  copyFileSync(tgz, join(shared, 'dsh-winstage-sandbox.tgz'))
  log(`plugin tgz: ${basename(tgz)} sha256=${sha.slice(0, 16)}…`)

  // 2) DSH 安装包
  const dshExe = findDshExe(args)
  if (dshExe) {
    copyFileSync(dshExe, join(shared, 'dsh-latest-windows-x64.exe'))
    log(`dsh installer: ${basename(dshExe)} sha256=${sha256File(dshExe).slice(0, 16)}…`)
  } else {
    warn('no dsh installer found (--dsh-exe or .t/r17/win-shared); guest install will be skipped')
  }

  // 3) guest 脚本
  for (const f of ['bootstrap.ps1']) copyFileSync(join(guest, f), join(shared, f))
  copyFileSync(join(guest, 'install.bat'), join(oem, 'install.bat'))

  // 4) run.env
  const env = [
    `EBK_RUN_ID=${args.runId}`,
    `EBK_SHARE=\\\\host.lan\\Data`,
    `EBK_WORKSPACE=C:\\winstage-ws`,
    `EBK_DSH_PORT=${args.dshPort}`,
  ].join('\r\n')
  writeText(join(shared, 'run.env'), env + '\r\n')
  log(`shared prepared: ${shared}`)
}

async function hostDriver(args: Args, ctx: ReturnType<typeof makeRunContext>) {
  const urlFile = join(ctx.sharedDir, `dsh-web-url-${args.runId}.txt`)
  const doneMarker = join(ctx.sharedDir, `driver-done-${args.runId}.txt`)
  const deadline = Date.now() + args.testTimeoutMin * 60 * 1000

  log('waiting for guest dsh web url ...')
  while (Date.now() < deadline && !existsSync(urlFile)) await sleep(5000)
  if (!existsSync(urlFile)) {
    warn('dsh web url not found within timeout; recording as finding')
    writeJson(join(ctx.reportDir, 'host-driver.json'), { ok: false, reason: 'no-web-url' })
    writeText(doneMarker, 'no-web-url')
    return { ok: false, reason: 'no-web-url' }
  }
  const url = readFileSync(urlFile, 'utf8').trim()
  log(`dsh web url: ${url}`)

  let session
  const captures: any[] = []
  try {
    session = await openWebSession({ url, timeoutMs: 30000 })
    captures.push(await session.capture('00-initial', { domDir: ctx.domDir, screenshotsDir: ctx.screenshotsDir }))

    // 新建会话（如有按钮）
    await clickByText(session.page, ['新建会话', 'New Session', 'New chat'])
    await session.page.waitForTimeout(2500)
    captures.push(await session.capture('01-new-session', { domDir: ctx.domDir, screenshotsDir: ctx.screenshotsDir }))

    // 发送触发暂存写操作的提示词
    await fillComposer(session.page, PROMPT)
    await submitComposer(session.page)
    log('prompt submitted; waiting for staged candidate / panel ...')

    // 轮询直到面板出现（或超时）
    const panelDeadline = Date.now() + 3 * 60 * 1000
    let seen = false
    while (Date.now() < panelDeadline) {
      await session.page.waitForTimeout(5000)
      const probe = await session.page.evaluate(panelProbe()).catch(() => null)
      if (probe && probe.found) { seen = true; break }
    }
    captures.push(await session.capture('02-after-prompt', { domDir: ctx.domDir, screenshotsDir: ctx.screenshotsDir }))
    log(`panel visible = ${seen}`)

    // 若能勾选，勾第一个候选并尝试批准
    if (seen) {
      await session.page.evaluate(`(() => { const cb = document.querySelector('input[type=checkbox]'); if (cb) cb.click(); return true; })()`).catch(() => {})
      await session.page.waitForTimeout(500)
      captures.push(await session.capture('03-selected', { domDir: ctx.domDir, screenshotsDir: ctx.screenshotsDir }))
      const clicked = await clickByText(session.page, ['批准所选', '批准全部', 'Approve'])
      await session.page.waitForTimeout(3000)
      captures.push(await session.capture('04-after-approve', { domDir: ctx.domDir, screenshotsDir: ctx.screenshotsDir }))
      log(`approve clicked = ${clicked}`)
    }
  } catch (e) {
    warn(`host driver error: ${e instanceof Error ? e.message : String(e)}`)
    writeJson(join(ctx.reportDir, 'host-driver-error.json'), { error: String(e) })
  } finally {
    if (session) await session.close().catch(() => {})
    writeText(doneMarker, JSON.stringify({ captures: captures.map((c) => ({ name: c.name, domBytes: c.domBytes, panelFound: c.panel?.found })) }, null, 2))
  }

  const summary = { ok: true, url, captures: captures.map((c) => ({ name: c.name, domBytes: c.domBytes, panelFound: c.panel?.found, screenshot: c.screenshot, dom: c.dom })) }
  writeJson(join(ctx.reportDir, 'host-driver.json'), summary)
  return summary
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

function panelProbe() {
  // 与 e2e/lib/panel-dom.ts 的谓词一致（此处在 Playwright page.evaluate 内联，避免跨文件传参）
  return `(() => {
    const re = /暂存待审|暂时收起|WinStage 沙箱|W暂存待审/;
    const all = Array.from(document.querySelectorAll('*'));
    const roots = all.filter(e => re.test(e.innerText || '') && e.querySelector('button'));
    roots.sort((x, y) => (x.innerText || '').length - (y.innerText || '').length);
    const root = roots[0];
    if (!root) return { found: false };
    return { found: true, rootTag: root.tagName, rootLen: (root.innerText || '').length };
  })()`
}

async function clickByText(page: any, labels: string[]): Promise<boolean> {
  const expr = `(() => {
    const labels = ${JSON.stringify(labels)};
    const vis = (e) => e.getClientRects().length > 0;
    const lbl = (e) => ((e.getAttribute && (e.getAttribute('aria-label') || e.getAttribute('title'))) || e.innerText || '').replace(/\\s+/g, ' ').trim();
    const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(vis);
    for (const l of labels) { const b = btns.find((e) => lbl(e).includes(l)); if (b) { b.click(); return l; } }
    return null;
  })()`
  return Boolean(await page.evaluate(expr).catch(() => null))
}

async function fillComposer(page: any, text: string): Promise<void> {
  await page.evaluate(
    `(() => { const el = document.querySelector('[contenteditable="true"], textarea'); if (el) { el.focus(); document.execCommand && document.execCommand('insertText', false, ${JSON.stringify(text)}); } return true; })()`,
  ).catch(() => {})
  await page.waitForTimeout(800)
}

async function submitComposer(page: any): Promise<void> {
  const byBtn = await clickByText(page, ['发送', 'Send'])
  if (!byBtn) {
    await page.evaluate(
      `(() => { const el = document.querySelector('[contenteditable="true"], textarea'); if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); return true; })()`,
    ).catch(() => {})
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if ((args as any).help) {
    process.stdout.write('usage: node tools/ebk-sandbox-test.ts --os-id win11 --run-id r1 [--keep] [--attach] ...\n')
    process.exit(0)
  }
  const ctx = makeRunContext(args.workdir, args.runId)
  log(`runId=${args.runId} os=${args.osId} workdir=${args.workdir}`)

  const ebk = await loadEbk()
  log(`ebk skills dir = ${resolveSkillsDir()}`)

  const ok = await probeHost(ebk)
  if (!ok) {
    warn('host not ready (docker / KVM / TUN). aborting (exit 2).')
    process.exit(2)
  }

  let captureResult: any = null
  let controller: AbortController | null = null
  let report: any = { runId: args.runId, os: args.osId, phases: [] }

  try {
    const composeFile = join(ctx.workdir, 'docker-compose.yml')
    const storageDir = args.storage ? resolve(args.storage) : join(ctx.workdir, 'storage')

    if (!args.attach) {
      await prepareShared(args, ctx)
      if (args.iso) {
        seedStorage(args.iso, storageDir)
        log(`local ISO seeded as custom.iso`)
      }
      const yaml = renderCompose(ebk, {
        osId: args.osId,
        runId: args.runId,
        ram: args.ram, cpu: args.cpu, disk: args.disk,
        webPort: args.webPort, rdpPort: args.rdpPort,
        userPorts: [args.dshPort],
        testDir: ctx.sharedDir,
        oemDir: join(ctx.workdir, 'oem'),
        storageDir,
        username: args.username, password: args.password, language: args.language,
      })
      writeText(composeFile, yaml)
      log(`compose written: ${composeFile}`)
      if (args.dryRun) {
        log('--dry-run: compose prepared, not launching. exiting 0.')
        process.stdout.write(yaml + '\n')
        process.exit(0)
      }

      const up = await composeUp({ composeFile, cwd: ctx.workdir })
      if (up.exitCode !== 0) {
        warn(`docker compose up failed (${up.exitCode})\n${up.stderr.slice(-600)}`)
        process.exit(2)
      }
      log('container up; waiting for readiness ...')

      await ebk.wait.waitForReady({
        containerName: `${args.osId}-${args.runId}`,
        webPort: args.webPort,
        timeoutMs: args.waitTimeoutMin * 60 * 1000,
        bootSettleMs: 0,
        logger,
      })
      log('guest reported ready')
      report.phases.push({ name: 'compose+wait', ok: true })
    } else {
      log('attach mode: skipping compose/wait')
      if (!existsSync(composeFile)) warn(`compose file missing for cleanup: ${composeFile}`)
    }

    // 并发录制（noVNC 像素级 + webm）
    if (args.capture && ebk.capture?.captureSession) {
      controller = new AbortController()
      const capPromise = ebk.capture.captureSession({
        url: `http://127.0.0.1:${args.webPort}/`,
        screenshotsDir: ctx.screenshotsDir,
        videoDir: ctx.artifactsDir,
        screenshotEveryMs: args.screenshotEverySec * 1000,
        signal: controller.signal,
        logger,
      })
      capPromise.then((r: any) => { captureResult = r }).catch(() => {})
    }

    // 宿主驱动（DOM/截图/AX + 审批）
    const driver = await hostDriver(args, ctx)
    report.hostDriver = driver

    // 等旅客机 RESULT 标记
    log('waiting for guest RESULT marker ...')
    const deadline = Date.now() + args.testTimeoutMin * 60 * 1000
    let markers: any[] = []
    while (Date.now() < deadline) {
      markers = findResultMarkers(ctx.sharedDir).filter((m) => m.name.includes(args.runId))
      if (markers.length) break
      await sleep(5000)
    }
    report.markers = markers.map((m) => ({ name: m.name, success: m.success }))
    if (markers.length) log(`RESULT: ${markers[0].name} success=${markers[0].success}`)
    else warn('no RESULT marker within timeout')
    if (controller) controller.abort()

    // collect + cleanup
    if (ebk.env?.collectArtifacts) {
      await ebk.env.collectArtifacts({
        containerName: `${args.osId}-${args.runId}`,
        testDir: ctx.sharedDir,
        artifactsDir: ctx.artifactsDir,
        logger,
      }).catch((e: any) => warn(`collect failed: ${e.message}`))
    }
    if (!args.keep) {
      await composeDown(composeFile, ctx.workdir).catch(() => {})
      if (ebk.env?.cleanupRun) {
        await ebk.env.cleanupRun({ composeFile, runDir: ctx.workdir, storageDir, keep: false }).catch(() => {})
      }
    } else {
      log('--keep: container left running')
    }

    report.capture = captureResult
    report.ok = markers.some((m) => m.success) && Boolean(driver?.ok)
    writeJson(join(ctx.reportDir, 'report.json'), report)
    log(`report: ${join(ctx.reportDir, 'report.json')}`)
    process.exit(report.ok ? 0 : 1)
  } catch (e) {
    warn(`fatal: ${e instanceof Error ? e.stack || e.message : String(e)}`)
    writeJson(join(ctx.reportDir, 'report.json'), { ...report, fatal: String(e) })
    process.exit(2)
  }
}

main()
