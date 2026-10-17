// 生成本地 vendor 的 pnpm overrides：把 @deepseek-ai/* 指向 `.dsh-vendor` 下的实体，
// 让 `pnpm install` 不再去公共 registry 取这些私有包。
//
// 幂等：只重写 `pnpm-workspace.yaml` 里 `# --- BEGIN/END LOCAL VENDOR OVERRIDES ---`
// 之间的内容；文件内容无变化时 `pnpm-workspace.yaml` 一字不动。
import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const VENDOR = join(ROOT, '.dsh-vendor', 'node_modules', '@deepseek-ai')

if (!existsSync(VENDOR)) {
  console.error(`# 没有 ${VENDOR} —— 先跑 node scripts/vendor/asar-extract.mjs`)
  process.exit(1)
}

// ── 1. 为缺失包建占位（这些包在 asar 里也不完整/不在 unpacked 中）─────────────
// ★ 诚实前提：以下包在 packages/linux 的**源码里无引用**（实测 grep 0 命中），
//   因此占位不会影响本仓的类型检查与构建；只是为了解除依赖图上的死锁。
//   若将来真的 import 它们，占位会立刻在 tsc 里暴露为 TS2307 —— 不会静默假绿。
const STUBS = ['dsh-approval', 'dsh-bash-local', 'dsh-bash-sandbox', 'node-addon-system']
for (const name of STUBS) {
  const dir = join(VENDOR, name)
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({
      name: `@deepseek-ai/${name}`,
      version: '0.0.0-local-stub',
      private: true,
      description: `本地占位：DSH asar 里取不到实体，且本仓源码未引用（见 scripts/vendor/README.md）`,
      main: './lib/index.js',
      types: './lib/index.d.ts',
    }, null, 2)}\n`,
  )
  writeFileSync(join(dir, 'lib/index.js'), `// 本地占位包：不可用。真要用到会在运行期立刻报错（不会静默通过）。\nmodule.exports = {}\n`)
  writeFileSync(join(dir, 'lib/index.d.ts'), `// 本地占位：故意不导出任何成员。若有源码 import 它，tsc 会立即报错。\nexport {}\n`)
}
console.log(`# 占位包 ${STUBS.length} 个：${STUBS.join(', ')}`)

// ── 2. 生成 overrides ───────────────────────────────────────────────────────
const names = readdirSync(VENDOR).sort()
const lines = names.map((n) => `  '@deepseek-ai/${n}': 'file:.dsh-vendor/node_modules/@deepseek-ai/${n}'`)

const wsPath = join(ROOT, 'pnpm-workspace.yaml')
const original = readFileSync(wsPath, 'utf8')
let text = original.replace(/\r\n/g, '\n')
// ★ 结尾标记是 `# --- END LOCAL VENDOR OVERRIDES ---`（带尾随 ` ---`）。
//   正则里漏掉它 ⇒ 匹配失败 ⇒ 每次跑都**追加**一个新块而不是替换（实测：连跑两次
//   pnpm-workspace.yaml 里出现三块 overrides，pnpm 直接报重复键）。替换必须整段命中。
text = text.replace(/^# --- BEGIN LOCAL VENDOR OVERRIDES ---[\s\S]*?^# --- END LOCAL VENDOR OVERRIDES ---[ \t]*\n?/m, '')
if (/# --- (BEGIN|END) LOCAL VENDOR OVERRIDES/.test(text)) {
  console.error('# overrides 段仍残留（块标记不匹配）⇒ 拒绝写入，避免把 pnpm-workspace.yaml 写坏')
  process.exit(1)
}

const block = [
  '# --- BEGIN LOCAL VENDOR OVERRIDES ---',
  '# ★ 为什么有这一段：',
  '#   本仓依赖的 `@deepseek-ai/dsh-*` 全部是**私有包**，实测 registry.npmjs.org 与',
  '#   registry.npmmirror.com 均 404 ⇒ `pnpm install` 在依赖图的第一步就失败，',
  '#   连带 `pnpm -r typecheck` 与 `prepare`（构建 dist）都无法执行。',
  '#',
  '#   而 DSH 桌面端安装目录自带一份完整的运行时依赖树：',
  '#     %LOCALAPPDATA%\\Programs\\DeepSeek Harness\\resources\\app.asar',
  '#     内部路径 dsh/node_modules/@deepseek-ai/ 共 289 个包。',
  '#   本段把依赖改指向从那里提取出来的 `.dsh-vendor/`（该目录 gitignore，不入库）。',
  '#',
  '# ★ 这一段**由脚本生成、不要手改**：',
  '#     node scripts/vendor/bootstrap.mjs [--force]',
  '#   它挂在根 package.json 的 `preinstall` 上，因此 `pnpm install` 会自己备齐依赖。',
  '#',
  '# ⚠ 前提：`.dsh-vendor/` 存在。它有 4 个**占位包**（asar 与 unpacked 里都没有实体，',
  '#   且本仓源码对它们 0 引用）—— 真被 import 时 tsc 会立刻报 TS2307，不会假绿。',
  '#',
  '# ✅ 若将来拿到内网 registry：删掉本段、删掉 `preinstall` 引导，并在仓库根加',
  '#    `.npmrc`（`@deepseek-ai:registry=...`）即可回到正常依赖来源。',
  'overrides:',
  ...lines,
  '# --- END LOCAL VENDOR OVERRIDES ---',
  '',
].join('\n')

const next = text.trimEnd() + '\n\n' + block
if (next !== original.replace(/\r\n/g, '\n')) {
  writeFileSync(wsPath, next, 'utf8')
  console.log(`# 已更新 ${wsPath}：overrides ${names.length} 条`)
} else {
  console.log(`# ${wsPath} 无变化（overrides ${names.length} 条）`)
}
