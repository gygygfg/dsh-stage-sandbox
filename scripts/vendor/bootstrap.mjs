// 让 `pnpm install`（以及 DSH 装载插件时的安装步骤）**自己把依赖备齐**。
//
// 为什么需要它：本仓依赖的 `@deepseek-ai/*` 是私有包，公共 registry 404；可用的实体
// 在本机 DSH 安装目录的 `resources/app.asar` 里。于是"能装成功"依赖两个磁盘上的东西：
//   1) `.dsh-vendor/` —— 从 asar 提取出来的依赖树（gitignore，不入库）
//   2) `pnpm-workspace.yaml` 的 overrides —— 把依赖指过去
// 二者缺一，`pnpm install` 都会在第一步就失败。本脚本把"生成它们"变成安装流程的一环：
//
//   pnpm install
//     └─ preinstall: node scripts/vendor/bootstrap.mjs
//          ├─ .dsh-vendor 已有包？→ 跳过（幂等；--force 强制重建）
//          ├─ 否则 → asar-extract.mjs（从 DSH 安装目录提取依赖闭包）
//          └─ make-overrides.mjs（建 4 个占位包 + 重写 overrides 段）
//
// 退出码：0 正常 ｜ 1 无法备齐依赖（找不到 app.asar 且 vendor 缺失）—— **不静默通过**：
// 假装备齐了只会让 pnpm 报一个看不懂的 404，把根因埋掉。
//
// 逃生口：
//   DSH_VENDOR_SKIP=1   跳过引导（例如你已经有内网 registry）
//   DSH_APP_ASAR=<路径> 指定 app.asar 位置（默认自动探测，见 asar-extract.mjs）
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const VENDOR_NM = join(ROOT, '.dsh-vendor', 'node_modules', '@deepseek-ai')

function run(script) {
  const r = spawnSync(process.execPath, [join(HERE, script)], { stdio: 'inherit', cwd: ROOT })
  if (r.status !== 0) {
    console.error(`# ${script} 失败（exit=${r.status}）⇒ 依赖无法备齐，安装中止`)
    process.exit(r.status ?? 1)
  }
}

function packageCount() {
  if (!existsSync(VENDOR_NM)) return 0
  return readdirSync(VENDOR_NM).filter((n) => existsSync(join(VENDOR_NM, n, 'package.json'))).length
}

if (process.env.DSH_VENDOR_SKIP === '1') {
  console.log('# DSH_VENDOR_SKIP=1 ⇒ 跳过 vendor 引导（假定你已有可用的 @deepseek-ai registry）')
  process.exit(0)
}

const force = process.argv.includes('--force')
const have = packageCount()

if (have > 0 && !force) {
  console.log(`# .dsh-vendor 已有 ${have} 个 @deepseek-ai 包 ⇒ 跳过提取（强制重建：加 --force）`)
} else {
  console.log(`# .dsh-vendor ${have === 0 ? '缺失' : `需重建（现有 ${have} 个包）`} ⇒ 从 DSH 安装目录提取`)
  run('asar-extract.mjs')
}

// overrides 每次都重算：vendor 内容变了（新增/减少包）而 overrides 没跟上，
// 依赖图就会指向不存在的目录 —— 这一步幂等，内容无变化时不写文件。
run('make-overrides.mjs')
console.log(`# vendor 引导完成：${packageCount()} 个 @deepseek-ai 包就位`)
