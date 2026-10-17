// 备齐 `.dsh-vendor` 并生成 pnpm overrides：把 @deepseek-ai/* 指向那里的实体，
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

// ── 1. 只给"确实没有实体"的包建占位 ──────────────────────────────────────────
// ★ 为什么不能再按**固定名单**建占位（实测教训）：
//   旧版无条件把 `dsh-approval` / `dsh-bash-local` / `dsh-bash-sandbox` /
//   `node-addon-system` 四个包写成占位，而其中三个在 asar 里**有真实实体** ——
//   于是 `lib/index.js` 被占位内容覆盖，`packages/linux/src/shell/staged-shell.ts`
//   里 `class StagedShellExecutor extends SandboxBashExecutor` 拿到 undefined，
//   vitest 直接 `Class extends value undefined` 挂掉两个 spec（实测 6 个失败文件里
//   有 2 个是这个）。占位是"没有实体时的退路"，不能反过来销毁实体。
//
//   判定"有实体"：package.json 存在，且其声明的入口文件确实在盘上。
function hasRealBody(dir) {
  const pj = join(dir, 'package.json')
  if (!existsSync(pj)) return false
  try {
    const j = JSON.parse(readFileSync(pj, 'utf8'))
    if (j.version === '0.0.0-local-stub') return true // 已经是占位：别再动它
    if (typeof j.main === 'string') return existsSync(join(dir, j.main))
    return true // exports 形态：有 package.json 就先信它
  } catch {
    return false
  }
}

function writeStub(name) {
  const dir = join(VENDOR, name)
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({
      name: `@deepseek-ai/${name}`,
      version: '0.0.0-local-stub',
      private: true,
      description: '本地占位：DSH asar 里取不到实体（见 scripts/vendor/README.md）',
      main: './lib/index.js',
      types: './lib/index.d.ts',
    }, null, 2)}\n`,
  )
  writeFileSync(join(dir, 'lib/index.js'), '// 本地占位包：不可用。真要用到会在运行期立刻报错（不会静默通过）。\nmodule.exports = {}\n')
  writeFileSync(join(dir, 'lib/index.d.ts'), '// 本地占位：故意不导出任何成员。若有源码 import 它，tsc 会立即报错。\nexport {}\n')
}

// 需求的并集：三个包 manifest 里声明的 @deepseek-ai/* ＋ vendor 里已经存在的包
// （后者是传递依赖，pnpm 同样要解析它们）。
function requiredNames() {
  const names = new Set(readdirSync(VENDOR).filter((n) => existsSync(join(VENDOR, n, 'package.json'))))
  for (const pkg of ['core', 'win', 'linux']) {
    const pj = join(ROOT, 'packages', pkg, 'package.json')
    if (!existsSync(pj)) continue
    const j = JSON.parse(readFileSync(pj, 'utf8'))
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const dep of Object.keys(j[field] ?? {})) {
        if (dep.startsWith('@deepseek-ai/')) names.add(dep.slice('@deepseek-ai/'.length))
      }
    }
  }
  return [...names].sort()
}

const required = requiredNames()
const stubbed = required.filter((n) => !hasRealBody(join(VENDOR, n)))
for (const name of stubbed) writeStub(name)
console.log(`# 需求 ${required.length} 个包；其中**无实体需占位** ${stubbed.length} 个：${stubbed.join(', ') || '（无）'}`)

// ── 2. 生成 overrides ───────────────────────────────────────────────────────
const lines = required.map((n) => `  '@deepseek-ai/${n}': 'file:.dsh-vendor/node_modules/@deepseek-ai/${n}'`)

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
  '# ⚠ asar 里取不到实体的包会被建成**占位**（导出为空对象）：真实引用它时',
  '#   运行期立刻报错、tsc 报 TS2307 —— 不静默假绿。哪些是占位见引导脚本的输出。',
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
  console.log(`# 已更新 ${wsPath}：overrides ${required.length} 条`)
} else {
  console.log(`# ${wsPath} 无变化（overrides ${required.length} 条）`)
}
