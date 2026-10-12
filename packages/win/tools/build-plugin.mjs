#!/usr/bin/env node
// @ts-nocheck —— 构建脚本（Node 直跑，不参与 tsconfig 的 src/tests 封印面）
/**
 * tools/build-plugin.mjs —— 把 `.ts` 运行时入口编译成可被 DSH 加载的 **JS** 产物。
 *
 * 存在理由（Node 实测错误，必须在这里解决）：
 *   本仓全量 TS 化后，插件入口是 `plugin/index.ts` / `dsh-plugin/fs-entry.ts` /
 *   `dsh-plugin/shell-entry.ts`。当插件通过 `dsh plugin add` **装进 node_modules** 后，
 *   Node 24 的类型剥离**拒绝**处理 node_modules 下的 `.ts`：
 *     ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
 *   于是三条 entry 全部 `failed to import` ⇒ fs/shell 无提供方 ⇒ sessionController 起不来。
 *   （`link:` 到仓库目录时不在 node_modules 下，才能侥幸加载。）
 *
 * 因此发布物必须带 **JS 入口**：`.ts` 仍作源，`exports` 指向这里产出的 `dist/*.mjs`。
 *
 * ── 为什么用 esbuild 的 `splitting` 而不是分别 bundle ─────────────────────────
 * `winstage-fs` 与 `winstage-shell` **共享**进程内单例（`review-service.ts` 的
 * `getReviewService()`，按 `canonical(root)#sessionId` 分键）。若三个入口各自 bundle 成
 * 独立文件，共享模块会被复制成三份 ⇒ 三个单例 ⇒「暂存写到 A、面板发布在 B」。
 * `splitting: true` 把共享模块提取成公共 chunk、仅一份 ⇒ 单例语义保持。
 *
 * 平台包（`@deepseek-ai/*`）与原生模块（koffi/node-pty）保持 external：前者由 harness
 * 运行时提供、后者按运行时绝对路径加载（`resolveDshModuleRoot()`），都不该被打进产物。
 *
 * 用法：node tools/build-plugin.mjs
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(REPO, 'dist')

rmSync(OUT, { recursive: true, force: true })

await build({
  absWorkingDir: REPO,
  entryPoints: {
    index: 'plugin/index.ts',
    'fs-entry': 'dsh-plugin/fs-entry.ts',
    'shell-entry': 'dsh-plugin/shell-entry.ts',
  },
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outExtension: { '.js': '.mjs' },
  // 只把「运行期按绝对路径/裸名解析」的平台包与原生模块设为 external：
  //   · `@deepseek-ai/dsh-shell` 是 `shell-executor` 里的**字面**动态 import（其它平台包用
  //     `pathToFileURL(绝对路径)`，esbuild 看不到）；
  //   · koffi / node-pty 由 `resolveDshModuleRoot()` 在运行期加载。
  // `@deepseek-ai/schemastery` **不** external：把它打进产物，插件就不再依赖 profile 里
  // 是否有可解析的依赖（否则 `link:` 装法不装依赖，config.ts 的 import 会失败）。
  external: ['node:*', 'koffi', 'node-pty', '@deepseek-ai/dsh-shell', '@deepseek-ai/cordis'],
  sourcemap: false,
  logLevel: 'info',
})

// 客户端半：`dsh-plugin/client.ts` 是挂到 `window.__ModuleLoader__.load` 的**脚本**
// （不是 ESM），只需剥离类型、保持原样；`require('react')` 由宿主客户端运行时提供。
await build({
  absWorkingDir: REPO,
  entryPoints: ['dsh-plugin/client.ts'],
  outdir: 'dist',
  bundle: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'info',
})

console.log('built dist/index.mjs, dist/fs-entry.mjs, dist/shell-entry.mjs, dist/client.js (+ shared chunks)')
