// @ts-nocheck —— 独立交叉验证套件（R17）：断言的是**真实结局**，不是"插件自己报了什么"。
/**
 * 交叉验证套件 R17 —— 四类边界失效的回归钉
 *
 * ── 为什么单独一个套件 ──────────────────────────────────────────────────────
 * 本轮交叉验证（不复用被测模块自己的判别入口）在四个面上实测出**边界失效**：
 *   ① 文件暂存→应用：`op:'mkdir'` 被"after.hash === absent"误判成删除；
 *   ② 原子替换：回退路径先把原件 `rmSync` 掉，第二次 rename 失败 ⇒ 原件与新件一起没了；
 *   ③ 敏感遮蔽：≤24 字符的高熵值、以及"含分隔符看着像路径"的令牌整段明文进 payload；
 *   ④ 危险命令拦截：带目录前缀的写类程序、以及粘在前一个 token 上的分隔符 ⇒ 判成
 *      `read-only`，而 `assertStagingWriteEnforceable()` 对 read-only 是**一票放行**
 *      （降级档没有 shim ⇒ 直写真实磁盘，既不暂存也不审批）。
 * 另加两节结构性要求：卸载可恢复（工具必须随包发布）与 Cordis 卸载协议。
 *
 * ── 每条断言的构成（缺一不写）────────────────────────────────────────────────
 *   ① 攻击/故障形状（一条具体输入）  ② 期望结局  ③ 反向对照（证明这条断言**能红**）
 *
 * 全部离线：不建子进程、不写真实注册表、不碰系统状态。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')

const checks = []
function ok(name, evidence) {
  checks.push({ pass: true, name, evidence })
  process.stdout.write(`  ✓ ${name}\n`)
  if (evidence) process.stdout.write(`      证据: ${evidence}\n`)
}
function bad(name, evidence) {
  checks.push({ pass: false, name, evidence })
  process.stdout.write(`  ✗ ${name}\n`)
  if (evidence) process.stdout.write(`      证据: ${evidence}\n`)
}
function assertThat(cond, name, evidence) {
  if (cond) ok(name, evidence)
  else bad(name, evidence)
}
function section(title) {
  process.stdout.write(`\n=== ${title} ===\n`)
}

const readSrc = (rel) => readFileSync(join(PKG, rel), 'utf8')
const SCRATCH = join(PKG, '.t', 'r17', 'crosscheck')
const fresh = (name) => {
  const root = join(SCRATCH, name)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  return root
}
rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

// ═══════════════════════════════════════════════════════════════════════════
// 1. 文件暂存 → 应用：`mkdir` 不得被当成删除
// ═══════════════════════════════════════════════════════════════════════════
section('1. 文件暂存→应用：批准「建目录」必须真的建目录（不得落到删除分支）')

const { Workspace } = await import('../src/workspace.ts')
const { hashAbsent } = await import('../src/store.ts')

{
  const root = fresh('mkdir-apply')
  const ws = new Workspace({ workspaceRoot: root }).init({ sessionId: 'r17-mkdir' })
  ws.createDirectory(join(root, 'brand-new-dir'), { origin: 'test' })
  const frozen = ws.freezeCandidate({ source: 'test' })
  const mkdirChange = frozen.changes.find((c) => c.op === 'mkdir')
  assertThat(mkdirChange !== undefined, '「建目录」确实产出一条 `op:mkdir` 的候选', JSON.stringify(frozen.changes.map((c) => `${c.op}:${c.path}`)))
  assertThat(
    mkdirChange && mkdirChange.before?.hash === hashAbsent() && mkdirChange.after?.hash === hashAbsent(),
    '对照：mkdir 的 before/after **两侧都是 absent**（正是它被旧判据误伤的原因）',
    JSON.stringify(mkdirChange),
  )
  const applied = ws.applyCandidate(frozen.candidate.id)
  const abs = join(root, 'brand-new-dir')
  assertThat(
    existsSync(abs) && statSync(abs).isDirectory(),
    '批准后真实磁盘上**真的出现**这个目录（旧实现：落到删除分支 ⇒ 静默 no-op）',
    `exists=${existsSync(abs)} applied=${JSON.stringify(applied.applied)} failed=${JSON.stringify(applied.failed)}`,
  )
}

{
  // 反向对照：删除型变更**仍然**必须真的删除（修 mkdir 不能把 delete 一起改坏）
  const root = fresh('delete-control')
  writeFileSync(join(root, 'doomed.txt'), 'D0\n')
  const ws = new Workspace({ workspaceRoot: root }).init({ sessionId: 'r17-del' })
  ws.remove(join(root, 'doomed.txt'), { origin: 'test' })
  const frozen = ws.freezeCandidate({ source: 'test' })
  ws.applyCandidate(frozen.candidate.id)
  assertThat(!existsSync(join(root, 'doomed.txt')), '对照：批准「删除」仍然真的删掉真实文件', `exists=${existsSync(join(root, 'doomed.txt'))}`)
}

{
  // 源码级反向对照：mkdir 分支必须**先于**"after.hash === absent ⇒ 删除"这条兜底
  const src = readSrc('src/workspace.ts')
  const mkdirBranch = src.indexOf("change.op === 'mkdir'")
  const deleteBranch = src.indexOf("if (change.op === 'delete' || change.after?.hash === hashAbsent()) {")
  assertThat(mkdirBranch > 0, '源码里存在显式的 `mkdir` 分支', `index=${mkdirBranch}`)
  assertThat(
    mkdirBranch > 0 && deleteBranch > 0 && mkdirBranch < deleteBranch,
    '`mkdir` 分支排在删除兜底分支**之前**（否则 mkdir 仍会被 absent 判据吞掉）',
    `mkdir@${mkdirBranch} < delete@${deleteBranch}`,
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. 原子替换：失败不得丢原件
// ═══════════════════════════════════════════════════════════════════════════
section('2. 原子替换（`writeFileAtomicReplacing`）：回退路径不得出现"原件已删、新件未到位"')

const { writeFileAtomicReplacing } = await import('../src/workspace.ts')

{
  const root = fresh('atomic')
  const target = join(root, 'keep.txt')
  writeFileSync(target, 'ORIGINAL\n')
  const result = writeFileAtomicReplacing(target, Buffer.from('REPLACED\n'))
  assertThat(readFileSync(target, 'utf8') === 'REPLACED\n', '正常路径：目标被整份替换', `strategy=${result.strategy}`)
  const leftovers = readdirSync(root).filter((n) => n.includes('.stage-tmp') || n.includes('.stage-bak'))
  assertThat(leftovers.length === 0, '正常路径不留临时/备份残留', JSON.stringify(leftovers))
}
{
  const src = readSrc('src/workspace.ts')
  const body = /export function writeFileAtomicReplacing\([\s\S]*?\n}\n/.exec(src)?.[0] ?? ''
  assertThat(body.length > 0, '能取到 `writeFileAtomicReplacing` 的函数体切片', `${body.length} 字节`)
  assertThat(
    !/rmSync\(target, \{ force: true \}\)/.test(body),
    '回退路径**不再**先 `rmSync(target)`（那是"原件先没、新件后到"的空窗）',
    '改为"先把原件改名备份 → 再改名新件 → 失败则改回原位"',
  )
  assertThat(/renameSync\(target, backup\)/.test(body), '回退路径先把原件挪到同目录备份名', 'renameSync(target, backup)')
  assertThat(
    /catch \(replaceError\)[\s\S]{0,200}renameSync\(backup, target\)/.test(body),
    '第二次 rename 失败时把备份**改回原位**（最坏停在原内容，绝不停在"什么都没有"）',
    'catch(replaceError) → renameSync(backup, target)',
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. 敏感内容遮蔽：短高熵值 / 像路径的令牌 / 凭据键名
// ═══════════════════════════════════════════════════════════════════════════
section('3. 敏感内容遮蔽：值级掩码不得漏掉"短"秘密与"像路径"的令牌')

const { maskSensitiveLine } = await import('../dsh-plugin/sensitive-content.ts')

const MUST_MASK = [
  ['password: Abc123Xyz789Qwer2', '20 字符混合大小写+数字（DSH 凭据 secret 的长度区间是 17–44）'],
  ['apiKey: a1B2c3D4e5F6g7H8', '18 字符混合大小写+数字'],
  ['token: abcdefghijklmnopqrst', '凭据键名 + 20 字符（形状上像 slug，靠键名判定）'],
  ['refreshToken: 1//0eXaMpLe-Of-A-VerY-Long-Token', '含 `/` 与 `-`，旧判据把它当路径放行'],
  ['DEEPSEEK_API_KEY: sk-R12PROBE0123456789abcdefghijklmnop', '已知密钥形态'],
]
for (const [line, why] of MUST_MASK) {
  const r = maskSensitiveLine(line)
  assertThat(r.masked === true && !r.text.includes(line.split(/\s+/).slice(1).join(' ')), `必须遮蔽：${line}`, `${why} ⇒ ${r.text}`)
}

const MUST_KEEP = [
  ['path: C:\\Users\\someone\\Desktop\\project\\file.txt', 'Windows 绝对路径不是秘密'],
  ['src: packages/win/src/workspace.ts', '相对路径不是秘密'],
  ['url: https://example.com/a/b/c?x=1', 'URI 不是秘密'],
  ['email: someone@example.com', '邮箱不是秘密'],
  ['port: localhost:8080', 'host:port 不是秘密'],
  ['enabled: true', '短标量不是秘密'],
  ['name: normal-file-ok', '可读短串不是秘密'],
]
for (const [line, why] of MUST_KEEP) {
  const r = maskSensitiveLine(line)
  assertThat(r.masked === false, `对照：不得遮蔽（否则掩码退化成"看不见改了什么"）：${line}`, why)
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. 危险命令拦截
// ═══════════════════════════════════════════════════════════════════════════
section('4. 危险命令拦截：`read-only` 在降级档是一票放行 ⇒ 写类程序绝不能被判成只读')

const { classifyCommandRisk } = await import('../src/executor.ts')

const BYPASSES = [
  ['echo', ['ok & C:\\Windows\\System32\\reg.exe add HKCU\\X /v v /d 1'], '写类程序带**绝对路径**（`WRITE_VERBS` 里只有裸名）'],
  ['echo', ['ok & .\\reg.exe add HKCU\\X /v v /d 1'], '写类程序带 `.\\` 前缀'],
  ['echo', ['x;reg add HKCU\\X /v v /d 1'], '分隔符 `;` **粘在前一个 token 尾上**'],
  ['echo', ['x&&reg add HKCU\\X /v v /d 1'], '分隔符 `&&` 粘在前一个 token 尾上'],
  ['echo', ['ok & C:\\Windows\\System32\\wbem\\WMIC.EXE process call create calc'], '带目录的未登记程序（至少必须判 indeterminate）'],
]
for (const [command, args, why] of BYPASSES) {
  const r = classifyCommandRisk(command, args)
  assertThat(r.risk !== 'read-only', `不得判成只读：${command} ${JSON.stringify(args).slice(0, 40)}`, `${why} ⇒ risk=${r.risk}`)
}

// 反向对照：真正的只读命令**仍然**要判只读（否则这道门会变成"一律拒绝"，就没用了）
for (const [command, args, label] of [
  ['cmd', ['/c', 'echo', 'hello'], 'cmd /c echo hello'],
  ['git', ['status'], 'git status'],
  ['cmd.exe', ['/c', 'echo', 'MUST-NOT-RUN'], 'cmd.exe /c echo …'],
]) {
  const r = classifyCommandRisk(command, args)
  assertThat(r.risk === 'read-only', `对照：${label} 仍判只读`, `risk=${r.risk}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. 卸载可恢复：还原工具必须随包发布
// ═══════════════════════════════════════════════════════════════════════════
section('5. 插件卸载 → 对客户端/profile 的修改可恢复（还原工具必须**随包发布**）')

const pkg = JSON.parse(readSrc('package.json'))
const files = Array.isArray(pkg.files) ? pkg.files : []
for (const must of ['tools/uninstall-restore.ts', 'tools/dsh-patches.ts', 'patches/']) {
  assertThat(
    files.includes(must),
    `package.json 的 files 必须包含 ${must}（否则装进去就再也拿不到还原工具）`,
    JSON.stringify(files),
  )
}

{
  // profile 覆盖层的还原必须是**可选可预览**的，且能分辨"不是我们写的那一行"
  const { planRestore } = await import('../tools/uninstall-restore.ts')
  const dir = fresh('restore')
  const patch = join(dir, 'cordis.patch.yml')
  writeFileSync(
    patch,
    [
      '- id: agent-default-model',
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      '    model: deepseek-flash',
      '- id: pwsh-sandbox',
      "  name: '@deepseek-ai/dsh-pwsh-sandbox'",
      "  disabled: !!js (process.env.WINSTAGE_SHELL !== '0')",
      '- id: pwsh-sandbox-handwritten',
      "  name: '@deepseek-ai/dsh-pwsh-sandbox'",
      '  disabled: true',
      '',
    ].join('\n'),
    'utf8',
  )
  const plan = planRestore(patch)
  const removed = plan.decisions.map((d) => d.id)
  assertThat(removed.includes('pwsh-sandbox'), '本插件写入的"让位"行被摘除', JSON.stringify(removed))
  assertThat(!removed.includes('pwsh-sandbox-handwritten'), '对照：形态不是本插件写的那一行**不自动摘**（交回人工）', JSON.stringify(plan.manual.map((m) => m.id)))
  assertThat(!removed.includes('agent-default-model'), '对照：与插件无关的条目原样保留', JSON.stringify(removed))
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Cordis 卸载协议：客户端副作用必须归 ctx.effect 所有
// ═══════════════════════════════════════════════════════════════════════════
section('6. Cordis 卸载协议（客户端注入的每一样东西都必须有回收路径）')

const clientSrc = readSrc('dsh-plugin/client.ts')
const hostSrc = readSrc('dsh-plugin/host-plugin.ts')

assertThat(
  /ctx\.effect\(\(\) => ctx\.locale\.register\(LOCALE_NS, dicts\)/.test(clientSrc),
  'i18n 字典注册由 `ctx.effect` 持有（卸载即撤）',
  'winstage-sandbox: dictionaries',
)
assertThat(
  /style\.remove\(\)/.test(clientSrc) && /document\.head\.appendChild\(style\)/.test(clientSrc),
  '注入的 `<style>` 有 `remove()` 回收路径（平台 UI 不会残留本插件的 CSS）',
  'COMPOSER_FALLBACK_UNHIDE_CSS',
)
assertThat(
  /ctx\.effect\(\(\) => \(\) => poller\.dispose\(\)/.test(clientSrc),
  '轮询器由 `ctx.effect` 持有（卸载时 clearInterval）',
  'winstage-sandbox: review poller',
)
assertThat(
  (clientSrc.match(/ctx\.slots\.inject\(/g) ?? []).length >= 2 &&
    /return \(\) => \{\s*\n\s*off\(\)/.test(clientSrc),
  '`ctx.slots.inject` 的两处都返回同步 disposer（槽位占用会随卸载释放）',
  `${(clientSrc.match(/ctx\.slots\.inject\(/g) ?? []).length} 处`,
)
assertThat(
  (clientSrc.match(/setInterval\(/g) ?? []).length === 1 && /clearInterval\(interval\)/.test(clientSrc),
  '客户端只有**一处** `setInterval`，且被 `clearInterval` 收掉',
  `${(clientSrc.match(/setInterval\(/g) ?? []).length} 处`,
)

// 主机侧：进程内单例 + 基线漂移定时器 + 面板路由都要归 cordis
assertThat(/ctx\.effect\(\(\) => \{[\s\S]{0,200}disposeReviewServices\(\)/.test(hostSrc), '进程内审阅服务单例由 `ctx.effect` 清空', 'winstage-sandbox: dispose review services')
assertThat(/installBaselineWatch\(ctx,/.test(hostSrc), '基线漂移定时器装配在主 ctx 上（其 effect 由 baseline-watch 自己注册）', 'installBaselineWatch(ctx, …)')
assertThat(/webScope\.effect\(\(\) => \{[\s\S]{0,200}webServer\.register\(route\)/.test(hostSrc), '面板路由由注入 scope 的 `effect` 注销', 'winstage-sandbox: panel routes')
assertThat(/export const name = 'winstage-sandbox'/.test(hostSrc) && /export const inject = \[\]/.test(hostSrc), '主机插件导出 `name` / `inject`（Cordis 插件契约）', "name='winstage-sandbox'")

// ═══════════════════════════════════════════════════════════════════════════
rmSync(SCRATCH, { recursive: true, force: true })
const failed = checks.filter((c) => !c.pass)
process.stdout.write(
  `\n========================================================================\n` +
    `交叉验证 R17（暂存应用 / 原子替换 / 敏感遮蔽 / 危险命令 / 卸载可恢复 / Cordis）：` +
    `断言 ${checks.length} 项，失败 ${failed.length} 项\n` +
    `RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} checks=${checks.length} failures=${failed.length} mode=normal\n`,
)
process.exit(failed.length === 0 ? 0 : 1)
