// @ts-nocheck —— 与既有测试脚本一致：纯 node 断言，不参与 tsc 严格检查。
/**
 * 后果分级（`src/severity.ts`）—— 纯函数，离线可复现。
 *
 * 为什么必须有这一套：`classifyChange()` 只回答"改动落在工作区内/外/敏感路径"，
 * 不回答"这条改动会做什么"。删除 `README.md` 与给 `README.md` 追加一行同样是
 * `risk:"normal"`。本次硬化把 Linux 的后果规则移植到 Windows，审阅面才第一次能
 * 对"删除 / 清零 / 持久化 / 系统路径"给出 L2/L3。
 *
 * 用法：`node tests/severity.ts`
 */
import {
  assessFileChange,
  assessRegistryChange,
  highestLevel,
  isSystemPath,
  looksSensitiveValueName,
  maxLevel,
} from '../src/severity.ts'

let failures = 0
let assertions = 0
const check = (name, ok, detail) => {
  assertions += 1
  if (!ok) failures += 1
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === undefined ? '' : `\n      证据: ${detail}`}\n`)
}

process.stdout.write('=== 文件变更的后果分级 ===\n')
{
  const del = assessFileChange({ path: 'README.md', op: 'delete', kind: 'file', beforeBytes: 120, afterBytes: 0 })
  check('删除文件 = L2', del.level === 'L2', JSON.stringify(del))
  check('删除文件带 FILE_DELETE 理由', del.reasons.some((r) => r.code === 'FILE_DELETE'), JSON.stringify(del.reasons))

  const rmtree = assessFileChange({ path: 'workspace', op: 'delete', kind: 'dir', beforeBytes: 0, afterBytes: 0 })
  check('删除目录 = L3', rmtree.level === 'L3', JSON.stringify(rmtree))

  const wipe = assessFileChange({ path: 'README.md', op: 'modify', kind: 'file', beforeBytes: 120, afterBytes: 0 })
  check('内容清零 = L3', wipe.level === 'L3' && wipe.reasons.some((r) => r.code === 'CONTENT_WIPED'), JSON.stringify(wipe))

  const trunc = assessFileChange({ path: 'log.txt', op: 'modify', kind: 'file', beforeBytes: 4096, afterBytes: 100 })
  check('大文件腰斩 = L2', trunc.level === 'L2' && trunc.reasons.some((r) => r.code === 'CONTENT_TRUNCATED'), JSON.stringify(trunc))

  const benign = assessFileChange({ path: 'src/a.py', op: 'modify', kind: 'file', beforeBytes: 100, afterBytes: 120 })
  check('普通编辑 = L1', benign.level === 'L1', JSON.stringify(benign))

  const add = assessFileChange({ path: 'out.txt', op: 'create', kind: 'file', beforeBytes: 0, afterBytes: 6 })
  check('新增输出 = L1', add.level === 'L1', JSON.stringify(add))
}

process.stdout.write('\n=== .git 内部与引用 ===\n')
{
  const hook = assessFileChange({ path: '.git/hooks/post-commit', op: 'create', kind: 'file' })
  check('安装 git hook = L3', hook.level === 'L3' && hook.reasons.some((r) => r.code === 'PERSISTENCE_GIT_INTERNAL'), JSON.stringify(hook))

  const config = assessFileChange({ path: '.git/config', op: 'modify', kind: 'file', beforeBytes: 30, afterBytes: 40 })
  check('.git/config = L3', config.level === 'L3', JSON.stringify(config))

  const ref = assessFileChange({ path: '.git/refs/heads/main', op: 'modify', kind: 'file', beforeBytes: 41, afterBytes: 41 })
  check('改 ref = L2（引用更新）', ref.level === 'L2' && ref.reasons.some((r) => r.code === 'GIT_REFERENCE_UPDATE'), JSON.stringify(ref))

  const refDel = assessFileChange({ path: '.git/refs/heads/main', op: 'delete', kind: 'file' })
  check('删 ref = L3', refDel.level === 'L3', JSON.stringify(refDel))

  const obj = assessFileChange({ path: '.git/objects/ab/cdef', op: 'create', kind: 'file', beforeBytes: 0, afterBytes: 5 })
  check('新增松散对象 = L1（内容寻址、可累加）', obj.level === 'L1', JSON.stringify(obj))
}

process.stdout.write('\n=== 工作区外与系统路径 ===\n')
{
  const outside = assessFileChange({ path: 'C:\\Users\\Docker\\code\\x.txt', op: 'create', kind: 'file', external: true, beforeBytes: 0, afterBytes: 5 })
  check('工作区外写入 = L2', outside.level === 'L2' && outside.reasons.some((r) => r.code === 'OUTSIDE_WORKSPACE'), JSON.stringify(outside))

  const system = assessFileChange({ path: 'C:\\Windows\\System32\\evil.txt', op: 'create', kind: 'file', external: true, beforeBytes: 0, afterBytes: 5 })
  check('System32 写入 = L3', system.level === 'L3' && system.reasons.some((r) => r.code === 'SYSTEM_PATH_WRITE'), JSON.stringify(system))

  const startup = assessFileChange({
    path: 'C:\\Users\\Docker\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\p.cmd',
    op: 'create', kind: 'file', external: true, beforeBytes: 0, afterBytes: 20,
  })
  check('启动目录 = L3', startup.level === 'L3', JSON.stringify(startup))

  check('isSystemPath 识别 hosts', isSystemPath('C:\\Windows\\System32\\drivers\\etc\\hosts') === true)
  check('isSystemPath 不误判用户目录', isSystemPath('C:\\Users\\Docker\\code\\a.txt') === false)
}

process.stdout.write('\n=== 注册表后果 ===\n')
{
  const run = assessRegistryChange({ path: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', op: 'create', valueName: 'EvalWinsec' })
  check('Run 键写值 = L3', run.level === 'L3' && run.reasons.some((r) => r.code === 'PERSISTENCE_REGISTRY'), JSON.stringify(run))

  const runOnce = assessRegistryChange({ path: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce', op: 'create', valueName: 'X' })
  check('RunOnce 写值 = L3', runOnce.level === 'L3', JSON.stringify(runOnce))

  const winlogon = assessRegistryChange({ path: 'HKLM\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon', op: 'modify', valueName: 'Shell' })
  check('Winlogon Shell = L3', winlogon.level === 'L3', JSON.stringify(winlogon))

  const service = assessRegistryChange({ path: 'HKLM\\System\\CurrentControlSet\\Services\\EvalWinsec', op: 'create', valueName: 'ImagePath' })
  check('服务 ImagePath = L3', service.level === 'L3', JSON.stringify(service))

  const benign = assessRegistryChange({ path: 'HKCU\\Software\\EvalWinsec', op: 'create', valueName: 'flag' })
  check('普通注册表写值 = L2', benign.level === 'L2' && benign.reasons.some((r) => r.code === 'REGISTRY_WRITE'), JSON.stringify(benign))

  const del = assessRegistryChange({ path: 'HKCU\\Software\\EvalWinsec', op: 'delete', valueName: 'flag' })
  check('删除注册表值 = L2', del.level === 'L2', JSON.stringify(del))
}

process.stdout.write('\n=== 组合 ===\n')
{
  check('highestLevel 取最大', highestLevel(['L1', 'L2', 'L3', 'L1']) === 'L3')
  check('maxLevel(L2,L3) = L3', maxLevel('L2', 'L3') === 'L3')
  check('敏感值名识别', looksSensitiveValueName('Password') === true && looksSensitiveValueName('flag') === false)
}

process.stdout.write(`\n${assertions} 项断言，失败 ${failures} 项\n`)
process.exit(failures === 0 ? 0 : 1)
