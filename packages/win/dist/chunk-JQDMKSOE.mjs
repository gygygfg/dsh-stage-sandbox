import {
  CREATE_NEW_CONSOLE,
  buildMitigationPolicy,
  findStaleAppContainerAces,
  listAppContainerSids,
  parseSddlDaclAces,
  summariseMitigations
} from "./chunk-Z53TC6BM.mjs";

// dsh-plugin/review-service.ts
import { copyFileSync as copyFileSync2, existsSync as existsSync8, mkdirSync as mkdirSync7, readFileSync as readFileSync8, readdirSync as readdirSync5, renameSync as renameSync5, rmSync as rmSync7, statSync as statSync5, writeFileSync as writeFileSync8 } from "node:fs";
import { dirname as dirname8, isAbsolute as isAbsolute4, join as join12, sep as sep6 } from "node:path";

// src/paths.ts
import { realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
function lexical(anyPath) {
  if (typeof anyPath !== "string" || anyPath.length === 0) {
    throw new TypeError("path must be a non-empty string");
  }
  let p = anyPath;
  if (p.startsWith("\\\\?\\")) p = p.slice(4);
  else if (p.startsWith("\\\\.\\")) p = p.slice(4);
  if (p.startsWith("UNC\\")) p = "\\\\" + p.slice(4);
  p = p.replace(/\//g, sep);
  p = normalize(p);
  if (/^[a-zA-Z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
  return p;
}
function canonical(anyPath) {
  const lex = lexical(anyPath);
  try {
    return realpathSync.native(lex);
  } catch {
    const parts = [];
    let cursor = lex;
    for (let depth = 0; depth < 64; depth += 1) {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      parts.unshift(cursor.slice(parent.length).replace(/^[\\/]/, ""));
      try {
        const resolvedParent = realpathSync.native(parent);
        return normalize(join(resolvedParent, ...parts));
      } catch {
        cursor = parent;
      }
    }
    return lex;
  }
}
function compareKey(anyPath) {
  return lexical(anyPath).toLowerCase();
}
function lexicalInside(parent, child) {
  const p = lexical(parent).replace(/[\\/]+$/, "");
  const c = lexical(child);
  if (c.length < p.length) return void 0;
  if (c.slice(0, p.length).toLowerCase() !== p.toLowerCase()) return void 0;
  const rest = c.slice(p.length);
  if (rest === "") return "";
  if (!rest.startsWith(sep)) return void 0;
  return rest.replace(/^[\\/]+/, "");
}
function isInside(parent, child) {
  const p = compareKey(canonical(parent));
  const c = compareKey(canonical(child));
  if (p === c) return true;
  const withSep = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(withSep);
}
function segments(relativePath) {
  return relativePath.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
}
function stableSort(paths) {
  return [...paths].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
}
var MASK_CLASSES = [
  // ── 原有 15 条：逐字保留（review-service 的 danger 清单引用它们的 id）────────
  //
  // ⚠ 顺序即优先级（`maskReason()` 返回**第一个**命中项），因此"更具体的规则必须排在更宽的规则之前"。
  //    这条在落地 N 类时被本测试当场抓到三处（全部是"宽规则吃掉窄规则"）：
  //      `dpapi`(宽) 吃掉 `dpapi-user`(窄)、`dsh-home`(宽) 吃掉 `dsh-credentials` / `dsh-profile-deps`。
  // ⚠ S3 修复（[实测] net-sens 阶段 B §5 / 本轮复现）：
  //   `canonical()` 走 `path.normalize`，**去掉结尾分隔符**。因此任何以 `\\` 收尾的模式
  //   都只能命中"该目录**之下**的文件"，命中不到**目录本身**：
  //   实测 `%APPDATA%\Microsoft\Protect` 目录可枚举（entries=2）却 `mask=(none)`。
  //   修法是把尾部 `\\` 改成 `(\\|$)`（"分隔符或结尾"），使目录自身与其后代都能命中。
  //   `probe-dpapi-user-dir` 就是为这条口径加的探针，避免"只有文件探针"时回归悄悄发生。
  { id: "dpapi-user", category: "DPAPI \u4E3B\u5BC6\u94A5", pattern: /\\appdata\\roaming\\microsoft\\protect(\\|$)/i, reason: "\u7528\u6237 DPAPI \u4E3B\u5BC6\u94A5\uFF08\u76EE\u5F55\u672C\u8EAB\u4E0E\u5176\u4E0B\u6240\u6709\u4E3B\u5BC6\u94A5\u6587\u4EF6\uFF09" },
  { id: "dpapi", category: "DPAPI \u4E3B\u5BC6\u94A5", pattern: /\\microsoft\\protect(\\|$)/i, reason: "DPAPI \u4E3B\u5BC6\u94A5\uFF08\u76EE\u5F55\u81EA\u8EAB\u4E0E\u5176\u4E0B\u6240\u6709\u4E3B\u5BC6\u94A5\u6587\u4EF6\uFF1BT2 \u4FEE\u76EE\u5F55\u5F62\u6001\uFF09" },
  // N4 的两条必须排在 dsh-home 之前，否则永远命中不到
  { id: "dsh-credentials", category: "\u672C\u5DE5\u5177\u81EA\u8EAB\u51ED\u636E\u6587\u4EF6", pattern: /\\\.dsh\\\.credentials\.yaml$/i, reason: "DSH \u51ED\u636E\u6587\u4EF6\uFF08\u660E\u6587\u4F1A\u8BDD\u51ED\u636E\uFF09" },
  { id: "dsh-profile-deps", category: "\u672C\u5DE5\u5177 profile \u7684\u4F9D\u8D56\u6811\uFF08\u53EF\u542B\u7B2C\u4E09\u65B9\u63D2\u4EF6\u4EE3\u7801\uFF09", pattern: /\\\.dsh\\profiles\\[^\\]+\\node_modules(\\|$)/i, reason: "DSH profile \u4F9D\u8D56\u6811\uFF1A\u7B2C\u4E09\u65B9\u63D2\u4EF6\u4EE3\u7801\u53CA\u5176\u53EF\u80FD\u5185\u5D4C\u7684\u4EE4\u724C" },
  // ── T2 收敛（读取面）：注册表配置单元族 ────────────────────────────────────
  // ① `config` **目录自身**也要命中（旧模式以 `\\` 收尾 ⇒ `[实测]` 目录自身 `mask=(none)`）；
  // ② 用户注册表 `NTUSER.DAT` / `UsrClass.dat` 是本机**可 stat、可枚举**的敏感对象
  //    （`[实测]` 1048576 B，读内容为 EBUSY=被系统占用），旧表**完全没有**规则覆盖它。
  // 归入 `sam`（"注册表配置单元"）而不是新开 id：`sam` 已在 `DANGER_MASK_IDS` 里，
  // 用户注册表与 SAM 同级敏感，走 danger 档（内容在审批面自动省略）才是正确后果。
  {
    id: "sam",
    category: "\u6CE8\u518C\u8868\u914D\u7F6E\u5355\u5143\uFF08SAM/SECURITY/SYSTEM \u4E0E\u7528\u6237\u6CE8\u518C\u8868 NTUSER.DAT / UsrClass.dat\uFF09",
    pattern: /^[a-z]:\\windows\\system32\\config(\\|$)|\\(ntuser|usrclass)\.dat(\.log[0-9]*)?$/i,
    reason: "\u6CE8\u518C\u8868\u914D\u7F6E\u5355\u5143\uFF1A\u672C\u5730\u8D26\u6237\u6570\u636E\u5E93 SAM/SECURITY/SYSTEM\uFF0C\u4EE5\u53CA\u7528\u6237/\u7C7B\u6CE8\u518C\u8868 NTUSER.DAT / UsrClass.dat\uFF08\u542B\u5176\u5FD9\u788C\u65E5\u5FD7\u526F\u672C\uFF09"
  },
  // ⚠ 以下四条在 T2 收敛里由 `\\\.ssh\\` 改成 `(\\|$)`：旧写法命中不到**这些目录自身**
  //    （`canonical()` 去掉结尾分隔符），于是"列目录"这一步漏在外面（S3 同一根因）。
  { id: "ssh", category: "SSH \u79C1\u94A5", pattern: /\\\.ssh(\\|$)/i, reason: "SSH \u79C1\u94A5\uFF08\u76EE\u5F55\u81EA\u8EAB\u4E0E\u5176\u4E0B\u6240\u6709\u6587\u4EF6\uFF09" },
  { id: "aws", category: "\u4E91\u51ED\u636E", pattern: /\\\.aws(\\|$)/i, reason: "\u4E91\u51ED\u636E\uFF08\u76EE\u5F55\u81EA\u8EAB\u4E0E\u5176\u4E0B\u6240\u6709\u6587\u4EF6\uFF09" },
  { id: "gcloud", category: "\u4E91\u51ED\u636E", pattern: /\\\.config\\gcloud(\\|$)/i, reason: "\u4E91\u51ED\u636E\uFF08\u76EE\u5F55\u81EA\u8EAB\u4E0E\u5176\u4E0B\u6240\u6709\u6587\u4EF6\uFF09" },
  { id: "kube", category: "\u96C6\u7FA4\u51ED\u636E", pattern: /\\\.kube(\\|$)/i, reason: "\u96C6\u7FA4\u51ED\u636E\uFF08\u76EE\u5F55\u81EA\u8EAB\u4E0E\u5176\u4E0B\u6240\u6709\u6587\u4EF6\uFF09" },
  { id: "git-credentials", category: "\u660E\u6587\u51ED\u636E", pattern: /\\\.git-credentials$/i, reason: "Git \u660E\u6587\u51ED\u636E" },
  { id: "npmrc", category: "\u5305\u7BA1\u7406\u5668\u4EE4\u724C", pattern: /\\\.npmrc$/i, reason: "\u5305\u7BA1\u7406\u5668\u4EE4\u724C" },
  // ⚠ T2 收敛：`\\\.dsh\\` → `(\\|$)`。`[实测]` 修复前 `C:\Users\Administrator\.dsh`
  //    （**整个 DSH 主目录**，13 个条目：sessions/credentials/profile/日志）`mask=(none)`。
  {
    id: "dsh-home",
    category: "\u672C\u5DE5\u5177\u81EA\u8EAB\u51ED\u636E/\u4F1A\u8BDD",
    pattern: /\\\.dsh(\\|$)/i,
    reason: "DSH \u4E3B\u76EE\u5F55\uFF1A\u4F1A\u8BDD\u65E5\u5FD7\u3001\u51ED\u636E\u5E93\u3001profile \u914D\u7F6E\uFF08\u76EE\u5F55\u81EA\u8EAB\u4E0E\u5176\u4E0B\u6240\u6709\u6587\u4EF6\uFF09"
  },
  // 同理：`.dshstage` **目录自身**此前也命中不到（S3 同一根因）。unmask 永不解除。
  { id: "stage-store", category: "\u672C\u5DE5\u5177\u81EA\u8EAB\u5B58\u50A8", pattern: /\\\.dshstage(\\|$)/i, reason: "\u6C99\u7BB1\u81EA\u8EAB\u5B58\u50A8\uFF08unmask \u6C38\u4E0D\u89E3\u9664\uFF1B\u76EE\u5F55\u81EA\u8EAB\u4E0E\u5176\u4E0B\u6240\u6709\u6587\u4EF6\uFF09", hard: true },
  { id: "browser", category: "\u6D4F\u89C8\u5668\u51ED\u636E\u5E93", pattern: /\\appdata\\(local|roaming)\\(google|microsoft\\edge|mozilla)\\.*(login data|cookies|key4\.db|logins\.json)/i, reason: "\u6D4F\u89C8\u5668\u51ED\u636E\u5E93" },
  // ── S5：浏览器凭据库的"位置无关"口径（本轮修复；[实测] 见下）──────────────────
  //
  // 为什么必须新增：既有的 `browser` 规则**硬编码了 `\appdata\...` 前缀**，
  // 于是"浏览器 profile 不在 AppData 下"时**完全不被遮蔽**。
  // `[实测]` 本机 `.t\dsh2\browser\edge-profile{,-headful}\...`（非 AppData，且是标准
  // Chromium profile 形状）：
  //   `edge-profile\Default\Login Data`                  129024 B  可读  mask=(none)
  //   `edge-profile\Default\Login Data For Account`       51200 B  可读  mask=(none)
  //   `edge-profile\Local State`                          25300 B  可读  mask=(none)
  //   `edge-profile-headful\Default\Login Data`          129024 B  可读  mask=(none)
  //   `edge-profile-headful\Default\Login Data For Account` 51200 B 可读  mask=(none)
  //   `edge-profile-headful\Local State`                  74863 B  可读  mask=(none)
  // 判据类别：**文件名族 + 扩展名约定**（不是"某个样本路径"）。
  //   · `Login Data` / `Login Data For Account` / `Web Data` 是 Chromium 的**固定文件名**，
  //     且文件名里带空格 ⇒ 不会误伤源码/夹具里任何常规标识符；
  //   · `Local State` 太普通（很多程序都有同名文件），因此**限定在** `...<profile>\Local State`
  //     这种"上一级目录名以 profile 结尾"的形状（`[^\\]*profile\local state$`）。
  // 诚实声明：这两条仍然是**黑名单**（按命名约定枚举），**不是硬边界** ——
  //   换个文件名（例如把 `Login Data` 复制成 `login.db`）就绕过了；
  //   真正的读面硬边界是 T0（AppContainer），而 T0 目前未生效（阶段 B：子进程不在 AppContainer 里）。
  // ── T2 收敛：把"浏览器 profile 关键库"从"凭据库"扩到**三类**（同为 Chromium 固定文件名）──
  // `[实测]`（本机，`tests\paths-masks.ts --probe`）修复前：
  //   `...\Edge\User Data\Default\History`            491520 B  readable  mask=(none)
  //   `...\edge-profile\Default\Network\Cookies`                not-present（AppData 外形状）
  //   而 AppData 内的同一批文件早已由更宽的 `browser` 规则命中（`mask=browser`），
  //   所以这里补的是**位置无关**的那一半，而不是重复。
  // 判据类别（逐条都能说出"哪一类对象"）：
  //   · `Login Data[ For Account]` / `Web Data` / `Network\Cookies` —— Chromium **固定文件名**；
  //   · `History` / `Archived History` —— **文件名太普通**，所以额外要求父目录是
  //     Chromium profile 形状（`Default` / `Profile N` / `Guest Profile` / `*profile`），
  //     避免把源码或夹具里任何叫 `History` 的目录一起封死（#16.8 作用域限定）。
  // 诚实声明：这仍然是**黑名单按命名约定枚举**，换个名字（把 `History` 复制成 `h.db`）就绕过；
  //   真实的读面硬边界是 T0（AppContainer），而 T0 的接线状态见 `docs\T2-T0接线契约.md`。
  //
  // ⚠ 为什么不新开一个 `browser-history-db` id（看起来更干净）：`src\audit.ts::READ_PROBES`
  //   与 `MASK_CLASSES` 之间有**双向覆盖契约**（`tests\audit-parse.ts` 用
  //   `READ_PROBE_MISSING_MASK_CLASSES` 强制"每个遮蔽类都要有读取探针"），而 `audit.ts`
  //   不在 T2 的写入边界内。为不把 `verify.cmd` 弄红又不越界，这里把新形状**并入既有类**
  //   并同步改 `category`/`reason` 文字；"单独立类"的补丁写在 `docs\T2-敏感读收敛报告.md`。
  {
    id: "browser-profile-auth-db",
    category: "\u6D4F\u89C8\u5668 profile \u5173\u952E\u5E93\u6587\u4EF6\u65CF\uFF08\u51ED\u636E\u5E93 / \u4F1A\u8BDD cookie / \u6D4F\u89C8\u5386\u53F2\uFF1B\u4F4D\u7F6E\u65E0\u5173\uFF09",
    pattern: /\\(login data( for account)?|web data|network\\cookies)(\\|$)|\\(default|profile \d+|guest profile|system profile|[^\\]*profile)\\((archived )?history)(\\|$)/i,
    reason: "\u6D4F\u89C8\u5668 profile \u5173\u952E\u5E93\uFF1AChromium \u56FA\u5B9A\u6587\u4EF6\u540D\uFF08Login Data / Web Data / Network\\Cookies\uFF09\u4E0E profile \u5F62\u72B6\u4E0B\u7684 History\uFF08\u4E0D\u518D\u8981\u6C42\u4F4D\u4E8E AppData \u2014 S5/T2\uFF09"
  },
  {
    id: "browser-profile-state",
    category: "\u6D4F\u89C8\u5668 profile \u72B6\u6001\u6587\u4EF6\uFF08\u542B\u52A0\u5BC6\u5BC6\u94A5\u7684\u672C\u5730\u72B6\u6001\u7C7B\uFF09",
    pattern: /\\[^\\]*profile\\(local state|login data( for account)?|web data)(\\|$)|\\local state$/i,
    reason: "\u6D4F\u89C8\u5668 profile \u5173\u952E\u72B6\u6001\u6587\u4EF6\uFF08Local State \u5185\u542B DPAPI \u4FDD\u62A4\u7684\u52A0\u5BC6\u5BC6\u94A5\uFF1BS5 \u4FEE\u590D\uFF09"
  },
  { id: "unattend", category: "\u65E0\u4EBA\u503C\u5B88\u5E94\u7B54\u6587\u4EF6", pattern: /\\unattend\.xml$/i, reason: "\u53EF\u80FD\u542B\u660E\u6587\u53E3\u4EE4" },
  { id: "sysvol-copy", category: "AD \u6570\u636E\u5E93", pattern: /\\ntds\.dit$/i, reason: "AD \u6570\u636E\u5E93" },
  { id: "hosts", category: "\u7F51\u7EDC\u914D\u7F6E\uFF08\u660E\u6587/\u53EF\u7BE1\u6539\uFF09", pattern: /\\windows\\system32\\drivers\\etc\\(hosts|lmhosts)$/i, reason: "\u4E3B\u673A\u540D\u6620\u5C04" },
  // T2：`wlansvc\\` → `wlansvc(\\|$)`（目录自身此前命中不到）
  { id: "wifi", category: "Wi-Fi \u914D\u7F6E\uFF08\u542B\u660E\u6587\u5BC6\u94A5\uFF09", pattern: /\\programdata\\microsoft\\wlansvc(\\|$)/i, reason: "Wi-Fi \u914D\u7F6E\u542B\u660E\u6587\u5BC6\u94A5\uFF08\u76EE\u5F55\u81EA\u8EAB\u4E0E\u5176\u4E0B\u6240\u6709 profile\uFF09" },
  // ── N1：凭据存储目录的通用命名 ─────────────────────────────────────────────
  // 类别：CI/云工具把**长期令牌**放在固定命名约定下（约定稳定，名字可枚举）。
  // 探针必须与规则形状一致：初次写成 `%APPDATA%\.config\gh\...`（多插了一层 AppData），
  // 被本测试当场判红——"探针写错"和"规则失效"必须能区分开。
  {
    id: "cli-cred-dirs",
    category: "\u4E91/CI \u5DE5\u5177\u51ED\u636E\u76EE\u5F55\uFF08\u547D\u540D\u7EA6\u5B9A\u7C7B\uFF09",
    pattern: /\\\.terraform\.d([\\/]|$)|\\\.pulumi([\\/]|$)|\\\.config[\\/](gh|gcloud|azure|aws|pulumi|doctl)([\\/]|$)|\\\.local[\\/](gh|gcloud|azure|aws|pulumi|doctl)([\\/]|$)/i,
    reason: "\u4E91/CI \u5DE5\u5177\u7684\u51ED\u636E\u76EE\u5F55\uFF08\u957F\u671F\u4EE4\u724C\u4EE5\u56FA\u5B9A\u547D\u540D\u7EA6\u5B9A\u843D\u76D8\uFF09"
  },
  // ── N2：包管理器令牌文件族 ─────────────────────────────────────────────────
  // 类别：**纯文本长期令牌**这同一类风险；原有表只覆盖 .npmrc 一个。
  // 注意两处（都是本测试当场抓到的真错）：
  //   ① 目录分隔符必须写成 `[\\/]`：`\.nuget\NuGet.Config` 在正则里会被解释成
  //      "转义点 + 字面 n + 任意字符 + NuGet"，于是永远不命中；
  //   ② 叶子名里本来就有点的（`NuGet.Config`）不能加前导 `\.`，否则同样永不命中。
  {
    id: "pkg-token-files",
    category: "\u5305\u7BA1\u7406\u5668\u4EE4\u724C\u6587\u4EF6\u65CF\uFF08\u660E\u6587\u957F\u671F\u4EE4\u724C\u7C7B\uFF09",
    pattern: /\\(\.npmrc|\.yarnrc|\.yarnrc\.yml|\.pypirc|\.netrc|_netrc|\.gem[\\/]credentials|\.nuget[\\/]NuGet\.Config|\.config[\\/]pip[\\/]pip\.conf|\.docker[\\/]config\.json|\.cargo[\\/]credentials(\..*)?|NuGet\.Config)(\\|$)/i,
    reason: "\u5305\u7BA1\u7406\u5668/CI \u4EE5\u7EAF\u6587\u672C\u4FDD\u5B58\u957F\u671F\u4EE4\u724C\uFF08\u4E0E .npmrc \u540C\u7C7B\uFF09"
  },
  // ── N3 / T2：凭据管理器 / DPAPI 输出 + AppData 下的 `*.credentials` 命名类 ────
  // `[实测]`（本机）`%LOCALAPPDATA%\Microsoft\Credentials` 目录**存在且可枚举**（3 条），
  // 修复前靠 `(\\|$)` 已能命中目录自身（与 S3 同一条修法），本轮补一条**目录形态**探针把它锁住。
  // 新增的第二支覆盖"不在 `Microsoft\` 下、但以 `.credentials` 命名"的凭据目录
  // （浏览器/CLI 常见的落盘命名约定）；`[实测]` 本机**不存在**这样的目录，
  // 因此它的探针是**形状探针**（构造出的命名类候选），会在报告里如实标注。
  {
    id: "cred-vault",
    category: "Windows \u51ED\u636E\u7BA1\u7406\u5668\u843D\u76D8\u4F4D\u7F6E + AppData \u4E0B *.credentials \u547D\u540D\u7C7B",
    pattern: /\\appdata\\(local|roaming)\\microsoft\\(credentials|vault)(\\|$)|\\appdata\\(local|roaming)\\[^\\]*\.credentials(\\|$)/i,
    reason: "Windows \u51ED\u636E\u7BA1\u7406\u5668/\u4FDD\u7BA1\u5E93\u843D\u76D8\u4F4D\u7F6E\uFF08\u4E0E DPAPI \u4E3B\u5BC6\u94A5\u540C\u7C7B\uFF09\uFF0C\u4EE5\u53CA AppData \u4E0B\u4EE5 *.credentials \u547D\u540D\u7684\u51ED\u636E\u76EE\u5F55"
  },
  // ── N5：无人值守/部署应答的族 ─────────────────────────────────────────────
  {
    id: "unattend-family",
    category: "\u9996\u6B21\u542F\u52A8\u5E94\u7B54\u6587\u4EF6\u65CF",
    pattern: /\\(unattend|autounattend)\.xml$|\\sysprep\.(inf|xml)$|\\panther\\[^\\]*\.xml$/i,
    reason: "\u9996\u6B21\u542F\u52A8/\u90E8\u7F72\u5E94\u7B54\u6587\u4EF6\u53EF\u80FD\u542B\u660E\u6587\u53E3\u4EE4\u6216\u4EA7\u54C1\u5BC6\u94A5"
  },
  // ── N6：网络配置族（含明文密钥 / 可能含凭据材料的日志）────────────────────
  {
    id: "net-config-family",
    category: "\u7F51\u7EDC\u914D\u7F6E\u4E0E\u4E8B\u4EF6\u65E5\u5FD7",
    pattern: /\\(networks|protocol)$|\\windows\\system32\\winevt\\logs\\[^\\]*\.evtx$|\\windows\\system32\\config\\[^\\]*\.evtx$/i,
    reason: "\u7F51\u7EDC\u914D\u7F6E\u6587\u4EF6\u4E0E\u4E8B\u4EF6\u65E5\u5FD7\uFF08\u4E8B\u6545/\u5BA1\u8BA1\u65E5\u5FD7\u53EF\u80FD\u542B\u51ED\u636E\u6750\u6599\uFF09"
  },
  // ── N7 / T2：编辑器/IDE 全局状态 + 终端命令历史 ──────────────────────────────
  // `[实测]`（本机）`%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine` 目录可枚举（1 条），
  // 其 `ConsoleHost_history.txt` 7950 B **可读**、修复前 `mask=(none)`。
  // 判据刻意选**目录**（`...\psreadline(\\|$)`）而不是文件名：命令历史可以改名/轮转，
  // 而目录名是稳定约定 ⇒ 改名不绕过（这正是"用同一目录形态代替黑名单文件名"的做法）。
  {
    id: "editor-token-state",
    category: "\u7F16\u8F91\u5668/\u7EC8\u7AEF\u5168\u5C40\u72B6\u6001\uFF08\u6269\u5C55\u4EE4\u724C\u4E0E\u547D\u4EE4\u5386\u53F2\u7C7B\uFF09",
    pattern: /\\appdata\\roaming\\(code|cursor)(\\logs)?\\user\\globalstorage(\\|$)|\\appdata\\roaming\\microsoft\\windows\\powershell\\psreadline(\\|$)/i,
    reason: "\u7F16\u8F91\u5668\u6269\u5C55\u628A PAT/\u4EE4\u724C\u5199\u8FDB globalStorage\uFF1BPowerShell PSReadLine \u76EE\u5F55\u4FDD\u5B58\u8F93\u5165\u8FC7\u7684\u547D\u4EE4\uFF08\u5E38\u542B\u660E\u6587\u4EE4\u724C/\u53E3\u4EE4\uFF09"
  },
  // ── N8：本机私钥/证书导出（**限定作用域**）───────────────────────────────
  // 限定在 \users\ 与 \programdata\ 之下：避免把源码/测试夹具里的 *.pem 一起封死（#16.8）。
  {
    id: "private-key-files",
    category: "\u79C1\u94A5/\u8BC1\u4E66\u5BFC\u51FA\u6587\u4EF6\uFF08\u6269\u5C55\u540D\u7EA6\u5B9A\u7C7B\uFF0C\u9650\u5B9A\u4F5C\u7528\u57DF\uFF09",
    pattern: /\\(users|programdata)\\.*\.(pfx|p12|pvk|pem|key)$/i,
    reason: "\u79C1\u94A5/\u8BC1\u4E66\u5BFC\u51FA\u6587\u4EF6\uFF08\u4F5C\u7528\u57DF\u9650\u5B9A\u5728\u7528\u6237\u4E0E\u7A0B\u5E8F\u6570\u636E\u76EE\u5F55\uFF0C\u907F\u514D\u8BEF\u4F24\u6E90\u7801\u5939\u5177\uFF09"
  },
  // ── N9：凭据缓存 / SSO cookie（T2：`inetcookies\\` → `inetcookies(\\|$)`，目录自身）──
  {
    id: "credential-cache",
    category: "\u51ED\u636E\u7F13\u5B58\u4E0E SSO cookie",
    pattern: /\\appdata\\local\\microsoft\\windows\\inetcookies(\\|$)|\\appdata\\roaming\\microsoft\\windows\\cookies(\\|$)|\\appdata\\local\\google\\chrome\\user data\\[^\\]+\\network\\cookies$/i,
    reason: "\u4F1A\u8BDD cookie \u53EF\u76F4\u63A5\u590D\u7528\u4E3A\u51ED\u636E\uFF08\u76EE\u5F55\u81EA\u8EAB\u4E0E\u5176\u4E0B\u6240\u6709 cookie \u5E93\uFF09"
  },
  // ── N10：进程/内存转储（T2：`minidump\\` → `minidump(\\|$)`，目录自身）────────
  {
    id: "process-dumps",
    category: "\u8FDB\u7A0B/\u5185\u5B58\u8F6C\u50A8\uFF08\u53EF\u80FD\u542B\u5185\u5B58\u4E2D\u7684\u4EE4\u724C\uFF09",
    pattern: /\.(dmp|mdmp)$|\\windows\\minidump(\\|$)/i,
    reason: "\u8F6C\u50A8\u6587\u4EF6\u53EF\u80FD\u542B\u8FDB\u7A0B\u5185\u5B58\u91CC\u7684\u4EE4\u724C/\u5BC6\u94A5"
  }
];
function envOr(name, fallback) {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}
var USERPROFILE = () => envOr("USERPROFILE", "C:\\Users\\Default");
var APPDATA = () => envOr("APPDATA", join(USERPROFILE(), "AppData", "Roaming"));
var LOCALAPPDATA = () => envOr("LOCALAPPDATA", join(USERPROFILE(), "AppData", "Local"));
var REPO_ROOT = () => envOr("DSH_REPO_ROOT", resolve(dirname(fileURLToPath(import.meta.url)), ".."));
var MASK_PROBES = [
  // 与 src/audit.ts 的 READ_PROBES 对齐（同一批目标）
  { id: "probe-sam-hive", maskClass: "sam", path: "C:\\Windows\\System32\\config\\SAM", label: "\u672C\u5730\u8D26\u6237\u6570\u636E\u5E93 SAM" },
  { id: "probe-ssh-key", maskClass: "ssh", path: join(USERPROFILE(), ".ssh", "id_rsa"), label: "SSH \u79C1\u94A5" },
  { id: "probe-git-credentials", maskClass: "git-credentials", path: join(USERPROFILE(), ".git-credentials"), label: "Git \u660E\u6587\u51ED\u636E" },
  { id: "probe-npmrc", maskClass: "npmrc", path: join(USERPROFILE(), ".npmrc"), label: "npm \u4EE4\u724C" },
  { id: "probe-dsh-home", maskClass: "dsh-home", path: join(USERPROFILE(), ".dsh", "sessions"), label: "DSH \u4E3B\u76EE\u5F55" },
  { id: "probe-stage-store", maskClass: "stage-store", path: join(USERPROFILE(), "ws", ".dshstage", "manifest.json"), label: "\u6C99\u7BB1\u81EA\u8EAB\u5B58\u50A8" },
  { id: "probe-hosts", maskClass: "hosts", path: "C:\\Windows\\System32\\drivers\\etc\\hosts", label: "hosts" },
  { id: "probe-unattend", maskClass: "unattend", path: "C:\\Windows\\Panther\\Unattend.xml", label: "\u65E0\u4EBA\u503C\u5B88\u5E94\u7B54" },
  { id: "probe-dpapi-user", maskClass: "dpapi-user", path: join(APPDATA(), "Microsoft", "Protect", "x"), label: "\u7528\u6237 DPAPI \u4E3B\u5BC6\u94A5" },
  // S3 修复的**专用**探针：目录**本身**（`canonical()` 会去掉结尾分隔符，
  // 因此这条探针才能证明"以 `\\` 收尾的模式命中不到目录自身"这个缺陷已被修掉）。
  // `[实测]` 本机该目录存在且可枚举：`directory(entries=2)`。
  { id: "probe-dpapi-user-dir", maskClass: "dpapi-user", path: join(APPDATA(), "Microsoft", "Protect"), label: "\u7528\u6237 DPAPI \u4E3B\u5BC6\u94A5\u76EE\u5F55\uFF08S3\uFF1A\u76EE\u5F55\u672C\u8EAB\uFF09" },
  { id: "probe-dpapi-machine", maskClass: "dpapi", path: "C:\\Windows\\System32\\Microsoft\\Protect\\S-1-5-18\\x", label: "\u673A\u5668 DPAPI \u4E3B\u5BC6\u94A5" },
  { id: "probe-browser-logins", maskClass: "browser", path: join(LOCALAPPDATA(), "Google", "Chrome", "User Data", "Default", "Login Data"), label: "\u6D4F\u89C8\u5668\u51ED\u636E\u5E93" },
  // ── S5 的四条探针：非 AppData 的浏览器 profile（[实测] 全部可读、mask=(none)）────
  // 仓库根用 `REPO_ROOT` 环境变量或按本模块位置推导（见下方 REPO_ROOT 常量）。
  // 形状对齐真实证据：`.t\dsh2\browser\edge-profile{,-headful}\…`。
  { id: "probe-browser-logins-nonappdata", maskClass: "browser-profile-auth-db", path: join(REPO_ROOT(), ".t", "dsh2", "browser", "edge-profile", "Default", "Login Data"), label: "AppData \u5916\u7684\u6D4F\u89C8\u5668\u51ED\u636E\u5E93 Login Data" },
  { id: "probe-browser-logins-account", maskClass: "browser-profile-auth-db", path: join(REPO_ROOT(), ".t", "dsh2", "browser", "edge-profile", "Default", "Login Data For Account"), label: "AppData \u5916\u7684\u6D4F\u89C8\u5668\u51ED\u636E\u5E93 Login Data For Account" },
  { id: "probe-browser-localstate", maskClass: "browser-profile-state", path: join(REPO_ROOT(), ".t", "dsh2", "browser", "edge-profile", "Local State"), label: "AppData \u5916\u7684\u6D4F\u89C8\u5668 Local State\uFF08\u542B\u52A0\u5BC6\u5BC6\u94A5\uFF09" },
  { id: "probe-browser-localstate-headful", maskClass: "browser-profile-state", path: join(REPO_ROOT(), ".t", "dsh2", "browser", "edge-profile-headful", "Local State"), label: "AppData \u5916\u7684\u6D4F\u89C8\u5668 Local State\uFF08headful profile\uFF09" },
  { id: "probe-aws", maskClass: "aws", path: join(USERPROFILE(), ".aws", "credentials"), label: "AWS \u51ED\u636E" },
  { id: "probe-gcloud", maskClass: "gcloud", path: join(USERPROFILE(), ".config", "gcloud", "credentials.db"), label: "gcloud \u51ED\u636E" },
  { id: "probe-kube", maskClass: "kube", path: join(USERPROFILE(), ".kube", "config"), label: "kubeconfig" },
  { id: "probe-wifi", maskClass: "wifi", path: "C:\\ProgramData\\Microsoft\\WlanSvc\\Profiles.xml", label: "Wi-Fi \u914D\u7F6E" },
  { id: "probe-ntds", maskClass: "sysvol-copy", path: "C:\\Windows\\NTDS\\ntds.dit", label: "AD \u6570\u636E\u5E93" },
  // N1
  { id: "probe-gh-config", maskClass: "cli-cred-dirs", path: join(USERPROFILE(), ".config", "gh", "hosts.yml"), label: "gh CLI \u51ED\u636E" },
  { id: "probe-terraform-credentials", maskClass: "cli-cred-dirs", path: join(USERPROFILE(), ".terraform.d", "credentials.tfrc.json"), label: "Terraform \u51ED\u636E\uFF08CLI \u914D\u7F6E\u6587\u4EF6\uFF09" },
  { id: "probe-aws-config-dir", maskClass: "cli-cred-dirs", path: join(USERPROFILE(), ".config", "aws", "config"), label: "AWS \u5171\u4EAB\u914D\u7F6E\u76EE\u5F55" },
  // N2
  { id: "probe-pypirc", maskClass: "pkg-token-files", path: join(USERPROFILE(), ".pypirc"), label: "PyPI \u4EE4\u724C" },
  { id: "probe-netrc", maskClass: "pkg-token-files", path: join(USERPROFILE(), "_netrc"), label: "netrc \u51ED\u636E" },
  { id: "probe-nuget-config", maskClass: "pkg-token-files", path: join(APPDATA(), "NuGet", "NuGet.Config"), label: "NuGet \u4EE4\u724C" },
  { id: "probe-docker-config", maskClass: "pkg-token-files", path: join(USERPROFILE(), ".docker", "config.json"), label: "Docker \u6CE8\u518C\u8868\u4EE4\u724C" },
  { id: "probe-cargo-credentials", maskClass: "pkg-token-files", path: join(USERPROFILE(), ".cargo", "credentials.toml"), label: "Cargo \u4EE4\u724C" },
  // N3
  { id: "probe-cred-manager", maskClass: "cred-vault", path: join(LOCALAPPDATA(), "Microsoft", "Credentials", "DFBE70A7E5CC19A398EBF1B96859CE5D"), label: "\u51ED\u636E\u7BA1\u7406\u5668\u6587\u4EF6" },
  { id: "probe-vault", maskClass: "cred-vault", path: join(LOCALAPPDATA(), "Microsoft", "Vault", "Vault.dat"), label: "Windows \u4FDD\u7BA1\u5E93" },
  // N4
  { id: "probe-dsh-credentials-file", maskClass: "dsh-credentials", path: join(USERPROFILE(), ".dsh", ".credentials.yaml"), label: "DSH \u51ED\u636E\u6587\u4EF6" },
  { id: "probe-dsh-profile-deps", maskClass: "dsh-profile-deps", path: join(USERPROFILE(), ".dsh", "profiles", "default", "node_modules", "x", "index.js"), label: "DSH profile \u4F9D\u8D56\u6811" },
  // N5
  { id: "probe-autounattend", maskClass: "unattend-family", path: "C:\\Windows\\Panther\\autounattend.xml", label: "autounattend" },
  { id: "probe-sysprep-inf", maskClass: "unattend-family", path: "C:\\Windows\\System32\\Sysprep\\sysprep.inf", label: "sysprep \u5E94\u7B54" },
  // N6
  { id: "probe-networks", maskClass: "net-config-family", path: "C:\\Windows\\System32\\drivers\\etc\\networks", label: "networks \u914D\u7F6E" },
  { id: "probe-evtx", maskClass: "net-config-family", path: "C:\\Windows\\System32\\winevt\\Logs\\Security.evtx", label: "\u5B89\u5168\u4E8B\u4EF6\u65E5\u5FD7" },
  // N7
  { id: "probe-vscode-globalstorage", maskClass: "editor-token-state", path: join(APPDATA(), "Code", "User", "globalStorage", "state.vscdb"), label: "VS Code \u5168\u5C40\u72B6\u6001" },
  // N8
  { id: "probe-pfx", maskClass: "private-key-files", path: join(USERPROFILE(), "certs", "client.pfx"), label: "\u79C1\u94A5\u5BFC\u51FA\u6587\u4EF6\uFF08\u7528\u6237\u76EE\u5F55\uFF09" },
  { id: "probe-pem", maskClass: "private-key-files", path: "C:\\ProgramData\\app\\server.key", label: "\u79C1\u94A5\u5BFC\u51FA\u6587\u4EF6\uFF08ProgramData\uFF09" },
  // N9
  { id: "probe-inetcookies", maskClass: "credential-cache", path: join(LOCALAPPDATA(), "Microsoft", "Windows", "INetCookies", "x.txt"), label: "\u7CFB\u7EDF cookie \u7F13\u5B58" },
  // Chrome 的 cookie 库**预期由更宽的 `browser` 规则先命中**（宽规则优先是设计，不是缺陷）；
  // 这里如实声明它命中的是 browser，从而同时把"browser 规则确实覆盖 Chrome Network\Cookies"钉死。
  { id: "probe-chrome-cookies-via-browser", maskClass: "browser", path: join(LOCALAPPDATA(), "Google", "Chrome", "User Data", "Default", "Network", "Cookies"), label: "Chrome cookie \u5E93\uFF08\u7531 browser \u89C4\u5219\u547D\u4E2D\uFF09" },
  // N10
  { id: "probe-dump", maskClass: "process-dumps", path: join(LOCALAPPDATA(), "CrashDumps", "node.exe.1234.dmp"), label: "\u8FDB\u7A0B\u8F6C\u50A8" },
  { id: "probe-minidump", maskClass: "process-dumps", path: "C:\\Windows\\Minidump\\x.dmp", label: "\u7CFB\u7EDF\u5C0F\u8F6C\u50A8" },
  // 新增（T2：`minidump` **目录自身**，S3 口径）
  { id: "probe-minidump-dir", maskClass: "process-dumps", path: "C:\\Windows\\Minidump", label: "\u7CFB\u7EDF\u5C0F\u8F6C\u50A8\u76EE\u5F55\uFF08\u76EE\u5F55\u81EA\u8EAB\uFF09" },
  // ═══════════════════════════════════════════════════════════════════════════
  // T2 收敛（读取面）：以下每条都是**实测可读/可枚举**的对象，或**目录自身**形态探针。
  // `[实测]` 原始读数见 `tests\paths-masks.ts --probe` 与
  // `docs\T2-敏感读收敛报告.md` 的改前/改后对照表。
  // ═══════════════════════════════════════════════════════════════════════════
  // ── DSH 自身产物（由既有 `dsh-credentials` / `dsh-home` 覆盖；这里逐条钉死）──
  { id: "probe-dsh-settings-imported", maskClass: "dsh-home", path: join(USERPROFILE(), ".dsh", "settings.yaml.imported"), label: "DSH \u5BFC\u5165\u540E\u7684\u8BBE\u7F6E\uFF08[\u5B9E\u6D4B] 197 B \u53EF\u8BFB\uFF09" },
  { id: "probe-dsh-web-url", maskClass: "dsh-home", path: join(USERPROFILE(), ".dsh", "web-url.txt"), label: "DSH Web \u5165\u53E3 URL\uFF08[\u5B9E\u6D4B] 74 B \u53EF\u8BFB\uFF0C\u53EF\u80FD\u542B\u5E26\u4EE4\u724C\u7684 URL\uFF09" },
  { id: "probe-dsh-home-dir", maskClass: "dsh-home", path: join(USERPROFILE(), ".dsh"), label: "DSH \u4E3B\u76EE\u5F55**\u81EA\u8EAB**\uFF08[\u5B9E\u6D4B] 13 \u4E2A\u6761\u76EE\u53EF\u679A\u4E3E\uFF1B\u4FEE\u590D\u524D mask=(none)\uFF09" },
  // ── 注册表配置单元（`sam`）──
  { id: "probe-security-hive", maskClass: "sam", path: "C:\\Windows\\System32\\config\\SECURITY", label: "SECURITY \u914D\u7F6E\u5355\u5143\uFF08[\u5B9E\u6D4B] stat \u5373 EPERM\uFF09" },
  { id: "probe-system-hive", maskClass: "sam", path: "C:\\Windows\\System32\\config\\SYSTEM", label: "SYSTEM \u914D\u7F6E\u5355\u5143\uFF08[\u5B9E\u6D4B] stat \u5373 EPERM\uFF09" },
  { id: "probe-config-dir", maskClass: "sam", path: "C:\\Windows\\System32\\config", label: "config \u76EE\u5F55**\u81EA\u8EAB**\uFF08[\u5B9E\u6D4B] \u4FEE\u590D\u524D mask=(none)\uFF09" },
  { id: "probe-ntuser-dat", maskClass: "sam", path: join(USERPROFILE(), "NTUSER.DAT"), label: "\u7528\u6237\u6CE8\u518C\u8868\u914D\u7F6E\u5355\u5143\uFF08[\u5B9E\u6D4B] 1048576 B\uFF1B\u4FEE\u590D\u524D mask=(none)\uFF09" },
  // 8.3 短名**真实存在**（`C:\Users\Administrator` → `C:\Users\ADMINI~1`）：
  // 这条探针证明"短名写法不能绕过遮蔽"（canonical 解析回长名后仍需命中）。
  { id: "probe-ntuser-dat-shortname", maskClass: "sam", path: "C:\\Users\\ADMINI~1\\NTUSER.DAT", label: "\u7528\u6237\u6CE8\u518C\u8868\u914D\u7F6E\u5355\u5143\uFF088.3 \u77ED\u540D\u5199\u6CD5\uFF0C\u9632\u7ED5\u8FC7\uFF09" },
  { id: "probe-usrclass-dat", maskClass: "sam", path: join(LOCALAPPDATA(), "Microsoft", "Windows", "UsrClass.dat"), label: "\u7528\u6237\u7C7B\u6CE8\u518C\u8868\u914D\u7F6E\u5355\u5143" },
  // ── 终端命令历史（`editor-token-state`；判据是**目录**，改名不绕过）──
  { id: "probe-psreadline-history", maskClass: "editor-token-state", path: join(APPDATA(), "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt"), label: "PSReadLine \u547D\u4EE4\u5386\u53F2\uFF08[\u5B9E\u6D4B] 7950 B \u53EF\u8BFB\uFF1B\u4FEE\u590D\u524D mask=(none)\uFF09" },
  { id: "probe-psreadline-dir", maskClass: "editor-token-state", path: join(APPDATA(), "Microsoft", "Windows", "PowerShell", "PSReadLine"), label: "PSReadLine \u76EE\u5F55**\u81EA\u8EAB**\uFF08\u6539\u540D\u4E0D\u7ED5\u8FC7\uFF1B[\u5B9E\u6D4B] 1 \u4E2A\u6761\u76EE\uFF09" },
  // ── 浏览器 profile 关键库：AppData 形态（`browser` 先命中）+ 非 AppData 形态 ──
  { id: "probe-edge-localstate", maskClass: "browser-profile-state", path: join(LOCALAPPDATA(), "Microsoft", "Edge", "User Data", "Local State"), label: "Edge \u672C\u5730\u72B6\u6001\uFF08[\u5B9E\u6D4B] 33484 B \u53EF\u8BFB\uFF1B\u542B DPAPI \u52A0\u5BC6\u5BC6\u94A5\uFF09" },
  { id: "probe-edge-logins-via-browser", maskClass: "browser", path: join(LOCALAPPDATA(), "Microsoft", "Edge", "User Data", "Default", "Login Data"), label: "Edge \u51ED\u636E\u5E93\uFF08\u7531\u66F4\u5BBD\u7684 browser \u89C4\u5219\u547D\u4E2D\uFF09" },
  { id: "probe-edge-logins-account-via-browser", maskClass: "browser", path: join(LOCALAPPDATA(), "Microsoft", "Edge", "User Data", "Default", "Login Data For Account"), label: "Edge \u8D26\u6237\u51ED\u636E\u5E93\uFF08\u7531 browser \u547D\u4E2D\uFF09" },
  { id: "probe-edge-network-cookies-via-browser", maskClass: "browser", path: join(LOCALAPPDATA(), "Microsoft", "Edge", "User Data", "Default", "Network", "Cookies"), label: "Edge \u4F1A\u8BDD cookie \u5E93\uFF08\u7531 browser \u547D\u4E2D\uFF09" },
  { id: "probe-edge-history", maskClass: "browser-profile-auth-db", path: join(LOCALAPPDATA(), "Microsoft", "Edge", "User Data", "Default", "History"), label: "Edge \u6D4F\u89C8\u5386\u53F2\uFF08[\u5B9E\u6D4B] 491520 B \u53EF\u8BFB\uFF1B\u4FEE\u590D\u524D mask=(none)\uFF09" },
  { id: "probe-edge-history-archived", maskClass: "browser-profile-auth-db", path: join(LOCALAPPDATA(), "Microsoft", "Edge", "User Data", "Default", "Archived History"), label: "Edge \u5F52\u6863\u6D4F\u89C8\u5386\u53F2\uFF08\u540C\u65CF\uFF09" },
  // 非 AppData 形态（S5 的原始证据形状）：Network\Cookies 与 History 修复前 mask=(none)
  { id: "probe-browser-network-cookies-nonappdata", maskClass: "browser-profile-auth-db", path: join(REPO_ROOT(), ".t", "dsh2", "browser", "edge-profile", "Default", "Network", "Cookies"), label: "AppData \u5916 Chromium \u4F1A\u8BDD cookie \u5E93" },
  { id: "probe-browser-history-nonappdata", maskClass: "browser-profile-auth-db", path: join(REPO_ROOT(), ".t", "dsh2", "browser", "chrome-profile", "Default", "History"), label: "AppData \u5916 Chromium \u6D4F\u89C8\u5386\u53F2" },
  // ── 凭据存储的目录形态（`cred-vault`）──
  { id: "probe-cred-manager-dir", maskClass: "cred-vault", path: join(LOCALAPPDATA(), "Microsoft", "Credentials"), label: "\u51ED\u636E\u7BA1\u7406\u5668\u76EE\u5F55**\u81EA\u8EAB**\uFF08[\u5B9E\u6D4B] 3 \u4E2A\u6761\u76EE\u53EF\u679A\u4E3E\uFF09" },
  // `[实测]` 本机**不存在** `*.credentials` 目录 ⇒ 这是**形状探针**（命名类候选），
  // 在 `docs\T2-敏感读收敛报告.md` 里如实标注"不存在的对象不算被挡住"。
  { id: "probe-appdata-credentials-class", maskClass: "cred-vault", path: join(APPDATA(), "acme.credentials", "token.bin"), label: "AppData \u4E0B *.credentials \u547D\u540D\u7C7B\u7684\u51ED\u636E\u76EE\u5F55\uFF08\u5F62\u72B6\u63A2\u9488\uFF1B\u672C\u673A\u4E0D\u5B58\u5728\uFF09" },
  // ── 目录自身形态：DPAPI 机器主密钥 / 沙箱自身存储（S3 口径回归）──
  { id: "probe-dpapi-machine-dir", maskClass: "dpapi", path: "C:\\Windows\\System32\\Microsoft\\Protect", label: "\u673A\u5668 DPAPI \u4E3B\u5BC6\u94A5\u76EE\u5F55**\u81EA\u8EAB**" },
  { id: "probe-stage-store-dir", maskClass: "stage-store", path: join(REPO_ROOT(), ".dshstage"), label: "\u6C99\u7BB1\u81EA\u8EAB\u5B58\u50A8\u76EE\u5F55**\u81EA\u8EAB**\uFF08unmask \u6C38\u4E0D\u89E3\u9664\uFF09" }
];
var SELF_MASK_ID = "stage-store";
function maskKey(anyPath) {
  const c = canonical(anyPath);
  const stripped = c.length > 3 ? c.replace(/[\\/]+$/, "") : c;
  return stripped.replace(/\//g, sep);
}
function maskReason(anyPath, extraMasks = []) {
  const p = maskKey(anyPath);
  for (const rule of extraMasks) {
    if (rule.pattern.test(p)) return { id: rule.id || "custom", reason: rule.reason || "custom mask", hard: rule.hard !== false };
  }
  for (const rule of MASK_CLASSES) {
    if (rule.pattern.test(p)) return { id: rule.id, reason: rule.reason, hard: true };
  }
  return void 0;
}
function maskEntryKind(pattern) {
  if (pattern.source.includes("(\\\\|$)")) return "dir";
  if (pattern.source.endsWith("$")) return "file";
  return "glob";
}
function exportMaskList() {
  return {
    schema: "winstage.mask.v1",
    source: "src/paths.ts",
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    counts: {
      rules: MASK_CLASSES.length,
      probes: MASK_PROBES.length,
      selfMaskId: SELF_MASK_ID
    },
    normalizer: {
      name: "maskKey",
      steps: [
        "canonical(): realpathSync.native \u2014 \u89E3\u6790 symlink/junction\u30018.3 \u77ED\u540D\u3001\\\\?\\ \u957F\u8DEF\u5F84\u524D\u7F00\u3001. \u4E0E ..",
        "strip-trailing-separator\uFF08\u76EE\u5F55\u81EA\u8EAB\u4E0E\u201C\u76EE\u5F55\\\u201D\u5F97\u5230\u540C\u4E00\u4E2A\u952E\uFF09",
        "unify-separator\uFF1A/ \u2192 \\",
        "\u76D8\u7B26\u5927\u5C0F\u5199\u7EDF\u4E00\u7531 lexical() \u5B8C\u6210\uFF1B\u5176\u4F59\u5927\u5C0F\u5199\u7531\u5404\u89C4\u5219\u7684 i \u6807\u5FD7\u8986\u76D6"
      ],
      // 消费方**必须**用同一语义；这里给出一条判据，便于跨语言实现自检
      invariant: 'maskKey(directory) === maskKey(directory + "\\\\")\uFF0C\u4E14\u77ED\u540D/\u957F\u540D\u5199\u6CD5\u5F97\u5230\u540C\u4E00\u4E2A\u952E'
    },
    matchModeDefault: "casefold-regex",
    entries: MASK_CLASSES.map((rule) => ({
      id: rule.id,
      kind: maskEntryKind(rule.pattern),
      pattern: rule.pattern.source,
      flags: rule.pattern.flags,
      matchMode: "casefold",
      category: rule.category,
      reason: rule.reason
    })),
    probes: MASK_PROBES.map((probe) => ({ id: probe.id, path: probe.path, maskClass: probe.maskClass ?? null }))
  };
}
function exportMaskJson(options = {}) {
  return JSON.stringify(exportMaskList(), null, options.pretty === false ? 0 : 2);
}
var runAsMain = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (runAsMain) {
  const argv = process.argv.slice(2);
  const flagIndex = argv.findIndex((value) => value === "--export-mask" || value.startsWith("--export-mask="));
  if (flagIndex === -1) {
    process.stderr.write(
      "usage: node src/paths.ts --export-mask <out.json|->\n       (\u5BFC\u51FA winstage.mask.v1 \u906E\u853D\u6E05\u5355\u4F9B shim \u6D88\u8D39\uFF1B`-` \u8868\u793A\u5199 stdout)\n"
    );
    process.exit(2);
  }
  const inline = argv[flagIndex].startsWith("--export-mask=") ? argv[flagIndex].slice("--export-mask=".length) : void 0;
  const target = inline ?? argv[flagIndex + 1];
  if (target === void 0 || target === "" || target.startsWith("--")) {
    process.stderr.write("paths.ts --export-mask: \u7F3A\u5C11\u8F93\u51FA\u8DEF\u5F84\uFF08\u7528 `-` \u8868\u793A stdout\uFF09\n");
    process.exit(2);
  }
  const payload = `${exportMaskJson()}
`;
  if (target === "-") {
    process.stdout.write(payload);
  } else {
    writeFileSync(target, payload);
    process.stderr.write(`mask export \u2192 ${target}\uFF08${MASK_CLASSES.length} \u6761\u89C4\u5219\uFF09
`);
  }
  process.exit(0);
}

// src/store.ts
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync as existsSync2,
  lstatSync,
  mkdirSync as mkdirSync2,
  readdirSync as readdirSync2,
  readFileSync as readFileSync2,
  renameSync,
  rmSync as rmSync2,
  statSync as statSync2,
  unlinkSync,
  writeFileSync as writeFileSync3
} from "node:fs";
import { basename, dirname as dirname3, isAbsolute as isAbsolute2, join as join4, normalize as normalize3, sep as sep3 } from "node:path";

// src/stage-guard.ts
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join2, normalize as normalize2, resolve as pathResolve, sep as sep2 } from "node:path";
import { tmpdir } from "node:os";
var STAGE_ROOT_LOST = "STAGE_ROOT_LOST";
var STAGE_GUARD_UNAVAILABLE = "STAGE_GUARD_UNAVAILABLE";
var STAGE_MARKER_NAME = ".winstage-owner.json";
var STAGE_SENTINEL_NAME = ".winstage-guard";
var STAGE_RELEASE_NAME = ".winstage-release";
var STAGE_ERROR_NAME = ".winstage-keeper.error";
var STAGE_BASE_NAME = "winstage-stage";
var GUARD_LOG_DIR = ".guard-logs";
var POWERSHELL = process.env.WINSTAGE_POWERSHELL || "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
var LIVE_GUARDS = /* @__PURE__ */ new Map();
var StageRootLostError = class extends Error {
  constructor(reason, detail = {}) {
    super(`the session working directory is no longer available (${reason})`);
    this.name = "StageRootLostError";
    this.code = STAGE_ROOT_LOST;
    this.reason = reason;
    if (detail.root !== void 0) this.root = detail.root;
    if (detail.keeperPid !== void 0) this.keeperPid = detail.keeperPid;
    if (detail.status !== void 0) this.status = detail.status;
  }
};
function guardUnavailableError(reason, detail = {}) {
  const error = new Error(`the protected session directory could not be established (${reason})`);
  error.name = "StageGuardUnavailableError";
  error.code = STAGE_GUARD_UNAVAILABLE;
  error.reason = reason;
  if (detail.root !== void 0) error.root = detail.root;
  return error;
}
function sanitizeKey(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const cleaned = text.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "_").replace(/[. ]+$/, "");
  return cleaned.slice(0, 120) || "";
}
function stageSessionKey({ sessionKey, workspaceRoot, env } = {}) {
  const e = env || process.env;
  const explicit = sanitizeKey(sessionKey);
  if (explicit) return explicit;
  const fromEnv = sanitizeKey(e?.DSH_SESSION_ID || e?.WINSTAGE_SESSION_ID || e?.DSH_SESSION);
  if (fromEnv) return fromEnv;
  if (workspaceRoot) {
    const digest = createHash("sha256").update(normalize2(String(workspaceRoot)).toLowerCase(), "utf8").digest("hex");
    return `ws-${digest.slice(0, 16)}`;
  }
  return "default";
}
function stageBaseDir(env) {
  const e = env || process.env;
  const local = e?.LOCALAPPDATA || e?.LocalAppData;
  return local ? join2(String(local), "Temp", STAGE_BASE_NAME) : join2(tmpdir(), STAGE_BASE_NAME);
}
function resolveStageRoot({ sessionKey, workspaceRoot, env, override } = {}) {
  if (override !== void 0 && override !== null && String(override).trim() !== "") {
    return normalize2(pathResolve(String(override)));
  }
  const fromEnv = (env || process.env)?.WINSTAGE_STAGE_ROOT;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return normalize2(pathResolve(fromEnv));
  const key = stageSessionKey({ sessionKey, workspaceRoot, env });
  return normalize2(join2(stageBaseDir(env), key));
}
var stageMarkerPath = (root) => join2(normalize2(String(root)), STAGE_MARKER_NAME);
var stageSentinelPath = (root) => join2(normalize2(String(root)), STAGE_SENTINEL_NAME);
var stageReleasePath = (root) => join2(normalize2(String(root)), STAGE_RELEASE_NAME);
var stageErrorPath = (root) => join2(normalize2(String(root)), STAGE_ERROR_NAME);
var sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function processAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return void 0;
  }
}
function readTextFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return void 0;
  }
}
function removeTreeRetry(target, attempts = 25, delayMs = 120) {
  for (let i = 0; i < attempts; i += 1) {
    if (!existsSync(target)) return true;
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 2 });
    } catch {
    }
    if (!existsSync(target)) return true;
    sleepSync(delayMs);
  }
  return !existsSync(target);
}
function verifyStageRootAlive(root) {
  const abs = normalize2(String(root));
  if (!existsSync(abs)) return { alive: false, reason: "root-missing", root: abs };
  let info;
  try {
    info = statSync(abs);
  } catch {
    return { alive: false, reason: "root-missing", root: abs };
  }
  if (!info.isDirectory()) return { alive: false, reason: "root-not-directory", root: abs };
  const marker = readJsonFile(stageMarkerPath(abs));
  if (!marker) {
    return { alive: false, reason: existsSync(stageMarkerPath(abs)) ? "marker-invalid" : "marker-missing", root: abs };
  }
  const sentinelPath = typeof marker.sentinel === "string" && marker.sentinel ? marker.sentinel : stageSentinelPath(abs);
  if (!existsSync(sentinelPath)) return { alive: false, reason: "sentinel-missing", root: abs, keeperPid: marker.keeperPid };
  const token = readTextFile(sentinelPath);
  if (token === void 0) return { alive: false, reason: "sentinel-unreadable", root: abs, keeperPid: marker.keeperPid };
  if (String(token) !== String(marker.token)) {
    return { alive: false, reason: "sentinel-tampered", root: abs, keeperPid: marker.keeperPid };
  }
  if (!processAlive(marker.keeperPid)) {
    return { alive: false, reason: "keeper-dead", root: abs, keeperPid: marker.keeperPid };
  }
  return { alive: true, reason: "guarded", root: abs, keeperPid: marker.keeperPid, sentinelPath };
}
var KEEPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root        = @@ROOT@@
$Sentinel    = @@SENTINEL@@
$MarkerPath  = @@MARKER@@
$Ready       = @@READY@@
$ErrorFile   = @@ERRORFILE@@
$ReleaseFile = @@RELEASEFILE@@
$ParentPid   = @@PARENTPID@@
$Token       = @@TOKEN@@
$Version     = @@VERSION@@
$StartedAt   = @@STARTEDAT@@

$hSent = $null
$hDir = $null
$hProc = [System.IntPtr]::Zero
$established = $false
$utf8 = New-Object System.Text.UTF8Encoding($false)

function WriteFileText([string]$path, [string]$text) {
  $dir = [System.IO.Path]::GetDirectoryName($path)
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

try {
  Add-Type -Namespace WinStageGuard -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Unicode, EntryPoint="CreateFileW")]
public static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, System.IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, System.IntPtr hTemplateFile);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern System.IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern uint WaitForSingleObject(System.IntPtr hHandle, uint dwMilliseconds);
'@

  $GENERIC_READ               = [uint32]2147483648
  $FILE_SHARE_READ            = [uint32]1
  $FILE_SHARE_WRITE           = [uint32]2
  $OPEN_EXISTING              = [uint32]3
  $FILE_ATTRIBUTE_NORMAL      = [uint32]128
  $FILE_FLAG_BACKUP_SEMANTICS = [uint32]33554432
  $SYNCHRONIZE                = [uint32]1048576
  $WAIT_OBJECT_0              = [uint32]0
  $WAIT_SLICE                 = [uint32]250

  if (-not (Test-Path -LiteralPath $Root)) { New-Item -ItemType Directory -Force -Path $Root | Out-Null }
  # \u54E8\u5175\u8BA4\u9886\uFF1A\u5185\u5BB9**\u5FC5\u987B**\u7B49\u4E8E\u672C\u5B88\u62A4\u7684 token \u2014\u2014 verifyStageRootAlive \u9010\u5B57\u6BD4\u5BF9\u4E24\u8005\uFF0C\u5BF9\u4E0D\u4E0A\u5C31\u5224
  # sentinel-tampered\u3002\u4E0A\u4E00\u6B21\u8FD0\u884C\u6B8B\u7559\u7684\u54E8\u5175\uFF08\u4E3B\u4EBA\u5DF2\u6B7B\uFF09\u4F1A\u8BA9\u65B0\u5B88\u62A4**\u81EA\u8BC1\u88AB\u7BE1\u6539**\uFF1A\u6839\u660E\u660E\u53EF\u7528\uFF0C
  # \u5374\u4E00\u8DEF\u62A5 STAGE_ROOT_LOST\u3002\u6240\u4EE5\u8FD9\u91CC\uFF1A\u4E0D\u5B58\u5728\u5C31\u5EFA\uFF1B\u5DF2\u5B58\u5728\u5219\u8986\u5199\u8BA4\u9886\u3002
  # \u82E5\u54E8\u5175\u4ECD\u88AB**\u5B58\u6D3B**\u5B88\u62A4\u6301\u6709\uFF08\u5B83\u7528 FILE_SHARE_READ \u6253\u5F00\u3001\u4E0D\u7ED9 WRITE\uFF09\uFF0C\u8986\u5199\u4F1A\u5931\u8D25 \u2014\u2014
  # \u90A3\u65F6\u5982\u5B9E\u629B\u9519\uFF0C\u7EDD\u4E0D\u9759\u9ED8\u63A5\u7BA1\u522B\u4EBA\u7684\u6839\uFF08fail-closed\uFF09\u3002
  if (-not (Test-Path -LiteralPath $Sentinel)) {
    WriteFileText $Sentinel $Token
  } else {
    try { WriteFileText $Sentinel $Token }
    catch { throw ('sentinel-held-by-live-guard:' + $_.Exception.Message) }
  }

  # \u2460 \u54E8\u5175\uFF1AGENERIC_READ + **\u53EA\u7ED9 FILE_SHARE_READ**\uFF08\u4E0D\u7ED9 WRITE / DELETE\uFF09
  $hSent = [WinStageGuard.Native]::CreateFileW($Sentinel, $GENERIC_READ, $FILE_SHARE_READ, [System.IntPtr]::Zero, $OPEN_EXISTING, $FILE_ATTRIBUTE_NORMAL, [System.IntPtr]::Zero)
  if ($hSent.IsInvalid) { throw ('sentinel-open-failed:' + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()) }

  # \u2461 \u6839\u76EE\u5F55\uFF1AGENERIC_READ + FILE_SHARE_READ|FILE_SHARE_WRITE\uFF08**\u4E0D\u7ED9 FILE_SHARE_DELETE**\uFF09
  $hDir = [WinStageGuard.Native]::CreateFileW($Root, $GENERIC_READ, ($FILE_SHARE_READ -bor $FILE_SHARE_WRITE), [System.IntPtr]::Zero, $OPEN_EXISTING, $FILE_FLAG_BACKUP_SEMANTICS, [System.IntPtr]::Zero)
  if ($hDir.IsInvalid) { throw ('root-open-failed:' + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()) }

  # \u2462 \u7B49\u7236\u8FDB\u7A0B\u6B7B\uFF08\u62FF\u4E0D\u5230\u53E5\u67C4\u5C31\u9000\u5316\u6210\u8F6E\u8BE2\uFF0C\u7EDD\u4E0D\u56E0\u6B64\u63D0\u524D\u6E05\u7406\uFF09
  $hProc = [WinStageGuard.Native]::OpenProcess($SYNCHRONIZE, $false, $ParentPid)

  # \u26A0 PowerShell \u53D8\u91CF\u540D**\u4E0D\u533A\u5206\u5927\u5C0F\u5199**\uFF1A$Marker \u4E0E $marker \u662F\u540C\u4E00\u4E2A\u53D8\u91CF\u3002
  # \u8FD9\u91CC\u56E0\u6B64\u628A"\u8DEF\u5F84"\u548C"JSON \u6587\u672C"\u53D6\u6210\u4E24\u4E2A\u4E0D\u4F1A\u4E92\u76F8\u8E29\u7684\u540D\u5B57\uFF08$MarkerPath / $markerJson\uFF09\u2014\u2014
  # \u66FE\u7ECF\u5199\u6210 $Marker + $marker\uFF0C\u4E8E\u662F\u8DEF\u5F84\u88AB JSON \u6587\u672C\u8986\u76D6\uFF0C
  # GetDirectoryName \u62FF\u5230 JSON \u76F4\u63A5\u629B "Illegal characters in path."\uFF08\u5DF2\u7531 wp0dbg4 \u5B9A\u4F4D\uFF09\u3002
  # \u672C\u6BB5\u811A\u672C**\u4E0D\u5141\u8BB8\u51FA\u73B0\u53CD\u5F15\u53F7**\uFF1A\u5B83\u4F1A\u6495\u88C2 JS \u6A21\u677F\u4E32\uFF0C\u4E5F\u4F1A\u8BA9 PS \u8F6C\u4E49\u8DE8\u5C42\u5931\u771F\u3002
  $markerJson = '{"version":' + $Version + ',"keeperPid":' + $PID + ',"parentPid":' + $ParentPid + ',"root":' + (ConvertTo-Json $Root -Compress) + ',"sentinel":' + (ConvertTo-Json $Sentinel -Compress) + ',"token":' + (ConvertTo-Json $Token -Compress) + ',"startedAt":' + (ConvertTo-Json $StartedAt -Compress) + ',"sentinelHandle":"' + $hSent.DangerousGetHandle().ToString() + '","dirHandle":"' + $hDir.DangerousGetHandle().ToString() + '"}'
  WriteFileText $MarkerPath $markerJson
  $established = $true
  WriteFileText $Ready 'ready'

  while ($true) {
    if ($hProc -ne [System.IntPtr]::Zero) {
      $w = [WinStageGuard.Native]::WaitForSingleObject($hProc, $WAIT_SLICE)
      if ($w -eq $WAIT_OBJECT_0) { break }
    } else {
      Start-Sleep -Milliseconds 250
      $p = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
      if ($null -eq $p) { break }
    }
    if (Test-Path -LiteralPath $ReleaseFile) { break }
  }
} catch {
  try { WriteFileText $ErrorFile ($_ | Out-String) } catch { }
} finally {
  try { if ($hSent -ne $null) { $hSent.Dispose() } } catch { }
  try { if ($hDir -ne $null) { $hDir.Dispose() } } catch { }
  if ($established) {
    for ($i = 0; $i -lt 60; $i++) {
      try {
        if (-not (Test-Path -LiteralPath $Root)) { break }
        Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction Stop
        break
      } catch { Start-Sleep -Milliseconds 120 }
    }
  }
}
`;
var psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
var KEEPER_VERSION = 1;
function keeperScript({ root, sentinel, marker, ready, errorFile, releaseFile, parentPid, token }) {
  return KEEPER_SCRIPT.replace("@@ROOT@@", psQuote(root)).replace("@@SENTINEL@@", psQuote(sentinel)).replace("@@MARKER@@", psQuote(marker)).replace("@@READY@@", psQuote(ready)).replace("@@ERRORFILE@@", psQuote(errorFile)).replace("@@RELEASEFILE@@", psQuote(releaseFile)).replace("@@PARENTPID@@", String(Number(parentPid))).replace("@@TOKEN@@", psQuote(token)).replace("@@VERSION@@", String(KEEPER_VERSION)).replace("@@STARTEDAT@@", psQuote((/* @__PURE__ */ new Date()).toISOString()));
}
function acquireInProcessGuard(root) {
  mkdirSync(root, { recursive: true });
  const token = randomUUID();
  const sentinel = stageSentinelPath(root);
  try {
    writeFileSync2(sentinel, token);
  } catch (error) {
    throw new Error(`stage sentinel is held by a live guard: ${sentinel} (${error.code ?? error.message})`);
  }
  const marker = {
    version: KEEPER_VERSION,
    keeperPid: process.pid,
    parentPid: process.pid,
    root,
    sentinel,
    token,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    inProcess: true
  };
  writeFileSync2(stageMarkerPath(root), JSON.stringify(marker, null, 2));
  return makeGuard({ root, sentinelPath: sentinel, keeperPid: process.pid, token, inProcess: true });
}
function makeGuard({ root, sentinelPath, keeperPid, token, inProcess }) {
  const state = { released: false };
  const guard = {
    root,
    sentinelPath,
    keeperPid,
    markerPath: stageMarkerPath(root),
    token,
    inProcess: Boolean(inProcess),
    status() {
      return verifyStageRootAlive(root);
    },
    assertAlive() {
      if (state.released) {
        throw new StageRootLostError("guard-released", { root, keeperPid });
      }
      const status = verifyStageRootAlive(root);
      if (!status.alive) {
        throw new StageRootLostError(status.reason, { root, keeperPid: status.keeperPid ?? keeperPid, status });
      }
      return status;
    },
    release(options = {}) {
      if (state.released) return { root, removed: !existsSync(root), alreadyReleased: true };
      state.released = true;
      LIVE_GUARDS.delete(root);
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 2e4;
      if (inProcess) {
        const removed2 = removeTreeRetry(root, 20, 100);
        return { root, removed: removed2, leftover: existsSync(root) };
      }
      try {
        if (existsSync(root)) writeFileSync2(stageReleasePath(root), "release\n");
      } catch {
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!processAlive(keeperPid) || !existsSync(root)) break;
        sleepSync(60);
      }
      const removed = removeTreeRetry(root, 3, 60);
      return { root, removed, keeperAlive: processAlive(keeperPid) };
    }
  };
  return guard;
}
function acquireStageGuard(root, options = {}) {
  const abs = normalize2(String(root));
  const existing = LIVE_GUARDS.get(abs);
  if (existing) {
    existing.assertAlive();
    return existing;
  }
  const allowInProcess = options.allowInProcess === true;
  if (process.platform !== "win32") {
    if (!allowInProcess) throw guardUnavailableError("unsupported-platform", { root: abs });
    const guard2 = acquireInProcessGuard(abs);
    LIVE_GUARDS.set(abs, guard2);
    return guard2;
  }
  try {
    mkdirSync(abs, { recursive: true });
  } catch (error) {
    throw guardUnavailableError(`root-not-creatable:${error?.code || "ERR"}`, { root: abs });
  }
  const sentinel = stageSentinelPath(abs);
  const markerPath = stageMarkerPath(abs);
  const readyPath = join2(abs, `.winstage-keeper.ready`);
  const errorPath = stageErrorPath(abs);
  const releasePath = stageReleasePath(abs);
  const token = randomUUID();
  const parentPid = Number(options.parentPid) || process.pid;
  for (const stale of [readyPath, errorPath, releasePath]) {
    try {
      if (existsSync(stale)) rmSync(stale, { force: true });
    } catch {
    }
  }
  const script = keeperScript({
    root: abs,
    sentinel,
    marker: markerPath,
    ready: readyPath,
    errorFile: errorPath,
    releaseFile: releasePath,
    parentPid,
    token
  });
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const logDir = options.logDir ? String(options.logDir) : join2(dirname2(abs), GUARD_LOG_DIR);
  let logFd;
  try {
    mkdirSync(logDir, { recursive: true });
    logFd = openSync(join2(logDir, `${abs.slice(abs.lastIndexOf(sep2) + 1)}-${Date.now()}.log`), "a");
  } catch {
    logFd = void 0;
  }
  let child;
  try {
    child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      stdio: logFd === void 0 ? "ignore" : ["ignore", logFd, logFd],
      windowsHide: true
    });
  } catch (error) {
    if (logFd !== void 0) {
      try {
        closeSync(logFd);
      } catch {
      }
    }
    throw guardUnavailableError("spawn-failed", { root: abs });
  }
  if (logFd !== void 0) {
    try {
      closeSync(logFd);
    } catch {
    }
  }
  child.unref();
  const deadline = Date.now() + (Number.isFinite(options.readyTimeoutMs) ? options.readyTimeoutMs : 2e4);
  let ready = false;
  while (Date.now() < deadline) {
    if (existsSync(readyPath) && readJsonFile(markerPath)) {
      ready = true;
      break;
    }
    if (existsSync(errorPath)) break;
    if (child.exitCode !== null) break;
    sleepSync(50);
  }
  if (!ready) {
    const detail = readTextFile(errorPath) || readTextFile(readyPath) || (child.exitCode !== null ? `keeper-exit-${child.exitCode}` : "keeper-timeout");
    try {
      child.kill();
    } catch {
    }
    removeTreeRetry(abs, 5, 100);
    throw guardUnavailableError(String(detail).split(/\r?\n/)[0].slice(0, 120) || "keeper-failed", { root: abs });
  }
  const marker = readJsonFile(markerPath) || {};
  const guard = makeGuard({ root: abs, sentinelPath: sentinel, keeperPid: marker.keeperPid ?? child.pid, token });
  LIVE_GUARDS.set(abs, guard);
  return guard;
}
var FORBIDDEN_MODEL_TEXT = Object.freeze(["\u6C99\u7BB1", "\u6682\u5B58", "\u66FF\u4EE3\u8DEF\u5F84", "sandbox", "staging", "stage", "shadow"]);
function checkTransparentMessages(texts = []) {
  const violations = [];
  for (const text of texts) {
    const lower = String(text).toLowerCase();
    for (const word of FORBIDDEN_MODEL_TEXT) {
      if (lower.includes(word.toLowerCase())) violations.push({ text: String(text), word });
    }
  }
  return { ok: violations.length === 0, violations };
}

// src/limits.ts
import { lstatSync as nodeLstatSync, readdirSync as nodeReaddirSync, realpathSync as nodeRealpathSync } from "node:fs";
import { join as join3 } from "node:path";
var UPSTREAM_STAGING_BYTES = 64 * 1024 ** 3;
var STAGING_BYTES_SOURCE = {
  marker: "[\u5B98\u65B9]",
  project: "NeoAI",
  file: "lua/NeoAI/default_config.lua",
  line: "disk_bytes = 64 * 1024 * 1024 * 1024, -- 64 GiB",
  reference: "docs/NeoAI-\u6C99\u7BB1\u80FD\u529B\u5206\u6790\u4E0E\u5DEE\u8DDD\u8F93\u5165.md \xA75.2 \u7B2C 13 \u6761"
};
var OUTPUT_CAP_SOURCE = {
  marker: "[\u63A8\u65AD]",
  reason: "\u4E0A\u6E38\u65E0\u8F93\u51FA\u4E0A\u9650\u5BF9\u6807\u9879\uFF1B4 MiB / 200000 \u884C\u4E3A\u672C\u9879\u76EE\u53D6\u503C\uFF0C\u53EF\u5728\u6784\u9020\u65F6\u8986\u76D6"
};
var DEFAULT_LIMITS = Object.freeze({
  stagingBytes: UPSTREAM_STAGING_BYTES,
  maxOutputBytes: 4 * 1024 * 1024,
  maxOutputLines: 2e5
});
var LIMIT_KEYS = Object.freeze(["stagingBytes", "maxOutputBytes", "maxOutputLines"]);
var FILE_ATTRIBUTE_REPARSE_POINT = 1024;
var MAX_TREE_ENTRIES = 2e5;
var MAX_INODE_TRACK = 5e5;
var FORMAT_SIZE_MAX = 999 * 1024 ** 4;
var HOOK_VALUES = { followReparsePoints: false, disableHardlinkDedupe: false };
var LimitsError = class extends Error {
  constructor(message, code = "LIMITS_INVALID", details = void 0) {
    super(message);
    this.name = "LimitsError";
    this.code = code;
    if (details !== void 0) this.details = details;
  }
};
var clip = (value) => {
  const text = String(value);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
};
var SIZE_UNITS = /* @__PURE__ */ new Map([
  ["B", 1],
  ["K", 1024],
  ["KI", 1024],
  ["KB", 1e3],
  ["KIB", 1024],
  ["M", 1024 ** 2],
  ["MI", 1024 ** 2],
  ["MB", 1e3 ** 2],
  ["MIB", 1024 ** 2],
  ["G", 1024 ** 3],
  ["GI", 1024 ** 3],
  ["GB", 1e3 ** 3],
  ["GIB", 1024 ** 3],
  ["T", 1024 ** 4],
  ["TI", 1024 ** 4],
  ["TB", 1e3 ** 4],
  ["TIB", 1024 ** 4]
]);
function assertByteCount(value, label, code) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new LimitsError(`${label} \u5FC5\u987B\u662F\u6570\u5B57\uFF0C\u6536\u5230 ${clip(value)}\uFF08\u7C7B\u578B ${typeof value}\uFF09`, code, { value });
  }
  if (!Number.isFinite(value)) {
    throw new LimitsError(`${label} \u5FC5\u987B\u662F\u6709\u9650\u6570\u5B57\uFF0C\u6536\u5230 ${clip(value)}`, code, { value });
  }
  if (!Number.isInteger(value)) {
    throw new LimitsError(`${label} \u5FC5\u987B\u662F\u6574\u6570\uFF08\u5B57\u8282\uFF09\uFF0C\u6536\u5230 ${clip(value)}`, code, { value });
  }
  if (value < 0) {
    throw new LimitsError(`${label} \u4E0D\u80FD\u4E3A\u8D1F\uFF0C\u6536\u5230 ${clip(value)}`, code, { value });
  }
  if (!Number.isSafeInteger(value)) {
    throw new LimitsError(`${label} \u8D85\u51FA\u5B89\u5168\u6574\u6570\u8303\u56F4\uFF08\u4F1A\u9759\u9ED8\u4E22\u7CBE\u5EA6\uFF09\uFF0C\u6536\u5230 ${clip(value)}`, code, { value });
  }
  return value;
}
function parseSize(text) {
  if (typeof text === "number") return assertByteCount(text, "parseSize(number)", "SIZE_PARSE_INVALID");
  if (text !== null && typeof text === "object") {
    if ("bytes" in text) return parseSize(text.bytes);
    throw new LimitsError(`parseSize \u6536\u5230\u4E0D\u652F\u6301\u7684\u5BF9\u8C61\uFF08\u7F3A bytes \u5B57\u6BB5\uFF09\uFF1A${clip(JSON.stringify(text))}`, "SIZE_PARSE_INVALID", { text });
  }
  if (typeof text !== "string") {
    throw new LimitsError(`parseSize \u9700\u8981\u5B57\u7B26\u4E32\u6216\u6570\u5B57\uFF0C\u6536\u5230 ${clip(text)}\uFF08\u7C7B\u578B ${typeof text}\uFF09`, "SIZE_PARSE_INVALID", { text });
  }
  const raw = text.trim();
  if (raw.length === 0) {
    throw new LimitsError("parseSize \u6536\u5230\u7A7A\u5B57\u7B26\u4E32", "SIZE_PARSE_INVALID", { text });
  }
  const cleaned = raw.replace(/_/g, "");
  const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))\s*([a-z]*)$/i.exec(cleaned);
  if (!match) {
    throw new LimitsError(`parseSize \u65E0\u6CD5\u89E3\u6790\uFF1A${clip(text)}\uFF08\u5F62\u72B6\u5E94\u4E3A <\u6570\u5B57><\u5355\u4F4D?>\uFF0C\u5982 64GiB / 512MiB / 1024\uFF09`, "SIZE_PARSE_INVALID", { text });
  }
  const [, numberText, unitText] = match;
  const suffix = unitText.toUpperCase();
  const unit = suffix.length === 0 ? 1 : SIZE_UNITS.get(suffix);
  if (unit === void 0) {
    throw new LimitsError(
      `parseSize \u4E0D\u8BA4\u8BC6\u7684\u5355\u4F4D "${clip(unitText)}"\uFF08\u652F\u6301 B/KB/MB/GB/TB\u3001KiB/MiB/GiB/TiB\uFF0C\u4EE5\u53CA KB \u7684\u7B80\u5199 K/M/G/T \u4E0E KiB \u7684\u7B80\u5199 Ki/Mi/Gi/Ti\uFF1B\u65E0\u540E\u7F00=\u5B57\u8282\uFF09`,
      "SIZE_PARSE_INVALID",
      { text, unit: unitText }
    );
  }
  const magnitude = Number(numberText);
  if (!Number.isFinite(magnitude)) {
    throw new LimitsError(`parseSize \u6570\u5B57\u90E8\u5206\u975E\u6CD5\uFF1A${clip(text)}`, "SIZE_PARSE_INVALID", { text });
  }
  if (magnitude < 0) {
    throw new LimitsError(`parseSize \u4E0D\u63A5\u53D7\u8D1F\u6570\uFF1A${clip(text)}`, "SIZE_PARSE_INVALID", { text });
  }
  const bytes = magnitude * unit;
  if (!Number.isFinite(bytes)) {
    throw new LimitsError(`parseSize \u7ED3\u679C\u6EA2\u51FA\uFF1A${clip(text)}`, "SIZE_PARSE_INVALID", { text });
  }
  if (!Number.isInteger(bytes)) {
    throw new LimitsError(
      `parseSize \u7ED3\u679C\u662F\u5C0F\u6570\uFF08${clip(text)} = ${bytes} \u5B57\u8282\uFF09\uFF1A\u4E0A\u9650\u5FC5\u987B\u662F\u6574\u6570\u5B57\u8282\uFF0C\u907F\u514D\u534A\u5B57\u8282\u8FDB\u5165\u914D\u989D\u8FD0\u7B97`,
      "SIZE_PARSE_INVALID",
      { text, bytes }
    );
  }
  return assertByteCount(bytes, `parseSize("${clip(text)}")`, "SIZE_PARSE_INVALID");
}
function toGiB(bytes) {
  return assertByteCount(bytes, "toGiB(bytes)", "LIMITS_INVALID") / 1024 ** 3;
}
function isReparsePoint(info) {
  if (!info || typeof info !== "object") return false;
  try {
    if (typeof info.isSymbolicLink === "function" && info.isSymbolicLink()) return true;
  } catch {
    return true;
  }
  return (info.mode & FILE_ATTRIBUTE_REPARSE_POINT) === FILE_ATTRIBUTE_REPARSE_POINT;
}
function isReparseEntry(info) {
  if (HOOK_VALUES.followReparsePoints) return false;
  return isReparsePoint(info);
}
function reparsePointKind(info) {
  if (!isReparsePoint(info)) return void 0;
  if (info.isSymbolicLink && info.isSymbolicLink()) return "symlink";
  if (info.isDirectory && info.isDirectory()) return "reparse-directory";
  if (info.isFile && info.isFile()) return "reparse-file";
  return "reparse";
}
function errorRecord(path, error) {
  return {
    path,
    code: error && error.code ? String(error.code) : "ERR_UNKNOWN",
    message: error && error.message ? String(error.message) : String(error)
  };
}
function measureTree(root, options = {}) {
  if (typeof root !== "string" || root.trim().length === 0) {
    throw new LimitsError(`measureTree \u9700\u8981\u975E\u7A7A\u8DEF\u5F84\u5B57\u7B26\u4E32\uFF0C\u6536\u5230 ${clip(root)}`, "MEASURE_TREE_INVALID", { root });
  }
  const {
    guard,
    // 可选：调用方注入自己的"该不该跟随"判据（任务签名允许）；返回 true = 是重解析点
    maxEntries = MAX_TREE_ENTRIES,
    fsImpl,
    onStat
  } = options;
  if (guard !== void 0 && typeof guard !== "function") {
    throw new LimitsError(`measureTree \u7684 guard \u5FC5\u987B\u662F\u51FD\u6570\uFF0C\u6536\u5230 ${typeof guard}`, "MEASURE_TREE_INVALID", { guard: typeof guard });
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new LimitsError(`measureTree \u7684 maxEntries \u5FC5\u987B \u22651 \u7684\u6B63\u6574\u6570\uFF0C\u6536\u5230 ${clip(maxEntries)}`, "MEASURE_TREE_INVALID", { maxEntries });
  }
  if (onStat !== void 0 && typeof onStat !== "function") {
    throw new LimitsError(`measureTree \u7684 onStat \u5FC5\u987B\u662F\u51FD\u6570\uFF0C\u6536\u5230 ${typeof onStat}`, "MEASURE_TREE_INVALID", { onStat: typeof onStat });
  }
  const fs = {
    lstatSync: fsImpl && fsImpl.lstatSync || nodeLstatSync,
    readdirSync: fsImpl && fsImpl.readdirSync || nodeReaddirSync,
    // ⚠ 必须用 **`.native`**：`[实测]` 本机 node v24.21.0，
    //   `fs.realpathSync(<tree>\junc)` 返回的是 **junction 自身**（还带 8.3 短名
    //   `...\ADMINI~1\...`），**不解析到目标**；而 `fs.realpathSync.native(<tree>\junc)`
    //   返回目标的**长名**真实路径 ⇒ 逃逸闭合校验只能建立在 `.native` 上。
    //   （这与 `src\paths.ts::canonical()` 的选择一致：那里用的也是 `realpathSync.native`，
    //     理由写在它的文件头：JS 层解析不了 junction。）
    realpathSync: fsImpl && fsImpl.realpathSync || nodeRealpathSync.native || nodeRealpathSync
  };
  const report = { bytes: 0, files: 0, dirs: 0, entries: 0, skipped: [], errors: [], notes: [], truncated: false };
  const seenInodes = /* @__PURE__ */ new Set();
  let dedupeDisabled = false;
  const shouldSkip = (info, path) => {
    if (guard) {
      try {
        return guard(info, path) === true;
      } catch {
        return true;
      }
    }
    return isReparseEntry(info);
  };
  let rootInfo;
  try {
    rootInfo = fs.lstatSync(root);
  } catch (error) {
    report.errors.push(errorRecord(root, error));
    return report;
  }
  if (onStat) {
    try {
      onStat(rootInfo, root, report.entries);
    } catch (error) {
      report.errors.push(errorRecord(root, error));
    }
  }
  report.entries += 1;
  if (shouldSkip(rootInfo, root)) {
    report.skipped.push({ path: root, kind: "root", reason: "root-is-reparse-point" });
    report.truncated = report.entries >= maxEntries;
    return report;
  }
  if (!rootInfo.isDirectory()) {
    if (rootInfo.isFile()) {
      report.files += 1;
      report.bytes += rootInfo.size;
    }
    return report;
  }
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = root;
  }
  report.dirs += 1;
  const visitedDirs = /* @__PURE__ */ new Set();
  const dirKey = (value) => String(value).toLowerCase().replace(/[\\/]+$/, "");
  visitedDirs.add(dirKey(realRoot));
  const resolvedTargetIsDirectory = (target) => {
    if (typeof target !== "string" || target.length === 0) return false;
    try {
      return fs.lstatSync(target).isDirectory() === true;
    } catch (error) {
      report.errors.push(errorRecord(target, error));
      return false;
    }
  };
  const stack = [{ path: root, parent: root }];
  let hitBound = false;
  scan: while (stack.length > 0) {
    if (report.entries >= maxEntries) {
      hitBound = true;
      break scan;
    }
    const frame = stack.pop();
    const current = frame.path;
    let dirents;
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      report.errors.push(errorRecord(current, error));
      continue;
    }
    dirents = [...dirents].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const dirent of dirents) {
      if (report.entries >= maxEntries) {
        hitBound = true;
        break scan;
      }
      const full = join3(current, dirent.name);
      const index = report.entries;
      report.entries += 1;
      let kind;
      try {
        if (typeof dirent.isSymbolicLink === "function" && dirent.isSymbolicLink()) kind = "symlink";
      } catch {
        kind = "dirent-error";
      }
      let info;
      let statOk = false;
      try {
        info = fs.lstatSync(full);
        statOk = true;
      } catch (error) {
        report.errors.push(errorRecord(full, error));
      }
      if (statOk && onStat) {
        try {
          onStat(info, full, index);
        } catch (error) {
          report.errors.push(errorRecord(full, error));
        }
      }
      if (!statOk) {
        if (report.entries >= maxEntries) break;
        continue;
      }
      const guardSaysLink = shouldSkip(info, full);
      if (kind === void 0 && guardSaysLink) kind = reparsePointKind(info) || "other";
      if (kind !== void 0 || !info.isFile()) {
        let resolved = full;
        try {
          resolved = fs.realpathSync(full);
        } catch {
          resolved = full;
        }
        const escaped = !HOOK_VALUES.followReparsePoints && !isWithin(realRoot, resolved);
        const shouldNotFollow = escaped || Boolean(guard) && guardSaysLink;
        if (shouldNotFollow) {
          report.skipped.push({
            path: full,
            kind: kind === void 0 ? escaped ? "realpath-escape" : "guard-says-link" : `${kind}${escaped ? "+realpath-escape" : ""}`,
            reason: escaped ? resolved === full ? "realpath-outside-tree" : `realpath-outside-tree:${resolved}` : "guard-reparse-point-not-followed"
          });
        } else {
          const targetIsDirectory = info.isDirectory() || resolvedTargetIsDirectory(resolved);
          if (targetIsDirectory) {
            const key = dirKey(resolved);
            if (visitedDirs.has(key)) {
              report.skipped.push({
                path: full,
                kind: kind === void 0 ? "directory-cycle" : `${kind}+cycle`,
                reason: "already-visited-cycle"
              });
              report.notes.push({ path: full, kind: "cycle-skipped", target: resolved });
            } else {
              visitedDirs.add(key);
              report.dirs += 1;
              stack.push({ path: resolved === full ? full : resolved, parent: full });
            }
          } else if (kind !== void 0) {
            report.skipped.push({ path: full, kind, reason: "reparse-point-not-followed" });
          }
        }
      } else {
        const key = typeof info.ino === "number" && info.ino !== 0 ? `${info.dev}:${info.ino}` : void 0;
        if (key !== void 0 && !dedupeDisabled && !HOOK_VALUES.disableHardlinkDedupe) {
          if (seenInodes.has(key)) {
            report.files += 1;
            report.notes.push({ path: full, kind: "hardlink-dedup", inode: key });
          } else {
            if (seenInodes.size >= MAX_INODE_TRACK) {
              dedupeDisabled = true;
              report.notes.push({
                path: full,
                kind: "inode-table-full",
                message: `inode \u53BB\u91CD\u8868\u8FBE\u5230\u4E0A\u9650 ${MAX_INODE_TRACK}\uFF0C\u540E\u7EED\u786C\u94FE\u63A5\u53EF\u80FD\u88AB\u91CD\u590D\u8BA1\u6570\uFF08\u4FDD\u5B88\u65B9\u5411\uFF09`
              });
              report.files += 1;
              report.bytes += info.size;
            } else {
              seenInodes.add(key);
              report.files += 1;
              report.bytes += info.size;
            }
          }
        } else {
          report.files += 1;
          report.bytes += info.size;
        }
      }
    }
  }
  if (hitBound) {
    report.truncated = true;
    report.errors.push({
      path: stack.length > 0 ? stack[stack.length - 1].path : root,
      code: "MEASURE_TREE_BOUND",
      message: `\u904D\u5386\u8FBE\u5230\u4E0A\u9650 maxEntries=${maxEntries}\uFF0C\u63D0\u524D\u7ED3\u675F\uFF1Abytes \u662F\u4E0B\u754C\uFF0C\u4E0D\u662F\u5B8C\u6574\u8D26`
    });
  }
  report.realRoot = realRoot;
  return report;
}
function isWithin(parentReal, childReal) {
  if (typeof parentReal !== "string" || typeof childReal !== "string") return false;
  const p = parentReal.toLowerCase().replace(/[\\/]+$/, "");
  const c = childReal.toLowerCase();
  return c === p || c.startsWith(`${p}\\`) || c.startsWith(`${p}/`);
}
function checkStagingQuota(options = {}) {
  if (options === null || typeof options !== "object") {
    throw new LimitsError(`checkStagingQuota \u9700\u8981\u9009\u9879\u5BF9\u8C61\uFF0C\u6536\u5230 ${clip(options)}`, "LIMITS_INVALID", { options });
  }
  const {
    root,
    quotaBytes = DEFAULT_LIMITS.stagingBytes,
    incomingBytes = 0,
    reservedBytes = 0,
    usedBytes: explicitUsed,
    measure = measureTree
  } = options;
  const quota = assertByteCount(quotaBytes, "checkStagingQuota.quotaBytes", "LIMITS_INVALID");
  const incoming = assertByteCount(incomingBytes, "checkStagingQuota.incomingBytes", "LIMITS_INVALID");
  const reserved = assertByteCount(reservedBytes, "checkStagingQuota.reservedBytes", "LIMITS_INVALID");
  let used;
  let measured;
  if (explicitUsed !== void 0) {
    used = assertByteCount(explicitUsed, "checkStagingQuota.usedBytes", "LIMITS_INVALID");
  } else {
    if (typeof root !== "string" || root.trim().length === 0) {
      throw new LimitsError(
        "checkStagingQuota \u9700\u8981 root\uFF08\u6682\u5B58\u6811\u8DEF\u5F84\uFF09\u6216\u663E\u5F0F usedBytes \u2014\u2014 \u4E24\u8005\u90FD\u6CA1\u6709\u5C31\u65E0\u6CD5\u5224\u5B9A\uFF0C\u62D2\u7EDD\u731C\u6D4B",
        "LIMITS_INVALID",
        { root }
      );
    }
    if (typeof measure !== "function") {
      throw new LimitsError(`checkStagingQuota.measure \u5FC5\u987B\u662F\u51FD\u6570\uFF0C\u6536\u5230 ${typeof measure}`, "LIMITS_INVALID", { measure: typeof measure });
    }
    measured = measure(root, options.measureOptions || {});
    if (!measured || typeof measured.bytes !== "number") {
      throw new LimitsError("checkStagingQuota: \u7EDF\u8BA1\u5B9E\u73B0\u6CA1\u6709\u8FD4\u56DE { bytes }\uFF0C\u65E0\u6CD5\u5224\u5B9A\uFF08fail-closed\uFF09", "LIMITS_INVALID", { measured });
    }
    used = assertByteCount(measured.bytes, "checkStagingQuota(\u7EDF\u8BA1\u5F97\u5230\u7684 usedBytes)", "LIMITS_INVALID");
  }
  const wouldBe = used + incoming + reserved;
  if (!Number.isSafeInteger(wouldBe)) {
    throw new LimitsError(`checkStagingQuota: used+incoming+reserved \u6EA2\u51FA\u5B89\u5168\u6574\u6570\uFF08${used}+${incoming}+${reserved}\uFF09`, "LIMITS_INVALID");
  }
  const allowed = wouldBe <= quota;
  const remaining = quota - used;
  const headroom = quota - wouldBe;
  const reason = allowed ? headroom === 0 ? `\u6070\u597D\u7528\u6EE1\u914D\u989D\uFF1Aused=${used} + incoming=${incoming} + reserved=${reserved} == quota=${quota}\uFF08\u96F6\u4F59\u91CF\u653E\u884C\uFF09` : `\u914D\u989D\u5185\uFF1AwouldBe=${wouldBe} <= quota=${quota}\uFF08\u4F59\u91CF ${headroom} \u5B57\u8282\uFF09` : `\u8D85\u51FA\u914D\u989D\uFF1Aused=${used} + incoming=${incoming} + reserved=${reserved} = ${wouldBe} > quota=${quota}\uFF08\u8D85\u51FA ${-headroom} \u5B57\u8282\uFF09`;
  const result = {
    allowed,
    usedBytes: used,
    incomingBytes: incoming,
    reservedBytes: reserved,
    quotaBytes: quota,
    remainingBytes: remaining,
    wouldBeBytes: wouldBe,
    headroomBytes: headroom,
    reason
  };
  if (measured) {
    result.measure = {
      bytes: measured.bytes,
      files: measured.files,
      dirs: measured.dirs,
      skipped: measured.skipped ? measured.skipped.length : 0,
      errors: measured.errors ? measured.errors.length : 0,
      truncated: measured.truncated === true,
      // 明确标注"这个账可信吗"：截断或出错 ⇒ 只是下界
      complete: measured.truncated !== true && (measured.errors ? measured.errors.length === 0 : true)
    };
  }
  return result;
}
var TRUNCATION_MARKER_TEMPLATE = "\n[WinStageSandbox][OUTPUT-TRUNCATED] dropped {droppedBytes} bytes / {droppedLines} lines; kept {keptBytes} bytes / {keptLines} lines (limit {limitBytes} bytes / {limitLines} lines)\n";
function renderMarker(fields) {
  return TRUNCATION_MARKER_TEMPLATE.replace(/\{(\w+)\}/g, (whole, key) => key in fields ? String(fields[key]) : whole);
}
function byteLengthOf(text) {
  return Buffer.byteLength(text, "utf8");
}
function countNewlines(text) {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  return count;
}
function lineCutIndex(text, maxLines) {
  if (maxLines === 0) return 0;
  let seen = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      seen += 1;
      if (seen >= maxLines) return i + 1;
    }
  }
  return void 0;
}
function cutOnCharacterBoundary(text, maxBytes) {
  const buffer = Buffer.from(text, "utf8");
  const budget = Math.max(0, Math.min(maxBytes, buffer.length));
  for (let size = budget; size >= Math.max(0, budget - 3); size -= 1) {
    if (size === 0) return { prefix: "", keptBytes: 0 };
    const next = buffer[size];
    if (next !== void 0 && (next & 192) === 128) continue;
    const candidate = buffer.subarray(0, size).toString("utf8");
    if (Buffer.byteLength(candidate, "utf8") === size) return { prefix: candidate, keptBytes: size };
  }
  return { prefix: "", keptBytes: 0 };
}
function hasLoneSurrogate(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 55296 && code <= 56319) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (!(next >= 56320 && next <= 57343)) return true;
      i += 1;
    } else if (code >= 56320 && code <= 57343) {
      return true;
    }
  }
  return false;
}
function assertAsciiMarker(marker) {
  for (const char of marker) {
    const code = char.codePointAt(0);
    if (code === 10 || code === 13 || code >= 32 && code <= 126) continue;
    throw new LimitsError(`\u622A\u65AD\u6807\u8BB0\u542B\u975E ASCII \u5B57\u7B26\uFF08U+${code.toString(16).toUpperCase()}\uFF09\u2014\u2014 \u63A7\u5236\u53F0\u4F1A\u53D8\u4E71\u7801\uFF0C\u7981\u6B62`, "OUTPUT_CAP_INVALID", { marker });
  }
  return true;
}
function applyOutputCap(text, options = {}) {
  if (typeof text !== "string") {
    throw new LimitsError(`applyOutputCap \u9700\u8981\u5B57\u7B26\u4E32\uFF0C\u6536\u5230 ${clip(text)}\uFF08\u7C7B\u578B ${typeof text}\uFF09\u2014\u2014 \u8BF7\u5148 toString/decode`, "OUTPUT_CAP_INVALID", { text: typeof text });
  }
  const { maxBytes = DEFAULT_LIMITS.maxOutputBytes, maxLines = DEFAULT_LIMITS.maxOutputLines } = options;
  const byteLimit = assertByteCount(maxBytes, "applyOutputCap.maxBytes", "OUTPUT_CAP_INVALID");
  const lineLimit = assertByteCount(maxLines, "applyOutputCap.maxLines", "OUTPUT_CAP_INVALID");
  const totalBytes = byteLengthOf(text);
  const totalLines = countNewlines(text);
  const overBytes = totalBytes > byteLimit;
  const overLines = totalLines > lineLimit;
  if (!overBytes && !overLines) {
    return {
      text,
      // 逐字节原样（含 BOM/CRLF 也原样）
      truncated: false,
      droppedBytes: 0,
      droppedLines: 0,
      keptBytes: totalBytes,
      keptLines: totalLines,
      byteTruncated: false,
      lineTruncated: false,
      marker: null
    };
  }
  let candidate = text;
  let droppedLines = 0;
  if (overLines) {
    const cut = lineCutIndex(text, lineLimit);
    if (cut !== void 0 && cut < text.length) {
      candidate = text.slice(0, cut);
      droppedLines = totalLines - countNewlines(candidate);
    }
  }
  let kept;
  let byteCutLoss = false;
  const candidateBytes = byteLengthOf(candidate);
  if (candidateBytes > byteLimit) {
    const { prefix, keptBytes: keptBytes2 } = cutOnCharacterBoundary(candidate, byteLimit);
    kept = prefix;
    byteCutLoss = keptBytes2 < candidateBytes;
  } else {
    kept = candidate;
  }
  const byteTruncated = byteCutLoss;
  const keptBytes = byteLengthOf(kept);
  const keptLines = countNewlines(kept);
  const droppedBytes = totalBytes - keptBytes;
  const droppedLinesFinal = Math.max(droppedLines, totalLines - keptLines);
  if (hasLoneSurrogate(kept)) {
    throw new LimitsError("applyOutputCap \u5185\u90E8\u9519\u8BEF\uFF1A\u622A\u65AD\u7ED3\u679C\u542B\u843D\u5355\u4EE3\u7406\u9879\uFF08\u534A\u4E2A\u7801\u70B9\uFF09\uFF0C\u62D2\u7EDD\u8FD4\u56DE\u635F\u574F\u6587\u672C", "OUTPUT_CAP_INVALID");
  }
  if (byteLengthOf(kept) !== keptBytes) {
    throw new LimitsError("applyOutputCap \u5185\u90E8\u9519\u8BEF\uFF1A\u622A\u65AD\u7ED3\u679C\u5B57\u8282\u6570\u4E0D\u81EA\u6D3D", "OUTPUT_CAP_INVALID");
  }
  const marker = renderMarker({
    droppedBytes,
    droppedLines: droppedLinesFinal,
    keptBytes,
    keptLines,
    limitBytes: byteLimit,
    limitLines: lineLimit
  });
  assertAsciiMarker(marker);
  return {
    text: kept + marker,
    truncated: true,
    droppedBytes,
    droppedLines: droppedLinesFinal,
    keptBytes,
    keptLines,
    byteTruncated,
    lineTruncated: overLines,
    marker
  };
}
function assertKnownKeys(input, where) {
  const unknown = Object.keys(input).filter((key) => !LIMIT_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new LimitsError(
      `${where} \u6536\u5230\u672A\u77E5\u952E ${unknown.map((k) => `"${clip(k)}"`).join(", ")}\uFF08\u53EA\u8BA4 ${LIMIT_KEYS.join(" / ")}\uFF09\u2014\u2014 \u62FC\u9519\u7684\u952E\u4F1A\u8BA9\u4E0A\u9650\u9759\u9ED8\u5931\u6548\uFF0C\u56E0\u6B64 fail-closed`,
      "LIMITS_INVALID",
      { unknown }
    );
  }
}
function wrapLimits(limits) {
  let flat = {};
  if (limits === void 0 || limits === null) {
    flat = {};
  } else if (typeof limits !== "object" || Array.isArray(limits)) {
    throw new LimitsError(`wrapLimits \u9700\u8981\u5BF9\u8C61\uFF08\u6216 undefined\uFF09\uFF0C\u6536\u5230 ${clip(limits)}\uFF08\u7C7B\u578B ${typeof limits}\uFF09`, "LIMITS_INVALID", { limits });
  } else {
    const keys = Object.keys(limits);
    const nestedKeys = keys.filter((key) => key === "staging" || key === "output");
    if (nestedKeys.length > 0) {
      const allowedNested = /* @__PURE__ */ new Set(["staging", "output"]);
      const unknown = keys.filter((key) => !allowedNested.has(key));
      if (unknown.length > 0) {
        throw new LimitsError(
          `wrapLimits \u6536\u5230\u5D4C\u5957\u5F62\u72B6\u65F6\u4E0D\u5141\u8BB8\u6DF7\u5165\u5176\u4ED6\u952E\uFF08\u672A\u77E5\uFF1A${unknown.map((k) => `"${clip(k)}"`).join(", ")}\uFF09`,
          "LIMITS_INVALID",
          { unknown }
        );
      }
      const staging = limits.staging;
      const output = limits.output;
      for (const [label, value] of [["staging", staging], ["output", output]]) {
        if (value === void 0 || value === null) continue;
        if (typeof value !== "object" || Array.isArray(value)) {
          throw new LimitsError(`wrapLimits \u7684 ${label} \u5FC5\u987B\u662F\u5BF9\u8C61\uFF0C\u6536\u5230 ${clip(value)}`, "LIMITS_INVALID", { [label]: value });
        }
      }
      if (staging) {
        const unknownStaging = Object.keys(staging).filter((key) => key !== "bytes");
        if (unknownStaging.length > 0) {
          throw new LimitsError(
            `wrapLimits \u7684 staging \u53EA\u8BA4 { bytes }\uFF0C\u6536\u5230\u672A\u77E5\u952E ${unknownStaging.map((k) => `"${clip(k)}"`).join(", ")}\uFF08\u62FC\u9519\u7684\u952E\u4F1A\u8BA9\u4E0A\u9650\u9759\u9ED8\u5931\u6548\uFF09`,
            "LIMITS_INVALID",
            { unknown: unknownStaging }
          );
        }
      }
      if (output) {
        const unknownOutput = Object.keys(output).filter((key) => key !== "maxBytes" && key !== "maxLines");
        if (unknownOutput.length > 0) {
          throw new LimitsError(
            `wrapLimits \u7684 output \u53EA\u8BA4 { maxBytes, maxLines }\uFF0C\u6536\u5230\u672A\u77E5\u952E ${unknownOutput.map((k) => `"${clip(k)}"`).join(", ")}\uFF08\u62FC\u9519\u7684\u952E\u4F1A\u8BA9\u4E0A\u9650\u9759\u9ED8\u5931\u6548\uFF09`,
            "LIMITS_INVALID",
            { unknown: unknownOutput }
          );
        }
      }
      const nestedFlat = {};
      if (staging && staging.bytes !== void 0) nestedFlat.stagingBytes = staging.bytes;
      if (output && output.maxBytes !== void 0) nestedFlat.maxOutputBytes = output.maxBytes;
      if (output && output.maxLines !== void 0) nestedFlat.maxOutputLines = output.maxLines;
      flat = nestedFlat;
    } else {
      assertKnownKeys(limits, "wrapLimits(limits)");
      flat = { ...limits };
    }
  }
  const stagingBytes = flat.stagingBytes === void 0 ? DEFAULT_LIMITS.stagingBytes : parseSize(flat.stagingBytes);
  const maxOutputBytes = flat.maxOutputBytes === void 0 ? DEFAULT_LIMITS.maxOutputBytes : parseSize(flat.maxOutputBytes);
  const maxOutputLines = flat.maxOutputLines === void 0 ? DEFAULT_LIMITS.maxOutputLines : assertByteCount(flat.maxOutputLines, "wrapLimits.maxOutputLines", "LIMITS_INVALID");
  const source = limits === void 0 || limits === null ? "defaults" : "explicit";
  return Object.freeze({
    stagingBytes,
    staging: Object.freeze({ bytes: stagingBytes }),
    maxOutputBytes,
    maxOutputLines,
    output: Object.freeze({ maxBytes: maxOutputBytes, maxLines: maxOutputLines }),
    source
  });
}
function summariseLimits(limits) {
  const normalised = limits && limits.staging && limits.output && Object.isFrozen(limits) ? limits : wrapLimits(limits);
  return {
    stagingBytes: normalised.stagingBytes,
    stagingGiB: toGiB(normalised.stagingBytes),
    maxOutputBytes: normalised.maxOutputBytes,
    maxOutputLines: normalised.maxOutputLines,
    // 出处：报告消费者据此判断"64 GiB 是对齐上游默认还是本项目自定义"
    source: normalised.source,
    stagingSource: STAGING_BYTES_SOURCE.marker,
    outputSource: OUTPUT_CAP_SOURCE.marker
  };
}
var __internal = Object.freeze({
  FILE_ATTRIBUTE_REPARSE_POINT,
  FORMAT_SIZE_MAX,
  MAX_INODE_TRACK,
  MAX_TREE_ENTRIES,
  TRUNCATION_MARKER_TEMPLATE,
  SIZE_UNITS,
  countNewlines,
  lineCutIndex,
  cutOnCharacterBoundary,
  hasLoneSurrogate,
  assertAsciiMarker,
  renderMarker,
  /**
   * `--plant` 变异体开关（**只影响当前进程**）。
   *
   * 钩子值刻意放在一个**可变表**里，而不是让公开 API 长出"要不要跟随链接"这种参数：
   * 遍历里只读 `HOOK_VALUES`，而它默认全 `false` —— 生产路径不存在打开的开关。
   * 测试改它，等于把源码里那两行判据**真的**拆掉（而不是写一套"模拟坏行为"的替身），
   * 因此 `--plant` 变红才是对判定力的真证据。
   */
  testHooks: HOOK_VALUES,
  setTestHooks(patch = {}) {
    if (patch === null || typeof patch !== "object") {
      throw new LimitsError(`setTestHooks \u9700\u8981\u5BF9\u8C61\uFF0C\u6536\u5230 ${clip(patch)}`, "LIMITS_INVALID");
    }
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in HOOK_VALUES)) throw new LimitsError(`\u672A\u77E5\u6D4B\u8BD5\u94A9\u5B50 "${clip(key)}"`, "LIMITS_INVALID");
      if (typeof value !== "boolean") throw new LimitsError(`testHooks.${key} \u5FC5\u987B\u662F\u5E03\u5C14\uFF0C\u6536\u5230 ${clip(value)}`, "LIMITS_INVALID");
      HOOK_VALUES[key] = value;
    }
    return { ...HOOK_VALUES };
  },
  resetTestHooks() {
    for (const key of Object.keys(HOOK_VALUES)) HOOK_VALUES[key] = false;
    return { ...HOOK_VALUES };
  }
});

// src/store.ts
var MANIFEST_VERSION = 1;
var CANDIDATE_VERSION = 1;
var STORE_DIR = ".dshstage";
function isStageCacheDir(dir, env) {
  const base = stageBaseDir(env).toLowerCase();
  const target = normalize3(String(dir)).toLowerCase();
  return target === base || target.startsWith(`${base}${sep3}`);
}
var STATE = {
  FILE: "file",
  // 暂存文件：读暂存内容
  DELETED: "deleted",
  // 删除标记：对所有工具表现为不存在
  CORRUPT: "corrupt"
  // 记录存在但存储对象缺失 → 明确损坏，禁止回退真实磁盘
};
var CANDIDATE_STATUS = {
  PENDING: "pending",
  APPLIED: "applied",
  PARTIALLY_APPLIED: "partially-applied",
  SUPERSEDED: "superseded",
  DISCARDED: "discarded",
  STALE: "stale"
};
function sha256Buffer(buffer) {
  return createHash2("sha256").update(buffer).digest("hex");
}
function hashFile(path) {
  return sha256Buffer(readFileSync2(path));
}
function hashAbsent() {
  return "absent";
}
function isExternalKey(key) {
  return typeof key === "string" && key.length > 0 && isAbsolute2(key);
}
function externalLeaf(key) {
  const raw = basename(normalize3(key));
  const cleaned = String(raw).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
  return cleaned.length === 0 ? "entry" : cleaned.slice(0, 120);
}
function externalKeyDigest(key) {
  return sha256Buffer(Buffer.from(normalize3(key).toLowerCase(), "utf8"));
}
function writeFileAtomic(path, data) {
  mkdirSync2(dirname3(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID2().slice(0, 8)}`;
  writeFileSync3(tmp, data);
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw error;
  }
}
function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync2(path, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(path, value) {
  writeFileAtomic(path, JSON.stringify(value, null, 2));
}
function makeRemovable(target) {
  if (!existsSync2(target)) return { repaired: 0 };
  let repaired = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    let info;
    try {
      info = lstatSync(current);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      const mode = info.mode & 511;
      if (mode !== 448) {
        try {
          chmodSync(current, 448);
          repaired += 1;
        } catch {
        }
      }
      let entries = [];
      try {
        entries = readdirSync2(current);
      } catch {
        entries = [];
      }
      for (const entry of entries) stack.push(join4(current, entry));
    }
  }
  return { repaired };
}
var Store = class {
  /** @param {string} workspaceRoot 真实工作区根（绝对路径，已 canonical） */
  constructor(workspaceRoot, options = {}) {
    this.workspaceRoot = workspaceRoot;
    this.stageRootOverride = options.stageRoot !== void 0 ? String(options.stageRoot) : void 0;
    this.stageEnv = options.env;
    this.dir = options.storeDir ? String(options.storeDir) : resolveStageRoot({
      sessionKey: options.sessionKey || options.sessionId,
      workspaceRoot,
      env: options.env,
      override: this.stageRootOverride
    });
    if (options.stageGuard === false) this.stageGuardMode = "off";
    else if (options.stageGuard === true) this.stageGuardMode = "on";
    else if (options.stageGuard && typeof options.stageGuard === "object") this.stageGuardMode = "given";
    else this.stageGuardMode = "auto";
    this.givenGuard = this.stageGuardMode === "given" ? options.stageGuard : void 0;
    this.guard = void 0;
    this.stageGuarded = this.stageGuardMode === "on" || this.stageGuardMode === "given" || this.stageGuardMode === "auto" && isStageCacheDir(this.dir, this.stageEnv);
    this.manifestPath = join4(this.dir, "manifest.json");
    this.queuePath = join4(this.dir, "queue.json");
    this.blobDir = join4(this.dir, "blobs");
    this.stagedDir = join4(this.dir, "staged");
    this.stagedExtDir = join4(this.dir, "staged-ext");
    this.candidateDir = join4(this.dir, "candidates");
    this.realDir = join4(this.dir, "real");
    this.privateDir = join4(this.dir, "private");
    this.cacheDir = join4(this.dir, "cache");
    this.ownerToken = options.ownerToken || randomUUID2();
    this.stagingQuotaBytes = options.stagingQuotaBytes === void 0 ? DEFAULT_LIMITS.stagingBytes : options.stagingQuotaBytes;
    this.measureStaging = typeof options.measureStaging === "function" ? options.measureStaging : measureTree;
  }
  /**
   * 建立/取得守护（幂等）。返回 `undefined` 表示本 store 不挂句柄守护
   * （例如调用方显式 `stageGuard: false`，或存储面是旧布局 `<root>/.dshstage`）。
   *
   * ── 接线须知（WP2/WP4 + 离线测试，**实测**）────────────────────────────────────
   * `%LOCALAPPDATA%\Temp\winstage-stage` 对**被沙箱收窄的命令行子进程**是**只读**的：
   * 连 `mkdir` 都返回 `EPERM`（本机实测，pwsh 与 node 结果一致）。
   * 而**宿主进程**（DSH 插件所在进程，即 `write` 工具那条通道）可以创建并写入它。
   * 因此：
   *   · 生产路径（插件 = 宿主进程）**不需要**任何额外配置，默认根就是可用的；
   *   · 任何跑在**受限档**里的离线测试/脚本，必须显式把根指到可写处：
   *     `new Store(root, { stageRoot: <可写临时目录>, stageGuard: true })`，
   *     或 `new Store(root, { storeDir: <可写目录> })`（后者不挂守护）。
   * 建不出根时这里 **fail-closed**：抛 `STAGE_GUARD_UNAVAILABLE`，
   * **绝不静默回落**到工作区、也绝不"无守护地继续暂存"（那会让抗外部清理悄悄变成假）。
   */
  guardStageRoot() {
    if (!this.stageGuarded) return void 0;
    if (this.guard) return this.guard;
    this.guard = this.givenGuard || acquireStageGuard(this.dir, { env: this.stageEnv });
    return this.guard;
  }
  /**
   * "丢失即显形"的唯一闸门：**每一次**往暂存面写之前都要过这一关。
   *
   * 判据交给 `stage-guard.ts::assertAlive()`（根在 + 标记在 + 哨兵未被篡改 + 守护存活）。
   * 任一失效 ⇒ 抛 `StageRootLostError`（`code === STAGE_ROOT_LOST`）。
   *
   * ⚠ 这里**不做任何重建**：根被外部清掉之后"顺手再建一个"正是必须避免的静默行为 ——
   * 那会把"暂存面被抹掉"伪装成什么都没发生，并且让后续写入落到一个**不再受守护**的目录里。
   */
  assertStageAvailable() {
    if (!this.stageGuarded) return { alive: true, reason: "unguarded" };
    return this.guardStageRoot().assertAlive();
  }
  /** 只看不建：当前存储面的存活状态（供审批面/自检报告根因） */
  stageStatus() {
    if (!this.stageGuarded) return { alive: true, reason: "unguarded", root: this.dir };
    const status = verifyStageRootAlive(this.dir);
    return { ...status, guarded: true };
  }
  /**
   * 正常释放（退出清理的调用点）：守护释放句柄并清空该根。
   * 宿主进程退出时会话根由守护自动清理；这里给"知道自己在收尾"的调用方一个确定性的出口。
   */
  releaseStageGuard(options = {}) {
    if (!this.guard) {
      return { root: this.dir, removed: !existsSync2(this.dir), alreadyReleased: true };
    }
    const report = this.guard.release(options);
    this.guard = void 0;
    return report;
  }
  ensureLayout() {
    this.assertStageAvailable();
    for (const dir of [this.dir, this.blobDir, this.stagedDir, this.stagedExtDir, this.candidateDir, this.realDir, this.privateDir, this.cacheDir]) {
      mkdirSync2(dir, { recursive: true });
    }
    return this;
  }
  // ---------- 内容寻址 ----------
  blobPath(hash) {
    return join4(this.blobDir, hash.slice(0, 2), hash);
  }
  hasBlob(hash) {
    return hash !== hashAbsent() && existsSync2(this.blobPath(hash));
  }
  /** 把内存内容落成一个 blob，返回 sha256 */
  putBlob(buffer) {
    const hash = sha256Buffer(buffer);
    const path = this.blobPath(hash);
    if (!existsSync2(path)) {
      this.assertStageAvailable();
      this.assertStagingQuota(buffer.length);
      mkdirSync2(dirname3(path), { recursive: true });
      writeFileSync3(path, buffer);
    }
    return hash;
  }
  /**
   * 暂存配额闸门（fail-closed，两条判据）。
   *
   * `limits.ts::checkStagingQuota()` 的入参是数字，它**看不到** `measureTree` 的
   * `errors[]/truncated`；其文件末"接线契约①"明确要求调用方在统计不完整时按
   * "已用 = 无上限"处理。本方法就是那个调用方：
   *   1. `measure.complete === false`（截断或条目出错）⇒ `STAGING_QUOTA_MEASUREMENT_INCOMPLETE`；
   *      **统计不了的树等于配额的洞**，宁可拒绝写入；
   *   2. `allowed === false`（used + incoming > quota）⇒ `STAGING_QUOTA_EXCEEDED`。
   *     `limits.ts` 的口径是"恰好用满"放行（零余量），本方法不额外收紧。
   *
   * 抛的是带 `code` 的类型化错误（与 `BLOB_MISSING` 同风格），并把完整判定挂在 `error.quota`
   * 上，便于审批面解释根因（used/quota/headroom/reason 一个都不丢）。
   */
  assertStagingQuota(incomingBytes = 0) {
    if (this.stagingQuotaBytes === null) {
      this.assertStageAvailable();
      return { allowed: true, reason: "staging quota explicitly disabled (stagingQuotaBytes:null)" };
    }
    this.assertStageAvailable();
    if (!existsSync2(this.dir)) mkdirSync2(this.dir, { recursive: true });
    const decision = checkStagingQuota({
      root: this.dir,
      quotaBytes: this.stagingQuotaBytes,
      incomingBytes,
      measure: this.measureStaging
    });
    if (decision.measure && decision.measure.complete === false) {
      const error = new Error(
        `STAGING_QUOTA_MEASUREMENT_INCOMPLETE: \u6682\u5B58\u6811\u7EDF\u8BA1\u4E0D\u5B8C\u6574\uFF08truncated=${decision.measure.truncated}, errors=${decision.measure.errors}, skipped=${decision.measure.skipped}\uFF09\uFF0C\u62D2\u7EDD\u5199\u5165 ${incomingBytes} \u5B57\u8282 \u2014\u2014 ${decision.reason}`
      );
      error.code = "STAGING_QUOTA_MEASUREMENT_INCOMPLETE";
      error.quota = decision;
      throw error;
    }
    if (!decision.allowed) {
      const error = new Error(`STAGING_QUOTA_EXCEEDED: \u6682\u5B58\u914D\u989D\u4E0D\u8DB3\uFF0C\u62D2\u7EDD\u5199\u5165 ${incomingBytes} \u5B57\u8282 \u2014\u2014 ${decision.reason}`);
      error.code = "STAGING_QUOTA_EXCEEDED";
      error.quota = decision;
      throw error;
    }
    return decision;
  }
  /** 把已有文件内容落成 blob（用于冻结 base/after） */
  putBlobFromFile(sourcePath) {
    return this.putBlob(readFileSync2(sourcePath));
  }
  /** 把 blob 还原到目标路径（物理替换语义，手册 #7.3） */
  materializeBlob(hash, targetPath, options = {}) {
    if (hash === hashAbsent()) {
      rmSync2(targetPath, { recursive: true, force: true });
      return { removed: true };
    }
    mkdirSync2(dirname3(targetPath), { recursive: true });
    if (options.useRename) {
      const tmp = `${targetPath}.stage-${randomUUID2().slice(0, 8)}`;
      copyFileSync(this.blobPath(hash), tmp);
      if (existsSync2(targetPath)) rmSync2(targetPath, { recursive: true, force: true });
      renameSync(tmp, targetPath);
    } else {
      if (existsSync2(targetPath)) rmSync2(targetPath, { recursive: true, force: true });
      copyFileSync(this.blobPath(hash), targetPath);
    }
    return { removed: false };
  }
  readBlob(hash) {
    if (!this.hasBlob(hash)) {
      const error = new Error(`blob missing for hash ${hash}`);
      error.code = "BLOB_MISSING";
      throw error;
    }
    return readFileSync2(this.blobPath(hash));
  }
  // ---------- 清单 ----------
  loadManifest() {
    const raw = readJson(this.manifestPath, void 0);
    if (!raw) return void 0;
    if (raw.version !== MANIFEST_VERSION) {
      const error = new Error(`unsupported manifest version ${raw.version}`);
      error.code = "MANIFEST_VERSION";
      throw error;
    }
    return raw;
  }
  saveManifest(manifest) {
    this.assertStageAvailable();
    writeJson(this.manifestPath, manifest);
  }
  createManifest(meta = {}) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const manifest = {
      version: MANIFEST_VERSION,
      sessionId: meta.sessionId || randomUUID2(),
      ownerToken: this.ownerToken,
      workspaceRoot: this.workspaceRoot,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      entries: {},
      hostOperations: []
    };
    this.saveManifest(manifest);
    return manifest;
  }
  /** 读取清单，若不存在则创建（幂等） */
  manifest(meta = {}) {
    const existing = this.loadManifest();
    if (existing) return existing;
    this.ensureLayout();
    return this.createManifest(meta);
  }
  touch(manifest) {
    manifest.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    manifest.revision = (manifest.revision || 0) + 1;
    this.saveManifest(manifest);
    return manifest;
  }
  /**
   * 清单键 → 物化暂存对象的绝对路径。
   *
   * 相对键（工作区内）：沿用 `staged/<rel>`（保留完整目录语义，命令执行的 cwd 就是它）。
   * 绝对键（工作区外）：`staged-ext/<aa>/<hash16>/<basename>` —— 绝对路径不能直接拼进
   * `staged/`（`C:` 的冒号是 Windows 非法文件名字符），故按稳定哈希分桶，只保留叶名。
   */
  stagedPath(key) {
    if (isExternalKey(key)) {
      const digest = externalKeyDigest(key);
      return join4(this.stagedExtDir, digest.slice(0, 2), digest.slice(0, 16), externalLeaf(key));
    }
    return join4(this.stagedDir, normalize3(key));
  }
  /**
   * 清单键 → **真实目标**绝对路径（带边界校验，越界 fail-closed）。
   *
   * 绝对键 = 工作区外目标：键本身就是它的真实路径，直接返回（键在建立时已 canonical）。
   * 相对键 = 工作区内：仍然做 `..` 逃逸校验，行为与改动前逐字一致。
   */
  realPath(key) {
    if (isExternalKey(key)) return normalize3(key);
    const clean = normalize3(key);
    if (clean.startsWith("..") || clean.includes(`..${sep3}`)) {
      const error = new Error(`unsafe relative path: ${key}`);
      error.code = "UNSAFE_RELATIVE_PATH";
      throw error;
    }
    return join4(this.workspaceRoot, clean);
  }
  // ---------- 队列 ----------
  loadQueue() {
    const raw = readJson(this.queuePath, void 0);
    if (!raw || raw.version !== 1) {
      return { version: 1, order: [], candidates: {}, supersededBy: {}, discarded: [] };
    }
    return raw;
  }
  saveQueue(queue) {
    this.assertStageAvailable();
    writeJson(this.queuePath, queue);
  }
  // ---------- 候选 ----------
  candidatePath(candidateId) {
    return join4(this.candidateDir, `${candidateId}.json`);
  }
  loadCandidate(candidateId) {
    return readJson(this.candidatePath(candidateId), void 0);
  }
  saveCandidate(candidate) {
    this.assertStageAvailable();
    writeJson(this.candidatePath(candidateIdOf(candidate)), candidate);
  }
  listCandidateIds() {
    if (!existsSync2(this.candidateDir)) return [];
    return readdirSync2(this.candidateDir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)).sort();
  }
  // ---------- 归属与清理 ----------
  /** 校验归属：只清理带本 store 标记的私有树（手册 #13.1） */
  verifyOwnership() {
    const manifest = this.loadManifest();
    if (!manifest) return { ok: true, reason: "no-manifest" };
    if (manifest.workspaceRoot && normalize3(manifest.workspaceRoot) !== normalize3(this.workspaceRoot)) {
      return { ok: false, reason: `manifest workspace mismatch: ${manifest.workspaceRoot}` };
    }
    return { ok: true, reason: "owned" };
  }
  /** 清理单个 blob 之外的资源：按 13.2 顺序执行 */
  disposeResources(targets = []) {
    const report = { removed: [], failed: [], repaired: 0 };
    for (const target of targets) {
      if (!existsSync2(target)) continue;
      const repair = makeRemovable(target);
      report.repaired += repair.repaired;
      try {
        rmSync2(target, { recursive: true, force: true });
        report.removed.push(target);
      } catch (error) {
        report.failed.push({ target, code: error.code || "ERR", message: error.message });
      }
    }
    return report;
  }
  /** 回收无引用的 blob（被任何层引用的都不动） */
  collectGarbage(options = {}) {
    const referenced = /* @__PURE__ */ new Set();
    const manifest = this.loadManifest();
    if (manifest) {
      for (const entry of Object.values(manifest.entries)) {
        if (entry.baseHash && entry.baseHash !== hashAbsent()) referenced.add(entry.baseHash);
        if (entry.stagedHash && entry.stagedHash !== hashAbsent()) referenced.add(entry.stagedHash);
      }
    }
    const queue = this.loadQueue();
    for (const id of queue.order) {
      const candidate = this.loadCandidate(id);
      if (!candidate) continue;
      for (const change of candidate.changes || []) {
        if (change.before?.hash && change.before.hash !== hashAbsent()) referenced.add(change.before.hash);
        if (change.after?.hash && change.after.hash !== hashAbsent()) referenced.add(change.after.hash);
      }
    }
    const report = { scanned: 0, removed: 0, kept: referenced.size, freedBytes: 0, failures: [] };
    if (!existsSync2(this.blobDir)) return report;
    const apply = options.apply === true;
    for (const shard of readdirSync2(this.blobDir)) {
      const shardDir = join4(this.blobDir, shard);
      if (!lstatSync(shardDir).isDirectory()) continue;
      for (const name of readdirSync2(shardDir)) {
        report.scanned += 1;
        if (referenced.has(name)) continue;
        const path = join4(shardDir, name);
        const bytes = statSync2(path).size;
        if (apply) {
          try {
            unlinkSync(path);
            report.removed += 1;
            report.freedBytes += bytes;
          } catch (error) {
            report.failures.push({ path, message: error.message });
          }
        }
      }
    }
    return report;
  }
};
function candidateIdOf(candidate) {
  return candidate.id;
}
function newCandidateId(sequence) {
  return `cs_${String(sequence).padStart(4, "0")}_${randomUUID2().slice(0, 8)}`;
}

// src/workspace.ts
import { existsSync as existsSync4, lstatSync as lstatSync2, mkdirSync as mkdirSync4, readdirSync as readdirSync4, readFileSync as readFileSync4, realpathSync as realpathSync3, renameSync as renameSync2, rmSync as rmSync4, statSync as statSync4, unlinkSync as unlinkSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname5, join as join7, normalize as normalize5, relative as relative2, sep as sep5 } from "node:path";
import { randomUUID as randomUUID4 } from "node:crypto";

// src/executor.ts
import { createRequire as createRequire2 } from "node:module";
import { spawn as spawnChildProcess, spawnSync as spawnSyncChildProcess } from "node:child_process";
import {
  closeSync as closeSync2,
  existsSync as existsSync3,
  mkdirSync as mkdirSync3,
  openSync as openSync2,
  readFileSync as readFileSync3,
  readdirSync as readdirSync3,
  realpathSync as realpathSync2,
  rmSync as rmSync3,
  statSync as statSync3,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync4
} from "node:fs";
import { dirname as dirname4, isAbsolute as isAbsolute3, join as join6, normalize as normalize4, resolve as resolve2, sep as sep4 } from "node:path";
import { tmpdir as tmpdir2 } from "node:os";
import { randomUUID as randomUUID3 } from "node:crypto";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/spawn-window.ts
import { createRequire } from "node:module";
import { join as join5 } from "node:path";
var WINDOWS_HIDE = false;
var require_ = createRequire(import.meta.url);
var applied = false;
var lastFailure;
var SUPPRESS = 1 | 32768;
function loadKoffi() {
  const candidates = ["koffi"];
  const push = (base) => {
    if (base) candidates.push(join5(base, "node_modules", "koffi"));
  };
  push(process.env.DSH_PROFILE_DIR);
  push(process.env.DSH_HOME && join5(process.env.DSH_HOME, "profiles"));
  push(process.env.USERPROFILE && join5(process.env.USERPROFILE, ".dsh", "profiles"));
  for (const candidate of candidates) {
    try {
      return require_(candidate);
    } catch {
    }
  }
  return void 0;
}
function suppressWindowsCriticalErrorDialogs() {
  if (applied) return true;
  try {
    const koffi = loadKoffi();
    if (koffi === void 0) {
      lastFailure = "koffi could not be resolved from any candidate path";
      return false;
    }
    const kernel32 = koffi.load("kernel32.dll");
    const SetErrorMode = kernel32.func("uint32 SetErrorMode(uint32 mode)");
    SetErrorMode(SUPPRESS);
    applied = true;
    lastFailure = void 0;
    return true;
  } catch (error) {
    lastFailure = error?.message ?? String(error);
    return false;
  }
}

// src/wfp.ts
import { createHash as createHash3 } from "node:crypto";
var FWP_DATA_TYPE = Object.freeze({
  FWP_EMPTY: 0,
  FWP_UINT8: 1,
  FWP_UINT16: 2,
  FWP_UINT32: 3,
  FWP_UINT64: 4,
  FWP_INT8: 5,
  FWP_INT16: 6,
  FWP_INT32: 7,
  FWP_INT64: 8,
  FWP_FLOAT: 9,
  FWP_DOUBLE: 10,
  FWP_BYTE_ARRAY16_TYPE: 11,
  FWP_BYTE_BLOB_TYPE: 12,
  FWP_SID: 13,
  FWP_SECURITY_DESCRIPTOR_TYPE: 14,
  FWP_TOKEN_INFORMATION_TYPE: 15,
  FWP_TOKEN_ACCESS_INFORMATION_TYPE: 16,
  FWP_UNICODE_STRING_TYPE: 17,
  FWP_BYTE_ARRAY6_TYPE: 18,
  FWP_SINGLE_DATA_TYPE_MAX: 255,
  FWP_V4_ADDR_MASK: 256,
  FWP_V6_ADDR_MASK: 257,
  FWP_RANGE_TYPE: 258
});
var FWP_MATCH_TYPE = Object.freeze({
  FWP_MATCH_EQUAL: 0,
  FWP_MATCH_GREATER: 1,
  FWP_MATCH_LESS: 2,
  FWP_MATCH_GREATER_OR_EQUAL: 3,
  FWP_MATCH_LESS_OR_EQUAL: 4,
  FWP_MATCH_RANGE: 5,
  FWP_MATCH_FLAGS_ALL_SET: 6,
  FWP_MATCH_FLAGS_ANY_SET: 7,
  FWP_MATCH_FLAGS_NONE_SET: 8,
  FWP_MATCH_EQUAL_CASE_INSENSITIVE: 9,
  FWP_MATCH_NOT_EQUAL: 10,
  FWP_MATCH_PREFIX: 11,
  FWP_MATCH_NOT_PREFIX: 12
});
var FWP_ACTION_TYPE = Object.freeze({
  FWP_ACTION_BLOCK: 4097,
  FWP_ACTION_PERMIT: 4098,
  FWP_ACTION_CALLOUT_TERMINATING: 4099,
  FWP_ACTION_CALLOUT_INSPECTION: 4100,
  FWP_ACTION_CALLOUT_UNKNOWN: 4101
});
var ACTION_TYPE_PROVISIONAL = true;
var FWPM_SUBLAYER_FLAG_PERSISTENT = 1;
var FWPM_SESSION_FLAG_DYNAMIC = 1;
var RPC_C_AUTHN_WINNT = 10;
var FWP_BYTE_BLOB_SIZE = 16;
var OFF_BYTE_BLOB = Object.freeze({ size: 0, data: 8 });
var FWP_VALUE0_SIZE = 16;
var OFF_VALUE = Object.freeze({ type: 0, value: 8 });
var FWP_CONDITION_VALUE0_SIZE = 16;
var OFF_CONDITION_VALUE = Object.freeze({ type: 0, value: 8 });
var FWPM_DISPLAY_DATA0_SIZE = 16;
var OFF_DISPLAY_DATA = Object.freeze({ name: 0, description: 8 });
var FWPM_ACTION0_SIZE = 24;
var OFF_ACTION = Object.freeze({ type: 0, filterTypeOrCalloutKey: 8 });
var FWPM_FILTER_CONDITION0_SIZE = 40;
var OFF_FILTER_CONDITION = Object.freeze({ fieldKey: 0, matchType: 16, conditionValue: 24 });
var FWPM_SUBLAYER0_SIZE = 72;
var OFF_SUBLAYER = Object.freeze({
  subLayerKey: 0,
  displayData: 16,
  flags: 32,
  providerKey: 40,
  providerData: 48,
  weight: 64
});
var FWPM_SESSION0_SIZE = 72;
var OFF_SESSION = Object.freeze({
  sessionKey: 0,
  displayData: 16,
  flags: 32,
  txnWaitTimeoutInMSec: 36,
  processId: 40,
  sid: 48,
  username: 56,
  kernelMode: 64
});
var FWPM_FILTER0_SIZE = 192;
var OFF_FILTER = Object.freeze({
  filterKey: 0,
  displayData: 16,
  flags: 32,
  providerKey: 40,
  providerData: 48,
  layerKey: 64,
  subLayerKey: 80,
  weight: 96,
  numFilterConditions: 112,
  filterCondition: 120,
  action: 128,
  rawContextOrProviderContextKey: 152,
  reserved: 160,
  filterId: 168,
  effectiveWeight: 176
});
var LAYOUT = Object.freeze({
  FWP_BYTE_BLOB: { size: FWP_BYTE_BLOB_SIZE, off: OFF_BYTE_BLOB },
  FWP_VALUE0: { size: FWP_VALUE0_SIZE, off: OFF_VALUE },
  FWP_CONDITION_VALUE0: { size: FWP_CONDITION_VALUE0_SIZE, off: OFF_CONDITION_VALUE },
  FWPM_DISPLAY_DATA0: { size: FWPM_DISPLAY_DATA0_SIZE, off: OFF_DISPLAY_DATA },
  FWPM_ACTION0: { size: FWPM_ACTION0_SIZE, off: OFF_ACTION },
  FWPM_FILTER_CONDITION0: { size: FWPM_FILTER_CONDITION0_SIZE, off: OFF_FILTER_CONDITION },
  FWPM_SUBLAYER0: { size: FWPM_SUBLAYER0_SIZE, off: OFF_SUBLAYER },
  FWPM_SESSION0: { size: FWPM_SESSION0_SIZE, off: OFF_SESSION },
  FWPM_FILTER0: { size: FWPM_FILTER0_SIZE, off: OFF_FILTER }
});
var GUID_TEXT = /^\{?([0-9a-fA-F]{8})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{12})\}?$/;
function parseGuid(text) {
  if (typeof text !== "string") throw new TypeError(`GUID must be a string, got ${typeof text}`);
  const match = GUID_TEXT.exec(text.trim());
  if (!match) {
    const error = new Error(`malformed GUID: ${JSON.stringify(text)} (expected 8-4-4-4-12 hex)`);
    error.code = "WFP_GUID_MALFORMED";
    throw error;
  }
  const [, d1, d2, d3, d4, d5] = match;
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32LE(parseInt(d1, 16), 0);
  buffer.writeUInt16LE(parseInt(d2, 16), 4);
  buffer.writeUInt16LE(parseInt(d3, 16), 6);
  buffer.writeUInt16BE(parseInt(d4, 16), 8);
  Buffer.from(d5, "hex").copy(buffer, 10);
  return buffer;
}
function formatGuid(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== 16) {
    throw new TypeError(`GUID buffer must be exactly 16 bytes, got ${Buffer.isBuffer(buffer) ? buffer.length : typeof buffer}`);
  }
  const hex = (n) => n.toString(16).padStart(2, "0");
  const d1 = buffer.readUInt32LE(0).toString(16).padStart(8, "0");
  const d2 = buffer.readUInt16LE(4).toString(16).padStart(4, "0");
  const d3 = buffer.readUInt16LE(6).toString(16).padStart(4, "0");
  const d4 = buffer.readUInt16BE(8).toString(16).padStart(4, "0");
  const d5 = [...buffer.subarray(10, 16)].map(hex).join("");
  return `${d1}-${d2}-${d3}-${d4}-${d5}`;
}
function coerceGuid(value, what = "GUID") {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 16) {
      const error2 = new Error(`${what} buffer must be 16 bytes, got ${value.length}`);
      error2.code = "WFP_GUID_MALFORMED";
      throw error2;
    }
    return value;
  }
  if (typeof value === "string") return parseGuid(value);
  const error = new Error(`${what} must be a GUID string or a 16-byte Buffer, got ${typeof value}`);
  error.code = "WFP_GUID_MALFORMED";
  throw error;
}
function writeGuid(buffer, offset, value, what) {
  if (value === null || value === void 0) {
    buffer.fill(0, offset, offset + 16);
    return;
  }
  coerceGuid(value, what).copy(buffer, offset);
}
function writePointer(buffer, offset, value) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("writePointer: buffer must be a Buffer");
  if (offset < 0 || offset + 8 > buffer.length) {
    const error2 = new Error(`writePointer: offset ${offset}+8 exceeds buffer length ${buffer.length}`);
    error2.code = "WFP_LAYOUT_OVERFLOW";
    throw error2;
  }
  const nullish = value === null || value === void 0;
  if (nullish) {
    buffer.writeBigUInt64LE(0n, offset);
    return;
  }
  if (typeof value === "bigint") {
    buffer.writeBigUInt64LE(value, offset);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      const error2 = new Error(`writePointer: numeric pointer must be a non-negative integer, got ${value}`);
      error2.code = "WFP_POINTER_INVALID";
      throw error2;
    }
    buffer.writeBigUInt64LE(BigInt(value), offset);
    return;
  }
  if (typeof value === "object" && typeof value.address === "function") {
    const address = value.address();
    if (typeof address !== "bigint") {
      const error2 = new Error(`writePointer: pointer-like object returned ${typeof address} from address()`);
      error2.code = "WFP_POINTER_INVALID";
      throw error2;
    }
    buffer.writeBigUInt64LE(address, offset);
    return;
  }
  const error = new Error(`writePointer: cannot encode pointer of type ${typeof value} at offset ${offset}`);
  error.code = "WFP_POINTER_INVALID";
  throw error;
}
function encodeWideString(text, what = "wide string") {
  if (typeof text !== "string") throw new TypeError(`${what} must be a string, got ${typeof text}`);
  if (text.includes("\0")) {
    const error = new Error(`${what} must not contain an embedded NUL`);
    error.code = "WFP_STRING_INVALID";
    throw error;
  }
  return Buffer.from(`${text}\0`, "utf16le");
}
function buildValue0({ type, value = null } = {}) {
  if (!Number.isInteger(type) || type < 0) {
    const error = new Error(`buildValue0: type must be a non-negative integer, got ${type}`);
    error.code = "WFP_VALUE_TYPE_INVALID";
    throw error;
  }
  const buffer = Buffer.alloc(FWP_VALUE0_SIZE);
  buffer.writeUInt32LE(type >>> 0, OFF_VALUE.type);
  const inline = {
    [FWP_DATA_TYPE.FWP_UINT8]: "writeUInt8",
    [FWP_DATA_TYPE.FWP_UINT16]: "writeUInt16LE",
    [FWP_DATA_TYPE.FWP_UINT32]: "writeUInt32LE",
    [FWP_DATA_TYPE.FWP_INT8]: "writeInt8",
    [FWP_DATA_TYPE.FWP_INT16]: "writeInt16LE",
    [FWP_DATA_TYPE.FWP_INT32]: "writeInt32LE",
    [FWP_DATA_TYPE.FWP_FLOAT]: "writeFloatLE"
  }[type];
  if (type === FWP_DATA_TYPE.FWP_EMPTY) {
    if (value !== null && value !== void 0) {
      const error = new Error("buildValue0: FWP_EMPTY must not carry a value (the union must stay zeroed)");
      error.code = "WFP_VALUE_TYPE_INVALID";
      throw error;
    }
    return buffer;
  }
  if (inline) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      const error = new Error(`buildValue0: data type ${type} is inline and needs a finite JS number, got ${typeof value}`);
      error.code = "WFP_VALUE_TYPE_INVALID";
      throw error;
    }
    buffer[inline](value, OFF_VALUE.value);
    return buffer;
  }
  if (value === null || value === void 0) {
    const error = new Error(
      `buildValue0: data type ${type} is a pointer member and must not be null (\u5B98\u65B9 FWP_CONDITION_VALUE0 \u9010\u5B57\u8981\u6C42 "This value cannot be null")`
    );
    error.code = "WFP_VALUE_TYPE_INVALID";
    throw error;
  }
  writePointer(buffer, OFF_VALUE.value, value);
  return buffer;
}
function buildConditionValue0(spec) {
  if (FWP_CONDITION_VALUE0_SIZE !== FWP_VALUE0_SIZE || OFF_CONDITION_VALUE.value !== OFF_VALUE.value) {
    const error = new Error("FWP_CONDITION_VALUE0 layout diverged from FWP_VALUE0 \u2014 layout constants are inconsistent");
    error.code = "WFP_LAYOUT_INCONSISTENT";
    throw error;
  }
  return buildValue0(spec);
}
function buildDisplayData0({ name = null, description = null } = {}) {
  const buffer = Buffer.alloc(FWPM_DISPLAY_DATA0_SIZE);
  writePointer(buffer, OFF_DISPLAY_DATA.name, name);
  writePointer(buffer, OFF_DISPLAY_DATA.description, description);
  return buffer;
}
function buildAction0({ type, filterType = null, calloutKey = null } = {}) {
  if (!Number.isInteger(type) || type < 0) {
    const error = new Error(`buildAction0: type must be a non-negative integer, got ${type}`);
    error.code = "WFP_ACTION_INVALID";
    throw error;
  }
  if (filterType && calloutKey) {
    const error = new Error("buildAction0: filterType and calloutKey are a union \u2014 only one may be set");
    error.code = "WFP_ACTION_INVALID";
    throw error;
  }
  const buffer = Buffer.alloc(FWPM_ACTION0_SIZE);
  buffer.writeUInt32LE(type >>> 0, OFF_ACTION.type);
  writeGuid(buffer, OFF_ACTION.filterTypeOrCalloutKey, filterType ?? calloutKey, "action GUID");
  return buffer;
}
function buildFilterCondition0({ fieldKey, matchType, conditionValue } = {}) {
  if (!Number.isInteger(matchType) || matchType < 0) {
    const error = new Error(`buildFilterCondition0: matchType must be a non-negative integer, got ${matchType}`);
    error.code = "WFP_CONDITION_INVALID";
    throw error;
  }
  if (!Buffer.isBuffer(conditionValue) || conditionValue.length !== FWP_CONDITION_VALUE0_SIZE) {
    const error = new Error(
      `buildFilterCondition0: conditionValue must be a ${FWP_CONDITION_VALUE0_SIZE}-byte Buffer from buildConditionValue0(), got ${Buffer.isBuffer(conditionValue) ? `${conditionValue.length} bytes` : typeof conditionValue}`
    );
    error.code = "WFP_CONDITION_INVALID";
    throw error;
  }
  const buffer = Buffer.alloc(FWPM_FILTER_CONDITION0_SIZE);
  writeGuid(buffer, OFF_FILTER_CONDITION.fieldKey, fieldKey, "condition fieldKey");
  buffer.writeUInt32LE(matchType >>> 0, OFF_FILTER_CONDITION.matchType);
  conditionValue.copy(buffer, OFF_FILTER_CONDITION.conditionValue);
  return buffer;
}
function buildFilterConditionArray(conditions) {
  if (!Array.isArray(conditions)) throw new TypeError("buildFilterConditionArray: conditions must be an array");
  const blocks = conditions.map((condition, index) => {
    if (!Buffer.isBuffer(condition) || condition.length !== FWPM_FILTER_CONDITION0_SIZE) {
      const error = new Error(
        `buildFilterConditionArray: element ${index} must be a ${FWPM_FILTER_CONDITION0_SIZE}-byte Buffer`
      );
      error.code = "WFP_CONDITION_INVALID";
      throw error;
    }
    return condition;
  });
  return { buffer: Buffer.concat(blocks), count: blocks.length };
}
function buildFilter0(spec = {}) {
  const {
    filterKey = null,
    displayData,
    flags = 0,
    providerKey = null,
    providerData = null,
    layerKey,
    subLayerKey,
    weight,
    conditions = [],
    action,
    rawContext = null,
    allowUnconditional = false,
    conditionPointer = null,
    pinConditionArray = null
  } = spec;
  if (!Buffer.isBuffer(displayData) || displayData.length !== FWPM_DISPLAY_DATA0_SIZE) {
    const error = new Error(`buildFilter0: displayData must be a ${FWPM_DISPLAY_DATA0_SIZE}-byte Buffer from buildDisplayData0()`);
    error.code = "WFP_FILTER_INVALID";
    throw error;
  }
  if (!Buffer.isBuffer(action) || action.length !== FWPM_ACTION0_SIZE) {
    const error = new Error(`buildFilter0: action must be a ${FWPM_ACTION0_SIZE}-byte Buffer from buildAction0()`);
    error.code = "WFP_FILTER_INVALID";
    throw error;
  }
  if (!Buffer.isBuffer(weight) || weight.length !== FWP_VALUE0_SIZE) {
    const error = new Error(`buildFilter0: weight must be a ${FWP_VALUE0_SIZE}-byte Buffer from buildValue0()`);
    error.code = "WFP_FILTER_INVALID";
    throw error;
  }
  if (subLayerKey === null || subLayerKey === void 0) {
    const error = new Error(
      "buildFilter0: subLayerKey is required \u2014 a filter in the default sublayer cannot be removed as a group (IID_NULL maps to the default sublayer)"
    );
    error.code = "WFP_FILTER_INVALID";
    throw error;
  }
  const { buffer: conditionBuffer, count } = buildFilterConditionArray(conditions);
  if (count === 0 && allowUnconditional !== true) {
    const error = new Error(
      'buildFilter0: zero conditions means "the action is always performed" (\u5B98\u65B9\u539F\u6587) \u2014 pass allowUnconditional:true to mean it deliberately'
    );
    error.code = "WFP_FILTER_UNCONDITIONAL_REFUSED";
    throw error;
  }
  if (count > 0 && conditionBuffer.length !== count * FWPM_FILTER_CONDITION0_SIZE) {
    const error = new Error("buildFilter0: condition buffer size does not match the condition count");
    error.code = "WFP_LAYOUT_INCONSISTENT";
    throw error;
  }
  let resolvedConditionPointer = null;
  if (count > 0) {
    resolvedConditionPointer = conditionPointer;
    if (resolvedConditionPointer === null || resolvedConditionPointer === void 0) {
      if (typeof pinConditionArray === "function") {
        resolvedConditionPointer = pinConditionArray(conditionBuffer, count);
      }
    }
    if (resolvedConditionPointer === null || resolvedConditionPointer === void 0) {
      const error = new Error(
        `buildFilter0: ${count} condition(s) were supplied, so FWPM_FILTER0.filterCondition must point at their native memory \u2014 but no pointer was given. Pass conditionPointer (an explicit address) or pinConditionArray (a (buffer, count) => pointer callback, e.g. (b) => koffi.address(b)). This module will not invent a placeholder pointer: a bogus pointer handed to FwpmFilterAdd0 fails unpredictably, and "looks like it worked but the filter is not active" is the worst outcome here.`
      );
      error.code = "WFP_CONDITION_POINTER_MISSING";
      throw error;
    }
    if (Buffer.isBuffer(resolvedConditionPointer)) {
      const error = new Error(
        "buildFilter0: conditionPointer must be an address (bigint / non-negative number / object with address()), not a Buffer. A Buffer has no exposed native address in Node, so passing one is always a bug."
      );
      error.code = "WFP_POINTER_INVALID";
      throw error;
    }
  }
  const buffer = Buffer.alloc(FWPM_FILTER0_SIZE);
  writeGuid(buffer, OFF_FILTER.filterKey, filterKey, "filterKey");
  displayData.copy(buffer, OFF_FILTER.displayData);
  buffer.writeUInt32LE(flags >>> 0, OFF_FILTER.flags);
  writeGuid(buffer, OFF_FILTER.providerKey, providerKey, "providerKey");
  if (providerData !== null && providerData !== void 0) {
    if (!Buffer.isBuffer(providerData) || providerData.length !== FWP_BYTE_BLOB_SIZE) {
      const error = new Error(`buildFilter0: providerData must be a ${FWP_BYTE_BLOB_SIZE}-byte Buffer from buildByteBlob()`);
      error.code = "WFP_FILTER_INVALID";
      throw error;
    }
    providerData.copy(buffer, OFF_FILTER.providerData);
  }
  writeGuid(buffer, OFF_FILTER.layerKey, layerKey, "layerKey");
  writeGuid(buffer, OFF_FILTER.subLayerKey, subLayerKey, "subLayerKey");
  weight.copy(buffer, OFF_FILTER.weight);
  buffer.writeUInt32LE(count >>> 0, OFF_FILTER.numFilterConditions);
  if (count > 0) writePointer(buffer, OFF_FILTER.filterCondition, resolvedConditionPointer);
  action.copy(buffer, OFF_FILTER.action);
  writePointer(buffer, OFF_FILTER.rawContextOrProviderContextKey, rawContext);
  return { buffer, count, conditions: conditionBuffer, conditionPointer: resolvedConditionPointer };
}
function buildSubLayer0(spec = {}) {
  const { subLayerKey = null, displayData, flags = 0, providerKey = null, providerData = null, weight = 256 } = spec;
  if (!Buffer.isBuffer(displayData) || displayData.length !== FWPM_DISPLAY_DATA0_SIZE) {
    const error = new Error(`buildSubLayer0: displayData must be a ${FWPM_DISPLAY_DATA0_SIZE}-byte Buffer from buildDisplayData0()`);
    error.code = "WFP_SUBLAYER_INVALID";
    throw error;
  }
  if (!Number.isInteger(weight) || weight < 0 || weight > 65535) {
    const error = new Error(`buildSubLayer0: weight must be a UINT16 (0..65535), got ${weight}`);
    error.code = "WFP_SUBLAYER_INVALID";
    throw error;
  }
  if ((flags & FWPM_SUBLAYER_FLAG_PERSISTENT) !== 0) {
    const error = new Error(
      "buildSubLayer0: FWPM_SUBLAYER_FLAG_PERSISTENT is refused \u2014 a persistent sublayer survives BFE restart and is a state leak across sessions"
    );
    error.code = "WFP_SUBLAYER_PERSISTENT_REFUSED";
    throw error;
  }
  const buffer = Buffer.alloc(FWPM_SUBLAYER0_SIZE);
  writeGuid(buffer, OFF_SUBLAYER.subLayerKey, subLayerKey, "subLayerKey");
  displayData.copy(buffer, OFF_SUBLAYER.displayData);
  buffer.writeUInt32LE(flags >>> 0, OFF_SUBLAYER.flags);
  writeGuid(buffer, OFF_SUBLAYER.providerKey, providerKey, "providerKey");
  if (providerData !== null && providerData !== void 0) {
    if (!Buffer.isBuffer(providerData) || providerData.length !== FWP_BYTE_BLOB_SIZE) {
      const error = new Error(`buildSubLayer0: providerData must be a ${FWP_BYTE_BLOB_SIZE}-byte Buffer`);
      error.code = "WFP_SUBLAYER_INVALID";
      throw error;
    }
    providerData.copy(buffer, OFF_SUBLAYER.providerData);
  }
  buffer.writeUInt16LE(weight, OFF_SUBLAYER.weight);
  return buffer;
}
function buildSession0({ flags = FWPM_SESSION_FLAG_DYNAMIC, txnWaitTimeoutInMSec = 0 } = {}) {
  if ((flags & ~FWPM_SESSION_FLAG_DYNAMIC) !== 0) {
    const error = new Error(
      `buildSession0: only FWPM_SESSION_FLAG_DYNAMIC is supported here, got flags=0x${(flags >>> 0).toString(16)}`
    );
    error.code = "WFP_SESSION_INVALID";
    throw error;
  }
  if (!Number.isInteger(txnWaitTimeoutInMSec) || txnWaitTimeoutInMSec < 0) {
    const error = new Error(`buildSession0: txnWaitTimeoutInMSec must be a non-negative integer`);
    error.code = "WFP_SESSION_INVALID";
    throw error;
  }
  const buffer = Buffer.alloc(FWPM_SESSION0_SIZE);
  buffer.writeUInt32LE(flags >>> 0, OFF_SESSION.flags);
  buffer.writeUInt32LE(txnWaitTimeoutInMSec >>> 0, OFF_SESSION.txnWaitTimeoutInMSec);
  return buffer;
}
function stableRuleKey(namespace, name) {
  if (typeof namespace !== "string" || namespace.length === 0) throw new TypeError("stableRuleKey: namespace must be a non-empty string");
  if (typeof name !== "string" || name.length === 0) throw new TypeError("stableRuleKey: name must be a non-empty string");
  const digest = createHash3("sha1").update(`${namespace}\0${name}`).digest();
  digest[6] = digest[6] & 15 | 80;
  digest[8] = digest[8] & 63 | 128;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
var NETWORK_TIERS = Object.freeze(["OFFLINE", "CONTROLLED_ONLINE", "OBSERVED_ONLINE"]);
var OFFLINE_LAYER_KEYS = Object.freeze([
  "ALE_AUTH_CONNECT_V4",
  "ALE_AUTH_CONNECT_V6",
  "ALE_AUTH_RECV_ACCEPT_V4",
  "ALE_AUTH_RECV_ACCEPT_V6",
  "ALE_AUTH_LISTEN_V4",
  "ALE_AUTH_LISTEN_V6"
]);
var CONDITION_KEYS = Object.freeze(["ALE_PACKAGE_ID", "ALE_APP_ID"]);
var MATCH_TARGETS = Object.freeze(["appcontainer", "app-identifier"]);
function planOfflineRules(options = {}) {
  const { tier = "OFFLINE", target = "appcontainer", guids = {} } = options;
  if (!NETWORK_TIERS.includes(tier)) {
    const error = new Error(`planOfflineRules: unknown network tier ${JSON.stringify(tier)}`);
    error.code = "WFP_TIER_INVALID";
    throw error;
  }
  if (!MATCH_TARGETS.includes(target)) {
    const error = new Error(`planOfflineRules: unknown match target ${JSON.stringify(target)}`);
    error.code = "WFP_TARGET_INVALID";
    throw error;
  }
  if (tier !== "OFFLINE") {
    const error = new Error(
      `planOfflineRules: tier ${tier} is not implemented \u2014 only OFFLINE is a hard block. CONTROLLED_ONLINE/OBSERVED_ONLINE require an allow-list model and are NOT implemented here (manual \xA79.1).`
    );
    error.code = "WFP_TIER_NOT_IMPLEMENTED";
    throw error;
  }
  const conditionKey = target === "appcontainer" ? "ALE_PACKAGE_ID" : "ALE_APP_ID";
  const missing = [];
  if (!guids[conditionKey]) missing.push(conditionKey);
  for (const layer of OFFLINE_LAYER_KEYS) if (!guids[layer]) missing.push(layer);
  if (missing.length > 0) {
    const error = new Error(
      `WFP_GUIDS_MISSING: no GUID literals are embedded in this module (no Windows SDK on this host); the caller must supply them. Missing: ${missing.join(", ")}`
    );
    error.code = "WFP_GUIDS_MISSING";
    error.missing = missing;
    throw error;
  }
  const subLayerKey = stableRuleKey("dsh-stage/wfp", `sublayer/${tier}/${target}`);
  const filters = OFFLINE_LAYER_KEYS.map((layer) => ({
    key: stableRuleKey("dsh-stage/wfp", `filter/${tier}/${target}/${layer}`),
    layerKey: layer,
    conditionKey,
    matchType: FWP_MATCH_TYPE.FWP_MATCH_EQUAL,
    action: FWP_ACTION_TYPE.FWP_ACTION_BLOCK,
    description: `dsh-stage OFFLINE: block ${layer} for ${conditionKey}`
  }));
  const warnings = [];
  if (target === "app-identifier") {
    warnings.push(
      "target=app-identifier matches by executable path (FWPM_CONDITION_ALE_APP_ID). It misses a renamed/copied copy of the same binary and can affect unrelated processes that run the same executable. WFP has NO process-id or restricted-SID condition key, so this is the only approximation available for the T1 (restricted-token) tier."
    );
  }
  warnings.push(
    'The ALE layer set covers connect/recv-accept/listen. Traffic already established before the filters were added is NOT re-evaluated by a block filter at ALE_AUTH_CONNECT (official: ALE authorizes on the first packet / connection). Treat "blocked" as verified only by an attacker probe launched from inside the sandbox AFTER the filters are installed.'
  );
  if (ACTION_TYPE_PROVISIONAL) {
    warnings.push(
      `FWP_ACTION_* values (BLOCK=0x${FWP_ACTION_TYPE.FWP_ACTION_BLOCK.toString(16)}) are provisional: the official page gives the composite expression but not the flag bit values, and no Windows SDK header is available on this host to confirm them.`
    );
  }
  return { tier, target, subLayerKey, filters, warnings };
}
function wfpError(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, extra);
  return error;
}
function describeWfpStatus(status) {
  const value = status >>> 0;
  const table = {
    0: "ERROR_SUCCESS",
    5: "ERROR_ACCESS_DENIED (FWPM_ACTRL_OPEN / FWPM_ACTRL_ADD \u4E0D\u8DB3\uFF0C\u6216\u9700\u8981\u7BA1\u7406\u5458)",
    50: 'ERROR_NOT_SUPPORTED (\u9636\u6BB5 B \u5B9E\u6D4B\u7684**\u786E\u5207**\u6210\u56E0\uFF1AauthnService \u4F20\u4E86 RPC_C_AUTHN_NONE(0)\u3002\u5B98\u65B9\u53EA\u5141\u8BB8 RPC_C_AUTHN_WINNT / RPC_C_AUTHN_DEFAULT\uFF0C\u4E24\u8005\u5728\u672C\u673A\u90FD\u8FD4\u56DE 0\u3002\u4E0E"WFP \u9700\u8981\u7BA1\u7406\u5458"\u65E0\u5173\uFF0C\u4E0E BFE \u662F\u5426\u8FD0\u884C\u4E5F\u65E0\u5173 \u2014\u2014 BFE \u5B9E\u6D4B RUNNING)',
    87: "ERROR_INVALID_PARAMETER",
    1717: "EPT_S_NOT_REGISTERED (RPC \u7AEF\u70B9\u4E0D\u53EF\u7528\uFF1B\u5E38\u89C1\u4E8E BFE \u670D\u52A1\u672A\u8FD0\u884C)",
    2150760451: "FWP_E_ALREADY_EXISTS",
    2150760455: "FWP_E_FILTER_NOT_FOUND",
    2150760456: "FWP_E_LAYER_NOT_FOUND (\u5E38\u89C1\u6839\u56E0\uFF1Alayer GUID \u5B57\u8282\u5E8F\u5199\u9519\u6216\u8BE5\u5C42\u4E0D\u5B58\u5728)",
    2150760457: "FWP_E_ALREADY_EXISTS (sessionKey \u91CD\u590D)",
    2150760458: "FWP_E_SUBLAYER_NOT_FOUND",
    2150760459: "FWP_E_NOT_FOUND",
    2150760464: "FWP_E_INCOMPATIBLE_TXN (\u53EA\u8BFB\u4E8B\u52A1\u4E2D\u4E0D\u53EF\u8C03\u7528)"
  };
  return table[value] ?? `unknown/undocumented WFP status 0x${value.toString(16)}`;
}
function probeWfpAvailability(api) {
  if (!api || typeof api.fwpmEngineOpen0 !== "function") {
    return { available: false, detail: "binding table has no fwpmEngineOpen0" };
  }
  const slot = [null];
  let returned;
  try {
    returned = api.fwpmEngineOpen0(null, RPC_C_AUTHN_WINNT, null, null, slot);
  } catch (error) {
    return { available: false, detail: `FwpmEngineOpen0 threw: ${error.message}` };
  }
  let status;
  let engine;
  if (returned !== null && typeof returned === "object" && ("status" in returned || "handle" in returned)) {
    status = (returned.status ?? 0) >>> 0;
    engine = returned.handle ?? null;
  } else {
    status = (typeof returned === "number" ? returned : 0) >>> 0;
    engine = slot[0] ?? null;
  }
  if (status !== 0 || !engine) {
    return {
      available: false,
      status: status >>> 0,
      detail: `FwpmEngineOpen0 -> 0x${(status >>> 0).toString(16)} (${status >>> 0}): ${describeWfpStatus(status)}`
    };
  }
  try {
    if (typeof api.fwpmEngineClose0 === "function") api.fwpmEngineClose0(engine);
  } catch {
  }
  return { available: true, status: 0, detail: "FwpmEngineOpen0 succeeded and the engine was closed again" };
}
function openEngine(api) {
  if (!api || typeof api.fwpmEngineOpen0 !== "function") {
    throw wfpError("WFP_UNAVAILABLE", "binding table has no fwpmEngineOpen0; refusing to pretend the network is blocked");
  }
  const sessionBuffer = buildSession0({});
  let engine;
  const slot = [null];
  try {
    engine = api.fwpmEngineOpen0(null, RPC_C_AUTHN_WINNT, null, sessionBuffer, slot);
  } catch (error) {
    throw wfpError("WFP_UNAVAILABLE", `FwpmEngineOpen0 threw: ${error.message}`, { cause: error });
  }
  let status;
  let handle;
  if (engine !== null && typeof engine === "object" && ("status" in engine || "handle" in engine)) {
    status = (engine.status ?? 0) >>> 0;
    handle = engine.handle ?? null;
  } else {
    status = (typeof engine === "number" ? engine : 0) >>> 0;
    handle = slot[0] ?? null;
  }
  if (status !== 0 || !handle) {
    throw wfpError("WFP_UNAVAILABLE", `FwpmEngineOpen0 -> 0x${status.toString(16)}: ${describeWfpStatus(status)}`, {
      wfpStatus: status
    });
  }
  return {
    handle,
    sessionBuffer,
    /** 关闭引擎（幂等；失败只记录不抛，因为此时已无补救手段） */
    close() {
      const failures = [];
      try {
        if (typeof api.fwpmEngineClose0 === "function") {
          const rc = api.fwpmEngineClose0(handle);
          if ((rc ?? 0) >>> 0 !== 0) failures.push(`FwpmEngineClose0 -> 0x${(rc >>> 0).toString(16)}`);
        } else {
          failures.push("binding table has no fwpmEngineClose0");
        }
      } catch (error) {
        failures.push(`FwpmEngineClose0 threw: ${error.message}`);
      }
      return { failures };
    }
  };
}
function installSubLayer(api, engineHandle, subLayerBuffer) {
  if (!Buffer.isBuffer(subLayerBuffer) || subLayerBuffer.length !== FWPM_SUBLAYER0_SIZE) {
    throw wfpError("WFP_SUBLAYER_INVALID", `subLayer must be a ${FWPM_SUBLAYER0_SIZE}-byte Buffer from buildSubLayer0()`);
  }
  const status = (api.fwpmSubLayerAdd0(engineHandle, subLayerBuffer, null) ?? 0) >>> 0;
  if (status === 0 || status === 2150760451) return { status, idempotent: status === 2150760451 };
  throw wfpError("WFP_SUBLAYER_ADD_FAILED", `FwpmSubLayerAdd0 -> 0x${status.toString(16)}: ${describeWfpStatus(status)}`, {
    wfpStatus: status
  });
}
function addFilter(api, engineHandle, filterBuffer) {
  if (!Buffer.isBuffer(filterBuffer) || filterBuffer.length !== FWPM_FILTER0_SIZE) {
    throw wfpError("WFP_FILTER_INVALID", `filter must be a ${FWPM_FILTER0_SIZE}-byte Buffer from buildFilter0()`);
  }
  const out = { id: null, status: 0 };
  const status = (api.fwpmFilterAdd0(engineHandle, filterBuffer, null, out) ?? 0) >>> 0;
  if (status !== 0) {
    throw wfpError("WFP_FILTER_ADD_FAILED", `FwpmFilterAdd0 -> 0x${status.toString(16)}: ${describeWfpStatus(status)}`, {
      wfpStatus: status
    });
  }
  if (out.id === null || out.id === void 0) {
    throw wfpError(
      "WFP_FILTER_ID_MISSING",
      "FwpmFilterAdd0 reported success but returned no filterId. filterId is the only handle FwpmFilterDeleteById0 accepts, so the filter could never be rolled back \u2014 refusing to treat this as a successful install."
    );
  }
  return { status, filterId: out.id };
}
function deleteFilterById(api, engineHandle, filterId) {
  const status = (api.fwpmFilterDeleteById0(engineHandle, BigInt(filterId)) ?? 0) >>> 0;
  if (status === 0 || status === 2150760455) return { status, idempotent: status !== 0 };
  throw wfpError("WFP_FILTER_DELETE_FAILED", `FwpmFilterDeleteById0 -> 0x${status.toString(16)}: ${describeWfpStatus(status)}`, {
    wfpStatus: status
  });
}
function deleteSubLayerByKey(api, engineHandle, subLayerKey) {
  const status = (api.fwpmSubLayerDeleteByKey0(engineHandle, coerceGuid(subLayerKey, "subLayerKey")) ?? 0) >>> 0;
  if (status === 0 || status === 2150760458) return { status, idempotent: status !== 0 };
  throw wfpError("WFP_SUBLAYER_DELETE_FAILED", `FwpmSubLayerDeleteByKey0 -> 0x${status.toString(16)}: ${describeWfpStatus(status)}`, {
    wfpStatus: status
  });
}
function applyOfflinePlan(api, engine, plan, guids, retainPointer = () => {
}, pin = null) {
  if (!engine || !engine.handle) throw wfpError("WFP_UNAVAILABLE", "applyOfflinePlan requires an open engine");
  if (!plan || plan.tier !== "OFFLINE") {
    throw wfpError("WFP_TIER_NOT_IMPLEMENTED", "applyOfflinePlan only implements the OFFLINE tier");
  }
  for (const required of ["fwpmSubLayerAdd0", "fwpmFilterAdd0", "fwpmFilterDeleteById0", "fwpmSubLayerDeleteByKey0"]) {
    if (typeof api[required] !== "function") {
      throw wfpError(
        "WFP_UNAVAILABLE",
        `binding table lacks ${required}; refusing to install filters that could not be rolled back`
      );
    }
  }
  const resolvedPin = typeof pin === "function" ? pin : typeof api?.pin === "function" ? api.pin : null;
  if (typeof resolvedPin !== "function") {
    throw wfpError(
      "WFP_PIN_REQUIRED",
      "applyOfflinePlan requires pin(buffer) -> native address (or a pin function on the binding table). FWPM_FILTER0.filterCondition, FWPM_DISPLAY_DATA0.name/description and FWPM_SUBLAYER0.displayData are all embedded pointers that cannot be derived from a JS Buffer. With koffi pass (b) => koffi.address(b)."
    );
  }
  const installed = { filters: [], subLayerKey: plan.subLayerKey };
  const keep = (buffer) => {
    retainPointer("wfp", buffer);
    return buffer;
  };
  const pinWideString = (text, what) => resolvedPin(keep(encodeWideString(text, what)));
  try {
    const subLayer = keep(
      buildSubLayer0({
        subLayerKey: plan.subLayerKey,
        displayData: keep(
          buildDisplayData0({
            name: pinWideString("dsh-stage", "sublayer displayData.name"),
            description: pinWideString("dsh-stage network isolation sublayer", "sublayer displayData.description")
          })
        ),
        weight: 256
      })
    );
    installSubLayer(api, engine.handle, subLayer);
    for (const rule of plan.filters) {
      const layerGuid = guids[rule.layerKey];
      const conditionGuid = guids[rule.conditionKey];
      const targetValue = guids.targetValue;
      if (!layerGuid) throw wfpError("WFP_GUIDS_MISSING", `missing layer GUID for ${rule.layerKey}`);
      if (!conditionGuid) throw wfpError("WFP_GUIDS_MISSING", `missing condition GUID for ${rule.conditionKey}`);
      if (targetValue === void 0 || targetValue === null) {
        throw wfpError(
          "WFP_TARGET_VALUE_MISSING",
          `guids.targetValue is required: the SID pointer (target=appcontainer) or the ALE_APP_ID blob pointer (target=app-identifier)`
        );
      }
      const conditionValueType = plan.target === "appcontainer" ? FWP_DATA_TYPE.FWP_SID : FWP_DATA_TYPE.FWP_BYTE_BLOB_TYPE;
      const condition = keep(
        buildFilterCondition0({
          fieldKey: conditionGuid,
          matchType: rule.matchType,
          conditionValue: keep(buildConditionValue0({ type: conditionValueType, value: targetValue }))
        })
      );
      const filter = keep(
        buildFilter0({
          filterKey: rule.key,
          displayData: keep(
            buildDisplayData0({
              name: pinWideString(rule.key, "filter displayData.name"),
              description: pinWideString(rule.description, "filter displayData.description")
            })
          ),
          layerKey: layerGuid,
          subLayerKey: plan.subLayerKey,
          weight: keep(buildValue0({ type: FWP_DATA_TYPE.FWP_EMPTY })),
          conditions: [condition],
          action: keep(buildAction0({ type: rule.action })),
          pinConditionArray: (buffer) => resolvedPin(buffer)
        })
      );
      const { filterId } = addFilter(api, engine.handle, filter.buffer);
      installed.filters.push({ key: rule.key, layerKey: rule.layerKey, filterId });
    }
    return installed;
  } catch (error) {
    const rollbackFailures = [];
    for (const item of [...installed.filters].reverse()) {
      try {
        deleteFilterById(api, engine.handle, item.filterId);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError.message);
      }
    }
    try {
      deleteSubLayerByKey(api, engine.handle, plan.subLayerKey);
    } catch (rollbackError) {
      rollbackFailures.push(rollbackError.message);
    }
    error.rollbackFailures = rollbackFailures;
    throw error;
  }
}

// src/netpolicy.ts
var NETWORK_TIER_STATES = Object.freeze({
  ENFORCED: "enforced",
  NOT_ENFORCED: "not-enforced",
  REFUSED: "refused",
  NOT_IMPLEMENTED: "not-implemented"
});
var ENUMERATION_UNAVAILABLE_REASON = "enumeration-unavailable";
var INSTALL_BINDINGS = Object.freeze([
  "fwpmEngineOpen0",
  "fwpmEngineClose0",
  "fwpmSubLayerAdd0",
  "fwpmFilterAdd0",
  "fwpmFilterDeleteById0",
  "fwpmSubLayerDeleteByKey0"
]);
var INSTALL_EVIDENCE_BRAND = /* @__PURE__ */ Symbol("WinStageSandbox.netpolicy.install-evidence");
var INSTALL_EVIDENCE_RECORDS = /* @__PURE__ */ new WeakMap();
var INVALIDATED_INSTALL_EVIDENCE = /* @__PURE__ */ new WeakSet();
function canonicalPlanValue(value) {
  if (value === null || value === void 0) return null;
  const text = guidText(value);
  if (text !== null) return `guid:${text}`;
  if (Buffer.isBuffer(value)) return `buf:${value.toString("hex")}`;
  if (typeof value === "bigint") return `num:${value.toString(16)}`;
  if (typeof value === "number") return `num:${Number.isInteger(value) ? BigInt(value).toString(16) : String(value)}`;
  if (typeof value === "string") return `text:${value}`;
  if (typeof value === "boolean") return `bool:${value}`;
  return `other:${Object.prototype.toString.call(value)}`;
}
function planFingerprint(plan, guids) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.filters)) return null;
  const guidSource = guids && typeof guids === "object" ? guids : {};
  const rules = plan.filters.map((rule) => [
    guidText(rule?.key) ?? String(rule?.key ?? ""),
    String(rule?.layerKey ?? ""),
    String(rule?.conditionKey ?? ""),
    String(rule?.matchType ?? ""),
    String(rule?.action ?? ""),
    String(rule?.description ?? ""),
    canonicalPlanValue(guidSource[rule?.layerKey]),
    canonicalPlanValue(guidSource[rule?.conditionKey])
  ]);
  const canonical3 = JSON.stringify({
    tier: String(plan.tier ?? ""),
    target: String(plan.target ?? ""),
    subLayerKey: String(plan.subLayerKey ?? ""),
    rules,
    targetValue: canonicalPlanValue(guidSource.targetValue)
  });
  return stableRuleKey("dsh-stage/netpolicy/plan-fingerprint", canonical3);
}
function auditVerdictSnapshot(auditResult) {
  return Object.freeze({
    verified: auditResult?.verified === true,
    reason: typeof auditResult?.reason === "string" ? auditResult.reason : null,
    installed: auditResult?.installed === true,
    filterCount: Number.isInteger(auditResult?.filterCount) ? auditResult.filterCount : 0,
    subLayerKey: typeof auditResult?.subLayerKey === "string" ? auditResult.subLayerKey : null,
    layerChecked: auditResult?.layerChecked === true
  });
}
function auditVerdictFingerprint(auditResult) {
  const snapshot = auditVerdictSnapshot(auditResult);
  return JSON.stringify([snapshot.verified, snapshot.reason, snapshot.installed, snapshot.filterCount]);
}
function verifyInstallEvidence({ install, api, plan, guids, audit }) {
  if (install === null || install === void 0) return { ok: false, reason: "missing-install" };
  if (typeof install !== "object") return { ok: false, reason: "install-not-an-object" };
  try {
    if (install[INSTALL_EVIDENCE_BRAND] !== true) return { ok: false, reason: "not-branded" };
    const record = INSTALL_EVIDENCE_RECORDS.get(install);
    if (!record) return { ok: false, reason: "not-produced-by-installNetworkPolicy" };
    if (INVALIDATED_INSTALL_EVIDENCE.has(install)) return { ok: false, reason: "evidence-torn-down" };
    if (record.api !== api) return { ok: false, reason: "api-mismatch" };
    const wanted = planFingerprint(plan, guids);
    if (wanted === null || typeof record.planFingerprint !== "string" || record.planFingerprint !== wanted) {
      return { ok: false, reason: "plan-mismatch" };
    }
    if (engineHandleOf(record.engine) === null) return { ok: false, reason: "engine-missing" };
    if (audit !== null && audit !== void 0 && auditVerdictFingerprint(audit) !== record.auditFingerprint) {
      return { ok: false, reason: "audit-mismatch" };
    }
    return { ok: true, install: record.evidence, audit: record.audit };
  } catch (error) {
    return { ok: false, reason: `evidence-check-threw:${error?.message ?? String(error)}` };
  }
}
function netError(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, extra);
  return error;
}
function missingInstallBindings(api) {
  if (!api || typeof api !== "object") return [...INSTALL_BINDINGS];
  return INSTALL_BINDINGS.filter((name) => typeof api[name] !== "function");
}
function normaliseGuids(value) {
  return value === null || value === void 0 ? {} : value;
}
function resolvePin(api, pin) {
  if (typeof pin === "function") return pin;
  if (api && typeof api.pin === "function") return api.pin;
  return null;
}
function runProbe(api, probe) {
  if (typeof probe === "function") {
    try {
      const result = probe(api);
      if (result && typeof result === "object") return result;
      return { available: false, detail: "probe \u51FD\u6570\u8FD4\u56DE\u4E86\u975E\u5BF9\u8C61\uFF0C\u6309\u4E0D\u53EF\u7528\u5904\u7406\uFF08fail-closed\uFF09" };
    } catch (error) {
      return { available: false, detail: `probe \u51FD\u6570\u629B\u9519\uFF1A${error.message}` };
    }
  }
  if (probe && typeof probe === "object") return probe;
  return probeWfpAvailability(api);
}
function refusedResult(tier, reason, extra = {}) {
  return {
    tier,
    state: NETWORK_TIER_STATES.REFUSED,
    enforced: false,
    verified: false,
    reason,
    plan: null,
    ...extra
  };
}
function guidText(value) {
  if (value === null || value === void 0) return null;
  try {
    if (Buffer.isBuffer(value)) return value.length === 16 ? formatGuid(value) : null;
    if (typeof value === "string") return formatGuid(coerceGuid(value));
  } catch {
    return null;
  }
  return null;
}
function engineHandleOf(engine) {
  if (engine === null || engine === void 0) return null;
  if (typeof engine === "object" && "handle" in engine) return engine.handle ?? null;
  return engine;
}
function splitStatusAndOut(returned, slot, outKey) {
  if (returned !== null && typeof returned === "object" && ("status" in returned || outKey in returned)) {
    return { status: (returned.status ?? 0) >>> 0, out: returned[outKey] ?? null };
  }
  return { status: (typeof returned === "number" ? returned : 0) >>> 0, out: slot?.[0] ?? null };
}
function resolveNetworkPolicy(options = {}) {
  const {
    requested = "OBSERVED_ONLINE",
    api = null,
    probe = null,
    guids = null,
    target = "appcontainer",
    pin = null,
    install = null,
    audit = null
  } = options ?? {};
  if (!NETWORK_TIERS.includes(requested)) {
    throw netError(
      "NETWORK_TIER_INVALID",
      `\u672A\u77E5\u7F51\u7EDC\u6863\u4F4D ${JSON.stringify(requested)}\uFF1A\u5FC5\u987B\u662F ${NETWORK_TIERS.join(" / ")} \u4E4B\u4E00 \u2014\u2014 \u62D2\u7EDD\u628A\u672A\u77E5\u6863\u4F4D\u5F53\u6210"\u4E0D\u963B\u65AD"\u6216"\u5DF2\u963B\u65AD"\uFF08fail-closed\uFF09`
    );
  }
  const effectiveGuids = normaliseGuids(guids);
  const isOffline = requested === "OFFLINE";
  let probeOutcome = null;
  let missingBindings = [];
  if (isOffline) {
    missingBindings = missingInstallBindings(api);
    if (missingBindings.length > 0) {
      return refusedResult(
        requested,
        `WFP_UNAVAILABLE: WFP \u7ED1\u5B9A\u8868\u4E0D\u53EF\u7528\uFF08\u7F3A\u5C11 ${missingBindings.join(", ")}\uFF09\uFF0C\u65E0\u6CD5\u8C03\u7528 FwpmFilterAdd0 \u5B89\u88C5\u963B\u65AD\u8FC7\u6EE4\u5668 \u2014\u2014 \u62D2\u7EDD\u58F0\u79F0\u7F51\u7EDC\u5DF2\u963B\u65AD\uFF08fail-closed\uFF09`,
        { missingBindings }
      );
    }
    if (resolvePin(api, pin) === null) {
      return refusedResult(
        requested,
        "WFP_PIN_REQUIRED: \u7F3A\u5C11 pin(buffer)->\u539F\u751F\u5730\u5740 \u56DE\u8C03\uFF08\u4E5F\u672A\u6302\u5728\u7ED1\u5B9A\u8868 api.pin \u4E0A\uFF09\uFF1AFWPM_FILTER0.filterCondition / FWPM_DISPLAY_DATA0.name/description / FWPM_SUBLAYER0.displayData \u90FD\u662F\u5185\u5D4C\u6307\u9488\uFF0CJS Buffer \u62FF\u4E0D\u5230\u539F\u751F\u5730\u5740 \u21D2 \u8BA1\u5212\u4E0D\u53EF\u5B89\u88C5\uFF0C\u62D2\u7EDD\u58F0\u79F0\u5DF2\u963B\u65AD",
        { missingBindings: ["pin"] }
      );
    }
    probeOutcome = runProbe(api, probe);
    if (probeOutcome.available !== true) {
      const statusText = probeOutcome.status === void 0 || probeOutcome.status === null ? "" : ` (status=0x${(probeOutcome.status >>> 0).toString(16)} ${describeWfpStatus(probeOutcome.status)})`;
      return refusedResult(
        requested,
        `WFP_UNAVAILABLE: WFP \u53EF\u7528\u6027\u63A2\u6D4B\u5931\u8D25 \u2014\u2014 ${probeOutcome.detail ?? "(\u65E0 detail)"}${statusText} \u2014\u2014 \u62D2\u7EDD\u58F0\u79F0\u7F51\u7EDC\u5DF2\u963B\u65AD\uFF08fail-closed\uFF09`,
        { probe: probeOutcome, missingBindings }
      );
    }
    try {
      const engine = openEngine(api);
      try {
        engine.close();
      } catch {
      }
    } catch (error) {
      return refusedResult(
        requested,
        `WFP_UNAVAILABLE: \u5F15\u64CE\u65E0\u6CD5\u6253\u5F00\uFF08FwpmEngineOpen0\uFF09\u2014\u2014 ${error.message} \u2014\u2014 \u62D2\u7EDD\u58F0\u79F0\u7F51\u7EDC\u5DF2\u963B\u65AD\uFF08fail-closed\uFF09`,
        { probe: probeOutcome, missingBindings }
      );
    }
  }
  let plan = null;
  let planError = null;
  try {
    plan = planOfflineRules({ tier: requested, target, guids: effectiveGuids });
  } catch (error) {
    planError = error;
  }
  if (planError) {
    if (planError.code === "WFP_TIER_NOT_IMPLEMENTED" || !isOffline) {
      return {
        tier: requested,
        state: NETWORK_TIER_STATES.NOT_IMPLEMENTED,
        enforced: false,
        verified: false,
        reason: `\u6863\u4F4D ${requested} \u672A\u5B9E\u73B0\uFF08${planError.code ?? "WFP_TIER_NOT_IMPLEMENTED"}\uFF09\uFF1A${planError.message} \u2014\u2014 \u8BE5\u6863\u4F4D\u4E0D\u4F5C\u51FA\u963B\u65AD\u58F0\u660E\uFF0C\u56E0\u6B64\u4ECD\u5141\u8BB8\u6267\u884C\uFF0C\u4F46\u7EDD\u4E0D\u62A5\u544A enforced=true`,
        plan: null
      };
    }
    return refusedResult(
      requested,
      `${planError.code ?? "WFP_PLAN_FAILED"}: ${planError.message} \u2014\u2014 \u8BA1\u5212\u4E0D\u53EF\u5B89\u88C5\uFF0C\u62D2\u7EDD\u58F0\u79F0\u5DF2\u963B\u65AD\uFF08fail-closed\uFF09`,
      { missing: planError.missing, probe: probeOutcome, missingBindings }
    );
  }
  const evidence = verifyInstallEvidence({ install, api, plan, guids: effectiveGuids, audit });
  let verdict;
  if (!evidence.ok) {
    const noEvidenceAtAll = evidence.reason === "missing-install";
    verdict = noEvidenceAtAll ? enforcementFromEvidence({ plan, install: null, audit: null }) : {
      state: NETWORK_TIER_STATES.NOT_ENFORCED,
      enforced: false,
      verified: false,
      reason: `\u5B89\u88C5\u8BC1\u636E\u4E0D\u88AB\u91C7\u4FE1\uFF08${evidence.reason}\uFF09\uFF1Aenforced:true \u53EA\u63A5\u53D7 installNetworkPolicy() \u4EB2\u81EA\u4EA7\u51FA\u3001\u4E14\u4E0E\u672C\u7ED1\u5B9A\u8868/\u672C\u8BA1\u5212\u540C\u6E90\u7684\u8BC1\u636E\uFF1B\u81EA\u9020\u6216\u8F6C\u53D1\u7684 { installed: [...] } \uFF08\u542B\u4F2A\u9020\u7684 audit\uFF09\u4E00\u5F8B\u6309"\u672A\u5F3A\u5236"\u5904\u7406\uFF08fail-closed\uFF0C\u89C1 src/netpolicy.ts \u7684 INSTALL_EVIDENCE_RECORDS\uFF09`
    };
  } else {
    verdict = enforcementFromEvidence({ plan, install: evidence.install, audit: evidence.audit });
  }
  return {
    tier: requested,
    state: verdict.state,
    enforced: verdict.enforced,
    verified: verdict.verified,
    reason: verdict.reason,
    plan,
    probe: probeOutcome,
    missingBindings
  };
}
function enforcementFromEvidence({ plan, install, audit }) {
  const expected = Array.isArray(plan?.filters) ? plan.filters.length : 0;
  const applied2 = appliedCount(install);
  if (!install) {
    return {
      state: NETWORK_TIER_STATES.NOT_ENFORCED,
      enforced: false,
      verified: false,
      reason: `OFFLINE \u8BA1\u5212\u5DF2\u89E3\u6790\u4E14\u524D\u7F6E\u6761\u4EF6\u6EE1\u8DB3\uFF08${expected} \u6761\u89C4\u5219\uFF09\uFF0C\u4F46**\u6CA1\u6709\u4EFB\u4F55\u5B89\u88C5\u8BC1\u636E**\uFF08\u672A\u8C03\u7528 FwpmFilterAdd0 / \u672A\u63D0\u4F9B install \u7ED3\u679C\uFF09\u2014\u2014 \u4E0D\u5F97\u58F0\u79F0\u7F51\u7EDC\u5DF2\u963B\u65AD`
    };
  }
  if (applied2 < expected) {
    return {
      state: NETWORK_TIER_STATES.NOT_ENFORCED,
      enforced: false,
      verified: false,
      reason: `\u53EA\u5B89\u88C5\u4E86 ${applied2}/${expected} \u6761\u8FC7\u6EE4\u5668\uFF08\u90E8\u5206\u5B89\u88C5\uFF09\uFF0C\u672A\u5B89\u88C5\u8005\u653E\u884C\u6D41\u91CF \u2014\u2014 \u4E0D\u58F0\u79F0\u5DF2\u5F3A\u5236`
    };
  }
  const auditResult = audit ?? null;
  if (!auditResult) {
    return {
      state: NETWORK_TIER_STATES.NOT_ENFORCED,
      enforced: false,
      verified: false,
      reason: `\u5DF2\u5B89\u88C5 ${applied2}/${expected} \u6761\u8FC7\u6EE4\u5668\uFF0C\u4F46\u6CA1\u6709\u4EFB\u4F55\u56DE\u8BFB\u6838\u5BF9\u7ED3\u679C\uFF08audit \u7F3A\u5931\uFF09\u2014\u2014 fail-closed\uFF1A\u4E0D\u58F0\u79F0\u5DF2\u5F3A\u5236`
    };
  }
  if (auditResult.verified === true) {
    return {
      state: NETWORK_TIER_STATES.ENFORCED,
      enforced: true,
      verified: true,
      reason: `\u5DF2\u5B89\u88C5 ${applied2}/${expected} \u6761\u8FC7\u6EE4\u5668\uFF0C\u5E76\u5DF2\u4ECE\u5F15\u64CE\u56DE\u8BFB\u6838\u5BF9\u901A\u8FC7\uFF08\u5B58\u5728\u6027 + \u5C42/\u5B50\u5C42\u4E00\u81F4\uFF09\u2014\u2014 \u7F51\u7EDC\u5DF2\u5F3A\u5236\u963B\u65AD`
    };
  }
  if (auditResult.reason === ENUMERATION_UNAVAILABLE_REASON) {
    return {
      state: NETWORK_TIER_STATES.ENFORCED,
      enforced: true,
      verified: false,
      reason: `\u5DF2\u5B89\u88C5 ${applied2}/${expected} \u6761\u8FC7\u6EE4\u5668\uFF1B\u4F46\u672C\u673A\u7ED1\u5B9A\u8868\u4E0D\u63D0\u4F9B\u8FC7\u6EE4\u5668\u56DE\u8BFB\u5165\u53E3\uFF08${ENUMERATION_UNAVAILABLE_REASON}\uFF09\u2014\u2014 \u5DF2\u5F3A\u5236\u4F46**\u672A\u72EC\u7ACB\u9A8C\u8BC1**\uFF08\u4E0D\u5F97\u8BFB\u6210"\u5DF2\u6838\u5BF9"\uFF09`
    };
  }
  return {
    state: NETWORK_TIER_STATES.NOT_ENFORCED,
    enforced: false,
    verified: false,
    reason: `\u56DE\u8BFB\u6838\u5BF9\u672A\u901A\u8FC7\uFF1A${auditResult.reason ?? "(\u65E0 reason)"} \u2014\u2014 \u4E0D\u58F0\u79F0\u5DF2\u5F3A\u5236`
  };
}
function appliedCount(install) {
  if (!install || typeof install !== "object") return 0;
  if (Array.isArray(install.installed)) return install.installed.length;
  if (install.installed && Array.isArray(install.installed.filters)) return install.installed.filters.length;
  if (Array.isArray(install.filterIds)) return install.filterIds.length;
  return 0;
}
function installNetworkPolicy({ api, plan, guids, pin = null, retainPointer = () => {
} } = {}) {
  const missing = missingInstallBindings(api);
  if (missing.length > 0) {
    throw netError(
      "NETWORK_POLICY_INSTALL_FAILED",
      `WFP \u7ED1\u5B9A\u8868\u7F3A\u5C11 ${missing.join(", ")}\uFF1A\u62D2\u7EDD\u5B89\u88C5\u65E0\u6CD5\u56DE\u6EDA\u7684\u7F51\u7EDC\u8FC7\u6EE4\u5668\uFF08fail-closed\uFF09`,
      { stage: "precondition", originalCode: "WFP_UNAVAILABLE", missingBindings: missing, installed: [], teardownFailures: [] }
    );
  }
  if (!plan || typeof plan !== "object" || plan.tier !== "OFFLINE" || !Array.isArray(plan.filters)) {
    throw netError(
      "NETWORK_POLICY_INSTALL_FAILED",
      'installNetworkPolicy \u53EA\u63A5\u53D7 planOfflineRules() \u4EA7\u51FA\u7684 OFFLINE \u8BA1\u5212\uFF08plan.tier === "OFFLINE" \u4E14 plan.filters \u4E3A\u6570\u7EC4\uFF09\u2014\u2014 \u4E0D\u731C\u3001\u4E0D\u964D\u7EA7',
      { stage: "precondition", originalCode: "NETWORK_POLICY_PLAN_INVALID", installed: [], teardownFailures: [] }
    );
  }
  if (resolvePin(api, pin) === null) {
    throw netError(
      "NETWORK_POLICY_INSTALL_FAILED",
      "WFP_PIN_REQUIRED: \u7F3A\u5C11 pin(buffer)->\u539F\u751F\u5730\u5740 \u56DE\u8C03\uFF0C\u5185\u5D4C\u6307\u9488\u65E0\u6CD5\u6784\u9020\uFF0C\u62D2\u7EDD\u5F00\u59CB\u5B89\u88C5\uFF08\u6539\u52A8\u7CFB\u7EDF\u72B6\u6001\u4E4B\u524D\u5C31\u62D2\u7EDD\uFF09",
      { stage: "precondition", originalCode: "WFP_PIN_REQUIRED", installed: [], teardownFailures: [] }
    );
  }
  let engine;
  try {
    engine = openEngine(api);
  } catch (error) {
    throw netError("NETWORK_POLICY_INSTALL_FAILED", `\u5F15\u64CE\u65E0\u6CD5\u6253\u5F00\uFF0C\u672A\u5B89\u88C5\u4EFB\u4F55\u8FC7\u6EE4\u5668\uFF1A${error.message}`, {
      stage: "engine-open",
      originalCode: error.code ?? "WFP_UNAVAILABLE",
      cause: error,
      installed: [],
      teardownFailures: [],
      policyTeardown: null
    });
  }
  const engineCloser = Object.freeze({
    handle: engineHandleOf(engine),
    close: typeof engine.close === "function" ? engine.close.bind(engine) : null
  });
  const recorded = [];
  let tornDown = false;
  let evidenceRecord = null;
  let evidenceResult = null;
  const installedSubLayerKey = plan.subLayerKey;
  const teardown = () => {
    if (tornDown) {
      return { removed: [], subLayerRemoved: false, subLayerIdempotent: false, engineClosed: false, failures: [], skipped: true };
    }
    tornDown = true;
    if (evidenceResult !== null) INVALIDATED_INSTALL_EVIDENCE.add(evidenceResult);
    const failures = [];
    const removed = [];
    for (const item of [...recorded].reverse()) {
      try {
        deleteFilterById(api, engineCloser.handle, item.id);
        removed.push(item.id);
      } catch (error) {
        failures.push(`FwpmFilterDeleteById0(${String(item.id)}) \u5931\u8D25\uFF1A${error.message}`);
      }
    }
    let subLayerRemoved = false;
    let subLayerIdempotent = false;
    try {
      const result = deleteSubLayerByKey(api, engineCloser.handle, installedSubLayerKey);
      subLayerRemoved = true;
      subLayerIdempotent = result?.idempotent === true;
    } catch (error) {
      failures.push(`FwpmSubLayerDeleteByKey0(${installedSubLayerKey}) \u5931\u8D25\uFF1A${error.message}`);
    }
    let engineClosed = false;
    try {
      if (engineCloser.close === null) {
        failures.push("FwpmEngineClose0 \u4E0D\u53EF\u7528\uFF1A\u5B89\u88C5\u65F6\u672A\u6355\u83B7\u5230 engine.close\uFF08\u4E0D\u5047\u88C5\u5DF2\u5173\u95ED\uFF09");
      } else {
        const result = engineCloser.close();
        engineClosed = (result?.failures?.length ?? 1) === 0;
        for (const failure of result?.failures ?? []) failures.push(`FwpmEngineClose0 \u5931\u8D25\uFF1A${failure}`);
      }
    } catch (error) {
      failures.push(`FwpmEngineClose0 \u629B\u9519\uFF1A${error.message}`);
    }
    return { removed, subLayerRemoved, subLayerIdempotent, engineClosed, failures, skipped: false };
  };
  try {
    const applied2 = applyOfflinePlan(api, engine, plan, guids, retainPointer, pin);
    for (const filter of applied2.filters ?? []) {
      recorded.push({ id: filter.filterId, key: filter.key, layerKey: filter.layerKey });
    }
    let auditResult;
    try {
      auditResult = auditNetworkPolicy({ api, engine, plan, guids, filterIds: recorded.map((item) => item.id) });
    } catch (error) {
      throw netError("NETWORK_POLICY_VERIFY_FAILED", `\u56DE\u8BFB\u6838\u5BF9\u629B\u9519\uFF1A${error.message}`, {
        stage: "verify",
        originalCode: error.code ?? "NETWORK_POLICY_AUDIT_FAILED",
        cause: error
      });
    }
    if (auditResult.verified === false && auditResult.reason !== ENUMERATION_UNAVAILABLE_REASON) {
      throw netError(
        "NETWORK_POLICY_VERIFY_FAILED",
        `\u5DF2\u8C03\u7528 FwpmFilterAdd0 \u4F46\u5F15\u64CE\u56DE\u8BFB\u6838\u5BF9\u672A\u901A\u8FC7\uFF08${auditResult.reason}\uFF09\u2014\u2014 \u6309 fail-closed \u7ACB\u5373\u56DE\u6EDA\uFF0C\u7EDD\u4E0D\u7559\u4E0B"\u770B\u8D77\u6765\u88C5\u4E0A\u4E86"\u7684\u8FC7\u6EE4\u5668`,
        { stage: "verify", originalCode: "NETWORK_POLICY_VERIFY_FAILED", audit: auditResult }
      );
    }
    const result = {
      installed: recorded.map((item) => ({ key: item.key, layerKey: item.layerKey, filterId: item.id })),
      subLayerKey: applied2.subLayerKey ?? plan.subLayerKey,
      filterIds: recorded.map((item) => item.id),
      teardown,
      /** 以下为附加字段（便于审计 / 能力报告接线），不属于规定返回形状 */
      plan,
      engine,
      audit: auditResult
    };
    evidenceRecord = Object.freeze({
      api,
      planFingerprint: planFingerprint(plan, guids),
      engine,
      engineCloser,
      audit: auditVerdictSnapshot(auditResult),
      auditFingerprint: auditVerdictFingerprint(auditResult),
      evidence: Object.freeze({
        installed: Object.freeze(recorded.map((item) => Object.freeze({ key: item.key, layerKey: item.layerKey, filterId: item.id }))),
        filterIds: Object.freeze(recorded.map((item) => item.id))
      })
    });
    INSTALL_EVIDENCE_RECORDS.set(result, evidenceRecord);
    evidenceResult = result;
    Object.defineProperty(result, INSTALL_EVIDENCE_BRAND, { value: true, enumerable: false, writable: false, configurable: false });
    return result;
  } catch (error) {
    const cleanup = teardown();
    const failures = [
      ...Array.isArray(error?.rollbackFailures) ? error.rollbackFailures.map((text) => `applyOfflinePlan \u56DE\u6EDA\uFF1A${text}`) : [],
      ...cleanup.failures
    ];
    if (error && error.code === "NETWORK_POLICY_VERIFY_FAILED") {
      error.teardownFailures = failures;
      error.policyTeardown = cleanup;
      error.installed = recorded.map((item) => item.id);
      throw error;
    }
    throw netError("NETWORK_POLICY_INSTALL_FAILED", `${error?.code ?? "WFP_ERROR"}: ${error?.message ?? String(error)}`, {
      stage: "apply",
      originalCode: error?.code ?? null,
      cause: error,
      installed: recorded.map((item) => item.id),
      teardownFailures: failures,
      policyTeardown: cleanup,
      rollbackFailures: Array.isArray(error?.rollbackFailures) ? error.rollbackFailures : []
    });
  }
}
function auditNetworkPolicy({ api, engine, plan, guids = null, filterIds = null } = {}) {
  const subLayerKey = plan?.subLayerKey ?? null;
  const handle = engineHandleOf(engine);
  const expected = Array.isArray(plan?.filters) ? plan.filters.length : 0;
  if (!plan || !Array.isArray(plan.filters)) {
    return { installed: false, filterCount: 0, subLayerKey, verified: false, reason: "plan-missing" };
  }
  if (expected === 0) {
    return { installed: false, filterCount: 0, subLayerKey, verified: false, reason: "plan-empty" };
  }
  if (handle === null) {
    return { installed: false, filterCount: 0, subLayerKey, verified: false, reason: "no-engine" };
  }
  const hasGetByKey = typeof api?.fwpmFilterGetByKey0 === "function";
  const hasEnum = typeof api?.fwpmFilterEnum0 === "function";
  if (!hasGetByKey && !hasEnum) {
    return { installed: false, filterCount: 0, subLayerKey, verified: false, reason: ENUMERATION_UNAVAILABLE_REASON };
  }
  let rawEntries = [];
  let lookupNote = "";
  try {
    if (hasGetByKey) {
      const statuses = [];
      for (const rule of plan.filters) {
        const slot = [null];
        const returned = api.fwpmFilterGetByKey0(handle, coerceGuid(rule.key, "filterKey"), slot);
        const { status, out } = splitStatusAndOut(returned, slot, "filter");
        if (status === 0 && out) rawEntries.push(out);
        else if (status !== 0) statuses.push(`0x${status.toString(16)}:${describeWfpStatus(status)}`);
      }
      if (statuses.length > 0) lookupNote = `\uFF1B\u56DE\u8BFB\u72B6\u6001\uFF1A${statuses.join(", ")}`;
    } else {
      const slot = [null];
      const returned = api.fwpmFilterEnum0(handle, null, slot);
      const { status, out } = splitStatusAndOut(returned, slot, "entries");
      if (status !== 0) {
        return {
          installed: false,
          filterCount: 0,
          subLayerKey,
          verified: false,
          reason: `enumeration-failed:FwpmFilterEnum0 -> 0x${status.toString(16)}`
        };
      }
      rawEntries = Array.isArray(out) ? out : Array.isArray(out?.entries) ? out.entries : [];
    }
  } catch (error) {
    return { installed: false, filterCount: 0, subLayerKey, verified: false, reason: `enumeration-failed:${error.message}` };
  }
  const planned = new Map(plan.filters.map((rule) => [guidText(rule.key) ?? rule.key, rule]));
  const expectedLayers = new Map(
    plan.filters.map((rule) => [
      guidText(rule.key) ?? rule.key,
      guids && typeof guids === "object" ? guidText(guids[rule.layerKey]) : null
    ])
  );
  const matched = /* @__PURE__ */ new Map();
  let fieldsIncomplete = false;
  let fieldsMismatch = false;
  let layerChecked = false;
  for (const entry of rawEntries) {
    if (!entry || typeof entry !== "object") continue;
    const key = guidText(entry.filterKey ?? entry.key);
    if (key === null) {
      fieldsIncomplete = true;
      continue;
    }
    const rule = planned.get(key);
    if (!rule) continue;
    const layerKey = guidText(entry.layerKey ?? entry.layer);
    const entrySubLayer = guidText(entry.subLayerKey ?? entry.subLayer);
    if (layerKey === null || entrySubLayer === null) {
      fieldsIncomplete = true;
      matched.set(key, rule);
      continue;
    }
    const wantedLayer = expectedLayers.get(key) ?? null;
    if (wantedLayer !== null) {
      layerChecked = true;
      if (layerKey !== wantedLayer) fieldsMismatch = true;
    }
    if (subLayerKey !== null && entrySubLayer !== subLayerKey) fieldsMismatch = true;
    matched.set(key, rule);
  }
  const installed = matched.size === expected;
  let reason;
  if (!installed) reason = `filters-missing:${matched.size}/${expected}${lookupNote}`;
  else if (fieldsIncomplete) reason = "enumeration-fields-incomplete";
  else if (fieldsMismatch) reason = "filter-fields-mismatch";
  else reason = "verified";
  return {
    installed,
    filterCount: rawEntries.length,
    subLayerKey,
    verified: installed && !fieldsIncomplete && !fieldsMismatch,
    reason,
    layerChecked,
    // 纯附注：这里的 id 只用于报告/日志，**不是**删除凭据（删除凭据在 installNetworkPolicy
    // 的 `filterIds` 里，保持 UINT64 的 BigInt 原样）。转成字符串是为了让审计结果能直接
    // `JSON.stringify` 进能力报告 —— BigInt 会让 JSON 序列化抛错。
    filterIds: Array.isArray(filterIds) ? filterIds.map((id) => typeof id === "bigint" ? id.toString() : id) : null
  };
}
var STATE_LABELS = Object.freeze({
  [NETWORK_TIER_STATES.ENFORCED]: "\u5DF2\u5F3A\u5236",
  [NETWORK_TIER_STATES.NOT_ENFORCED]: "\u672A\u5F3A\u5236",
  [NETWORK_TIER_STATES.REFUSED]: "\u5DF2\u62D2\u7EDD\uFF08\u80FD\u529B\u4E0D\u8DB3\uFF0C\u62D2\u7EDD\u58F0\u79F0\u5DF2\u963B\u65AD\uFF09",
  [NETWORK_TIER_STATES.NOT_IMPLEMENTED]: "\u672A\u5B9E\u73B0\uFF08\u4E0D\u4F5C\u963B\u65AD\u58F0\u660E\uFF09"
});
function summariseNetworkPolicy(result) {
  if (!result || typeof result !== "object") {
    return {
      tier: null,
      state: NETWORK_TIER_STATES.NOT_ENFORCED,
      enforced: false,
      verified: false,
      reason: "\u7F3A\u5C11\u7F51\u7EDC\u7B56\u7565\u89E3\u6790\u7ED3\u679C \u2014\u2014 \u4E0D\u5F97\u636E\u6B64\u58F0\u79F0\u7F51\u7EDC\u5DF2\u5F3A\u5236\uFF08fail-closed\uFF09"
    };
  }
  return {
    tier: result.tier ?? null,
    state: result.state ?? NETWORK_TIER_STATES.NOT_ENFORCED,
    enforced: result.enforced === true,
    verified: result.verified === true,
    reason: typeof result.reason === "string" ? result.reason : ""
  };
}

// src/executor.ts
var require_2 = createRequire2(import.meta.url);
var DIALOG_SUPPRESSION_APPLIED = suppressWindowsCriticalErrorDialogs();
var ACL_PACKAGE = "@deepseek-ai/dsh-sandbox-windows-acl";
var WIN32_PACKAGE = "@deepseek-ai/dsh-win32-process";
function resolveDshModuleRoot() {
  const candidates = [];
  if (process.env.DSH_SANDBOX_NODE_ROOT) candidates.push(process.env.DSH_SANDBOX_NODE_ROOT);
  if (process.env.DSH_PROFILE_DIR) {
    candidates.push(join6(process.env.DSH_PROFILE_DIR, "node_modules"));
    candidates.push(join6(dirname4(process.env.DSH_PROFILE_DIR), "node_modules"));
  }
  const cli = resolveDshCliPath();
  if (cli) {
    candidates.push(dirname4(dirname4(cli)));
    candidates.push(join6(cli, "node_modules"));
  }
  return candidates.filter((value) => typeof value === "string" && value.length > 0);
}
function resolveDshCliPath() {
  const direct = join6(process.env.APPDATA || "", "npm", "node_modules", "@deepseek-ai", "dsh");
  if (existsSync3(direct)) return direct;
  const caches = [process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean).map((base) => join6(base, "npm-cache", "_npx"));
  for (const cache of caches) {
    if (!existsSync3(cache)) continue;
    let entries = [];
    try {
      entries = readdirSync3(cache);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = join6(cache, entry, "node_modules", "@deepseek-ai", "dsh");
      if (existsSync3(candidate)) return candidate;
    }
  }
  return void 0;
}
function requireFromRoots(spec, roots) {
  const errors = [];
  for (const root of roots) {
    try {
      const scoped = createRequire2(join6(root, "noop.js"));
      const loaded = scoped(spec);
      return { module: loaded, from: root };
    } catch (error) {
      errors.push(`${root}: ${error.code || error.message}`);
    }
  }
  try {
    return { module: require_2(spec), from: "self" };
  } catch (error) {
    const failure = new Error(`cannot resolve ${spec}
  tried:
    ${errors.join("\n    ")}
  self: ${error.message}`);
    failure.code = "MODULE_NOT_FOUND";
    throw failure;
  }
}
function loadWindowsSandboxModules() {
  const roots = resolveDshModuleRoot();
  const out = { __roots: roots };
  for (const spec of [ACL_PACKAGE, WIN32_PACKAGE]) {
    try {
      out[spec] = requireFromRoots(spec, roots);
    } catch (error) {
      out[spec] = { error };
    }
  }
  return out;
}
var ENV_ALLOWLIST = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  // PATH 必须保留：CreateProcessAsUserW 不做 PATHEXT 解析，我们靠它在宿主侧
  // 把裸命令名解析成绝对路径（`[实测]` 缺陷 6）；不保留则任何工具都找不到。
  "PATH",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "OS",
  "USERNAME",
  "USERDOMAIN",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "PUBLIC",
  "TZ",
  "LANG",
  "LC_ALL",
  "TERM",
  "DSH_PROFILE"
];
var ENV_DENYLIST_PATTERNS = [
  /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i,
  /^AWS_|^AZURE_|^GOOGLE_|^GCP_|^GITHUB_|^GH_|^NPM_TOKEN|^DOCKER_/i,
  /^HTTP_PROXY$|^HTTPS_PROXY$|^ALL_PROXY$|^NO_PROXY$/i,
  /^NODE_OPTIONS$|^NODE_PATH$/
];
function isSensitiveEnvName(name) {
  return ENV_DENYLIST_PATTERNS.some((pattern) => pattern.test(name));
}
function buildChildEnvironment(overrides = {}, options = {}) {
  const env = {};
  for (const name of ENV_ALLOWLIST) {
    const value = process.env[name];
    if (typeof value === "string") env[name] = value;
  }
  const rejected = [];
  for (const [name, value] of Object.entries(overrides)) {
    if (value === void 0 || value === null) continue;
    if (!options.allowSensitive && isSensitiveEnvName(name)) {
      rejected.push(name);
      continue;
    }
    env[name] = String(value);
  }
  if (options.tempDir) {
    env.TMP = options.tempDir;
    env.TEMP = options.tempDir;
  }
  if (options.cwd) env.PWD = options.cwd;
  return { env, rejected };
}
var JOB_OBJECT_LIMIT_PROCESS_TIME = 2;
var JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 8;
var JOB_OBJECT_LIMIT_PROCESS_MEMORY = 256;
var JOB_OBJECT_LIMIT_JOB_MEMORY = 512;
var JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 8192;
var JobObjectExtendedLimitInformation = 9;
var JobObjectBasicAccountingInformation = 1;
var CREATE_UNICODE_ENVIRONMENT = 1024;
var JOB_BASIC_ACCOUNTING_SIZE = 48;
var OFF_ACCOUNTING = {
  totalPageFaultCount: 32,
  totalProcesses: 36,
  activeProcesses: 40,
  totalTerminatedProcesses: 44
};
var OFF = {
  basicLimitInformation: 0,
  perProcessUserTimeLimit: 0,
  perJobUserTimeLimit: 8,
  limitFlags: 16,
  minimumWorkingSetSize: 24,
  maximumWorkingSetSize: 32,
  activeProcessLimit: 36,
  affinity: 40,
  priorityClass: 48,
  // IO_COUNTERS: 64..112
  processMemoryLimit: 112,
  jobMemoryLimit: 120,
  peakProcessMemoryUsed: 128,
  peakJobMemoryUsed: 136,
  size: 144
};
function buildExtendedLimitInformation(options = {}) {
  const buffer = Buffer.alloc(OFF.size);
  let flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (options.activeProcessLimit) flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
  if (options.processMemoryLimit) flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
  if (options.jobMemoryLimit) flags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
  if (options.perProcessTimeLimitMs) flags |= JOB_OBJECT_LIMIT_PROCESS_TIME;
  buffer.writeUInt32LE(flags >>> 0, OFF.limitFlags);
  if (options.perProcessTimeLimitMs) {
    buffer.writeBigInt64LE(BigInt(options.perProcessTimeLimitMs) * 10000n, OFF.perProcessUserTimeLimit);
  }
  if (options.activeProcessLimit) buffer.writeUInt32LE(options.activeProcessLimit >>> 0, OFF.activeProcessLimit);
  if (options.processMemoryLimit) buffer.writeBigUInt64LE(BigInt(options.processMemoryLimit), OFF.processMemoryLimit);
  if (options.jobMemoryLimit) buffer.writeBigUInt64LE(BigInt(options.jobMemoryLimit), OFF.jobMemoryLimit);
  return { buffer, flags };
}
function parseBasicAccounting(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("accounting buffer must be a Buffer");
  if (buffer.length !== JOB_BASIC_ACCOUNTING_SIZE) {
    throw new Error(`accounting buffer must be exactly ${JOB_BASIC_ACCOUNTING_SIZE} bytes, got ${buffer.length}`);
  }
  const readField = (name) => {
    const offset = OFF_ACCOUNTING[name];
    if (offset + 4 > buffer.length) {
      throw new Error(
        `accounting field ${name} at offset ${offset} exceeds the ${buffer.length}-byte struct; offsets are wrong`
      );
    }
    return buffer.readUInt32LE(offset);
  };
  return {
    totalProcesses: readField("totalProcesses"),
    activeProcesses: readField("activeProcesses"),
    terminatedProcesses: readField("totalTerminatedProcesses"),
    totalPageFaultCount: readField("totalPageFaultCount")
  };
}
var GENERIC_READ = 2147483648;
var OPEN_EXISTING = 3;
function quoteWindowsArgument(value) {
  const text = String(value);
  if (text.length > 0 && !/[\s"]/.test(text)) return text;
  let out = '"';
  let backslashes = 0;
  for (const ch of text) {
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    out += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  out += "\\".repeat(backslashes * 2) + '"';
  return out;
}
function buildWindowsCommandLine(applicationName, args = []) {
  return [quoteWindowsArgument(applicationName), ...args.map(quoteWindowsArgument)].join(" ");
}
var AppContainerLauncher = class {
  /**
   * @param {object} koffi 已加载的 koffi
   * @param {object} api 低层绑定表（`createJobObjectW` / `assignProcessToJobObject` / `closeHandle`…）
   * @param {{profileName?:string, capabilities?:string[], tempDir?:string, grantPaths?:string[], job?:unknown}} options
   */
  constructor(koffi, api, options = {}) {
    if (!koffi || typeof koffi.load !== "function") throw fail("T0_UNAVAILABLE", "koffi is required for the AppContainer launch path");
    this.koffi = koffi;
    this.api = api;
    this.options = options;
    this.profileName = options.profileName || `dsh.stage.t0.${Date.now().toString(36)}${randomUUID3().slice(0, 4)}`;
    this.capabilities = options.capabilities ?? [];
    this.kernel32 = koffi.load("kernel32.dll");
    this.ResumeThread = this.kernel32.func("uint32 ResumeThread(void *thread)");
    this.TerminateProcess = this.kernel32.func("bool TerminateProcess(void *process, uint32 code)");
    this.WaitForSingleObject = this.kernel32.func("uint32 WaitForSingleObject(void *handle, uint32 ms)");
    this.GetExitCodeProcess = this.kernel32.func("bool GetExitCodeProcess(void *process, _Out_ uint32 *code)");
    this.CloseHandleRaw = this.kernel32.func("bool CloseHandle(void *handle)");
    this.CreateFileW = this.kernel32.func(
      "void *CreateFileW(const char16_t *name, uint32 access, uint32 share, void *sa, uint32 disposition, uint32 flags, void *template)"
    );
    this.CreatePipe = this.kernel32.func("bool CreatePipe(_Out_ void **readPipe, _Out_ void **writePipe, void *sa, uint32 size)");
    this.PeekNamedPipe = this.kernel32.func(
      "bool PeekNamedPipe(void *pipe, void *buffer, uint32 bufferSize, void *bytesRead, _Out_ uint32 *totalAvailable, void *bytesLeftThisMessage)"
    );
    this.ReadFile = this.kernel32.func(
      "bool ReadFile(void *file, _Out_ uint8 *buffer, uint32 toRead, _Out_ uint32 *read, void *overlapped)"
    );
    this.GetCurrentProcess = this.kernel32.func("void *GetCurrentProcess()");
    this.GetStdHandle = this.kernel32.func("void *GetStdHandle(int which)");
    this.runtime = void 0;
    this.sidString = void 0;
    this.granted = [];
    this.exitHook = void 0;
    this.lastLaunch = void 0;
  }
  /** 由 `createAppContainerLauncher()`（异步工厂）注入 runtime 并立即做 ACL 授权 */
  attachRuntime(runtime, sidString) {
    this.runtime = runtime;
    this.sidString = sidString;
    const grants = [];
    for (const entry of this.options.grantPaths ?? []) {
      const target = typeof entry === "string" ? entry : entry?.path;
      const rights = typeof entry === "string" ? "M" : entry?.rights ?? "M";
      if (typeof target !== "string" || target.length === 0) continue;
      grants.push({ target, ...grantPathToAppContainerSid(target, sidString, rights) });
    }
    this.granted = grants;
    const failed = grants.filter((grant) => !grant.ok);
    if (failed.length > 0) {
      throw fail(
        "T0_UNAVAILABLE",
        `icacls could not grant the package SID access to: ${failed.map((g) => `${g.target} (${g.detail})`).join("; ")}. Without that grant the AppContainer child cannot even write inside the staged root, so the staged root would be unusable \u2014 refusing to start a T0 run (fail-closed).`
      );
    }
    if (this.exitHook) process.removeListener("exit", this.exitHook);
    this.exitHook = () => this._revokeGrantsOnExit();
    process.once("exit", this.exitHook);
    return { profileName: this.profileName, sid: sidString, grants };
  }
  /**
   * 退出兜底：只做**同步**的 ACL 撤销。任何失败都只能"少做"，
   * 绝不把异常抛进退出路径（那会把 exit code 弄脏）；漏掉的由 `init()` 的修复路径兜底。
   */
  _revokeGrantsOnExit() {
    for (const grant of this.granted ?? []) {
      try {
        icaclsRun([grant.target, "/remove:g", `*${this.sidString}`]);
      } catch {
      }
    }
    this.granted = [];
  }
  /** 撤销 `attachRuntime()` 建立的全部 ACL 授权（dispose 调用；失败如实返回） */
  revokeGrants() {
    const failures = [];
    for (const grant of this.granted) {
      const result = icaclsRun([grant.target, "/remove:g", `*${this.sidString}`]);
      if (!result.ok) failures.push(`${grant.target}: ${result.detail}`);
    }
    this.granted = [];
    return failures;
  }
  /**
   * 启动一个 T0 子进程并**等到它退出**，输出从可继承的匿名管道读回。
   *
   * 顺序（与 `planCombinationOrder()` 一致）：建属性列表 → `CREATE_SUSPENDED` →
   * `AssignProcessToJobObject` → `ResumeThread` → **边等边排空管道** → 取退出码。
   */
  launch({ command, args = [], cwd, job, timeoutMs = 12e4, env = null, beforeResume }) {
    if (!this.runtime) throw fail("T0_UNAVAILABLE", "launcher was not attached to an AppContainerRuntime (fail-closed)");
    const commandLine = buildWindowsCommandLine(command, args);
    const environmentBlock = env === null || env === void 0 ? null : encodeEnvironmentBlock(env);
    const stdio = openT0StdioPipes(this.CreatePipe, this.CreateFileW);
    const startupInfoStdio = buildT0StdioHandles(this.koffi, stdio);
    let child;
    try {
      child = this.runtime.spawn({
        commandLine,
        applicationName: command,
        cwd,
        // `[实测-阶段FIX-B]` 继承句柄 + 自有控制台：见文件顶部说明。
        inheritHandles: true,
        extraCreationFlags: CREATE_NEW_CONSOLE,
        startupInfoStdio,
        // 环境块（手册 #8.3：从允许清单**重建**，绝不继承父环境）。
        // 必须与 `CREATE_UNICODE_ENVIRONMENT` 成对（`buildCreationFlags` 会加那一位）——
        // 漏掉它 `CreateProcess` 返回 Win32 87，子进程根本创建不出来（缺陷 13）。
        environmentBlock: environmentBlock ?? null
      });
    } finally {
      try {
        this.CloseHandleRaw(stdio.write);
      } catch {
      }
    }
    try {
      return this._runChild({ child, job, timeoutMs, stdio, beforeResume });
    } finally {
      closeT0Stdio({ stdin: stdio.stdin, read: stdio.read }, this.CloseHandleRaw);
    }
  }
  _runChild({ child, job, timeoutMs, stdio, beforeResume }) {
    try {
      if (job) {
        if (this.api.assignProcessToJobObject(job, child.process) === 0) {
          throw win32Error(this.api, "AssignProcessToJobObject", `pid=${child.pid} (T0 path)`);
        }
      }
      if (typeof beforeResume === "function") {
        beforeResume({ pid: child.pid, process: child.process, thread: child.thread });
      }
      this.runtime.resume(child);
      const drained = this._waitAndDrain(child.process, timeoutMs, stdio);
      const codeSlot = [0];
      const got = this.GetExitCodeProcess(child.process, codeSlot);
      const exitCode = got === true || got === 1 ? codeSlot[0] : null;
      if (drained.timedOut) safeTerminate(this.TerminateProcess, child.process);
      this.lastLaunch = {
        pid: child.pid,
        jobAssigned: job !== void 0 && job !== null,
        waited: drained.lastWait,
        timedOut: drained.timedOut,
        capturedBytes: drained.captured.length,
        stdioKind: "single-inheritable-pipe (stdout+stderr merged)",
        inheritance: "inherit-handles+create-new-console+pipe-stdio",
        streamsSeparable: false
      };
      return { pid: child.pid, exitCode, timedOut: drained.timedOut, stdout: drained.captured, stderr: Buffer.alloc(0) };
    } catch (error) {
      safeTerminate(this.TerminateProcess, child.process);
      throw error;
    } finally {
      try {
        this.CloseHandleRaw(child.thread);
      } catch {
      }
      try {
        this.CloseHandleRaw(child.process);
      } catch {
      }
    }
  }
  /**
   * 有界等待 + **持续排空管道**。
   *
   * ── 为什么不能"先等退出再读"（这是 D11 的同一类死锁）──────────────────────────
   * 匿名管道缓冲区写满后，子进程会阻塞在 `WriteFile` 上等待有人读；而父进程若先
   * `WaitForSingleObject(INFINITE)`，就再也没有人去读 ⇒ 双方互等，直到外层超时。
   * 实测表征与小输出无关：**只有输出超过管道缓冲才会触发**（本仓库 D11 的教训）。
   * 因此这里每睡 `T0_WAIT_SLICE_MS` 就排空一次两条管道，直到进程退出或超时。
   *
   * 排空用 `PeekNamedPipe` 先问"有多少可读"，再按这个长度 `ReadFile`：
   * 直接用阻塞 `ReadFile` 会在"子进程还活着但暂时没输出"时把我们自己挂住。
   */
  _waitAndDrain(processHandle, timeoutMs, stdio) {
    const deadline = Date.now() + timeoutMs;
    const captured = [];
    let lastWait = null;
    let timedOut = false;
    for (; ; ) {
      lastWait = this.WaitForSingleObject(processHandle, T0_WAIT_SLICE_MS);
      drainPipeAvailable(this.PeekNamedPipe, this.ReadFile, stdio.read, captured);
      if (lastWait === 0) break;
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
    }
    drainPipeAvailable(this.PeekNamedPipe, this.ReadFile, stdio.read, captured);
    return { captured: Buffer.concat(captured), timedOut, lastWait };
  }
  dispose() {
    const failures = [];
    if (this.runtime) {
      try {
        const result = this.runtime.dispose();
        for (const item of result?.failures ?? []) failures.push(`runtime: ${item}`);
      } catch (error) {
        failures.push(`runtime.dispose threw: ${error.message}`);
      }
    }
    failures.push(...this.revokeGrants());
    if (this.exitHook) {
      process.removeListener("exit", this.exitHook);
      this.exitHook = void 0;
    }
    this.runtime = void 0;
    return failures;
  }
};
function safeTerminate(TerminateProcess, process2) {
  try {
    TerminateProcess(process2, 1);
  } catch {
  }
}
function openT0StdioPipes(CreatePipe, CreateFileW) {
  const securityAttributes = makeInheritableSecurityAttributes();
  const readSlot = [null];
  const writeSlot = [null];
  const ok = CreatePipe(readSlot, writeSlot, securityAttributes, 0);
  if (!win32Succeeded(ok) || !readSlot[0] || !writeSlot[0]) {
    throw fail("T0_UNAVAILABLE", "CreatePipe failed; without an inheritable pipe the AppContainer child has no usable stdout/stderr");
  }
  const stdin = CreateFileW("NUL", GENERIC_READ, 1 | 2, securityAttributes, OPEN_EXISTING, 0, null);
  if (!stdin) throw fail("T0_UNAVAILABLE", "CreateFileW(NUL) failed for the T0 child stdin");
  return { read: readSlot[0], write: writeSlot[0], stdin, merged: true };
}
function makeInheritableSecurityAttributes() {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32LE(24, 0);
  buffer.writeBigUInt64LE(0n, 8);
  buffer.writeUInt32LE(1, 16);
  return buffer;
}
function closeT0Stdio(stdio, closeHandle) {
  for (const handle of [stdio?.stdin, stdio?.read, stdio?.write]) {
    if (!handle) continue;
    try {
      closeHandle(handle);
    } catch {
    }
  }
}
function buildT0StdioHandles(koffi, stdio) {
  const address = koffi.address(stdio.write);
  if (typeof address !== "bigint") throw fail("T0_UNAVAILABLE", "koffi.address(handle) did not return a bigint");
  return {
    stdInput: ((value) => {
      const input = koffi.address(value);
      if (typeof input !== "bigint") throw fail("T0_UNAVAILABLE", "koffi.address(stdin) did not return a bigint");
      return input;
    })(stdio.stdin),
    // 两条流共用同一个写端：见 openT0StdioPipes 的第 3 条结论
    stdOutput: address,
    stdError: address
  };
}
function drainPipeAvailable(PeekNamedPipe, ReadFile, pipe, sink) {
  if (!pipe) return;
  const available = [0];
  const peeked = PeekNamedPipe(pipe, null, 0, null, available, null);
  if (!win32Succeeded(peeked)) return;
  let remaining = available[0] >>> 0;
  if (remaining === 0) return;
  const buffer = Buffer.alloc(Math.min(remaining, 65536));
  const readSlot = [0];
  while (remaining > 0) {
    const ok = ReadFile(pipe, buffer, buffer.length, readSlot, null);
    if (!win32Succeeded(ok) || readSlot[0] >>> 0 === 0) break;
    const count = readSlot[0] >>> 0;
    sink.push(Buffer.from(buffer.subarray(0, count)));
    remaining -= count;
  }
}
var T0_WAIT_SLICE_MS = 20;
function win32Succeeded(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return false;
}
var STAGE_GRANT_FAILED = "STAGE_GRANT_FAILED";
var STAGE_GRANT_REASONS = Object.freeze({
  /** 没有可用的授权目标（调用方既没给 override，`resolveStageRoot` 也没给出根） */
  NO_TARGET: "no-grant-target",
  /** 宿主进程都建不出这个根（WP0 的典型形态：受限子进程建缓存根 ⇒ EPERM） */
  ROOT_NOT_CREATABLE: "root-not-creatable",
  /** 拿不到本次运行要授权的写身份（能力 SID） */
  WRITE_SID_UNAVAILABLE: "write-sid-unavailable",
  /** 授权调用本身抛错 / 后端回报失败 */
  GRANT_CALL_FAILED: "grant-call-failed",
  /** 回读 DACL 成功，但里面**没有**那条允许 ACE（确定的失败，不是"测不出来"） */
  ACE_NOT_VERIFIED: "ace-not-verified",
  /** 回读不了 DACL、或 writeSid 不是合法 SID ⇒ **如实报未验证**（不是"已验证通过"） */
  ACE_NOT_VERIFIABLE: "ace-not-verifiable"
});
var SID_TEXT_PATTERN = /^S-1-\d+(?:-\d+)+$/;
function isSidString(value) {
  return typeof value === "string" && SID_TEXT_PATTERN.test(value);
}
function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === void 0 || value === null) continue;
    if (String(value).trim() === "") continue;
    return String(value);
  }
  return void 0;
}
function stageGrantTarget(options = {}) {
  const explicit = firstNonEmpty(options.stagingRoot, options.override);
  if (explicit !== void 0) {
    return { root: normalize4(resolve2(explicit)), source: "explicit-override", override: true, keyed: true };
  }
  const env = options.env;
  const keyed = firstNonEmpty(options.sessionKey, options.workspaceRoot, env?.DSH_SESSION_ID, env?.WINSTAGE_SESSION_ID, env?.DSH_SESSION, process.env.DSH_SESSION_ID, process.env.WINSTAGE_SESSION_ID, process.env.DSH_SESSION) !== void 0;
  return {
    root: resolveStageRoot({ sessionKey: options.sessionKey, workspaceRoot: options.workspaceRoot, env }),
    source: "resolve-stage-root",
    override: false,
    /**
     * `keyed`：这条缓存根是不是**按会话/工作区定键**的。
     *
     * 为什么需要它：`resolveStageRoot()` 在既没有会话键、也没有工作区根时返回的是
     * 通用的 `<baseDir>\default` —— **所有无键调用方会共用同一个根**。那不是"会话根"，
     * 拿它当暂存面会把两个会话的暂存混在一起。因此未定键时调用方（`WindowsStageExecutor`）
     * **照旧拒绝启动**（`SANDBOX_UNAVAILABLE: stagingRoot is required`，与接线前逐字一致），
     * 而不是悄悄用上这个共享根。注意这与"授权失败"是两件事：那是**配置缺失**，这是
     * `STAGE_GRANT_FAILED` 的范畴（根有了却没授权上）。
     */
    keyed
  };
}
function stageGrantError(reason, detail = {}) {
  const error = new Error(`the protected session directory could not be prepared for writing (${reason})`);
  error.name = "StageGrantError";
  error.code = STAGE_GRANT_FAILED;
  error.reason = reason;
  if (detail.root !== void 0) error.root = detail.root;
  if (detail.writeSid !== void 0) error.writeSid = detail.writeSid;
  if (detail.detail !== void 0) error.detail = detail.detail;
  if (detail.steps !== void 0) error.steps = detail.steps;
  error.policyDenial = false;
  error.distinctFrom = {
    [STAGE_ROOT_LOST]: "\u6839/\u54E8\u5175/\u5B88\u62A4\u5728\u5EFA\u7ACB**\u4E4B\u540E**\u5931\u6548\uFF08\u4E22\u5931\u5373\u663E\u5F62\uFF0CWP0\uFF09",
    [STAGE_GUARD_UNAVAILABLE]: "\u6839/\u5B88\u62A4\u5728\u672C\u6B21\u8FD0\u884C**\u4E4B\u524D**\u5C31\u5EFA\u4E0D\u8D77\u6765\uFF08WP0\uFF09",
    [STAGE_GRANT_FAILED]: "\u6839\u5728\uFF0C\u4F46**\u6CA1\u88AB\u6388\u6743\u7ED9\u672C\u6B21\u8FD0\u884C\u7684\u8EAB\u4EFD** \u2014\u2014 \u6388\u6743\u94FE\u672A\u63A5\u901A\uFF08WP1\uFF09"
  };
  return error;
}
function verifyStageGrantAce(options = {}) {
  const root = options.root;
  const writeSid = options.writeSid;
  if (!isSidString(writeSid)) {
    return {
      verified: false,
      measured: false,
      reason: STAGE_GRANT_REASONS.ACE_NOT_VERIFIABLE,
      root,
      writeSid,
      detail: `the write identity is not a syntactically valid SID, so no access entry can be looked up by name: ${String(writeSid)}`
    };
  }
  const read = options.readSddl ?? ((target) => readDaclSddl(target, options));
  let readBack;
  try {
    readBack = read(root);
  } catch (error) {
    return {
      verified: false,
      measured: false,
      reason: STAGE_GRANT_REASONS.ACE_NOT_VERIFIABLE,
      root,
      writeSid,
      detail: `reading back the access control list threw: ${error.code ?? ""} ${error.message}`.trim()
    };
  }
  if (!readBack || readBack.ok !== true) {
    return {
      verified: false,
      measured: false,
      reason: STAGE_GRANT_REASONS.ACE_NOT_VERIFIABLE,
      root,
      writeSid,
      detail: `could not read back the access control list of ${root}: ${readBack?.detail ?? "(no detail)"}`
    };
  }
  const parse = options.parseSddl ?? parseSddlDaclAces;
  let aces = [];
  let unparsed = [];
  try {
    const parsed = parse(readBack.sddl);
    aces = Array.isArray(parsed?.aces) ? parsed.aces : [];
    unparsed = Array.isArray(parsed?.unparsed) ? parsed.unparsed : [];
  } catch (error) {
    return {
      verified: false,
      measured: false,
      reason: STAGE_GRANT_REASONS.ACE_NOT_VERIFIABLE,
      root,
      writeSid,
      detail: `the access control list could not be parsed: ${error.message}`
    };
  }
  const wanted = String(writeSid).toUpperCase();
  const match = aces.find((ace) => ace.type === 0 && String(ace.sid).toUpperCase() === wanted);
  if (!match) {
    return {
      verified: false,
      measured: true,
      reason: STAGE_GRANT_REASONS.ACE_NOT_VERIFIED,
      root,
      writeSid,
      sddl: readBack.sddl,
      present: aces.map((ace) => ace.sid),
      unparsed,
      detail: `the access control list of ${root} has no ACCESS_ALLOWED entry for ${writeSid}` + (unparsed.length > 0 ? ` (${unparsed.length} entry/entries could not be parsed)` : "")
    };
  }
  return {
    verified: true,
    measured: true,
    reason: "ace-present",
    root,
    writeSid,
    inherited: match.inherited === true,
    rights: match.rights,
    detail: `ACCESS_ALLOWED entry for ${writeSid} is present on ${root}${match.inherited === true ? " (inherited)" : ""}`
  };
}
async function ensureStageGrant(options = {}) {
  const target = options.target ?? stageGrantTarget(options);
  const steps = [];
  const root = target?.root;
  if (typeof root !== "string" || root.length === 0) {
    throw stageGrantError(STAGE_GRANT_REASONS.NO_TARGET, {
      detail: "neither an explicit override nor resolveStageRoot() produced a directory to authorise",
      steps
    });
  }
  let created = false;
  try {
    created = !existsSync3(root);
    mkdirSync3(root, { recursive: true });
    steps.push({ step: "host-create-root", ok: true, by: "host-process", created, root });
  } catch (error) {
    steps.push({ step: "host-create-root", ok: false, by: "host-process", root, detail: `${error.code ?? "ERR"}: ${error.message}` });
    throw stageGrantError(STAGE_GRANT_REASONS.ROOT_NOT_CREATABLE, {
      root,
      detail: `${error.code ?? "ERR"}: ${error.message}`,
      steps
    });
  }
  const writable = options.writable !== false;
  let writeSid;
  if (writable) {
    const resolveWriteSid = options.resolveWriteSid ?? options.workspaceWriteSid;
    try {
      writeSid = options.writeSid !== void 0 ? options.writeSid : resolveWriteSid?.(root);
    } catch (error) {
      steps.push({ step: "resolve-write-identity", ok: false, root, detail: `${error.code ?? "ERR"}: ${error.message}` });
      throw stageGrantError(STAGE_GRANT_REASONS.WRITE_SID_UNAVAILABLE, {
        root,
        detail: `${error.code ?? "ERR"}: ${error.message}`,
        steps
      });
    }
    if (typeof writeSid !== "string" || writeSid.length === 0) {
      steps.push({ step: "resolve-write-identity", ok: false, root, detail: String(writeSid) });
      throw stageGrantError(STAGE_GRANT_REASONS.WRITE_SID_UNAVAILABLE, {
        root,
        detail: `resolving the write identity returned ${JSON.stringify(writeSid ?? null)}`,
        steps
      });
    }
    steps.push({ step: "resolve-write-identity", ok: true, root, writeSid });
  } else {
    steps.push({ step: "resolve-write-identity", ok: true, skipped: "read-only-mode", root });
  }
  let value;
  if (typeof options.runGrant === "function") {
    let outcome;
    try {
      outcome = await options.runGrant(root, writeSid);
    } catch (error) {
      steps.push({ step: "authorise", ok: false, root, writeSid, detail: `${error.code ?? "ERR"}: ${error.message}` });
      if (!writable) throw error;
      throw stageGrantError(STAGE_GRANT_REASONS.GRANT_CALL_FAILED, {
        root,
        writeSid,
        detail: `${error.code ?? "ERR"}: ${error.message}`,
        steps
      });
    }
    if (outcome && outcome.ok === false) {
      steps.push({ step: "authorise", ok: false, root, writeSid, detail: String(outcome.detail ?? "(no detail)") });
      throw stageGrantError(STAGE_GRANT_REASONS.GRANT_CALL_FAILED, {
        root,
        writeSid,
        detail: String(outcome.detail ?? "(no detail)"),
        steps
      });
    }
    value = outcome?.value !== void 0 ? outcome.value : outcome;
    steps.push({ step: "authorise", ok: true, root, writeSid, skipped: writable ? void 0 : "read-only-mode" });
  } else {
    value = options.grantedValue;
    steps.push({ step: "authorise", ok: true, root, writeSid, skipped: "no-grant-callback" });
  }
  let verification;
  if (!writable) {
    verification = { verified: false, measured: false, reason: "read-only-mode", root };
  } else if (options.verifyStageGrantAce === false) {
    verification = { verified: false, measured: false, reason: "verification-disabled-by-caller", root, writeSid };
  } else {
    const verify = options.verifyStageGrantAce ?? verifyStageGrantAce;
    verification = verify({ root, writeSid, readSddl: options.readSddl, parseSddl: options.parseSddl, captureDir: options.captureDir });
  }
  steps.push({
    step: "verify-access-entry",
    ok: verification.verified === true,
    measured: verification.measured === true,
    root,
    writeSid,
    reason: verification.reason
  });
  const strict = options.injectedBackend !== true;
  if (strict && verification.verified !== true) {
    const reason = verification.measured === true ? STAGE_GRANT_REASONS.ACE_NOT_VERIFIED : STAGE_GRANT_REASONS.ACE_NOT_VERIFIABLE;
    throw stageGrantError(reason, {
      root,
      writeSid,
      detail: verification.detail,
      steps
    });
  }
  return {
    target,
    created,
    hostCreated: true,
    granted: writable,
    writable,
    writeSid,
    verification,
    steps,
    value
  };
}
function grantPathToAppContainerSid(target, sidString, rights = "M") {
  const result = icaclsRun([target, "/grant", `*${sidString}:(OI)(CI)${rights}`]);
  return { ok: result.ok, detail: result.detail, rights };
}
function icaclsRun(args) {
  const captureDir = join6(tmpdir2(), "dsh-icacls-capture");
  try {
    const result = runCapturedToFiles("icacls", args, { captureDir, timeoutMs: 3e4 });
    const text = `${result.out}${result.err ? ` | ${result.err}` : ""}`.replace(/\r?\n/g, " | ").trim();
    if (result.code === 0) return { ok: true, detail: text };
    return { ok: false, detail: `${result.error ?? `exit=${result.code}`}${text ? ` | ${text.slice(0, 300)}` : ""}`.trim() };
  } catch (error) {
    try {
      const { execFileSync } = require_2("node:child_process");
      const text = String(execFileSync("icacls", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).replace(/\r?\n/g, " | ").trim();
      return { ok: true, detail: `${text} (fd capture unavailable: ${error.message})` };
    } catch (pipeError) {
      return { ok: false, detail: `${pipeError.code ?? ""} ${String(pipeError.message).slice(0, 200)}`.trim() };
    }
  }
}
function readDaclSddl(dir, options = {}) {
  const captureDir = options.captureDir ?? join6(tmpdir2(), "dsh-icacls-save");
  try {
    mkdirSync3(captureDir, { recursive: true });
  } catch {
    return { ok: false, detail: `cannot create capture dir ${captureDir}` };
  }
  const file = join6(captureDir, `dacl-${randomUUID3().slice(0, 8)}.sddl`);
  try {
    const result = icaclsRun([dir, "/save", file]);
    if (!result.ok) return { ok: false, detail: result.detail };
    const buffer = readFileSync3(file);
    const utf16 = buffer.length >= 2 && buffer[1] === 0;
    const text = buffer.toString(utf16 ? "utf16le" : "utf8");
    const line = text.split(/\r?\n/).find((l) => l.includes("D:"));
    if (!line) return { ok: false, detail: `no SDDL in /save output for ${dir}` };
    const sddl = line.slice(line.indexOf("D:"));
    return { ok: true, sddl, detail: sddl };
  } catch (error) {
    return { ok: false, detail: `readDaclSddl failed: ${error.message}` };
  } finally {
    try {
      if (existsSync3(file)) unlinkSync2(file);
    } catch {
    }
  }
}
function repairStaleAppContainerAces(dir, options = {}) {
  const read = options.readSddl ?? ((target) => readDaclSddl(target, options));
  const run = options.runIcacls ?? icaclsRun;
  const before = read(dir);
  if (!before.ok) {
    return {
      repaired: false,
      removed: [],
      remaining: [],
      present: [],
      sddlAvailable: false,
      verifyAvailable: false,
      reason: `cannot read the DACL of ${dir}: ${before.detail}`,
      commands: []
    };
  }
  const found = findStaleAppContainerAces(before.sddl);
  const present = listAppContainerSids(before.sddl);
  if (found.stale.length === 0) {
    return {
      repaired: false,
      removed: [],
      remaining: [],
      present,
      sddlAvailable: true,
      verifyAvailable: true,
      reason: found.unparsed.length > 0 ? `no stale package-SID allow ACE, but ${found.unparsed.length} ACE(s) could not be parsed (${found.unparsed.slice(0, 3).join("")})` : "no stale AppContainer package-SID ACE",
      commands: []
    };
  }
  const commands = [];
  const removed = [];
  const failed = [];
  for (const ace of found.stale) {
    const command = `icacls "${dir}" /remove:g *${ace.sid}`;
    commands.push(command);
    const result = run([dir, "/remove:g", `*${ace.sid}`]);
    if (result.ok) removed.push(ace.sid);
    else failed.push(`${ace.sid}: ${result.detail}`);
  }
  const after = read(dir);
  const remaining = after.ok ? findStaleAppContainerAces(after.sddl).stale.map((a) => a.sid) : [...failed];
  const repaired = failed.length === 0 && remaining.length === 0;
  return {
    repaired,
    removed,
    remaining,
    present: after.ok ? listAppContainerSids(after.sddl) : present,
    sddlAvailable: true,
    verifyAvailable: after.ok,
    commands,
    reason: repaired ? `removed ${removed.length} stale AppContainer package-SID ACE(s)` : `could not fully remove stale package-SID ACE(s): ${[...failed, ...remaining].join("; ")}`
  };
}
async function createAppContainerLauncher(options = {}) {
  const api = options.api;
  if (!api || typeof api.assignProcessToJobObject !== "function") {
    throw fail("T0_UNAVAILABLE", "the merged binding table has no assignProcessToJobObject; T0 cannot enforce job ownership");
  }
  let runtimeModule;
  try {
    runtimeModule = await import("./appcontainer-runtime-EZII2CMB.mjs");
  } catch (error) {
    throw fail("T0_UNAVAILABLE", `cannot load src/appcontainer-runtime.ts: ${error.message}`);
  }
  const koffi = loadKoffiModule();
  if (!koffi) {
    throw fail(
      "T0_UNAVAILABLE",
      "koffi FFI is not resolvable from either the DSH install tree or $DSH_PROFILE_DIR\\node_modules; the AppContainer path needs it for CreateProcessW with a STARTUPINFOEXW"
    );
  }
  const bindings = runtimeModule.createKoffiAppContainerBindings(koffi);
  const launcher = new AppContainerLauncher(koffi, api, {
    profileName: options.profileName,
    capabilities: options.capabilities ?? [],
    grantPaths: options.grantPaths ?? []
  });
  const runtime = new runtimeModule.AppContainerRuntime(bindings, {
    profileName: launcher.profileName,
    capabilities: launcher.capabilities,
    jobAvailable: true,
    // 三轮接线：进程缓解策略。缺省/`none` ⇒ `null` ⇒ 属性列表 1 个槽位、不写 MITIGATION_POLICY，
    // 与接线前的字节行为一致（`AppContainerRuntime` 内部用 attributeListCountFor 判定）。
    mitigationPolicy: options.mitigationPolicy ?? null
  });
  const initReport = runtime.init();
  const sidString = typeof bindings.sidToString === "function" ? bindings.sidToString(initReport.sid) : null;
  if (typeof sidString !== "string" || sidString.length === 0) {
    throw fail(
      "T0_UNAVAILABLE",
      "ConvertSidToStringSidW could not turn the package SID into a string; without it the staged root cannot be granted to the AppContainer (and comparing TokenAppContainerSid would be impossible)"
    );
  }
  const grantReport = launcher.attachRuntime(runtime, sidString);
  return {
    launcher,
    runtime,
    bindings,
    profileName: initReport.profileName,
    sid: sidString,
    createdProfile: initReport.createdHere,
    grants: grantReport.grants,
    attributeListSize: initReport.attributeListSize,
    // 三轮接线：如实回报"这次 T0 启动器带了什么缓解策略"（null = 没带）
    mitigation: initReport.mitigation ?? null,
    attributeCount: initReport.attributeCount ?? 1
  };
}
function loadKoffiModule() {
  const candidates = [...resolveDshModuleRoot().map((root) => join6(root, "koffi"))];
  if (typeof process.env.DSH_PROFILE_DIR === "string" && process.env.DSH_PROFILE_DIR.length > 0) {
    candidates.push(join6(process.env.DSH_PROFILE_DIR, "node_modules", "koffi"));
  }
  candidates.push("koffi");
  for (const spec of candidates) {
    try {
      const loaded = require_2(spec);
      if (loaded && typeof loaded.load === "function") return loaded;
    } catch {
    }
  }
  return void 0;
}
var RestrictedLauncher = class {
  constructor(api, token, spawnPipedProcess, options = {}) {
    this.api = api;
    this.token = token;
    this.spawnPipedProcess = spawnPipedProcess;
    this.options = options;
    this.jobs = /* @__PURE__ */ new Set();
  }
  /** 建立 Job 并把子进程挂进去（进程树回收 / 资源上限） */
  createJob(options = {}) {
    const job = this.api.createJobObjectW(null, null);
    if (!job) throw win32Error(this.api, "CreateJobObjectW", "sandbox job creation");
    const config = {
      // 默认**不设**活跃进程上限：本 Job 要承载沙箱内的整棵进程树，
      // 设一个小上限会以 1816（Job 配额耗尽）让所有命令起不来（真实缺陷 14）。
      activeProcessLimit: options.activeProcessLimit ?? this.options.activeProcessLimit,
      processMemoryLimit: options.processMemoryLimit ?? this.options.processMemoryLimit,
      jobMemoryLimit: options.jobMemoryLimit ?? this.options.jobMemoryLimit,
      perProcessTimeLimitMs: options.perProcessTimeLimitMs
    };
    const { buffer, flags } = buildExtendedLimitInformation(config);
    if (this.api.setInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, buffer.length) === 0) {
      const code = this.api.getLastError();
      try {
        this.api.closeHandle(job);
      } catch {
      }
      throw win32Error(this.api, "SetInformationJobObject", `flags=0x${flags.toString(16)}`);
    }
    this.jobs.add(job);
    return { job, flags, config };
  }
  /**
   * 查询 Job 内活跃进程数（用于验证分配确实生效，而不是"看起来成功"）。
   *
   * 每个字段读取前都做边界断言：这个类曾经因为偏移写错 4 字节而越界抛
   * `ERR_OUT_OF_RANGE`，把"Job 不可用"变成假故障。宁可在这里大声失败，
   * 也不要静默读到错位的数字。
   */
  activeProcesses(job) {
    const buffer = Buffer.alloc(JOB_BASIC_ACCOUNTING_SIZE);
    if (this.api.queryInformationJobObject(job, JobObjectBasicAccountingInformation, buffer, buffer.length, null) === 0) {
      throw win32Error(this.api, "QueryInformationJobObject", `basic accounting (len=${buffer.length})`);
    }
    return parseBasicAccounting(buffer);
  }
  /**
   * 启动受限子进程：显式环境块 + 匿名管道 stdio + Job 归属。
   * 任一 Win32 失败都抛错并回收已分配资源（fail-closed）。
   *
   * 环境注入方式（重要）：`spawnPipedProcess` 内部的受限路径固定以
   * lpEnvironment = NULL 调用 CreateProcessAsUserW（即继承父环境，违反手册 #8.3）。
   * 由于绑定表是可写普通对象，这里在启动窗口内把 `createProcessAsUserW` 换成
   * 显式传入环境块的版本；窗口结束后立即还原，不做长期 monkey patch。
   */
  launch({ command, args = [], cwd, env, job }) {
    const environmentBlock = encodeEnvironmentBlock(env);
    const original = this.api.createProcessAsUserW;
    if (typeof original !== "function") {
      throw fail("SANDBOX_UNAVAILABLE", "binding table has no createProcessAsUserW; cannot launch a confined child");
    }
    this.api.createProcessAsUserW = function patched(token, applicationName, commandLine, processAttributes, threadAttributes, inheritHandles, creationFlags, lpEnvironment, currentDirectory, startupInfo, processInfo) {
      const providesEnv = lpEnvironment === null || lpEnvironment === void 0;
      const chosen = providesEnv ? environmentBlock : lpEnvironment;
      let flags = creationFlags;
      if (providesEnv && chosen !== null && chosen !== void 0) {
        flags = (flags | CREATE_UNICODE_ENVIRONMENT) >>> 0;
      }
      return original.call(
        this,
        token,
        applicationName,
        commandLine,
        processAttributes,
        threadAttributes,
        inheritHandles,
        flags,
        chosen,
        currentDirectory,
        startupInfo,
        processInfo
      );
    };
    let child;
    try {
      child = this.spawnPipedProcess(this.api, { token: this.token, command, args, cwd });
    } finally {
      this.api.createProcessAsUserW = original;
    }
    if (job) {
      if (this.api.assignProcessToJobObject(job, child.process) === 0) {
        const code = this.api.getLastError();
        try {
          this.api.terminateProcess(child.process, 1);
        } catch {
        }
        throw win32Error(this.api, "AssignProcessToJobObject", `pid=${child.pid}`, code);
      }
    }
    return child;
  }
  terminateJob(job, exitCode = 1) {
    try {
      return this.api.terminateJobObject(job, exitCode);
    } catch {
      return 0;
    }
  }
  dispose() {
    const failures = [];
    for (const job of this.jobs) {
      try {
        this.api.closeHandle(job);
      } catch (error) {
        failures.push(error.message);
      }
    }
    this.jobs.clear();
    return failures;
  }
};
function encodeEnvironmentBlock(env) {
  const strings = Object.entries(env).sort(([a], [b]) => a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0).map(([key, value]) => `${key}=${value}`);
  return Buffer.from(`${strings.join("\0")}\0\0`, "utf16le");
}
function win32Error(api, name, detail, code) {
  const win32Code = code ?? api.getLastError();
  let text = "";
  try {
    const buffer = Buffer.alloc(1024);
    const length = api.formatMessageW(4096, null, win32Code, 0, buffer, buffer.length / 2, null);
    if (length > 0) text = buffer.toString("utf16le", 0, (length - 1) * 2).trim();
  } catch {
  }
  const error = new Error(`${name} failed (${win32Code}${text ? `: ${text}` : ""})${detail ? ` \u2014 ${detail}` : ""}`);
  error.code = "WIN32_FAILURE";
  error.win32Code = win32Code;
  error.api = name;
  return error;
}
function mergeBindingTables(lowLevel, captured) {
  const merged = { ...lowLevel };
  const added = [];
  const skipped = [];
  for (const [name, value] of Object.entries(captured ?? {})) {
    if (typeof merged[name] === "function") {
      skipped.push(name);
      continue;
    }
    merged[name] = value;
    added.push(name);
  }
  return { merged, added, skipped };
}
function captureLaunchState(instance) {
  const entries = Object.entries(instance).map(([name, value]) => ({ name, value }));
  const api = entries.find(
    ({ value }) => value && typeof value === "object" && typeof value.createProcessAsUserW === "function"
  );
  const token = entries.find(({ name, value }) => {
    if (value === null || value === void 0) return false;
    return /token/i.test(name) && name !== "tokenType";
  });
  if (!api || !token) return void 0;
  return { api: api.value, token: token.value, fieldNames: { api: api.name, token: token.name } };
}
async function initAclSandboxWithTokenCapture(AclSandbox, options) {
  const sandbox = new AclSandbox(options);
  await sandbox.init();
  const captured = captureLaunchState(sandbox);
  if (!captured) {
    try {
      sandbox.dispose();
    } catch {
    }
    throw new Error(
      "SANDBOX_UNAVAILABLE: could not discover the restricted token/binding table on an initialized AclSandbox. Refusing to fall back to an environment-inheriting spawn (manual \xA78.3)."
    );
  }
  return { sandbox, ...captured };
}
var EXIT_WAIT_SLICE_MS = 50;
async function waitForExitWithoutStarvingEventLoop(api, process2, waitForProcessExit) {
  let exitCode;
  for (; ; ) {
    const waited = api.waitForSingleObject(process2, EXIT_WAIT_SLICE_MS);
    if (waited === 0) {
      const slot = typeof api.allocUint32 === "function" ? api.allocUint32() : void 0;
      try {
        const readInto = slot ?? Buffer.alloc(4);
        if (api.getExitCodeProcess(process2, readInto) === 0) break;
        exitCode = slot !== void 0 ? api.decodeUint32(slot) : readInto.readUInt32LE(0);
      } finally {
        if (slot !== void 0 && typeof api.freeNative === "function") api.freeNative(slot);
      }
      break;
    }
    if (waited === 258) {
      await new Promise((resolve3) => setTimeout(resolve3, 0));
      continue;
    }
    break;
  }
  if (exitCode !== void 0) {
    waitForProcessExit(api, process2);
    return exitCode;
  }
  return waitForProcessExit(api, process2);
}
function capabilityDimensionSnapshot(options = {}) {
  const networkTier = options.networkTier ?? "OBSERVED_ONLINE";
  const mitigationProfile = options.mitigationProfile ?? "none";
  let networkPolicy;
  try {
    networkPolicy = summariseNetworkPolicy(resolveNetworkPolicy({ requested: networkTier }));
  } catch (error) {
    networkPolicy = { tier: networkTier, state: "unknown", enforced: false, verified: false, reason: `\u7F51\u7EDC\u7B56\u7565\u5224\u5B9A\u629B\u9519\uFF1A${error.code ?? ""} ${error.message}`.trim() };
  }
  let mitigations;
  try {
    mitigations = summariseMitigations(buildMitigationPolicy({ profile: mitigationProfile }));
  } catch (error) {
    mitigations = { profile: mitigationProfile, flags: null, names: [], attribute: null, size: null, noop: null, state: "unknown", reason: `\u7F13\u89E3\u7B56\u7565\u6784\u9020\u5931\u8D25\uFF1A${error.code ?? ""} ${error.message}`.trim() };
  }
  let limits;
  try {
    limits = summariseLimits(wrapLimits(options.limits));
  } catch (error) {
    limits = { stagingBytes: null, stagingGiB: null, maxOutputBytes: null, maxOutputLines: null, source: "unknown", stagingSource: null, outputSource: null, state: "unknown", reason: `\u8D44\u6E90\u4E0A\u9650\u89E3\u6790\u5931\u8D25\uFF1A${error.code ?? ""} ${error.message}`.trim() };
  }
  return { networkPolicy, mitigations, limits };
}
var WindowsStageExecutor = class _WindowsStageExecutor {
  constructor(options = {}) {
    this.options = options;
    this.stageGrantPlan = stageGrantTarget({
      stagingRoot: options.stagingRoot,
      sessionKey: options.sessionKey ?? options.sessionId,
      workspaceRoot: options.workspaceRoot,
      env: options.env
    });
    this.stagingRoot = options.stagingRoot ? canonicalDir(options.stagingRoot) : this.stageGrantPlan.keyed ? this.stageGrantPlan.root : void 0;
    this.stagingRootSource = this.stagingRoot === void 0 ? "unresolved" : this.stageGrantPlan.source;
    this.stageGrant = void 0;
    this.mirrorRoot = options.mirrorRoot ? canonicalDir(options.mirrorRoot) : void 0;
    this.mode = options.mode || "workspace-write";
    this.tier = options.tier || "T1";
    this.sandbox = void 0;
    this.launcher = void 0;
    this.api = void 0;
    this.token = void 0;
    this.tempDir = void 0;
    this.initReport = void 0;
    this.job = void 0;
    this.stagingRootAudit = {
      configuredAtConstruction: this.stagingRoot,
      configuredWasSet: Boolean(this.stagingRoot),
      envAtConstruction: readStageRootEnv(),
      events: [],
      rootLost: false,
      rootLostCount: 0,
      tierDrift: false
    };
    this.stagingWriteGate = {
      trips: [],
      lastDecision: void 0,
      latchClearedBy: void 0
    };
    this.appContainer = void 0;
    this.appContainerInfo = void 0;
    this.launchMode = void 0;
    this.tierRequested = void 0;
    this.tierEffective = void 0;
    this.fallbackReason = void 0;
    this.transparent = void 0;
    this.shimLauncher = void 0;
    this.networkTier = options.networkTier ?? "OBSERVED_ONLINE";
    this.mitigationProfileRequested = options.mitigationProfile ?? "none";
    this.mitigationPolicyBuilt = buildMitigationPolicy({ profile: this.mitigationProfileRequested });
    this.limits = options.limits && options.limits.staging && options.limits.output && Object.isFrozen(options.limits) ? options.limits : wrapLimits(options.limits);
    this.networkPolicyResult = void 0;
    this.networkPolicy = void 0;
    this.networkPolicyPrepared = false;
    this.networkInstallEvidence = void 0;
    this.networkInstallAudit = void 0;
    this.networkTeardown = void 0;
    this.networkTeardownResult = void 0;
    this.noteStagingRootSampling("construction");
  }
  /**
   * ── 缺陷③（Fix A 的核心）：`init()` 自检结果的二次判定 ─────────────────────────
   *
   * 为什么需要它：自检**已经**测出了"暂存根写不进去"，但 `enforcement` 只被放进
   * `sandboxInit` 报告里，`exec` 照常跑命令并返回 0（审计 `raw/70-t0-json.txt`、
   * `raw/81-a3`：`inside-staging-write-allowed=fail` + `enforcement=degraded` + 退出码 0）。
   * 于是"工作区外写入被捕获进暂存"的招牌保证在该工作区**静默失效**。
   *
   * 判定只看**实测观测**（`checks` / `observed`），不看"档位声明"：
   *   - 实测缺项 ⇒ `verdict='unmeasured'`（**不是 pass**；测不出来就不许说测过了）
   *   - 任一判据 `fail` ⇒ `verdict='fail'` + 把触发项列进 `failedChecks`
   *
   * 静态方法（纯函数）以便离线套件直接喂合成报告：`WindowsStageExecutor.stagingWriteEnforceability(...)`。
   *
   * @param {object} report 形如 `{checks: [{name,status,detail}], enforcement, observed}`
   * @param {object} [options] `{lane: 'sandbox'|'shim'}`
   * @returns {{verdict:'pass'|'fail'|'unmeasured', lane:string, enforcement:string|undefined,
   *            failedChecks:Array, measuredChecks:Array, missingChecks:string[], reason:string}}
   */
  static stagingWriteEnforceability(report, options = {}) {
    const lane = options.lane ?? "sandbox";
    const checks = Array.isArray(report?.checks) ? report.checks : [];
    const measuredNames = lane === "shim" ? SHIM_STAGING_WRITE_CHECKS : SANDBOX_STAGING_WRITE_CHECKS;
    const relevant = checks.filter((c) => isStagingWriteCheckName(c?.name));
    const measuredChecks = relevant.map((c) => ({ name: c.name, status: c.status, detail: c.detail }));
    const failedChecks = measuredChecks.filter((c) => c.status !== "pass" && c.status !== "documented-residual");
    const missingChecks = [];
    if (!report || typeof report !== "object") missingChecks.push("(no self-test report was produced)");
    else if (measuredChecks.length === 0) missingChecks.push("(no staging-write check was executed)");
    for (const name of measuredNames) {
      if (!measuredChecks.some((c) => c.name === name)) missingChecks.push(name);
    }
    const base = { lane, enforcement: report?.enforcement, failedChecks, measuredChecks, missingChecks };
    if (failedChecks.length > 0) {
      return {
        ...base,
        verdict: "fail",
        reason: `${failedChecks.length} staging-write check(s) failed: ` + failedChecks.map((c) => `${c.name}=${c.status} (${String(c.detail ?? "").slice(0, 120)})`).join("; ")
      };
    }
    if (missingChecks.length > 0) {
      return { ...base, verdict: "unmeasured", reason: `staging-write enforcement was not fully measured: missing ${missingChecks.join(", ")}` };
    }
    return { ...base, verdict: "pass", reason: "every staging-write check passed under the identity this run uses" };
  }
  /**
   * 实例侧入口：读取自身自检结果算判定（不触系统状态）。
   * 自检还没跑过时返回 `unmeasured` —— 绝不默认放行。
   */
  stagingWriteEnforceability(options = {}) {
    return _WindowsStageExecutor.stagingWriteEnforceability(this.initReport, {
      lane: options.lane ?? (this.launchMode === "shim" ? "shim" : "sandbox")
    });
  }
  /**
   * ── Fix A：运行前闸门（**BUG-4 修复后：单命令级，绝不闩锁整段会话**）─────────────
   *
   * 修复前：`initReport` 的自检探针只要**瞬时**失败一次（`0xC0000005` / `0xE0434352` /
   * exit 127 / >25s 挂死四种形态实测都出现过），整段会话里**每一条**命令都被同一门文本
   * 拒绝 —— 连 `Write-Output "x"` 都拒，持续数分钟且没有解除提示。
   *
   * 修复后，判定只回答"**这一条**命令的问题"：
   *   · **授权未建立**（Phase 2 / WP1，`this.stageGrant.granted !== true` 且本档确实靠
   *     ACL 写授权）⇒ 拒绝，码 `STAGE_GRANT_FAILED`。这条**优先于下面三条**、也不吃
   *     只读豁免：它是本次运行身份的**结构事实**（与 ① 的失根同级），不是一次测量，
   *     因此调用方注入的 `stagingWriteCheck` 替身**不能**把它改写成放行。
   *   · `read-only`      ⇒ **不拦**（只读命令没有可被静默降级的写入面）。判定写进
   *                        `this.stagingWriteGate`，下游可机检"这次豁免是因为只读"。
   *   · `write-capable`  ⇒ 拒绝，码 `STAGING_WRITE_UNVERIFIED`，并带**可重试**文案
   *                        （`retryable:true` + `retryHint`：本次命令未执行、文件未变）。
   *   · `indeterminate`  ⇒ 也拒绝（fail-closed 不变），码
   *                        `STAGING_WRITE_UNVERIFIED_INDETERMINATE`，**逐条说明为什么判不出来**。
   *
   * 仍然**绝不**在 `enforcement` 降级时让一条**可能写**的命令照常跑并返回 0。
   * 拒绝时抛**带 code 的**结构化错误，由 CLI 走它既有的人读通道
   * （`src/cli.ts:196-198` 的 `fail()` → stderr）呈现；**本函数不写 stdout/stderr**，
   * 模型可见输出（命令自己的输出）因此一个字节都不被污染（与
   * `dsh-plugin/shell-executor.ts:1320-1335` 的"模型可见输出 vs 人工通道"同一纪律）。
   */
  assertStagingWriteEnforceable(context = {}) {
    const override = this.options.stagingWriteCheck;
    const report = typeof override?.evaluate === "function" ? override.evaluate(this) : this.stagingWriteEnforceability();
    this.stagingWriteCheckReport = report;
    const risk = this.commandRisk(context);
    const decisionBase = {
      at: Date.now(),
      command: typeof context.command === "string" ? context.command : void 0,
      risk: risk.risk,
      riskReasons: risk.reasons,
      verdict: report.verdict,
      lane: report.lane
    };
    const rootState = this.assertStagingRootPresent("staging-write-gate");
    const grantRecord = this.stageGrant;
    if (grantRecord && grantRecord.writable === true && grantRecord.enforcement === "acl-write-sid" && grantRecord.granted !== true) {
      const grantError = stageGrantError(STAGE_GRANT_REASONS.ACE_NOT_VERIFIED, {
        root: grantRecord.root,
        writeSid: grantRecord.writeSid,
        detail: "the write authorisation for this run was never established (granted !== true)",
        steps: grantRecord.steps
      });
      grantError.refusedCommand = decisionBase.command;
      grantError.commandRisk = risk.risk;
      grantError.retryable = true;
      grantError.retryHint = "\u5185\u90E8\u6682\u5B58\u6388\u6743\u672A\u5EFA\u7ACB\uFF0C\u672C\u6B21\u547D\u4EE4\u672A\u6267\u884C\uFF08not executed\uFF09\u3001\u6587\u4EF6\u672A\u53D8\uFF08files unchanged\uFF09";
      this.stagingWriteGate.trips.push({ ...decisionBase, action: "refused", code: STAGE_GRANT_FAILED });
      this.stagingWriteGate.lastDecision = { ...decisionBase, action: "refused", code: STAGE_GRANT_FAILED };
      throw grantError;
    }
    if (report.verdict === "pass") {
      decisionBase.action = "allowed";
      this.stagingWriteGate.lastDecision = decisionBase;
      return { allowed: true, ...report, risk };
    }
    if (risk.risk === COMMAND_RISK.READ_ONLY) {
      decisionBase.action = "allowed-read-only-bypass";
      decisionBase.bypassReason = "\u672C\u6761\u547D\u4EE4\u88AB\u6B63\u5411\u5224\u5B9A\u4E3A\u53EA\u8BFB/\u65E0\u526F\u4F5C\u7528\uFF1A\u6682\u5B58\u6839\u6B64\u523B\u662F\u5426\u53EF\u5199\u4E0D\u5F71\u54CD\u5B83\u7684\u7ED3\u679C\uFF0C\u56E0\u6B64\u95F8\u95E8\u53EA\u8BB0\u5F55\u3001\u4E0D\u62D2\u7EDD\uFF08BUG-4\uFF1A\u62D2\u7EDD\u9762\u53EA\u8986\u76D6\u6709\u98CE\u9669\u7684\u90A3\u4E00\u6761\u547D\u4EE4\uFF09";
      this.stagingWriteGate.lastDecision = decisionBase;
      this.stagingWriteGate.trips.push(decisionBase);
      this.stagingWriteGate.latchClearedBy = "read-only-command";
      return { allowed: true, bypassed: "read-only", ...report, risk, decision: decisionBase };
    }
    const indeterminate = risk.risk === COMMAND_RISK.INDETERMINATE;
    const code = indeterminate ? "STAGING_WRITE_UNVERIFIED_INDETERMINATE" : "STAGING_WRITE_UNVERIFIED";
    const riskLine = indeterminate ? `\u672C\u6761\u547D\u4EE4**\u65E0\u6CD5\u5224\u5B9A**\uFF08cannot determine\uFF09\u662F\u5426\u4F1A\u4EA7\u751F\u526F\u4F5C\u7528\uFF0C\u56E0\u6B64 fail-closed \u62D2\u7EDD\uFF08\u800C\u4E0D\u662F\u628A"\u4E0D\u77E5\u9053"\u8BF4\u6210"\u7B56\u7565\u62D2\u7EDD"\uFF09\u3002\u5224\u4E0D\u51FA\u6765\u7684\u539F\u56E0\uFF1A${risk.reasons.join("\uFF1B")}\u3002` : `\u672C\u6761\u547D\u4EE4\u88AB\u5224\u5B9A\u4E3A**\u53EF\u80FD\u5199\u5165**\uFF0C\u56E0\u6B64\u62D2\u7EDD\u3002\u7406\u7531\uFF1A${risk.reasons.join("\uFF1B")}\u3002`;
    const error = fail(
      code,
      `refusing to run THIS command: the staged root is not verified writable by the identity this run uses (${report.verdict === "unmeasured" ? "measurement unavailable/incomplete" : "measured as not writable"}). reason: ${report.reason}. ${riskLine} If the command ran, writes outside the workspace would NOT be captured into staging while the caller still sees exit code 0 \u2014 that is the silent-degradation shape this gate exists to prevent. \u8FD9\u6B21\u62D2\u7EDD**\u53EA\u4F5C\u7528\u4E8E\u8FD9\u4E00\u6761\u547D\u4EE4**\uFF1A\u672C\u6B21\u547D\u4EE4\u672A\u6267\u884C\u3001\u6587\u4EF6\u672A\u53D8\uFF0C\u8BF7\u4FEE\u590D\u540E\u91CD\u8BD5\uFF1B\u540C\u4E00\u4F1A\u8BDD\u91CC\u7684\u53EA\u8BFB\u547D\u4EE4\u4E0D\u4F1A\u88AB\u672C\u95F8\u95E8\u62E6\u4E0B\u3002`
    );
    error.report = report;
    error.risk = risk;
    error.retryable = true;
    error.retryHint = "\u5185\u90E8\u6682\u5B58\u6821\u9A8C\u672A\u901A\u8FC7\uFF08internal staging error\uFF09\uFF0C\u672C\u6B21\u547D\u4EE4\u672A\u6267\u884C\uFF08not executed\uFF09\u3001\u6587\u4EF6\u672A\u53D8\uFF08files unchanged\uFF09\uFF0C\u8BF7\u91CD\u8BD5\uFF08please retry\uFF09\uFF1B\u91CD\u8BD5\u524D\u53EF\u5148\u8DD1\u53EA\u8BFB\u547D\u4EE4\u786E\u8BA4\u73AF\u5883\u3002";
    error.policyDenial = false;
    error.remediation = [
      "retry the same command \u2014 this refusal is scoped to that one command and never latches the session (BUG-4)",
      "run `dsh-stage init --workspace <dir>` \u2014 it now detects and removes the stale AppContainer package-SID ACE a previous `--tier T0` run left on the staged root",
      "if the ACE is still present, inspect it with: icacls <staged>  (look for an explicit `S-1-15-2-*:(OI)(CI)(M)` entry)",
      "if the message says unmeasured, the in-sandbox self-test could not run at all (missing PowerShell / restricted token / ACL backend) \u2014 fix that first; the gate deliberately does not guess",
      "if a read-only command was refused as indeterminate, re-issue it with a plain read-only verb (Get-*/Test-*/Write-Output) or pass `commandRisk` \u2014 the gate explains exactly which token it could not judge"
    ];
    error.humanChannel = {
      code,
      verdict: report.verdict,
      lane: report.lane,
      enforcement: report.enforcement,
      failedChecks: report.failedChecks,
      missingChecks: report.missingChecks,
      reason: report.reason,
      commandRisk: risk.risk,
      commandRiskReasons: risk.reasons,
      retryable: true,
      retryHint: error.retryHint,
      remediation: error.remediation
    };
    this.stagingWriteGate.trips.push({ ...decisionBase, action: "refused", code });
    this.stagingWriteGate.lastDecision = { ...decisionBase, action: "refused", code };
    throw error;
  }
  /**
   * 判定"这一条命令"的风险（可被 `options.commandRisk` 显式覆盖 —— 与
   * `stagingWriteCheck` 同一约定：依赖注入缝必须显式声明，不改变生产默认行为）。
   */
  commandRisk(context = {}) {
    const override = this.options.commandRisk;
    if (typeof override === "function") return override(context.command, context.args ?? [], context);
    if (override && typeof override === "object" && typeof override.risk === "string") return override;
    return classifyCommandRisk(context.command, context.args ?? [], context);
  }
  /**
   * ── BUG-3：失根的**采样 + 判定 + 可查询状态** ─────────────────────────────────
   *
   * 每次 `init()` / `run()` 进来都采一次样，检测三件事：
   *   ① `this.stagingRoot` 从"有值"变成"空"（失根）；
   *   ② 暂存根此前存在、现在不存在（失联）；
   *   ③ 环境契约 `WINSTAGE_STAGE_ROOT` 变成空值（现场 ENV-01 的形态）。
   * 任一命中 ⇒ 抛**独立错误码**（`STAGING_ROOT_*`，`policyDenial:false`），
   * 并把事件记进 `this.stagingRootAudit`，由 `stagingRootDiagnostics()` 查询。
   */
  noteStagingRootSampling(where) {
    const audit = this.stagingRootAudit;
    const env = readStageRootEnv();
    const configured = this.stagingRoot;
    const configuredWasSet = Boolean(configured);
    let exists = false;
    let isDirectory = false;
    try {
      const stat = configured ? statSync3(configured) : void 0;
      exists = Boolean(stat);
      isDirectory = Boolean(stat?.isDirectory?.());
    } catch {
      exists = false;
    }
    const previous = audit.events.length > 0 ? audit.events[audit.events.length - 1] : void 0;
    const previouslyExisted = previous ? previous.exists === true : false;
    const sample = {
      at: Date.now(),
      where,
      configured,
      configuredWasSet,
      envStageRoot: env.present ? env.value : void 0,
      envPresent: env.present,
      exists,
      isDirectory,
      previouslyExisted
    };
    const wasEverSet = audit.configuredWasSet || audit.events.some((e) => e.configuredWasSet);
    if (wasEverSet && !configuredWasSet) {
      audit.events.push({ ...sample, kind: "root-lost", severity: "critical" });
      audit.rootLost = true;
      audit.rootLostCount += 1;
    } else if (previous?.envPresent === true && env.present === true && String(previous.envStageRoot ?? "").length > 0 && String(env.value ?? "").trim() === "") {
      audit.events.push({ ...sample, kind: "env-stage-root-blanked", severity: "critical" });
      audit.rootLost = true;
      audit.rootLostCount += 1;
    } else if (previouslyExisted && !exists) {
      audit.events.push({ ...sample, kind: "root-vanished", severity: "critical" });
      audit.rootLost = true;
      audit.rootLostCount += 1;
    } else {
      audit.events.push({ ...sample, kind: "sample" });
    }
    if (this.tierRequested !== void 0 && this.tierEffective !== void 0 && this.tierRequested !== this.tierEffective) {
      if (!audit.tierDrift) {
        audit.tierDrift = true;
        audit.events.push({
          at: Date.now(),
          where,
          kind: "tier-drift",
          severity: "warning",
          tierRequested: this.tierRequested,
          tierEffective: this.tierEffective,
          fallbackReason: this.fallbackReason
        });
      }
    }
    if (audit.events.length > 200) audit.events.splice(0, audit.events.length - 200);
    return sample;
  }
  /**
   * 失根判定（采样 → 纯函数判定）。失根时抛**独立错误码**，
   * 结论里明确写"这不是策略拒绝"。
   */
  assertStagingRootPresent(where = "preflight") {
    const audit = this.stagingRootAudit;
    const sample = this.noteStagingRootSampling(where);
    const env = readStageRootEnv();
    const configured = this.stagingRoot;
    let exists = sample.exists;
    let isDirectory = sample.isDirectory;
    if (configured && !exists && !sample.previouslyExisted && configured === audit.configuredAtConstruction) {
      try {
        mkdirSync3(configured, { recursive: true });
        const stat = statSync3(configured);
        exists = true;
        isDirectory = Boolean(stat.isDirectory?.());
      } catch (error) {
        throw this.rootLossError(
          {
            status: "lost",
            code: STAGING_ROOT_CODES.ABSENT,
            category: "root-loss",
            policyDenial: false,
            distinctFromPolicyDenial: true,
            retryable: true,
            summary: `\u6682\u5B58\u6839 ${configured} \u4E0D\u5B58\u5728\u4E14\u65E0\u6CD5\u521B\u5EFA\uFF1A${error.message} \u2014\u2014 \u8FD9\u662F**\u6C99\u7BB1\u81EA\u8EAB\u6545\u969C**\uFF0C\u4E0D\u662F\u7B56\u7565\u62D2\u7EDD\u3002`,
            action: "\u68C0\u67E5\u8DEF\u5F84\u6743\u9650/\u78C1\u76D8\u540E\u91CD\u65B0 `dsh-stage init --workspace <dir>`\u3002",
            evidence: { configured, where }
          },
          where
        );
      }
    }
    const state = classifyStagingRootState({
      where,
      configured,
      configuredWasSet: audit.configuredWasSet || Boolean(configured),
      envStageRoot: env.present ? env.value : void 0,
      envWasSet: env.present,
      previouslyExisted: sample.previouslyExisted,
      exists,
      isDirectory
    });
    this.stagingRootState = state;
    if (state.status === "ok") return state;
    throw this.rootLossError(state, where);
  }
  /** 把"失根"结论做成结构化错误（**与策略拒绝可区分**：独立码 + 一句话 + 建议动作） */
  rootLossError(state, where) {
    const error = fail(state.code, `[${state.category}] ${state.summary} \u5EFA\u8BAE\u52A8\u4F5C\uFF1A${state.action}`);
    error.category = state.category;
    error.policyDenial = false;
    error.distinctFromPolicyDenial = true;
    error.retryable = state.retryable === true;
    error.retryHint = "\u8FD9\u662F\u5931\u6839\uFF08\u6682\u5B58\u6839\u5931\u8054\uFF09\uFF0C\u4E0D\u662F\u6743\u9650\u4E0D\u8DB3\uFF1A\u8BF7\u5148\u91CD\u5EFA\u6682\u5B58\u6839\u518D\u91CD\u8DD1\uFF0C\u4E0D\u8981\u53CD\u590D\u91CD\u8BD5\u540C\u4E00\u6761\u547D\u4EE4\u3002";
    error.summary = state.summary;
    error.action = state.action;
    error.where = where;
    error.evidence = state.evidence;
    error.remediation = [state.action, "\u67E5\u8BE2\u53EF\u8BCA\u65AD\u72B6\u6001\uFF1A`stagingRootDiagnostics()`\uFF08\u542B\u672C\u6B21\u4F1A\u8BDD\u662F\u5426\u66FE\u5931\u6839 / \u6863\u4F4D\u6F02\u79FB\uFF09"];
    error.humanChannel = {
      code: state.code,
      category: state.category,
      policyDenial: false,
      summary: state.summary,
      action: state.action,
      where,
      remediation: error.remediation
    };
    return error;
  }
  /**
   * ── BUG-3：可查询的失根 / 漂移状态 ───────────────────────────────────────────
   *
   * "是否曾发生失根 / 档位漂移"必须能被查询，而不是只活在一条误导性报错里。
   */
  stagingRootDiagnostics() {
    const audit = this.stagingRootAudit;
    const critical = audit.events.filter((e) => e.severity === "critical");
    return {
      code: audit.rootLost ? critical[critical.length - 1]?.kind ?? "root-lost" : STAGING_ROOT_CODES.OK,
      rootLost: audit.rootLost,
      rootLostCount: audit.rootLostCount,
      rootLostEvents: critical.map((e) => ({ at: e.at, where: e.where, kind: e.kind, configured: e.configured, envStageRoot: e.envStageRoot, exists: e.exists })),
      tierDrift: audit.tierDrift,
      tierRequested: this.tierRequested,
      tierEffective: this.tierEffective,
      configured: this.stagingRoot,
      configuredWasSet: audit.configuredWasSet,
      envStageRoot: readStageRootEnv().value,
      // ── Phase 2 / WP1：根**从哪来**（`explicit-override` / `resolve-stage-root`）────
      // 与"授权上了没有"。失根（本函数的主判据）与"没授权上"是两件事，必须分开查。
      rootSource: this.stagingRootSource,
      grant: this.stageGrant,
      currentState: this.stagingRootState?.code ?? void 0,
      summary: audit.rootLost ? `\u672C\u6B21\u4F1A\u8BDD\u66FE\u53D1\u751F**\u5931\u6839**\uFF08${audit.rootLostCount} \u6B21\uFF0C\u6700\u8FD1\u4E00\u6B21\uFF1A${critical[critical.length - 1]?.kind}\uFF09\u2014\u2014 \u8FD9\u4E0D\u662F\u7B56\u7565\u62D2\u7EDD\uFF1B\u6B64\u524D\u5DF2\u6682\u5B58\u7684\u5DE5\u4F5C\u53EF\u80FD\u5DF2\u968F\u65E7\u4F1A\u8BDD\u6D88\u5931\u3002` : audit.tierDrift ? `\u672A\u5931\u6839\uFF0C\u4F46\u53D1\u751F**\u6863\u4F4D\u6F02\u79FB**\uFF08\u8BF7\u6C42 ${this.tierRequested} \u2192 \u751F\u6548 ${this.tierEffective}\uFF09\u3002` : "\u672A\u5931\u6839\u3001\u672A\u53D1\u751F\u6863\u4F4D\u6F02\u79FB\u3002",
      events: audit.events.slice(-50)
    };
  }
  /**
   * 能力与依赖解析。
   *
   * 可通过 `options.overrides` 注入替身，用于**不依赖 Win32 的确定性测试**：
   *   { AclSandbox, processBindings, spawnPipedProcess, workspaceWriteSid, tempWriteSid,
   *     assertPrivateTempDisjoint }
   * 这是正常的依赖注入缝，不改变生产路径行为（不注入时完全走真实加载）。
   */
  static capabilities(overrides = {}) {
    const modules = loadWindowsSandboxModules();
    const acl = modules[ACL_PACKAGE];
    const win32 = modules[WIN32_PACKAGE];
    const aclModule = acl?.module;
    const win32Module = win32?.module;
    const resolved = {
      aclAvailable: typeof aclModule?.AclSandbox === "function",
      aclError: acl?.error?.message,
      aclFrom: acl?.from,
      aclVersion: safeVersion(acl?.from, ACL_PACKAGE),
      win32Available: typeof win32Module?.spawnPipedProcess === "function",
      win32Error: win32?.error?.message,
      win32From: win32?.from,
      win32Version: safeVersion(win32?.from, WIN32_PACKAGE),
      resolutionRoots: modules.__roots,
      AclSandbox: aclModule?.AclSandbox,
      // 低层原语表（不含 spawnPipedProcess —— 那是模块级函数，单独取）
      processBindings: win32Module && typeof win32Module.loadWin32ProcessBindings === "function" ? safeLoadProcessBindings(win32Module) : void 0,
      // 模块级 spawn 函数：spawnPipedProcess(api, options)
      spawnPipedProcess: win32Module?.spawnPipedProcess,
      // 收集子进程结果所需的库函数（drainPipe / waitForProcessExit）
      processLibrary: win32Module ? { drainPipe: win32Module.drainPipe, waitForProcessExit: win32Module.waitForProcessExit } : void 0,
      workspaceWriteSid: aclModule?.workspaceWriteSid,
      tempWriteSid: aclModule?.tempWriteSid,
      assertPrivateTempDisjoint: aclModule?.assertPrivateTempDisjoint,
      // ── 去令牌化（透明 shim）耦合点 ───────────────────────────────────────────
      // 与 AclSandbox / spawnPipedProcess 一样，这是**显式依赖注入缝**：
      // 离线测试可以注入"shim 可用 / 不可用"的替身，从而确定性覆盖模式判定与
      // fail-closed 回退，而不改变生产路径行为（不注入时走真实探测）。
      probeTransparentShim,
      resolveShimArtifacts,
      // 去令牌化启动的**进程级**原语（文件描述符重定向，绝不用管道）。
      // 同样可被替身覆盖：离线测试要能断言"启动确实走了注入器、环境里没有 DSH_SANDBOX*"。
      spawnTransparentProcess: spawnCapturedAsync
    };
    const merged = { ...resolved };
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== void 0) merged[key] = value;
    }
    if (overrides.AclSandbox) merged.aclAvailable = true;
    if (overrides.spawnPipedProcess) merged.win32Available = true;
    if (overrides.simulate) {
      for (const [key, value] of Object.entries(overrides.simulate)) merged[key] = value;
    }
    merged.capabilityDimensions = capabilityDimensionSnapshot(overrides);
    return merged;
  }
  /**
   * 去令牌化（透明 shim）初始化：**不建受限令牌**，只装配注入器与暂存根。
   *
   * 与受限令牌路径的差别（必须如实记录）：
   *   - 不调用 `AclSandbox.init()` ⇒ 没有 `CreateRestrictedToken`、没有 Low IL 标签；
   *   - 不建 Job Object ⇒ `terminate()` 用 `taskkill /T /F` 回收注入器进程树；
   *   - 强制 + 暂存由 shim 的用户态 IAT 钩子承担（T4 的语义，见探测器 checks）。
   */
  async initTransparent(cap) {
    const started = Date.now();
    const lowLevel = cap.processBindings;
    if (!lowLevel || typeof lowLevel.createJobObjectW !== "function") {
      throw fail(
        "SANDBOX_UNAVAILABLE",
        "loadWin32ProcessBindings() did not return the Win32 process primitive table; the transparent mode refuses to start without it"
      );
    }
    const writable = this.mode === "workspace-write";
    const tempDir = this.options.tempDir || defaultPrivateTemp();
    mkdirSync3(tempDir, { recursive: true });
    if (writable && typeof cap.assertPrivateTempDisjoint === "function") {
      cap.assertPrivateTempDisjoint([this.stagingRoot], tempDir);
    }
    this.api = { ...lowLevel };
    this.tempDir = writable ? tempDir : void 0;
    const logPath = join6(this.stagingRoot, "shim.log");
    const { configPath, config } = writeShimConfig({
      stageRoot: this.stagingRoot,
      logPath,
      extraPassthrough: this.options.shimPassthrough ?? []
    });
    const auditPath = typeof this.options.auditLogPath === "string" && this.options.auditLogPath.length > 0 ? this.options.auditLogPath : join6(
      typeof this.options.registryStageDir === "string" && this.options.registryStageDir.length > 0 ? this.options.registryStageDir : tempDir,
      "audit.jsonl"
    );
    this.auditPath = this.options.audit === false ? void 0 : auditPath;
    this.shimLauncher = new ShimLauncher(this.api, {
      artifacts: this.transparent.artifacts,
      // shim 的环境契约（T4 `winstage_shim.h`）：STAGE_ROOT / CONFIG / LOG。
      // **不设** WINSTAGE_SHIM_DISABLE —— 设了 shim 就完全不生效，等于裸跑。
      env: {
        WINSTAGE_STAGE_ROOT: this.stagingRoot,
        WINSTAGE_SHIM_LOG: logPath,
        WINSTAGE_SHIM_CONFIG: configPath,
        ...this.auditPath ? { WINSTAGE_AUDIT_LOG: this.auditPath } : {},
        // ── 注册表覆盖层**不得**落在暂存树里（本轮修复）─────────────────────────
        // `WINSTAGE_STAGE_ROOT` 同时是文件族的重定向根**和**注册表 overlay 的默认
        // sessionDir（`ws_entry.c` 的取值顺序：REGSTAGE_SESSION_DIR > DSH_REGSTAGE_ROOT
        // > STAGE_ROOT）。而 `stagingRoot` 就是**暂存树**本身 —— 于是 shim 把
        // `registry/overlay.hive*`/`overlay.journal` 写进暂存树，宿主执行后的
        // "提取暂存树变化"（`workspace.captureAfterExecution` / `ingestCapturedChanges`）
        // 立刻把它们当成**工作区变更**去摄取，并在文件仍被持有/独占时抛
        // `EPERM ... overlay.<pid>.hive.LOG1`（本机实测：`cli exec --tier auto` 正是
        // 这样崩的）。这是"自指条目"的老形态：暂存层自己的状态文件被当成用户改动。
        // 把 sessionDir 指到**会话存储根**（`<store>/`，即 manifest/review/queue 所在处）
        // 一次解决两件事：① overlay/WAL 不再进暂存树；② 覆盖层与候选队列同在
        // `<sessionDir>/` 下，正是 `src/registry-stage.ts::createRegistryStage()`
        // 读取 WAL、写 `candidates/` + `queue.json` 的契约布局。
        ...typeof this.options.registryStageDir === "string" && this.options.registryStageDir.length > 0 ? {
          WINSTAGE_REGSTAGE_SESSION_DIR: this.options.registryStageDir,
          DSH_REGSTAGE_ROOT: this.options.registryStageDir
        } : {}
      },
      captureDir: this.stagingRoot,
      spawn: typeof cap.spawnTransparentProcess === "function" ? cap.spawnTransparentProcess : spawnCapturedAsync
    });
    this.initReport = await this.selfTest();
    this.stageGrant = {
      root: this.stagingRoot,
      source: this.stagingRootSource,
      override: this.stageGrantPlan.override === true,
      writable: this.mode === "workspace-write",
      enforcement: "shim-user-mode",
      granted: false,
      verified: false,
      reason: "this mode enforces staging writes in user space; no capability-SID entry is written",
      hostCreated: existsSync3(this.stagingRoot)
    };
    this.prepareNetworkPolicy();
    Object.assign(this.initReport, {
      initMs: Date.now() - started,
      mode: this.mode,
      stagingRoot: this.stagingRoot,
      tempDir: this.tempDir,
      // 缺陷③（Fix B）：本次 init 在暂存根上做的陈旧包 SID ACE 修复
      // （修复发生在 `init()` 顶部，早于通道判定，因此这里读实例字段）
      staleAppContainerAces: this.staleAceRepair,
      // Phase 2 / WP1：本档的写授权记录（机制 = shim 用户态，非 ACL）
      stagingGrant: this.stageGrant,
      tier: this.tier,
      tierRequested: this.tierRequested,
      tierEffective: this.tierEffective,
      launchMode: this.launchMode,
      fallbackReason: this.fallbackReason,
      // 三轮接线的三个维度摘要
      ...this.dimensionSummaries(),
      backend: "winstage-shim-iat",
      enforcement: "shim-user-mode",
      jobEnabled: false,
      jobAccounting: null,
      treeReclaim: "taskkill /T /F (transparent mode has no Job Object)",
      transparentShim: this.transparent ? {
        available: this.transparent.available,
        reason: this.transparent.reason,
        artifacts: this.transparent.artifacts,
        transport: this.transparent.transport,
        checks: this.transparent.checks,
        abiVersion: this.transparent.abiVersion,
        canary: this.transparent.canary,
        canaryJudge: this.transparent.canaryJudge
      } : void 0,
      shimConfig: config,
      shimConfigPath: configPath
    });
    return this.initReport;
  }
  /** fail-closed 初始化：任何 Win32 失败都抛错，绝不降级为无沙箱（手册 1.2 / 5.2） */
  async init() {
    if (this.sandbox || this.launchMode === "shim") return this.initReport;
    if (process.platform !== "win32") {
      throw fail("SANDBOX_UNAVAILABLE", 'the Windows stage sandbox requires process.platform === "win32"');
    }
    if (!this.stagingRoot) throw fail("SANDBOX_UNAVAILABLE", "stagingRoot is required \u2014 refusing to confine an unspecified root");
    try {
      mkdirSync3(this.stagingRoot, { recursive: true });
    } catch (error) {
      throw stageGrantError(STAGE_GRANT_REASONS.ROOT_NOT_CREATABLE, {
        root: this.stagingRoot,
        detail: `${error.code ?? "ERR"}: ${error.message}`,
        steps: [{ step: "host-create-root", ok: false, by: "host-process", root: this.stagingRoot }]
      });
    }
    this.noteStagingRootSampling("init");
    const staleRepair = this.repairStaleStagingAces();
    const cap = _WindowsStageExecutor.capabilities(this.options.overrides);
    const requested = this.options.tier ?? process.env.WINSTAGE_TIER ?? "T1";
    this.tierRequested = requested;
    const wantsTransparent = String(requested).toUpperCase() === TRANSPARENT_TIER || String(requested).toLowerCase() === "auto";
    if (wantsTransparent && typeof cap.probeTransparentShim === "function") {
      this.transparent = cap.probeTransparentShim({
        stagingRoot: this.stagingRoot,
        tempDir: this.options.tempDir,
        passthrough: this.options.shimPassthrough,
        timeoutMs: this.options.shimProbeTimeoutMs,
        captureDir: this.stagingRoot,
        registryStageDir: this.options.registryStageDir,
        ...this.options.shimOptions ?? {}
      });
    }
    const selected = selectLaunchMode(requested, this.transparent);
    this.launchMode = selected.mode;
    this.tierEffective = selected.tierEffective;
    this.tier = selected.tierEffective;
    this.fallbackReason = selected.fallbackReason;
    if (this.launchMode === "shim") return this.initTransparent(cap);
    if (!cap.aclAvailable) {
      throw fail(
        "SANDBOX_UNAVAILABLE",
        `@deepseek-ai/dsh-sandbox-windows-acl is not loadable (${cap.aclError}). Refusing to run unconfined \u2014 binding the workspace writable without an enforcing backend is forbidden (manual \xA71.2/\xA75.2).`
      );
    }
    const tempDir = this.options.tempDir || defaultPrivateTemp();
    mkdirSync3(tempDir, { recursive: true });
    if (typeof cap.assertPrivateTempDisjoint === "function") {
      cap.assertPrivateTempDisjoint([this.stagingRoot], tempDir);
    }
    const writable = this.mode === "workspace-write";
    const started = Date.now();
    const grant = await ensureStageGrant({
      target: { ...this.stageGrantPlan, root: this.stagingRoot },
      writable,
      resolveWriteSid: (root) => cap.workspaceWriteSid(root),
      // 授权动作本身仍由 ACL 后端做（令牌构造 + ACE 写入），本文件不重写它；
      // 后端抛错 / 回报失败一律被 `ensureStageGrant` 归因成 `STAGE_GRANT_FAILED`。
      runGrant: async (root, writeSid) => ({
        value: await initAclSandboxWithTokenCapture(cap.AclSandbox, {
          writableDirs: writable ? [root] : [],
          tempDir: writable ? tempDir : null,
          writeSid,
          tempWriteSid: writable && tempDir ? cap.tempWriteSid(tempDir) : void 0,
          mode: this.mode
        })
      }),
      readSddl: this.options.readSddl,
      parseSddl: this.options.parseSddl,
      captureDir: this.options.icaclsCaptureDir,
      verifyStageGrantAce: this.options.verifyStageGrantAce,
      // 调用方注入了 `overrides.AclSandbox` 替身 ⇒ 替身不写真实 ACE，回读注定测不到。
      // 显式声明这条缝（而不是靠"writeSid 长得像假的"之类猜测），语义与
      // `assertPrivateTempDisjoint` 等替身缝一致：生产不注入即走严格判据。
      injectedBackend: Boolean(this.options.overrides?.AclSandbox)
    });
    this.stageGrant = {
      root: this.stagingRoot,
      source: this.stagingRootSource,
      override: this.stageGrantPlan.override === true,
      writable,
      // 本档的强制机制：能力 SID（`S-1-4-…`）在暂存根上的写 ACE。闸门只对这条档生效。
      enforcement: "acl-write-sid",
      granted: grant.granted === true,
      writeSid: grant.writeSid,
      verified: grant.verification?.verified === true,
      verification: grant.verification,
      hostCreated: grant.hostCreated === true,
      created: grant.created === true,
      steps: grant.steps
    };
    const { sandbox, api: capturedApi, token, fieldNames } = grant.value;
    const lowLevel = cap.processBindings;
    if (!lowLevel || typeof lowLevel.createProcessAsUserW !== "function") {
      safeDispose(sandbox);
      throw fail(
        "SANDBOX_UNAVAILABLE",
        "loadWin32ProcessBindings() did not return a usable low-level table (createProcessAsUserW missing)"
      );
    }
    if (typeof cap.spawnPipedProcess !== "function") {
      safeDispose(sandbox);
      throw fail(
        "SANDBOX_UNAVAILABLE",
        "the win32-process module did not export spawnPipedProcess; cannot launch a confined child with an explicit environment block (manual \xA78.3)."
      );
    }
    const { merged, added, skipped } = mergeBindingTables(lowLevel, capturedApi);
    for (const required of ["createProcessAsUserW", "createPipe", "assignProcessToJobObject", "setInformationJobObject"]) {
      if (typeof merged[required] !== "function") {
        safeDispose(sandbox);
        throw fail("SANDBOX_UNAVAILABLE", `the merged binding table lacks the required primitive ${required}`);
      }
    }
    this.spawnPipedProcess = cap.spawnPipedProcess;
    this.sandbox = sandbox;
    this.api = merged;
    this.token = token;
    this.tempDir = writable ? tempDir : void 0;
    this.launcher = new RestrictedLauncher(merged, token, cap.spawnPipedProcess, this.options);
    this.processLibrary = cap.processLibrary;
    if (typeof this.processLibrary?.drainPipe !== "function" || typeof this.processLibrary?.waitForProcessExit !== "function") {
      safeDispose(sandbox);
      throw fail(
        "SANDBOX_UNAVAILABLE",
        "the process library did not expose drainPipe/waitForProcessExit; confined child output cannot be collected"
      );
    }
    const jobInfo = this.launcher.createJob();
    this.job = jobInfo.job;
    let jobAccounting;
    const probe = this.launcher.createJob();
    try {
      jobAccounting = this.launcher.activeProcesses(probe.job);
      if (jobAccounting.activeProcesses !== 0 || jobAccounting.totalProcesses !== 0) {
        throw new Error(
          `fresh job reports active=${jobAccounting.activeProcesses} total=${jobAccounting.totalProcesses}, expected zeros`
        );
      }
    } catch (error) {
      try {
        this.api.closeHandle(probe.job);
      } catch {
      }
      try {
        this.api.closeHandle(this.job);
      } catch {
      }
      safeDispose(this.sandbox);
      throw fail(
        "SANDBOX_UNAVAILABLE",
        `Job Object self-check failed (${error.message}); refusing to run with an unverified job structure`
      );
    }
    this.launcher.jobs.delete(probe.job);
    safeClose(this.api, probe.job);
    const resident = this.launcher.activeProcesses(this.job);
    if (resident.totalProcesses !== 0 || resident.activeProcesses !== 0) {
      safeDispose(this.sandbox);
      throw fail(
        "SANDBOX_UNAVAILABLE",
        `the resident job is not empty at startup (active=${resident.activeProcesses} total=${resident.totalProcesses}); the host process must not be assigned to it`
      );
    }
    this.initReport = await this.selfTest();
    let appContainer = null;
    if (String(this.tier).toUpperCase() === "T0") {
      try {
        appContainer = await createAppContainerLauncher({
          api: this.api,
          grantPaths: [this.stagingRoot, this.tempDir].filter(Boolean),
          capabilities: this.options.capabilities ?? [],
          profileName: this.options.profileName,
          // 三轮接线：把进程缓解策略传进 T0 启动路径。默认 `none` ⇒ 构造出的策略
          // `flags === 0n` ⇒ 属性列表仍是 1 个槽位、一次 `UpdateProcThreadAttribute`，
          // 与接线前**逐字一致**（判据在 appcontainer-runtime 的 attributeListCountFor）。
          mitigationPolicy: this.mitigationPolicyBuilt
        });
        this.appContainer = appContainer.launcher;
        this.appContainerInfo = {
          profileName: appContainer.profileName,
          sid: appContainer.sid,
          createdProfile: appContainer.createdProfile,
          grants: appContainer.grants,
          attributeListSize: appContainer.attributeListSize,
          mitigation: appContainer.mitigation ?? null
        };
      } catch (error) {
        try {
          this.launcher?.dispose();
        } catch {
        }
        safeClose(this.api, this.job);
        safeDispose(this.sandbox);
        throw fail(
          "SANDBOX_UNAVAILABLE",
          `tier=T0 was requested but the AppContainer launch path could not be established (${error.code ?? ""} ${error.message}). Refusing to fall back to T1: the report would then claim T0 while the child is an ordinary process.`
        );
      }
    }
    this.prepareNetworkPolicy();
    Object.assign(this.initReport, {
      initMs: Date.now() - started,
      mode: this.mode,
      stagingRoot: this.stagingRoot,
      tempDir: this.tempDir,
      capturedFields: fieldNames,
      bindingTable: { addedFromAcl: added, keptFromProcessLibrary: skipped.length },
      jobFlags: `0x${jobInfo.flags.toString(16)}`,
      jobConfig: jobInfo.config,
      jobAccounting,
      // 缺陷③（Fix B）：本次 init 在暂存根上做的陈旧包 SID ACE 修复（含"没发现"这一如实结论）
      staleAppContainerAces: staleRepair,
      // ── Phase 2 / WP1：本次运行在暂存根上做的**写授权**（目标来源 + 回读结论）──────
      // `source` 让人一眼看出根是显式 override 来的还是 `resolveStageRoot()` 解析的；
      // `verified` 是回读 DACL 的结论。失败不会走到这里（上面已经 fail-closed 抛错）。
      stagingGrant: this.stageGrant,
      tier: this.tier,
      tierRequested: this.tierRequested,
      tierEffective: this.tierEffective,
      launchMode: this.launchMode,
      fallbackReason: this.fallbackReason,
      // 三轮接线的三个维度摘要（同一份口径也出现在 run() 结果里）
      ...this.dimensionSummaries(),
      transparentShim: this.transparent ? {
        available: this.transparent.available,
        reason: this.transparent.reason,
        artifacts: this.transparent.artifacts,
        transport: this.transparent.transport,
        checks: this.transparent.checks,
        abiVersion: this.transparent.abiVersion
      } : void 0,
      appContainer: this.appContainerInfo
    });
    return this.initReport;
  }
  /**
   * ── 缺陷③（Fix B）：`init` 侧的**修复路径** ─────────────────────────────────────
   *
   * 检测暂存根上"被显式写进去的 AppContainer 包 SID 允许 ACE"
   * （`S-1-15-2-…:(OI)(CI)(M)`，上一次 T0 运行为了包 SID 能写暂存根而授予、却没撤销），
   * 并把它们摘掉，让之后的 T1 暂存写重新可用。
   *
   * 三条纪律：
   *   ① **只碰暂存根**（`this.stagingRoot`）：不下钻、不碰父目录、不碰 tempDir，
   *      因为判据（`findStaleAppContainerAces`）只对"显式写入"的 ACE 成立，
   *      而本仓库唯一会往树里写这种 ACE 的地方就是 T0 的 `grantPaths`；
   *   ② 测不出来就说测不出来（`sddlAvailable:false`）—— **不**把"读不到 DACL"读成"干净"；
   *   ③ 摘不干净也如实报（`repaired:false` + `remaining`），由 Fix A 闸门拒绝运行，
   *      而不是"假装修好了"继续跑。
   *
   * 人读通道：`init` 的格式化输出会打印 `⚠ 清理…`（见 `src/capability.ts::formatReport`），
   * 模型可见的 `exec` stdout 不受影响（本函数什么都不打印）。
   */
  repairStaleStagingAces() {
    if (this.options.repairStaleAces === false) {
      return { checked: false, repaired: false, removed: [], remaining: [], present: [], skipped: "disabled-by-option" };
    }
    if (!this.stagingRoot) {
      return { checked: false, repaired: false, removed: [], remaining: [], present: [], skipped: "no-staging-root" };
    }
    let result;
    try {
      result = (this.options.repairStaleAcesImpl ?? repairStaleAppContainerAces)(this.stagingRoot, {
        captureDir: this.options.icaclsCaptureDir
      });
    } catch (error) {
      return {
        checked: true,
        repaired: false,
        removed: [],
        remaining: [],
        present: [],
        sddlAvailable: false,
        verifyAvailable: false,
        reason: `stale-ACE repair threw: ${error.message}`
      };
    }
    this.staleAceRepair = result;
    return { checked: true, ...result };
  }
  /**
   * 实例级实测（手册 #5.5：缓存成功不能替代实例启动后的必要检查）。
   * 关键：必须从**沙箱内部**发起真实攻击探针，而不是从宿主侧推断。
   */
  async selfTest() {
    if (this.launchMode === "shim") return this.selfTestTransparent();
    const checks = [];
    const stamp = `${Date.now().toString(36)}${randomUUID3().slice(0, 4)}`;
    const inside = join6(this.stagingRoot, `.dsh-selfcheck-${stamp}.txt`);
    const outside = join6(dirname4(this.stagingRoot), `.dsh-selfcheck-outside-${stamp}.txt`);
    const system = `C:\\Windows\\dsh-selfcheck-${stamp}.txt`;
    const script = [
      "$r=[ordered]@{}",
      `try{Set-Content -LiteralPath '${ps(inside)}' -Value 'x' -ErrorAction Stop;$r.inside='ok'}catch{$r.inside='denied'}`,
      `try{Set-Content -LiteralPath '${ps(outside)}' -Value 'x' -ErrorAction Stop;$r.outside='ok'}catch{$r.outside='denied'}`,
      `try{Set-Content -LiteralPath '${ps(system)}' -Value 'x' -ErrorAction Stop;$r.system='ok'}catch{$r.system='denied'}`,
      `try{[void](Get-Content -LiteralPath 'C:\\Windows\\win.ini' -ErrorAction Stop);$r.readSystem='ok'}catch{$r.readSystem='denied'}`,
      "$r.temp=$env:TEMP",
      "$r.user=$env:USERNAME",
      "$r.secret=$($null -eq $env:DSH_TEST_SECRET)",
      "[Console]::Out.Write(($r|ConvertTo-Json -Compress))"
    ].join(";");
    let outcome;
    try {
      const shell = resolvePowerShell(process.env, this.stagingRoot);
      outcome = await this.run({
        command: shell.name,
        args: ["-NoLogo", "-NonInteractive", "-NoProfile", "-Command", script],
        cwd: this.stagingRoot,
        timeoutMs: this.options.selfTestTimeoutMs ?? 9e4,
        env: { DSH_TEST_SECRET: "should-not-appear" },
        // 自检就是产出"暂存根能不能写"这条证据的那次运行 —— Fix A 的闸门必须豁免它，
        // 否则会在证据存在之前拒绝自己（先有鸡还是先有蛋）。
        skipStagingWritePreflight: true
      });
    } catch (error) {
      checks.push({ name: "self-test-spawn", status: "fail", detail: error.message, evidence: "[\u5B9E\u6D4B]" });
      cleanupTargets([inside, outside, system]);
      return { checks, enforcement: "unknown" };
    }
    let parsed;
    const lastLine = outcome.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    try {
      parsed = JSON.parse(lastLine || "{}");
    } catch {
      parsed = void 0;
    }
    const pass = (name, condition, detail) => checks.push({ name, status: condition ? "pass" : "fail", detail, evidence: "[\u5B9E\u6D4B] \u4ECE\u6C99\u7BB1\u5185\u90E8\u53D1\u8D77" });
    pass("inside-staging-write-allowed", parsed?.inside === "ok", parsed?.inside ?? outcome.stderr.slice(0, 300));
    pass("outside-staging-write-denied", parsed?.outside === "denied", parsed?.outside ?? "no result");
    pass("system-dir-write-denied", parsed?.system === "denied", parsed?.system ?? "no result");
    pass("temp-rewritten-to-private", typeof parsed?.temp === "string" && sameDir(parsed.temp, this.tempDir), `TEMP=${parsed?.temp}`);
    pass("sensitive-env-not-inherited", parsed?.secret === true, `DSH_TEST_SECRET present=${parsed?.secret === false}`);
    checks.push({
      name: "system-file-read",
      status: parsed?.readSystem === "denied" ? "pass" : "documented-residual",
      detail: parsed?.readSystem === "denied" ? "\u8BFB\u53D6\u88AB\u62D2\uFF08\u8D85\u51FA\u9884\u671F\uFF0C\u53EF\u80FD\u7531\u5BBF\u4E3B ACL \u800C\u975E\u672C\u6C99\u7BB1\u9020\u6210\uFF09" : "\u8BFB\u53D6\u6210\u529F \u2014\u2014 WRITE_RESTRICTED \u4E0E Low IL \u5747\u4E0D\u9650\u5236\u8BFB\u53D6\uFF08\u624B\u518C #16.10 \u6B8B\u4F59\u8FB9\u754C\uFF0C\u4E0D\u5F97\u58F0\u660E\u4E3A\u786C\u8FB9\u754C\uFF09",
      evidence: "[\u5B9E\u6D4B] \u4ECE\u6C99\u7BB1\u5185\u90E8\u53D1\u8D77"
    });
    try {
      const accounting = this.launcher.activeProcesses(this.job);
      checks.push({
        name: "job-object-accounting",
        status: "pass",
        detail: `totalProcesses=${accounting.totalProcesses} active=${accounting.activeProcesses} terminated=${accounting.terminatedProcesses}`,
        evidence: "[\u5B9E\u6D4B]"
      });
    } catch (error) {
      checks.push({ name: "job-object-accounting", status: "fail", detail: error.message, evidence: "[\u5B9E\u6D4B]" });
    }
    cleanupTargets([inside, outside, system]);
    const enforcement = checks.every((c) => c.status === "pass" || c.status === "documented-residual") ? "partial" : "degraded";
    return { checks, enforcement, observed: parsed, exitCode: outcome.exitCode };
  }
  /**
   * 去令牌化模式的实例自检（手册 #5.5：缓存"探测通过"不能替代实例启动后的检查）。
   *
   * 判据与受限令牌模式**不同**，这一点必须写死在两条路径里而不是复用：
   *   - 工作区外写入「报告成功」是**预期**（被 shim 重定向进暂存），
   *     因此判据是「报成功 + 宿主侧真实磁盘没有它 + 暂存树里有它」；
   *   - 另加金丝雀结论（四类能力真的恢复）与痕迹断言（无 `DSH_SANDBOX*`）。
   */
  async selfTestTransparent() {
    const checks = [];
    const stamp = `${Date.now().toString(36)}${randomUUID3().slice(0, 4)}`;
    const outside = `C:\\Windows\\Temp\\winstage-shim-selfcheck-${stamp}.txt`;
    const judge = this.transparent?.canaryJudge;
    checks.push({
      name: "transparent-capability-canary",
      status: judge?.ok ? "pass" : "fail",
      detail: `\u7ECF\u6CE8\u5165\u5668\u542F\u52A8\u7684\u91D1\u4E1D\u96C0\u5B50\u8FDB\u7A0B: ${judge?.reason ?? "\u65E0\u91D1\u4E1D\u96C0\u7ED3\u679C"}; items=${JSON.stringify(judge?.items ?? {})}`,
      evidence: "[\u5B9E\u6D4B] winstage-inject.exe \u2192 \u91D1\u4E1D\u96C0 PowerShell"
    });
    const script = [
      "$ErrorActionPreference='Continue'",
      `try { Set-Content -LiteralPath '${ps(outside)}' -Value 'winstage-shim' -ErrorAction Stop; 'SHIM-WRITE=ok' } catch { 'SHIM-WRITE=denied:' + $_.Exception.GetType().Name }`,
      `try { [void](Get-Content -LiteralPath '${ps(outside)}' -ErrorAction Stop); 'SHIM-READBACK=ok' } catch { 'SHIM-READBACK=denied' }`
    ].join("\r\n");
    let outcome;
    try {
      const shell = resolvePowerShell(process.env, this.stagingRoot);
      outcome = await this.run({
        command: shell.name,
        args: ["-NoLogo", "-NonInteractive", "-NoProfile", "-Command", script],
        cwd: this.stagingRoot,
        timeoutMs: this.options.selfTestTimeoutMs ?? 9e4,
        // 与受限令牌路径同理：自检自己产出判据，Fix A 闸门豁免它。
        skipStagingWritePreflight: true
      });
    } catch (error) {
      checks.push({ name: "transparent-self-test-spawn", status: "fail", detail: error.message, evidence: "[\u5B9E\u6D4B]" });
      return { checks, enforcement: "degraded" };
    }
    const reported = /SHIM-WRITE=ok/.test(outcome.stdout);
    const realExists = existsSync3(outside);
    let staged;
    try {
      staged = findFileUnder(this.stagingRoot, `winstage-shim-selfcheck-${stamp}.txt`);
    } catch {
      staged = void 0;
    }
    checks.push({
      name: "outside-write-staged-not-real",
      status: reported && !realExists && staged ? "pass" : "fail",
      detail: `child-reported-ok=${reported} real-disk-has-file=${realExists} staged=${staged ?? "not-found"} exit=${outcome.exitCode}`,
      evidence: "[\u5B9E\u6D4B] \u4ECE\u6C99\u7BB1\u5185\u90E8\u53D1\u8D77\u5199\u3001\u5BBF\u4E3B\u4FA7\u6838\u5BF9\u771F\u5B9E\u78C1\u76D8\u4E0E\u6682\u5B58\u6811"
    });
    if (realExists) {
      try {
        unlinkSync2(outside);
      } catch {
      }
    }
    checks.push({
      name: "no-dsh-sandbox-trace",
      status: this.transparent?.canary?.dshSandboxCount === 0 ? "pass" : "fail",
      detail: `\u5B50\u8FDB\u7A0B\u91CC\u7684 DSH_SANDBOX* \u53D8\u91CF: ${JSON.stringify(this.transparent?.canary?.dshSandboxVars ?? null)}`,
      evidence: "[\u5B9E\u6D4B] \u91D1\u4E1D\u96C0\u5B50\u8FDB\u7A0B\u73AF\u5883\u626B\u63CF"
    });
    const enforcement = checks.every((check) => check.status === "pass" || check.status === "documented-residual") ? "shim-user-mode" : "degraded";
    return { checks, enforcement, observed: this.transparent?.canary, exitCode: outcome.exitCode };
  }
  /**
   * 解析可执行文件的绝对路径。
   *
   * 为什么必须自己做（`[实测]` 缺陷 6）：`CreateProcessAsUserW` **不做** shell 式的
   * 可执行文件解析 —— 它不会补 `PATHEXT`（`.exe`/`.cmd`/…），也不走 App Paths 注册表。
   * 传 `pwsh` 这种裸名字会直接失败，Win32 错误 2（ERROR_FILE_NOT_FOUND）。
   * 因此必须在宿主侧把命令解析成绝对路径，再用受限令牌启动。
   *
   * 解析顺序（与 CreateProcess 的搜索顺序一致）：
   *   1. 已是绝对路径且存在 → 直接用
   *   2. 含目录分隔符 → 相对 cwd / PATH 各目录拼接
   *   3. 裸名字 → 依次尝试 pathExt 里的每个扩展名，逐个 PATH 目录查找
   *   4. 都找不到 → 抛 ENOENT，并附上搜过哪些位置（不要静默失败）
   */
  static resolveExecutable(command, options = {}) {
    return resolveExecutable(command, options);
  }
  /**
   * 收集已启动子进程的结果。
   *
   * **真实的 API 形状**（真实缺陷 15）：`spawnPipedProcess` 返回的是
   * `{ pid, process, stdoutRead, stderrRead }` —— 它**没有** `wait()` 方法。
   * 管道必须用 `drainPipe(api, handle)` 读完，退出码要用
   * `waitForProcessExit(api, process)` 取。
   *
   * 早先的实现照搬了 `AclSandbox.spawn()` 的 `{ pid, wait() }` 形状，
   * 于是运行期报 `child.wait is not a function`；
   * 而**替身当时伪造了 `wait()`**，所以这个错误在离线测试里漏过了 ——
   * 替身失真比没有替身更危险，因为它给出虚假的通过。
   *
   * @param {{pid:number, process:unknown, stdoutRead:unknown, stderrRead:unknown}} child
   * @returns {Promise<{stdout: Buffer, stderr: Buffer, exitCode: number}>}
   */
  async collectChild(child) {
    const { drainPipe, waitForProcessExit } = this.processLibrary ?? {};
    if (typeof drainPipe !== "function" || typeof waitForProcessExit !== "function") {
      throw fail(
        "SANDBOX_UNAVAILABLE",
        "the process library did not expose drainPipe/waitForProcessExit; cannot collect confined child output"
      );
    }
    const api = this.api;
    const exitWait = new Promise((resolve3, reject) => {
      queueMicrotask(() => {
        setTimeout(() => {
          try {
            resolve3(waitForExitWithoutStarvingEventLoop(api, child.process, waitForProcessExit));
          } catch (error) {
            reject(error);
          }
        }, 0);
      });
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      drainPipe(api, child.stdoutRead),
      drainPipe(api, child.stderrRead),
      exitWait
    ]);
    return {
      stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? "")),
      stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr ?? "")),
      exitCode
    };
  }
  /**
   * ── 三轮接线：网络策略准备（判定 → 仅 OFFLINE 时安装/回读 → 记录）────────────────
   *
   * 幂等：第一次调用做完就缓存（`networkPolicyPrepared`）。三件事必须一起看：
   *   1. **判定**：`resolveNetworkPolicy()` 不因"计划能构造出来"就报 `ENFORCED`；
   *      它要求"安装证据 + 回读核对"（或本机确实没有回读入口）。
   *   2. **安装**：只有 OFFLINE、且判定结果里 `plan` 非空（= 绑定表/pin/探测/引擎/计划
   *      五步全过，唯一缺的就是安装证据）时才真的装。装的过程由 `netpolicy` 自己
   *      best-effort 回滚；本函数把 `teardown` 收好，`dispose()` 时拆。
   *   3. **失败不吞**：安装/回读失败 ⇒ 记 `not-enforced` 并把底层 code 拼进 reason，
   *      绝不改写成 enforced。
   *
   * 默认档位 `OBSERVED_ONLINE` 下本函数是**纯判定**：不安装、不改系统状态
   * （`resolveNetworkPolicy` 对非 OFFLINE 档位不碰绑定表）。
   */
  prepareNetworkPolicy() {
    if (this.networkPolicyPrepared) return this.networkPolicy;
    this.networkPolicyPrepared = true;
    const requested = this.networkTier;
    const api = this.options.networkBindings ?? this.api ?? null;
    const resolveInput = {
      requested,
      api,
      probe: this.options.networkProbe ?? null,
      guids: this.options.networkGuids ?? null,
      target: this.options.networkTarget ?? "appcontainer",
      pin: this.options.networkPin ?? null
    };
    let result = resolveNetworkPolicy({
      ...resolveInput,
      install: this.networkInstallEvidence ?? null,
      audit: this.networkInstallAudit ?? null
    });
    if (requested === "OFFLINE" && result.state !== NETWORK_TIER_STATES.ENFORCED && result.plan) {
      try {
        const installed = installNetworkPolicy({
          api,
          plan: result.plan,
          guids: resolveInput.guids,
          pin: resolveInput.pin,
          retainPointer: this.options.networkRetainPointer
        });
        this.networkInstallEvidence = installed;
        this.networkInstallAudit = installed.audit;
        this.networkTeardown = typeof installed.teardown === "function" ? installed.teardown : void 0;
        result = resolveNetworkPolicy({ ...resolveInput, install: installed, audit: installed.audit });
      } catch (error) {
        result = {
          ...result,
          state: NETWORK_TIER_STATES.NOT_ENFORCED,
          enforced: false,
          verified: false,
          reason: `${result.reason}\uFF1B\u5B89\u88C5/\u56DE\u8BFB\u5931\u8D25\uFF08${error.code ?? "NETWORK_POLICY_INSTALL_FAILED"}\uFF09\uFF1A${error.message} \u2014\u2014 \u7F51\u7EDC\u6CA1\u6709\u88AB\u6321\u4F4F\uFF0C\u56E0\u6B64\u4E0D\u5F97\u58F0\u79F0\u5DF2\u5F3A\u5236`
        };
      }
    }
    this.networkPolicyResult = result;
    this.networkPolicy = summariseNetworkPolicy(result);
    return this.networkPolicy;
  }
  /**
   * ── 三轮接线：网络 fail-closed 闸门（`run()` 的第一道门）─────────────────────────
   *
   * `OFFLINE` 档位若拿不到 `state:'enforced'`，**拒绝执行任何命令**：
   * 错误码 `SANDBOX_NETWORK_POLICY_UNENFORCED`，message 里带 netpolicy 的 `reason`。
   * 这是"绝不悄悄放行网络"的唯一落地点 —— 判定说挡不住就不跑，而不是照跑不误。
   */
  assertNetworkPolicyEnforceable() {
    const summary = this.prepareNetworkPolicy();
    if (this.networkTier === "OFFLINE" && summary.state !== NETWORK_TIER_STATES.ENFORCED) {
      throw fail(
        "SANDBOX_NETWORK_POLICY_UNENFORCED",
        `networkTier=OFFLINE \u4F46\u7F51\u7EDC\u7B56\u7565\u6CA1\u6709\u771F\u6B63\u751F\u6548\uFF08state=${summary.state}, enforced=${summary.enforced}, verified=${summary.verified}\uFF09\uFF1A${summary.reason} \u2014\u2014 \u62D2\u7EDD\u5728"\u4EE5\u4E3A\u7F51\u7EDC\u5DF2\u963B\u65AD\u3001\u5B9E\u9645\u662F\u901A\u7684"\u72B6\u6001\u4E0B\u6267\u884C\u4EFB\u4F55\u547D\u4EE4\uFF08fail-closed\uFF09`
      );
    }
    return summary;
  }
  /**
   * ── 三轮接线：暂存配额闸门 ──────────────────────────────────────────────────────
   *
   * fail-closed 两条：
   *   1. `checkStagingQuota()` 判定超配额 ⇒ `STAGING_QUOTA_EXCEEDED`（写入之前就拒绝，
   *      而不是写完再量）；
   *   2. **统计不完整**（`truncated` 或 `errors` 非空）⇒ `STAGING_QUOTA_MEASUREMENT_INCOMPLETE`。
   *      这一条是硬要求：统计不了的树等于配额的洞，宁可拒绝写入。
   *      （`limits.ts` 的"接线契约"把这条判断留给调用方 —— 本方法就是那个调用方。）
   *
   * 默认配额 = `options.limits.stagingBytes`（= 64 GiB）；`stagingQuotaBytes: null` 显式关闭。
   */
  assertStagingQuota(incomingBytes = 0, where = "staging-write") {
    const quotaBytes = this.options.stagingQuotaBytes !== void 0 ? this.options.stagingQuotaBytes : this.limits.stagingBytes;
    if (quotaBytes === null) return { allowed: true, reason: "staging quota explicitly disabled (stagingQuotaBytes:null)" };
    if (this.stagingRoot && !existsSync3(this.stagingRoot)) mkdirSync3(this.stagingRoot, { recursive: true });
    const measure = typeof this.options.measureStaging === "function" ? this.options.measureStaging : measureTree;
    const decision = checkStagingQuota({
      root: this.stagingRoot,
      quotaBytes,
      incomingBytes,
      measure,
      measureOptions: this.options.measureStagingOptions ?? {}
    });
    if (decision.measure && decision.measure.complete === false) {
      const error = fail(
        "STAGING_QUOTA_MEASUREMENT_INCOMPLETE",
        `\u6682\u5B58\u914D\u989D\u7EDF\u8BA1\u4E0D\u5B8C\u6574\uFF08truncated=${decision.measure.truncated}, errors=${decision.measure.errors}\uFF09\uFF1B\u62D2\u7EDD\u5199\u5165 ${where}\uFF1A${decision.reason} \u2014\u2014 \u7EDF\u8BA1\u4E0D\u4E86\u7684\u6811\u7B49\u4E8E\u914D\u989D\u7684\u6D1E\uFF08fail-closed\uFF09`
      );
      error.quota = decision;
      throw error;
    }
    if (!decision.allowed) {
      const error = fail("STAGING_QUOTA_EXCEEDED", `\u6682\u5B58\u914D\u989D\u4E0D\u8DB3\uFF0C\u62D2\u7EDD\u5199\u5165 ${where}\uFF1A${decision.reason}`);
      error.quota = decision;
      throw error;
    }
    return decision;
  }
  /**
   * ── 三轮接线：三个维度的报告摘要（`initReport` 与 `run()` 结果共用同一份口径）────
   * 合在一处是为了"报告只有一份投影"：任何消费方读到的都是同一组字段。
   */
  dimensionSummaries() {
    return {
      networkPolicy: this.prepareNetworkPolicy(),
      mitigations: summariseMitigations(this.mitigationPolicyBuilt),
      limits: summariseLimits(this.limits)
    };
  }
  /**
   * 拆除本次安装的 WFP 策略（幂等；**从不抛错**，失败如实返回给调用方）。
   *
   * 顺序与语义由 `netpolicy.installNetworkPolicy().teardown()` 承担（删 filter 逆序 →
   * 删 sublayer → 关引擎；DYNAMIC 会话是兜底）。本方法只负责调用一次并记账。
   */
  teardownNetworkPolicy() {
    if (!this.networkTeardown) return [];
    const teardown = this.networkTeardown;
    this.networkTeardown = void 0;
    this.networkInstallEvidence = void 0;
    this.networkInstallAudit = void 0;
    try {
      const result = teardown();
      this.networkTeardownResult = result;
      return (result?.failures ?? []).map((text) => `network teardown: ${text}`);
    } catch (error) {
      return [`network teardown threw: ${error.message}`];
    }
  }
  /** 在受限令牌下执行一次命令，返回结构化结果（手册第 4 章返回契约） */
  async run(options) {
    if (!this.sandbox && this.launchMode !== "shim") {
      throw fail("SANDBOX_UNAVAILABLE", "executor is not initialised; call init() first (fail-closed)");
    }
    this.assertNetworkPolicyEnforceable();
    this.assertStagingQuota(0, "run-preflight");
    if (options.skipStagingWritePreflight !== true) this.assertStagingRootPresent("run-preflight");
    if (options.skipStagingWritePreflight !== true) {
      this.assertStagingWriteEnforceable({ command: options.command, args: options.args });
    }
    const cwd = options.cwd || this.stagingRoot;
    if (!sameDirOrInside(this.stagingRoot, cwd)) {
      throw fail("CWD_OUTSIDE_STAGING", `cwd ${cwd} is outside the staged root ${this.stagingRoot}`);
    }
    if (!existsSync3(cwd)) mkdirSync3(cwd, { recursive: true });
    const { env, rejected } = buildChildEnvironment(options.env, {
      tempDir: this.tempDir,
      cwd,
      tier: this.tier
    });
    const cleartext = detectCleartextSecret([options.command, ...options.args || []].join(" "));
    if (cleartext.matched) {
      const denial = fail(CLEARTEXT_SECRET_FAILURE.code, CLEARTEXT_SECRET_FAILURE.message);
      denial.category = CLEARTEXT_SECRET_FAILURE.category;
      denial.secretKind = cleartext.kind;
      denial.secretSnippet = cleartext.snippet;
      throw denial;
    }
    const resolvedCommand = resolveExecutable(options.command, { cwd, env });
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 12e4;
    let child;
    let launchFailure;
    const t0 = this.launchMode === "appcontainer" && this.appContainer !== void 0 && this.appContainer !== null;
    const transparent = this.launchMode === "shim";
    try {
      if (t0) {
        child = this.appContainer.launch({
          command: resolvedCommand,
          args: options.args || [],
          cwd,
          job: this.job,
          timeoutMs,
          env
        });
      } else if (transparent) {
        child = await this.shimLauncher.launch({
          command: resolvedCommand,
          args: options.args || [],
          cwd,
          env,
          timeoutMs
        });
      } else {
        child = this.launcher.launch({
          command: resolvedCommand,
          args: options.args || [],
          cwd,
          env,
          job: this.job
        });
      }
    } catch (error) {
      launchFailure = error;
    }
    let timedOut = false;
    const timeoutPromise = new Promise((resolve3) => {
      const handle = setTimeout(() => {
        timedOut = true;
        resolve3({ stdout: Buffer.alloc(0), stderr: Buffer.from(`dsh-stage: timeout after ${timeoutMs}ms`), exitCode: 124 });
      }, timeoutMs);
      if (typeof handle.unref === "function") handle.unref();
    });
    let settled;
    if (launchFailure) {
      settled = {
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(`dsh-stage: sandbox launch failed: ${launchFailure.message}`),
        exitCode: 127
      };
    } else if (t0) {
      timedOut = child.timedOut === true;
      settled = {
        stdout: Buffer.isBuffer(child.stdout) ? child.stdout : Buffer.from(String(child.stdout ?? "")),
        stderr: Buffer.isBuffer(child.stderr) ? child.stderr : Buffer.from(String(child.stderr ?? "")),
        exitCode: child.exitCode
      };
    } else if (transparent) {
      timedOut = child.timedOut === true;
      settled = {
        stdout: Buffer.isBuffer(child.stdout) ? child.stdout : Buffer.from(String(child.stdout ?? "")),
        stderr: Buffer.isBuffer(child.stderr) ? child.stderr : Buffer.from(String(child.stderr ?? "")),
        exitCode: child.exitCode
      };
    } else {
      try {
        settled = await Promise.race([this.collectChild(child), timeoutPromise]);
      } catch (error) {
        settled = { stdout: Buffer.alloc(0), stderr: Buffer.from(`dsh-stage: ${error.message}`), exitCode: 127 };
      }
    }
    if (timedOut) this.terminate(124);
    const stdoutRaw = settled.stdout.toString("utf8");
    const stderrRaw = settled.stderr.toString("utf8");
    const cappedStdout = applyOutputCap(stdoutRaw, { maxBytes: this.limits.maxOutputBytes, maxLines: this.limits.maxOutputLines });
    const cappedStderr = applyOutputCap(stderrRaw, { maxBytes: this.limits.maxOutputBytes, maxLines: this.limits.maxOutputLines });
    const stdout = cappedStdout.text;
    const stderr = cappedStderr.text;
    const outputTruncated = cappedStdout.truncated || cappedStderr.truncated;
    const capSummary = (capped) => ({
      truncated: capped.truncated,
      droppedBytes: capped.droppedBytes,
      droppedLines: capped.droppedLines,
      keptBytes: capped.keptBytes,
      keptLines: capped.keptLines,
      byteTruncated: capped.byteTruncated,
      lineTruncated: capped.lineTruncated,
      marker: capped.marker
    });
    const startupFailureReport = classifyStartupFailure({
      exitCode: settled.exitCode,
      stdout,
      stderr,
      launchFailure,
      sideEffectsObserved: options.sideEffectsObserved === true
    });
    return {
      argv: [options.command, ...options.args || []],
      command: options.command,
      // 展示解析结果：便于区分"命令名找不到"与"命令自身失败"（手册第 4 章）
      resolvedCommand,
      args: options.args || [],
      cwd,
      logicalCwd: options.logicalCwd,
      exitCode: settled.exitCode,
      stdout,
      stderr,
      timedOut,
      launchFailed: launchFailure !== void 0,
      launchFailureCode: launchFailure?.win32Code,
      // ── BUG-9：启动失败归一分类（真实 NTSTATUS 原样带出）─────────────────────
      // 只要有启动失败特征就带上；`denialClaimContradicted` 明确回答
      // "报 Access is denied 但子进程其实已经运行"这类与事实相反的结论。
      startupFailure: startupFailureReport,
      durationMs: Date.now() - startedAt,
      envKeys: Object.keys(env).sort(),
      envRejected: rejected,
      classification: classifyOutcome({ exitCode: settled.exitCode, stdout, stderr, launchFailure, startupFailure: startupFailureReport }),
      enforcement: transparent ? "shim-user-mode" : "partial",
      backend: transparent ? "winstage-shim-iat" : t0 ? "windows-appcontainer" : "windows-acl-restricted-token",
      launchMode: this.launchMode,
      tier: this.tier,
      hasOutput: stdout.length > 0 || stderr.length > 0,
      // #4.2：退出码 0 且无输出 = 执行完成无输出，不是"没执行"
      completedWithoutOutput: settled.exitCode === 0 && stdout.length === 0 && stderr.length === 0,
      // ── BUG-3 / BUG-4：可查询的诊断面（逐条命令的闸门判定 + 失根状态）──────────
      stagingWriteGate: this.stagingWriteGate.lastDecision,
      stagingRoot: this.stagingRootDiagnostics(),
      // ── 三轮接线的报告面（同一份摘要口径，见 dimensionSummaries）──────────────
      outputTruncated,
      outputDroppedBytes: cappedStdout.droppedBytes + cappedStderr.droppedBytes,
      outputCap: { stdout: capSummary(cappedStdout), stderr: capSummary(cappedStderr) },
      ...this.dimensionSummaries()
    };
  }
  terminate(exitCode = 1) {
    if (this.launchMode === "shim") {
      const failures = this.shimLauncher ? this.shimLauncher.terminateAll(exitCode) : [];
      return { terminated: true, failures };
    }
    if (!this.job || !this.launcher) return { terminated: false };
    const result = this.launcher.terminateJob(this.job, exitCode);
    return { terminated: result !== 0 };
  }
  dispose() {
    const failures = [];
    failures.push(...this.teardownNetworkPolicy());
    if (this.launchMode === "shim") {
      if (this.shimLauncher) failures.push(...this.shimLauncher.dispose());
      if (this.tempDir && this.options.keepTemp !== true) {
        try {
          if (existsSync3(this.tempDir)) rmSync3(this.tempDir, { recursive: true, force: true });
        } catch (error) {
          failures.push(`temp cleanup (${this.tempDir}): ${error.message}`);
        }
      }
      this.shimLauncher = void 0;
      this.launchMode = void 0;
      return { disposed: true, failures };
    }
    if (this.appContainer) {
      try {
        failures.push(...this.appContainer.dispose());
      } catch (error) {
        failures.push(`appcontainer dispose: ${error.message}`);
      }
      this.appContainer = void 0;
    }
    if (this.launcher) failures.push(...this.launcher.dispose());
    if (this.sandbox) {
      try {
        this.sandbox.dispose();
      } catch (error) {
        failures.push(error instanceof AggregateError ? error.errors.map((e) => e.message).join("; ") : error.message);
      }
    }
    if (this.tempDir && this.options.keepTemp !== true) {
      try {
        if (existsSync3(this.tempDir)) rmSync3(this.tempDir, { recursive: true, force: true });
      } catch (error) {
        failures.push(`temp cleanup (${this.tempDir}): ${error.message}`);
      }
    }
    this.sandbox = void 0;
    this.launcher = void 0;
    this.job = void 0;
    return { disposed: true, failures };
  }
};
var cachedShell;
function resolvePowerShell(env = process.env, cwd = process.cwd()) {
  if (cachedShell) return cachedShell;
  const candidates = ["pwsh", "powershell"];
  const failures = [];
  for (const candidate of candidates) {
    try {
      const resolved = resolveExecutable(candidate, { cwd, env });
      cachedShell = { command: resolved, name: candidate };
      return cachedShell;
    } catch (error2) {
      failures.push(`${candidate}: ${error2.message}`);
    }
  }
  const error = fail("ENOENT", `no PowerShell interpreter found (tried ${candidates.join(", ")})`);
  error.failures = failures;
  throw error;
}
function resolveExecutable(command, options = {}) {
  if (typeof command !== "string" || command.length === 0) {
    throw fail("ENOENT", "command must be a non-empty string");
  }
  const cwd = options.cwd;
  const env = options.env ?? process.env;
  if (isAbsolute3(command)) {
    if (existsSync3(command)) return command;
    const error2 = fail("ENOENT", `executable not found: ${command}`);
    error2.searched = [command];
    throw error2;
  }
  const pathExt = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const extensions = [...pathExt, ""];
  const hasSeparator = /[\\/]/.test(command);
  const pathDirs = (env.PATH || "").split(";").map((dir) => dir.trim()).filter(Boolean);
  const searchDirs = hasSeparator ? [cwd, ...pathDirs] : [...cwd ? [cwd] : [], ...pathDirs];
  const tried = [];
  for (const dir of searchDirs) {
    if (!dir) continue;
    const base = join6(dir, command);
    for (const ext of extensions) {
      const candidate = ext === "" ? base : base + ext;
      tried.push(candidate);
      if (existsSync3(candidate)) return candidate;
    }
  }
  const error = fail("ENOENT", `cannot resolve executable "${command}"`);
  error.searched = tried.slice(0, 40);
  error.pathExt = pathExt;
  throw error;
}
var STAGING_WRITE_CHECK_NAMES = Object.freeze([
  "inside-staging-write-allowed",
  "outside-write-staged-not-real",
  "transparent-capability-canary",
  "no-dsh-sandbox-trace"
]);
function isStagingWriteCheckName(name) {
  return STAGING_WRITE_CHECK_NAMES.includes(name);
}
var SANDBOX_STAGING_WRITE_CHECKS = Object.freeze(["inside-staging-write-allowed"]);
var SHIM_STAGING_WRITE_CHECKS = Object.freeze([
  "transparent-capability-canary",
  "outside-write-staged-not-real",
  "no-dsh-sandbox-trace"
]);
var COMMAND_RISK = Object.freeze({
  READ_ONLY: "read-only",
  WRITE: "write-capable",
  INDETERMINATE: "indeterminate"
});
var WRITE_VERB_PREFIXES = Object.freeze([
  "set",
  "new",
  "remove",
  "add",
  "copy",
  "move",
  "rename",
  "clear",
  "out",
  "export",
  "invoke",
  "start",
  "stop",
  "install",
  "uninstall",
  "register",
  "unregister",
  "update",
  "enable",
  "disable",
  "restore",
  "backup",
  "save",
  "publish",
  "send",
  "receive",
  "mount",
  "dismount",
  "lock",
  "unlock",
  "grant",
  "revoke",
  "block",
  "unblock",
  "reset",
  "restart",
  "resume",
  "suspend",
  "submit",
  "undo",
  "switch",
  "open",
  "close",
  "format",
  "optimize",
  "repair",
  "kill",
  "redo",
  "rollback",
  "commit"
]);
var READ_ONLY_VERB_PREFIXES = Object.freeze([
  "get",
  "read",
  "test",
  "select",
  "where",
  "foreach",
  "sort",
  "measure",
  "format",
  "convertto",
  "convertfrom",
  "join",
  "split",
  "resolve",
  "compare",
  "group",
  "show",
  "find",
  "search",
  "trace",
  "debug",
  "watch",
  "wait",
  "write"
]);
var PS_VERB_NOUN_RE = /^([a-z]+)-([a-z][a-z0-9]*)$/;
var KNOWN_PS_VERB_PREFIXES = /* @__PURE__ */ new Set([...WRITE_VERB_PREFIXES, ...READ_ONLY_VERB_PREFIXES]);
var READ_ONLY_BARE_VERBS = Object.freeze([
  "echo",
  "write",
  "dir",
  "ls",
  "cat",
  "type",
  "pwd",
  "whoami",
  "hostname",
  "ver",
  "tasklist",
  "findstr",
  "find",
  "more",
  "tree",
  "fc",
  "comp",
  "cd",
  "chdir",
  "pushd",
  "popd",
  "cls",
  "clear",
  "sleep",
  "sls",
  "select",
  "where",
  "foreach",
  "sort",
  "measure",
  "compare",
  "diff",
  "gci",
  "gi",
  "gc",
  "gl",
  "gps",
  "ps",
  "gcm",
  "gm",
  "gv",
  "gdr",
  "gsv",
  "gp",
  "gal",
  "gh",
  "ft",
  "fl",
  "fw",
  "oh",
  "gcb",
  "gjb",
  "gwmi",
  "gcim",
  "curl",
  "wget",
  "ipconfig",
  "systeminfo",
  "where.exe"
]);
var READ_ONLY_EXES = Object.freeze([
  "whoami",
  "whoami.exe",
  "hostname",
  "hostname.exe",
  "ver",
  "ver.exe",
  "tasklist",
  "tasklist.exe",
  "findstr",
  "findstr.exe",
  "find",
  "find.exe",
  "ipconfig",
  "ipconfig.exe",
  "systeminfo",
  "systeminfo.exe",
  "where",
  "where.exe"
]);
var READ_ONLY_VERBS = Object.freeze([
  // ── 读/查询 ───────────────────────────────────────────────────────────────
  "get-childitem",
  "get-item",
  "get-content",
  "get-location",
  "get-date",
  "get-process",
  "get-command",
  "get-member",
  "get-variable",
  "get-host",
  "get-psdrive",
  "get-help",
  "get-module",
  "get-service",
  "get-itemproperty",
  "get-acl",
  "get-filehash",
  "get-ciminstance",
  "get-wmiobject",
  "get-eventlog",
  "get-winevent",
  "get-counter",
  "get-alias",
  "get-history",
  "get-job",
  "get-runspace",
  "get-type",
  "get-random",
  "get-unique",
  "get-culture",
  "get-uiculture",
  "get-timezone",
  "get-computerinfo",
  "get-volume",
  "get-disk",
  "get-partition",
  "get-netadapter",
  "get-netipaddress",
  "get-netipconfiguration",
  "get-netfirewallprofile",
  "get-netfirewallrule",
  "get-nettcpconnection",
  "get-smbshare",
  "get-localuser",
  "get-localgroup",
  "get-hotfix",
  "get-package",
  "get-childitem",
  "get-filehash",
  "get-psprovider",
  "get-verb",
  "get-process",
  "test-path",
  "test-connection",
  "test-netconnection",
  "test-modulemanifest",
  "test-json",
  "resolve-path",
  "join-path",
  "split-path",
  "read-host",
  // ── 投影/格式化（无副作用） ────────────────────────────────────────────────
  "select-object",
  "where-object",
  "foreach-object",
  "sort-object",
  "measure-object",
  "format-table",
  "format-list",
  "format-wide",
  "format-custom",
  "out-string",
  "out-host",
  "out-null",
  "out-gridview",
  "convertto-json",
  "convertfrom-json",
  "convertto-csv",
  "convertto-xml",
  "convertto-html",
  "write-output",
  "write-host",
  "write-verbose",
  "write-debug",
  "write-information",
  "write-warning",
  "write-progress",
  "compare-object",
  "group-object",
  "start-sleep",
  "wait-event",
  "wait-process",
  "select-string",
  // ── 只读别名 ──────────────────────────────────────────────────────────────
  "gci",
  "gi",
  "gc",
  "gl",
  "gps",
  "gcm",
  "gm",
  "gv",
  "gdr",
  "gsv",
  "gp",
  "gal",
  "gh",
  "gcb",
  "gjb",
  "gwmi",
  "gcim",
  "ft",
  "fl",
  "fw",
  "oh",
  "select",
  "where",
  "foreach",
  "sort",
  "measure",
  "compare",
  "diff",
  "sls",
  "sleep",
  "echo",
  "write",
  ...READ_ONLY_BARE_VERBS,
  ...READ_ONLY_EXES
]);
var WRITE_VERBS = Object.freeze([
  // ── 文件/内容 ─────────────────────────────────────────────────────────────
  "set-content",
  "add-content",
  "clear-content",
  "new-item",
  "remove-item",
  "move-item",
  "copy-item",
  "rename-item",
  "out-file",
  "tee-object",
  "export-csv",
  "export-clixml",
  "expand-archive",
  "compress-archive",
  "set-item",
  "set-itemproperty",
  "new-itemproperty",
  "remove-itemproperty",
  "clear-item",
  "set-acl",
  "new-psdrive",
  "remove-psdrive",
  "new-variable",
  "set-variable",
  "remove-variable",
  "clear-variable",
  "new-alias",
  "set-alias",
  "remove-alias",
  "import-module",
  "install-module",
  "save-module",
  "install-package",
  "install-script",
  "save-script",
  "update-module",
  "register-scheduledtask",
  "unregister-scheduledtask",
  "new-scheduledtask",
  "set-scheduledtask",
  "start-scheduledtask",
  "new-service",
  "set-service",
  "write-eventlog",
  "clear-eventlog",
  "remove-service",
  "start-service",
  "stop-service",
  "restart-service",
  "suspend-service",
  "resume-service",
  "new-webserviceproxy",
  "invoke-webrequest",
  "invoke-restmethod",
  "invoke-expression",
  "start-process",
  "start-job",
  "stop-process",
  "stop-job",
  "remove-job",
  "debug-process",
  "new-localuser",
  "remove-localuser",
  "set-localuser",
  "add-localgroupmember",
  "new-netfirewallrule",
  "remove-netfirewallrule",
  "set-netfirewallprofile",
  "new-smbshare",
  "remove-smbshare",
  "mount-diskimage",
  "dismount-diskimage",
  "format-volume",
  "set-volume",
  "new-partition",
  "clear-disk",
  "initialize-disk",
  "set-executionpolicy",
  "restore-computer",
  "checkpoint-computer",
  "enable-computerrestore",
  "disable-computerrestore",
  "new-selfsignedcertificate",
  "export-pfxcertificate",
  "import-pfxcertificate",
  // ── 写类别名 / 内建 ───────────────────────────────────────────────────────
  "sc",
  "ac",
  "clc",
  "ni",
  "ri",
  "rm",
  "del",
  "erase",
  "rmdir",
  "rd",
  "mi",
  "move",
  "mv",
  "cpi",
  "cp",
  "copy",
  "rni",
  "ren",
  "rename",
  "si",
  "sp",
  "spps",
  "kill",
  "taskkill",
  "mkdir",
  "md",
  "touch",
  "tee",
  "out",
  "sv",
  "rv",
  "nv",
  "sal",
  "ipal",
  "iex",
  "iwr",
  "irm",
  "saps",
  "sa",
  "start",
  "npx",
  "npm",
  "pnpm",
  "yarn",
  "pip",
  "pip3",
  "choco",
  "winget",
  "install",
  "reg",
  "reg.exe",
  "sc.exe",
  "net",
  "net.exe",
  "schtasks",
  "schtasks.exe",
  "takeown",
  "icacls",
  "cacls",
  "attrib",
  "robocopy",
  "xcopy",
  "format",
  "diskpart",
  "shutdown",
  "bcdedit",
  "wusa",
  "msiexec",
  "dd",
  "truncate",
  "chmod",
  "chown",
  "ln"
]);
var INTERPRETER_COMMANDS = Object.freeze([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "wsl",
  "wsl.exe",
  "bash",
  "bash.exe",
  "sh",
  "sh.exe"
]);
var GIT_READ_ONLY_SUBCOMMANDS = Object.freeze([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "describe",
  "blame",
  "shortlog",
  "cat-file",
  "symbolic-ref",
  "whatchanged",
  "grep"
]);
var WRITE_OPERATORS = Object.freeze([
  // `>`（含 `>>`）落盘；但 `2>&1` / `1>&2` 这类**只重定向控制台**的写法不算写文件。
  { label: "file redirection", pattern: /(?:^|[^>])>(?!&)/ },
  { label: "pipe-to-file-cmdlet", pattern: /\|\s*(out-file|set-content|add-content|export-csv|export-clixml|tee-object|tee)\b/i },
  { label: "out-file", pattern: /\bout-file\b/i },
  { label: "tee", pattern: /\btee(-object)?\b/i },
  { label: "curl-download-flag", pattern: /(^|\s)-[oO]\b/ },
  { label: "git-mutating-subcommand", pattern: /\bgit(\.exe)?\s+(commit|push|pull|checkout|switch|reset|clean|apply|add|rm|mv|stash|merge|rebase|tag|init|clone|fetch)\b/i }
]);
var OPAQUE_PAYLOAD_OPERATORS = Object.freeze([
  { label: "pwsh -EncodedCommand\uFF08\u8F7D\u8377\u662F base64\uFF0C\u8BFB\u4E0D\u61C2\uFF09", pattern: /-(enc|encodedcommand)\b/i },
  { label: "pwsh -File\uFF08\u8F7D\u8377\u5728\u6587\u4EF6\u91CC\uFF0C\u672C\u6B21\u5224\u5B9A\u770B\u4E0D\u5230\uFF09", pattern: /(^|\s)-file\s+\S+/i }
]);
function tokenizeCommandLine(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(text ?? ""))) !== null) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}
function baseNameLower(token) {
  const text = String(token ?? "").toLowerCase();
  const cut = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"));
  return cut >= 0 ? text.slice(cut + 1) : text;
}
function classifyCommandRisk(command, args = [], options = {}) {
  const argv = [command, ...Array.isArray(args) ? args : []].filter((v) => v !== void 0 && v !== null);
  const joined = argv.map((v) => String(v)).join(" ");
  const tokens = tokenizeCommandLine(joined);
  const lowerTokens = tokens.map((t) => t.toLowerCase());
  const reasons = [];
  for (const operator of WRITE_OPERATORS) {
    const hit = operator.pattern.exec(joined);
    if (hit) {
      reasons.push(`\u5199\u5165\u578B\u64CD\u4F5C\u7B26\u300C${operator.label}\u300D\u547D\u4E2D\uFF1A${JSON.stringify(hit[0]).slice(0, 40)}`);
    }
  }
  const writeHits = lowerTokens.filter((t) => WRITE_VERBS.includes(t));
  if (writeHits.length > 0) reasons.push(`\u5199\u7C7B\u52A8\u8BCD\u547D\u4E2D\uFF1A${[...new Set(writeHits)].join(", ")}`);
  const unknownVerbNoun = [];
  let readOnlyHitCount = 0;
  for (const lower of lowerTokens) {
    const verbNoun = PS_VERB_NOUN_RE.exec(lower);
    if (verbNoun && KNOWN_PS_VERB_PREFIXES.has(verbNoun[1])) {
      if (READ_ONLY_VERBS.includes(lower)) {
        readOnlyHitCount += 1;
        continue;
      }
      if (WRITE_VERB_PREFIXES.includes(verbNoun[1])) {
        reasons.push(`\u5199\u7C7B Verb-Noun\uFF08\u672A\u5728\u53EA\u8BFB\u8868\u5185\uFF09\uFF1A${lower}`);
        continue;
      }
      unknownVerbNoun.push(lower);
      continue;
    }
    if (READ_ONLY_BARE_VERBS.includes(lower)) readOnlyHitCount += 1;
  }
  if (reasons.length > 0) {
    return {
      risk: COMMAND_RISK.WRITE,
      reasons,
      evidence: { command: String(command ?? ""), args: Array.isArray(args) ? args.length : 0, tokens: lowerTokens }
    };
  }
  if (unknownVerbNoun.length > 0) {
    return {
      risk: COMMAND_RISK.INDETERMINATE,
      reasons: [
        `\u65E0\u6CD5\u5224\u5B9A\u526F\u4F5C\u7528\uFF08cannot determine side effects\uFF09\uFF1A\u51FA\u73B0\u672A\u77E5 Verb-Noun ${[...new Set(unknownVerbNoun)].join(", ")}\uFF1B\u5B83\u65E2\u4E0D\u5728\u53EA\u8BFB\u8868\u91CC\uFF0C\u4E5F\u4E0D\u5728\u5199\u8868\u91CC \u2014\u2014 \u5224\u4E0D\u51FA\u6765\u65F6\u62D2\u7EDD\uFF0C\u4E14\u5982\u5B9E\u8BF4\u660E\u5224\u4E0D\u51FA\u6765\u7684\u539F\u56E0`
      ],
      evidence: { command: String(command ?? ""), tokens: lowerTokens }
    };
  }
  const opaque = OPAQUE_PAYLOAD_OPERATORS.filter((entry) => entry.pattern.test(joined));
  if (opaque.length > 0) {
    return {
      risk: COMMAND_RISK.INDETERMINATE,
      reasons: opaque.map((entry) => `\u65E0\u6CD5\u5224\u5B9A\u526F\u4F5C\u7528\uFF1A${entry.label}`),
      evidence: { command: String(command ?? ""), opaque: opaque.map((e) => e.label) }
    };
  }
  const head = baseNameLower(tokens[0] ?? command ?? "");
  const headIsInterpreter = INTERPRETER_COMMANDS.includes(head);
  const headIsGit = head === "git" || head === "git.exe";
  const headKnown = headIsInterpreter || headIsGit || READ_ONLY_VERBS.includes(head) || READ_ONLY_EXES.includes(head) || WRITE_VERBS.includes(head);
  if (!headKnown) {
    return {
      risk: COMMAND_RISK.INDETERMINATE,
      reasons: [
        `\u65E0\u6CD5\u5224\u5B9A\u526F\u4F5C\u7528\uFF1A\u53EF\u6267\u884C\u6587\u4EF6\u300C${tokens[0] ?? command}\u300D\u4E0D\u5728\u5DF2\u77E5\u7684\u53EA\u8BFB/\u5199\u7C7B\u6E05\u5355\u91CC\uFF0C\u56E0\u6B64\u65E0\u6CD5\u8BC1\u660E\u5B83\u4E0D\u4F1A\u5199 \u2014\u2014 \u5224\u4E0D\u51FA\u6765\u65F6\u62D2\u7EDD\uFF0C\u4E14\u5982\u5B9E\u8BF4\u660E\u5224\u4E0D\u51FA\u6765\u7684\u539F\u56E0`
      ],
      evidence: { command: String(command ?? ""), head, tokens: lowerTokens }
    };
  }
  if (headIsGit) {
    const sub = lowerTokens.slice(1).find((t) => !t.startsWith("-"));
    if (sub !== void 0 && GIT_READ_ONLY_SUBCOMMANDS.includes(sub)) {
      return { risk: COMMAND_RISK.READ_ONLY, reasons: [`git \u53EA\u8BFB\u5B50\u547D\u4EE4\uFF1A${sub}`], evidence: { head, sub } };
    }
    return {
      risk: COMMAND_RISK.INDETERMINATE,
      reasons: [
        `\u65E0\u6CD5\u5224\u5B9A\u526F\u4F5C\u7528\uFF1Agit \u5B50\u547D\u4EE4\u300C${sub ?? "(none)"}\u300D\u4E0D\u5728\u53EA\u8BFB\u5B50\u547D\u4EE4\u6E05\u5355\u91CC\uFF08${GIT_READ_ONLY_SUBCOMMANDS.join("/")}\uFF09`
      ],
      evidence: { head, sub }
    };
  }
  if (readOnlyHitCount === 0) {
    return {
      risk: COMMAND_RISK.INDETERMINATE,
      reasons: [
        `\u65E0\u6CD5\u5224\u5B9A\u526F\u4F5C\u7528\uFF1A\u300C${command}\u300D\u8FD9\u6B21\u8C03\u7528\u91CC\u6CA1\u6709\u4EFB\u4F55\u5DF2\u767B\u8BB0\u7684\u53EA\u8BFB\u52A8\u8BCD\uFF08\u53EF\u80FD\u662F -File \u811A\u672C\u3001\u4EA4\u4E92\u5F0F\u89E3\u91CA\u5668\u3001\u6216\u7EAF\u53C2\u6570\uFF09\uFF0C\u56E0\u6B64\u65E0\u6CD5\u8BC1\u660E\u5B83\u4E0D\u4F1A\u5199`
      ],
      evidence: { command: String(command ?? ""), tokens: lowerTokens, assumeInterpreterPayload: options.assumeInterpreterPayload === true }
    };
  }
  return {
    risk: COMMAND_RISK.READ_ONLY,
    reasons: [`\u5168\u90E8\u52A8\u8BCD\u90FD\u5728\u53EA\u8BFB\u8868\u5185\uFF08${readOnlyHitCount} \u4E2A\uFF09\uFF0C\u4E14\u6CA1\u6709\u4EFB\u4F55\u5199\u5165\u578B\u64CD\u4F5C\u7B26${headIsInterpreter ? `\uFF1B\u89E3\u91CA\u5668\u8F7D\u8377\u5DF2\u6309\u52A8\u8BCD\u9010\u6761\u6838\u5BF9` : ""}`],
    evidence: { command: String(command ?? ""), head, readOnlyHitCount, tokens: lowerTokens }
  };
}
function readStageRootEnv(env = process.env) {
  const names = ["WINSTAGE_STAGE_ROOT", "DSH_STAGE_ROOT"];
  for (const name of names) {
    if (env && Object.prototype.hasOwnProperty.call(env, name)) {
      const value = env[name];
      return { name, present: true, value: value === void 0 || value === null ? "" : String(value) };
    }
  }
  return { name: names[0], present: false, value: void 0 };
}
var STAGING_ROOT_CODES = Object.freeze({
  OK: "STAGING_ROOT_OK",
  LOST: "STAGING_ROOT_LOST",
  VANISHED: "STAGING_ROOT_VANISHED",
  ENV_BLANKED: "STAGING_ROOT_ENV_BLANKED",
  ABSENT: "STAGING_ROOT_ABSENT",
  NOT_A_DIRECTORY: "STAGING_ROOT_NOT_A_DIRECTORY"
});
function classifyStagingRootState(state = {}) {
  const evidence = {
    where: state.where,
    configured: state.configured,
    configuredWasSet: state.configuredWasSet === true,
    envStageRoot: state.envStageRoot,
    envWasSet: state.envWasSet === true,
    previouslyExisted: state.previouslyExisted === true,
    exists: state.exists === true,
    isDirectory: state.isDirectory === true
  };
  const lost = (code, summary, action) => ({
    status: "lost",
    code,
    category: "root-loss",
    // 关键：这一位给下游机检用 —— "失根"**不是**策略拒绝
    policyDenial: false,
    distinctFromPolicyDenial: true,
    retryable: true,
    summary,
    action,
    evidence
  });
  if (evidence.envWasSet && (evidence.envStageRoot === void 0 || String(evidence.envStageRoot).trim() === "")) {
    return lost(
      STAGING_ROOT_CODES.ENV_BLANKED,
      "\u672C\u6B21\u4F1A\u8BDD\u4E2D WINSTAGE_STAGE_ROOT \u53D8\u6210\u4E86\u7A7A\u503C \u2014\u2014 \u8FD9\u662F**\u5931\u6839**\uFF08\u6682\u5B58\u6839\u5931\u8054\uFF09\uFF0C\u4E0D\u662F\u7B56\u7565\u62D2\u7EDD\uFF1B\u6B64\u540E\u6240\u6709\u5199\u5165\u90FD\u4F1A\u5931\u8D25\uFF0C\u4E14\u6B64\u524D\u5DF2\u6682\u5B58\u7684\u5DE5\u4F5C\u53EF\u80FD\u5DF2\u968F\u65E7\u4F1A\u8BDD\u6D88\u5931\u3002",
      '\u91CD\u65B0\u6267\u884C `dsh-stage init --workspace <dir>` \u91CD\u5EFA\u6682\u5B58\u6839\uFF0C\u518D\u91CD\u8DD1\u521A\u624D\u90A3\u6761\u547D\u4EE4\uFF1B\u4E0D\u8981\u628A\u5B83\u5F53\u6210"\u6743\u9650\u4E0D\u8DB3"\u91CD\u8BD5\u3002'
    );
  }
  if (evidence.configuredWasSet && (evidence.configured === void 0 || evidence.configured === null || String(evidence.configured).trim() === "")) {
    return lost(
      STAGING_ROOT_CODES.LOST,
      '\u6682\u5B58\u6839\u4ECE"\u6709\u503C"\u53D8\u6210\u4E86"\u7A7A" \u2014\u2014 \u8FD9\u662F**\u5931\u6839**\uFF08\u6682\u5B58\u6839\u5931\u8054\uFF09\uFF0C\u4E0D\u662F\u7B56\u7565\u62D2\u7EDD\uFF08NOT a policy denial\uFF09\u3002',
      "\u505C\u6B62\u5728\u5F53\u524D\u4F1A\u8BDD\u91CC\u7EE7\u7EED\u5199\u5165\uFF1B\u7528 `dsh-stage init --workspace <dir>` \u91CD\u5EFA\u6682\u5B58\u6839\uFF0C\u5E76\u6838\u5BF9\u5DF2\u6682\u5B58\u7684\u5DE5\u4F5C\u662F\u5426\u8FD8\u5728\u3002"
    );
  }
  if (evidence.configuredWasSet && evidence.exists !== true) {
    return lost(
      STAGING_ROOT_CODES.VANISHED,
      `\u6682\u5B58\u6839 ${evidence.configured} \u5728\u672C\u6B21\u4F1A\u8BDD\u4E2D**\u5DF2\u7ECF\u5931\u8054**\uFF08\u6B64\u524D\u5B58\u5728\uFF0C\u73B0\u5728\u4E0D\u5B58\u5728\uFF09\u2014\u2014 \u8FD9\u662F**\u5931\u6839**\uFF0C\u4E0D\u662F\u7B56\u7565\u62D2\u7EDD\u3002`,
      "\u7528 `dsh-stage init --workspace <dir>` \u91CD\u5EFA\u6682\u5B58\u6839\uFF1B`Get-ChildItem <dir>` \u786E\u8BA4\u76EE\u5F55\u8FD8\u5728\uFF0C\u518D\u91CD\u8DD1\u547D\u4EE4\u3002"
    );
  }
  if (evidence.exists === true && evidence.isDirectory !== true) {
    return lost(
      STAGING_ROOT_CODES.NOT_A_DIRECTORY,
      `\u6682\u5B58\u6839 ${evidence.configured} \u5B58\u5728\u4F46\u4E0D\u662F\u76EE\u5F55 \u2014\u2014 \u6682\u5B58\u5C42\u65E0\u6CD5\u5DE5\u4F5C\uFF0C\u8FD9\u662F**\u6C99\u7BB1\u81EA\u8EAB\u6545\u969C**\uFF0C\u4E0D\u662F\u7B56\u7565\u62D2\u7EDD\u3002`,
      "\u68C0\u67E5\u8BE5\u8DEF\u5F84\u662F\u5426\u88AB\u540C\u540D\u6587\u4EF6\u5360\u7528\uFF0C\u6539\u4E3A\u4E00\u4E2A\u771F\u5B9E\u76EE\u5F55\u540E\u91CD\u65B0 `dsh-stage init`\u3002"
    );
  }
  if (evidence.exists !== true) {
    return lost(
      STAGING_ROOT_CODES.ABSENT,
      `\u6682\u5B58\u6839 ${evidence.configured ?? "(\u672A\u8BBE\u7F6E)"} \u4E0D\u5B58\u5728\uFF0C\u4E14\u672C\u6B21\u4F1A\u8BDD\u6CA1\u6709\u5B83\u66FE\u5B58\u5728\u7684\u8BB0\u5F55 \u2014\u2014 \u8FD9\u662F**\u914D\u7F6E/\u521D\u59CB\u5316\u7F3A\u5931**\uFF0C\u4E0D\u662F\u7B56\u7565\u62D2\u7EDD\u3002`,
      "\u5148 `dsh-stage init --workspace <dir>` \u521B\u5EFA\u6682\u5B58\u6839\uFF0C\u518D\u91CD\u8DD1\u547D\u4EE4\u3002"
    );
  }
  return {
    status: "ok",
    code: STAGING_ROOT_CODES.OK,
    category: "ok",
    policyDenial: false,
    distinctFromPolicyDenial: false,
    retryable: false,
    summary: `\u6682\u5B58\u6839\u5C31\u7EEA\uFF1A${evidence.configured}`,
    action: "none",
    evidence
  };
}
var STARTUP_FAILURE_CATEGORIES = Object.freeze({
  DLL_INIT_FAILED: "dll-init-failed",
  INTERNAL_ERROR: "internal-error",
  SPAWN_UNKNOWN: "spawn-unknown",
  CLR_EXCEPTION: "clr-exception",
  ACCESS_VIOLATION: "access-violation",
  DLL_NOT_FOUND: "dll-not-found",
  STACK_BUFFER_OVERRUN: "stack-buffer-overrun",
  ACCESS_DENIED: "access-denied",
  FILE_NOT_FOUND: "file-not-found",
  NO_CREDENTIALS: "no-credentials",
  ALREADY_EXISTS: "already-exists",
  NONE: "none"
});
var FAILURE_SEMANTICS = Object.freeze({
  /** ① 本就不允许的操作（越界写 / 提权 / 敏感路径写 / 明文外泄密钥形态） */
  POLICY: "policy",
  /** ② 环境故障：可重试；**不得**与策略拒绝共用文案 */
  ENVIRONMENT: "environment",
  /** ③ 普通失败：命令自己失败，或"到底跑没跑"无法判定 */
  COMMAND: "command"
});
var FAILURE_CODE_POLICY = "DENIED_ACTION_NOT_PERMITTED";
var FAILURE_CODE_ENVIRONMENT = "ENV_FAULT_RETRYABLE";
var FAILURE_CODE_COMMAND = "COMMAND_FAILED";
var FAILURE_CODE_FAMILY = Object.freeze({
  [FAILURE_SEMANTICS.POLICY]: [FAILURE_CODE_POLICY],
  [FAILURE_SEMANTICS.ENVIRONMENT]: [FAILURE_CODE_ENVIRONMENT],
  [FAILURE_SEMANTICS.COMMAND]: [FAILURE_CODE_COMMAND]
});
var FAILURE_CATEGORY_CODES = Object.freeze({
  [FAILURE_SEMANTICS.POLICY]: FAILURE_CODE_POLICY,
  [FAILURE_SEMANTICS.ENVIRONMENT]: FAILURE_CODE_ENVIRONMENT,
  [FAILURE_SEMANTICS.COMMAND]: FAILURE_CODE_COMMAND,
  POLICY: FAILURE_CODE_POLICY,
  ENVIRONMENT: FAILURE_CODE_ENVIRONMENT,
  COMMAND: FAILURE_CODE_COMMAND
});
var FAILURE_CATEGORY_TEXT = Object.freeze({
  [FAILURE_SEMANTICS.POLICY]: {
    classification: "not-permitted",
    message: "\u8BF7\u6C42\u7684\u64CD\u4F5C\u4E0D\u88AB\u5141\u8BB8\uFF08\u6743\u9650/\u7B56\u7565\u5224\u5B9A\uFF09\uFF0C\u672C\u6B21\u672A\u6267\u884C\u3002",
    retryable: false
  },
  [FAILURE_SEMANTICS.ENVIRONMENT]: {
    classification: "environment-fault",
    message: "\u6267\u884C\u73AF\u5883\u6545\u969C\uFF0C\u547D\u4EE4\u6CA1\u6709\u8FD0\u884C\uFF1B\u8FD9\u662F\u53EF\u91CD\u8BD5\u7684\u73AF\u5883\u95EE\u9898\u3002",
    retryable: true
  },
  [FAILURE_SEMANTICS.COMMAND]: {
    classification: "command-failure",
    message: "\u547D\u4EE4\u5931\u8D25\u3002",
    retryable: false
  }
});
var TRANSPARENCY_FORBIDDEN_TOKENS = Object.freeze([
  "\u6C99\u7BB1",
  "\u6682\u5B58",
  "\u66FF\u4EE3\u8DEF\u5F84",
  "sandbox",
  "staging",
  // ⚠ `stage` 单独列出（不要以为 `staging` 能顺带覆盖它）：按**子串**匹配，
  //   因此 `staged` / `stage-root` / `overlay-stage` 一并命中。
  //   代价必须如实声明：英文 `execute` / `message` 里也含 `stage` 子串 ⇒
  //   模型可见文案里**不要**用这些英文词（中文文案不受影响）。
  "stage",
  "overlay"
]);
function transparencyViolations(text) {
  const value = String(text ?? "").toLowerCase();
  return TRANSPARENCY_FORBIDDEN_TOKENS.filter((token) => value.includes(token.toLowerCase()));
}
function isKnownFailureCategory(category) {
  return Object.prototype.hasOwnProperty.call(FAILURE_CATEGORY_CODES, String(category));
}
function classifyFailureSemantics(input = {}) {
  const text = [input.code, input.errorCode, input.message, input.stderr, input.stdout, input.detail].filter((part) => part !== void 0 && part !== null).map((part) => String(part)).join("\n");
  const code = input.code ?? input.errorCode;
  const evidence = [];
  if (isKnownFailureCategory(input.category)) {
    const hint = String(input.category);
    const base2 = FAILURE_CATEGORY_TEXT[hint];
    evidence.push("explicit-category-hint");
    const mapped = startupFailureInsightFromText(text);
    return {
      category: hint,
      code: FAILURE_CATEGORY_CODES[hint],
      classification: base2.classification,
      message: base2.message,
      retryable: base2.retryable === true,
      indeterminate: hint === FAILURE_SEMANTICS.COMMAND && input.denialClaimContradicted === true,
      evidence,
      technicalCode: typeof code === "string" ? code : void 0,
      userDetail: mapped?.message,
      violations: transparencyViolations(base2.message)
    };
  }
  const environmentText = /STAGING_ROOT_LOST|STAGING_ROOT_VANISHED|STAGING_ROOT_ENV_BLANKED|STAGING_ROOT_ABSENT|STAGING_ROOT_NOT_A_DIRECTORY|staging root[^\n]{0,60}(lost|vanished|no longer exists)|SANDBOX_UNAVAILABLE|SANDBOX_NETWORK_POLICY_UNENFORCED|carrier-init-failed|injector exit|spawn UNKNOWN|STATUS_DLL_INIT_FAILED|0xc0000142|0x8007054f|0x800700b7|SEC_E_NO_CREDENTIALS|No credentials are available/i.test(
    text
  );
  const environmentCode = typeof code === "string" && /SANDBOX_UNAVAILABLE|SANDBOX_NETWORK_POLICY_UNENFORCED|STAGING_ROOT_|EXECUTOR_INVALID|INIT_FAILED|MATERIALIZE_FAILED|BASE_MISSING|BASE_LOAD_FAILED/.test(code);
  if (environmentText) evidence.push("environment-fault-signature");
  if (environmentCode) evidence.push("environment-fault-code");
  if (environmentText || environmentCode) {
    const mapped = startupFailureInsightFromText(text);
    const base2 = FAILURE_CATEGORY_TEXT[FAILURE_SEMANTICS.ENVIRONMENT];
    const violation = transparencyViolations(base2.message);
    return {
      category: FAILURE_SEMANTICS.ENVIRONMENT,
      code: FAILURE_CATEGORY_CODES[FAILURE_SEMANTICS.ENVIRONMENT],
      classification: base2.classification,
      message: base2.message,
      retryable: true,
      indeterminate: false,
      evidence,
      technicalCode: typeof code === "string" ? code : void 0,
      /** 用户侧附加说明（可含机制措辞；**不进**模型可见通道） */
      userDetail: mapped?.message,
      violations: violation
    };
  }
  const policyText = /CWD_OUTSIDE_STAGING|outside the staged root|privilege not held|requires elevation|elevation|SeDebugPrivilege|SeTakeOwnershipPrivilege|sensitive|protected path|CLEARTEXT_CREDENTIAL|cleartext/i.test(
    text
  );
  const policyCode = typeof code === "string" && /CWD_OUTSIDE_STAGING|FORBIDDEN|DENIED|POLICY|NOT_PERMITTED|ELEVATION/.test(code);
  if (policyText) evidence.push("policy-signature");
  if (policyCode) evidence.push("policy-code");
  if (policyText || policyCode) {
    const base2 = FAILURE_CATEGORY_TEXT[FAILURE_SEMANTICS.POLICY];
    return {
      category: FAILURE_SEMANTICS.POLICY,
      code: FAILURE_CATEGORY_CODES[FAILURE_SEMANTICS.POLICY],
      classification: base2.classification,
      message: base2.message,
      retryable: false,
      indeterminate: false,
      evidence,
      technicalCode: typeof code === "string" ? code : void 0,
      violations: transparencyViolations(base2.message)
    };
  }
  const base = FAILURE_CATEGORY_TEXT[FAILURE_SEMANTICS.COMMAND];
  const contradicted = input.denialClaimContradicted === true || input.childRan === true;
  if (contradicted) evidence.push("denial-claim-contradicted-by-execution-evidence");
  return {
    category: FAILURE_SEMANTICS.COMMAND,
    code: FAILURE_CATEGORY_CODES[FAILURE_SEMANTICS.COMMAND],
    classification: base.classification,
    message: contradicted ? "\u547D\u4EE4\u7ED3\u679C\u4E0D\u786E\u5B9A\uFF1A\u6267\u884C\u901A\u9053\u62A5\u4E86\u62D2\u7EDD\uFF0C\u4F46\u540C\u65F6\u5B58\u5728\u8FDB\u7A0B\u5DF2\u8FD0\u884C\u7684\u8BC1\u636E\uFF1B\u56E0\u6B64**\u4E0D\u80FD**\u65AD\u8A00\u547D\u4EE4\u672A\u6267\u884C\uFF0C\u4E5F\u65E0\u6CD5\u786E\u8BA4\u5B83\u662F\u5426\u5B8C\u6574\u6267\u884C\u3002\u8BF7\u4EE5\u5B9E\u9645\u4EA7\u51FA\u4E3A\u51C6\u3002" : base.message,
    retryable: false,
    indeterminate: contradicted,
    evidence,
    technicalCode: typeof code === "string" ? code : void 0,
    violations: transparencyViolations(base.message)
  };
}
function detectCleartextSecret(text) {
  const value = String(text ?? "");
  if (value.length === 0) return { matched: false };
  const outbound = /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget|HttpClient|WebClient|UploadString|UploadData|Send-MailMessage|smtp|ftp|ssh|scp|nc|netcat|Test-NetConnection|System\.Net\.)\b/i.test(
    value
  ) || /https?:\/\//i.test(value);
  if (!outbound) return { matched: false };
  const patterns = [
    { kind: "pem-private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
    { kind: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/ },
    { kind: "github-token", re: /\bghp_[A-Za-z0-9]{20,}\b/ },
    { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
    { kind: "openai-style-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
    { kind: "bearer-credential", re: /\bAuthorization\s*:\s*Bearer\s+\S{8,}/i },
    { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ }
  ];
  for (const pattern of patterns) {
    const hit = pattern.re.exec(value);
    if (hit !== null) {
      const raw = hit[0];
      const masked = `${raw.slice(0, 4)}***(${raw.length} chars)`;
      return { matched: true, kind: pattern.kind, snippet: masked };
    }
  }
  return { matched: false };
}
var CLEARTEXT_SECRET_FAILURE = Object.freeze({
  code: "CLEARTEXT_CREDENTIAL_IN_REQUEST",
  category: FAILURE_SEMANTICS.POLICY,
  message: '\u8BF7\u6C42\u91CC\u51FA\u73B0\u4E86\u660E\u6587\u5F62\u6001\u7684\u79C1\u94A5/\u8BBF\u95EE\u4EE4\u724C\uFF0C\u5DF2\u6309"\u8BE5\u8BF7\u6C42\u4E0D\u88AB\u5141\u8BB8"\u5904\u7406\uFF1A\u672C\u6B21\u672A\u53D1\u51FA\u3002\u51ED\u636E\u4E0D\u5F97\u901A\u8FC7\u660E\u6587\u51FA\u7AD9\u901A\u9053\u53D1\u9001\u3002'
});
function startupFailureInsightFromText(text) {
  const value = String(text ?? "").toLowerCase();
  const hex = Object.keys(STARTUP_FAILURE_TABLE).filter((key2) => key2.length === 10).filter((key2) => value.includes(key2));
  const named = /status_dll_init_failed/.test(value) ? "0xc0000142" : /sec_e_no_credentials|no credentials are available/.test(value) ? "0x8009030e" : void 0;
  const key = hex[0] ?? named;
  const entry = key === void 0 ? void 0 : STARTUP_FAILURE_TABLE[key];
  if (entry === void 0) return void 0;
  return { code: key, category: entry.category, label: entry.label, kind: entry.kind, message: entry.hint };
}
var STARTUP_FAILURE_TABLE = Object.freeze({
  "0xc0000142": { category: STARTUP_FAILURE_CATEGORIES.DLL_INIT_FAILED, label: "STATUS_DLL_INIT_FAILED", kind: "runner-failure", hint: "\u5B50\u8FDB\u7A0B\u5728\u7528\u6237\u6001\u521D\u59CB\u5316\u9636\u6BB5\u5C31\u6B7B\u4E86\uFF08DLL \u521D\u59CB\u5316\u5931\u8D25\uFF09\uFF1A\u591A\u4E3A\u684C\u9762/\u7A97\u53E3\u7AD9\u3001\u4F1A\u8BDD 0\u3001\u53D7\u9650\u4EE4\u724C\u6216 CreateNoWindow \u7EC4\u5408\u5BFC\u81F4\uFF1B\u4E0D\u662F\u547D\u4EE4\u81EA\u8EAB\u5931\u8D25\uFF0C\u4E5F\u4E0D\u662F\u7B56\u7565\u62D2\u7EDD\u3002" },
  "0xc0000135": { category: STARTUP_FAILURE_CATEGORIES.DLL_NOT_FOUND, label: "STATUS_DLL_NOT_FOUND", kind: "runner-failure", hint: "\u5B50\u8FDB\u7A0B\u7F3A\u5C11\u4F9D\u8D56 DLL\uFF08PATH/\u5DE5\u4F5C\u76EE\u5F55\u4E0D\u5BF9\uFF0C\u6216\u4F9D\u8D56\u672A\u5B89\u88C5\uFF09\u3002" },
  "0xc0000005": { category: STARTUP_FAILURE_CATEGORIES.ACCESS_VIOLATION, label: "STATUS_ACCESS_VIOLATION", kind: "runner-failure", hint: "\u5B50\u8FDB\u7A0B\u8BBF\u95EE\u8FDD\u4F8B\uFF08\u5D29\u6E83\uFF09\u3002\u63A2\u9488/\u542F\u52A8\u5668\u81EA\u8EAB\u6545\u969C\uFF0C\u4E0D\u6784\u6210\u5BF9\u547D\u4EE4\u7684\u7B56\u7565\u5224\u5B9A\u3002" },
  "0xc0000409": { category: STARTUP_FAILURE_CATEGORIES.STACK_BUFFER_OVERRUN, label: "STATUS_STACK_BUFFER_OVERRUN", kind: "runner-failure", hint: "\u5B50\u8FDB\u7A0B\u88AB __fastfail \u7EC8\u6B62\uFF08\u6808\u6EA2\u51FA/\u7F13\u89E3\u63AA\u65BD\u89E6\u53D1\uFF09\u3002" },
  "0xe0434352": { category: STARTUP_FAILURE_CATEGORIES.CLR_EXCEPTION, label: "CLR unhandled exception (0xE0434352)", kind: "runner-failure", hint: "\u6258\u7BA1\u8FD0\u884C\u65F6\u629B\u51FA\u4E86\u672A\u5904\u7406\u5F02\u5E38\u3002**\u6CE8\u610F**\uFF1A\u5B83\u65E2\u53EF\u80FD\u662F\u542F\u52A8\u5668/CLI \u5D29\u6E83\uFF0C\u4E5F\u53EF\u80FD\u662F\u88AB\u6D4B\u547D\u4EE4\u81EA\u8EAB\u5D29\u6E83 \u2014\u2014 \u53EA\u770B\u9000\u51FA\u7801\u65E0\u6CD5\u533A\u5206\uFF0C\u987B\u7ED3\u5408\u662F\u5426\u6709\u5B50\u8FDB\u7A0B\u8F93\u51FA\u3002" },
  "0x8007054f": { category: STARTUP_FAILURE_CATEGORIES.INTERNAL_ERROR, label: "HRESULT 0x8007054F (ERROR_INTERNAL_ERROR)", kind: "runner-failure", hint: "Win32 \u5185\u90E8\u9519\u8BEF\uFF08\u5B9E\u6D4B\u51FA\u73B0\u5728 System.Data.dll \u52A0\u8F7D\u8DEF\u5F84\u4E0A\uFF09\uFF1A\u73AF\u5883/\u4F9D\u8D56\u88C5\u914D\u95EE\u9898\uFF0C\u4E0D\u662F\u7B56\u7565\u62D2\u7EDD\u3002" },
  // `0x80070549`（ERROR_NO_SUCH_LOGON_SESSION = 1312）—— 现场里"`ERROR_INTERNAL_ERROR` 那条
  // 栈经常把内层码写成 0x8007054F，而**归一化后真正落到 stdout/stderr 的**是 0x80070549"。
  // 两者同族（都是装配期的 Win32 内部错误），因此**同一分类、同一句结论**，只是机读码原样带出。
  "0x80070549": { category: STARTUP_FAILURE_CATEGORIES.INTERNAL_ERROR, label: "HRESULT 0x80070549 (ERROR_NO_SUCH_LOGON_SESSION)", kind: "runner-failure", hint: "Win32 \u5185\u90E8\u9519\u8BEF\uFF08\u540C 0x8007054F \u4E00\u65CF\uFF0C\u5B9E\u6D4B\u51FA\u73B0\u5728 System.Data.dll \u52A0\u8F7D\u8DEF\u5F84\u4E0A\uFF09\uFF1A\u73AF\u5883/\u4F9D\u8D56\u88C5\u914D\u95EE\u9898\uFF0C\u4E0D\u662F\u7B56\u7565\u62D2\u7EDD\u3001\u4E5F\u4E0D\u662F\u5B89\u5168\u62E6\u622A\u3002" },
  "0x80070005": { category: STARTUP_FAILURE_CATEGORIES.ACCESS_DENIED, label: "HRESULT 0x80070005 (E_ACCESSDENIED / ERROR_ACCESS_DENIED)", kind: "denied", hint: "\u771F\u7684\u662F\u8BBF\u95EE\u88AB\u62D2\uFF08ACL / \u4EE4\u724C\u6743\u9650\uFF09\u3002" },
  // ── WP6：**故障伪装成防护**必须被拆穿（否则会被读成"安全拦截"，从而掩盖真实故障）──
  "0x8009030e": { category: STARTUP_FAILURE_CATEGORIES.NO_CREDENTIALS, label: "SEC_E_NO_CREDENTIALS (0x8009030E)", kind: "environment-fault", hint: 'Schannel/Security Support Provider \u53D6\u4E0D\u5230\u51ED\u636E\uFF1A\u8FD9\u662F**\u4EE4\u724C\u80FD\u529B\u7F3A\u5931**\uFF08\u53D7\u9650\u4EE4\u724C\u4E0B\u6CA1\u6709\u53EF\u7528\u51ED\u636E\u53E5\u67C4\uFF09\uFF0C**\u4E0D\u662F\u5B89\u5168\u62E6\u622A**\uFF0C\u4E5F\u4E0D\u662F\u7B56\u7565\u62D2\u7EDD \u2014\u2014 \u4E0D\u8981\u628A\u5B83\u8BFB\u6210"\u88AB\u5B89\u5168\u7B56\u7565\u6321\u4F4F"\u3002\u5C5E\u73AF\u5883\u6545\u969C\uFF0C\u53EF\u91CD\u8BD5\u3002' },
  "0x800700b7": { category: STARTUP_FAILURE_CATEGORIES.ALREADY_EXISTS, label: "HRESULT 0x800700B7 (ERROR_ALREADY_EXISTS)", kind: "environment-fault", hint: "\u76EE\u6807\u5BF9\u8C61\u5DF2\u5B58\u5728\uFF08\u5B9E\u6D4B\u51FA\u73B0\u5728 profile/\u5BB9\u5668\u76EE\u5F55\u88C5\u914D\u8DEF\u5F84\u4E0A\uFF09\uFF1A\u5C5E**\u73AF\u5883/\u88C5\u914D**\u95EE\u9898\uFF0C\u4E0D\u662F\u7B56\u7565\u62D2\u7EDD\u3001\u4E5F\u4E0D\u662F\u5B89\u5168\u62E6\u622A\u3002" },
  "0x0000007f": { category: STARTUP_FAILURE_CATEGORIES.SPAWN_UNKNOWN, label: "spawn UNKNOWN (127)", kind: "runner-failure", hint: "libuv \u7684 `spawn UNKNOWN`\uFF1ACreateProcess \u6CA1\u7ED9\u51FA\u53EF\u7528\u9519\u8BEF\u7801\uFF0C\u53EF\u6267\u884C\u6587\u4EF6/\u4F9D\u8D56/\u6743\u9650\u4E09\u8005\u4E4B\u4E00\u3002" },
  "0x00000002": { category: STARTUP_FAILURE_CATEGORIES.FILE_NOT_FOUND, label: "Win32 2 (ERROR_FILE_NOT_FOUND)", kind: "runner-failure", hint: "\u53EF\u6267\u884C\u6587\u4EF6\u6CA1\u627E\u5230\uFF1ACreateProcessAsUserW \u4E0D\u8865 PATHEXT\u3001\u4E0D\u67E5 App Paths\uFF0C\u88F8\u547D\u4EE4\u540D\u5FC5\u7136\u8D70\u5230\u8FD9\u91CC\u3002" }
});
function normalizeExitCode(value) {
  if (value === void 0 || value === null || typeof value !== "number" || Number.isNaN(value)) return void 0;
  const signed = value > 2147483647 ? value - 4294967296 : Math.trunc(value);
  const unsigned = value >>> 0;
  return { signed, unsigned, hex: `0x${unsigned.toString(16).padStart(8, "0")}` };
}
function classifyStartupFailure(input = {}) {
  const exit = normalizeExitCode(input.exitCode);
  const text = `${input.stderr ?? ""}
${input.stdout ?? ""}
${input.launchFailure?.message ?? input.error ?? ""}`;
  const spawned = (() => {
    const match = /spawn\s+UNKNOWN(?:\s*\((\d+)\))?/i.exec(text);
    if (match) return { matched: true, raw: match[0], code: match[1] };
    return { matched: false };
  })();
  let entry;
  if (exit !== void 0 && STARTUP_FAILURE_TABLE[exit.hex]) entry = STARTUP_FAILURE_TABLE[exit.hex];
  else if (spawned.matched) entry = STARTUP_FAILURE_TABLE["0x0000007f"];
  const stdoutText = String(input.stdout ?? "");
  const stderrText = String(input.stderr ?? "");
  const stdoutReal = stdoutText.split(/\r?\n/).filter((line) => line.length > 0 && !/^dsh-stage:/.test(line)).join("\n").trim();
  const producedOutput = stdoutReal.length > 0;
  const cleanExit = exit !== void 0 && exit.unsigned === 0;
  const observedSideEffects = input.sideEffectsObserved === true;
  const childRan = producedOutput || cleanExit || observedSideEffects;
  const accessDeniedText = /access is denied|0x80070005|E_ACCESSDENIED|UnauthorizedAccessException|PermissionDenied/i.test(text);
  const codes = [];
  if (exit) codes.push(exit.hex);
  if (spawned.matched) codes.push("spawn UNKNOWN");
  const recognized = entry !== void 0;
  const conclusion = recognized ? {
    category: entry.category,
    label: entry.label,
    kind: entry.kind,
    message: entry.hint
  } : {
    category: STARTUP_FAILURE_CATEGORIES.NONE,
    label: "no startup-failure signature recognized",
    kind: void 0,
    message: "\u6CA1\u6709\u8BC6\u522B\u5230\u5DF2\u77E5\u7684\u542F\u52A8\u5931\u8D25\u7279\u5F81\uFF08\u6309\u666E\u901A\u547D\u4EE4\u7ED3\u679C\u5904\u7406\uFF09\u3002"
  };
  const contradicted = accessDeniedText && childRan;
  return {
    // ── 归一分类（可读）
    category: conclusion.category,
    label: conclusion.label,
    classificationKind: conclusion.kind,
    message: conclusion.message,
    // ── 真实值原样带出
    ntstatus: exit?.signed,
    ntstatusHex: exit?.hex,
    ntstatusUnsigned: exit?.unsigned,
    rawSignature: spawned.matched ? spawned.raw : void 0,
    recognizedCodes: codes,
    // ── 事实性检查（stderr 不算执行证据，理由见上）────────────────────────────
    stdoutBytes: stdoutReal.length,
    stderrPresent: stderrText.trim().length > 0,
    evidenceOfExecution: { producedOutput, cleanExit, observedSideEffects },
    childRan,
    // ── "报错与事实相反"的显式结论
    denialClaimContradicted: contradicted,
    conclusion: contradicted ? "denial-claim-contradicted-by-evidence" : conclusion.category === STARTUP_FAILURE_CATEGORIES.NONE ? "no-startup-failure" : "classified",
    diagnosis: contradicted ? '\u542F\u52A8/\u6267\u884C\u901A\u9053\u62A5\u7684\u662F access-denied \u5F62\u6001\u7684\u62D2\u7EDD\uFF0C\u4F46**\u540C\u65F6\u5B58\u5728\u6267\u884C\u8BC1\u636E**\uFF08stdout \u6709\u8F93\u51FA / \u5E72\u51C0\u9000\u51FA\u7801 / \u8C03\u7528\u65B9\u62A5\u7684\u526F\u4F5C\u7528\uFF09\u2014\u2014 \u56E0\u6B64**\u4E0D\u5F97**\u636E\u6B64\u4E0B"\u547D\u4EE4\u672A\u6267\u884C"\u6216"\u547D\u4EE4\u88AB\u62D2"\u7684\u7ED3\u8BBA\uFF1B\u5230\u5E95\u8DD1\u6CA1\u8DD1\u3001\u8DD1\u5B8C\u6CA1\u6709\uFF0C\u4EC5\u51ED\u8FD9\u6761\u62A5\u9519**\u65E0\u6CD5\u5224\u5B9A**\uFF0C\u8BF7\u4EE5\u5B9E\u9645\u4EA7\u51FA\u4E3A\u51C6\u3002\u8BE5\u62D2\u7EDD\u58F0\u660E**\u4E0D\u6784\u6210**\u7B56\u7565\u5224\u5B9A\u3002' : conclusion.message
  };
}
function classifyOutcome({ exitCode, stdout, stderr, launchFailure, startupFailure }) {
  const text = `${stderr}
${stdout}`;
  if (/dsh-stage: timeout after|^timeout after/m.test(text)) {
    return { kind: "timeout", reason: "execution exceeded the configured timeout" };
  }
  if (/STAGING_ROOT_LOST|STAGING_ROOT_VANISHED|STAGING_ROOT_ENV_BLANKED|STAGING_ROOT_ABSENT|STAGING_ROOT_NOT_A_DIRECTORY/.test(text) || /WINSTAGE_STAGE_ROOT\b[^\n]{0,40}(变成空|is empty|blanked)/i.test(text) || /staging root[^\n]{0,60}(lost|vanished|no longer exists)/i.test(text)) {
    return {
      kind: "root-loss",
      reason: "the staging root was LOST (it went empty or vanished mid-session) \u2014 this is a sandbox/root lifecycle failure, NOT a policy denial; earlier staged work may already be gone",
      policyDenial: false
    };
  }
  if (/dsh-stage: sandbox launch failed|windows-acl-run:|SANDBOX_UNAVAILABLE/.test(text)) {
    return { kind: "runner-failure", reason: "sandbox runner/launcher refused \u2014 classify as a broken sandbox, not a policy denial" };
  }
  const startup = startupFailure ?? classifyStartupFailure({ exitCode, stdout, stderr, launchFailure });
  if (startup.denialClaimContradicted || startup.category !== STARTUP_FAILURE_CATEGORIES.NONE && STARTUP_FAILURE_TABLE[startup.ntstatusHex]) {
    return {
      kind: startup.denialClaimContradicted ? "command-failed" : startup.classificationKind ?? "runner-failure",
      reason: startup.diagnosis,
      startupFailure: startup,
      // 供机检：这一条**不是**策略拒绝
      policyDenial: startup.category === STARTUP_FAILURE_CATEGORIES.ACCESS_DENIED && !startup.denialClaimContradicted,
      contradictedDenialClaim: startup.denialClaimContradicted === true
    };
  }
  if (/Access is denied|UnauthorizedAccessException|PermissionDenied|0x80070005|EPERM|EACCES/i.test(text)) {
    return { kind: "denied", reason: "the confined action was denied by the write boundary / ACL", policyDenial: true };
  }
  if (exitCode === 0) return { kind: "ok", reason: "completed" };
  if (exitCode === 124) return { kind: "timeout", reason: "execution exceeded the configured timeout" };
  if (exitCode === 127) return { kind: "runner-failure", reason: "runner exit 127 \u2014 documented broken-sandbox signal" };
  return { kind: "command-failed", reason: `command exited ${exitCode}` };
}
function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}
function safeDispose(sandbox) {
  try {
    sandbox?.dispose();
  } catch {
  }
}
function safeLoadProcessBindings(win32Module) {
  try {
    return win32Module.loadWin32ProcessBindings();
  } catch {
    return void 0;
  }
}
function safeClose(api, handle) {
  try {
    if (handle !== void 0 && handle !== null) api.closeHandle(handle);
  } catch {
  }
}
function safeVersion(from, packageName) {
  if (!from || from === "self") return void 0;
  try {
    return createRequire2(join6(from, "noop.js"))(`${packageName}/package.json`).version;
  } catch {
    return void 0;
  }
}
function cleanupTargets(targets) {
  for (const target of targets) {
    try {
      if (existsSync3(target)) rmSync3(target, { force: true });
    } catch {
    }
  }
}
function defaultPrivateTemp() {
  const base = join6(tmpdir2(), "dsh-stage-temp");
  mkdirSync3(base, { recursive: true });
  return join6(base, randomUUID3());
}
function canonicalDir(target) {
  const absolute = normalize4(target);
  try {
    return realpathSync2.native(absolute);
  } catch {
    return absolute;
  }
}
function sameDir(left, right) {
  if (!left || !right) return false;
  return canonicalDir(left).toLowerCase().replace(/[\\/]+$/, "") === canonicalDir(right).toLowerCase().replace(/[\\/]+$/, "");
}
function sameDirOrInside(parent, child) {
  if (!parent || !child) return false;
  const p = canonicalDir(parent).toLowerCase().replace(/[\\/]+$/, "");
  const c = canonicalDir(child).toLowerCase().replace(/[\\/]+$/, "");
  return c === p || c.startsWith(p + sep4);
}
function ps(value) {
  return value.replace(/'/g, "''");
}
var TRANSPARENT_TIER = "TS";
var SHIM_ABI_VERSION = 1;
var SHIM_INJECT_FAILURE_EXIT = 111;
var SHIM_REQUIRED_EXPORTS = ["WinstageShimInit", "WinstageShimAbiVersion", "WinstageShimStatsJson"];
var SHIM_RELATIVE_PATHS = {
  dll: join6("shim", "out", "winstage-shim.dll"),
  injector: join6("shim", "out", "winstage-inject.exe"),
  probe: join6("shim", "out", "winstage-probe.exe")
};
var CAPABILITY_MARKER = "WINSTAGE-CAPABILITY:";
function repoRootPath() {
  return dirname4(dirname4(fileURLToPath2(import.meta.url)));
}
function resolveShimArtifacts(options = {}) {
  const shimDir = resolve2(options.shimDir || process.env.WINSTAGE_SHIM_DIR || join6(repoRootPath(), "shim", "out"));
  return {
    shimDir,
    dllPath: resolve2(options.dllPath || process.env.WINSTAGE_SHIM_DLL || join6(shimDir, "winstage-shim.dll")),
    injectorPath: resolve2(options.injectorPath || process.env.WINSTAGE_SHIM_INJECTOR || join6(shimDir, "winstage-inject.exe")),
    probePath: resolve2(options.probePath || process.env.WINSTAGE_SHIM_PROBE || join6(shimDir, "winstage-probe.exe"))
  };
}
function parsePeExports(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64) return { ok: false, detail: "file too small" };
  if (buffer.readUInt16LE(0) !== 23117) return { ok: false, detail: "no MZ header" };
  const peOffset = buffer.readUInt32LE(60);
  if (peOffset <= 0 || peOffset + 24 > buffer.length) return { ok: false, detail: `bogus e_lfanew ${peOffset}` };
  if (buffer.readUInt32LE(peOffset) !== 17744) return { ok: false, detail: "no PE signature" };
  const coff = peOffset + 4;
  const machine = buffer.readUInt16LE(coff);
  const numberOfSections = buffer.readUInt16LE(coff + 2);
  const sizeOfOptionalHeader = buffer.readUInt16LE(coff + 16);
  const optional = coff + 20;
  if (optional + 2 > buffer.length) return { ok: false, detail: "truncated optional header" };
  const magic = buffer.readUInt16LE(optional);
  if (magic !== 523) return { ok: false, detail: `not PE32+ (magic=0x${magic.toString(16)})` };
  if (optional + 116 > buffer.length) return { ok: false, detail: "truncated data directories" };
  const exportRva = buffer.readUInt32LE(optional + 112);
  const sections = [];
  const sectionTable = optional + sizeOfOptionalHeader;
  for (let index = 0; index < numberOfSections; index += 1) {
    const at = sectionTable + index * 40;
    if (at + 40 > buffer.length) break;
    sections.push({
      virtualSize: buffer.readUInt32LE(at + 8),
      virtualAddress: buffer.readUInt32LE(at + 12),
      sizeOfRawData: buffer.readUInt32LE(at + 16),
      pointerToRawData: buffer.readUInt32LE(at + 20)
    });
  }
  const rvaToOffset = (rva) => {
    for (const section of sections) {
      const span = Math.max(section.virtualSize, section.sizeOfRawData);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
        return section.pointerToRawData + (rva - section.virtualAddress);
      }
    }
    return -1;
  };
  if (exportRva === 0) return { ok: true, machine, names: [], detail: "no export directory" };
  const exportOffset = rvaToOffset(exportRva);
  if (exportOffset < 0 || exportOffset + 40 > buffer.length) return { ok: false, detail: "export directory RVA out of range" };
  const nameCount = buffer.readUInt32LE(exportOffset + 24);
  const namesRva = buffer.readUInt32LE(exportOffset + 32);
  const namesOffset = rvaToOffset(namesRva);
  if (namesOffset < 0 || nameCount > 65535) return { ok: false, detail: "export name table out of range" };
  const names = [];
  for (let index = 0; index < nameCount; index += 1) {
    const at = namesOffset + index * 4;
    if (at + 4 > buffer.length) break;
    const nameOffset = rvaToOffset(buffer.readUInt32LE(at));
    if (nameOffset < 0) continue;
    const end = buffer.indexOf(0, nameOffset);
    if (end < 0) continue;
    names.push(buffer.toString("ascii", nameOffset, end));
  }
  return { ok: true, machine, names };
}
function probeShimDll(dllPath) {
  if (!dllPath) return { ok: false, detail: "no candidate shim DLL path" };
  if (!existsSync3(dllPath)) return { ok: false, detail: `not found: ${dllPath}` };
  let buffer;
  try {
    buffer = readFileSync3(dllPath);
  } catch (error) {
    return { ok: false, detail: `unreadable: ${error.message}` };
  }
  const pe = parsePeExports(buffer);
  if (!pe.ok) return { ok: false, detail: `PE parse failed: ${pe.detail}` };
  if (pe.machine !== 34404) return { ok: false, detail: `machine 0x${pe.machine.toString(16)} is not x64 (0x8664)` };
  const missing = SHIM_REQUIRED_EXPORTS.filter((name) => !pe.names.includes(name));
  if (missing.length > 0) {
    return { ok: false, detail: `missing exports: ${missing.join(", ")} (found: ${pe.names.slice(0, 8).join(", ") || "none"})` };
  }
  return {
    ok: true,
    detail: `x64 PE, ${buffer.length} bytes, ${pe.names.length} exports incl. ${SHIM_REQUIRED_EXPORTS.join("/")}`,
    exports: pe.names,
    size: buffer.length
  };
}
function writeShimConfig({ stageRoot, logPath, extraPassthrough = [] }) {
  const configPath = join6(stageRoot, "winstage-shim.config.json");
  const passthrough = [...new Set([stageRoot, ...extraPassthrough].filter((value) => typeof value === "string" && value.length > 0))];
  const config = {
    stageRoot,
    logPath: logPath ?? join6(stageRoot, "shim.log"),
    failClosed: true,
    readThrough: true,
    verbose: false,
    traceStagedOps: true,
    passthrough
  };
  writeFileSync4(configPath, `${JSON.stringify(config, null, 2)}
`, "utf8");
  return { configPath, config };
}
function runCapturedToFiles(file, args, options = {}) {
  const captureDir = resolve2(options.captureDir || options.cwd || tmpdir2());
  mkdirSync3(captureDir, { recursive: true });
  const stamp = `${Date.now().toString(36)}-${randomUUID3().slice(0, 6)}`;
  const outPath = join6(captureDir, `.winstage-cap-${stamp}.out`);
  const errPath = join6(captureDir, `.winstage-cap-${stamp}.err`);
  let outFd;
  let errFd;
  let status = null;
  let signal = null;
  let failure;
  try {
    outFd = openSync2(outPath, "w");
    errFd = openSync2(errPath, "w");
    const result = spawnSyncChildProcess(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", outFd, errFd],
      timeout: options.timeoutMs ?? 6e4,
      windowsHide: false
    });
    status = result.status;
    signal = result.signal;
    failure = result.error?.message;
  } catch (error) {
    failure = error.message;
  } finally {
    for (const fd of [outFd, errFd]) {
      if (typeof fd === "number") {
        try {
          closeSync2(fd);
        } catch {
        }
      }
    }
  }
  const read = (path) => {
    try {
      return existsSync3(path) ? readFileSync3(path, "utf8") : "";
    } catch {
      return "";
    }
  };
  const out = read(outPath);
  const err = read(errPath);
  if (options.keepCaptureFiles !== true) {
    for (const path of [outPath, errPath]) {
      try {
        unlinkSync2(path);
      } catch {
      }
    }
  }
  return { code: status, signal, timedOut: status === null && signal === "SIGTERM", error: failure, out, err };
}
function parseMarkerJson(text, marker = CAPABILITY_MARKER) {
  if (typeof text !== "string") return void 0;
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const at = lines[index].indexOf(marker);
    if (at < 0) continue;
    try {
      return JSON.parse(lines[index].slice(at + marker.length).trim());
    } catch {
    }
  }
  return void 0;
}
function buildCapabilityCanaryScript() {
  return [
    "$ErrorActionPreference = 'Continue'",
    "$r = [ordered]@{}",
    // ① 管道：跑不通时管道内容为空（错误是非终止性的）
    "$pipeText = ''",
    'try { $pipeText = (& node --version | Out-String) } catch { $pipeText = "" }',
    "$r.pipeOk = [bool]($pipeText -match '^v\\d+\\.')",
    "$r.pipeText = ($pipeText + '').Trim()",
    // ② 重定向：受限令牌下文件会被创建但**内容为空**（静默丢数据）
    "$f = Join-Path $env:TEMP ('winstage-canary-' + [guid]::NewGuid().ToString('n') + '.txt')",
    "try { & node --version > $f } catch { }",
    "$redirText = ''",
    'try { if (Test-Path -LiteralPath $f) { $redirText = ((Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue) + "").Trim() } } catch { }',
    "$r.redirectOk = [bool]($redirText -match '^v\\d+\\.')",
    "$r.redirectText = $redirText",
    "Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue",
    // ③ 系统查询（不重定向：让子进程直接继承脚本自身的标准句柄，靠退出码判定）
    "& whoami.exe /user",
    "$r.whoamiUser = ($LASTEXITCODE -eq 0)",
    "& whoami.exe /groups",
    "$r.whoamiGroups = ($LASTEXITCODE -eq 0)",
    '& tasklist.exe /FI "IMAGENAME eq node.exe"',
    "$r.tasklist = ($LASTEXITCODE -eq 0)",
    "try { Get-CimInstance Win32_OperatingSystem -ErrorAction Stop | Out-Null; $r.cim = $true } catch { $r.cim = $false }",
    "try { Get-NetFirewallProfile -ErrorAction Stop | Out-Null; $r.firewall = $true } catch { $r.firewall = $false }",
    "try { $tc = Get-NetTCPConnection -ErrorAction Stop; $r.tcpConnection = ($null -ne $tc) } catch { $r.tcpConnection = $false }",
    // ④ TLS：SChannel 的失败发生在**取凭据**这一步，因此用回环自连即可把它逼出来
    "$r.tlsCredentials = $false",
    "$r.tlsDetail = ''",
    "$listener = $null",
    "try {",
    "  $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)",
    "  $listener.Start()",
    "  $client = New-Object Net.Sockets.TcpClient",
    "  $client.ReceiveTimeout = 4000",
    "  $client.Connect('127.0.0.1', $listener.LocalEndpoint.Port)",
    "  $ssl = New-Object Net.Security.SslStream($client.GetStream(), $false, [System.Net.Security.RemoteCertificateValidationCallback]{ $true })",
    '  try { $ssl.AuthenticateAsClient("localhost"); $r.tlsCredentials = $true; $r.tlsDetail = "handshake-ok" }',
    "  catch {",
    "    $m = $_.Exception.Message",
    "    if ($_.Exception.InnerException) { $m = $_.Exception.InnerException.Message }",
    "    $r.tlsDetail = $m",
    "    $r.tlsCredentials = [bool]($m -notmatch 'credentials are available')",
    "  }",
    "  $client.Close()",
    "} catch { $r.tlsDetail = $_.Exception.Message }",
    "finally { if ($listener) { $listener.Stop() } }",
    // ⑤ 沙箱痕迹：子进程环境里不得有任何 DSH_SANDBOX*
    '$r.dshSandboxVars = @([System.Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -like "DSH_SANDBOX*" })',
    "$r.dshSandboxCount = $r.dshSandboxVars.Count",
    // ⑤b 去令牌化模式的**已知可见痕迹**：shim 的环境契约变量（如实上报，不当成没发生）
    '$r.winstageVars = @([System.Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -like "WINSTAGE_*" })',
    "$r.winstageCount = $r.winstageVars.Count",
    "[Console]::Out.Write('" + CAPABILITY_MARKER + "' + ($r | ConvertTo-Json -Compress))"
  ].join("\r\n");
}
function judgeCanary(canary) {
  if (!canary || typeof canary !== "object") {
    return { ok: false, reason: "canary produced no parsable marker JSON", items: {}, advisory: {} };
  }
  const items = {
    pipe: canary.pipeOk === true,
    redirect: canary.redirectOk === true,
    whoamiUser: canary.whoamiUser === true,
    whoamiGroups: canary.whoamiGroups === true,
    tasklist: canary.tasklist === true,
    cim: canary.cim === true,
    tcpConnection: canary.tcpConnection === true,
    noDshSandboxTrace: (canary.dshSandboxCount ?? 1) === 0
  };
  const advisory = {
    firewall: canary.firewall === true,
    tlsCredentials: canary.tlsCredentials === true
  };
  const failed = Object.entries(items).filter(([, ok]) => !ok).map(([name]) => name);
  const advisoryFailed = Object.entries(advisory).filter(([, ok]) => !ok).map(([name]) => name);
  const reason = failed.length === 0 ? `all capabilities present${advisoryFailed.length > 0 ? ` (advisory failed: ${advisoryFailed.join(", ")})` : ""}` : `failed: ${failed.join(", ")}${advisoryFailed.length > 0 ? ` (advisory failed: ${advisoryFailed.join(", ")})` : ""}`;
  return { ok: failed.length === 0, reason, items, advisory, advisoryFailed };
}
var CARRIER_INIT_FAILED_PREFIX = "carrier-init-failed";
function formatExitCode(code) {
  if (typeof code !== "number" || !Number.isFinite(code)) return String(code);
  return `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}
function clipDiagnostic(text, head = 320, tail = 160) {
  const value = String(text ?? "");
  if (value.length <= head + tail) return value;
  return `${value.slice(0, head)} \u2026 [+${value.length - head - tail} chars elided] \u2026 ${value.slice(-tail)}`;
}
var transparentProbeCache = /* @__PURE__ */ new Map();
function transparentProbeCacheKey(options, artifacts, stageRoot, captureDir) {
  if (options.cache === false || options.refresh === true) return void 0;
  const stat = (p) => {
    try {
      const s = statSync3(p);
      return `${s.size}@${Math.trunc(s.mtimeMs)}`;
    } catch {
      return "missing";
    }
  };
  return JSON.stringify([
    artifacts.dllPath,
    stat(artifacts.dllPath),
    artifacts.injectorPath,
    stat(artifacts.injectorPath),
    artifacts.probePath,
    stat(artifacts.probePath),
    stageRoot,
    captureDir,
    options.timeoutMs ?? 6e4,
    options.extraPassthrough ?? null
  ]);
}
function probeTransparentShim(options = {}) {
  const artifacts = options.artifacts ?? resolveShimArtifacts(options);
  const stageRoot = typeof options.stagingRoot === "string" && options.stagingRoot.length > 0 ? resolve2(options.stagingRoot) : options.stagingRoot;
  const captureDir = resolve2(options.captureDir || stageRoot || tmpdir2());
  const key = transparentProbeCacheKey(options, artifacts, stageRoot, captureDir);
  if (key !== void 0) {
    const hit = transparentProbeCache.get(key);
    if (hit !== void 0) return hit;
  }
  const result = probeTransparentShimUncached({ ...options, artifacts, stagingRoot: stageRoot, captureDir });
  if (key !== void 0 && result?.available === true) transparentProbeCache.set(key, result);
  return result;
}
function probeTransparentShimUncached(options = {}) {
  const checks = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    return ok;
  };
  const artifacts = options.artifacts ?? resolveShimArtifacts(options);
  const stageRoot = typeof options.stagingRoot === "string" && options.stagingRoot.length > 0 ? resolve2(options.stagingRoot) : options.stagingRoot;
  const captureDir = resolve2(options.captureDir || stageRoot || tmpdir2());
  const timeoutMs = options.timeoutMs ?? 6e4;
  const done = (available2, reason, extra = {}) => ({
    available: available2,
    reason,
    artifacts,
    checks,
    abiVersion: extra.abiVersion,
    stats: extra.stats,
    canary: extra.canary,
    canaryJudge: extra.canaryJudge,
    configPath: extra.configPath,
    logPath: extra.logPath,
    transport: "winstage-inject.exe (remote LoadLibraryW; T4 contract)"
  });
  const dll = probeShimDll(artifacts.dllPath);
  record("shim-dll", dll.ok, dll.detail);
  const injectorOk = existsSync3(artifacts.injectorPath);
  record("shim-injector", injectorOk, injectorOk ? artifacts.injectorPath : `not found: ${artifacts.injectorPath}`);
  const probeOk = existsSync3(artifacts.probePath);
  record("shim-probe-exe", probeOk, probeOk ? artifacts.probePath : `not found: ${artifacts.probePath}`);
  if (!dll.ok || !injectorOk || !probeOk) {
    return done(false, checks.find((entry) => !entry.ok)?.detail ?? "shim artifacts incomplete");
  }
  if (typeof stageRoot !== "string" || stageRoot.length === 0) {
    record("shim-stage-root", false, "stagingRoot is required for the transparent mode");
    return done(false, "stagingRoot is required for the transparent mode");
  }
  try {
    mkdirSync3(stageRoot, { recursive: true });
  } catch (error) {
    record("shim-stage-root", false, `cannot create ${stageRoot}: ${error.message}`);
    return done(false, `cannot create ${stageRoot}: ${error.message}`);
  }
  const logPath = options.logPath || join6(stageRoot, "shim.log");
  let configPath;
  try {
    configPath = writeShimConfig({ stageRoot, logPath, extraPassthrough: options.passthrough ?? [] }).configPath;
    record("shim-config", true, configPath);
  } catch (error) {
    record("shim-config", false, `cannot write ${stageRoot}\\winstage-shim.config.json: ${error.message}`);
    return done(false, `cannot write the shim config: ${error.message}`);
  }
  const canaryTemp = options.tempDir ? resolve2(options.tempDir) : join6(stageRoot, ".canary-temp");
  mkdirSync3(canaryTemp, { recursive: true });
  const allowlisted = buildChildEnvironment({}, { tempDir: canaryTemp, cwd: stageRoot }).env;
  const shimEnv = {
    ...allowlisted,
    WINSTAGE_STAGE_ROOT: stageRoot,
    WINSTAGE_SHIM_LOG: logPath,
    WINSTAGE_SHIM_CONFIG: configPath,
    // The canary must use the SAME overlay location as the real runs, otherwise the
    // probe's own `registry/overlay*.hive` lands inside the staged tree and the
    // host's "collect staged-tree changes" step tries to ingest it (self-referential
    // entry; observed as `EPERM ... overlay.<pid>.hive.LOG1`).
    ...typeof options.registryStageDir === "string" && options.registryStageDir.length > 0 ? {
      WINSTAGE_REGSTAGE_SESSION_DIR: options.registryStageDir,
      DSH_REGSTAGE_ROOT: options.registryStageDir
    } : {}
  };
  const selftestPath = join6(captureDir, `.winstage-selftest-${randomUUID3().slice(0, 6)}.json`);
  const selftestRun = runCapturedToFiles(artifacts.probePath, ["selftest", artifacts.dllPath, selftestPath], {
    cwd: stageRoot,
    env: shimEnv,
    timeoutMs,
    captureDir
  });
  let selftest;
  try {
    selftest = existsSync3(selftestPath) ? JSON.parse(readFileSync3(selftestPath, "utf8")) : void 0;
  } catch {
    selftest = void 0;
  }
  const abiVersion = selftest?.abiVersion ?? selftest?.abi;
  const abiOk = abiVersion === SHIM_ABI_VERSION;
  const stats = parseJsonMaybe(selftest?.statsRaw) ?? selftest?.stats ?? selftest?.selftestStats;
  const initialized = stats?.initialized === true || selftest?.initialized === true;
  const hooksInstalled = stats?.hooksInstalled === true;
  record(
    "shim-selftest",
    abiOk && initialized,
    `probe exit=${selftestRun.code}; loaded=${selftest?.loaded} abi=${abiVersion} initReturn=${selftest?.initReturn} initialized=${initialized} hooksInstalled=${hooksInstalled} iatSites=${stats?.hooks?.iatSites ?? "n/a"} modules=${stats?.hooks?.modules ?? "n/a"}; ${String(selftestRun.err).slice(0, 200)}`
  );
  try {
    unlinkSync2(selftestPath);
  } catch {
  }
  if (!abiOk || !initialized) {
    return done(false, `shim selftest did not prove an initialized ABI ${SHIM_ABI_VERSION} DLL`, { abiVersion, configPath, logPath, stats });
  }
  const canaryScriptPath = join6(stageRoot, ".winstage-canary.ps1");
  try {
    writeFileSync4(canaryScriptPath, `\uFEFF${buildCapabilityCanaryScript()}\r
`, "utf8");
  } catch (error) {
    record("shim-canary-script", false, `cannot write ${canaryScriptPath}: ${error.message}`);
    return done(false, `cannot write the canary script: ${error.message}`, { abiVersion, configPath, logPath });
  }
  const reportPath = join6(captureDir, `.winstage-inject-report-${randomUUID3().slice(0, 6)}.json`);
  let canaryTarget = options.canaryTarget;
  if (!canaryTarget) {
    try {
      canaryTarget = resolveExecutable("powershell", { env: shimEnv, cwd: stageRoot });
    } catch {
      canaryTarget = "powershell.exe";
    }
  }
  let canaryRun;
  let injectReport;
  const maxCarrierAttempts = Math.max(1, Math.min(5, Number.isInteger(options.carrierRetries) ? options.carrierRetries : 3));
  const carrierAttempts = [];
  for (let attempt = 1; attempt <= maxCarrierAttempts; attempt += 1) {
    try {
      unlinkSync2(reportPath);
    } catch {
    }
    canaryRun = runCapturedToFiles(
      artifacts.injectorPath,
      [
        "--dll",
        artifacts.dllPath,
        "--report",
        reportPath,
        "--",
        canaryTarget,
        "-NoLogo",
        "-NonInteractive",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        canaryScriptPath
      ],
      { cwd: stageRoot, env: shimEnv, timeoutMs, captureDir }
    );
    try {
      injectReport = existsSync3(reportPath) ? JSON.parse(readFileSync3(reportPath, "utf8")) : void 0;
    } catch {
      injectReport = void 0;
    }
    const attemptInjectorHealthy = injectReport?.ok === true;
    const attemptChildStarted = canaryRun.code === 0;
    carrierAttempts.push({
      attempt,
      exit: canaryRun.code,
      injectorOk: attemptInjectorHealthy,
      childStarted: attemptChildStarted,
      timedOut: canaryRun.timedOut === true
    });
    const carrierOnlyFailure = attemptInjectorHealthy && !attemptChildStarted && canaryRun.timedOut !== true;
    if (carrierOnlyFailure && attempt < maxCarrierAttempts) continue;
    break;
  }
  const injectorHealthy = injectReport?.ok === true;
  const childStarted = canaryRun.code === 0;
  const carrierInitFailed = injectorHealthy && !childStarted;
  const injectionOk = childStarted && injectReport?.ok !== false;
  const attemptsNote = carrierAttempts.length > 1 ? ` carrierAttempts=${carrierAttempts.length}/${maxCarrierAttempts} carrierExits=[${carrierAttempts.map((entry) => formatExitCode(entry.exit)).join(", ")}]` : "";
  const injectorDetail = `injector exit=${canaryRun.code} (${formatExitCode(canaryRun.code)}) (111=injection failure) report.ok=${injectReport?.ok ?? "n/a"}${attemptsNote}`;
  record(
    "shim-inject-canary",
    injectionOk,
    carrierInitFailed ? `${CARRIER_INIT_FAILED_PREFIX}: injectorOk=true childExit=${canaryRun.code} (${formatExitCode(canaryRun.code)}); the injector succeeded but the carrier process (target=${canaryTarget}) died during its own initialization; ${injectorDetail} ${clipDiagnostic(injectReport?.error ?? canaryRun.err)}` : `${injectorDetail} ${clipDiagnostic(injectReport?.error ?? canaryRun.err)}`
  );
  const logExists = existsSync3(logPath);
  let logTail = "";
  try {
    logTail = logExists ? readFileSync3(logPath, "utf8").slice(-400) : "";
  } catch {
    logTail = "";
  }
  record("shim-log-observed", logExists, logExists ? `${logPath}: ${logTail.replace(/\s+/g, " ").slice(0, 200)}` : `no shim log at ${logPath}`);
  const canary = parseMarkerJson(canaryRun.out);
  const canaryJudge = judgeCanary(canary);
  record(
    "shim-canary-capabilities",
    canaryJudge.ok,
    `${canaryJudge.reason}; target=${canaryTarget}; stderr=${String(canaryRun.err).replace(/\u0000/g, "").replace(/\s+/g, " ").slice(0, 300)}; raw=${JSON.stringify(canary ?? {}).slice(0, 300)}`
  );
  for (const path of [reportPath, canaryScriptPath]) {
    try {
      unlinkSync2(path);
    } catch {
    }
  }
  const available = checks.filter((entry) => entry.name !== "shim-log-observed").every((entry) => entry.ok);
  return done(available, available ? "transparent shim is available and capability-proven" : checks.find((entry) => !entry.ok)?.detail ?? "transparent shim not proven", {
    abiVersion,
    canary,
    canaryJudge,
    configPath,
    logPath
  });
}
var ShimLauncher = class {
  constructor(api, options = {}) {
    this.api = api;
    this.options = options;
    this.artifacts = options.artifacts;
    this.env = options.env ?? {};
    this.captureDir = options.captureDir;
    this.spawn = typeof options.spawn === "function" ? options.spawn : spawnCapturedAsync;
    this.tracked = /* @__PURE__ */ new Set();
    this.lastLaunch = void 0;
  }
  /** 启动一个去令牌化子进程并等它退出（输出经文件描述符重定向读回） */
  async launch({ command, args = [], cwd, env, timeoutMs = 12e4 }) {
    if (!this.artifacts?.injectorPath || !this.artifacts?.dllPath) {
      throw fail("TS_UNAVAILABLE", "transparent launcher has no injector/DLL (fail-closed; refusing to run unconfined)");
    }
    const captureDir = resolve2(this.captureDir || cwd || tmpdir2());
    mkdirSync3(captureDir, { recursive: true });
    const reportPath = join6(captureDir, `.winstage-inject-${randomUUID3().slice(0, 6)}.json`);
    const argv = ["--dll", this.artifacts.dllPath, "--report", reportPath, "--", command, ...args];
    const started = Date.now();
    const outcome = await this.spawn(this.artifacts.injectorPath, argv, {
      cwd,
      env: { ...this.env, ...env ?? {} },
      timeoutMs,
      captureDir
    });
    this.tracked.delete(outcome.pid);
    let report;
    try {
      report = existsSync3(reportPath) ? JSON.parse(readFileSync3(reportPath, "utf8")) : void 0;
    } catch {
      report = void 0;
    }
    try {
      unlinkSync2(reportPath);
    } catch {
    }
    this.lastLaunch = {
      pid: outcome.pid,
      injectorExit: outcome.code,
      timedOut: outcome.timedOut,
      injectionReport: report,
      durationMs: Date.now() - started,
      dllPath: this.artifacts.dllPath,
      injectorPath: this.artifacts.injectorPath,
      streamsKind: "file-descriptor-redirect (no named pipes)",
      jobAssigned: false
    };
    if (outcome.code === SHIM_INJECT_FAILURE_EXIT || report?.ok === false) {
      throw fail(
        "TS_INJECTION_FAILED",
        `winstage-inject.exe refused to start the child (exit ${outcome.code}, report.ok=${report?.ok}): ${report?.error ?? outcome.err.slice(0, 300)} \u2014 refusing to continue unconfined (fail-closed)`
      );
    }
    return {
      pid: outcome.pid,
      exitCode: outcome.code,
      timedOut: outcome.timedOut,
      stdout: outcome.out,
      stderr: outcome.err,
      injectionReport: report
    };
  }
  /** 回收：杀掉仍被跟踪的注入器进程树（尽力而为，失败如实返回） */
  terminateAll(exitCode = 1) {
    const failures = [];
    for (const pid of [...this.tracked]) {
      const killed = killProcessTree(pid);
      this.tracked.delete(pid);
      if (!killed.ok) failures.push(`${pid}: ${killed.detail}`);
    }
    return failures;
  }
  dispose() {
    return this.terminateAll();
  }
};
async function spawnCapturedAsync(file, args, options = {}) {
  const captureDir = options.captureDir || options.cwd || tmpdir2();
  mkdirSync3(captureDir, { recursive: true });
  const stamp = `${Date.now().toString(36)}-${randomUUID3().slice(0, 6)}`;
  const outPath = join6(captureDir, `.winstage-run-${stamp}.out`);
  const errPath = join6(captureDir, `.winstage-run-${stamp}.err`);
  const outFd = openSync2(outPath, "w");
  const errFd = openSync2(errPath, "w");
  let child;
  try {
    child = spawnChildProcess(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", outFd, errFd],
      windowsHide: false
    });
  } finally {
    closeSync2(outFd);
    closeSync2(errFd);
  }
  const pid = child.pid;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(pid);
  }, options.timeoutMs ?? 12e4);
  if (typeof timer.unref === "function") timer.unref();
  const settled = await new Promise((resolve3) => {
    child.once("error", (error) => resolve3({ code: null, signal: null, failure: error.message }));
    child.once("exit", (code, signal) => resolve3({ code, signal }));
  });
  clearTimeout(timer);
  const out = readTextFile2(outPath);
  const err = readTextFile2(errPath);
  for (const path of [outPath, errPath]) {
    try {
      unlinkSync2(path);
    } catch {
    }
  }
  return { pid, code: settled.code, signal: settled.signal, timedOut, error: settled.failure, out, err };
}
function findFileUnder(root, name, depth = 0) {
  if (depth > 12) return void 0;
  let entries = [];
  try {
    entries = readdirSync3(root, { withFileTypes: true });
  } catch {
    return void 0;
  }
  for (const entry of entries) {
    const full = join6(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findFileUnder(full, name, depth + 1);
      if (nested) return nested;
      continue;
    }
    if (entry.name === name) return full;
  }
  return void 0;
}
function readTextFile2(path) {
  try {
    return existsSync3(path) ? readFileSync3(path, "utf8") : "";
  } catch {
    return "";
  }
}
function parseJsonMaybe(value) {
  if (value === null || value === void 0) return void 0;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return void 0;
  try {
    return JSON.parse(value);
  } catch {
    return void 0;
  }
}
function killProcessTree(pid) {
  if (typeof pid !== "number" || pid <= 0) return { ok: false, detail: "invalid pid" };
  try {
    const result = spawnSyncChildProcess("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return { ok: result.status === 0, detail: `taskkill exit=${result.status}` };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}
function selectLaunchMode(requested, probe) {
  const want = String(requested ?? "T1").toUpperCase();
  if (want === "T0") return { mode: "appcontainer", tierEffective: "T0", fallbackReason: void 0 };
  if (want === TRANSPARENT_TIER || want === "AUTO") {
    if (probe?.available === true) {
      return { mode: "shim", tierEffective: TRANSPARENT_TIER, fallbackReason: void 0 };
    }
    const reason = probe?.reason ?? "not probed";
    return {
      mode: "restricted-token",
      tierEffective: "T1",
      fallbackReason: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*:/.test(reason) ? `${reason} \u2014 fail-closed fallback to the restricted-token mode` : `transparent shim unavailable (${reason}) \u2014 fail-closed fallback to the restricted-token mode`
    };
  }
  return { mode: "restricted-token", tierEffective: want || "T1", fallbackReason: void 0 };
}

// src/workspace.ts
var SandboxError = class extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
    this.detail = detail;
  }
};
function classifyEntry(item, dirent) {
  if (dirent && typeof dirent.isSymbolicLink === "function" && dirent.isSymbolicLink()) return "reparse-point";
  try {
    const info = lstatSync2(item);
    if (info.isSymbolicLink()) return "reparse-point";
    if (info.isDirectory() && dirent && typeof dirent.isDirectory === "function" && dirent.isDirectory() === false) {
      return "reparse-point";
    }
    return void 0;
  } catch (error) {
    return `unreadable:${error.code ?? "ERR"}`;
  }
}
var WALK_MAX_DEPTH = 64;
var WHITEOUT_LEAF = "wo";
function logicalFromWhiteoutMarker(woRoot, markerPath) {
  const rel = relative2(woRoot, markerPath);
  if (!rel || rel.startsWith("..")) return void 0;
  const parts = rel.split(sep5).filter((part) => part !== "");
  if (parts.length < 2) return void 0;
  if (parts[0].toLowerCase() === "_unc") {
    if (parts.length < 3) return void 0;
    return `\\\\${parts.slice(1).join(sep5)}`;
  }
  if (!/^[a-zA-Z]$/.test(parts[0])) return void 0;
  return `${parts[0].toUpperCase()}:${sep5}${parts.slice(1).join(sep5)}`;
}
function walkStagedForHashes(stagedDir) {
  const hashes = /* @__PURE__ */ new Map();
  const realPaths = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  const whiteouts = /* @__PURE__ */ new Map();
  const skippedReparsePoints = [];
  const skipped = [];
  const record = (path, reason) => {
    skipped.push({ path, reason });
    if (reason === "reparse-point") skippedReparsePoints.push(path);
  };
  const identityOf = (dir) => {
    try {
      return realpathSync3.native(dir).toLowerCase();
    } catch {
      return normalize5(dir).toLowerCase();
    }
  };
  const walkWhiteouts = (woRoot, dir, ancestors, depth) => {
    if (depth > WALK_MAX_DEPTH) {
      record(dir, "depth-limit");
      return;
    }
    const key = identityOf(dir);
    if (ancestors.has(key)) {
      record(dir, "cycle-detected");
      return;
    }
    let entries;
    try {
      entries = readdirSync4(dir, { withFileTypes: true });
    } catch (error) {
      record(dir, `unreadable:${error.code ?? "ERR"}`);
      return;
    }
    ancestors.add(key);
    try {
      for (const dirent of entries) {
        const item = join7(dir, dirent.name);
        const reason = classifyEntry(item, dirent);
        if (reason !== void 0) {
          seen.add(item);
          record(item, reason);
          continue;
        }
        if (dirent.isDirectory()) {
          walkWhiteouts(woRoot, item, ancestors, depth + 1);
          continue;
        }
        const logical = logicalFromWhiteoutMarker(woRoot, item);
        if (logical === void 0) {
          record(item, "whiteout-unmappable");
          continue;
        }
        whiteouts.set(compareKey(logical), logical);
      }
    } finally {
      ancestors.delete(key);
    }
  };
  const walk = (dir, ancestors, depth) => {
    if (depth > WALK_MAX_DEPTH) {
      record(dir, "depth-limit");
      return;
    }
    const key = identityOf(dir);
    if (ancestors.has(key)) {
      record(dir, "cycle-detected");
      return;
    }
    let entries;
    try {
      entries = readdirSync4(dir, { withFileTypes: true });
    } catch (error) {
      record(dir, `unreadable:${error.code ?? "ERR"}`);
      return;
    }
    ancestors.add(key);
    try {
      for (const dirent of entries) {
        const item = join7(dir, dirent.name);
        const reason = classifyEntry(item, dirent);
        if (reason !== void 0) {
          seen.add(item);
          record(item, reason);
          continue;
        }
        if (dirent.isDirectory()) {
          if (depth === 0 && dirent.name.toLowerCase() === WHITEOUT_LEAF) {
            seen.add(item);
            walkWhiteouts(item, item, ancestors, 0);
            continue;
          }
          walk(item, ancestors, depth + 1);
          continue;
        }
        seen.add(item);
        const rel = relative2(stagedDir, item);
        hashes.set(rel, hashFile(item));
        realPaths.set(rel, rel);
      }
    } finally {
      ancestors.delete(key);
    }
  };
  if (existsSync4(stagedDir)) walk(stagedDir, /* @__PURE__ */ new Set(), 0);
  return { hashes, realPaths, seen, whiteouts, skippedReparsePoints, skipped };
}
function driftReasonOf(expected, found) {
  if (expected === found) return null;
  if (expected === hashAbsent()) return "baseline-appeared";
  if (found === hashAbsent()) return "baseline-deleted";
  return "baseline-drifted";
}
function hostFileFingerprint(abs) {
  try {
    const info = statSync4(abs);
    if (!info.isFile()) return void 0;
    return { sha256: hashFile(abs), size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return void 0;
  }
}
function baselineConflictOf(expectedFingerprint, foundFingerprint) {
  if (!expectedFingerprint || typeof expectedFingerprint.sha256 !== "string") return null;
  const changed = [];
  if (!foundFingerprint) {
    return { code: "host-file-missing", expected: expectedFingerprint, found: null, changed: ["exists"] };
  }
  if (expectedFingerprint.sha256 !== foundFingerprint.sha256) changed.push("sha256");
  if (expectedFingerprint.size !== void 0 && foundFingerprint.size !== expectedFingerprint.size) changed.push("size");
  if (expectedFingerprint.mtimeMs !== void 0 && foundFingerprint.mtimeMs !== void 0 && Math.abs(foundFingerprint.mtimeMs - expectedFingerprint.mtimeMs) > 1) {
    changed.push("mtime");
  }
  const contentChanged = changed.some((key) => key === "sha256" || key === "size");
  if (!contentChanged) return null;
  return { code: "host-file-modified", expected: expectedFingerprint, found: foundFingerprint, changed };
}
function writeFileAtomicReplacing(target, content) {
  const dir = dirname5(target);
  mkdirSync4(dir, { recursive: true });
  const tmp = join7(dir, `.${randomUUID4()}.stage-tmp`);
  writeFileSync5(tmp, content);
  try {
    try {
      renameSync2(tmp, target);
      return { strategy: "rename", bytes: content.length };
    } catch (renameError) {
      if (!existsSync4(target)) {
        throw renameError;
      }
      rmSync4(target, { force: true });
      renameSync2(tmp, target);
      return { strategy: "replace", bytes: content.length };
    }
  } catch (error) {
    cleanupTemp(tmp);
    throw error;
  }
}
function cleanupTemp(path) {
  try {
    unlinkSync3(path);
  } catch {
  }
}
function statKind(path) {
  try {
    const info = lstatSync2(path);
    if (info.isSymbolicLink()) {
      try {
        const target = statSync4(path);
        return { kind: target.isDirectory() ? "dir" : "file", symlink: true };
      } catch {
        return { kind: "dangling", symlink: true };
      }
    }
    if (info.isDirectory()) return { kind: "dir", symlink: false };
    return { kind: "file", symlink: false };
  } catch {
    return void 0;
  }
}
var Workspace = class {
  /**
   * @param {{workspaceRoot: string, sessionId?: string, ownerToken?: string, masks?: Array<{id?:string,pattern:RegExp,reason?:string,hard?:boolean}>}} options
   */
  constructor(options) {
    if (!options?.workspaceRoot) throw new SandboxError("WORKSPACE_REQUIRED", "workspaceRoot is required");
    this.root = canonical(options.workspaceRoot);
    this.store = new Store(this.root, options);
    this.sessionId = options.sessionId;
    this.extraMasks = options.masks || [];
    this.maskEnforcement = true;
  }
  /** 启动：恢复持久状态，再重建投影（手册 13.1） */
  init(meta = {}) {
    this.store.ensureLayout();
    this.manifest = this.store.manifest({ sessionId: this.sessionId, ...meta });
    this.sessionId = this.manifest.sessionId;
    this.queue = this.store.loadQueue();
    this.corruption = this.verifyProjection();
    return this;
  }
  /**
   * 校验投影完整性：记录声明文件存在而存储对象缺失 → 损坏，禁止发布（3.1）。
   * 绝不把"暂存副本意外丢失"解释为用户删除。
   *
   * ── 目录条目不得走 blob 分支（缺陷 D10）──────────────────────────────────────
   * 目录条目（含 `synthesizeParents()` 合成的父目录，以及 `createDirectory()` 建的目录）
   * 天生 `stagedHash === hashAbsent()`：目录**不是**内容对象，没有 blob 是**正确状态**。
   * 初版第一分支缺少 `entry.kind !== 'dir'` 守卫，于是健康工作区被报成
   * "损坏项 N 个（禁止发布）"，例如 `corruption:[{path:"seed",reason:"staged blob missing"}]`
   * （原始证据 `.t\sbx3\t-fs\out\cli-init-healthy.json`）。
   * 第二分支本来就有同类守卫（见下），两处必须同口径：
   *   - 文件：blob 缺失 = 损坏；blob 在但暂存树物化缺失 = 损坏
   *   - 目录：不查 blob，只查"是否有东西被声称物化了却没有"（合成目录允许不存在）
   */
  verifyProjection() {
    const corrupt = [];
    for (const [rel, entry] of Object.entries(this.manifest.entries)) {
      if (entry.state === STATE.DELETED) continue;
      if (entry.kind === "dir") {
        if (entry.synthetic === true) continue;
        if (entry.stagedHash !== hashAbsent() && !this.store.hasBlob(entry.stagedHash)) {
          corrupt.push({ path: rel, reason: "staged blob missing", state: STATE.CORRUPT });
        }
        continue;
      }
      const okBlob = entry.stagedHash === hashAbsent() ? false : this.store.hasBlob(entry.stagedHash);
      const materialized = existsSync4(this.store.stagedPath(rel));
      if (!okBlob && entry.state === STATE.FILE) {
        corrupt.push({ path: rel, reason: "staged blob missing", state: STATE.CORRUPT });
      } else if (!materialized && entry.state === STATE.FILE && entry.kind !== "dir") {
        corrupt.push({ path: rel, reason: "staged tree object missing", state: STATE.CORRUPT });
      }
    }
    return corrupt;
  }
  // ==================== 遮蔽 ====================
  /**
   * 遮蔽判定：**先规范化，再判豁免**（#16.6）。
   *
   * 顺序至关重要，这里曾经写反过并被自测抓到：`isInside()` 内部会对两侧做
   * canonical()，所以"工作区内的 junction 指向宿主敏感目录"这类绕过会被
   * 误判为"在工作区内"而获得豁免。正确顺序是：
   *   1. 先 canonical() 得到链接解析后的真实路径；
   *   2. 只有**解析后仍在工作区内**才谈豁免（豁免必须限定作用域，#16.8）；
   *   3. 解析后落到工作区外的（含 junction/符号链接逃逸）一律走硬拒绝表。
   * 反例：仓库位于被遮蔽目录之下时，项目文件解析后仍在工作区内 → 不误伤。
   */
  maskOf(absolutePath) {
    const resolved = canonical(absolutePath);
    const storeDir = this.store?.dir;
    if (storeDir && isInside(storeDir, resolved)) {
      return { id: "stage-store", reason: "\u672C\u5DE5\u5177\u81EA\u8EAB\u5B58\u50A8\uFF08unmask \u6C38\u4E0D\u89E3\u9664\uFF1B\u76EE\u5F55\u81EA\u8EAB\u4E0E\u5176\u4E0B\u6240\u6709\u6587\u4EF6\uFF09", hard: true };
    }
    if (isInside(this.root, resolved)) {
      const rel = relative2(this.root, resolved);
      if (!/^\.?dshstage([\\/]|$)/i.test(rel)) return void 0;
    }
    return maskReason(resolved, this.extraMasks);
  }
  /** 硬检查必须能被所有工具路径命中，不能只挂在 read 上（#16.7 / A72） */
  assertReadable(absolutePath) {
    if (!this.maskEnforcement) return;
    const mask = this.maskOf(absolutePath);
    if (mask) {
      throw new SandboxError("SANDBOX_PATH_MASKED", `reading ${absolutePath} is denied by mask "${mask.id}": ${mask.reason}`, {
        maskId: mask.id,
        reason: mask.reason,
        path: absolutePath
      });
    }
  }
  // ==================== 路径 ====================
  /**
   * 逻辑路径 → 工作区相对路径（**词法**判定，不解析链接）。
   *
   * 为什么用词法而不是 canonical：工作区内的 junction 可以解析到工作区外，
   * 若此处按 canonical 判定就会抛错，导致遮蔽表根本没有机会给出
   * SANDBOX_PATH_MASKED（手册 #16.7 硬边界先于可协商项）。
   * 因此：词法在外 → 抛错；词法在内、解析后逃逸 → 返回相对路径，
   * 交给 maskOf() 判定为遮蔽不可见。
   */
  relative(target) {
    const rel = lexicalInside(this.root, target);
    if (rel === void 0) {
      const error = new SandboxError("PATH_OUTSIDE_WORKSPACE", `path escapes workspace: ${target}`, {
        workspaceRoot: this.root,
        target: lexical(target)
      });
      throw error;
    }
    return rel;
  }
  /**
   * 逻辑路径 → **清单键**（S3a：工作区外条目底座）。
   *
   *   - 词法在工作区内 → `{ key: <相对路径>, external: false }`（与 `relative()` 同一口径）
   *   - 词法在工作区外 → `{ key: <规范化绝对路径>, external: true }`
   *
   * 为什么键用**规范化绝对路径**而不是 `..\..` 相对路径：相对路径在暂存树里会产生
   * 语义歧义（`..` 既可能是"用户写的相对路径"也可能是"越界逃逸"），而绝对路径与
   * 工作区内相对路径的键空间天然不相交 —— `entryOf()` 因此对两种条目是同一个查找。
   *
   * 与 `relative()` 的关系：`relative()` **保持原样**（工作区外仍抛
   * PATH_OUTSIDE_WORKSPACE），因为它是"这个路径必须工作区内"的断言式入口，
   * 已被读取工具与既有测试依赖；`keyOf()` 是新增的双键空间入口，两者不互相改变语义。
   */
  keyOf(target) {
    const rel = lexicalInside(this.root, target);
    if (rel !== void 0) return { key: rel, external: false, abs: rel === "" ? this.root : this.store.realPath(rel) };
    const abs = canonical(target);
    return { key: abs, external: true, abs };
  }
  /** 相对路径 → 真实绝对路径 */
  absolute(rel) {
    return this.store.realPath(rel);
  }
  /** 相对路径 → 暂存绝对路径（保留 basename，供语言识别，见 #3.9） */
  staged(rel) {
    return this.store.stagedPath(rel);
  }
  entryOf(rel) {
    return this.manifest.entries[rel];
  }
  /**
   * **以真实文件为基线重新暂存**（`/winstage rebase` 的落地动作）。
   *
   * 暂存条目是"相对某个基线的 diff"。基线一旦被外部改动（shell / 另一个进程 /
   * 编辑器），`applyOneChange()` 会以 `STALE_BASELINE` 拒绝落盘（手册 #12.1，
   * 不能静默覆盖），而面板上的 diff 还停在旧基线 ⇒ "视图与现实不一致、批准必然失败"。
   * 本方法把 `baseHash/baseKind` 换成磁盘当前值，**不改 `stagedHash`、不改 `state`**
   * —— 这是重述基线，不是强制覆盖：
   *   - 真实内容 ≠ 暂存内容 ⇒ 变成一条**可批准的**新 diff（before 现在是真实内容）；
   *   - 真实内容 == 暂存内容 ⇒ 无净变化，条目自动退出视图（连批准都不需要）。
   * @returns {boolean} 是否找到并更新了条目
   */
  rebaseEntry(rel) {
    const entry = this.entryOf(rel);
    if (!entry) return false;
    const abs = this.absolute(rel);
    const info = statKind(abs);
    const baseHash = info && info.kind === "file" ? hashFile(abs) : hashAbsent();
    if (baseHash !== hashAbsent()) this.store.putBlob(readFileSync4(abs));
    entry.baseHash = baseHash;
    entry.baseKind = info?.kind;
    entry.baseFingerprint = info?.kind === "file" ? hostFileFingerprint(abs) : void 0;
    entry.baseRevision = this.manifest.revision;
    entry.changed = entry.state === STATE.DELETED ? true : entry.stagedHash !== entry.baseHash;
    entry.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    return true;
  }
  /**
   * 该条目的真实基线是否已经偏离**清单记录**（外部改动）。
   *
   * 判据与 `applyOneChange()` 的 `STALE_BASELINE` 检查**同源**：只比 hash
   * （`before.hash` 对 absent 的条目同样用 `hashAbsent()`），因此"面板说没 stale"
   * 与"批准会成功"不会互相矛盾。
   * @returns {{stale: boolean, expected: string, found: string}}
   */
  baselineDrift(rel) {
    const entry = this.entryOf(rel);
    if (!entry) return { stale: false, expected: hashAbsent(), found: hashAbsent(), reason: null };
    const info = statKind(this.absolute(rel));
    const found = info && info.kind === "file" ? hashFile(this.absolute(rel)) : hashAbsent();
    const expected = entry.baseHash ?? hashAbsent();
    return { stale: found !== expected, expected, found, reason: driftReasonOf(expected, found) };
  }
  // ==================== 读取面 ====================
  /**
   * 存在性：必须区分文件与目录（#3.1）。
   *
   * 注意这里用**词法边界**判定而不是 canonical：
   * 工作区内的 junction 若解析到工作区外，`relative()` 会抛 PATH_OUTSIDE_WORKSPACE，
   * 而存在性查询不应该以异常表达"不可见"。词法上在工作区内、解析后逃逸的路径，
   * 统一走遮蔽/不可见语义（#16.6），从而与 read 的硬拒绝保持一致而不崩溃。
   */
  exists(target, opts = {}) {
    const lexicalRel = lexicalInside(this.root, target);
    if (lexicalRel === void 0) {
      const key = canonical(target);
      const entry2 = this.entryOf(key);
      if (entry2) {
        if (entry2.state === STATE.DELETED) return { exists: false, kind: entry2.kind, source: "deleted", external: true };
        if (entry2.state === STATE.CORRUPT) {
          throw new SandboxError("WORKSPACE_CORRUPT", `staged object for ${key} is missing; refusing to fall back to the real disk`, {
            path: key
          });
        }
        return { exists: true, kind: entry2.kind === "dir" ? "dir" : "file", source: "staged", external: true };
      }
      if (this.hasStagedDescendant(key)) return { exists: true, kind: "dir", source: "synthetic", external: true };
      if (!opts.skipMaskCheck) {
        const mask = this.maskOf(target);
        if (mask) return { exists: false, kind: void 0, source: "masked", maskId: mask.id, external: true };
      }
      const outsideInfo = statKind(key);
      if (!outsideInfo) return { exists: false, source: "outside", external: true };
      return { exists: true, kind: outsideInfo.kind === "dir" ? "dir" : "file", source: "baseline", external: true };
    }
    const rel = lexicalRel;
    if (rel === "") return { exists: true, kind: "dir", source: "baseline" };
    const entry = this.entryOf(rel);
    if (entry) {
      if (entry.state === STATE.DELETED) return { exists: false, kind: entry.kind, source: "deleted" };
      if (entry.state === STATE.CORRUPT) {
        throw new SandboxError("WORKSPACE_CORRUPT", `staged object for ${rel} is missing; refusing to fall back to the real disk`, {
          path: rel
        });
      }
      return { exists: true, kind: entry.kind === "dir" ? "dir" : "file", source: "staged" };
    }
    if (this.hasStagedDescendant(rel)) return { exists: true, kind: "dir", source: "synthetic" };
    const abs = this.absolute(rel);
    if (!opts.skipMaskCheck) {
      const mask = this.maskOf(abs);
      if (mask) {
        return { exists: false, kind: void 0, source: "masked", maskId: mask.id };
      }
    }
    const info = statKind(abs);
    if (!info) return { exists: false };
    return { exists: true, kind: info.kind === "dir" ? "dir" : "file", source: "baseline" };
  }
  /**
   * 暂存树里是否有该键的**后代**。
   *
   * S3a 追加两条约束：
   *   1. 键空间不混：相对键只看工作区内条目，绝对键只看外部条目。否则
   *      `C:\out` 会被当成工作区根的"后代"而污染根枚举（这正是必须防的错）。
   *   2. `rel === ''`（工作区根）不再走 `compareKey('')` —— 那个调用会抛 TypeError
   *      （`lexical()` 拒绝空串）。根的语义就是"是否有任何工作区内条目"。
   */
  hasStagedDescendant(rel) {
    const external = isExternalKey(rel);
    if (rel === "") {
      return Object.values(this.manifest.entries).some((entry) => entry.external !== true);
    }
    const prefix = compareKey(rel) + sep5.toLowerCase();
    for (const [key, entry] of Object.entries(this.manifest.entries)) {
      if (entry.external === true !== external) continue;
      if (compareKey(key).startsWith(prefix)) return true;
    }
    return false;
  }
  readFile(target) {
    const { key: rel } = this.keyOf(target);
    const entry = this.entryOf(rel);
    if (entry) {
      if (entry.state === STATE.DELETED) {
        throw new SandboxError("ENOENT", `${target} does not exist in the workspace view (deleted)`, { path: rel });
      }
      if (entry.kind === "dir") {
        throw new SandboxError("EISDIR", `${target} is a directory`, { path: rel });
      }
      if (!this.store.hasBlob(entry.stagedHash)) {
        throw new SandboxError("WORKSPACE_CORRUPT", `staged content for ${target} is missing; refusing to read the real disk`, {
          path: rel
        });
      }
      return this.store.readBlob(entry.stagedHash);
    }
    const abs = this.absolute(rel);
    this.assertReadable(abs);
    if (!existsSync4(abs)) throw new SandboxError("ENOENT", `${target} does not exist`, { path: rel });
    if (statKind(abs)?.kind === "dir") throw new SandboxError("EISDIR", `${target} is a directory`, { path: rel });
    return readFileSync4(abs);
  }
  readText(target) {
    return this.readFile(target).toString("utf8");
  }
  stat(target) {
    const { key: rel } = this.keyOf(target);
    const state = this.exists(target);
    if (!state.exists) return void 0;
    if (state.source === "staged" && this.entryOf(rel)) {
      const entry = this.entryOf(rel);
      const materialized = this.staged(rel);
      const size = existsSync4(materialized) && entry.kind !== "dir" ? statSync4(materialized).size : 0;
      return { path: rel, kind: state.kind, source: "staged", size, hash: entry.stagedHash, modified: entry.updatedAt };
    }
    if (state.source === "synthetic") return { path: rel, kind: "dir", source: "synthetic", size: 0 };
    const abs = this.absolute(rel);
    const info = statSync4(abs);
    return { path: rel, kind: info.isDirectory() ? "dir" : "file", source: "baseline", size: info.size, modified: info.mtime.toISOString() };
  }
  /**
   * 目录枚举：合并基线目录与新增子项，递归合成父目录（#3.11）。
   * 返回的 path 一律是**逻辑路径**；目录项不带暂存路径（#3.2 / #3.3）。
   */
  listDir(target, opts = {}) {
    const { key: rel, external } = this.keyOf(target);
    const state = this.exists(target);
    if (!state.exists) throw new SandboxError("ENOENT", `directory ${target} does not exist`, { path: rel });
    if (state.kind !== "dir") throw new SandboxError("ENOTDIR", `${target} is not a directory`, { path: rel });
    const merged = /* @__PURE__ */ new Map();
    const abs = this.absolute(rel);
    if (existsSync4(abs)) {
      for (const name of readdirSync4(abs)) {
        const childRel = rel === "" ? name : join7(rel, name);
        const childAbs = this.absolute(childRel);
        const info = statKind(childAbs);
        const source = info?.kind === "dir" ? "dir" : "file";
        merged.set(compareKey(childRel), {
          path: childRel,
          name,
          kind: source,
          origin: "baseline",
          symlink: info?.symlink === true,
          masked: this.maskOf(childAbs) !== void 0
        });
      }
    }
    const prefix = rel === "" ? "" : compareKey(rel) + sep5.toLowerCase();
    for (const [key, entry] of Object.entries(this.manifest.entries)) {
      if (entry.external === true !== external) continue;
      const ckey = compareKey(key);
      if (rel === "") {
        if (!ckey.includes(sep5.toLowerCase())) {
          this.applyEntryToMerge(merged, key, entry, key);
        } else {
          const head = key.slice(0, key.search(/[\\/]/));
          this.applyEntryToMerge(merged, head, { kind: "dir", state: entry.state === STATE.DELETED ? STATE.FILE : entry.state }, head, "synthetic");
        }
      } else if (ckey.startsWith(prefix)) {
        const rest = key.slice(rel.length + 1);
        const head = rest.split(/[\\/]/)[0];
        const childRel = join7(rel, head);
        const isDirect = !rest.slice(head.length).match(/[\\/]/);
        this.applyEntryToMerge(merged, childRel, isDirect ? entry : { kind: "dir", state: STATE.FILE }, childRel, isDirect ? void 0 : "synthetic");
      }
    }
    for (const [key, entry] of Object.entries(this.manifest.entries)) {
      if (entry.state !== STATE.DELETED) continue;
      if (entry.external === true !== external) continue;
      const ckey = compareKey(key);
      if (rel === "") {
        if (!ckey.includes(sep5.toLowerCase())) merged.delete(ckey);
        else {
          const head = key.slice(0, key.search(/[\\/]/));
          if (compareKey(head) === ckey) merged.delete(compareKey(head));
        }
      } else if (ckey.startsWith(prefix)) {
        const rest = key.slice(rel.length + 1);
        if (!rest.match(/[\\/]/)) merged.delete(ckey);
      }
    }
    let items = [...merged.values()];
    if (!opts.includeMasked) items = items.filter((item) => !item.masked);
    items = stableSort(items.map((i) => i.path)).map((p) => merged.get(compareKey(p)));
    if (opts.recursive) {
      const out = [];
      for (const item of items) {
        out.push(item);
        if (item.kind === "dir") {
          try {
            out.push(...this.listDir(this.absolute(item.path), { recursive: true, includeMasked: opts.includeMasked }));
          } catch {
          }
        }
      }
      return out;
    }
    return items;
  }
  applyEntryToMerge(merged, path, entry, origin, forcedKind) {
    const key = compareKey(path);
    if (entry.state === STATE.DELETED) {
      merged.delete(key);
      return;
    }
    const kind = forcedKind || (entry.kind === "dir" ? "dir" : "file");
    merged.set(key, {
      path,
      name: path.split(/[\\/]/).pop(),
      kind,
      origin: origin || (entry.kind === "dir" ? "staged" : "staged"),
      symlink: false,
      masked: false
    });
  }
  /**
   * 搜索：跨基线与暂存，删除标记不可见（#3.6 同一工作区所有读者看到同一版本）。
   */
  search(pattern, opts = {}) {
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, opts.flags || "i");
    const limit = opts.limit ?? 500;
    const matches = [];
    const walk = (rel) => {
      if (matches.length >= limit) return;
      let items;
      try {
        items = this.listDir(this.absolute(rel), { includeMasked: false });
      } catch {
        return;
      }
      for (const item of items) {
        if (matches.length >= limit) return;
        if (item.masked) continue;
        if (opts.glob && !globMatch(opts.glob, item.name)) {
          if (item.kind === "dir") walk(item.path);
          continue;
        }
        if (item.kind === "file") {
          let text;
          try {
            text = this.readText(this.absolute(item.path));
          } catch {
            continue;
          }
          if (text.includes("\0")) continue;
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i += 1) {
            if (regex.test(lines[i])) {
              matches.push({ path: item.path, line: i + 1, text: lines[i], origin: item.origin });
              if (matches.length >= limit) return;
            }
          }
        } else {
          walk(item.path);
        }
      }
    };
    walk("");
    return matches;
  }
  // ==================== 变更面 ====================
  ensureEntry(rel, opts = {}) {
    const existing = this.entryOf(rel);
    if (existing && existing.state !== STATE.DELETED) {
      if (opts.kind && existing.kind !== opts.kind && existing.kind !== "dir") {
        existing.kind = opts.kind;
      }
      if (opts.refreshBaseline !== false) {
        const absNow = this.absolute(rel);
        const infoNow = statKind(absNow);
        const baseNow = infoNow && infoNow.kind === "file" ? hashFile(absNow) : hashAbsent();
        if (baseNow !== existing.baseHash) {
          if (baseNow !== hashAbsent()) this.store.putBlob(readFileSync4(absNow));
          existing.baseHash = baseNow;
          existing.baseKind = infoNow?.kind;
          existing.baseFingerprint = infoNow?.kind === "file" ? hostFileFingerprint(absNow) : void 0;
          existing.baseRevision = this.manifest.revision;
          existing.baselineRefreshedAt = (/* @__PURE__ */ new Date()).toISOString();
        }
        existing.changed = existing.stagedHash !== existing.baseHash;
      }
      return existing;
    }
    const abs = this.absolute(rel);
    const info = statKind(abs);
    const baseHash = info && info.kind === "file" ? hashFile(abs) : hashAbsent();
    if (baseHash !== hashAbsent()) this.store.putBlob(readFileSync4(abs));
    const entry = {
      path: rel,
      kind: info?.kind === "dir" ? "dir" : opts.kind || "file",
      state: STATE.FILE,
      baseHash,
      baseKind: info?.kind,
      // WP8.2：宿主原件基线指纹（size + mtime + sha256）—— 应用前重算，未变才替换
      ...info?.kind === "file" ? { baseFingerprint: hostFileFingerprint(abs) } : {},
      stagedHash: baseHash,
      symlink: info?.symlink === true,
      baseRevision: this.manifest.revision,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      changed: false,
      origin: opts.origin || "tool",
      // 工作区**外**条目的显式标记（键就是规范化绝对路径，见 keyOf 的说明）。
      // 工作区内条目**不写这个字段**：保持既有清单形态逐字不变（可回归对照）。
      ...isExternalKey(rel) ? { external: true, absPath: abs } : {}
    };
    this.manifest.entries[rel] = entry;
    return entry;
  }
  /**
   * 写文件：新建或复制都先建受控父目录（#3.5）。
   *
   * S3a：`target` 在工作区**外**时同样进暂存 —— 键 = 规范化绝对路径，
   * 物化对象落在 `.dshstage/staged-ext/<分桶>/<basename>`，**真实磁盘一位不改**
   * （落盘只能经 applyCandidate，见 :applyOneChange）。
   */
  writeFile(target, content, opts = {}) {
    const { key: rel, external } = this.keyOf(target);
    if (rel === "") throw new SandboxError("EISDIR", "cannot write the workspace root");
    const entry = this.ensureEntry(rel, { kind: "file", origin: opts.origin });
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    const hash = this.store.putBlob(buffer);
    const stagedPath = this.staged(rel);
    mkdirSync4(dirname5(stagedPath), { recursive: true });
    writeFileSync5(stagedPath, buffer);
    entry.kind = "file";
    entry.state = STATE.FILE;
    entry.stagedHash = hash;
    entry.size = buffer.length;
    entry.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    entry.changed = hash !== entry.baseHash;
    if (!external) this.synthesizeParents(rel);
    this.store.touch(this.manifest);
    return { path: rel, hash, bytes: buffer.length, changed: entry.changed };
  }
  editText(target, edit, opts = {}) {
    const current = this.exists(target);
    const before = current.exists && current.kind === "file" ? this.readText(target) : void 0;
    const next = applyEdit(before, edit);
    const result = this.writeFile(target, next, opts);
    return { ...result, previousHash: before === void 0 ? hashAbsent() : sha256Buffer(Buffer.from(before, "utf8")) };
  }
  /** 删除：持久化删除标记，而不是"尽力而为"（#3.7 / 第 7 章）——工作区外同样只留墓碑 */
  remove(target, opts = {}) {
    const { key: rel, external } = this.keyOf(target);
    if (rel === "") throw new SandboxError("EPERM", "refusing to delete the workspace root");
    const state = this.exists(target);
    if (!state.exists && !opts.missingOk) {
      const entry2 = this.entryOf(rel);
      if (entry2?.state === STATE.DELETED) return { path: rel, deleted: true, idempotent: true };
      throw new SandboxError("ENOENT", `${target} does not exist`, { path: rel });
    }
    const entry = this.ensureEntry(rel, { origin: opts.origin });
    entry.state = STATE.DELETED;
    entry.deletedAt = (/* @__PURE__ */ new Date()).toISOString();
    entry.updatedAt = entry.deletedAt;
    entry.changed = true;
    delete entry.stagedHash;
    const stagedPath = this.staged(rel);
    if (existsSync4(stagedPath)) {
      const repair = makeRemovable(stagedPath);
      try {
        rmSync4(stagedPath, { recursive: true, force: true });
      } catch (error) {
        entry.cleanupFailure = { code: error.code, message: error.message, repaired: repair.repaired };
      }
    }
    if (!external) this.synthesizeParents(rel);
    this.store.touch(this.manifest);
    return { path: rel, deleted: true, wasKind: state.kind };
  }
  createDirectory(target, opts = {}) {
    const { key: rel, external } = this.keyOf(target);
    if (rel === "") return { path: rel, created: false, reason: "root" };
    const state = this.exists(target);
    if (state.exists) {
      if (state.kind === "dir") return { path: rel, created: false, idempotent: true };
      throw new SandboxError("EEXIST", `${target} exists as a file`, { path: rel });
    }
    const entry = this.ensureEntry(rel, { kind: "dir", origin: opts.origin });
    entry.kind = "dir";
    entry.state = STATE.FILE;
    entry.stagedHash = hashAbsent();
    entry.changed = entry.baseKind !== "dir";
    mkdirSync4(this.staged(rel), { recursive: true });
    if (!external) this.synthesizeParents(rel);
    this.store.touch(this.manifest);
    return { path: rel, created: true };
  }
  rename(from, to, opts = {}) {
    const { key: fromRel } = this.keyOf(from);
    const { key: toRel } = this.keyOf(to);
    const state = this.exists(from);
    if (!state.exists) throw new SandboxError("ENOENT", `${from} does not exist`, { path: fromRel });
    if (state.kind === "file") {
      const content = this.readFile(from);
      this.remove(from, { missingOk: true, origin: opts.origin });
      this.writeFile(to, content, opts);
    } else {
      for (const item of this.listDir(from, { recursive: true })) {
        const childFrom = item.path;
        const childTo = join7(toRel, relative2(fromRel, childFrom));
        if (item.kind === "file") {
          const content = this.readFile(this.absolute(childFrom));
          this.remove(this.absolute(childFrom), { missingOk: true });
          this.writeFile(this.absolute(childTo), content, opts);
        } else {
          this.createDirectory(this.absolute(childTo), opts);
        }
      }
      this.remove(from, { missingOk: true, origin: opts.origin });
    }
    if (!isExternalKey(toRel)) this.synthesizeParents(toRel);
    this.store.touch(this.manifest);
    return { from: fromRel, to: toRel };
  }
  /** 递归补齐各级父目录，使目录树在逻辑视图里自洽（#3.11） */
  synthesizeParents(rel) {
    if (isExternalKey(rel)) return;
    const parts = segments(rel);
    parts.pop();
    let cursor = "";
    for (const part of parts) {
      cursor = cursor === "" ? part : join7(cursor, part);
      const entry = this.entryOf(cursor);
      if (entry && entry.state !== STATE.DELETED) continue;
      const abs = this.absolute(cursor);
      const info = statKind(abs);
      this.manifest.entries[cursor] = {
        path: cursor,
        kind: "dir",
        state: STATE.FILE,
        baseHash: hashAbsent(),
        baseKind: info?.kind,
        stagedHash: hashAbsent(),
        synthetic: true,
        changed: info?.kind !== "dir",
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        origin: "synthetic"
      };
    }
  }
  // ==================== 差异与候选 ====================
  /**
   * 净变化清单。无净变化返回空数组 → 调用方不得入队（#12.1）。
   *
   * S3a：工作区**外**条目的 `path` 就是它的**规范化绝对路径**（键即路径），
   * 并额外带 `external: true`；工作区内条目**不多写任何字段**（保持既有候选 JSON 逐字不变）。
   * 判级（三档）由第二阶段按 `change.path` + `change.external` 做，本层不改分级语义。
   */
  diffEntries() {
    const changes = [];
    for (const rel of stableSort(Object.keys(this.manifest.entries))) {
      const entry = this.manifest.entries[rel];
      const external = entry.external === true ? { external: true } : {};
      const hostFile = entry.baseFingerprint ? { hostFile: entry.baseFingerprint } : {};
      if (entry.state === STATE.DELETED) {
        if (entry.baseHash === hashAbsent() && entry.baseKind === void 0) continue;
        changes.push({
          path: rel,
          op: "delete",
          kind: entry.baseKind === "dir" ? "dir" : "file",
          before: { hash: entry.baseHash, kind: entry.baseKind, ...hostFile },
          after: { hash: hashAbsent() },
          ...external
        });
        continue;
      }
      if (entry.kind === "dir") {
        if (entry.baseKind !== "dir" && !entry.synthetic) {
          changes.push({ path: rel, op: "mkdir", kind: "dir", before: { hash: hashAbsent() }, after: { hash: hashAbsent() }, ...external });
        }
        continue;
      }
      if (entry.stagedHash === entry.baseHash) continue;
      changes.push({
        path: rel,
        op: entry.baseHash === hashAbsent() ? "create" : "modify",
        kind: "file",
        before: { hash: entry.baseHash, kind: entry.baseKind, ...hostFile },
        after: { hash: entry.stagedHash, bytes: entry.size },
        ...external
      });
    }
    return changes;
  }
  /**
   * 冻结候选：before/after 两侧都在候选里冻结（#12.6）。
   * 同一分支同一路径的新候选取代旧待审（#3.8），但只在明确修订关系内（#12.1 / 12.3）。
   */
  freezeCandidate(opts = {}) {
    const changes = this.diffEntries();
    const hostOperations = this.manifest.hostOperations.filter((op) => op.status === "pending");
    if (changes.length === 0 && hostOperations.length === 0) {
      return { enqueued: false, reason: "no-net-change", changes: [], hostOperations: [] };
    }
    const sequence = Math.max(Number(this.queue.sequence) || 0, this.queue.order?.length || 0) + 1;
    const id = newCandidateId(sequence);
    const createdAt = (/* @__PURE__ */ new Date()).toISOString();
    const candidate = {
      version: CANDIDATE_VERSION,
      id,
      createdAt,
      sessionId: this.manifest.sessionId,
      workspaceRoot: this.root,
      revision: this.manifest.revision,
      source: opts.source || "tool",
      status: CANDIDATE_STATUS.PENDING,
      supersededBy: void 0,
      changes: changes.map((change) => ({
        ...change,
        // 两侧 hash 直接指向 blob；blob 是内容寻址的，因此天然不可变
        frozen: true
      })),
      hostOperations: hostOperations.map((op) => ({ ...op })),
      summary: summarize(changes, hostOperations)
    };
    this.store.saveCandidate(candidate);
    this.queue = this.store.loadQueue();
    this.queue.order.push(id);
    this.queue.candidates[id] = { id, status: CANDIDATE_STATUS.PENDING, createdAt, files: candidate.summary.files };
    for (const otherId of this.queue.order) {
      if (otherId === id) continue;
      const other = this.store.loadCandidate(otherId);
      if (!other || other.status !== CANDIDATE_STATUS.PENDING) continue;
      if (other.sessionId !== candidate.sessionId) continue;
      const overlapping = other.changes.some((c) => changes.some((n) => compareKey(n.path) === compareKey(c.path)));
      if (!overlapping) continue;
      other.status = CANDIDATE_STATUS.SUPERSEDED;
      other.supersededBy = id;
      other.supersededAt = createdAt;
      this.store.saveCandidate(other);
      this.queue.candidates[otherId] = { ...this.queue.candidates[otherId], status: CANDIDATE_STATUS.SUPERSEDED, supersededBy: id };
      this.queue.supersededBy[otherId] = id;
    }
    this.queue.sequence = sequence;
    this.pruneCandidates();
    this.store.saveQueue(this.queue);
    for (const op of hostOperations) op.status = "enqueued";
    this.store.touch(this.manifest);
    return { enqueued: true, candidate, changes, hostOperations };
  }
  /**
   * ── WP5′：把已结案的候选**从队列与磁盘上移除**，让状态量与轮次解耦 ──────────────
   *
   * 判据（只有"绝对没有后续决定会读它"的状态才回收）：
   *   · `superseded`   —— 已被同路径的更新修订取代（`freezeCandidate()` 刚写过 supersededBy）。
   *                       任何读取都会沿 `supersededBy` 走到最新那份，因此旧那份是死数据。
   *                       若它还带 `hostOperations`（宿主操作台账），则**不回收**：
   *                       那张台账没有"取代"语义，丢了就等于丢账。
   *   · `applied`      —— 全部路径已落盘，`resolveCandidate()` 对它只会回 `ALREADY_APPLIED`，
   *                       而落盘事实已经由 **manifest 的 stagedHash/baseHash** 承担
   *                       （重放一次是 no-op，因为此时 `stagedHash === baseHash`），
   *                       所以候选文件不是任何事实的唯一载体。
   *
   * 刻意**不**回收：`pending` / `partially-applied` / `stale`（都还有决定价值）、
   * 以及注册表候选（它们的产物由 `src/registry-stage.ts` 持有，本文件不越界处置）。
   *
   * 不变式（`_r3/wp5-test.ts` 断言）：连续 N 轮写入后
   *   `queue.order.length` 与 `candidates/*.json` 的条数都 **≤ 1**，与 N 无关。
   *
   * @returns {{pruned: string[], kept: number}}
   */
  pruneCandidates(options = {}) {
    const queue = this.queue || this.store.loadQueue();
    queue.order = Array.isArray(queue.order) ? queue.order : [];
    const keep = /* @__PURE__ */ new Set();
    const pruned = [];
    for (const id of queue.order) {
      const candidate = this.store.loadCandidate(id);
      if (!candidate) {
        pruned.push(id);
        continue;
      }
      const registry = candidate.origin === "registry" || candidate.source === "registry-stage";
      const settled = candidate.status === CANDIDATE_STATUS.SUPERSEDED || candidate.status === CANDIDATE_STATUS.APPLIED;
      const hasHostLedger = Array.isArray(candidate.hostOperations) && candidate.hostOperations.length > 0;
      if (options.all === true || settled && !hasHostLedger && !registry) {
        pruned.push(id);
        const tombstone = candidate.status === CANDIDATE_STATUS.APPLIED ? "applied" : "superseded";
        queue.resolved = queue.resolved && typeof queue.resolved === "object" ? queue.resolved : {};
        queue.resolved[id] = { status: tombstone, at: candidate.appliedAt ?? candidate.supersededAt ?? (/* @__PURE__ */ new Date()).toISOString() };
        delete queue.candidates[id];
        try {
          rmSync4(this.store.candidatePath(id), { force: true });
        } catch {
        }
        continue;
      }
      keep.add(id);
    }
    queue.order = queue.order.filter((id) => keep.has(id));
    this.queue = queue;
    return { pruned, kept: queue.order.length };
  }
  /** 待审列表：展开为按文件计数的口径（#12.7 / A27） */
  listReviews(opts = {}) {
    const out = [];
    for (const id of this.queue.order) {
      const candidate = this.store.loadCandidate(id);
      if (!candidate) continue;
      if (!opts.includeResolved && ![CANDIDATE_STATUS.PENDING, CANDIDATE_STATUS.PARTIALLY_APPLIED, CANDIDATE_STATUS.STALE].includes(candidate.status)) continue;
      if (opts.path && !candidate.changes.some((c) => compareKey(c.path) === compareKey(opts.path))) continue;
      out.push(candidate);
    }
    return out;
  }
  /** 陈旧引用重定向：沿 superseded_by 链走到最新，带环路保护（#12.3） */
  resolveCandidate(id) {
    const seen = /* @__PURE__ */ new Set();
    let current = id;
    while (current) {
      if (seen.has(current)) {
        throw new SandboxError("CANDIDATE_CYCLE", `supersede chain contains a cycle at ${current}`, { chain: [...seen] });
      }
      seen.add(current);
      const candidate = this.store.loadCandidate(current);
      if (!candidate) {
        const resolved = (this.queue ?? this.store.loadQueue())?.resolved?.[current];
        if (resolved?.status === "applied") return { candidate: { id: current, status: CANDIDATE_STATUS.APPLIED, changes: [], pruned: true }, idempotent: "ALREADY_APPLIED" };
        if (resolved?.status === "superseded") {
          throw new SandboxError("CANDIDATE_SUPERSEDED_BY_PRUNE", `candidate ${current} was superseded and has been reclaimed`, { id: current });
        }
        throw new SandboxError("CANDIDATE_NOT_FOUND", `candidate ${current} does not exist`, { id: current });
      }
      if (candidate.status === CANDIDATE_STATUS.APPLIED) return { candidate, idempotent: "ALREADY_APPLIED" };
      if (candidate.status === CANDIDATE_STATUS.DISCARDED) {
        throw new SandboxError("CANDIDATE_DISCARDED", `candidate ${current} was discarded`, { id: current });
      }
      if (candidate.status === CANDIDATE_STATUS.SUPERSEDED && candidate.supersededBy) {
        current = candidate.supersededBy;
        continue;
      }
      return { candidate };
    }
    throw new SandboxError("CANDIDATE_NOT_FOUND", `candidate ${id} could not be resolved`);
  }
  /** 丢弃是一个有状态操作，不是删文件（#12.5 / A28） */
  discardCandidate(id, opts = {}) {
    const { candidate, idempotent } = this.resolveCandidate(id);
    if (idempotent === "ALREADY_APPLIED") {
      throw new SandboxError("ALREADY_APPLIED", `candidate ${candidate.id} is already applied`, { id: candidate.id });
    }
    this.queue = this.store.loadQueue();
    candidate.status = CANDIDATE_STATUS.DISCARDED;
    candidate.discardedAt = (/* @__PURE__ */ new Date()).toISOString();
    candidate.discardReason = opts.reason || "user";
    this.store.saveCandidate(candidate);
    this.queue.candidates[candidate.id] = { ...this.queue.candidates[candidate.id], status: CANDIDATE_STATUS.DISCARDED };
    this.queue.discarded.push({ id: candidate.id, at: candidate.discardedAt, reason: candidate.discardReason });
    this.store.saveQueue(this.queue);
    return { discarded: candidate.id };
  }
  /**
   * 选择性应用。
   *   - 逐文件条件检查：真实文件自暂存以来被外部改动 → 该文件 STALE，不静默覆盖
   *   - 未选部分保留为可追踪修订，不丢弃整份候选（#12.2）
   */
  applyCandidate(id, opts = {}) {
    const { candidate, idempotent } = this.resolveCandidate(id);
    if (idempotent === "ALREADY_APPLIED") {
      return { idempotent: "ALREADY_APPLIED", applied: [], failed: [], blockedByMask: [], maskWarnings: [], conflicts: [], remaining: 0 };
    }
    const selected = opts.paths ? new Set(opts.paths.map(compareKey)) : void 0;
    const chosen = candidate.changes.filter((change) => selected ? selected.has(compareKey(change.path)) : true);
    const applied2 = [];
    const failed = [];
    const blockedByMask = [];
    const maskWarnings = [];
    const confirmedMasks = opts.confirmedMasks;
    const confirmedSet = confirmedMasks === true || confirmedMasks === void 0 ? null : new Set([...confirmedMasks].map(compareKey));
    const conflicts = [];
    const pendingChanges = [];
    for (const change of chosen) {
      if (change.op === "delete" || change.after?.hash === hashAbsent()) continue;
      const current = existsSync4(this.absolute(change.path)) ? hashFile(this.absolute(change.path)) : hashAbsent();
      if (current === change.after?.hash) continue;
      pendingChanges.push(change);
    }
    if (opts.force !== true) {
      for (const change of pendingChanges) {
        const conflict = this.baselineConflictOf(change);
        if (!conflict) continue;
        const foundNow = existsSync4(this.absolute(change.path)) ? statKind(this.absolute(change.path))?.kind === "file" ? hashFile(this.absolute(change.path)) : hashAbsent() : hashAbsent();
        conflicts.push({
          path: change.path,
          op: change.op,
          ...conflict,
          expectedHash: change.before?.hash ?? hashAbsent(),
          foundHash: foundNow
        });
      }
    }
    if (conflicts.length > 0) {
      const failed2 = conflicts.map((conflict) => ({
        path: conflict.path,
        op: conflict.op,
        code: "STALE_BASELINE",
        message: `real file changed after this edit was recorded (baseline conflict: ${conflict.changed.join("+")}); refusing to overwrite`,
        // 用的是**内容 hash**口径（与 `applyOneChange()` 同源），不是指纹里的 sha256 字段
        driftReason: driftReasonOf(conflict.expectedHash, conflict.foundHash),
        expected: conflict.expected,
        found: conflict.found
      }));
      return {
        id: candidate.id,
        status: candidate.status,
        applied: [],
        failed: failed2,
        blockedByMask: [],
        maskWarnings: [],
        conflicts,
        remaining: chosen.map((change) => change.path),
        totalChanged: candidate.changes.length,
        requeued: true,
        // 命令面/面板据此列出"哪些文件在你暂存之后被改过"，并给出覆盖 / 放弃两个出口
        note: "baseline-conflict: refused to overwrite host files that changed after staging (nothing was written)"
      };
    }
    for (const change of chosen) {
      const abs = this.absolute(change.path);
      const mask = this.maskOf(abs);
      if (mask) {
        const info = {
          path: change.path,
          maskId: mask.id,
          reason: mask.reason,
          hard: mask.hard === true,
          external: change.external === true
        };
        if (isInside(this.root, abs)) {
          const confirmed = confirmedMasks === true || confirmedSet !== null && confirmedSet.has(compareKey(change.path));
          if (!confirmed) {
            blockedByMask.push(info);
            failed.push({
              path: change.path,
              op: change.op,
              code: "SANDBOX_PATH_MASKED_CONFIRM",
              message: `${mask.reason}\uFF08\u6279\u51C6\u4F1A\u628A\u6682\u5B58\u5185\u5BB9\u5199\u5165\u771F\u5B9E\u78C1\u76D8\u4E14\u4E0D\u53EF\u64A4\u9500\uFF1B\u9700\u8981\u4E8C\u6B21\u786E\u8BA4\uFF09`,
              maskId: mask.id,
              hard: mask.hard === true
            });
            continue;
          }
          maskWarnings.push({ ...info, confirmed: true });
        } else {
          maskWarnings.push(info);
        }
      }
      try {
        this.applyOneChange(change, opts);
        applied2.push({ path: change.path, op: change.op });
      } catch (error) {
        failed.push({
          path: change.path,
          op: change.op,
          code: error.code || "ERR",
          message: error.message,
          // `applyOneChange()` 的 STALE_BASELINE 分支在 details 里带着形状
          // （`driftReason`）⇒ 只加不改地透出给命令面；旧调用方读不到也照旧工作。
          ...error?.detail?.driftReason ? { driftReason: error.detail.driftReason } : {}
        });
      }
    }
    const allChanged = new Set(candidate.changes.map((c) => compareKey(c.path)));
    const appliedKeys = new Set(applied2.map((a) => compareKey(a.path)));
    const remaining = candidate.changes.filter((c) => !appliedKeys.has(compareKey(c.path)));
    this.queue = this.store.loadQueue();
    let status;
    if (applied2.length === 0 && failed.length > 0) {
      status = candidate.status === CANDIDATE_STATUS.PENDING ? CANDIDATE_STATUS.PENDING : CANDIDATE_STATUS.STALE;
    } else if (remaining.length > 0 || failed.length > 0) {
      status = CANDIDATE_STATUS.PARTIALLY_APPLIED;
    } else {
      status = CANDIDATE_STATUS.APPLIED;
    }
    candidate.status = status;
    candidate.appliedAt = (/* @__PURE__ */ new Date()).toISOString();
    candidate.appliedPaths = [...candidate.appliedPaths || [], ...applied2.map((a) => a.path)];
    candidate.lastApply = { applied: applied2, failed, blockedByMask, maskWarnings, conflicts: [] };
    this.store.saveCandidate(candidate);
    this.queue.candidates[candidate.id] = {
      ...this.queue.candidates[candidate.id],
      status,
      appliedFiles: candidate.appliedPaths.length,
      remainingFiles: remaining.length
    };
    for (const item of applied2) {
      const entry = this.entryOf(item.path);
      if (!entry) continue;
      if (change_isDelete(candidate, item.path)) {
        entry.baseHash = hashAbsent();
        entry.baseKind = void 0;
        entry.baseFingerprint = void 0;
        entry.state = STATE.DELETED;
      } else {
        entry.baseHash = entry.stagedHash;
        entry.baseKind = entry.kind;
        entry.baseFingerprint = hostFileFingerprint(this.absolute(item.path));
        entry.changed = false;
      }
    }
    if (applied2.length > 0) this.store.touch(this.manifest);
    if (status === CANDIDATE_STATUS.APPLIED) {
      this.pruneCandidates();
      this.store.saveQueue(this.queue);
    }
    return {
      id: candidate.id,
      status,
      applied: applied2,
      failed,
      blockedByMask,
      maskWarnings,
      // WP8.2：整批预检的冲突清单（非空 ⇒ `applied` 必为空；只加不改：老调用方读不到也照旧）
      conflicts: [],
      remaining: remaining.map((c) => c.path),
      totalChanged: allChanged.size,
      // 未选部分重新入队为可追踪修订（#12.2）
      requeued: remaining.length > 0
    };
  }
  /**
   * ── WP8.2：单条变更的**宿主原件基线冲突**判定（`applyOneChange()` 与
   * `applyCandidate()` 的整批预检**共用这一个判据**，绝不各写一份）────────────────
   *
   * 指纹来源优先级：
   *   1. `change.before.hostFile` —— 候选里**冻结**的那一份（批准时唯一权威的口径：
   *      批准针对的就是这份冻结候选）；
   *   2. 清单条目上的 `baseFingerprint` —— 兜底（老候选没有 `hostFile` 时）；
   *   3. 两者都没有 ⇒ 返回 `null`（不判冲突）。这是**故意的宽松**：老清单/目录/外部键
   *      没有指纹可比，此时既有行为（`before.hash` 闸门）照旧生效，不新增拒绝面。
   *
   * @returns {{code:string,expected:object,found:object|null,changed:string[]}|null}
   */
  baselineConflictOf(change) {
    const expected = change?.before?.hostFile ?? this.entryOf(change?.path)?.baseFingerprint;
    if (!expected) return null;
    const abs = this.absolute(change.path);
    const found = hostFileFingerprint(abs);
    return baselineConflictOf(expected, found);
  }
  applyOneChange(change, opts) {
    const abs = this.absolute(change.path);
    const realNow = existsSync4(abs) && statKind(abs)?.kind === "file" ? hashFile(abs) : hashAbsent();
    const expected = change.before?.hash ?? hashAbsent();
    if (!opts.force && realNow !== expected) {
      throw new SandboxError("STALE_BASELINE", `real file changed after this edit was recorded (expected ${expected}, found ${realNow}); refusing to overwrite`, {
        path: change.path,
        expected,
        found: realNow,
        // 缺陷②（F5b）：把**漂移形状**随失败一起上报，命令面/面板才能说清
        // "真实文件在暂存之后出现"（有内容丢失风险）而不是笼统的"基线已过期"。
        driftReason: driftReasonOf(expected, realNow)
      });
    }
    if (change.op === "delete" || change.after?.hash === hashAbsent()) {
      if (existsSync4(abs)) {
        const repair = makeRemovable(abs);
        try {
          rmSync4(abs, { recursive: true, force: true });
        } catch (error) {
          throw new SandboxError("EDELETE_FAILED", `could not delete ${change.path}: ${error.message}`, {
            path: change.path,
            repaired: repair.repaired
          });
        }
      }
      return;
    }
    if (!this.store.hasBlob(change.after.hash)) {
      throw new SandboxError("BLOB_MISSING", `candidate content for ${change.path} is missing; candidate is unusable`, {
        path: change.path,
        hash: change.after.hash
      });
    }
    const content = this.store.readBlob(change.after.hash);
    if (opts.force !== true) {
      const conflict = this.baselineConflictOf(change);
      if (conflict) {
        throw new SandboxError("BASELINE_CONFLICT", `host file changed since staging (${conflict.changed.join("+")}); refusing to overwrite`, {
          path: change.path,
          code: conflict.code,
          expected: conflict.expected,
          found: conflict.found,
          changed: conflict.changed
        });
      }
    }
    writeFileAtomicReplacing(abs, content);
  }
  // ==================== 命令执行前后的物化与提取（#3.2 / 3.6 / A16） ====================
  /**
   * ── 缺陷③（Fix B）：`init` 面上的**修复路径** ───────────────────────────────────
   *
   * 检查暂存根上有没有"被显式写进去的 AppContainer 包 SID 允许 ACE"
   * （`S-1-15-2-…:(OI)(CI)(M)`，上一次 `--tier T0` 运行留下、却没被撤销），
   * 有就摘掉，让 T1 的暂存写重新可用。
   *
   * 为什么挂在 `init` 上：`init` 是用户"把这个工作区收拾好"的既有动词，
   * 而 `cli exec` 每次都会先 `executor.init()`；因此**下一次任何命令都会自愈**，
   * 与审计记下的"重跑 init 不自愈"正好相反。
   *
   * 判定与执行都在 `src/appcontainer.ts`（纯 SDDL 判据）+ `src/executor.ts`
   * （`repairStaleAppContainerAces`，用 icacls 落地），本方法只做工作区侧的转接，
   * 不重复实现判据（判据漂移会让"修复"和"测量"对不上）。
   *
   * @param {{repairImpl?: Function, runIcacls?: Function, readSddl?: Function}} [options] 注入缝（离线测试用）
   */
  repairStaleAppContainerAces(options = {}) {
    const impl = options.repairImpl ?? repairStaleAppContainerAces;
    const result = impl(this.store.stagedDir, options);
    return { stagingRoot: this.store.stagedDir, ...result };
  }
  /** 执行前物化当前工作区版本到 staging root */
  materializeForExecution() {
    const report = { copied: 0, failed: [] };
    for (const [rel, entry] of Object.entries(this.manifest.entries)) {
      if (entry.state === STATE.DELETED) continue;
      if (entry.kind === "dir") {
        mkdirSync4(this.staged(rel), { recursive: true });
        continue;
      }
      const target = this.staged(rel);
      try {
        mkdirSync4(dirname5(target), { recursive: true });
        if (this.store.hasBlob(entry.stagedHash)) writeFileSync5(target, this.store.readBlob(entry.stagedHash));
        report.copied += 1;
      } catch (error) {
        report.failed.push({ path: rel, message: error.message });
      }
    }
    return report;
  }
  /**
   * 执行后提取：相对输入版本的新增变化（#3.2）。
   * 只提取相对 staging 快照的净变化，不重复暂存已暂存路径（#3.10 幂等）。
   *
   * 重解析点（D8）：与 `snapshotStagedTree()` 共用 `walkStagedForHashes()`，
   * 因此 junction/symlink 既不会被 hash（否则 EISDIR 直接崩），也不会被误判成"被命令删除"
   * ——`seen` 里包含它们，下面的删除检测据此跳过。
   *
   * ── 删除的第二条来源：白障标记（缺陷①b）──────────────────────────────────────
   * 快照是**执行前**取的（`src\cli.ts:204`），shim 不可能让一个"从未暂存过的路径"
   * 出现在里面；它在 `<staging root>\wo\…` 写下的标记才是"这条路径被删除了"的唯一痕迹。
   * 因此：内容对象消失（非 shim 档的 `del` 直接删暂存副本）与**新出现的白障标记**
   * 两条来源都要报删除，并按逻辑路径去重（同一次删除在两个面上都留痕时只报一次）。
   */
  captureAfterExecution(beforeSnapshot) {
    const changes = [];
    const { hashes, realPaths, seen, whiteouts } = walkStagedForHashes(this.store.stagedDir);
    const deletedLogical = /* @__PURE__ */ new Set();
    for (const [key, now] of hashes) {
      const before = beforeSnapshot.get(key);
      if (before === now) continue;
      const change = { path: realPaths.get(key) ?? key, hash: now, previous: before };
      if (before === void 0) change.created = true;
      changes.push(change);
    }
    for (const [key, previousHash] of beforeSnapshot) {
      if (hashes.has(key)) continue;
      if (seen.has(this.store.stagedPath(key))) continue;
      const logical = realPaths.get(key) ?? key;
      changes.push({ path: logical, hash: hashAbsent(), previous: previousHash, deleted: true });
      deletedLogical.add(compareKey(this.absolute(logical)));
    }
    const beforeWhiteouts = beforeSnapshot.whiteouts instanceof Map ? beforeSnapshot.whiteouts : /* @__PURE__ */ new Map();
    for (const [whiteoutKey, logical] of whiteouts) {
      if (beforeWhiteouts.has(whiteoutKey)) continue;
      if (deletedLogical.has(whiteoutKey)) continue;
      if (lexicalInside(this.store.dir, logical) !== void 0) continue;
      const rel = lexicalInside(this.root, logical);
      changes.push({ path: rel === void 0 ? logical : rel, hash: hashAbsent(), deleted: true });
    }
    return changes;
  }
  /**
   * 执行前对暂存树做**内容戳快照**（#3.2 / A16）。
   *
   * ── 重解析点必须跳过（缺陷 D8；判定在 task-7 修好）────────────────────────────
   * `lstatSync(junction).isDirectory()` 在 Windows 上返回 **true**，而
   * `hashFile(junction)` 会跟随解析目标；目标若是目录就抛
   * `EISDIR: illegal operation on a directory, read`，
   * 于是一条 `cli exec` 会在**命令还没跑**的时候崩掉（exit=1）。
   * 守卫本身（`classifyEntry()`）在旧版是**恒 false 的假判据**（`mode & 0x400`），
   * task-7 用实测选型换成 `dirent.isSymbolicLink()` + 交叉校验，并补了环路防护。
   *
   * 跳过而不是"按目标内容记戳"的理由：重解析点在暂存树里不是一个内容对象，
   * 跟随解析会①越过暂存边界读取（可能是宿主任意目录，甚至形成环），
   * ②让"文件在暂存树里"这个前提失真。它在暂存树里表现为**不透明结点**，
   * 因此既不入快照，也不被当成"被命令删除了"。代价（如实记录）：
   * 暂存树内 junction 指向的目标内容变化**不会**被 `captureAfterExecution` 捕获。
   *
   * 返回值仍是 `Map`（调用方按 `Map` 用），另外挂两个**可观测**属性（不是静默跳过）：
   *   · `skippedReparsePoints: string[]` —— 被判为重解析点的路径（兼容既有调用方）；
   *   · `skipped: Array<{path, reason}>` —— **结构化**跳过记录，reason ∈
   *     `reparse-point` / `cycle-detected` / `depth-limit` / `whiteout-unmappable` /
   *     `unreadable:<CODE>`。
   *
   * 另挂 `whiteouts: Map<compareKey(逻辑绝对路径), 逻辑绝对路径>`（缺陷①b）：执行前已有的
   * 白障标记，`captureAfterExecution()` 用它做差集，只把**这次新出现**的标记报成删除。
   * `wo\` 子树在此**不进入内容戳**（`walkStagedForHashes()` 的统一口径），因此
   * 上一次运行留下的标记既不会被当成暂存内容对象，也不会被当成"暂存对象消失"。
   */
  snapshotStagedTree() {
    const { hashes, whiteouts, skippedReparsePoints, skipped } = walkStagedForHashes(this.store.stagedDir);
    hashes.skippedReparsePoints = skippedReparsePoints;
    hashes.skipped = skipped;
    hashes.whiteouts = whiteouts;
    return hashes;
  }
  /**
   * 把"沙箱内捕获到的变化"并入逻辑工作区（#3.2）。
   *
   * 为什么必须由 Workspace 承担（缺陷 D9）：`cli exec` 原先只打印 `capturedChanges` 的**条数**，
   * 从不把捕获结果写回清单，于是暂存树里明明有命令产出的文件，
   * `diffEntries()` 却一个变化都看不到 → `review` 永远是空队列 →
   * 文档承诺的 `exec → review → apply` 链路**根本跑不通**
   * （原始证据 `.t\sbx3\t-fs\out\07-cli-exec-clean-smoke.out` / `09-cli-status-clean-exec.out` /
   *  `10-cli-review-clean-exec.out`：执行成功、`capturedChanges=1`，但 `pendingCandidates=0`）。
   * 这段逻辑原先只存在于 `tests\e2e-flow.ts` 里（测试自己在 CLI 之外手工补了这两步），
   * 属于"测试替被测代码干活"——所以这里把它搬进正主，测试改为调用本方法。
   *
   * 幂等（#3.10）：`captured` 是**相对执行前快照**的净变化，已暂存路径不会被重复暂存；
   * 内容相同的重复 exec 捕获为空数组，什么都不做。
   *
   * @param {Array<{path: string, hash: string, previous?: string, deleted?: boolean}>} captured
   * @returns {{ingested: number, deletions: number, skipped: Array<{path: string, reason: string}>}}
   */
  ingestCapturedChanges(captured = []) {
    const result = { ingested: 0, deletions: 0, skipped: [] };
    for (const change of captured) {
      const abs = this.absolute(change.path);
      if (change.deleted) {
        try {
          this.remove(abs, { missingOk: true, origin: "exec" });
          result.deletions += 1;
        } catch (error) {
          result.skipped.push({ path: change.path, reason: error.message });
        }
        continue;
      }
      const hash = change.hash && change.hash !== hashAbsent() ? change.hash : void 0;
      if (hash && this.store.hasBlob(hash)) {
        this.writeFile(abs, this.store.readBlob(hash), { origin: "exec" });
        result.ingested += 1;
        continue;
      }
      const stagedPath = this.store.stagedPath(change.path);
      if (!existsSync4(stagedPath)) {
        result.skipped.push({ path: change.path, reason: "staged object missing; not ingesting" });
        continue;
      }
      this.writeFile(abs, readFileSync4(stagedPath), { origin: "exec" });
      result.ingested += 1;
    }
    return result;
  }
  /**
   * 幂等冻结候选（缺陷 D9 的后半段）。
   *
   * `freezeCandidate()` 无条件新建候选并取代同路径旧待审；如果每次 `exec` 都调它，
   * 队列会被无意义地刷屏（同一个变更反复产生候选）。因此这里先看
   * 最新待审候选是否**恰好**覆盖当前净变化（按路径 + 操作 + 两侧 hash），
   * 是则复用，否则才冻结。判据与 `dsh-plugin\review-service.ts::represents()` 同一口径。
   *
   * @returns {{frozen: boolean, candidate?: object, reason?: string, changes: number}}
   */
  freezeIfNeeded(opts = {}) {
    const changes = this.diffEntries();
    if (changes.length === 0) return { frozen: false, reason: "no-net-change", changes: 0 };
    const pending = this.listReviews();
    const latest = pending[pending.length - 1];
    if (latest && candidateRepresents(latest.changes, changes)) {
      return { frozen: false, reason: "already-represented", candidate: latest, changes: changes.length };
    }
    const frozen = this.freezeCandidate(opts);
    if (frozen.enqueued !== true) return { frozen: false, reason: frozen.reason || "not-enqueued", changes: changes.length };
    return { frozen: true, candidate: frozen.candidate, changes: changes.length };
  }
  recordHostOperation(operation) {
    const op = {
      id: `host_${this.manifest.hostOperations.length + 1}_${Date.now().toString(36)}`,
      kind: operation.kind || "host_op",
      summary: operation.summary,
      detail: operation.detail,
      riskLevel: operation.riskLevel || "L2",
      status: "pending",
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.manifest.hostOperations.push(op);
    this.store.touch(this.manifest);
    return op;
  }
};
function change_isDelete(candidate, path) {
  const change = candidate.changes.find((c) => compareKey(c.path) === compareKey(path));
  return change ? change.op === "delete" : false;
}
function candidateRepresents(candidateChanges, changes) {
  if (!Array.isArray(candidateChanges) || candidateChanges.length !== changes.length) return false;
  const index = new Map(candidateChanges.map((c) => [compareKey(c.path), c]));
  for (const change of changes) {
    const other = index.get(compareKey(change.path));
    if (!other) return false;
    if (other.op !== change.op) return false;
    if ((other.before?.hash ?? hashAbsent()) !== (change.before?.hash ?? hashAbsent())) return false;
    if ((other.after?.hash ?? hashAbsent()) !== (change.after?.hash ?? hashAbsent())) return false;
  }
  return true;
}
function summarize(changes, hostOperations) {
  const byOp = {};
  for (const change of changes) byOp[change.op] = (byOp[change.op] || 0) + 1;
  return {
    files: changes.length,
    hostOperations: hostOperations.length,
    byOp,
    bytes: changes.reduce((sum, c) => sum + (c.after?.bytes || 0), 0)
  };
}
function applyEdit(before, edit) {
  if (typeof edit === "string") {
    if (before === void 0) throw new SandboxError("ENOENT", "cannot replace content of a nonexistent file without insert semantics");
    return edit;
  }
  if (!edit || typeof edit !== "object") throw new SandboxError("BAD_EDIT", "edit must be a string or an object");
  let text = before;
  if (edit.mode === "create" || before === void 0) {
    if (edit.mode !== "create" && before === void 0) throw new SandboxError("ENOENT", "file does not exist");
    text = edit.content ?? "";
    if (edit.oldText) throw new SandboxError("BAD_EDIT", "oldText is not valid when creating a file");
    return text;
  }
  if (edit.oldText !== void 0) {
    const occurrences = text.split(edit.oldText).length - 1;
    if (occurrences === 0) {
      throw new SandboxError("EDIT_NO_MATCH", "oldText was not found; the file may have changed", { occurrences });
    }
    if (occurrences > 1 && !edit.replaceAll) {
      throw new SandboxError("EDIT_AMBIGUOUS", `oldText matched ${occurrences} times; refusing an ambiguous edit`, { occurrences });
    }
    text = edit.replaceAll ? text.split(edit.oldText).join(edit.newText ?? "") : text.replace(edit.oldText, edit.newText ?? "");
  }
  if (edit.append) text += edit.append;
  if (edit.prepend) text = edit.prepend + text;
  if (edit.insertAtLine !== void 0) {
    const lines = text.split("\n");
    lines.splice(edit.insertAtLine, 0, edit.content ?? "");
    text = lines.join("\n");
  }
  return text;
}
function globMatch(glob, name) {
  const pattern = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^\\\\/]*").replace(/\?/g, ".").replace(/\u0000/g, ".*");
  return new RegExp(`^${pattern}$`, "i").test(name);
}

// src/tools.ts
import { normalize as normalize6 } from "node:path";
function renderCandidateDiff(store, candidate, options = {}) {
  const maxLines = options.maxLines ?? 40;
  const out = [];
  for (const change of candidate.changes) {
    out.push({ type: "change-header", path: change.path, op: change.op, kind: change.kind });
    if (change.kind === "dir") {
      out.push({ type: "note", text: "\u76EE\u5F55\u53D8\u66F4" });
      continue;
    }
    const beforeLines = change.before?.hash && change.before.hash !== hashAbsent() && store.hasBlob(change.before.hash) ? store.readBlob(change.before.hash).toString("utf8").split(/\r?\n/) : [];
    const afterLines = change.after?.hash && change.after.hash !== hashAbsent() && store.hasBlob(change.after.hash) ? store.readBlob(change.after.hash).toString("utf8").split(/\r?\n/) : [];
    let shown = 0;
    const length = Math.max(beforeLines.length, afterLines.length);
    for (let i = 0; i < length && shown < maxLines; i += 1) {
      const a = beforeLines[i];
      const b = afterLines[i];
      if (a === b) continue;
      if (a !== void 0 && b === void 0) out.push({ type: "remove", line: i + 1, text: a });
      else if (a === void 0 && b !== void 0) out.push({ type: "add", line: i + 1, text: b });
      else {
        out.push({ type: "remove", line: i + 1, text: a });
        out.push({ type: "add", line: i + 1, text: b });
      }
      shown += 1;
    }
    if (shown >= maxLines) out.push({ type: "note", text: `diff \u5DF2\u622A\u65AD\uFF08\u8D85\u8FC7 ${maxLines} \u884C\u53D8\u5316\uFF09` });
  }
  return out;
}

// dsh-plugin/sensitive-content.ts
var REDACTED_PREFIX = "<REDACTED";
var REDACTED_SUFFIX = ">";
var MASK_REASON = Object.freeze({
  /** 结构化行：`key: value` / `key=value` / `"key": "value"` —— 只遮值 */
  STRUCTURED_VALUE: "structured-value",
  /** 裸 token：没有分隔符、但形状像密钥/令牌（长度 + 字符集 + 字符类多样性） */
  BARE_TOKEN: "bare-token",
  /** 二进制/控制字符占比过高（evtx / 私钥派生体 / UTF-16 转储）—— 整行遮蔽 */
  BINARY_LINE: "binary-line",
  /** 已知密钥形态（`sk-…` / `Bearer …`）—— 保留标记、遮蔽随机段 */
  KNOWN_SECRET: "known-secret"
});
function redactedToken(length) {
  const n = Number.isFinite(length) && length > 0 ? Math.trunc(length) : 0;
  return `${REDACTED_PREFIX} len=${n}${REDACTED_SUFFIX}`;
}
var DELIMITER_RE = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|"[^"]*|[A-Za-z_][\w.\-[\]]*)\s*(?::|=)/;
var BARE_TOKEN_RE = /[A-Za-z0-9+/_][A-Za-z0-9+/=_.-]{15,}/g;
var SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/|\\\\)?[^\s]*$/;
var KNOWN_SECRET_RE = /\b(?:sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9+/=_.-]{16,})/g;
function maskKnownSecret(match) {
  if (match.startsWith("Bearer")) {
    const rest = match.slice("Bearer".length);
    const lead = rest.match(/^\s*/)[0];
    const token = rest.slice(lead.length);
    return `Bearer${lead}${redactedToken(token.length)}`;
  }
  const dash = match.indexOf("-");
  return `${match.slice(0, dash + 1)}${redactedToken(match.length - dash - 1)}`;
}
function looksSecretLike(token) {
  const text = String(token ?? "");
  if (text.length < 16) return false;
  if (hasLongRepeat(text)) return true;
  if (!/[A-Za-z]/.test(text)) return false;
  const classes = (/[a-z]/.test(text) ? 1 : 0) + (/[A-Z]/.test(text) ? 1 : 0) + (/[0-9]/.test(text) ? 1 : 0) + (/[+/=_.-]/.test(text) ? 1 : 0);
  return classes >= 3;
}
function valueNeedsMask(value) {
  const text = String(value ?? "");
  if (text.length === 0) return false;
  if (looksBinaryLine(text)) return true;
  if (hasLongRepeat(text)) return true;
  if (text.length <= 24) return false;
  if (isLocationLike(text)) return false;
  if (/\s/.test(text) && text.length <= 96) {
    const distinct = new Set(text.replace(/\s+/g, "")).size;
    if (distinct / text.length >= 0.55) return false;
  }
  return true;
}
function isLocationLike(value) {
  const text = String(value ?? "");
  if (text.length === 0) return false;
  if (SCHEME_RE.test(text)) return true;
  if (/^[A-Za-z]:[\\/]/.test(text)) return true;
  if (/^\\\\[^\\]/.test(text)) return true;
  if (/^(\.{1,2}[\\/]|[\\/])/.test(text)) return true;
  if (/\\|\//.test(text) && !text.includes("=") && (!/\s/.test(text) || /^[A-Za-z]:/.test(text))) return true;
  if (/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(text)) return true;
  if (/^[A-Za-z0-9._-]+:\d{1,5}$/.test(text)) return true;
  return false;
}
function hasLongRepeat(text) {
  const value = String(text ?? "");
  let run = 1;
  for (let i = 1; i < value.length; i += 1) {
    if (value[i] === value[i - 1]) {
      run += 1;
      if (run >= 16) return true;
    } else run = 1;
  }
  return false;
}
function looksBinaryLine(text) {
  const value = String(text ?? "");
  if (value.length === 0) return false;
  let controls = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127 || code > 126) controls += 1;
  }
  return controls >= 4 && controls / value.length >= 0.02;
}
function maskSensitiveLine(line) {
  const original = typeof line === "string" ? line : String(line ?? "");
  if (original.length === 0) return { text: original, masked: false, segments: 0, reasons: [] };
  const trailing = original.endsWith("\r") ? "\r" : "";
  const body = trailing ? original.slice(0, -1) : original;
  if (looksBinaryLine(body)) {
    return {
      text: `${redactedToken(body.length)}${trailing}`,
      masked: true,
      segments: 1,
      reasons: [MASK_REASON.BINARY_LINE]
    };
  }
  const reasons = [];
  let segments2 = 0;
  let text = body;
  KNOWN_SECRET_RE.lastIndex = 0;
  text = text.replace(KNOWN_SECRET_RE, (match) => {
    segments2 += 1;
    if (!reasons.includes(MASK_REASON.KNOWN_SECRET)) reasons.push(MASK_REASON.KNOWN_SECRET);
    return maskKnownSecret(match);
  });
  if (segments2 === 0) {
    const delim = DELIMITER_RE.exec(body);
    if (delim) {
      let at = delim[0].length;
      while (at < body.length && (body[at] === " " || body[at] === "	")) at += 1;
      const value = body.slice(at);
      if (valueNeedsMask(value)) {
        text = `${body.slice(0, at)}${redactedToken(value.length)}`;
        segments2 += 1;
        reasons.push(MASK_REASON.STRUCTURED_VALUE);
      }
    } else {
      const parts = [];
      let cursor = 0;
      BARE_TOKEN_RE.lastIndex = 0;
      let match;
      while ((match = BARE_TOKEN_RE.exec(body)) !== null) {
        const token = match[0];
        if (!looksSecretLike(token)) continue;
        parts.push(body.slice(cursor, match.index));
        parts.push(redactedToken(token.length));
        cursor = match.index + token.length;
        segments2 += 1;
        if (!reasons.includes(MASK_REASON.BARE_TOKEN)) reasons.push(MASK_REASON.BARE_TOKEN);
      }
      parts.push(body.slice(cursor));
      if (segments2 > 0) text = parts.join("");
    }
  }
  if (segments2 === 0) return { text: original, masked: false, segments: 0, reasons: [] };
  return { text: `${text}${trailing}`, masked: true, segments: segments2, reasons };
}
function maskSensitiveLines(lines) {
  const out = [];
  let segments2 = 0;
  const reasons = /* @__PURE__ */ new Set();
  for (const item of Array.isArray(lines) ? lines : []) {
    if (!item || typeof item !== "object") {
      out.push(item);
      continue;
    }
    const result = maskSensitiveLine(item.text ?? "");
    segments2 += result.segments;
    for (const reason of result.reasons) reasons.add(reason);
    out.push(result.masked ? { ...item, text: result.text, redacted: true } : item);
  }
  return { lines: out, masked: segments2 > 0, segments: segments2, reasons: [...reasons] };
}

// dsh-plugin/unstaged-ledger.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync5, readFileSync as readFileSync5, renameSync as renameSync3, writeFileSync as writeFileSync6 } from "node:fs";
import { join as join9 } from "node:path";
var UNSTAGED_LEDGER_BASENAME = "unstaged.json";
var MAX_ENTRIES = 200;
var UNSTAGED_REASONS = Object.freeze({
  /** 会话工作区与插件配置的暂存根不同（R11 D7-a 的实测形态） */
  FOREIGN_WORKSPACE: "foreign-session-workspace",
  /** 目标无法归一成暂存键（`keyOf()` 拿不到 targetKey） */
  UNRESOLVED_TARGET: "unresolved-target",
  /** 显式逃生口 `WINSTAGE_STAGE_OUTSIDE=direct` */
  STAGE_OUTSIDE_DIRECT: "stage-outside-direct"
});
function unstagedLedgerPath(storeDir) {
  return join9(String(storeDir), UNSTAGED_LEDGER_BASENAME);
}
function readUnstagedLedger(storeDir) {
  const empty = { version: 1, entries: [] };
  const file = unstagedLedgerPath(storeDir);
  try {
    if (!existsSync5(file)) return empty;
    const raw = JSON.parse(readFileSync5(file, "utf8"));
    if (!raw || !Array.isArray(raw.entries)) return empty;
    return { version: 1, updatedAt: raw.updatedAt, entries: raw.entries };
  } catch {
    return empty;
  }
}
function recordUnstaged(storeDir, entry, options = {}) {
  try {
    const dir = String(storeDir ?? "");
    if (dir.length === 0) return void 0;
    const record = {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      op: String(entry?.op ?? "unknown"),
      path: String(entry?.path ?? ""),
      reason: String(entry?.reason ?? "unknown"),
      ...entry?.physical ? { physical: String(entry.physical) } : {},
      ...entry?.sessionId ? { sessionId: String(entry.sessionId) } : {},
      /** 这一条是否**真的**落在真实磁盘上（`direct` 档为 true；`deny` 档不会走到这里） */
      appliedToDisk: entry?.appliedToDisk === true
    };
    mkdirSync5(dir, { recursive: true });
    const ledger = readUnstagedLedger(dir);
    const entries = [...ledger.entries, record].slice(-MAX_ENTRIES);
    const payload = { version: 1, updatedAt: (/* @__PURE__ */ new Date()).toISOString(), entries };
    const file = unstagedLedgerPath(dir);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync6(tmp, JSON.stringify(payload, null, 2));
    renameSync3(tmp, file);
    return record;
  } catch (error) {
    try {
      options.onError?.(`\u8BB0\u8D26\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u672C\u6B21\u64CD\u4F5C\uFF09\uFF1A${error?.message ?? error}`);
    } catch {
    }
    return void 0;
  }
}
function unstagedSnapshot(storeDir) {
  const ledger = readUnstagedLedger(storeDir);
  const entries = ledger.entries;
  const byReason = {};
  for (const entry of entries) byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1;
  return {
    /** 账本里**有没有**绕过暂存的记录（面板据此显示常驻横幅） */
    any: entries.length > 0,
    count: entries.length,
    /** 真的落在真实磁盘上的条数（`direct` 档） */
    appliedToDisk: entries.filter((e) => e.appliedToDisk === true).length,
    byReason,
    updatedAt: ledger.updatedAt ?? null,
    /** 最近 N 条（面板只需要展示最近发生的；完整账本在 `unstaged.json`） */
    recent: entries.slice(-20),
    ledgerFile: UNSTAGED_LEDGER_BASENAME
  };
}

// src/registry-stage.ts
import { appendFileSync, existsSync as existsSync6, mkdirSync as mkdirSync6, readFileSync as readFileSync6, renameSync as renameSync4, rmSync as rmSync5, writeFileSync as writeFileSync7 } from "node:fs";
import { dirname as dirname7, join as join10 } from "node:path";

// src/registry-guard.ts
import { Buffer as Buffer2 } from "node:buffer";
var HIVE_HANDLES = Object.freeze({
  HKCR: 0x80000000n,
  HKEY_CLASSES_ROOT: 0x80000000n,
  HKCU: 0x80000001n,
  HKEY_CURRENT_USER: 0x80000001n,
  HKLM: 0x80000002n,
  HKEY_LOCAL_MACHINE: 0x80000002n,
  HKU: 0x80000003n,
  HKEY_USERS: 0x80000003n,
  HKPD: 0x80000004n,
  HKEY_PERFORMANCE_DATA: 0x80000004n,
  HKCC: 0x80000005n,
  HKEY_CURRENT_CONFIG: 0x80000005n
});
var SHORT_BY_LONG = Object.freeze({
  HKEY_CLASSES_ROOT: "HKCR",
  HKEY_CURRENT_USER: "HKCU",
  HKEY_LOCAL_MACHINE: "HKLM",
  HKEY_USERS: "HKU",
  HKEY_PERFORMANCE_DATA: "HKPD",
  HKEY_CURRENT_CONFIG: "HKCC"
});
var HIVE_CANONICAL = Object.freeze(
  Object.fromEntries(
    Object.keys(HIVE_HANDLES).map((spelling) => [
      spelling,
      spelling.startsWith("HKEY_") ? SHORT_BY_LONG[spelling] : spelling
    ])
  )
);
if (Object.values(HIVE_CANONICAL).some((short) => short === void 0)) {
  throw new Error("registry-guard: SHORT_BY_LONG is missing an entry for one of HIVE_HANDLES; fix the table");
}
var REG_TYPES = Object.freeze({
  REG_NONE: 0,
  REG_SZ: 1,
  REG_EXPAND_SZ: 2,
  REG_BINARY: 3,
  REG_DWORD: 4,
  REG_DWORD_BIG_ENDIAN: 5,
  REG_LINK: 6,
  REG_MULTI_SZ: 7,
  REG_RESOURCE_LIST: 8,
  REG_FULL_RESOURCE_DESCRIPTOR: 9,
  REG_RESOURCE_REQUIREMENTS_LIST: 10,
  REG_QWORD: 11
});
var REG_TYPE_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(REG_TYPES).map(([name, value]) => [value, name]))
);
var REG_STATUS = Object.freeze({
  ERROR_SUCCESS: 0,
  ERROR_FILE_NOT_FOUND: 2,
  ERROR_PATH_NOT_FOUND: 3,
  ERROR_ACCESS_DENIED: 5,
  ERROR_SHARING_VIOLATION: 32,
  ERROR_INVALID_PARAMETER: 87,
  ERROR_MORE_DATA: 234,
  ERROR_NO_MORE_ITEMS: 259,
  ERROR_KEY_HAS_CHILDREN: 1020
});
var REG_ACCESS = Object.freeze({
  KEY_QUERY_VALUE: 1,
  KEY_SET_VALUE: 2,
  KEY_CREATE_SUB_KEY: 4,
  KEY_ENUMERATE_SUB_KEYS: 8,
  KEY_NOTIFY: 16,
  KEY_CREATE_LINK: 32,
  // ── 复合掩码（`[官方]` winreg.h "Registry Key Security and Access Rights"）──────
  // 阶段 B 实测缺陷：初版**只有**上面 6 个基本位 + 3 个 STANDARD_RIGHTS 位，**没有 KEY_READ**。
  // 而 `KEY_READ` 是注册表里最常用的授权掩码（也是 `planAclRestriction` 的典型入参），
  // 缺了它会让 `REG_ACCESS.KEY_READ` 是 `undefined` → `accessName` 解析不出来 →
  // 在 `` `0x${access.toString(16)}` `` 里以 TypeError 崩溃（见 planAclRestriction 的入参校验）。
  // 推导（STANDARD_RIGHTS_READ/WRITE 都等于 READ_CONTROL = 0x00020000）：
  //   KEY_READ    = READ_CONTROL | KEY_QUERY_VALUE | KEY_ENUMERATE_SUB_KEYS | KEY_NOTIFY
  //               = 0x20000 | 0x1 | 0x8 | 0x10 = 0x00020019
  //   KEY_WRITE   = READ_CONTROL | KEY_SET_VALUE | KEY_CREATE_SUB_KEY
  //               = 0x20000 | 0x2 | 0x4 = 0x00020006
  //   KEY_EXECUTE = KEY_READ = 0x00020019（官方明确写 "KEY_EXECUTE ... equivalent to KEY_READ"）
  //   KEY_ALL_ACCESS = (STANDARD_RIGHTS_ALL | 上述全部) & ~SYNCHRONIZE
  //                  = (0x001F0000 | 0x003F) & ~0x00100000 = 0x000F003F
  // `accessName` 解析取**第一个**匹配的键名，所以别名顺序有意义：KEY_READ 必须排在 KEY_EXECUTE 之前。
  KEY_READ: 131097,
  KEY_EXECUTE: 131097,
  KEY_WRITE: 131078,
  KEY_ALL_ACCESS: 983103,
  READ_CONTROL: 131072,
  WRITE_DAC: 262144,
  WRITE_OWNER: 524288
});
var VALUE_ENCODERS = Object.freeze({
  REG_SZ: (value) => {
    if (typeof value !== "string") throw new TypeError("REG_SZ value must be a string");
    return Buffer2.from(`${value}\0`, "utf16le").toString("hex");
  },
  REG_EXPAND_SZ: (value) => {
    if (typeof value !== "string") throw new TypeError("REG_EXPAND_SZ value must be a string");
    return Buffer2.from(`${value}\0`, "utf16le").toString("hex");
  },
  REG_MULTI_SZ: (value) => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new TypeError("REG_MULTI_SZ value must be an array of strings");
    }
    return Buffer2.from(`${value.join("\0")}\0\0`, "utf16le").toString("hex");
  },
  REG_DWORD: (value) => {
    if (!Number.isInteger(value) || value < 0 || value > 4294967295) throw new TypeError("REG_DWORD must be a UINT32");
    return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
  },
  REG_DWORD_BIG_ENDIAN: (value) => {
    if (!Number.isInteger(value) || value < 0 || value > 4294967295) throw new TypeError("REG_DWORD_BIG_ENDIAN must be a UINT32");
    return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
  },
  REG_QWORD: (value) => {
    if (typeof value !== "bigint" || value < 0n || value > 0xffffffffffffffffn) throw new TypeError("REG_QWORD must be a UINT64 bigint");
    return `0x${value.toString(16).padStart(16, "0")}`;
  },
  REG_BINARY: (value) => {
    const buffer = Buffer2.isBuffer(value) ? value : Buffer2.from(String(value), "hex");
    return buffer.toString("hex");
  },
  REG_NONE: (value) => Buffer2.isBuffer(value) ? value.toString("hex") : String(value)
});
var VALUE_DECODERS = Object.freeze({
  REG_SZ: (hex) => stripTrailingNul(Buffer2.from(hex, "hex").toString("utf16le")),
  REG_EXPAND_SZ: (hex) => stripTrailingNul(Buffer2.from(hex, "hex").toString("utf16le")),
  REG_MULTI_SZ: (hex) => {
    const text = Buffer2.from(hex, "hex").toString("utf16le").replace(/\u0000+$/, "");
    return text.length === 0 ? [] : text.split("\0");
  },
  REG_DWORD: (hex) => Number.parseInt(hex, 16) >>> 0,
  REG_DWORD_BIG_ENDIAN: (hex) => Number.parseInt(hex, 16) >>> 0,
  REG_QWORD: (hex) => BigInt(hex),
  REG_BINARY: (hex) => Buffer2.from(hex, "hex").toString("hex"),
  REG_NONE: (hex) => hex
});
var HEX_ONLY = /^[0-9a-fA-F]*$/;
var HEX_PREFIXED_TYPES = /* @__PURE__ */ new Set(["REG_DWORD", "REG_DWORD_BIG_ENDIAN", "REG_QWORD"]);
var EMPTY_DATA_ALLOWED = /* @__PURE__ */ new Set(["REG_BINARY", "REG_NONE"]);
function assertShape(valueName, typeName, data) {
  const reject = (why) => {
    const error = new Error(`deserializeSnapshot: value ${JSON.stringify(valueName)} (${typeName}) ${why}`);
    error.code = "REG_SNAPSHOT_INVALID";
    throw error;
  };
  if (typeof data !== "string") {
    reject(`has non-string data ${JSON.stringify(data)}; data must be an encoded string`);
  }
  const prefixed = HEX_PREFIXED_TYPES.has(typeName);
  const body = prefixed && /^0x/i.test(data) ? data.slice(2) : data;
  if (prefixed && !/^0x/i.test(data)) {
    reject(`has data ${JSON.stringify(data)} without the required "0x" prefix`);
  }
  if (!HEX_ONLY.test(body)) {
    const shown = data.length > 48 ? `${data.slice(0, 48)}\u2026` : data;
    reject(
      `has non-hexadecimal data ${JSON.stringify(shown)}; refusing to decode (Buffer.from(bad,"hex") silently truncates at the first bad character, which would be read as an empty value)`
    );
  }
  if (body.length % 2 !== 0) {
    reject(`has odd-length hexadecimal data (${body.length} hex chars); hex must encode whole bytes`);
  }
  if (body.length === 0 && !EMPTY_DATA_ALLOWED.has(typeName)) {
    reject("has empty data; only REG_BINARY and REG_NONE may legitimately serialise to the empty string");
  }
}
var __internal2 = { compareName, stripTrailingNul, REG_TYPE_NAMES, decodeGuard: true };
function guardedDecoder(valueName, typeName, decoder) {
  return (data) => {
    if (__internal2.decodeGuard) assertShape(valueName, typeName, data);
    try {
      return decoder(data);
    } catch (error) {
      const wrapped = new Error(
        `deserializeSnapshot: value ${JSON.stringify(valueName)} (${typeName}) failed to decode: ${error.message}`
      );
      wrapped.code = "REG_SNAPSHOT_INVALID";
      throw wrapped;
    }
  };
}
function stripTrailingNul(text) {
  return text.endsWith("\0") ? text.slice(0, -1) : text;
}
function registryTypeName(type) {
  const reject = (why) => {
    const error = new Error(`registryTypeName: ${why}`);
    error.code = "REG_TYPE_UNKNOWN";
    throw error;
  };
  if (typeof type === "number") {
    const name = REG_TYPE_NAMES[type];
    if (name === void 0) reject(`unknown numeric registry type ${type} (winreg.h REG_* values are 0..11)`);
    return name;
  }
  if (typeof type === "string") {
    const upper = type.toUpperCase();
    if (upper in REG_TYPES) return upper;
    reject(`unknown registry type ${JSON.stringify(type)}; expected a REG_* name or a winreg.h numeric value`);
  }
  reject(`registry type must be a string or number, got ${typeof type} ${JSON.stringify(type)}`);
  return void 0;
}
function encodeRegistryValue(type, value) {
  const name = registryTypeName(type);
  const encoder = VALUE_ENCODERS[name];
  if (typeof encoder !== "function") {
    const error = new Error(
      `encodeRegistryValue: ${name} has no codec in this module; it cannot be staged faithfully (refusing instead of silently reinterpreting the value)`
    );
    error.code = "REG_TYPE_UNSUPPORTED";
    throw error;
  }
  try {
    return encoder(value);
  } catch (error) {
    const wrapped = new Error(`encodeRegistryValue: (${name}) ${error.message}`);
    wrapped.code = error.code === "REG_TYPE_UNSUPPORTED" ? error.code : "REG_SNAPSHOT_INVALID";
    throw wrapped;
  }
}
function decodeRegistryValue(type, data, valueName = "(value)") {
  const name = registryTypeName(type);
  const decoder = VALUE_DECODERS[name];
  if (typeof decoder !== "function") {
    const error = new Error(
      `decodeRegistryValue: ${name} has no codec in this module; it cannot be read back faithfully (refusing instead of silently reinterpreting the value)`
    );
    error.code = "REG_TYPE_UNSUPPORTED";
    throw error;
  }
  return guardedDecoder(valueName, name, decoder)(data);
}
function parseRegistryPath(fullPath) {
  if (typeof fullPath !== "string" || fullPath.length === 0) {
    throw new TypeError("registry path must be a non-empty string");
  }
  const normalized = fullPath.trim().replace(/\//g, "\\");
  const separator = normalized.indexOf("\\");
  const head = (separator === -1 ? normalized : normalized.slice(0, separator)).toUpperCase();
  const rest = separator === -1 ? "" : normalized.slice(separator + 1);
  const handle = HIVE_HANDLES[head];
  if (handle === void 0) {
    const error = new Error(
      `unknown registry root ${JSON.stringify(head)} in ${JSON.stringify(fullPath)}; expected one of ${Object.keys(HIVE_HANDLES).join(", ")}`
    );
    error.code = "REG_HIVE_UNKNOWN";
    throw error;
  }
  const canonicalName = HIVE_CANONICAL[head];
  const subKey = rest.replace(/\\+$/, "");
  return { hive: canonicalName, handle, subKey, canonical: subKey.length > 0 ? `${canonicalName}\\${subKey}` : canonicalName };
}
function normalizeSnapshot(raw = {}) {
  const root = typeof raw.root === "string" && raw.root.length > 0 ? raw.root.trim().replace(/\//g, "\\") : void 0;
  if (!root) {
    const error = new Error("normalizeSnapshot: raw.root must be a non-empty registry path");
    error.code = "REG_SNAPSHOT_INVALID";
    throw error;
  }
  const { canonical: canonical3 } = parseRegistryPath(root);
  const exists = raw.exists === true;
  const accessDenied = raw.accessDenied === true;
  if (!exists && !accessDenied) {
    return Object.freeze({
      root: canonical3,
      exists: false,
      accessDenied: false,
      errorCode: raw.errorCode ?? REG_STATUS.ERROR_FILE_NOT_FOUND,
      subKeys: Object.freeze([]),
      values: Object.freeze({}),
      sddl: void 0
    });
  }
  if (accessDenied) {
    return Object.freeze({
      root: canonical3,
      exists: true,
      // 无法证明不存在；保守记为"存在但读不到"
      accessDenied: true,
      errorCode: raw.errorCode ?? REG_STATUS.ERROR_ACCESS_DENIED,
      subKeys: Object.freeze([]),
      values: Object.freeze({}),
      sddl: void 0
    });
  }
  const seenSubKeys = /* @__PURE__ */ new Set();
  const subKeys = Object.freeze(
    [...raw.subKeys ?? []].filter((name) => typeof name === "string" && name.length > 0).sort(compareName).filter((name) => {
      const folded = name.toLowerCase();
      if (seenSubKeys.has(folded)) return false;
      seenSubKeys.add(folded);
      return true;
    })
  );
  const values = {};
  const seenValueNames = /* @__PURE__ */ new Set();
  for (const [name, entry] of Object.entries(raw.values ?? {}).sort(([left], [right]) => compareName(left, right))) {
    const folded = name.toLowerCase();
    if (seenValueNames.has(folded)) continue;
    seenValueNames.add(folded);
    if (entry === null || typeof entry !== "object") {
      const error = new Error(`normalizeSnapshot: value ${JSON.stringify(name)} must be {type, data}`);
      error.code = "REG_SNAPSHOT_INVALID";
      throw error;
    }
    const typeName = typeof entry.type === "number" ? REG_TYPE_NAMES[entry.type] : entry.type;
    if (typeof typeName !== "string" || !(typeName in REG_TYPES)) {
      const error = new Error(
        `normalizeSnapshot: value ${JSON.stringify(name)} has unknown type ${JSON.stringify(entry.type)}`
      );
      error.code = "REG_SNAPSHOT_INVALID";
      throw error;
    }
    const encoder = VALUE_ENCODERS[typeName];
    let encoded;
    try {
      encoded = encoder(entry.data);
    } catch (error) {
      const wrapped = new Error(`normalizeSnapshot: value ${JSON.stringify(name)} (${typeName}): ${error.message}`);
      wrapped.code = "REG_SNAPSHOT_INVALID";
      throw wrapped;
    }
    values[name] = Object.freeze({ type: typeName, data: encoded });
  }
  const sortedValues = Object.freeze(
    Object.fromEntries(
      Object.keys(values).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0).map((key) => [key, values[key]])
    )
  );
  return Object.freeze({
    root: canonical3,
    exists: true,
    accessDenied: false,
    errorCode: REG_STATUS.ERROR_SUCCESS,
    subKeys,
    values: sortedValues,
    sddl: typeof raw.sddl === "string" ? raw.sddl : void 0
  });
}
function serializeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new TypeError("serializeSnapshot: snapshot must be an object");
  return JSON.stringify(
    {
      root: snapshot.root,
      exists: snapshot.exists === true,
      accessDenied: snapshot.accessDenied === true,
      errorCode: snapshot.errorCode ?? 0,
      subKeys: [...snapshot.subKeys ?? []],
      values: Object.fromEntries(
        Object.entries(snapshot.values ?? {}).map(([name, entry]) => [name, { type: entry.type, data: entry.data }])
      ),
      sddl: snapshot.sddl
    },
    null,
    2
  );
}
var CHANGE_KINDS = Object.freeze(["key-created", "key-deleted", "key-access-changed", "value-added", "value-deleted", "value-changed", "security-changed"]);
function diffSnapshots(before, after) {
  if (!before || !after) throw new TypeError("diffSnapshots requires two snapshots");
  if (before.root !== after.root) {
    const error = new Error(`diffSnapshots: root mismatch (${before.root} vs ${after.root}) \u2014 comparing different keys is meaningless`);
    error.code = "REG_DIFF_ROOT_MISMATCH";
    throw error;
  }
  const changes = [];
  if (!before.exists && after.exists) changes.push({ kind: "key-created", key: after.root });
  if (before.exists && !after.exists) changes.push({ kind: "key-deleted", key: before.root });
  if (before.accessDenied !== after.accessDenied) {
    changes.push({
      kind: "key-access-changed",
      key: after.root,
      // `before` / `after` 是"可读性"标签，**不是** SDDL。
      // 阶段 B 实测缺陷：初版只给了这两个标签，而 `planRollback` 却把 `change.before`
      // 当 SDDL 用（`sddl: change.before`, `reversibility: EXACT`），于是产出一条
      // `{op:'restore-sddl', sddl:'readable', reversibility:'EXACT'}` ——
      // 一个"承诺精确回滚"却携带无意义 SDDL 的计划。要还原权限必须有**执行前的 SDDL**，
      // 所以这里把快照里真实存在的 SDDL 一并带上（没有就是 null，由 planRollback 标 IMPOSSIBLE）。
      before: before.accessDenied ? "access-denied" : "readable",
      after: after.accessDenied ? "access-denied" : "readable",
      sddlBefore: typeof before.sddl === "string" && before.sddl.length > 0 ? before.sddl : null,
      sddlAfter: typeof after.sddl === "string" && after.sddl.length > 0 ? after.sddl : null
    });
  }
  const beforeSub = new Set(before.subKeys ?? []);
  const afterSub = new Set(after.subKeys ?? []);
  for (const name of [...afterSub].filter((n) => !beforeSub.has(n)).sort(compareName)) {
    changes.push({ kind: "subkey-added", key: `${after.root}\\${name}` });
  }
  for (const name of [...beforeSub].filter((n) => !afterSub.has(n)).sort(compareName)) {
    changes.push({ kind: "subkey-deleted", key: `${before.root}\\${name}` });
  }
  const beforeValues = before.values ?? {};
  const afterValues = after.values ?? {};
  for (const name of Object.keys(afterValues).sort(compareName)) {
    if (!(name in beforeValues)) {
      changes.push({ kind: "value-added", key: after.root, valueName: name, after: { ...afterValues[name] } });
      continue;
    }
    const left = beforeValues[name];
    const right = afterValues[name];
    if (left.type !== right.type) {
      changes.push({
        kind: "value-changed",
        key: after.root,
        valueName: name,
        reason: "type",
        before: { ...left },
        after: { ...right }
      });
      continue;
    }
    if (left.data !== right.data) {
      changes.push({
        kind: "value-changed",
        key: after.root,
        valueName: name,
        reason: "data",
        before: { ...left },
        after: { ...right }
      });
    }
  }
  for (const name of Object.keys(beforeValues).sort(compareName)) {
    if (!(name in afterValues)) {
      changes.push({ kind: "value-deleted", key: before.root, valueName: name, before: { ...beforeValues[name] } });
    }
  }
  if ((before.sddl ?? null) !== (after.sddl ?? null)) {
    changes.push({ kind: "security-changed", key: after.root, before: before.sddl, after: after.sddl });
  }
  const summary = changes.reduce((acc, change) => {
    acc[change.kind] = (acc[change.kind] ?? 0) + 1;
    return acc;
  }, {});
  return { changes, summary };
}
function compareName(a, b) {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}
var REVERSIBILITY = Object.freeze({
  EXACT: "exact",
  // 有原值，可精确还原
  LOSSY: "lossy",
  // 能还原到"记录到的状态"，但记录本身可能不完整（例如只读了值没读权限）
  IMPOSSIBLE: "impossible"
  // 无原值 → 只能删除
});
function planRollback(changes, options = {}) {
  if (!Array.isArray(changes)) throw new TypeError("planRollback: changes must be an array");
  const operations = [];
  const warnings = [];
  for (const change of changes) {
    const fullPath = change.key ?? options.rootPath;
    if (typeof fullPath !== "string" || fullPath.length === 0) {
      const error = new Error(`planRollback: change without a key path: ${JSON.stringify(change)}`);
      error.code = "REG_ROLLBACK_INVALID";
      throw error;
    }
    const { hive, subKey, canonical: canonical3 } = parseRegistryPath(fullPath);
    const needsElevation = hive === "HKLM" || hive === "HKU" || hive === "HKCR" || hive === "HKCC";
    switch (change.kind) {
      case "key-created":
        operations.push({
          op: "delete-key",
          hive,
          subKey,
          path: canonical3,
          reversibility: REVERSIBILITY.LOSSY,
          needsElevation,
          reason: "\u6574\u4E2A\u952E\u5728\u6267\u884C\u671F\u95F4\u88AB\u521B\u5EFA\uFF1B\u5220\u9664\u5B83\u4F1A\u8FDE\u540C\u5176\u4E2D\u672A\u88AB\u5FEB\u7167\u8BB0\u5F55\u7684\u503C\u4E00\u8D77\u4E22\u5931"
        });
        break;
      case "key-deleted":
        operations.push({
          op: "recreate-key",
          hive,
          subKey,
          path: canonical3,
          reversibility: REVERSIBILITY.IMPOSSIBLE,
          needsElevation,
          reason: "\u952E\u7684\u539F\u503C\u4E0D\u5728\u5FEB\u7167\u4E2D\uFF08\u5FEB\u7167\u53EA\u8BB0\u5F55\u5B83\u7684\u5B58\u5728\u6027\uFF09\uFF1B\u4EC5\u80FD\u91CD\u5EFA\u7A7A\u952E\uFF0C\u5185\u5BB9\u4E0D\u53EF\u6062\u590D"
        });
        warnings.push(`key-deleted ${canonical3}: \u5185\u5BB9\u4E0D\u53EF\u6062\u590D\uFF08IMPOSSIBLE\uFF09\uFF0C\u53EA\u80FD\u91CD\u5EFA\u7A7A\u952E`);
        break;
      case "key-access-changed": {
        const sddlBefore = typeof change.sddlBefore === "string" && change.sddlBefore.length > 0 ? change.sddlBefore : null;
        operations.push({
          op: "restore-sddl",
          hive,
          subKey,
          path: canonical3,
          sddl: sddlBefore,
          readabilityBefore: change.before,
          readabilityAfter: change.after,
          reversibility: sddlBefore === null ? REVERSIBILITY.IMPOSSIBLE : REVERSIBILITY.EXACT,
          // 不写死 true：HKCU 的键通常由当前用户拥有（WRITE_DAC 已持有），只有 HKLM/HKU/HKCR/HKCC 才需要管理员。
          // 阶段 B 实测缺陷：初版这里写死 `true`，与同一分支 reason 里写的"HKLM 需管理员"自相矛盾，
          // 会让纯 HKCU 的回滚计划也报 requiresElevation=true（诱导无谓的提权）。
          needsElevation,
          reason: sddlBefore === null ? '\u6267\u884C\u524D\u540E"\u53EF\u8BFB\u6027"\u53D1\u751F\u4E86\u53D8\u5316\uFF0C\u4F46\u5DEE\u5F02\u8BB0\u5F55\u91CC\u6CA1\u6709\u6267\u884C\u524D\u7684 SDDL\uFF08\u9700\u8981\u6267\u884C\u524D\u5E26 READ_CONTROL \u843D\u76D8 SDDL\uFF09\uFF0C\u56E0\u6B64\u6743\u9650\u65E0\u6CD5\u8FD8\u539F' : "\u7528\u6267\u884C\u524D\u8BB0\u5F55\u7684 SDDL \u901A\u8FC7 RegSetKeySecurity \u8FD8\u539F\uFF08\u9700\u8981 WRITE_DAC\uFF09"
        });
        if (sddlBefore === null) {
          warnings.push(`key-access-changed ${canonical3}: \u65E0\u53EF\u8FD8\u539F\u7684\u539F\u59CB SDDL \u2014\u2014 \u5DEE\u5F02\u8BB0\u5F55\u91CC\u7684 before/after \u662F"\u53EF\u8BFB\u6027"\u6807\u7B7E\uFF0C\u4E0D\u662F SDDL`);
        }
        break;
      }
      case "security-changed":
        operations.push({
          op: "restore-sddl",
          hive,
          subKey,
          path: canonical3,
          sddl: change.before,
          reversibility: change.before === void 0 || change.before === null ? REVERSIBILITY.IMPOSSIBLE : REVERSIBILITY.EXACT,
          // 同上：needsElevation 由 hive 决定，不写死 true（HKCU 的 WRITE_DAC 不需要提权）
          needsElevation,
          reason: "\u6309\u6267\u884C\u524D\u8BB0\u5F55\u7684 SDDL \u8FD8\u539F\u5B89\u5168\u63CF\u8FF0\u7B26\uFF08\u9700\u8981 WRITE_DAC\uFF1BHKLM \u9700\u7BA1\u7406\u5458\uFF09"
        });
        break;
      case "value-added":
        operations.push({
          op: "delete-value",
          hive,
          subKey,
          path: canonical3,
          valueName: change.valueName,
          reversibility: REVERSIBILITY.EXACT,
          needsElevation,
          reason: "\u8BE5\u503C\u5728\u6267\u884C\u671F\u95F4\u51FA\u73B0\uFF0C\u5220\u9664\u5B83\u5373\u56DE\u5230\u539F\u72B6"
        });
        break;
      case "value-deleted":
        operations.push({
          op: "set-value",
          hive,
          subKey,
          path: canonical3,
          valueName: change.valueName,
          type: change.before?.type,
          data: change.before?.data,
          reversibility: change.before === void 0 ? REVERSIBILITY.IMPOSSIBLE : REVERSIBILITY.EXACT,
          needsElevation,
          reason: change.before === void 0 ? "\u6CA1\u6709\u539F\u503C\u7684\u8BB0\u5F55\uFF0C\u65E0\u6CD5\u8FD8\u539F" : "\u7528\u6267\u884C\u524D\u8BB0\u5F55\u7684\u7C7B\u578B\u4E0E\u6570\u636E\u5199\u56DE"
        });
        if (change.before === void 0) warnings.push(`value-deleted ${canonical3}\\${change.valueName}: \u65E0\u539F\u503C\u8BB0\u5F55\uFF0C\u4E0D\u53EF\u8FD8\u539F`);
        break;
      case "value-changed":
        operations.push({
          op: "set-value",
          hive,
          subKey,
          path: canonical3,
          valueName: change.valueName,
          type: change.before?.type,
          data: change.before?.data,
          reversibility: change.before === void 0 ? REVERSIBILITY.IMPOSSIBLE : REVERSIBILITY.EXACT,
          needsElevation,
          reason: `\u8FD8\u539F\u88AB\u4FEE\u6539\u7684\u503C\uFF08\u53D8\u66F4\u7EF4\u5EA6\uFF1A${change.reason ?? "unknown"}\uFF09`
        });
        break;
      case "subkey-added":
        operations.push({
          op: "delete-key",
          hive,
          subKey,
          path: canonical3,
          reversibility: REVERSIBILITY.LOSSY,
          needsElevation,
          reason: "\u5B50\u952E\u5728\u6267\u884C\u671F\u95F4\u51FA\u73B0\uFF1B\u53EA\u8BB0\u5F55\u4E86\u540D\u5B57\uFF0C\u672A\u9012\u5F52\u5FEB\u7167\u5176\u5185\u5BB9"
        });
        warnings.push(`subkey-added ${canonical3}: \u53EA\u8BB0\u5F55\u4E86\u540D\u5B57\uFF0C\u9012\u5F52\u56DE\u6EDA\u9700\u8981\u5148\u9012\u5F52\u5FEB\u7167\uFF08\u5F53\u524D\u5B9E\u73B0\u4E0D\u9012\u5F52\uFF09`);
        break;
      case "subkey-deleted":
        operations.push({
          op: "recreate-key",
          hive,
          subKey,
          path: canonical3,
          reversibility: REVERSIBILITY.IMPOSSIBLE,
          needsElevation,
          reason: "\u5B50\u952E\u88AB\u5220\u9664\u4E14\u6CA1\u6709\u9012\u5F52\u5FEB\u7167\uFF0C\u5185\u5BB9\u4E0D\u53EF\u6062\u590D"
        });
        warnings.push(`subkey-deleted ${canonical3}: \u5185\u5BB9\u4E0D\u53EF\u6062\u590D\uFF08IMPOSSIBLE\uFF09`);
        break;
      default:
        throw Object.assign(new Error(`planRollback: unknown change kind ${JSON.stringify(change.kind)}`), {
          code: "REG_ROLLBACK_INVALID"
        });
    }
  }
  const order = { "delete-value": 0, "delete-key": 1, "recreate-key": 2, "set-value": 3, "restore-sddl": 4 };
  operations.sort((a, b) => (order[a.op] ?? 9) - (order[b.op] ?? 9));
  const count = (level) => operations.filter((op) => op.reversibility === level).length;
  if (count(REVERSIBILITY.IMPOSSIBLE) > 0) {
    warnings.push(
      `${count(REVERSIBILITY.IMPOSSIBLE)} \u9879\u56DE\u6EDA\u662F\u4E0D\u53EF\u80FD\u7684\uFF08IMPOSSIBLE\uFF09\u2014\u2014 \u4E0D\u8981\u628A\u8FD9\u4EFD\u8BA1\u5212\u63CF\u8FF0\u4E3A"\u53EF\u5B8C\u5168\u56DE\u6EDA"`
    );
  }
  if (count(REVERSIBILITY.LOSSY) > 0) {
    warnings.push(`${count(REVERSIBILITY.LOSSY)} \u9879\u56DE\u6EDA\u662F LOSSY \u7684\uFF08\u80FD\u6267\u884C\u4F46\u53EF\u80FD\u4E22\u5931\u672A\u8BB0\u5F55\u7684\u5185\u5BB9\uFF09`);
  }
  return {
    operations,
    warnings,
    exact: count(REVERSIBILITY.EXACT),
    lossy: count(REVERSIBILITY.LOSSY),
    impossible: count(REVERSIBILITY.IMPOSSIBLE)
  };
}
var ACL_PRINCIPALS = Object.freeze(["appcontainer", "restricted", "users"]);

// src/registry-stage.ts
var REGISTRY_STAGE_VERSION = 1;
var REGISTRY_STAGE_SUBDIR = "registry";
var OVERLAY_HIVE_NAME = "overlay.hive";
var OVERLAY_JOURNAL_NAME = "overlay.journal";
var OVERLAY_STATE_NAME = "overlay.state.json";
var OVERLAY_DISCARDED_NAME = "overlay.discarded.journal";
var REGISTRY_CANDIDATE_SOURCE = "registry-stage";
var REGISTRY_CANDIDATE_ORIGIN = "registry";
var REG_STAGE_KIND = Object.freeze({
  CREATE_KEY: 1,
  DELETE_KEY: 2,
  SET_VALUE: 3,
  DELETE_VALUE: 4,
  HARD_DENY: 5,
  UNSTAGED: 6
});
var KIND_NAME = Object.freeze(
  Object.fromEntries(Object.entries(REG_STAGE_KIND).map(([name, value]) => [value, name]))
);
var REG_STAGE_FLAGS = Object.freeze({
  HARD_DENY: 1,
  HAS_VALUE_NAME: 2,
  HAS_DATA: 4,
  VOLATILE: 8,
  /** 这是一条"透传真实 API"的记录（kind=UNSTAGED 必须置位） */
  UNSTAGED: 16
});
var REG_STAGE_JOURNAL_MAGIC = 1196577604;
var REG_STAGE_RECORD_OFFSETS = Object.freeze({
  magic: 0,
  version: 4,
  kind: 6,
  type: 8,
  flags: 10,
  pathChars: 12,
  nameChars: 16,
  dataBytes: 20,
  status: 24,
  reserved: 28,
  total: 32
});
var REG_STAGE_RECORD_SIZE = REG_STAGE_RECORD_OFFSETS.total;
var REG_STAGE_ABI_VERSION = 1;
var HARD_DENY_STATUS = REG_STATUS.ERROR_ACCESS_DENIED;
var REG_LOAD_APP_KEY_FLAGS = Object.freeze({
  REG_PROCESS_APPKEY: 1,
  REG_USE_CURRENT_SECURITY_CONTEXT: 2
});
var REG_OPTIONS = Object.freeze({
  REG_OPTION_NON_VOLATILE: 0,
  REG_OPTION_VOLATILE: 1,
  REG_OPTION_CREATE_LINK: 2,
  REG_OPTION_BACKUP_RESTORE: 4,
  REG_OPTION_OPEN_LINK: 8
});
var KEY_WOW64 = Object.freeze({
  KEY_WOW64_64KEY: 256,
  KEY_WOW64_32KEY: 512
});
var REG_HIVES_STAGEABLE = Object.freeze(["HKCR", "HKCU", "HKLM", "HKU", "HKCC"]);
var REG_HIVES_HARD_DENY = Object.freeze({
  HKPD: "HKEY_PERFORMANCE_DATA \u662F\u6027\u80FD\u8BA1\u6570\u5668\u4F2A hive\uFF08\u65E0\u540E\u5907\u914D\u7F6E\u5355\u5143\u6587\u4EF6\uFF09\uFF0C\u6CA1\u6709\u53EF\u6302\u8F7D\u8986\u76D6\u5C42\u7684\u4F4D\u7F6E"
});
var REG_STAGE_UNSUPPORTED_TYPES = Object.freeze([
  "REG_LINK",
  "REG_RESOURCE_LIST",
  "REG_FULL_RESOURCE_DESCRIPTOR",
  "REG_RESOURCE_REQUIREMENTS_LIST"
]);
var REG_STAGE_HOOKED_APIS = Object.freeze([
  "RegCreateKeyExW",
  "RegOpenKeyExW",
  "RegSetValueExW",
  "RegQueryValueExW",
  "RegDeleteKeyExW",
  "RegDeleteValueW",
  "RegEnumKeyExW",
  "RegEnumValueW"
]);
var REG_STAGE_HARD_DENY_APIS = Object.freeze({
  RegSetKeySecurity: "app hive \u5185\u6240\u6709\u952E\u5171\u4EAB\u540C\u4E00\u4E2A\u5B89\u5168\u63CF\u8FF0\u7B26\uFF0C\u4E14 [\u5B98\u65B9] \u660E\u786E\u7981\u6B62\u5BF9 app hive \u5185\u7684\u952E\u8C03\u7528 RegSetKeySecurity \u21D2 SD \u53D8\u66F4\u65E0\u6CD5\u6682\u5B58",
  RegLoadKey: "\u6574\u68F5 hive \u7684\u52A0\u8F7D\u4E0D\u5728\u8986\u76D6\u8303\u56F4\u5185\uFF08\u4F1A\u6539\u53D8\u5168\u5C40\u547D\u540D\u7A7A\u95F4\uFF09",
  RegUnLoadKey: "\u6574\u68F5 hive \u7684\u5378\u8F7D\u4E0D\u5728\u8986\u76D6\u8303\u56F4\u5185",
  RegSaveKey: "\u6574\u68F5 hive \u7684\u5BFC\u51FA\u4E0D\u5728\u8986\u76D6\u8303\u56F4\u5185\uFF08\u4F1A\u628A\u8986\u76D6\u5C42\u5F53\u6210\u771F\u5B9E hive \u843D\u76D8\uFF09",
  RegSaveKeyEx: "\u6574\u68F5 hive \u7684\u5BFC\u51FA\u4E0D\u5728\u8986\u76D6\u8303\u56F4\u5185",
  RegRestoreKey: "\u6574\u68F5 hive \u7684\u8FD8\u539F\u4E0D\u5728\u8986\u76D6\u8303\u56F4\u5185",
  RegReplaceKey: "\u6574\u68F5 hive \u7684\u66FF\u6362\u4E0D\u5728\u8986\u76D6\u8303\u56F4\u5185",
  RegRenameKey: "\u952E\u91CD\u547D\u540D\u6CA1\u6709\u5BF9\u5E94\u7684\u6682\u5B58\u8BED\u4E49\uFF08\u8986\u76D6\u5C42\u6309\u8DEF\u5F84\u7D22\u5F15\uFF0C\u91CD\u547D\u540D\u4F1A\u7834\u574F\u5019\u9009\u7684\u8DEF\u5F84\u8EAB\u4EFD\uFF09",
  RegCopyTree: "\u8DE8\u952E\u6574\u6811\u590D\u5236\u4E0D\u5728\u8986\u76D6\u8303\u56F4\u5185\uFF08RegCopyTreeW \u672A\u88AB hook\uFF09",
  RegCreateKeyTransactedW: "\u4E8B\u52A1\u6CE8\u518C\u8868 API \u4E0E\u8986\u76D6\u5C42\u7684\u4E8B\u52A1\u8BED\u4E49\u4E0D\u540C\uFF0C\u6682\u5B58\u4F1A\u7ED9\u51FA\u865A\u5047\u7684\u539F\u5B50\u6027",
  RegDeleteKeyTransactedW: "\u4E8B\u52A1\u6CE8\u518C\u8868 API \u4E0E\u8986\u76D6\u5C42\u7684\u4E8B\u52A1\u8BED\u4E49\u4E0D\u540C",
  RegOpenKeyTransactedW: "\u4E8B\u52A1\u6CE8\u518C\u8868 API \u4E0E\u8986\u76D6\u5C42\u7684\u4E8B\u52A1\u8BED\u4E49\u4E0D\u540C",
  RegConnectRegistryW: "\u8FDC\u7A0B\u6CE8\u518C\u8868\u53E5\u67C4\u4E0D\u53EF\u80FD\u88AB\u91CD\u5B9A\u5411\u5230\u672C\u5730\u8986\u76D6\u5C42",
  RegConnectRegistryExW: "\u8FDC\u7A0B\u6CE8\u518C\u8868\u53E5\u67C4\u4E0D\u53EF\u80FD\u88AB\u91CD\u5B9A\u5411\u5230\u672C\u5730\u8986\u76D6\u5C42",
  RegOverridePredefKey: '\u9884\u5B9A\u4E49\u952E\u91CD\u5B9A\u5411\u4F1A\u628A\u8986\u76D6\u5C42\u7684\u8DEF\u5F84\u6620\u5C04\u6574\u4F53\u6253\u4E71\uFF08\u5B83\u662F"\u53E6\u4E00\u4E2A 8.3 \u7EA7\u522B\u7684\u91CD\u5B9A\u5411\u5668"\uFF0C\u4E0E\u8986\u76D6\u5C42\u53E0\u52A0\u65E0\u6CD5\u63A8\u7406\uFF09',
  RegOpenUserClassesRoot: "\u6309\u4EE4\u724C\u6253\u5F00\u7684 HKCR \u89C6\u56FE\u6CA1\u6709\u7A33\u5B9A\u7684\u53EF\u6682\u5B58\u8DEF\u5F84\u8EAB\u4EFD",
  RegOpenCurrentUser: "\u6309\u4EE4\u724C\u6253\u5F00\u7684 HKCU \u89C6\u56FE\u6CA1\u6709\u7A33\u5B9A\u7684\u53EF\u6682\u5B58\u8DEF\u5F84\u8EAB\u4EFD",
  NtCreateKey: "\u539F\u751F API \u7ED5\u8FC7 Reg* \u5C42\uFF1B\u8986\u76D6\u5C42\u53EA hook winreg \u7684 8 \u4E2A\u5165\u53E3\uFF0C\u5FC5\u987B fail-closed",
  NtOpenKey: "\u539F\u751F API \u7ED5\u8FC7 Reg* \u5C42\uFF08\u89C1 NtCreateKey\uFF09",
  NtSetValueKey: "\u539F\u751F API \u7ED5\u8FC7 Reg* \u5C42\uFF08\u89C1 NtCreateKey\uFF09",
  NtDeleteKey: "\u539F\u751F API \u7ED5\u8FC7 Reg* \u5C42\uFF08\u89C1 NtCreateKey\uFF09",
  NtDeleteValueKey: "\u539F\u751F API \u7ED5\u8FC7 Reg* \u5C42\uFF08\u89C1 NtCreateKey\uFF09",
  ZwCreateKey: "\u539F\u751F API \u7684 Zw \u522B\u540D\uFF0C\u540C\u6837\u7ED5\u8FC7 Reg* \u5C42",
  ZwOpenKey: "\u539F\u751F API \u7684 Zw \u522B\u540D\uFF0C\u540C\u6837\u7ED5\u8FC7 Reg* \u5C42",
  ZwSetValueKey: "\u539F\u751F API \u7684 Zw \u522B\u540D\uFF0C\u540C\u6837\u7ED5\u8FC7 Reg* \u5C42"
});
var REG_STAGE_HARD_DENY_OPTIONS = Object.freeze([
  {
    flag: REG_OPTIONS.REG_OPTION_CREATE_LINK,
    name: "REG_OPTION_CREATE_LINK",
    reason: '\u7B26\u53F7\u94FE\u63A5\u952E\uFF08REG_OPTION_CREATE_LINK\uFF09\u5728\u8986\u76D6\u5C42\u91CC\u6CA1\u6709\u7B49\u4EF7\u7269\uFF1B\u6682\u5B58\u5B83\u4F1A\u8BA9"\u94FE\u63A5"\u53D8\u6210"\u666E\u901A\u952E"'
  },
  {
    flag: REG_OPTIONS.REG_OPTION_BACKUP_RESTORE,
    name: "REG_OPTION_BACKUP_RESTORE",
    reason: "REG_OPTION_BACKUP_RESTORE \u4F1A\u7ED5\u8FC7 ACL \u5E76\u6539\u53D8\u53E5\u67C4\u8BED\u4E49\uFF0C\u8986\u76D6\u5C42\u65E0\u6CD5\u5FE0\u5B9E\u590D\u73B0"
  },
  {
    flag: REG_OPTIONS.REG_OPTION_OPEN_LINK,
    name: "REG_OPTION_OPEN_LINK",
    reason: "REG_OPTION_OPEN_LINK \u8981\u6C42\u6253\u5F00\u94FE\u63A5\u672C\u8EAB\u800C\u975E\u76EE\u6807\uFF0C\u8986\u76D6\u5C42\u6CA1\u6709\u94FE\u63A5\u5BF9\u8C61"
  }
]);
var REG_STAGE_HARD_DENY_SAM = Object.freeze([]);
var REG_STAGE_UNSTAGED_SAM = Object.freeze([
  {
    flag: KEY_WOW64.KEY_WOW64_64KEY,
    name: "KEY_WOW64_64KEY",
    appliesTo: "wow64-process",
    reason: "KEY_WOW64_64KEY \u5728 64 \u4F4D\u8FDB\u7A0B\u91CC\u662F\u6587\u6863\u5316\u7684 no-op\uFF08\u4E0D\u662F\u89C6\u56FE\u8BF7\u6C42 \u21D2 \u5FC5\u987B\u8D70\u6B63\u5E38\u6682\u5B58\u8DEF\u5F84\uFF09\uFF1B\u53EA\u6709 WOW64 \u8FDB\u7A0B\u91CC\u5B83\u624D\u771F\u7684\u6307\u5411\u53E6\u4E00\u4E2A hive \u4F4D\u7F6E\uFF0C\u90A3\u65F6\u6309 unstaged \u900F\u4F20\uFF08x64 shim \u4E0D\u4F1A\u88AB\u6CE8\u5165 WOW64 \u8FDB\u7A0B\uFF09"
  },
  {
    flag: KEY_WOW64.KEY_WOW64_32KEY,
    name: "KEY_WOW64_32KEY",
    appliesTo: "any",
    reason: "KEY_WOW64_32KEY \u6307\u5411**\u53E6\u4E00\u4E2A hive \u4F4D\u7F6E**\uFF0832 \u4F4D\u89C6\u56FE\uFF09\uFF0C\u8986\u76D6\u5C42\u6CA1\u6709\u89C6\u56FE\u6982\u5FF5\uFF1A\u6682\u5B58\u5B83\u4F1A\u628A\u503C\u5199\u5230\u9519\u7684\u4F4D\u7F6E \u21D2 \u4E0D\u53EF\u6682\u5B58 \u21D2 \u900F\u4F20\u771F\u5B9E API \u5E76\u8BB0 UNSTAGED\uFF08\u4E0D\u518D\u662F ERROR_ACCESS_DENIED \u786C\u62D2\uFF09"
  }
]);
var REG_STAGE_UNSTAGED_REASON = Object.freeze({
  WOW64_32KEY: 1,
  WOW64_VIEW_IN_WOW64_PROCESS: 2,
  UNRESOLVABLE_BASE_HANDLE: 3,
  BARE_HIVE_ROOT: 4
});
var UNSTAGED_REASON_NAME = Object.freeze(
  Object.fromEntries(Object.entries(REG_STAGE_UNSTAGED_REASON).map(([name, value]) => [value, name]))
);
var REG_STAGE_OP = Object.freeze({
  CREATE_KEY: "create-key",
  DELETE_KEY: "delete-key",
  SET_VALUE: "set-value",
  DELETE_VALUE: "delete-value"
});
var API_BY_OP = Object.freeze({
  "create-key": "RegCreateKeyExW",
  "delete-key": "RegDeleteKeyExW",
  "set-value": "RegSetValueExW",
  "delete-value": "RegDeleteValueW"
});
var KIND_BY_OP = Object.freeze({
  "create-key": REG_STAGE_KIND.CREATE_KEY,
  "delete-key": REG_STAGE_KIND.DELETE_KEY,
  "set-value": REG_STAGE_KIND.SET_VALUE,
  "delete-value": REG_STAGE_KIND.DELETE_VALUE
});
var OP_BY_KIND = Object.freeze({
  [REG_STAGE_KIND.CREATE_KEY]: "create-key",
  [REG_STAGE_KIND.DELETE_KEY]: "delete-key",
  [REG_STAGE_KIND.SET_VALUE]: "set-value",
  [REG_STAGE_KIND.DELETE_VALUE]: "delete-value"
});
var DEFAULT_VALUE_SUFFIX = "\\@";
function stageError(code, message, extra = {}) {
  const error = Object.assign(new Error(message), { code }, extra);
  return error;
}
function policyRejection(verdict) {
  return stageError("REG_STAGE_HARD_DENY", `registry-stage refuses this operation: ${verdict.reason}`, {
    policyCode: verdict.code,
    status: verdict.status,
    api: verdict.api,
    path: verdict.canonical
  });
}
function assertNonEmptyString(value, what) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`registry-stage: ${what} must be a non-empty string`);
  }
  return value;
}
function resolveRegistryStageRoot(sessionDir) {
  return join10(assertNonEmptyString(sessionDir, "sessionDir"), REGISTRY_STAGE_SUBDIR);
}
function resolveRegistryStagePath(sessionDir) {
  return join10(resolveRegistryStageRoot(sessionDir), OVERLAY_HIVE_NAME);
}
function resolveRegistryStageJournalPath(sessionDir) {
  return join10(resolveRegistryStageRoot(sessionDir), OVERLAY_JOURNAL_NAME);
}
function resolveRegistryStageStatePath(sessionDir) {
  return join10(resolveRegistryStageRoot(sessionDir), OVERLAY_STATE_NAME);
}
function resolveRegistryStageDiscardedPath(sessionDir) {
  return join10(resolveRegistryStageRoot(sessionDir), OVERLAY_DISCARDED_NAME);
}
function overlayContainerChain(registryPath) {
  const { canonical: canonical3 } = parseRegistryPath(registryPath);
  const parts = canonical3.split("\\");
  const chain = [];
  for (let index = 1; index < parts.length; index += 1) chain.push(parts.slice(0, index + 1).join("\\"));
  return chain;
}
function fold(value) {
  return String(value).toLowerCase();
}
function lastSegment(registryPath) {
  const index = registryPath.lastIndexOf("\\");
  return index === -1 ? registryPath : registryPath.slice(index + 1);
}
function isDirectChildFold(parentFold, childFold) {
  if (!childFold.startsWith(`${parentFold}\\`)) return false;
  return !childFold.slice(parentFold.length + 1).includes("\\");
}
function ancestorFolds(canonical3) {
  const parts = canonical3.split("\\");
  const ancestors = [];
  for (let index = 1; index < parts.length; index += 1) ancestors.push(fold(parts.slice(0, index).join("\\")));
  return ancestors;
}
function registryValueUnitPath(keyPath, valueName) {
  return typeof valueName === "string" && valueName.length > 0 ? `${keyPath}\\${valueName}` : `${keyPath}${DEFAULT_VALUE_SUFFIX}`;
}
function classifyRegistryOperation(operation = {}) {
  const api = operation.api;
  if (typeof api !== "string" || api.length === 0) {
    throw stageError("REG_STAGE_POLICY_INVALID", "classifyRegistryOperation: operation.api is required");
  }
  const deny = (code, reason, extra = {}) => ({
    stageable: false,
    code,
    status: HARD_DENY_STATUS,
    reason,
    api,
    ...extra
  });
  const unstaged = (code, reason, unstagedReason, extra = {}) => ({
    stageable: false,
    unstaged: true,
    code,
    status: REG_STATUS.ERROR_SUCCESS,
    unstagedReason,
    reason,
    api,
    ...extra
  });
  const knownDeny = REG_STAGE_HARD_DENY_APIS[api];
  if (knownDeny !== void 0) return deny("REG_STAGE_API_HARD_DENY", `${api}: ${knownDeny}`);
  if (!REG_STAGE_HOOKED_APIS.includes(api)) {
    return deny(
      "REG_STAGE_API_NOT_HOOKED",
      `${api} \u4E0D\u5728\u88AB hook \u7684 ${REG_STAGE_HOOKED_APIS.length} \u4E2A API \u4E4B\u5185\uFF1B\u672A hook \u7684\u8C03\u7528\u65E0\u6CD5\u88AB\u6682\u5B58\uFF0C\u5FC5\u987B fail-closed`
    );
  }
  const dwOptions = operation.dwOptions ?? 0;
  if (!Number.isInteger(dwOptions) || dwOptions < 0) {
    throw stageError("REG_STAGE_POLICY_INVALID", `dwOptions must be a non-negative integer, got ${String(operation.dwOptions)}`);
  }
  for (const option of REG_STAGE_HARD_DENY_OPTIONS) {
    if ((dwOptions & option.flag) !== 0) return deny("REG_STAGE_OPTION_HARD_DENY", `${api}: ${option.reason}`, { flag: option.name });
  }
  const samDesired = operation.samDesired ?? 0;
  if (!Number.isInteger(samDesired) || samDesired < 0) {
    throw stageError("REG_STAGE_POLICY_INVALID", `samDesired must be a non-negative integer, got ${String(operation.samDesired)}`);
  }
  for (const sam of REG_STAGE_HARD_DENY_SAM) {
    if ((samDesired & sam.flag) !== 0) return deny("REG_STAGE_SAM_HARD_DENY", `${api}: ${sam.reason}`, { flag: sam.name });
  }
  const wow64Process = operation.wow64Process === true;
  for (const sam of REG_STAGE_UNSTAGED_SAM) {
    if ((samDesired & sam.flag) === 0) continue;
    if (sam.appliesTo === "wow64-process" && !wow64Process) continue;
    return unstaged("REG_STAGE_SAM_UNSTAGED", `${api}: ${sam.reason}`, sam.name === "KEY_WOW64_32KEY" ? "WOW64_32KEY" : "WOW64_VIEW_IN_WOW64_PROCESS", {
      flag: sam.name,
      samDesired
    });
  }
  let parsed;
  try {
    parsed = parseRegistryPath(operation.path);
  } catch (error) {
    if (error.code === "REG_HIVE_UNKNOWN") {
      return deny("REG_STAGE_ROOT_UNKNOWN", `${api}: ${error.message}`);
    }
    throw error;
  }
  const hiveDeny = REG_HIVES_HARD_DENY[parsed.hive];
  if (hiveDeny !== void 0) return deny("REG_STAGE_HIVE_HARD_DENY", `${api}: ${hiveDeny}`, { hive: parsed.hive });
  if (!REG_HIVES_STAGEABLE.includes(parsed.hive)) {
    return deny("REG_STAGE_HIVE_HARD_DENY", `${api}: ${parsed.hive} \u4E0D\u5728\u53EF\u6682\u5B58 hive \u5217\u8868\u5185`, { hive: parsed.hive });
  }
  let typeName;
  if (operation.type !== void 0 && operation.type !== null) {
    try {
      typeName = registryTypeName(operation.type);
    } catch (error) {
      return deny("REG_TYPE_UNKNOWN", `${api}: ${error.message}`, { hive: parsed.hive, canonical: parsed.canonical });
    }
    if (REG_STAGE_UNSUPPORTED_TYPES.includes(typeName)) {
      return deny(
        "REG_TYPE_UNSUPPORTED",
        `${api}: ${typeName} \u5728\u672C\u6A21\u5757\u6CA1\u6709\u7F16\u89E3\u7801\u5668\uFF1B\u9759\u9ED8\u5F53\u6210 REG_BINARY \u4F1A\u6539\u6389\u8BED\u4E49\uFF0C\u56E0\u6B64\u786C\u62D2`,
        { hive: parsed.hive, canonical: parsed.canonical, type: typeName }
      );
    }
  }
  return {
    stageable: true,
    code: "REG_STAGE_OK",
    status: REG_STATUS.ERROR_SUCCESS,
    reason: "stageable",
    api,
    hive: parsed.hive,
    subKey: parsed.subKey,
    canonical: parsed.canonical,
    type: typeName,
    flags: {
      volatile: (dwOptions & REG_OPTIONS.REG_OPTION_VOLATILE) !== 0,
      /** 裸 hive 根（`HKCU` 自身）：永远存在 ⇒ create-key 是净变化为零的"打开已有键" */
      bareRoot: parsed.subKey.length === 0
    }
  };
}
var REGISTERED_HARD_DENIALS = Object.freeze({
  hives: Object.freeze(
    Object.entries(REG_HIVES_HARD_DENY).map(([hive, reason]) => ({ hive, reason }))
  ),
  apis: Object.freeze(
    Object.entries(REG_STAGE_HARD_DENY_APIS).map(([api, reason]) => ({ api, reason }))
  ),
  options: Object.freeze(REG_STAGE_HARD_DENY_OPTIONS.map((entry) => ({ name: entry.name, reason: entry.reason }))),
  sam: Object.freeze(REG_STAGE_HARD_DENY_SAM.map((entry) => ({ name: entry.name, reason: entry.reason }))),
  /**
   * **不可暂存 ⇒ 透传** 的清单（契约 v1.4）。与上面四类并列，因为它是**第三类结论**：
   * 既不是"暂存成功"，也不是"被拒"—— 调用被交给真实 API，只留一条 `UNSTAGED` 审计记录。
   * 把这些混进 `apis`/`sam`（硬拒）里，就是把"沙箱表示不了"说成"你没权限"。
   */
  unstaged: Object.freeze([
    ...REG_STAGE_UNSTAGED_SAM.map((entry) => ({ kind: "sam", name: entry.name, reason: entry.reason })),
    {
      kind: "handle",
      name: "REG_STAGE_ROOT_UNKNOWN",
      reason: "\u65E0\u6CD5\u4ECE\u9884\u5B9A\u4E49\u6839\u6D3E\u751F\u89C4\u8303\u8DEF\u5F84\u7684\u53E5\u67C4\uFF08\u539F\u751F API \u53E5\u67C4 / RegConnectRegistry \u53E5\u67C4 / \u8DE8\u8FDB\u7A0B\u88F8\u53E5\u67C4\uFF09\uFF1A\u8986\u76D6\u5C42\u7ED9\u4E0D\u51FA\u8DEF\u5F84\uFF0C\u5C31**\u4E0D\u731C**\uFF1B\u771F\u5B9E API \u8BA4\u8BC6\u8FD9\u4E2A\u53E5\u67C4\uFF0C\u6240\u4EE5\u900F\u4F20\u771F\u5B9E\u8C03\u7528\uFF08\u65E7\u884C\u4E3A\u662F\u786C\u62D2 5 \u2014\u2014 \u90A3\u662F\u5728\u56DE\u7B54\u4E00\u4E2A\u8C03\u7528\u65B9\u6CA1\u95EE\u7684\u95EE\u9898\uFF09"
    },
    {
      kind: "handle",
      name: "BARE_HIVE_ROOT_VALUE_WRITE",
      reason: '\u88F8 hive \u6839\uFF08`HKCU` \u81EA\u8EAB\uFF09\u4E0A\u7684 set-value/delete-value/delete-key\uFF1A\u8986\u76D6\u5C42\u91CC"\u6839"\u4E0D\u662F\u53EF\u5199\u76EE\u6807\uFF08app hive \u7684\u6839\u4E0D\u80FD\u5F53\u8DEF\u5F84\u7528\uFF09\uFF0C\u4F46\u771F\u5B9E API \u4E0A\u8FD9\u4E9B\u8C03\u7528\u662F\u5408\u6CD5\u7684 \u21D2 \u900F\u4F20\u771F\u5B9E\u6839\u53E5\u67C4\uFF1Bcreate-key \u5BF9\u88F8\u6839\u4ECD\u662F\u7EAF\u6253\u5F00\uFF08\u51C0\u53D8\u5316\u4E3A\u96F6\uFF0C\u4E0D\u5165 WAL\uFF09'
    }
  ]),
  types: Object.freeze(
    REG_STAGE_UNSUPPORTED_TYPES.map((type) => ({
      type,
      reason: `${type} \u6CA1\u6709\u7F16\u89E3\u7801\u5668\uFF08registry-guard \u7684 VALUE_ENCODERS/DECODERS \u4E0D\u542B\u5B83\uFF09`
    }))
  ),
  /**
   * **语义级**残余：不是"调用被拒"，而是"调用成功但系统不认"。
   * 诚实性要求把它与上面四类并列写出，而不是藏在某一节里。
   */
  semantic: Object.freeze([
    "\u8986\u76D6\u5C42\u53EA\u5F71\u54CD\u88AB hook \u7684 Reg* \u8C03\u7528\uFF1BNtSetValueKey/ZwSetValueKey\u3001\u76F4\u63A5\u5199 NTUSER.DAT/SYSTEM\u3001\u672A\u6CE8\u5165\u7684 reg.exe/regedit \u7167\u6837\u547D\u4E2D\u771F\u5B9E hive",
    "\u5199\u8FDB\u8986\u76D6\u5C42 \u2260 \u7CFB\u7EDF\u751F\u6548\uFF1A\u670D\u52A1/COM/\u9A71\u52A8/\u542F\u52A8\u9879\u8BFB\u7684\u662F\u771F\u5B9E hive\uFF08\u4F8B\u5982 HKCU\\...\\Run \u4E0D\u4F1A\u771F\u7684\u5F00\u673A\u81EA\u542F\uFF09",
    "\u5B89\u5168\u63CF\u8FF0\u7B26\u53D8\u66F4\u65E0\u6CD5\u6682\u5B58\uFF08app hive \u5168\u952E\u5171\u4EAB\u4E00\u4E2A SD\uFF0C\u4E14\u7981\u6B62 RegSetKeySecurity\uFF09",
    "HKEY_USERS\\<\u5176\u4ED6\u7528\u6237> \u7684\u5019\u9009\u53EF\u4EE5\u51BB\u7ED3\uFF0C\u4F46\u5E94\u7528\u65F6\u9700\u8981\u52A0\u8F7D\u5BF9\u65B9\u7684 hive\uFF08\u7BA1\u7406\u5458\uFF1B\u5426\u5219 apply \u62A5\u5931\u8D25\uFF09",
    'REG_OPTION_VOLATILE \u952E\u5728\u8986\u76D6\u5C42\u91CC\u662F\u6587\u4EF6\u578B hive\uFF0C"\u91CD\u542F\u5373\u5931"\u7684\u8BED\u4E49\u8981\u7B49\u5E94\u7528\u65F6\u6309 volatile \u9009\u9879\u91CD\u5EFA\u624D\u6210\u7ACB',
    '\u8BFB\u53D6\u9762\u6CA1\u6709\u88AB\u8986\u76D6\uFF1A\u8986\u76D6\u5C42\u53EA\u8986\u76D6"\u672C\u4F1A\u8BDD\u6682\u5B58\u8FC7\u7684\u8DEF\u5F84"\uFF0C\u5176\u4F59\u8BFB\u53D6\u4ECD\u8D70\u771F\u5B9E hive\uFF08\u53D7\u9650\u4EE4\u724C\u4E0B\u53EF\u80FD\u8BFB\u4E0D\u5230\uFF09'
  ])
});
function createOverlayState(options = {}) {
  return {
    version: REGISTRY_STAGE_VERSION,
    sessionId: typeof options.sessionId === "string" && options.sessionId.length > 0 ? options.sessionId : null,
    createdAt: typeof options.createdAt === "string" ? options.createdAt : null,
    seq: 0,
    ops: []
  };
}
function cloneState(state) {
  return { ...state, ops: [...state.ops] };
}
function applyOverlayOperation(state, operation = {}) {
  if (!state || state.version !== REGISTRY_STAGE_VERSION) {
    throw stageError("REG_STAGE_STATE_INVALID", "applyOverlayOperation: state must come from createOverlayState()");
  }
  const op = operation.op;
  const api = API_BY_OP[op];
  if (api === void 0) {
    throw stageError("REG_STAGE_OP_UNKNOWN", `applyOverlayOperation: unknown op ${JSON.stringify(op)}`);
  }
  const verdict = classifyRegistryOperation({
    api,
    path: operation.path,
    type: operation.type,
    dwOptions: operation.dwOptions,
    samDesired: operation.samDesired,
    wow64Process: operation.wow64Process
  });
  if (verdict.unstaged === true) {
    return cloneState(state);
  }
  if (!verdict.stageable) throw policyRejection(verdict);
  const canonical3 = verdict.canonical;
  const next = cloneState(state);
  const push = (entry) => {
    next.seq += 1;
    next.ops.push({ seq: next.seq, ...entry });
  };
  if (op === "create-key") {
    if (overlayContainerChain(canonical3).length === 0) return next;
    const volatile = (operation.dwOptions ?? 0) & REG_OPTIONS.REG_OPTION_VOLATILE ? true : false;
    const chain = overlayContainerChain(canonical3);
    for (const level of chain) {
      if (overlayKeyExists(next, level) === true) continue;
      push({ op, path: level, volatile: volatile && fold(level) === fold(canonical3) });
    }
    return next;
  }
  if (op === "delete-key") {
    if (overlayContainerChain(canonical3).length === 0) {
      throw stageError(
        "REG_STAGE_ROOT_READONLY",
        `delete-key on the predefined root ${canonical3} is meaningless: the root always exists and cannot be removed`,
        { status: HARD_DENY_STATUS, path: canonical3 }
      );
    }
    push({ op, path: canonical3 });
    return next;
  }
  const valueName = typeof operation.valueName === "string" ? operation.valueName : "";
  if (op === "set-value") {
    const entry = { op, path: canonical3, valueName, typeName: verdict.type };
    entry.data = encodeRegistryValue(verdict.type, operation.value);
    push(entry);
    return next;
  }
  push({ op, path: canonical3, valueName });
  return next;
}
function classifyOverlayNetEffect({ state, baselineFor }) {
  if (!state || state.version !== REGISTRY_STAGE_VERSION) {
    throw stageError("REG_STAGE_STATE_INVALID", "classifyOverlayNetEffect: state must come from createOverlayState()");
  }
  if (typeof baselineFor !== "function") {
    throw stageError(
      "REG_READER_MISSING",
      "classifyOverlayNetEffect requires baselineFor(path): without the real hive you cannot tell an open from a create"
    );
  }
  const snapshotCache = /* @__PURE__ */ new Map();
  const base = (canonical3) => {
    const key = fold(canonical3);
    if (!snapshotCache.has(key)) snapshotCache.set(key, baselineFor(canonical3));
    return snapshotCache.get(key);
  };
  const exists = /* @__PURE__ */ new Map();
  const values = /* @__PURE__ */ new Map();
  const unreadableReason = /* @__PURE__ */ new Map();
  const ensure = (canonical3) => {
    const key = fold(canonical3);
    if (!exists.has(key)) {
      const snapshot = base(canonical3);
      if (snapshot.accessDenied === true || snapshot.unreadable === true) {
        exists.set(key, "unknown");
        values.set(key, "unknown");
        unreadableReason.set(
          key,
          snapshot.unreadableReason ?? (snapshot.accessDenied === true ? "the baseline read was denied (ERROR_ACCESS_DENIED)" : "the baseline could not be read")
        );
      } else {
        exists.set(key, snapshot.exists === true);
        const map = {};
        for (const [name, entry] of Object.entries(snapshot.values ?? {})) map[fold(name)] = { name, type: entry.type, data: entry.data };
        values.set(key, map);
      }
    }
    return key;
  };
  const why = (key) => {
    const reason = unreadableReason.get(key);
    return reason === void 0 ? "" : ` (${reason})`;
  };
  const operations = [];
  for (const [index, entry] of state.ops.entries()) {
    const canonical3 = parseRegistryPath(entry.path).canonical;
    const key = ensure(canonical3);
    const valueName = typeof entry.valueName === "string" ? entry.valueName : "";
    let effect = "net";
    let reason = "state changes relative to the real hive";
    if (entry.op === REG_STAGE_OP.CREATE_KEY) {
      if (exists.get(key) === "unknown") {
        effect = "unknown";
        reason = `baseline is unreadable: cannot tell whether this is an open or a create${why(key)}`;
      } else if (exists.get(key) === true) {
        effect = "no-op";
        reason = 'key already exists in the real hive: RegCreateKeyExW is "open or create", a pure open must not create an overlay entry';
      } else {
        exists.set(key, true);
        values.set(key, {});
      }
    } else if (entry.op === REG_STAGE_OP.DELETE_KEY) {
      if (exists.get(key) === "unknown") {
        effect = "unknown";
        reason = `baseline is unreadable${why(key)}`;
      } else if (exists.get(key) === false) {
        effect = "no-op";
        reason = "key does not exist in the real hive: nothing to delete";
      } else {
        exists.set(key, false);
        values.set(key, {});
      }
    } else if (entry.op === REG_STAGE_OP.SET_VALUE) {
      const map = values.get(key);
      if (map === "unknown") {
        effect = "unknown";
        reason = `baseline is unreadable${why(key)}`;
      } else {
        const current = map[fold(valueName)];
        if (current && current.type === entry.typeName && current.data === entry.data) {
          effect = "no-op";
          reason = "the value already has exactly this type and data";
        } else {
          map[fold(valueName)] = { name: valueName, type: entry.typeName, data: entry.data };
          if (exists.get(key) === false) exists.set(key, true);
        }
      }
    } else if (entry.op === REG_STAGE_OP.DELETE_VALUE) {
      const map = values.get(key);
      if (map === "unknown") {
        effect = "unknown";
        reason = `baseline is unreadable${why(key)}`;
      } else if (!map[fold(valueName)]) {
        effect = "no-op";
        reason = "value does not exist in the real hive: nothing to delete";
      } else {
        delete map[fold(valueName)];
      }
    } else {
      effect = "unknown";
      reason = `unknown op ${entry.op}`;
    }
    operations.push({ index, seq: entry.seq, op: entry.op, path: canonical3, valueName: valueName || void 0, effect, reason });
  }
  const summary = operations.reduce(
    (acc, operation) => {
      acc[operation.effect === "no-op" ? "noop" : operation.effect] += 1;
      return acc;
    },
    { total: operations.length, net: 0, noop: 0, unknown: 0 }
  );
  return { operations, summary, hasNetChange: summary.net > 0 };
}
function filterOverlayNetOperations({ state, baselineFor, operation }) {
  const before = classifyOverlayNetEffect({ state, baselineFor });
  const expanded = applyOverlayOperation(state, operation);
  const after = classifyOverlayNetEffect({ state: expanded, baselineFor });
  const added = after.operations.slice(before.operations.length);
  if (added.length === 0) {
    return { effect: "no-op", reason: "the operation produced no overlay entry (net change is zero)", added: [], state };
  }
  const netAdded = added.filter((entry) => entry.effect === "net");
  const unknownAdded = added.filter((entry) => entry.effect === "unknown");
  const keptOps = netAdded.map((entry) => expanded.ops[entry.index]);
  const ops = [...state.ops, ...keptOps];
  const seq = ops.reduce((max, entry) => Math.max(max, entry.seq ?? 0), state.seq);
  const nextState = { ...state, ops, seq };
  const effect = netAdded.length > 0 ? "net" : unknownAdded.length > 0 ? "unknown" : "no-op";
  const reason = netAdded.length > 0 ? `kept ${netAdded.length} net operation(s)` : unknownAdded.length > 0 ? unknownAdded[0].reason : added[0].reason;
  return { effect, reason, added, state: nextState };
}
function overlayKeyExists(state, registryPath) {
  const canonical3 = parseRegistryPath(registryPath).canonical;
  const target = fold(canonical3);
  for (const ancestor of ancestorFolds(canonical3)) {
    const last2 = lastOperationForFold(state, ancestor);
    if (last2 && last2.op === REG_STAGE_OP.DELETE_KEY) return false;
  }
  const last = lastOperationForFold(state, target);
  if (!last) return void 0;
  return last.op !== REG_STAGE_OP.DELETE_KEY;
}
function lastOperationForFold(state, targetFold) {
  for (let index = state.ops.length - 1; index >= 0; index -= 1) {
    if (fold(state.ops[index].path) === targetFold) return state.ops[index];
  }
  return void 0;
}
function lastValueOperationFor(state, registryPath, valueName) {
  const target = fold(parseRegistryPath(registryPath).canonical);
  const wanted = fold(valueName ?? "");
  for (let index = state.ops.length - 1; index >= 0; index -= 1) {
    const entry = state.ops[index];
    if (entry.op !== REG_STAGE_OP.SET_VALUE && entry.op !== REG_STAGE_OP.DELETE_VALUE) continue;
    if (fold(entry.path) !== target) continue;
    if (fold(entry.valueName ?? "") !== wanted) continue;
    return entry;
  }
  return void 0;
}
function overlayTouchedPaths(state) {
  const levels = /* @__PURE__ */ new Map();
  for (const op of state.ops) {
    for (const level of overlayContainerChain(op.path)) {
      if (!levels.has(fold(level))) levels.set(fold(level), level);
    }
  }
  return [...levels.values()].sort((left, right) => fold(left) < fold(right) ? -1 : fold(left) > fold(right) ? 1 : 0);
}
function withBaselineChecked(baseline, canonical3) {
  const base = baseline ?? normalizeSnapshot({ root: canonical3, exists: false });
  if (fold(base.root) !== fold(canonical3)) {
    throw stageError(
      "REG_STAGE_BASELINE_ROOT_MISMATCH",
      `baseline root ${base.root} does not match requested path ${canonical3}; comparing different keys is meaningless`
    );
  }
  if (base.accessDenied === true) {
    throw stageError(
      "REG_BASELINE_UNREADABLE",
      `baseline for ${canonical3} is unreadable (ERROR_ACCESS_DENIED): the overlay cannot pretend the pre-existing values are empty, so this path is NOT frozen into a candidate`,
      { root: canonical3 }
    );
  }
  if (base.unreadable === true) {
    throw stageError(
      "REG_BASELINE_UNREADABLE",
      `baseline for ${canonical3} could not be read: ${base.unreadableReason ?? "reader did not report a usable answer"} \u2014 refusing to treat "not read" as "does not exist / is empty"`,
      { root: canonical3 }
    );
  }
  return base;
}
function withBaselineKnowledge(snapshot, raw, canonical3) {
  if (raw.unreadable === true) {
    return Object.freeze({
      ...snapshot,
      exists: true,
      unreadable: true,
      subKeysKnown: false,
      unreadableReason: typeof raw.unreadableReason === "string" && raw.unreadableReason.length > 0 ? raw.unreadableReason : `reader could not read ${canonical3}`
    });
  }
  if (raw.exists !== true && raw.exists !== false && raw.accessDenied !== true) {
    return Object.freeze({
      ...snapshot,
      exists: true,
      unreadable: true,
      subKeysKnown: false,
      unreadableReason: `reader did not report "exists" for ${canonical3}: refusing to treat a missing answer as "the key does not exist" (that answer would become a real \`reg add <key> /f\`)`
    });
  }
  if (snapshot.exists !== true || snapshot.accessDenied === true) return snapshot;
  if (Array.isArray(raw.subKeys) || raw.subKeysKnown === true) return snapshot;
  return Object.freeze({
    ...snapshot,
    subKeysKnown: false,
    subKeysUnknownReason: `reader did not report subKeys for ${canonical3}: the sub-key enumeration is UNKNOWN, not known-empty`
  });
}
function baselineSubKeysKnown(baseline) {
  if (baseline.exists !== true) return true;
  if (baseline.subKeysKnown === false) return false;
  if (baseline.subKeysKnown === true) return true;
  return Array.isArray(baseline.subKeys);
}
function baselineSubKeysArray(baseline) {
  return Array.isArray(baseline.subKeys) ? baseline.subKeys : [];
}
function summarizeChangeKinds(changes) {
  return changes.reduce((acc, change) => {
    acc[change.kind] = (acc[change.kind] ?? 0) + 1;
    return acc;
  }, {});
}
function setEntryCaseInsensitive(map, name, entry) {
  const wanted = fold(name);
  const next = {};
  for (const [key, value] of Object.entries(map)) {
    if (fold(key) === wanted) continue;
    next[key] = value;
  }
  next[name] = entry;
  return next;
}
function removeEntryCaseInsensitive(map, name) {
  const wanted = fold(name);
  const next = {};
  for (const [key, value] of Object.entries(map)) {
    if (fold(key) === wanted) continue;
    next[key] = value;
  }
  return next;
}
function addNameCaseInsensitive(list, name) {
  if (list.some((entry) => fold(entry) === fold(name))) return list;
  return [...list, name];
}
function removeNameCaseInsensitive(list, name) {
  return list.filter((entry) => fold(entry) !== fold(name));
}
function overlayView({ state, path, baseline }) {
  if (!state || state.version !== REGISTRY_STAGE_VERSION) {
    throw stageError("REG_STAGE_STATE_INVALID", "overlayView: state must come from createOverlayState()");
  }
  const canonical3 = parseRegistryPath(path).canonical;
  const target = fold(canonical3);
  const base = withBaselineChecked(baseline, canonical3);
  if (overlayKeyExists(state, canonical3) === false) {
    return normalizeSnapshot({ root: canonical3, exists: false, errorCode: REG_STATUS.ERROR_FILE_NOT_FOUND });
  }
  const mergeEnumeration = __internal3.enumerationMerge !== false;
  let exists = base.exists;
  let values = mergeEnumeration ? { ...base.values } : {};
  let subKeysKnown = baselineSubKeysKnown(base);
  let subKeys = mergeEnumeration ? [...baselineSubKeysArray(base)] : [];
  let subKeysUnknownReason = typeof base.subKeysUnknownReason === "string" && base.subKeysUnknownReason.length > 0 ? base.subKeysUnknownReason : `baseline for ${canonical3} did not report a sub-key enumeration: "unknown" must not be read as "empty"`;
  for (const entry of state.ops) {
    const entryFold = fold(entry.path);
    if (entryFold === target) {
      if (entry.op === REG_STAGE_OP.CREATE_KEY) {
        if (!exists) {
          exists = true;
          values = {};
          subKeys = [];
          subKeysKnown = true;
        }
      } else if (entry.op === REG_STAGE_OP.DELETE_KEY) {
        exists = false;
        values = {};
        subKeys = [];
        subKeysKnown = true;
      } else if (entry.op === REG_STAGE_OP.SET_VALUE) {
        exists = true;
        values = setEntryCaseInsensitive(values, entry.valueName ?? "", { type: entry.typeName, data: entry.data });
      } else if (entry.op === REG_STAGE_OP.DELETE_VALUE) {
        values = removeEntryCaseInsensitive(values, entry.valueName ?? "");
      }
      continue;
    }
    if (isDirectChildFold(target, entryFold)) {
      const name = lastSegment(entry.path);
      if (entry.op === REG_STAGE_OP.CREATE_KEY) subKeys = addNameCaseInsensitive(subKeys, name);
      else if (entry.op === REG_STAGE_OP.DELETE_KEY) subKeys = removeNameCaseInsensitive(subKeys, name);
    }
  }
  if (!exists) return normalizeSnapshot({ root: canonical3, exists: false, errorCode: REG_STATUS.ERROR_FILE_NOT_FOUND });
  const typed = {};
  for (const [name, entry] of Object.entries(values)) {
    typed[name] = { type: entry.type, data: decodeRegistryValue(entry.type, entry.data, name) };
  }
  const view = normalizeSnapshot({ root: canonical3, exists: true, subKeys, values: typed, sddl: base.sddl });
  if (subKeysKnown) return view;
  return Object.freeze({ ...view, subKeysKnown: false, subKeysUnknownReason });
}
function overlayQueryValue({ state, path, valueName = "", baseline }) {
  const canonical3 = parseRegistryPath(path).canonical;
  if (overlayKeyExists(state, canonical3) === false) return { status: REG_STATUS.ERROR_FILE_NOT_FOUND, reason: "key does not exist in the overlay" };
  const base = baseline ?? normalizeSnapshot({ root: canonical3, exists: false });
  if (fold(base.root) !== fold(canonical3)) {
    throw stageError("REG_STAGE_BASELINE_ROOT_MISMATCH", `baseline root ${base.root} does not match ${canonical3}`);
  }
  if (base.accessDenied === true) {
    const staged = lastValueOperationFor(state, canonical3, valueName);
    if (!staged || staged.op !== REG_STAGE_OP.SET_VALUE) {
      return { status: REG_STATUS.ERROR_ACCESS_DENIED, reason: "baseline is unreadable and this value was not staged" };
    }
    return {
      status: REG_STATUS.ERROR_SUCCESS,
      type: staged.typeName,
      data: staged.data,
      value: decodeRegistryValue(staged.typeName, staged.data, valueName),
      source: "overlay"
    };
  }
  const view = overlayView({ state, path: canonical3, baseline: base });
  if (!view.exists) return { status: REG_STATUS.ERROR_FILE_NOT_FOUND, reason: "key does not exist" };
  const wanted = fold(valueName);
  const found = Object.entries(view.values).find(([name2]) => fold(name2) === wanted);
  if (!found) return { status: REG_STATUS.ERROR_FILE_NOT_FOUND, reason: "value does not exist" };
  const [name, entry] = found;
  return {
    status: REG_STATUS.ERROR_SUCCESS,
    name,
    type: entry.type,
    data: entry.data,
    value: decodeRegistryValue(entry.type, entry.data, name),
    source: "overlay-view"
  };
}
function overlayQueryKey({ state, path, baseline }) {
  const canonical3 = parseRegistryPath(path).canonical;
  if (overlayKeyExists(state, canonical3) === false) {
    return { status: REG_STATUS.ERROR_FILE_NOT_FOUND, exists: false, subKeys: [], valueNames: [], subKeysKnown: true };
  }
  const base = baseline ?? normalizeSnapshot({ root: canonical3, exists: false });
  if (base.accessDenied === true) {
    return {
      status: REG_STATUS.ERROR_ACCESS_DENIED,
      exists: true,
      subKeys: [],
      valueNames: [],
      subKeysKnown: false,
      reason: base.unreadableReason ?? "baseline is unreadable (ERROR_ACCESS_DENIED)"
    };
  }
  if (base.unreadable === true) {
    return {
      status: REG_STATUS.ERROR_ACCESS_DENIED,
      exists: true,
      subKeys: [],
      valueNames: [],
      subKeysKnown: false,
      reason: base.unreadableReason ?? "baseline could not be read"
    };
  }
  const view = overlayView({ state, path: canonical3, baseline: base });
  if (!view.exists) {
    return { status: REG_STATUS.ERROR_FILE_NOT_FOUND, exists: false, subKeys: [], valueNames: [], subKeysKnown: true };
  }
  const subKeysKnown = view.subKeysKnown !== false;
  return {
    status: REG_STATUS.ERROR_SUCCESS,
    exists: true,
    subKeys: [...view.subKeys],
    valueNames: Object.keys(view.values),
    // WP12：枚举**未知**时必须显式说出来，别让调用方把 `subKeys: []` 读成"这个键没有子键"
    // （`[实测]` 2026-09-30：把枚举说成空 ⇒ .NET 证书存储读空 ⇒ PowerShell 起不来）。
    subKeysKnown,
    reason: subKeysKnown ? void 0 : view.subKeysUnknownReason
  };
}
function overlayEnumKeys({ state, path, baseline }) {
  const query = overlayQueryKey({ state, path, baseline });
  if (query.status === REG_STATUS.ERROR_SUCCESS && query.subKeysKnown === false) {
    return { status: REG_STATUS.ERROR_ACCESS_DENIED, names: [], subKeysKnown: false, reason: query.reason };
  }
  return { status: query.status, names: query.status === REG_STATUS.ERROR_SUCCESS ? query.subKeys : [] };
}
function overlayEnumValues({ state, path, baseline }) {
  const canonical3 = parseRegistryPath(path).canonical;
  if (overlayKeyExists(state, canonical3) === false) return { status: REG_STATUS.ERROR_FILE_NOT_FOUND, values: [] };
  const base = baseline ?? normalizeSnapshot({ root: canonical3, exists: false });
  if (base.accessDenied === true || base.unreadable === true) {
    return {
      status: REG_STATUS.ERROR_ACCESS_DENIED,
      values: [],
      reason: base.unreadableReason ?? "baseline is unreadable"
    };
  }
  const view = overlayView({ state, path: canonical3, baseline: base });
  if (!view.exists) return { status: REG_STATUS.ERROR_FILE_NOT_FOUND, values: [] };
  return {
    status: REG_STATUS.ERROR_SUCCESS,
    values: Object.entries(view.values).map(([name, entry]) => ({ name, type: entry.type, data: entry.data }))
  };
}
function diffOverlay({ state, baselineFor }) {
  if (typeof baselineFor !== "function") {
    throw stageError("REG_READER_MISSING", "diffOverlay requires baselineFor(path) \u2014 refusing to diff against an assumed-empty baseline");
  }
  const paths = overlayTouchedPaths(state);
  const roots = {};
  const changes = [];
  const unreadable = [];
  const subKeysUnknown = [];
  const warnings = [];
  for (const path of paths) {
    const baseline = baselineFor(path);
    if (baseline.accessDenied === true || baseline.unreadable === true) {
      unreadable.push(path);
      warnings.push(
        `${path}: \u57FA\u7EBF\u8BFB\u53D6\u5931\u8D25\uFF08${baseline.accessDenied === true ? "ERROR_ACCESS_DENIED" : baseline.unreadableReason ?? "reader did not report a usable answer"}\uFF09\uFF0C\u8BE5\u8DEF\u5F84**\u4E0D**\u8FDB\u5165\u5019\u9009 \u2014\u2014 \u5019\u9009\u5FC5\u987B\u51BB\u7ED3\u4E00\u4E2A\u53EF\u9A8C\u8BC1\u7684 before\uFF08\u624B\u518C #12.6\uFF09\uFF0C\u8BFB\u4E0D\u5230\u5C31\u4E0D\u8BB8\u5047\u88C5\u8BFB\u5230`
      );
      continue;
    }
    const after = overlayView({ state, path, baseline });
    const rawDiff = diffSnapshots(baseline, after);
    let rootChanges = rawDiff.changes;
    const subKeysKnown = baselineSubKeysKnown(baseline);
    if (!subKeysKnown) {
      const undecidable = rootChanges.filter((change) => change.kind === "subkey-added" || change.kind === "subkey-deleted");
      rootChanges = rootChanges.filter((change) => change.kind !== "subkey-added" && change.kind !== "subkey-deleted");
      subKeysUnknown.push(path);
      warnings.push(
        `${path}: \u57FA\u7EBF**\u6CA1\u6709\u62A5\u5B50\u952E\u679A\u4E3E**\uFF08\u672A\u77E5\uFF0C\u4E0D\u662F\u7A7A\uFF09\u21D2 \u65E0\u6CD5\u5224\u5B9A"\u5B50\u952E\u589E\u5220"\u3002\u5DF2\u5254\u9664 ${undecidable.length} \u6761\u731C\u51FA\u6765\u7684\u5B50\u952E\u53D8\u66F4\uFF08${undecidable.map((change) => `${change.kind}:${change.key}`).join(", ") || "none"}\uFF09\u2014\u2014\u5426\u5219 \`subkey-added\` \u4F1A\u53D8\u6210 \`mkdir\` \u5355\u5143\uFF0C\u8BA9 apply \u53BB\u771F\u5B9E hive \u4E0A\u521B\u5EFA**\u5DF2\u5B58\u5728**\u7684\u952E\uFF08\`reg add <\u5DF2\u5B58\u5728\u952E> /f\` \u5728\u5199\u4FDD\u62A4/\u53D7\u9650\u4EE4\u724C\u4E0B\u88AB\u62D2 \u21D2 \u6574\u6279\u6279\u4E0D\u52A8\uFF09\u3002\u8BE5\u8DEF\u5F84\u7684**\u503C\u4E0E\u5B58\u5728\u6027**\u53D8\u66F4\u7167\u5E38\u4FDD\u7559\u3002`
      );
    }
    if (rootChanges.length === 0) continue;
    roots[path] = {
      changes: rootChanges,
      // summary 必须按**剔除后**的差异重算，否则候选里的计数会与变更单元对不上。
      summary: subKeysKnown ? rawDiff.summary : summarizeChangeKinds(rootChanges),
      subKeysKnown,
      rollback: planRollback(rootChanges, { rootPath: path }),
      baselineFrozen: serializeSnapshot(baseline)
    };
    for (const change of rootChanges) changes.push({ ...change, registryPath: path });
  }
  const lostValues = changes.filter((change) => change.kind === "value-deleted" || change.kind === "key-deleted").length;
  if (lostValues > 0) {
    warnings.push(
      `${lostValues} \u9879\u53D8\u66F4\u6D89\u53CA"\u5220\u9664/\u8986\u76D6\u65E2\u6709\u6570\u636E"\uFF1A\u5E94\u7528\u524D\u8BF7\u786E\u8BA4\u5019\u9009\u91CC\u51BB\u7ED3\u7684 before \u662F\u4F60\u8981\u8986\u76D6\u7684\u72B6\u6001`
    );
  }
  return { paths, roots, changes, totalChanges: changes.length, unreadable, subKeysUnknown, warnings };
}
var OP_BY_DIFF_KIND = Object.freeze({
  "key-created": "mkdir",
  "subkey-added": "mkdir",
  "key-deleted": "delete",
  "subkey-deleted": "delete",
  "value-added": "create",
  "value-changed": "modify",
  "value-deleted": "delete",
  "key-access-changed": "unsupported",
  "security-changed": "unsupported"
});
function overlayChangesToCandidateChanges(diffResult) {
  const units = [];
  const seen = /* @__PURE__ */ new Set();
  for (const change of diffResult.changes) {
    const op = OP_BY_DIFF_KIND[change.kind];
    if (op === void 0) {
      throw stageError("REG_STAGE_DIFF_KIND_UNKNOWN", `unknown diff kind ${JSON.stringify(change.kind)}`);
    }
    const unitPath = change.valueName !== void 0 ? registryValueUnitPath(change.key, change.valueName) : change.key;
    const dedupeKey = `${op}|${fold(unitPath)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const unit = {
      kind: "registry",
      registry: true,
      external: true,
      path: unitPath,
      registryPath: change.key,
      hive: parseRegistryPath(change.key).hive,
      op,
      diffKind: change.kind,
      before: change.before ?? null,
      after: change.after ?? null,
      frozen: true
    };
    if (change.valueName !== void 0) unit.valueName = change.valueName;
    if (change.reason !== void 0) unit.reason = change.reason;
    if (op === "unsupported") {
      unit.appliable = false;
      unit.unsupportedReason = "\u5B89\u5168\u63CF\u8FF0\u7B26/\u53EF\u8BFB\u6027\u53D8\u66F4\u65E0\u6CD5\u5728\u8986\u76D6\u5C42\u6682\u5B58\uFF1Aapp hive \u5185\u6240\u6709\u952E\u5171\u4EAB\u4E00\u4E2A SD\uFF0C\u4E14\u7981\u6B62 RegSetKeySecurity";
    } else {
      unit.appliable = true;
    }
    units.push(unit);
  }
  return units;
}
function summarizeRegistryChanges(changes) {
  const byOp = {};
  for (const change of changes) byOp[change.op] = (byOp[change.op] || 0) + 1;
  return {
    files: changes.length,
    hostOperations: 0,
    byOp,
    bytes: 0,
    keys: new Set(changes.map((change) => change.registryPath)).size,
    values: changes.filter((change) => change.valueName !== void 0).length,
    unsupported: changes.filter((change) => change.appliable === false).length
  };
}
function assertJournalRecord(record) {
  if (!record || typeof record !== "object") throw new TypeError("registry-stage: journal record must be an object");
  const kind = record.kind;
  if (KIND_NAME[kind] === void 0) {
    throw stageError("REG_STAGE_JOURNAL_INVALID", `unknown journal record kind ${JSON.stringify(kind)}`);
  }
  assertNonEmptyString(record.path, "journal record path");
}
function journalRecordForOperation(operation = {}) {
  const op = operation.op;
  const kind = KIND_BY_OP[op];
  if (kind === void 0) throw stageError("REG_STAGE_OP_UNKNOWN", `journalRecordForOperation: unknown op ${JSON.stringify(op)}`);
  const canonical3 = parseRegistryPath(operation.path).canonical;
  const record = { kind, path: canonical3, flags: 0, type: 0, valueName: null, data: null, status: 0 };
  if (op === "set-value") {
    record.type = REG_TYPES[registryTypeName(operation.type)];
    record.valueName = typeof operation.valueName === "string" ? operation.valueName : "";
    record.data = encodeRegistryValue(operation.type, operation.value);
    record.flags |= REG_STAGE_FLAGS.HAS_VALUE_NAME | REG_STAGE_FLAGS.HAS_DATA;
  }
  if (op === "delete-value") {
    record.valueName = typeof operation.valueName === "string" ? operation.valueName : "";
    record.flags |= REG_STAGE_FLAGS.HAS_VALUE_NAME;
  }
  if (operation.dwOptions && (operation.dwOptions & REG_OPTIONS.REG_OPTION_VOLATILE) !== 0) {
    record.flags |= REG_STAGE_FLAGS.VOLATILE;
  }
  return record;
}
function journalUnstagedRecord({ api, path, reason, unstagedReason = "UNRESOLVABLE_BASE_HANDLE" }) {
  if (REG_STAGE_UNSTAGED_REASON[unstagedReason] === void 0) {
    throw stageError(
      "REG_STAGE_JOURNAL_INVALID",
      `journalUnstagedRecord: unknown unstagedReason ${JSON.stringify(unstagedReason)} (expected one of ${Object.keys(REG_STAGE_UNSTAGED_REASON).join("/")})`
    );
  }
  return {
    kind: REG_STAGE_KIND.UNSTAGED,
    path: typeof path === "string" && path.length > 0 ? path : `<unstaged:${api ?? "unknown"}>`,
    flags: REG_STAGE_FLAGS.UNSTAGED,
    type: REG_STAGE_UNSTAGED_REASON[unstagedReason],
    valueName: null,
    data: null,
    status: 0,
    api: api ?? null,
    reason: reason ?? null,
    unstagedReason
  };
}
function registryWireBytes(type, dataHex) {
  const typeName = registryTypeName(type);
  const text = typeof dataHex === "string" ? dataHex : "";
  decodeRegistryValue(typeName, text, "<wire>");
  if (typeName === "REG_DWORD" || typeName === "REG_DWORD_BIG_ENDIAN" || typeName === "REG_QWORD") {
    const body = /^0x/i.test(text) ? text.slice(2) : text;
    if (typeName === "REG_QWORD") {
      const buffer2 = Buffer.alloc(8);
      buffer2.writeBigUInt64LE(BigInt(`0x${body}`), 0);
      return buffer2;
    }
    const value = Number.parseInt(body, 16) >>> 0;
    const buffer = Buffer.alloc(4);
    if (typeName === "REG_DWORD_BIG_ENDIAN") buffer.writeUInt32BE(value, 0);
    else buffer.writeUInt32LE(value, 0);
    return buffer;
  }
  return Buffer.from(text, "hex");
}
function registryDataHex(type, wireBuffer) {
  const typeName = registryTypeName(type);
  if (!Buffer.isBuffer(wireBuffer)) throw new TypeError("registryDataHex: wireBuffer must be a Buffer");
  if (typeName === "REG_DWORD" || typeName === "REG_DWORD_BIG_ENDIAN") {
    if (wireBuffer.length !== 4) {
      throw stageError("REG_STAGE_WIRE_LENGTH", `registryDataHex: ${typeName} expects 4 bytes, got ${wireBuffer.length}`);
    }
    const value = typeName === "REG_DWORD_BIG_ENDIAN" ? wireBuffer.readUInt32BE(0) : wireBuffer.readUInt32LE(0);
    return `0x${value.toString(16).padStart(8, "0")}`;
  }
  if (typeName === "REG_QWORD") {
    if (wireBuffer.length !== 8) {
      throw stageError("REG_STAGE_WIRE_LENGTH", `registryDataHex: REG_QWORD expects 8 bytes, got ${wireBuffer.length}`);
    }
    return `0x${wireBuffer.readBigUInt64LE(0).toString(16).padStart(16, "0")}`;
  }
  return wireBuffer.toString("hex");
}
function encodeJournalRecord(record) {
  assertJournalRecord(record);
  const pathBuffer = Buffer.from(record.path, "utf16le");
  const nameBuffer = Buffer.from(record.valueName ?? "", "utf16le");
  const dataHex = record.data ?? "";
  const dataBuffer = record.kind === REG_STAGE_KIND.SET_VALUE ? registryWireBytes(record.typeName ?? record.type, dataHex) : Buffer.alloc(0);
  const flags = record.flags ?? (record.valueName !== null && record.valueName !== void 0 ? REG_STAGE_FLAGS.HAS_VALUE_NAME : 0) | (record.data !== null && record.data !== void 0 ? REG_STAGE_FLAGS.HAS_DATA : 0);
  if (record.kind === REG_STAGE_KIND.UNSTAGED) {
    if ((flags & REG_STAGE_FLAGS.UNSTAGED) === 0) {
      throw stageError("REG_STAGE_JOURNAL_INVALID", "kind=UNSTAGED must set REG_STAGE_FLAGS.UNSTAGED");
    }
    if (UNSTAGED_REASON_NAME[record.type] === void 0) {
      throw stageError(
        "REG_STAGE_JOURNAL_INVALID",
        `kind=UNSTAGED needs type = a REG_STAGE_UNSTAGED_REASON code (1..${Object.keys(REG_STAGE_UNSTAGED_REASON).length}), got ${String(record.type)}`
      );
    }
    if ((flags & (REG_STAGE_FLAGS.HAS_VALUE_NAME | REG_STAGE_FLAGS.HAS_DATA)) !== 0 || (record.status ?? 0) !== 0) {
      throw stageError(
        "REG_STAGE_JOURNAL_INVALID",
        "kind=UNSTAGED must not carry valueName/data and must keep status=0 (nothing was denied and nothing was staged)"
      );
    }
  }
  const buffer = Buffer.alloc(REG_STAGE_RECORD_SIZE + pathBuffer.length + nameBuffer.length + dataBuffer.length);
  const O = REG_STAGE_RECORD_OFFSETS;
  buffer.writeUInt32LE(REG_STAGE_JOURNAL_MAGIC, O.magic);
  buffer.writeUInt16LE(record.version ?? REGISTRY_STAGE_VERSION, O.version);
  buffer.writeUInt16LE(record.kind, O.kind);
  buffer.writeUInt16LE(record.type ?? 0, O.type);
  buffer.writeUInt16LE(flags, O.flags);
  buffer.writeUInt32LE(pathBuffer.length / 2, O.pathChars);
  buffer.writeUInt32LE(nameBuffer.length / 2, O.nameChars);
  buffer.writeUInt32LE(dataBuffer.length, O.dataBytes);
  buffer.writeUInt32LE((record.status ?? 0) >>> 0, O.status);
  buffer.writeUInt32LE(0, O.reserved);
  let offset = REG_STAGE_RECORD_SIZE;
  pathBuffer.copy(buffer, offset);
  offset += pathBuffer.length;
  nameBuffer.copy(buffer, offset);
  offset += nameBuffer.length;
  dataBuffer.copy(buffer, offset);
  return buffer;
}
function decodeJournalRecords(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("decodeJournalRecords: buffer must be a Buffer");
  const records = [];
  const O = REG_STAGE_RECORD_OFFSETS;
  let offset = 0;
  let torn = false;
  while (offset + REG_STAGE_RECORD_SIZE <= buffer.length) {
    const magic = buffer.readUInt32LE(offset + O.magic);
    if (magic !== REG_STAGE_JOURNAL_MAGIC) {
      throw stageError(
        "REG_STAGE_JOURNAL_CORRUPT",
        `journal record at byte ${offset} has magic 0x${magic.toString(16)} (expected 0x${REG_STAGE_JOURNAL_MAGIC.toString(16)} 'DSRG')`,
        { offset }
      );
    }
    const version = buffer.readUInt16LE(offset + O.version);
    if (version !== REGISTRY_STAGE_VERSION) {
      throw stageError("REG_STAGE_JOURNAL_VERSION", `journal record version ${version} is not ${REGISTRY_STAGE_VERSION}`, {
        offset
      });
    }
    const kind = buffer.readUInt16LE(offset + O.kind);
    if (KIND_NAME[kind] === void 0) {
      throw stageError("REG_STAGE_JOURNAL_CORRUPT", `journal record kind ${kind} is unknown`, { offset });
    }
    const type = buffer.readUInt16LE(offset + O.type);
    const flags = buffer.readUInt16LE(offset + O.flags);
    const pathChars = buffer.readUInt32LE(offset + O.pathChars);
    const nameChars = buffer.readUInt32LE(offset + O.nameChars);
    const dataBytes = buffer.readUInt32LE(offset + O.dataBytes);
    const status = buffer.readUInt32LE(offset + O.status);
    const reserved = buffer.readUInt32LE(offset + O.reserved);
    const bodyStart = offset + REG_STAGE_RECORD_SIZE;
    const bodyBytes = pathChars * 2 + nameChars * 2 + dataBytes;
    if (bodyStart + bodyBytes > buffer.length) {
      torn = true;
      break;
    }
    const path = pathChars === 0 ? "" : buffer.toString("utf16le", bodyStart, bodyStart + pathChars * 2);
    const nameStart = bodyStart + pathChars * 2;
    const rawName = nameChars === 0 ? "" : buffer.toString("utf16le", nameStart, nameStart + nameChars * 2);
    const dataStart = nameStart + nameChars * 2;
    const wireBytes = dataBytes === 0 ? Buffer.alloc(0) : Buffer.from(buffer.subarray(dataStart, dataStart + dataBytes));
    const typeName = kind === REG_STAGE_KIND.SET_VALUE ? registryTypeName(type) : void 0;
    records.push({
      kind,
      kindName: KIND_NAME[kind],
      op: OP_BY_KIND[kind],
      version,
      type,
      typeName,
      flags,
      path,
      pathChars,
      nameChars,
      dataBytes,
      reserved,
      valueName: (flags & REG_STAGE_FLAGS.HAS_VALUE_NAME) !== 0 ? rawName : null,
      // `wireBytes` 是线格式原样字节（DLL 视角）；`data` 是快照口径的十六进制文本（宿主视角）。
      // 两者必须由同一对函数互转，否则"沙箱里写的"与"候选里记的"会分叉。
      wireBytes,
      data: (flags & REG_STAGE_FLAGS.HAS_DATA) !== 0 && typeName !== void 0 ? registryDataHex(typeName, wireBytes) : null,
      status,
      volatile: (flags & REG_STAGE_FLAGS.VOLATILE) !== 0
    });
    offset = bodyStart + bodyBytes;
  }
  if (offset < buffer.length && !torn) torn = true;
  return { records, bytesConsumed: offset, torn, trailingBytes: buffer.length - offset };
}
function replayJournal(records) {
  if (!Array.isArray(records)) throw new TypeError("replayJournal: records must be an array");
  let state = createOverlayState({});
  const hardDenied = [];
  const rejected = [];
  const unstaged = [];
  for (const record of records) {
    if (record.kind === REG_STAGE_KIND.HARD_DENY) {
      hardDenied.push({ path: record.path, status: record.status, api: record.api ?? null, reason: record.reason ?? null });
      continue;
    }
    if (record.kind === REG_STAGE_KIND.UNSTAGED) {
      unstaged.push({
        path: record.path,
        reasonCode: record.type,
        reasonName: UNSTAGED_REASON_NAME[record.type] ?? null,
        api: record.api ?? null,
        reason: record.reason ?? null
      });
      continue;
    }
    try {
      state = applyOverlayOperation(state, {
        op: record.op,
        path: record.path,
        type: record.typeName ?? record.type,
        valueName: record.valueName ?? "",
        value: record.data === null ? void 0 : decodeRegistryValue(record.typeName ?? record.type, record.data, record.valueName ?? ""),
        dwOptions: record.volatile ? REG_OPTIONS.REG_OPTION_VOLATILE : 0
      });
    } catch (error) {
      rejected.push({ path: record.path, op: record.op, code: error.code ?? "ERR", message: String(error.message) });
    }
  }
  return { state, hardDenied, rejected, unstaged };
}
function readJsonIfExists(path) {
  if (!existsSync6(path)) return void 0;
  try {
    return JSON.parse(readFileSync6(path, "utf8"));
  } catch {
    return void 0;
  }
}
function writeJson2(path, value) {
  mkdirSync6(dirname7(path), { recursive: true });
  writeFileSync7(path, `${JSON.stringify(value, null, 2)}
`);
}
function queueFileName() {
  return "queue.json";
}
function emptyQueue() {
  return { version: 1, order: [], candidates: {}, supersededBy: {}, discarded: [] };
}
function createRegistryStage(options = {}) {
  const sessionDir = assertNonEmptyString(options.sessionDir, "options.sessionDir");
  const stageRoot = resolveRegistryStageRoot(sessionDir);
  const hivePath = resolveRegistryStagePath(sessionDir);
  const journalPath = resolveRegistryStageJournalPath(sessionDir);
  const statePath = resolveRegistryStageStatePath(sessionDir);
  const discardedPath = resolveRegistryStageDiscardedPath(sessionDir);
  const candidateDir = join10(sessionDir, "candidates");
  const queuePath = join10(sessionDir, queueFileName());
  const now = typeof options.now === "function" ? options.now : () => (/* @__PURE__ */ new Date()).toISOString();
  const sessionId = typeof options.sessionId === "string" && options.sessionId.length > 0 ? options.sessionId : null;
  let reader = options.reader ?? null;
  let writer = options.writer ?? null;
  let state = createOverlayState({ sessionId });
  let resolution = { version: REGISTRY_STAGE_VERSION, status: "open", candidateId: null, appliedPaths: [], discardedAt: null, discardReason: null };
  let candidate = null;
  let opened = false;
  const baselines = /* @__PURE__ */ new Map();
  function baselineFor(path) {
    if (!reader || typeof reader.read !== "function") {
      throw stageError(
        "REG_READER_MISSING",
        "registry-stage has no reader: refusing to diff against an assumed-empty baseline (attach a host-token reader with setReader()/options.reader)"
      );
    }
    const canonical3 = parseRegistryPath(path).canonical;
    const key = fold(canonical3);
    if (!baselines.has(key)) baselines.set(key, readBaselineFresh(canonical3));
    return baselines.get(key);
  }
  function readBaselineFresh(path) {
    if (!reader || typeof reader.read !== "function") {
      throw stageError("REG_READER_MISSING", "registry-stage has no reader (see baselineFor)");
    }
    const canonical3 = parseRegistryPath(path).canonical;
    const raw = reader.read(canonical3);
    if (raw === void 0 || raw === null) {
      throw stageError(
        "REG_READ_EMPTY",
        `reader returned ${raw === null ? "null" : "undefined"} for ${canonical3}; an empty result is NOT "unchanged" and NOT a denial (manual ch.4)`
      );
    }
    return withBaselineKnowledge(normalizeSnapshot({ root: canonical3, ...raw }), raw, canonical3);
  }
  function saveResolution() {
    mkdirSync6(stageRoot, { recursive: true });
    writeJson2(statePath, resolution);
  }
  function appendRecord(record) {
    mkdirSync6(stageRoot, { recursive: true });
    const buffer = encodeJournalRecord(record);
    appendFileSync(journalPath, buffer);
    return buffer.length;
  }
  function requireOpen() {
    if (!opened) open();
  }
  function open() {
    mkdirSync6(stageRoot, { recursive: true });
    let resumedRecords = 0;
    let torn = false;
    let hardDenied = [];
    let rejected = [];
    let unstaged = [];
    if (existsSync6(journalPath)) {
      const decoded = decodeJournalRecords(readFileSync6(journalPath));
      const replay = replayJournal(decoded.records);
      state = replay.state;
      hardDenied = replay.hardDenied;
      rejected = replay.rejected;
      unstaged = replay.unstaged;
      resumedRecords = replay.state.ops.length;
      torn = decoded.torn;
    }
    const persisted = readJsonIfExists(statePath);
    if (persisted && typeof persisted === "object") resolution = { ...resolution, ...persisted };
    opened = true;
    return {
      sessionDir,
      stageRoot,
      hivePath,
      journalPath,
      statePath,
      sessionId,
      resumed: resumedRecords,
      torn,
      hardDenied,
      rejected,
      unstaged,
      status: resolution.status,
      hiveLoaded: false,
      note: "overlay.hive \u7531 shim \u7528 RegLoadAppKeyW \u52A0\u8F7D\uFF08\u672C\u6A21\u5757**\u4E0D**\u52A0\u8F7D\u5B83\uFF09\uFF1B\u5BBF\u4E3B\u53EA\u8BFB WAL\uFF08overlay.journal\uFF09\u4EA7\u5019\u9009\uFF0C\u56E0\u6B64\u4E0D\u9700\u8981\u8DE8\u8FDB\u7A0B IPC"
    };
  }
  function persistOperation(operation) {
    const canonical3 = parseRegistryPath(operation.path).canonical;
    const policy = classifyRegistryOperation({
      api: API_BY_OP[operation.op],
      path: canonical3,
      type: operation.type,
      dwOptions: operation.dwOptions,
      samDesired: operation.samDesired,
      wow64Process: operation.wow64Process
    });
    if (policy.unstaged === true) {
      const record2 = journalUnstagedRecord({
        api: API_BY_OP[operation.op],
        path: policy.code === "REG_STAGE_SAM_UNSTAGED" ? canonical3 : void 0,
        reason: policy.reason,
        unstagedReason: policy.unstagedReason ?? "UNRESOLVABLE_BASE_HANDLE"
      });
      const bytes2 = appendRecord(record2);
      return {
        status: REG_STATUS.ERROR_SUCCESS,
        path: canonical3,
        op: operation.op,
        seq: state.seq,
        bytes: bytes2,
        record: record2,
        net: false,
        staged: false,
        unstaged: true,
        unstagedReason: policy.unstagedReason ?? null,
        netEffect: "unstaged",
        reason: policy.reason,
        note: "overlay cannot represent this call: it was passed through to the real API (this facade only journals the audit record; the DLL performs the passthrough) and is NOT part of any candidate"
      };
    }
    if (!policy.stageable) throw policyRejection(policy);
    const net = filterOverlayNetOperations({ state, baselineFor, operation });
    if (net.effect === "unknown") {
      throw stageError(
        "REG_BASELINE_UNREADABLE",
        `${API_BY_OP[operation.op]}(${canonical3}): ${net.reason}`,
        { status: REG_STATUS.ERROR_ACCESS_DENIED, path: canonical3 }
      );
    }
    if (net.effect !== "net") {
      return {
        status: REG_STATUS.ERROR_SUCCESS,
        path: canonical3,
        op: operation.op,
        seq: state.seq,
        bytes: 0,
        record: null,
        net: false,
        netEffect: net.effect,
        reason: net.reason
      };
    }
    const record = journalRecordForOperation({ ...operation, path: canonical3 });
    const kept = net.state.ops.slice(state.ops.length);
    const bytes = kept.reduce((sum, entry) => sum + appendRecord(recordForOpEntry(entry, operation)), 0);
    state = net.state;
    return {
      status: REG_STATUS.ERROR_SUCCESS,
      path: canonical3,
      op: operation.op,
      seq: state.seq,
      bytes,
      record,
      net: true,
      netEffect: "net",
      reason: net.reason,
      entries: kept.length
    };
  }
  function recordForOpEntry(entry, operation) {
    if (entry.op === REG_STAGE_OP.CREATE_KEY && fold(entry.path) !== fold(parseRegistryPath(operation.path).canonical)) {
      return journalRecordForOperation({ op: "create-key", path: entry.path, dwOptions: entry.volatile ? REG_OPTIONS.REG_OPTION_VOLATILE : 0 });
    }
    return journalRecordForOperation({ ...operation, path: entry.path });
  }
  function isUnstageable(op, path, opts = {}, type) {
    return classifyRegistryOperation({
      api: API_BY_OP[op],
      path: parseRegistryPath(path).canonical,
      type,
      dwOptions: opts.dwOptions,
      samDesired: opts.samDesired,
      wow64Process: opts.wow64Process
    }).unstaged === true;
  }
  function stageCreateKey(path, opts = {}) {
    requireOpen();
    return persistOperation({
      op: REG_STAGE_OP.CREATE_KEY,
      path,
      dwOptions: opts.dwOptions ?? 0,
      samDesired: opts.samDesired ?? 0,
      wow64Process: opts.wow64Process
    });
  }
  function stageDeleteKey(path, opts = {}) {
    requireOpen();
    const canonical3 = parseRegistryPath(path).canonical;
    const operation = {
      op: REG_STAGE_OP.DELETE_KEY,
      path: canonical3,
      samDesired: opts.samDesired ?? 0,
      wow64Process: opts.wow64Process
    };
    if (isUnstageable(REG_STAGE_OP.DELETE_KEY, canonical3, opts)) return persistOperation(operation);
    const exists = effectiveExists(canonical3);
    if (!exists) {
      throw stageError("REG_STAGE_KEY_NOT_FOUND", `RegDeleteKeyExW(${canonical3}): \u952E\u4E0D\u5B58\u5728\uFF08ERROR_FILE_NOT_FOUND\uFF09`, {
        status: REG_STATUS.ERROR_FILE_NOT_FOUND,
        path: canonical3
      });
    }
    if (opts.recursive !== true) {
      const view = overlayView({ state, path: canonical3, baseline: baselineFor(canonical3) });
      if (view.subKeys.length > 0) {
        throw stageError(
          "REG_STAGE_KEY_HAS_CHILDREN",
          `RegDeleteKeyExW(${canonical3}): \u952E\u4ECD\u6709\u5B50\u952E\uFF08${view.subKeys.join(", ")}\uFF09\u21D2 ERROR_KEY_HAS_CHILDREN\uFF1B\u771F\u5B9E API \u540C\u6837\u4F1A\u62D2\u7EDD\uFF0C\u6682\u5B58**\u4E0D\u8BB8**\u5047\u88C5\u5220\u6389\u4E86\u4E00\u6574\u68F5\u5B50\u6811`,
          { status: REG_STATUS.ERROR_KEY_HAS_CHILDREN, path: canonical3, subKeys: [...view.subKeys] }
        );
      }
    }
    return persistOperation(operation);
  }
  function stageSetValue(path, valueName, type, value, opts = {}) {
    requireOpen();
    const canonical3 = parseRegistryPath(path).canonical;
    const operation = {
      op: REG_STAGE_OP.SET_VALUE,
      path: canonical3,
      valueName: typeof valueName === "string" ? valueName : "",
      type,
      value,
      dwOptions: opts.dwOptions ?? 0,
      samDesired: opts.samDesired ?? 0,
      wow64Process: opts.wow64Process
    };
    if (isUnstageable(REG_STAGE_OP.SET_VALUE, canonical3, opts, type)) return persistOperation(operation);
    if (!effectiveExists(canonical3)) {
      throw stageError("REG_STAGE_KEY_NOT_FOUND", `RegSetValueExW(${canonical3}): \u952E\u4E0D\u5B58\u5728\uFF08ERROR_FILE_NOT_FOUND\uFF09`, {
        status: REG_STATUS.ERROR_FILE_NOT_FOUND,
        path: canonical3
      });
    }
    return persistOperation(operation);
  }
  function stageDeleteValue(path, valueName, opts = {}) {
    requireOpen();
    const canonical3 = parseRegistryPath(path).canonical;
    const operation = {
      op: REG_STAGE_OP.DELETE_VALUE,
      path: canonical3,
      valueName: valueName ?? "",
      samDesired: opts.samDesired ?? 0,
      wow64Process: opts.wow64Process
    };
    if (isUnstageable(REG_STAGE_OP.DELETE_VALUE, canonical3, opts)) return persistOperation(operation);
    if (!effectiveExists(canonical3)) {
      throw stageError("REG_STAGE_KEY_NOT_FOUND", `RegDeleteValueW(${canonical3}): \u952E\u4E0D\u5B58\u5728`, {
        status: REG_STATUS.ERROR_FILE_NOT_FOUND,
        path: canonical3
      });
    }
    const view = overlayView({ state, path: canonical3, baseline: baselineFor(canonical3) });
    const wanted = fold(valueName ?? "");
    if (!Object.keys(view.values).some((name) => fold(name) === wanted)) {
      throw stageError("REG_STAGE_VALUE_NOT_FOUND", `RegDeleteValueW(${canonical3}\\${valueName}): \u503C\u4E0D\u5B58\u5728`, {
        status: REG_STATUS.ERROR_FILE_NOT_FOUND,
        path: canonical3,
        valueName
      });
    }
    return persistOperation(operation);
  }
  function effectiveExists(canonical3) {
    const overlay = overlayKeyExists(state, canonical3);
    if (overlay !== void 0) return overlay;
    const base = baselineFor(canonical3);
    if (base.accessDenied === true) {
      throw stageError(
        "REG_BASELINE_UNREADABLE",
        `baseline for ${canonical3} is unreadable (ERROR_ACCESS_DENIED); refusing to guess whether it exists`,
        { status: REG_STATUS.ERROR_ACCESS_DENIED, path: canonical3 }
      );
    }
    return base.exists === true;
  }
  function snapshot(path) {
    requireOpen();
    if (path !== void 0) {
      const canonical3 = parseRegistryPath(path).canonical;
      return overlayView({ state, path: canonical3, baseline: baselineFor(canonical3) });
    }
    const paths = overlayTouchedPaths(state);
    const baseline = {};
    const overlay = {};
    for (const entry of paths) {
      const base = baselineFor(entry);
      baseline[entry] = base;
      overlay[entry] = overlayView({ state, path: entry, baseline: base });
    }
    return { paths, baseline, overlay };
  }
  function diff() {
    requireOpen();
    return diffOverlay({ state, baselineFor });
  }
  function enqueueCandidate(frozen) {
    const existing = readJsonIfExists(queuePath);
    if (existing !== void 0 && existing.version !== 1) {
      throw stageError("REG_STAGE_QUEUE_VERSION", `unsupported queue version ${String(existing.version)} at ${queuePath}`);
    }
    const queue = existing ?? emptyQueue();
    queue.order = Array.isArray(queue.order) ? queue.order : [];
    queue.candidates = queue.candidates ?? {};
    queue.supersededBy = queue.supersededBy ?? {};
    queue.discarded = queue.discarded ?? [];
    queue.order.push(frozen.id);
    queue.candidates[frozen.id] = { id: frozen.id, status: CANDIDATE_STATUS.PENDING, createdAt: frozen.createdAt, files: frozen.summary.files };
    const unitPaths = new Set(frozen.changes.map((change) => fold(change.path)));
    for (const otherId of queue.order) {
      if (otherId === frozen.id) continue;
      const other = readJsonIfExists(join10(candidateDir, `${otherId}.json`));
      if (!other || other.status !== CANDIDATE_STATUS.PENDING) continue;
      if (other.origin !== REGISTRY_CANDIDATE_ORIGIN) continue;
      if (other.sessionId !== frozen.sessionId) continue;
      if (!other.changes.some((change) => unitPaths.has(fold(change.path)))) continue;
      other.status = CANDIDATE_STATUS.SUPERSEDED;
      other.supersededBy = frozen.id;
      other.supersededAt = frozen.createdAt;
      writeJson2(join10(candidateDir, `${otherId}.json`), other);
      queue.candidates[otherId] = { ...queue.candidates[otherId], status: CANDIDATE_STATUS.SUPERSEDED, supersededBy: frozen.id };
      queue.supersededBy[otherId] = frozen.id;
    }
    writeJson2(queuePath, queue);
    return queue;
  }
  function freezeCandidate(opts = {}) {
    requireOpen();
    const result = diff();
    const changes = overlayChangesToCandidateChanges(result);
    if (changes.length === 0) {
      return {
        enqueued: false,
        reason: result.unreadable.length > 0 ? "no-freezable-change" : "no-net-change",
        changes: [],
        unreadable: result.unreadable,
        subKeysUnknown: result.subKeysUnknown,
        warnings: result.warnings
      };
    }
    const queue = readJsonIfExists(queuePath);
    const sequence = (queue?.order?.length ?? 0) + 1;
    const id = typeof opts.id === "string" && opts.id.length > 0 ? opts.id : newCandidateId(sequence);
    const createdAt = now();
    const frozen = {
      version: 1,
      id,
      createdAt,
      sessionId,
      workspaceRoot: opts.workspaceRoot ?? options.workspaceRoot ?? null,
      revision: null,
      source: opts.source ?? REGISTRY_CANDIDATE_SOURCE,
      origin: REGISTRY_CANDIDATE_ORIGIN,
      status: CANDIDATE_STATUS.PENDING,
      supersededBy: void 0,
      changes,
      hostOperations: [],
      summary: summarizeRegistryChanges(changes),
      baselines: Object.fromEntries(
        Object.entries(result.roots).map(([path, root]) => [path, root.baselineFrozen])
      ),
      unfrozen: result.unreadable,
      // WP12：这些路径的**子键维度**没能冻结（读取器没报枚举）。如实落盘，别让"没冻结"
      // 看起来像"冻结了一个空表"。
      unfrozenSubKeys: result.subKeysUnknown,
      warnings: result.warnings,
      note: '\u6CE8\u518C\u8868\u5019\u9009\uFF1Abefore \u6765\u81EA\u5BBF\u4E3B\u4EE4\u724C\u4E0B\u7684\u771F\u5B9E hive \u5FEB\u7167\uFF0Cafter \u6765\u81EA\u8986\u76D6\u5C42\u89C6\u56FE\u3002\u5E94\u7528\u524D\u771F\u5B9E hive \u4E0D\u4F1A\u88AB\u672C\u5019\u9009\u6539\u52A8\uFF1B\u4E22\u5F03\u5373\u56DE\u5230"\u4EC0\u4E48\u90FD\u6CA1\u53D1\u751F"\u3002'
    };
    mkdirSync6(candidateDir, { recursive: true });
    writeJson2(join10(candidateDir, `${id}.json`), frozen);
    if (opts.enqueue !== false) enqueueCandidate(frozen);
    candidate = frozen;
    resolution = { ...resolution, status: CANDIDATE_STATUS.PENDING, candidateId: id };
    saveResolution();
    return {
      enqueued: opts.enqueue !== false,
      candidate: frozen,
      changes,
      unreadable: result.unreadable,
      subKeysUnknown: result.subKeysUnknown,
      warnings: result.warnings
    };
  }
  function applyUnits() {
    const units = [];
    for (const entry of state.ops) {
      if (entry.op === REG_STAGE_OP.CREATE_KEY) {
        units.push({
          op: "create-key",
          path: entry.path,
          keyPath: entry.path,
          // 保留 volatile 选项（WAL 里记了 VOLATILE 位）：否则"重启即失"的真实语义会在应用时丢失，
          // 而文档说"应用时保留该选项"就成了一句不成立的承诺。
          dwOptions: entry.volatile ? REG_OPTIONS.REG_OPTION_VOLATILE : 0
        });
      } else if (entry.op === REG_STAGE_OP.DELETE_KEY) units.push({ op: "delete-key", path: entry.path, keyPath: entry.path });
      else if (entry.op === REG_STAGE_OP.SET_VALUE) {
        units.push({
          op: "set-value",
          path: registryValueUnitPath(entry.path, entry.valueName ?? ""),
          keyPath: entry.path,
          valueName: entry.valueName ?? "",
          type: entry.typeName,
          data: entry.data
        });
      } else if (entry.op === REG_STAGE_OP.DELETE_VALUE) {
        units.push({
          op: "delete-value",
          path: registryValueUnitPath(entry.path, entry.valueName ?? ""),
          keyPath: entry.path,
          valueName: entry.valueName ?? ""
        });
      }
    }
    return units;
  }
  function frozenBaselineFor(canonical3) {
    if (!candidate || !candidate.baselines) return void 0;
    const wanted = fold(canonical3);
    const found = Object.entries(candidate.baselines).find(([path]) => fold(path) === wanted);
    return found ? found[1] : void 0;
  }
  function refreshFrozenBaseline(canonical3) {
    if (!candidate || !candidate.baselines) return;
    const fresh = serializeSnapshot(readBaselineFresh(canonical3));
    const wanted = fold(canonical3);
    const existing = Object.keys(candidate.baselines).find((path) => fold(path) === wanted);
    if (existing !== void 0) candidate.baselines[existing] = fresh;
    else candidate.baselines[canonical3] = fresh;
  }
  function apply(opts = {}) {
    requireOpen();
    if (resolution.status === CANDIDATE_STATUS.DISCARDED) {
      throw stageError("REG_CANDIDATE_DISCARDED", `registry candidate ${resolution.candidateId} was discarded`, {
        id: resolution.candidateId
      });
    }
    const activeWriter = opts.writer ?? writer;
    if (!activeWriter || typeof activeWriter !== "object") {
      throw stageError(
        "REG_WRITER_MISSING",
        "registry-stage.apply() needs a writer (host token). Without one we cannot apply, and pretending to apply would be exactly the dishonesty this project forbids"
      );
    }
    const frozen = candidate ?? freezeCandidate({ enqueue: false }).candidate;
    if (!frozen) return { status: "no-net-change", applied: [], failed: [], skipped: [], stale: [], note: "no changes to apply" };
    const selected = Array.isArray(opts.paths) && opts.paths.length > 0 ? new Set(opts.paths.map((path) => fold(path))) : null;
    const approved = new Set((frozen.changes ?? []).map((change) => fold(change.path)));
    const units = applyUnits();
    const applied2 = [];
    const failed = [];
    const skipped = [];
    const stale = [];
    const blocked = [];
    const appliedSet = new Set(resolution.appliedPaths.map((path) => fold(path)));
    const createdHere = /* @__PURE__ */ new Set();
    for (const unit of units) {
      if (!approved.has(fold(unit.path))) {
        skipped.push({ path: unit.path, op: unit.op, reason: "not-in-candidate" });
        continue;
      }
      if (selected && !selected.has(fold(unit.path))) {
        skipped.push({ path: unit.path, op: unit.op, reason: "not-selected" });
        continue;
      }
      if (appliedSet.has(fold(unit.path))) {
        skipped.push({ path: unit.path, op: unit.op, reason: "already-applied" });
        continue;
      }
      if (unit.op === "set-value" || unit.op === "delete-value" || unit.op === "delete-key") {
        let keyPresent = createdHere.has(fold(unit.keyPath));
        if (!keyPresent) {
          try {
            keyPresent = readBaselineFresh(unit.keyPath).exists === true;
          } catch (error) {
            blocked.push({
              path: unit.path,
              op: unit.op,
              status: REG_STATUS.ERROR_ACCESS_DENIED,
              reason: `cannot determine whether the parent key exists: ${error.code ?? error.name}`
            });
            continue;
          }
        }
        if (!keyPresent) {
          blocked.push({
            path: unit.path,
            op: unit.op,
            status: REG_STATUS.ERROR_FILE_NOT_FOUND,
            reason: `parent key ${unit.keyPath} does not exist in the real hive and its create-key unit was not applied (approve the mkdir unit too; apply() never silently creates an unapproved key)`
          });
          continue;
        }
      }
      if (unit.op === "create-key") {
        let alreadyThere = false;
        try {
          const current = readBaselineFresh(unit.keyPath);
          alreadyThere = current.exists === true && current.accessDenied !== true && current.unreadable !== true;
        } catch {
          alreadyThere = false;
        }
        if (alreadyThere) {
          skipped.push({
            path: unit.path,
            op: unit.op,
            noop: true,
            reason: 'already-exists-in-real-hive: RegCreateKeyExW is "open or create", so this unit is a no-op; a no-op create must not block the batch (and must not trigger `reg add <existing key> /f`)'
          });
          appliedSet.add(fold(unit.path));
          continue;
        }
      }
      const baselineFrozen = frozenBaselineFor(unit.keyPath);
      if (baselineFrozen !== void 0 && opts.force !== true) {
        const current = serializeSnapshot(readBaselineFresh(unit.keyPath));
        if (current !== baselineFrozen) {
          stale.push({
            path: unit.path,
            op: unit.op,
            reason: "real hive changed after the candidate was frozen; refusing to apply a stale before"
          });
          continue;
        }
      }
      let result;
      try {
        if (unit.op === "create-key") result = activeWriter.createKey(unit.path, { dwOptions: unit.dwOptions ?? 0 });
        else if (unit.op === "delete-key") result = activeWriter.deleteKey(unit.path, { recursive: true });
        else if (unit.op === "set-value") result = activeWriter.setValue(unit.keyPath, unit.valueName, unit.type, unit.data);
        else result = activeWriter.deleteValue(unit.keyPath, unit.valueName);
      } catch (error) {
        failed.push({ path: unit.path, op: unit.op, status: error.status ?? REG_STATUS.ERROR_ACCESS_DENIED, reason: String(error.message) });
        continue;
      }
      const status = (result?.status ?? result ?? 0) >>> 0;
      if (status === REG_STATUS.ERROR_SUCCESS) {
        applied2.push({ path: unit.path, op: unit.op });
        appliedSet.add(fold(unit.path));
        if (unit.op === "create-key") createdHere.add(fold(unit.path));
        if (unit.op === "delete-key") createdHere.delete(fold(unit.path));
        refreshFrozenBaseline(unit.keyPath);
      } else {
        failed.push({ path: unit.path, op: unit.op, status, reason: `writer returned LSTATUS ${status}` });
      }
    }
    resolution.appliedPaths = [.../* @__PURE__ */ new Set([...resolution.appliedPaths, ...applied2.map((unit) => unit.path)])];
    const remaining = units.filter((unit) => !appliedSet.has(fold(unit.path)));
    if (failed.length === 0 && remaining.length === 0 && applied2.length > 0) resolution.status = CANDIDATE_STATUS.APPLIED;
    else if (applied2.length > 0) resolution.status = CANDIDATE_STATUS.PARTIALLY_APPLIED;
    else if (stale.length > 0 && failed.length === 0) resolution.status = CANDIDATE_STATUS.STALE;
    saveResolution();
    if (candidate) writeJson2(join10(candidateDir, `${candidate.id}.json`), candidate);
    baselines.clear();
    return {
      id: frozen.id,
      status: resolution.status,
      applied: applied2,
      failed,
      skipped,
      stale,
      blocked,
      remaining: remaining.map((unit) => unit.path),
      note: "apply() \u5728**\u5BBF\u4E3B\u4EE4\u724C**\u4E0B\u9010\u6761\u91CD\u653E WAL\uFF08\u4FDD\u6301\u987A\u5E8F\uFF09\uFF1A\u672A\u9009\u4E2D\u7684\u5355\u5143\u4ECD\u7559\u5728\u8986\u76D6\u5C42\uFF0C\u771F\u5B9E hive \u53EA\u88AB\u5DF2 applied \u7684\u5355\u5143\u89E6\u78B0\uFF1B\u7236\u952E\u672A\u6279\u51C6\u65F6\u5B50\u5355\u5143\u8FDB `blocked`\uFF08status=2\uFF09\uFF0C\u4E0D\u4F1A\u88AB\u9759\u9ED8\u8865\u5EFA\uFF1B`RegCreateKeyExW` \u843D\u5728**\u771F\u5B9E\u5DF2\u5B58\u5728**\u7684\u952E\u4E0A\u65F6\u8FDB `skipped`\uFF08noop=true, WP12\uFF09\u2014\u2014\u7A7A\u64CD\u4F5C\u521B\u5EFA\u4E0D\u8BB8\u628A\u6574\u6279\u6253\u6210\u5931\u8D25"
    };
  }
  function discard(opts = {}) {
    requireOpen();
    resolution.status = CANDIDATE_STATUS.DISCARDED;
    resolution.discardedAt = now();
    resolution.discardReason = typeof opts.reason === "string" && opts.reason.length > 0 ? opts.reason : "user";
    saveResolution();
    let auditPath = null;
    if (existsSync6(journalPath)) {
      if (existsSync6(discardedPath)) rmSync5(discardedPath, { force: true });
      renameSync4(journalPath, discardedPath);
      auditPath = discardedPath;
    }
    let hiveRemoved = false;
    if (existsSync6(hivePath)) {
      rmSync5(hivePath, { force: true });
      hiveRemoved = true;
    }
    const id = resolution.candidateId;
    if (id) {
      const queue = readJsonIfExists(queuePath);
      if (queue && queue.version === 1 && queue.candidates?.[id]) {
        queue.candidates[id] = { ...queue.candidates[id], status: CANDIDATE_STATUS.DISCARDED };
        queue.discarded = [...queue.discarded ?? [], { id, at: resolution.discardedAt, reason: resolution.discardReason }];
        writeJson2(queuePath, queue);
      }
    }
    state = createOverlayState({ sessionId });
    baselines.clear();
    candidate = null;
    return {
      discarded: true,
      id: id ?? null,
      auditPath,
      hiveRemoved,
      note: '\u4E22\u5F03\u53EA\u6E05\u7406\u8986\u76D6\u5C42\uFF1A\u771F\u5B9E hive \u4E4B\u6240\u4EE5\u6CA1\u53D8\uFF0C\u662F\u56E0\u4E3A apply() \u4ECE\u672A\u8FD0\u884C\u8FC7 \u2014\u2014 \u800C\u4E0D\u662F\u56E0\u4E3A"\u6211\u4EEC\u628A\u6539\u52A8\u64A4\u56DE\u6765\u4E86"'
    };
  }
  return {
    // 只读元信息
    sessionDir,
    stageRoot,
    hivePath,
    journalPath,
    statePath,
    discardedPath,
    sessionId,
    // 生命周期
    open,
    snapshot,
    diff,
    freezeCandidate,
    apply,
    discard,
    // 暂存写入（宿主侧参考实现；DLL 走同一份 WAL 协议）
    stageCreateKey,
    stageDeleteKey,
    stageSetValue,
    stageDeleteValue,
    // 查询（shim 语义的参考实现）
    readKey: (path) => {
      requireOpen();
      return overlayQueryKey({ state, path, baseline: baselineFor(path) });
    },
    readValue: (path, valueName = "") => {
      requireOpen();
      return overlayQueryValue({ state, path, valueName, baseline: baselineFor(path) });
    },
    enumKeys: (path) => {
      requireOpen();
      return overlayEnumKeys({ state, path, baseline: baselineFor(path) });
    },
    enumValues: (path) => {
      requireOpen();
      return overlayEnumValues({ state, path, baseline: baselineFor(path) });
    },
    // 注入与内部状态
    setReader: (next) => {
      reader = next;
      baselines.clear();
      return next;
    },
    setWriter: (next) => {
      writer = next;
      return next;
    },
    getState: () => state,
    getResolution: () => ({ ...resolution }),
    getCandidate: () => candidate,
    hardDenials: () => REGISTERED_HARD_DENIALS
  };
}
var REG_STAGE_ABI_REQUIRED_EXPORTS = Object.freeze([
  "DshRegStageAbiVersion",
  "DshRegStageAttach",
  "DshRegStageDetach",
  "DshRegStageJournalAppend"
]);
var REG_STAGE_ABI_OPTIONAL_EXPORTS = Object.freeze(["DshRegStageAttachState"]);
var REG_STAGE_CONFORMANCE = Object.freeze({
  abiVersion: REG_STAGE_ABI_VERSION,
  requiredExports: REG_STAGE_ABI_REQUIRED_EXPORTS,
  optionalExports: REG_STAGE_ABI_OPTIONAL_EXPORTS,
  /** 暂存根（shim 现有环境变量）；`registry/` 由 DLL 拼在其下 */
  stageRootEnv: "WINSTAGE_STAGE_ROOT",
  /** 兼容别名：DshRegStageAttach 的显式参数优先于任何环境变量 */
  stageRootAliasEnv: "DSH_REGSTAGE_ROOT",
  stageSubdir: REGISTRY_STAGE_SUBDIR,
  journalName: OVERLAY_JOURNAL_NAME,
  /** RECOMMENDED：shim 自用的读回存储（宿主**不**读它）；用不用 app hive 是 T4 的实现自由 */
  hiveName: OVERLAY_HIVE_NAME,
  stateName: OVERLAY_STATE_NAME,
  recordSize: REG_STAGE_RECORD_SIZE,
  recordOffsets: REG_STAGE_RECORD_OFFSETS,
  magic: REG_STAGE_JOURNAL_MAGIC,
  hookedApis: REG_STAGE_HOOKED_APIS,
  hardDenyStatus: HARD_DENY_STATUS,
  walFirst: true,
  /** T4 的闭环节 runner 必须满足的四条（否则 E3/E5 永远证明不了闭环） */
  runnerRequirements: Object.freeze([
    "E3.overlay-has-value \u5FC5\u987B\u6539\u6210\u8BFB <stageRoot>/registry/overlay.journal \u5E76\u65AD\u8A00 SET_VALUE \u8BB0\u5F55\uFF08path/name/type/data \u9010\u5B57\u6BB5\uFF09\uFF0C\u4E0D\u518D\u6BD4\u8F83 values.wsv \u7684\u5341\u516D\u8FDB\u5236\u6587\u672C",
    '\u65B0\u589E E3.host-can-freeze-candidate\uFF1A\u5BBF\u4E3B createRegistryStage({sessionDir, reader}) \u2192 freezeCandidate() \u5FC5\u987B\u5305\u542B\u8BE5\u5199\u5165\uFF08\u8FD9\u662F"\u8D70\u5BA1\u6279\u9762\u677F"\u7684\u95ED\u73AF\uFF09',
    "E5.registry-read-back \u5FC5\u987B\u8981\u6C42 queryRc==0 \u65F6\u56DE\u4F20\u5185\u5BB9\uFF08data \u4E3A\u5B57\u7B26\u4E32\uFF0C\u6216 bytes>0\uFF09\uFF0C\u4E14 type \u662F\u5408\u6CD5 REG_*\uFF080..11\uFF09",
    "\u95ED\u73AF\u8282\u62A5\u544A\u5FC5\u987B\u6BD4 winstage-shim.dll \u65B0\uFF1A\u5426\u5219\u8BC1\u636E\u8FC7\u671F\uFF0C\u5FC5\u987B\u91CD\u8DD1 node tools/run-shim-closedloop.ts"
  ]),
  note: "\u8986\u76D6\u5C42\u662F**\u903B\u8F91\u91CD\u5B9A\u5411**\uFF1A\u5BBF\u4E3B\u53EA\u9700\u8981 registry/overlay.journal\uFF1Boverlay.hive \u662F shim \u5185\u90E8\u8BFB\u56DE\u5B58\u50A8\u7684\u63A8\u8350\u5B9E\u73B0\uFF0C\u5BBF\u4E3B\u4E0D\u8BFB\u5B83\u3002\u771F\u5B9E hive \u5728 apply() \u4E4B\u524D\u4E0D\u5F97\u88AB\u89E6\u78B0\u3002"
});
var __internal3 = {
  API_BY_OP,
  KIND_BY_OP,
  OP_BY_KIND,
  KIND_NAME,
  fold,
  lastSegment,
  isDirectChildFold,
  ancestorFolds,
  stageError,
  HIVE_CANONICAL,
  /**
   * 枚举合并开关（**只供变异体自证**，生产路径恒为 true）。
   *
   * 设成 false 即恢复"覆盖层里有键目录就只列覆盖层"的旧行为 —— 也就是 2026-09-30
   * 实测到的阻塞级缺陷（`HKCU\Software` 下真实子键全部消失 ⇒ PowerShell 起不来）。
   * `tests/registry-stage.ts` 用它证明"并集断言真的有判定力"（把并集退化 ⇒ 断言必须红）。
   * ⚠ 与 registry-guard 的 `decodeGuard` 同一条纪律：**读取时机在调用点**（不捕获快照），
   * 因此声明位置不影响语义，但任何"模块求值期间就调用 overlayView"的代码会撞 TDZ。
   */
  enumerationMerge: true
};

// src/registry-bindings.ts
import { closeSync as closeSync3, existsSync as existsSync7, mkdtempSync, openSync as openSync3, readFileSync as readFileSync7, rmSync as rmSync6 } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir as tmpdir3 } from "node:os";
import { join as join11 } from "node:path";
function regExePath(env = process.env) {
  const root = env.SystemRoot || env.windir || "C:\\Windows";
  const candidate = join11(root, "System32", "reg.exe");
  return existsSync7(candidate) ? candidate : "reg.exe";
}
var SUPPORTED = /* @__PURE__ */ new Set(["REG_SZ", "REG_EXPAND_SZ", "REG_DWORD", "REG_BINARY", "REG_MULTI_SZ"]);
var QUERY_DENIED = /拒绝访问|Access is denied/i;
var QUERY_NOT_FOUND = /unable to find the specified registry key|找不到指定的注册表项/i;
var HIVE_LONG_NAME = Object.freeze({
  HKCR: "HKEY_CLASSES_ROOT",
  HKCU: "HKEY_CURRENT_USER",
  HKLM: "HKEY_LOCAL_MACHINE",
  HKU: "HKEY_USERS",
  HKCC: "HKEY_CURRENT_CONFIG"
});
function longHivePath(canonical3) {
  const head = canonical3.split("\\")[0];
  const long = HIVE_LONG_NAME[head.toUpperCase()];
  return long === void 0 ? canonical3 : long + canonical3.slice(head.length);
}
function classifyQueryFailure(result, canonical3) {
  const text = `${result.stdout ?? ""}
${result.stderr ?? ""}`;
  if (QUERY_DENIED.test(text)) {
    return {
      exists: true,
      accessDenied: true,
      errorCode: 5,
      subKeysKnown: false,
      unreadableReason: `reg query ${canonical3} was denied (ERROR_ACCESS_DENIED)`
    };
  }
  if (QUERY_NOT_FOUND.test(text)) {
    return { exists: false, accessDenied: false, errorCode: 2, subKeysKnown: true };
  }
  return {
    exists: true,
    accessDenied: false,
    unreadable: true,
    errorCode: result.status ?? 5,
    subKeysKnown: false,
    unreadableReason: `reg query ${canonical3} did not run or failed unrecognizably (status=${result.status}, via=${result.via ?? "pipe"}, error=${result.error ?? "none"}, stderr=${JSON.stringify(String(result.stderr ?? "").slice(0, 200))}): refusing to translate "we could not read it" into "the key does not exist"`
  };
}
function runReg(args, options = {}) {
  const mode = options.stdio ?? "auto";
  if (mode === "file" || mode === "auto" && pipesRefused) return runRegRedirected(args, options);
  const piped = spawnCaptured(args, options);
  if (piped.status !== null || mode === "pipe") return piped;
  pipesRefused = true;
  const redirected = runRegRedirected(args, options);
  redirected.pipeError = piped.error ?? "unknown";
  redirected.note = `piped stdio was refused (${redirected.pipeError}); retried with file redirection (residual boundary R10: a confined host cannot open named pipes)`;
  return redirected;
}
var pipesRefused = false;
function describeSpawnError(error) {
  return `${error?.code ?? error?.name ?? "ERR"}: ${error?.message ?? error}`;
}
function decodeOemIfMojibake(buffer) {
  for (const label of ["gbk", "gb18030", "big5", "shift_jis", "euc-kr", "windows-1251", "windows-1252"]) {
    try {
      const text = new TextDecoder(label, { fatal: false }).decode(buffer);
      if (!text.includes("\uFFFD")) return text;
    } catch {
    }
  }
  return null;
}
function decodeRegOutput(value) {
  if (!Buffer.isBuffer(value)) return typeof value === "string" ? value : "";
  if (value.length === 0) return "";
  if (guessEncoding(value) === "utf16le") return value.toString("utf16le");
  const utf8 = value.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  return decodeOemIfMojibake(value) ?? utf8;
}
function spawnCaptured(args, options) {
  try {
    const result = spawnSync(regExePath(options.env), args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      timeout: options.timeoutMs ?? 3e4,
      encoding: null,
      maxBuffer: 32 * 1024 * 1024
    });
    return {
      status: result.status,
      stdout: decodeRegOutput(result.stdout),
      stderr: decodeRegOutput(result.stderr),
      error: result.error ? describeSpawnError(result.error) : null,
      via: "pipe"
    };
  } catch (error) {
    return { status: null, stdout: "", stderr: "", error: describeSpawnError(error), via: "pipe" };
  }
}
function runRegRedirected(args, options) {
  let dir;
  try {
    dir = mkdtempSync(join11(options.tmpDir ?? tmpdir3(), "winstage-reg-"));
  } catch (error) {
    return { status: null, stdout: "", stderr: "", error: `cannot create redirect dir: ${describeSpawnError(error)}`, via: "file" };
  }
  const outPath = join11(dir, "stdout.bin");
  const errPath = join11(dir, "stderr.bin");
  let fdOut;
  let fdErr;
  try {
    fdOut = openSync3(outPath, "w");
    fdErr = openSync3(errPath, "w");
    const result = spawnSync(regExePath(options.env), args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      timeout: options.timeoutMs ?? 3e4,
      stdio: ["ignore", fdOut, fdErr]
    });
    closeSync3(fdOut);
    fdOut = void 0;
    closeSync3(fdErr);
    fdErr = void 0;
    return {
      status: result.status,
      stdout: readRedirected(outPath),
      stderr: readRedirected(errPath),
      error: result.error ? describeSpawnError(result.error) : null,
      via: "file"
    };
  } catch (error) {
    return { status: null, stdout: "", stderr: "", error: describeSpawnError(error), via: "file" };
  } finally {
    if (fdOut !== void 0) {
      try {
        closeSync3(fdOut);
      } catch {
      }
    }
    if (fdErr !== void 0) {
      try {
        closeSync3(fdErr);
      } catch {
      }
    }
    try {
      rmSync6(dir, { recursive: true, force: true });
    } catch {
    }
  }
}
function readRedirected(path) {
  try {
    return decodeRegOutput(readFileSync7(path));
  } catch {
    return "";
  }
}
function guessEncoding(buffer) {
  if (buffer.length > 1 && buffer[1] === 0) return "utf16le";
  return "utf8";
}
function createRegExeReader(options = {}) {
  const exec = options.exec ?? runReg;
  return {
    read(canonical3) {
      const r = exec(["query", canonical3], options);
      if (r.status !== 0) return classifyQueryFailure(r, canonical3);
      const values = {};
      const subKeys = [];
      const self = canonical3.toLowerCase();
      const selfLong = longHivePath(canonical3).toLowerCase();
      const prefixes = [`${self}\\`, `${selfLong}\\`];
      for (const raw of r.stdout.split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, "");
        if (!line) continue;
        if (!/^\s/.test(line)) {
          const base = line.trim();
          const lower = base.toLowerCase();
          if (lower === self || lower === selfLong) continue;
          const prefix = prefixes.find((candidate) => lower.startsWith(candidate));
          subKeys.push(prefix === void 0 ? base.split("\\").pop() : base.slice(prefix.length));
          continue;
        }
        const m = line.match(/^\s{2,}(.*?)\s{4,}(REG_[A-Z_]+)(?:\s{0,4}(.*))?$/);
        if (!m) continue;
        const name = m[1] === "(Default)" ? "" : m[1];
        const type = m[2];
        const data = (m[3] ?? "").trim();
        if (!SUPPORTED.has(type)) {
          throw Object.assign(new Error(`reader: unsupported value type ${type} for ${name} in ${canonical3}`), {
            code: "REG_READ_UNSUPPORTED_TYPE"
          });
        }
        values[name] = { type, data: type === "REG_BINARY" ? data.replace(/\s+/g, "") : data };
      }
      return { exists: true, accessDenied: false, errorCode: 0, subKeys, subKeysKnown: true, values };
    }
  };
}
function createRegExeWriter(options = {}) {
  const exec = options.exec ?? runReg;
  const log = options.log ?? (() => {
  });
  const REG_OPTION_VOLATILE = 1;
  const wire = options.wireBytes;
  const statusOf = (r) => {
    if (r.status === 0) return 0;
    if (r.status === null) return 5;
    return r.status;
  };
  return {
    createKey(path, opts = {}) {
      if (((opts.dwOptions ?? 0) & REG_OPTION_VOLATILE) !== 0) {
        log(`writer: refusing REG_OPTION_VOLATILE via reg.exe (unsupported): ${path}`);
        return { status: 87, message: "REG_OPTION_VOLATILE cannot be expressed through reg.exe" };
      }
      const r = exec(["add", path, "/f"], options);
      return { status: statusOf(r) };
    },
    setValue(path, valueName, type, dataHex) {
      const typeName = typeof type === "string" && type.startsWith("REG_") ? type : String(type);
      let rendered;
      try {
        rendered = renderValue(typeName, dataHex, wire);
      } catch (error) {
        return { status: 87, message: `${error?.message ?? error}` };
      }
      const args = valueName === void 0 || valueName === null || valueName === "" ? ["add", path, "/ve", "/t", typeName, "/d", rendered, "/f"] : ["add", path, "/v", valueName, "/t", typeName, "/d", rendered, "/f"];
      const r = exec(args, options);
      return { status: statusOf(r) };
    },
    deleteValue(path, valueName) {
      const args = valueName === void 0 || valueName === null || valueName === "" ? ["delete", path, "/ve", "/f"] : ["delete", path, "/v", valueName, "/f"];
      const r = exec(args, options);
      return { status: statusOf(r) };
    },
    deleteKey(path) {
      const r = exec(["delete", path, "/f"], options);
      return { status: statusOf(r) };
    }
  };
}
function renderValue(typeName, dataHex, wire) {
  const buffer = typeof wire === "function" ? wire(typeName, dataHex) : void 0;
  if (!Buffer.isBuffer(buffer)) {
    throw new Error(`cannot render ${typeName}: no wire encoder was provided`);
  }
  if (typeName === "REG_DWORD") {
    if (buffer.length !== 4) throw new Error(`REG_DWORD wire length must be 4, got ${buffer.length}`);
    return String(buffer.readUInt32LE(0));
  }
  if (typeName === "REG_BINARY") return buffer.toString("hex");
  if (typeName === "REG_SZ" || typeName === "REG_EXPAND_SZ") {
    return buffer.toString("utf16le").replace(/\u0000+$/, "");
  }
  if (typeName === "REG_MULTI_SZ") {
    return buffer.toString("utf16le").replace(/\u0000+$/, "").split("\0").join("\\0");
  }
  throw new Error(`unsupported value type ${typeName}`);
}

// dsh-plugin/review-service.ts
function isRegistryCandidate(candidate) {
  return candidate !== null && typeof candidate === "object" && (candidate.origin === "registry" || candidate.source === REGISTRY_CANDIDATE_SOURCE);
}
var REVIEW_BASENAME = "review.json";
var EFFECTIVE_STAGING = /* @__PURE__ */ new Map();
function noteEffectiveStaging(workspaceRoot, enabled) {
  const key = String(workspaceRoot ?? "").toLowerCase();
  if (key.length === 0) return;
  EFFECTIVE_STAGING.set(key, { enabled: enabled === true, workspaceRoot, seenAt: Date.now() });
}
function effectiveStagingOf(workspaceRoot) {
  return EFFECTIVE_STAGING.get(String(workspaceRoot ?? "").toLowerCase());
}
function shellEnvOverride(env = process.env) {
  const raw = env?.WINSTAGE_SHELL;
  if (raw === "1") return { value: "1", forced: true, text: "WINSTAGE_SHELL=1\uFF08\u5F3A\u5236 WinStage \u63A5\u7BA1\uFF09" };
  if (raw === "0") return { value: "0", forced: true, text: "WINSTAGE_SHELL=0\uFF08\u5F3A\u5236\u4EA4\u8FD8\u5E73\u53F0\uFF09" };
  return { value: raw === void 0 ? null : String(raw), forced: false, text: null };
}
var AUTO_REBASE_INTERVAL_MS = 1e3;
var SENSITIVE_OMIT_NOTE = "\u5185\u5BB9\u5DF2\u6309\u654F\u611F\u7B56\u7565\u7701\u7565\uFF08\u4E0D\u628A\u51ED\u636E/\u5BC6\u94A5\u7247\u6BB5\u5199\u5165 review.json\uFF09";
var SENSITIVE_MASK_NOTE = "\u5185\u5BB9\u5DF2\u6309\u654F\u611F\u7B56\u7565\u63A9\u7801\uFF08\u4FDD\u7559\u952E\u540D/\u7F29\u8FDB/\u957F\u5EA6\uFF0C\u503C\u66FF\u6362\u4E3A <REDACTED len=\u2026>\uFF09";
var DANGER_MASK_IDS = Object.freeze([
  SELF_MASK_ID,
  // 'stage-store' → 本工具自身的存储树（遮蔽表里那条 hard 规则）
  "ssh",
  "aws",
  "gcloud",
  "kube",
  "git-credentials",
  "npmrc",
  "dsh-home",
  "dpapi",
  "dpapi-user",
  "browser",
  "sam",
  "sysvol-copy",
  "wifi"
]);
var REQUIRED_MASK_IDS = Object.freeze([...DANGER_MASK_IDS, "hosts"]);
var DANGER_IDS = new Set(DANGER_MASK_IDS);
function effectiveStagingSnapshot(workspaceRoot, hint) {
  const observed = effectiveStagingOf(workspaceRoot);
  const override = shellEnvOverride();
  const effective = hint && typeof hint.enabled === "boolean" ? hint.enabled : observed?.enabled ?? null;
  return {
    /** 快照根（面板据此确认这是不是自己的根） */
    workspaceRoot,
    /** **生效值**：这个暂存根此刻是否真的在接管；`null` = 本进程未观察到 */
    effective,
    /**
     * **配置值**（loader 行 `config.enabled` 的判定结果）：
     * `true` / `false` = 读到明确值；`null` = 没注入（自测/无装配方）。
     * 与 `effective` 并列给出 ⇒ 界面不必再"用一个猜另一个"（R11 D7-d 的根因）。
     */
    configValue: hint && typeof hint.enabled === "boolean" ? hint.enabled : null,
    /** 观察时间（`null` = 没有观察记录） */
    observedAt: observed ? new Date(observed.seenAt).toISOString() : null,
    /** 生效值的**依据**（`staging-fs` 登记 / 装配方注入 / 未观察到） */
    source: hint && typeof hint.enabled === "boolean" ? "config" : observed ? "staging-fs" : "unobserved",
    /** 进程级 `WINSTAGE_SHELL` 是否**强制**了某一侧（D7-c/d 的"被环境变量强制"） */
    shellOverride: { value: override.value, forced: override.forced, text: override.text },
    /**
     * "配置值 vs 生效值不一致"的机读结论。`null` = 一致或无法比较。
     * 面板据此把状态词写成"已关闭（但当前由环境变量强制接管）"这类**同时呈现两者**的句子。
     */
    mismatch: hint && typeof hint.enabled === "boolean" && effective !== null && hint.enabled !== effective ? { configValue: hint.enabled, effective, reason: override.forced ? "env-override" : "profile-overlay" } : null
  };
}
function assertDangerIdsExist() {
  const known = new Set(MASK_CLASSES.map((rule) => rule.id));
  const missing = REQUIRED_MASK_IDS.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new Error(
      `review-service: MASK_CLASSES \u91CC\u627E\u4E0D\u5230\u8FD9\u4E9B id\uFF0C\u5224\u7EA7\u4F1A\u9759\u9ED8\u5931\u51C6\uFF1A${missing.join(", ")}\u3002\u8BF7\u540C\u6B65 src/paths.ts \u4E0E review-service.ts \u7684\u5371\u9669\u6E05\u5355\u3002`
    );
  }
  const wrong = DANGER_MASK_IDS.filter((id) => !DANGER_IDS.has(id));
  if (wrong.length > 0) throw new Error(`review-service: DANGER_MASK_IDS \u81EA\u76F8\u77DB\u76FE\uFF1A${wrong.join(", ")}`);
  return true;
}
assertDangerIdsExist();
var BUILTIN_MASK_IDS = new Set(MASK_CLASSES.map((rule) => rule.id));
function isDangerMask(mask, dangerIds) {
  const id = mask?.id;
  if (dangerIds.has(id)) return true;
  if (id && !BUILTIN_MASK_IDS.has(id) && mask?.hard === true) return true;
  return false;
}
function resolveReviewStoreDir({ workspaceRoot, sessionId, storeDir, stageRoot, env } = {}) {
  if (storeDir !== void 0 && storeDir !== null && String(storeDir).trim() !== "") {
    return String(storeDir);
  }
  return resolveStageRoot({
    // 无会话身份时用**共享服务**的会话 id（与 `ReviewService` 构造函数的默认值同源），
    // 这样"共享服务写在哪"与"它自己的快照发布在哪"必然是同一个目录。
    sessionKey: sessionDirKey(sessionId) || DEFAULT_REVIEW_SESSION_ID,
    workspaceRoot,
    env,
    override: stageRoot
  });
}
function legacyWorkspaceStoreDir(workspaceRoot) {
  return join12(String(workspaceRoot), STORE_DIR);
}
var READ_POLICIES = Object.freeze(["record", "block"]);
var DEFAULT_READ_POLICY = "record";
var DEFAULT_REVIEW_SESSION_ID = "dsh-host";
var MAX_READ_VISIBILITY_KEYS = 200;
var READ_VISIBILITY = /* @__PURE__ */ new Map();
function readVisibilityKey(sessionId) {
  return sessionDirKey(sessionId) || DEFAULT_REVIEW_SESSION_ID;
}
function visibilityEntry(sessionId, policy) {
  const key = readVisibilityKey(sessionId);
  let entry = READ_VISIBILITY.get(key);
  if (!entry) {
    entry = { key, policy: DEFAULT_READ_POLICY, reads: 0, byKey: /* @__PURE__ */ new Map(), notices: /* @__PURE__ */ new Set() };
    READ_VISIBILITY.set(key, entry);
  }
  if (policy !== void 0 && READ_POLICIES.includes(policy)) entry.policy = policy;
  return entry;
}
function setReadVisibilityPolicy(sessionId, policy) {
  return visibilityEntry(sessionId, policy).policy;
}
function recordReadVisibility(input = {}) {
  const entry = visibilityEntry(input.sessionId);
  const maskId = String(input.maskId ?? "unknown");
  const key = String(input.maskKey ?? "");
  const dedupKey = `${maskId}\0${key.toLowerCase()}`;
  entry.reads += 1;
  const existing = entry.byKey.get(dedupKey);
  if (existing) {
    existing.reads += 1;
    existing.lastAt = (/* @__PURE__ */ new Date()).toISOString();
    if (input.op && !existing.ops.includes(input.op)) existing.ops.push(input.op);
    return { dedupKey, maskId, reads: existing.reads, firstForMaskId: false, dropped: false };
  }
  if (entry.byKey.size >= MAX_READ_VISIBILITY_KEYS) {
    return { dedupKey, maskId, reads: 1, firstForMaskId: false, dropped: true };
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  entry.byKey.set(dedupKey, {
    maskId,
    path: key,
    reason: input.reason,
    reads: 1,
    ops: input.op ? [input.op] : [],
    firstAt: now,
    lastAt: now
  });
  const firstForMaskId = !entry.notices.has(maskId);
  if (firstForMaskId) entry.notices.add(maskId);
  return { dedupKey, maskId, reads: 1, firstForMaskId, dropped: false };
}
function readVisibilitySnapshot(sessionId) {
  const entry = visibilityEntry(sessionId);
  const byMaskId = {};
  const items = [];
  for (const item of entry.byKey.values()) {
    byMaskId[item.maskId] = (byMaskId[item.maskId] ?? 0) + 1;
    items.push({
      maskId: item.maskId,
      path: item.path,
      reason: item.reason,
      reads: item.reads,
      ops: [...item.ops],
      firstAt: item.firstAt,
      lastAt: item.lastAt
    });
  }
  items.sort((a, b) => a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : 0);
  return {
    policy: entry.policy,
    /** 去重后的"敏感对象"条数（去重键 = `maskId + maskKey`） */
    objects: entry.byKey.size,
    /** 未去重的读取次数（同一个对象读 N 次就 +N，但**不**新增条目） */
    reads: entry.reads,
    /** 是否因为条目上限而不再新增条目（只累计 `reads`）—— 如实标注，不假装计数完整 */
    truncated: entry.byKey.size >= MAX_READ_VISIBILITY_KEYS,
    byMaskId,
    items,
    note: "\u8BFB\u4FA7\u53EF\u89C1\u6027\uFF1A\u53EA\u8BB0\u5F55\u3001\u4E0D\u6539\u5199\u8BFB\u7ED3\u679C\uFF08\u9ED8\u8BA4 readPolicy=record\uFF09\u3002\u8FD9\u662F\u9ED1\u540D\u5355\u5F0F\u7684\u8BB0\u5F55\uFF0C\u4E0D\u662F\u8BFB\u8FB9\u754C\u3002"
  };
}
function driftReasonText(reason) {
  if (reason === "baseline-appeared") return '\u771F\u5B9E\u6587\u4EF6\u5728\u6682\u5B58\u4E4B\u540E\u51FA\u73B0\uFF08\u57FA\u7EBF\u672C\u4E3A"\u4E0D\u5B58\u5728"\uFF09';
  if (reason === "baseline-deleted") return "\u771F\u5B9E\u6587\u4EF6\u5728\u6682\u5B58\u4E4B\u540E\u88AB\u5916\u90E8\u5220\u9664";
  return "\u771F\u5B9E\u6587\u4EF6\u5728\u6682\u5B58\u4E4B\u540E\u88AB\u5916\u90E8\u6539\u5199";
}
function classifyChange(change, options = {}) {
  if (typeof change?.path !== "string" || change.path.length === 0) {
    throw new TypeError("classifyChange: change.path must be a non-empty string");
  }
  const workspaceRoot = options.workspaceRoot;
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new TypeError("classifyChange: options.workspaceRoot is required");
  }
  const explicitExternal = typeof change.external === "boolean" ? change.external : void 0;
  const absolute = isAbsolute4(change.path) ? change.path : join12(workspaceRoot, change.path);
  const resolved = canonical(absolute);
  const dangerIds = options.dangerMaskIds ? new Set(options.dangerMaskIds) : DANGER_IDS;
  const mask = maskReason(resolved, options.masks || []);
  let inside;
  if (explicitExternal === void 0) {
    try {
      inside = isInside(workspaceRoot, resolved);
    } catch {
      inside = true;
    }
  }
  const external = explicitExternal ?? !inside;
  if (mask) {
    return {
      external,
      risk: "sensitive",
      safety: isDangerMask(mask, dangerIds) ? "danger" : "risk",
      riskReason: mask.reason ?? null
    };
  }
  const outside = external === true || inside === false;
  return {
    external: outside,
    risk: outside ? "outside" : "normal",
    safety: null,
    riskReason: null
  };
}
function countRisks(files) {
  const counts = { normal: 0, outside: 0, sensitive: 0, danger: 0 };
  for (const item of files) {
    if (item.risk === "normal") counts.normal += 1;
    else if (item.risk === "outside") counts.outside += 1;
    else if (item.risk === "sensitive") {
      counts.sensitive += 1;
      if (item.safety === "danger") counts.danger += 1;
    }
  }
  return counts;
}
function truncatedReasonOf(listed = [], listedCount = 0) {
  const rowTruncated = listed.length > listedCount;
  const contentTruncated = listed.some((item) => item?.truncated === true);
  const parts = [];
  if (rowTruncated) parts.push("row-limit");
  if (contentTruncated) parts.push("content-limit");
  return parts.length === 0 ? null : parts.join("+");
}
function buildAlerts(files, candidateId) {
  const dangers = files.filter((item) => item.safety === "danger");
  if (dangers.length === 0) return [];
  return [
    {
      id: `${candidateId ?? "no-candidate"}:danger`,
      kind: "danger-change",
      severity: "danger",
      count: dangers.length,
      /** 命中的路径（供 Client 定位；顺序即 files 顺序） */
      paths: dangers.map((item) => item.path),
      message: `${dangers.length} \u9879\u6539\u52A8\u547D\u4E2D\u51ED\u636E/\u672C\u5DE5\u5177\u81EA\u8EAB\u7B49\u654F\u611F\u8DEF\u5F84\uFF0C\u5185\u5BB9\u5DF2\u7701\u7565`,
      hint: "\u8FD9\u662F\u4E00\u6B21\u4FE1\u606F\u6CC4\u9732\u98CE\u9669\u63D0\u793A\uFF0C\u4E0D\u963B\u65AD\u4EFB\u4F55\u64CD\u4F5C\uFF1B\u6279\u51C6/\u62D2\u7EDD\u4F9D\u65E7\u5F02\u6B65\u3002"
    }
  ];
}
var DEFAULT_LIMITS2 = {
  maxFiles: 40,
  maxLinesPerFile: 60,
  maxLineChars: 240,
  /** 统计用的渲染上限：只为计数，不发给 Client */
  countLines: 4e3
};
var childPrefix = (rel) => `${compareKey(rel)}${sep6.toLowerCase()}`;
var ReviewService = class {
  /**
   * @param {{workspaceRoot: string, sessionId?: string, limits?: object, log?: (msg: string) => void}} options
   */
  constructor(options = {}) {
    if (!options?.workspaceRoot) throw new Error("ReviewService: workspaceRoot is required");
    this.workspaceRoot = options.workspaceRoot;
    this.sessionId = options.sessionId || DEFAULT_REVIEW_SESSION_ID;
    this.storeDir = options.storeDir ? String(options.storeDir) : resolveReviewStoreDir({
      workspaceRoot: this.workspaceRoot,
      sessionId: this.sessionId,
      stageRoot: options.stageRoot,
      env: options.env
    });
    this.limits = { ...DEFAULT_LIMITS2, ...options.limits || {} };
    this.log = options.log || (() => {
    });
    this.logger = options.logger;
    this.audit = options.audit;
    this.effectiveStagingHint = options.effectiveStaging;
    this.clearFailures = [];
    this.driftFingerprint = void 0;
    this.driftSnapshot = void 0;
    this.reportedDrift = /* @__PURE__ */ new Set();
    this.env = options.env;
    this.workspace = new Workspace({
      workspaceRoot: this.workspaceRoot,
      sessionId: this.sessionId,
      // WP2：存储根**只有一条**解析路径（`resolveReviewStoreDir()`）；显式注入优先，
      // 否则 `Workspace` → `Store` 也会走同一个 `resolveStageRoot()`（`src/store.ts`）。
      ...options.storeDir ? { storeDir: options.storeDir } : {},
      ...options.env ? { env: options.env } : {}
    });
    this.workspace.init({ origin: "host-plugin" });
    this.markFresh();
  }
  /**
   * **warn / error 级**日志（§7.3 S11–S14："失败必须响"）。
   *
   * 这些分支以前只用 `this.log`（= `logger.info`）记一句就吞掉，实测表现是"零报错"。
   * 顺序：`logger.warn` → `logger.error` → `console.error`（进程 stderr）。
   *
   * ⚠ **痕迹边界（本轮复核）**：本方法是**人工侧通道**（宿主 logger / 宿主进程 stderr），
   * 不是模型可见通道 —— 它永远不参与命令的 stdout/stderr，也绝不能被拼进 `/winstage*`
   * 命令的 `text` 返回值（那两路都会被模型看到）。因此这里的 `[winstage]` 前缀保留：
   * 它是给运维/用户看的归因标记。**新增任何面向模型的文案时，不要走这里。**
   */
  logError(message) {
    const line = `[winstage] ${message}`;
    const logger = this.logger;
    try {
      if (logger && typeof logger.warn === "function") return logger.warn(line);
      if (logger && typeof logger.error === "function") return logger.error(line);
    } catch {
    }
    try {
      console.error(line);
    } catch {
    }
  }
  /** 清除路径失败的记账：由命令面读出来告诉用户"没清干净" */
  noteClearFailure(entry) {
    if (!Array.isArray(this.clearFailures)) this.clearFailures = [];
    this.clearFailures.push(entry);
  }
  /** 记录"我读的是哪一版清单"（mtime 作为便宜的变更戳） */
  markFresh() {
    try {
      this.loadedStamp = statSync5(this.workspace.store.manifestPath).mtimeMs;
    } catch {
      this.loadedStamp = void 0;
    }
    return this.workspace;
  }
  /**
   * 读路径用的**便宜**新鲜度检查：清单文件 mtime 未变就不重新读盘。
   *
   * 为什么不每次都 `reload()`：`init()` 会重建清单对象并逐个校验投影，
   * 而 `stat`/`readText` 是被文件工具高频调用的。CLI（另一进程）改动过暂存树时
   * mtime 一定变化，因此这个判据足以避免"读到陈旧副本"。
   */
  fresh() {
    let stamp;
    try {
      stamp = statSync5(this.workspace.store.manifestPath).mtimeMs;
    } catch {
      stamp = void 0;
    }
    if (stamp !== this.loadedStamp) {
      this.workspace.init();
      this.markFresh();
    }
    return this.workspace;
  }
  /** 每次操作前重读持久状态（CLI 与插件共用一份暂存树） */
  reload() {
    this.workspace.init();
    return this.workspace;
  }
  /**
   * ★ **自动对准基线** —— 只处理**无损**漂移（缺陷② F5b 收窄后的语义）。
   *
   * 暂存条目是"相对某个基线的 diff"。基线一旦被**外部**改动，`applyOneChange()` 会以
   * `STALE_BASELINE` 拒绝落盘（这层保护是对的：绝不静默覆盖）。
   *
   * 本方法把 `/winstage rebase` 的落地动作（`_rebase()` → `rebaseEntry()` 重述
   * `baseHash/baseKind`，**不动** `stagedHash/state`）在一处集中执行，但**只对**
   * 真实内容与暂存内容相同（⇒ 对准后无净变化、磁盘一个字节都不会被改）的漂移生效：
   *   - 真实内容 == 暂存内容 ⇒ 无损：对准后条目自动退出视图；
   *   - 真实内容 ≠ 暂存内容（含"基线 absent 而真实文件已出现"）⇒ **blocked**，
   *     绝不自动对准 —— 否则这条会变成"可批准"，下一次批准静默覆盖外部写入
   *     （F5b 实测的数据丢失路径）。它保持 `baselineStale`，由显式 `/winstage rebase`
   *     或 `/winstage reject` 处置。
   *
   * 调用点（收窄后）：`/winstage rebase`（`rebase()`）、`approve --rebase` 的显式意图、
   * 以及自测/人工诊断。**不在** `reload()` / `publish()` / `afterMutation()` / `approve()`
   * 里 —— 那些路径一旦自动对准，快照就永远看不到漂移（F5b 的 90 s 静默就是这么来的）。
   *
   * 幂等 + 节流：没有漂移时不重冻结、不写快照；1 秒内重复调用直接返回上次结论。
   * 逃生口：`WINSTAGE_AUTO_REBASE=0` 关掉（回到显式 `/winstage rebase`）。
   *
   * @param {{force?: boolean}} [options] `force` 绕过节流（自测/人工诊断用）
   * @returns {{rebased: string[], discarded: string[], blocked: Array<{path:string,reason:string,expected:string,found:string}>, skipped: boolean, throttled?: boolean}}
   */
  autoRebaseDrifted(options = {}) {
    if (process.env.WINSTAGE_AUTO_REBASE === "0") {
      return { rebased: [], discarded: [], blocked: [], skipped: true };
    }
    const now = Date.now();
    if (options.force !== true && this.autoRebaseLastAt !== void 0 && now - this.autoRebaseLastAt < AUTO_REBASE_INTERVAL_MS) {
      return { rebased: [], discarded: [], blocked: [], skipped: false, throttled: true };
    }
    if (this.autoRebasing === true) {
      return { rebased: [], discarded: [], blocked: [], skipped: false, throttled: true };
    }
    this.autoRebasing = true;
    try {
      const ws = this.workspace;
      const drifted = [];
      const blocked = [];
      for (const change of ws.diffEntries()) {
        const drift = ws.baselineDrift(change.path);
        if (!drift.stale) continue;
        const staged = ws.entryOf(change.path)?.stagedHash ?? hashAbsent();
        if (drift.found !== hashAbsent() && drift.found !== staged) {
          blocked.push({ path: change.path, reason: drift.reason, expected: drift.expected, found: drift.found });
          continue;
        }
        drifted.push(change.path);
      }
      this.autoRebaseLastAt = now;
      if (drifted.length === 0) return { rebased: [], discarded: [], blocked, skipped: false };
      const result = this._rebase(drifted);
      return { rebased: result.rebased, discarded: result.discarded, blocked, skipped: false };
    } finally {
      this.autoRebasing = false;
    }
  }
  /** 快照文件绝对路径（与暂存清单**同一个存储根**；会话隔离时即该会话的目录） */
  reviewPath() {
    return join12(this.workspace.store.dir, REVIEW_BASENAME);
  }
  /**
   * **自愈**：把**别处**已经落下的条目并进本会话的存储（WP2：候选来源经
   * `resolveStageRoot()` 解析，绝不硬拼旧布局）。
   *
   * 为什么需要：只要有一次调用拿不到会话身份（旧进程、agentless、initiator 不可读），
   * 内容就会落到**共享根**，而面板只读自己的会话目录 ⇒ 条目"随 Turn 消失"。这里在**每次
   * 会话级写/命令**上做一次便宜检查（manifest 不存在就零成本返回）：
   *   - 目标还没有 manifest ⇒ 整份搬（rename 优先，失败退回复制）；
   *   - 目标已有 manifest ⇒ 按**条目键**合并（目标优先），blobs/staged 只补缺失的；
   *   - 并完清掉来源的 manifest/queue（`candidates` 丢弃：净 diff 会重新冻结）。
   *
   * 两个来源（顺序即优先级）：
   *   1. **共享根** = `resolveReviewStoreDir({ sessionId: undefined })` —— Phase 1 之后
   *      "没有会话身份"的那次写落在缓存里的哪，这里就扫哪；
   *   2. **旧布局**（`legacyWorkspaceStoreDir()`）—— 升级前积在工作区里的内容。
   *      只读/只搬走，永不回写（写入路径一个字节都不会再落到那里）。
   * @returns {number} 并入的条目数（0 = 没有可并的）
   */
  absorbSharedStore() {
    const seen = /* @__PURE__ */ new Set();
    let total = 0;
    for (const dir of [this.sharedStoreDir(), legacyWorkspaceStoreDir(this.workspaceRoot)]) {
      let dedup;
      try {
        dedup = canonical(dir).toLowerCase();
      } catch {
        dedup = String(dir).toLowerCase();
      }
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      total += this.absorbFromStore(dir);
    }
    return total;
  }
  /** 本进程"共享（无会话身份）"服务的存储根 —— 与 `getReviewService()` 同一解析入口 */
  sharedStoreDir() {
    return resolveReviewStoreDir({ workspaceRoot: this.workspaceRoot, sessionId: void 0, env: this.env });
  }
  /** 从**某一个**来源存储把条目并进本会话（`absorbSharedStore()` 的实体；逐来源独立记账） */
  absorbFromStore(sharedDir) {
    const targetDir = this.workspace.store.dir;
    try {
      if (canonical(targetDir) === canonical(sharedDir)) return 0;
      const sharedManifestPath = join12(sharedDir, "manifest.json");
      if (!existsSync8(sharedManifestPath)) return 0;
      let shared;
      try {
        shared = JSON.parse(readFileSync8(sharedManifestPath, "utf8"));
      } catch {
        return 0;
      }
      const sharedEntries = shared && typeof shared.entries === "object" && shared.entries ? shared.entries : {};
      if (Object.keys(sharedEntries).length === 0) return 0;
      mkdirSync7(targetDir, { recursive: true });
      const targetManifestPath = join12(targetDir, "manifest.json");
      let target = null;
      try {
        target = JSON.parse(readFileSync8(targetManifestPath, "utf8"));
      } catch {
        target = null;
      }
      let moved = 0;
      if (!target || typeof target !== "object") {
        for (const name of ["manifest.json", "queue.json", "blobs", "staged", "staged-ext", "candidates", "real", "private", "cache"]) {
          const from = join12(sharedDir, name);
          if (!existsSync8(from)) continue;
          try {
            renameSync5(from, join12(targetDir, name));
          } catch {
            copyTreeMissing(from, join12(targetDir, name));
          }
          moved += 1;
        }
      } else {
        target.entries = target.entries && typeof target.entries === "object" ? target.entries : {};
        for (const [rel, entry] of Object.entries(sharedEntries)) {
          if (target.entries[rel]) continue;
          target.entries[rel] = entry;
          moved += 1;
        }
        writeFileSync8(targetManifestPath, JSON.stringify(target, null, 2));
        copyTreeMissing(join12(sharedDir, "blobs"), join12(targetDir, "blobs"));
        copyTreeMissing(join12(sharedDir, "staged"), join12(targetDir, "staged"));
        copyTreeMissing(join12(sharedDir, "staged-ext"), join12(targetDir, "staged-ext"));
      }
      if (moved > 0) {
        rmSync7(sharedManifestPath, { force: true });
        rmSync7(join12(sharedDir, "queue.json"), { force: true });
        rmSync7(join12(sharedDir, "candidates"), { recursive: true, force: true });
        this.workspace.init();
        this.markFresh();
        this.publish();
        this.log(`\u5DF2\u628A\u6765\u6E90\u5B58\u50A8\u91CC\u7684 ${moved} \u6761\u5F85\u5BA1\u5E76\u5165\u4F1A\u8BDD\u5B58\u50A8\uFF1A${targetDir}`);
      }
      return moved;
    } catch (error) {
      this.logError(`\u5E76\u5165\u6765\u6E90\u5B58\u50A8\u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF09\uFF1A${error?.message ?? error}`);
      return 0;
    }
  }
  /** 变更过暂存树之后：冻结候选并发布快照（供 Client 轮询） */
  afterMutation(reason = "mutation") {
    let frozenInfo;
    try {
      frozenInfo = this.ensureCandidate(reason);
    } catch (error) {
      this.logError(`\u51BB\u7ED3\u5019\u9009\u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF0C\u6682\u5B58\u5185\u5BB9\u4ECD\u5728\uFF09\uFF1A${error.message}`);
    }
    if (frozenInfo?.frozen === true) {
      try {
        this.audit?.ask?.({
          candidateId: frozenInfo.candidate?.id,
          fileCount: Array.isArray(frozenInfo.candidate?.changes) ? frozenInfo.candidate.changes.length : void 0,
          reason: `${reason}: \u53D8\u66F4\u5DF2\u6682\u5B58\uFF0C\u7B49\u5F85\u5BA1\u6279`
        });
      } catch (error) {
        this.logError(`\u5BA1\u8BA1\u955C\u50CF ask \u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF0C\u4E0D\u5F71\u54CD\u6682\u5B58\uFF09\uFF1A${error?.message ?? error}`);
      }
    }
    const snapshot = this.publish();
    this.markFresh();
    return snapshot;
  }
  /**
   * 把当前净变化冻结成候选（幂等：已由最新待审候选覆盖时不再产生新候选）。
   *
   * 为什么要判重：`freezeCandidate()` 每次调用都会新建候选并**取代**同路径旧待审。
   * 快照与命令是高频调用，若无条件冻结，队列会被无意义地刷屏。
   */
  ensureCandidate(source = "panel") {
    const ws = this.reload();
    const changes = ws.diffEntries();
    if (changes.length === 0) return { frozen: false, reason: "no-net-change" };
    const pending = ws.listReviews();
    const latest = pending[pending.length - 1];
    if (latest && this.represents(latest.changes, changes)) return { frozen: false, candidate: latest };
    const frozen = ws.freezeCandidate({ source });
    return { frozen: frozen.enqueued === true, candidate: frozen.candidate };
  }
  /** 最新待审候选是否**恰好**覆盖这批净变化（按路径 + 操作 + 两侧哈希） */
  represents(candidateChanges, changes) {
    if (candidateChanges.length !== changes.length) return false;
    const index = new Map(candidateChanges.map((c) => [compareKey(c.path), c]));
    for (const change of changes) {
      const other = index.get(compareKey(change.path));
      if (!other) return false;
      if (other.op !== change.op) return false;
      if ((other.before?.hash ?? hashAbsent()) !== (change.before?.hash ?? hashAbsent())) return false;
      if ((other.after?.hash ?? hashAbsent()) !== (change.after?.hash ?? hashAbsent())) return false;
    }
    return true;
  }
  /**
   * 冻结候选里"已不在当前净 diff、而且磁盘上也不是它要写的内容"的路径
   * → **只读存档行**（实测缺陷 D1 的修法）。
   *
   * ── 为什么需要它（实测）──────────────────────────────────────────────────────
   * `files[]` 过去**只**由 `ws.diffEntries()`（当前净 diff）驱动。于是一个**仍有活的**
   * 候选，只要它的路径后来被从净 diff 里抹掉，它在面板上就**不可见、不可勾、不可批**，
   * 而 `queue.json` 里它仍挂着 `pending`（"空壳 pending"）。实测证据
   * `.t/sbx3/browser/out/s3b2-visibility.txt`：`cs_0005` 的两条路径
   * （`.ssh\id_rsa`、`r3-a.txt`）`panelRenders=no`，而候选状态是 `pending`。
   *
   * ── 收录判据（逐条可核对）────────────────────────────────────────────────────
   * 一条冻结路径进面板，当且仅当**三条同时成立**：
   *   1. 它不在当前净 diff 里（在的话由 `renderChange` 渲染成可批准行）；
   *   2. 它**不是"已经落盘"**。"已经落盘"的路径不需要任何决定，把它再列成"待审"
   *      只会虚报数量、并让"未选路径仍在待审"这类判据失真 —— 实测踩到过：
   *      部分批准之后 `counts.files` 从 1 变成 2（多出一条已落盘的存档行）。
   *      判据用**磁盘真值**（`realHashOf()`）而不是记账字段，因此"另一个候选/手工
   *      把同样内容写好了"也算已落盘；
   *   3. 它仍被某份有活的候选冻结着（`ws.listReviews()`）。
   *
   * ── ⚠ "已经落盘"对**删除类**必须换判据（实测踩到过，必须在报告里留痕）──────────
   * 删除类条目的 `after.hash` 就是 `'absent'` 哨兵，而"文件不存在"的磁盘真值也是
   * `'absent'` ⇒ 拿两者比较会把**删除一个基线本就不存在的对象**判成"已完成"。
   * 这类墓碑正是 `diffEntries()` 刻意跳过的那种（`src/workspace.ts:786`："删除一个
   * 从未存在的东西不算变化"），于是候选会在面板上**永远消失** —— 这就是实测缺陷 D1
   * 在 3085 现役 fixture 上的真实形态（`cs_0005` 的 `.ssh\id_rsa` / `r3-a.txt` 都是
   * 这种墓碑，manifest 里 `state:"deleted"` + `baseHash:"absent"`）。
   * 因此两分：
   *   - `appliedPaths` 命中（这份候选自己已经应用过它，删除类也适用）⇒ 已落盘；
   *   - **非删除类**才用磁盘比对（磁盘上已经是它要写的内容）⇒ 已落盘。
   *
   * ── 取舍：为什么这些行**不给勾选框**（`frozenOnly: true`）──────────────────────
   *   1. 写入面本来就按**当前净 diff** 过滤路径（`ReviewService.approve()` 在净 diff
   *      为空时早退 + `host-plugin.ts` 用 `matchPaths(ws.diffEntries(), …)`），
   *      勾一条不在净 diff 里的路径只会得到"没有匹配的待审路径" —— 那是**假操作**，
   *      而"给了勾选框却必然失败"比"标记成不可批准"更糟；
   *   2. 冻结 blob 可能已被回收（`revert()` 会 `rmSync` 暂存对象），要渲染内容就得
   *      额外引入 blob 读取与异常分支；
   *   3. 硬约束是"**绝不让用户在看不到内容的情况下批准**"：这些行的内容既不可保证
   *      也不可写入 ⇒ 只给元数据（路径 / 操作 / 三档）与"已不在净 diff"的标记。
   * 危险档的内容省略策略在这里**同样适用**（`diff: []` + `note`），一行都不例外。
   *
   * ── 代价 ─────────────────────────────────────────────────────────────────────
   * 对"不在净 diff 里"的**非删除类**候选路径各算一次真实文件哈希。只在**发布快照**
   * 时发生（变更/命令），不在 Client 的 1.5 s 轮询路径上；条数被候选数界住。
   *
   * 本方法是**纯读**：不改任何状态。自动 discard 只发生在 `reject()` 这条**变更**路径上
   * （见 `reconcileCandidates()`），因此轮询永远不会写盘。
   */
  frozenOnlyRows(ws, netKeys) {
    const merged = /* @__PURE__ */ new Map();
    for (const candidate of ws.listReviews()) {
      if (isRegistryCandidate(candidate)) continue;
      const appliedKeys = new Set((candidate.appliedPaths || []).map((entry) => compareKey(entry)));
      for (const change of candidate.changes || []) {
        const key = compareKey(change.path);
        if (netKeys.has(key)) continue;
        const want = change.after?.hash ?? hashAbsent();
        const isDelete = change.op === "delete" || want === hashAbsent();
        if (appliedKeys.has(key)) continue;
        if (!isDelete && this.realHashOf(ws, change) === want) continue;
        const verdict = classifyChange(change, { workspaceRoot: this.workspaceRoot, masks: ws.extraMasks });
        const entry = ws.entryOf(change.path);
        const frozenReason = !entry ? "reclaimed" : entry.state === STATE.DELETED ? "no-op" : "no-net-change";
        const row = {
          path: change.path,
          op: change.op,
          kind: change.kind === "dir" ? "dir" : "file",
          totals: { added: 0, removed: 0 },
          diff: [],
          truncated: false,
          external: verdict.external,
          risk: verdict.risk,
          safety: verdict.safety,
          riskReason: verdict.riskReason,
          /** D1：本行来自"冻结候选"、已不在当前净 diff ⇒ 面板不得给勾选框 */
          frozenOnly: true,
          frozenReason,
          /** 冻结它的候选（同一路径可被多份候选共享，见 D6） */
          candidateIds: [candidate.id]
        };
        if (verdict.safety === "danger") row.note = SENSITIVE_OMIT_NOTE;
        const prev = merged.get(key);
        if (!prev) {
          merged.set(key, row);
          continue;
        }
        prev.candidateIds = [.../* @__PURE__ */ new Set([...prev.candidateIds, ...row.candidateIds])];
      }
    }
    return [...merged.values()].sort((a, b) => {
      const left = compareKey(a.path);
      const right = compareKey(b.path);
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    });
  }
  /**
   * 注册表候选 → Client 可直接渲染的**可批准**行。
   *
   * 与文件行同构（同样的 `path/op/kind/totals/diff/external/risk/safety/riskReason`），
   * 只多两个字段：`kind:'registry'` 与 `registryPath`/`valueName`。
   * ⚠ 这些行**没有 diff 内容**：注册表变更的内容不在文件系统里，面板至少能显示
   * "哪个键/哪个值、什么操作、三档风险"，这与"看不到内容就不给批准"的既有硬约束
   * 并不冲突 —— 覆盖层的语义是"批准=把这条键值变更照原样应用到真实 hive"，
   * 而用户看到的就是那条变更本身。
   */
  registryRows(ws, pending) {
    const rows = [];
    for (const candidate of pending) {
      if (!isRegistryCandidate(candidate)) continue;
      for (const change of candidate.changes || []) {
        let verdict;
        try {
          verdict = classifyChange(
            { ...change, external: true },
            { workspaceRoot: this.workspaceRoot, masks: ws?.extraMasks }
          );
        } catch {
          verdict = { external: true, risk: "outside", safety: "normal", riskReason: "registry change" };
        }
        const row = {
          path: change.path,
          op: change.op,
          kind: "registry",
          registry: true,
          totals: { added: 0, removed: 0 },
          diff: [],
          truncated: false,
          external: true,
          risk: verdict.risk,
          safety: verdict.safety,
          riskReason: verdict.riskReason,
          candidateIds: [candidate.id],
          registryPath: change.registryPath ?? change.key,
          note: "\u6CE8\u518C\u8868\u53D8\u66F4\uFF1A\u6B64\u523B\u53EA\u5B58\u5728\u4E8E\u8986\u76D6\u5C42\u91CC\uFF08**\u771F\u5B9E\u6CE8\u518C\u8868\u4E00\u4E2A\u5B57\u8282\u672A\u53D8**\uFF09\uFF1B\u52FE\u9009\u5E76\u6279\u51C6\u540E\u624D\u7531\u5BBF\u4E3B\u4EE4\u724C\u5199\u5165\u771F\u5B9E hive\uFF0C\u62D2\u7EDD\u5219\u4E22\u5F03\u3002"
        };
        if (change.valueName !== void 0) row.valueName = change.valueName;
        if (change.appliable === false) {
          row.appliable = false;
          row.note = `\u8BE5\u6CE8\u518C\u8868\u53D8\u66F4**\u4E0D\u53EF\u5E94\u7528**\uFF1A${change.unsupportedReason ?? "\u8986\u76D6\u5C42\u65E0\u6CD5\u8868\u793A"}`;
        }
        rows.push(row);
      }
    }
    return rows;
  }
  /** 真实文件当前内容哈希（不存在 / 读不了 / 非普通文件 ⇒ `hashAbsent()`，与 applyOneChange 同口径） */
  realHashOf(ws, change) {
    try {
      const abs = ws.absolute(change.path);
      if (!statSync5(abs).isFile()) return hashAbsent();
      return hashFile(abs);
    } catch {
      return hashAbsent();
    }
  }
  /**
   * ── WP8.2：宿主原件**指纹冲突**（`snapshot` 与 `approve` 共用同一判据）──────────────
   *
   * 委派给 `src/workspace.ts` 的方法（判据只有一份：`baselineConflictOf()` 纯函数 +
   * `hostFileFingerprint()`）。**刻意不在这里重写一遍比较逻辑** —— 审批面与落盘面
   * 一旦各持一套判据，"面板说没冲突、批准却拒绝"就会成为常态，而这类不一致正是
   * F5b 那次静默覆盖的同源缺陷。
   *
   * 纯读（只 `statSync` + `hashFile`），不写任何状态；`workspace` 侧注入缝也随之失效时
   * 一律回 `null`（不判冲突），保证老清单/外部键的行为逐字不变。
   *
   * @returns {{code:string,expected:object,found:object|null,changed:string[]}|null}
   */
  baselineConflictOf(ws, change) {
    try {
      if (typeof ws?.baselineConflictOf !== "function") return null;
      return ws.baselineConflictOf(change);
    } catch {
      return null;
    }
  }
  /**
   * Method A 主线读侧：把宿主 `sandbox-audit.json`（AI 进程树的文件/注册表读写分类统计）
   * 作为快照的 `audit` 段带给面板。**纯读、有界**：只带 summary + 每类 ≤50 行样本，
   * 完整报告在文件里。文件由 `shell-executor.captureAudit()` 写在**同一会话存储根**；
   * 不存在则返回 null（无审计/未开启）。
   */
  auditSummary() {
    try {
      const file = join12(dirname8(this.reviewPath()), "sandbox-audit.json");
      if (!existsSync8(file)) return null;
      const raw = JSON.parse(readFileSync8(file, "utf8"));
      const slice = (arr) => Array.isArray(arr) ? arr.slice(0, 50) : [];
      return {
        generatedAt: raw.generatedAt ?? null,
        summary: raw.summary ?? null,
        files: {
          read: slice(raw.files?.read),
          written: slice(raw.files?.written),
          deleted: slice(raw.files?.deleted)
        },
        registry: { read: slice(raw.registry?.read), written: slice(raw.registry?.written) },
        note: "bounded: summary + up to 50 rows per list; full report in sandbox-audit.json"
      };
    } catch {
      return null;
    }
  }
  /**
   * 当前待审快照（对象形式；Client 读的是它的 JSON 序列化）。
   *
   * ── D1：`files[]` = 净 diff 行（可批准） ∪ 冻结存档行（`frozenOnly`，只显示）──
   * 只渲染净 diff 会让"仍有活的候选"整体消失，于是 `queue.json` 里的 `pending`
   * 变成用户看不见也清不掉空壳。净 diff 行**排在前面**，因此"第一个普通项"仍然是
   * 可批准的那一个（套件与用户的手感都不变）。
   *
   * **D1 不变式**（`fixd_selftest.ts` 逐候选核对）：对每一份仍有活的候选，
   * 它的每一条冻结路径，要么**已经落盘**（磁盘内容就是它要写的内容 ⇒ 无需决定），
   * 要么在 `files[]` 里有一行。因此"有活候选 = 面板上一定看得见"。
   */
  snapshot(options = {}) {
    const ws = this.reload();
    const changes = ws.diffEntries();
    const pending = ws.listReviews();
    const latest = pending[pending.length - 1];
    const limits = { ...this.limits, ...options.limits || {} };
    const netKeys = new Set(changes.map((change) => compareKey(change.path)));
    const netFiles = changes.map((change) => this.renderChange(ws, change, limits));
    const registryFiles = this.registryRows(ws, pending);
    const frozenFiles = this.frozenOnlyRows(ws, netKeys);
    const listed = [...netFiles, ...registryFiles, ...frozenFiles];
    const masked = netFiles.filter(
      (entry) => entry && (entry.contentMasked === true || entry.note === SENSITIVE_OMIT_NOTE)
    );
    const pageSize = Math.max(0, Number(limits.maxFiles) || 0);
    const files = listed.slice(0, pageSize);
    const rowTruncated = listed.length > files.length;
    const totals = listed.reduce((acc, f) => ({
      added: acc.added + f.totals.added,
      removed: acc.removed + f.totals.removed
    }), { added: 0, removed: 0 });
    return {
      version: 1,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      workspaceRoot: this.workspaceRoot,
      sessionId: ws.manifest?.sessionId,
      candidateId: latest?.id,
      revision: ws.manifest?.revision,
      // 待审 = 面板上有**任何**一行（全量口径：被截断掉的行也是待审）
      pending: listed.length > 0,
      /** 行级截断的机读位（旧语义保留：只回 true 当"有行没列出来"） */
      truncated: rowTruncated,
      counts: {
        /** 待审**总数**（截断前） */
        files: listed.length,
        /** 面板实际列出的行数（≤ `pageSize`）；`files - listed` 即被截断条数 */
        listed: files.length,
        /** 显式全量键（与 `files` 同值），名字不含歧义 */
        totalFiles: listed.length,
        /** 本页上限（= `limits.maxFiles`）—— 断言②要拿它做 `min()` */
        pageSize,
        /** `totalFiles > listed` 的机读布尔位（旧版恒 false，见文件头缺陷记录） */
        truncated: rowTruncated,
        additions: totals.added,
        deletions: totals.removed,
        /** 净 diff 的条数 = 真正可批准的那部分（**与轮次无关**，WP5′ 的核心指标） */
        net: changes.length,
        /** 其中"冻结存档行"的条数（只显示、不可批准）——按**全量**统计 */
        frozenOnly: listed.filter((f) => f.frozenOnly === true).length,
        /** 注册表候选行数（机读；本轮实测曾出现"注册表行 0 条"，故单列一项供断言） */
        registry: listed.filter((f) => f.registry === true).length,
        staleBaseline: listed.filter((f) => f.baselineStale === true).length,
        staleBaselineLossy: listed.filter((f) => f.baselineStale === true && f.baselineStaleCode !== "baseline-deleted").length,
        /**
         * WP8.2：**基线冲突**（宿主原件在暂存之后被改过 ⇒ 判冲突、不覆盖）的条数。
         * 与 `staleBaseline` 的区别：后者是"批准会被 `STALE_BASELINE` 拒绝"，
         * 本键是"新指纹判据（size+mtime+sha256）命中了冲突"。两者同源不同粒度，
         * 都保留，因为面板对二者的措辞与出路不同（前者：rebase/reject；后者：覆盖/放弃）。
         */
        baselineConflict: listed.filter((f) => f.baselineConflict === true).length
      },
      /**
       * 截断的**机读原因**（`null` = 没截断）。合并语义用 `+` 连接：
       *   · `row-limit`     —— 行数超过 `pageSize`，有整行没列出来；
       *   · `content-limit` —— 某条的 `diff` 片段被 `maxLinesPerFile` 截了（行数没超也可能有）。
       * 与两个计数位**同源**（同一个 `truncatedReasonOf()`），不在这里再推一遍。
       */
      truncatedReason: truncatedReasonOf(listed, files.length),
      /** 分页细节（面板据此画"显示前 N / 共 M"）；与 `counts` 同源，不另算一遍 */
      page: { pageSize, listed: files.length, total: listed.length, omitted: Math.max(0, listed.length - files.length) },
      riskCounts: countRisks(listed),
      alerts: buildAlerts(netFiles, latest?.id),
      candidates: pending.map((candidate) => ({
        id: candidate.id,
        status: candidate.status,
        paths: (candidate.changes || []).map((change) => change.path),
        appliedPaths: [...candidate.appliedPaths || []]
      })),
      readVisibility: readVisibilitySnapshot(this.sessionId),
      /**
       * R12 修复 · D7-a：**本次会话里"没有走暂存"的动作**（机读，绝不静默）。
       *
       * 来源是 `staging-fs` 落在**同一存储根**的 `unstaged.json`（`dsh-plugin/unstaged-ledger.ts`）。
       * R11 D7-a 的实测结论是"`write` 工具在平台一次提权后绕过暂存直落真实盘，
       * 而界面与审计零提示" ⇒ 现在这件事必然出现在快照里：
       * 面板据此显示常驻提示，复核者据此判定"这一条的写入不进待审、也无法被拒绝"。
       *
       * 语义边界：`any=false` 只说明**账本里没有记录**，不等于"平台面一定没有别的写入通道"
       * （`pwsh` 工具的落点由 shell 半边负责，不在本账本范围内）。
       */
      unstaged: unstagedSnapshot(this.storeDir),
      /**
       * R12 修复 · D7-b/c/d：**配置值与生效值分列**（界面必须能同时看到两者）。
       *
       *   · `configValue`      —— 本插件 loader 行 `config.enabled` 的**配置值**
       *     （`staging-fs.stagingEnabled()` 的判据；`null` = 读不到行 ⇒ 视为接管）；
       *   · `effective`        —— 本进程里这个暂存根**是否真的在接管**（生效值）；
       *   · `shellOverride`    —— 进程级 `WINSTAGE_SHELL` 是否**强制**了某一侧。
       *
       * R11 D7-d 的形态是"行内状态词 `已关闭`，而实测 TS 在跑"：客户端当时只读了
       * `config.enabled`。现在两者都在同一份快照里 ⇒ 面板可以显式说
       * "配置值：已关闭 / 生效值：接管中（原因：WINSTAGE_SHELL=1 强制）"，
       * 而"被 profile 覆盖层固定 / 被进程环境变量强制"这两种失败原因也各有字段。
       */
      staging: effectiveStagingSnapshot(this.workspaceRoot, this.effectiveStagingHint),
      /**
       * R12 修复 · D2：**本版快照里哪些字段被掩码**（机读，绝不静默）。
       *
       * 与 `files[].contentMasked` 同源（同一批 `renderChange()` 结果），
       * 但额外给出"整版汇总"：面板/审计可以一眼回答
       * "这份 review.json 里有没有被掩码的内容、掩了几段、为什么掩"，
       * 不需要逐条扫 `files[]`。
       *
       * 语义边界（**不要读成"哈希也被掩码了"**）：
       * 本段只描述**展示文本**。`before/after` 哈希与字节数永远按真实字节算，
       * 因此掩码不影响"基线是否漂移 / 能不能批准"的任何判定。
       */
      redactions: {
        /** 有**任何**条目被掩码时为 true（含 danger 档的整份省略） */
        masked: masked.length > 0,
        /** 被掩码的条目数 */
        fields: masked.length,
        /** 被掩码的**段**总数（一行里可能有多个值） */
        segments: masked.reduce((sum, entry) => sum + (entry.maskedSegments || 0), 0),
        /** 逐条明细（path + 理由 + 段数）——面板据此在行内标"内容已掩码" */
        items: masked.map((entry) => ({
          path: entry.path,
          reason: entry.note === SENSITIVE_OMIT_NOTE ? "omitted" : "masked",
          segments: entry.maskedSegments || 0,
          maskReasons: entry.maskReasons || []
        })),
        /** 掩码策略的两条口径（字面量，供断言逐字核对） */
        policies: { omitted: SENSITIVE_OMIT_NOTE, masked: SENSITIVE_MASK_NOTE },
        /** 占位形态（Client 可拿它做二次校验：出现这个前缀就说明这一段没有原文） */
        token: redactedToken(0).replace(" len=0", " len=\u2026")
      },
      /** Method A 主线：AI 进程树读了/改了什么的分类统计（见 `auditSummary()`） */
      audit: this.auditSummary(),
      files
    };
  }
  /**
   * 单条变更 → Client 可直接渲染的项。
   *
   * `totals` 是**真实**增删行数（统计渲染），`diff` 是**有界**的展示片段；
   * 两者刻意分开，避免"截断后的展示"被当成"这就是全部改动"（缺陷 11 的同类错误）。
   *
   * ── 安全设计决定（Lead 已批准）──────────────────────────────────────────────
   * `diff` 承载的是**文件内容片段**。对 `safety:"danger"` 的条目
   * （凭据/密钥/本工具自身存储等），默认**不把内容片段写进 review.json** ——
   * 否则等于把凭据渲染进浏览器（快照是普通文件，Client 用
   * `ctx.remote.workspaceFiles.read` 直接读它）。
   *
   * 做法：`diff: []` + `truncated: false` + 顶层 `note` 说明"内容已按敏感策略省略"。
   * `totals`（纯计数）、`path`、`op`、`kind`、`risk`、`safety`、`riskReason` **照常给出**，
   * 面板因此仍能显示"哪个文件、什么操作、为什么敏感、改了多少行"，只是看不到内容。
   *
   * `risk`/`safety`/`riskReason` 这三个字段**在拿到行数之前**就定好了，
   * 所以 danger 条目根本不会为渲染内容而产生任何成本，也不存在
   * "先渲染再丢弃"的中间态。
   */
  renderChange(ws, change, limits) {
    const verdict = classifyChange(change, {
      workspaceRoot: this.workspaceRoot,
      masks: ws.extraMasks
    });
    const sensitiveOmitted = verdict.safety === "danger";
    const sensitiveMasked = !sensitiveOmitted && verdict.risk === "sensitive";
    const item = {
      // ── 老字段（向后兼容：一个都不能少、不能改名）──────────────────────
      path: change.path,
      op: change.op,
      kind: change.kind === "dir" ? "dir" : "file",
      totals: { added: 0, removed: 0 },
      diff: [],
      truncated: false,
      // ── 新增字段（Lead 锁定的 review.json 契约）───────────────────────
      external: verdict.external,
      risk: verdict.risk,
      safety: verdict.safety,
      riskReason: verdict.riskReason
    };
    if (item.kind !== "dir") {
      const expected = change.before?.hash ?? hashAbsent();
      const found = this.realHashOf(ws, change);
      if (found !== expected) {
        item.baselineStale = true;
        item.baseline = { expected, found };
        item.baselineStaleCode = driftReasonOf(expected, found);
      }
      const conflict = this.baselineConflictOf(ws, change);
      if (conflict) {
        item.baselineConflict = true;
        item.baselineConflictCode = conflict.code;
        item.baselineConflictChanged = conflict.changed;
        item.hostBaseline = { expected: conflict.expected, found: conflict.found };
      }
    }
    if (sensitiveOmitted) item.note = SENSITIVE_OMIT_NOTE;
    if (item.kind === "dir") return item;
    const candidateLike = { changes: [change] };
    const all = renderCandidateDiff(ws.store, candidateLike, { maxLines: limits.countLines });
    for (const line of all) {
      if (line.type === "add") item.totals.added += 1;
      else if (line.type === "remove") item.totals.removed += 1;
    }
    if (sensitiveOmitted) return item;
    let redaction = { lines: [], masked: false, segments: 0, reasons: [] };
    if (sensitiveMasked) {
      const view = [];
      for (const line of all) {
        if (line.type === "change-header" || line.type === "note") continue;
        if (view.length >= limits.maxLinesPerFile) break;
        const text = String(line.text ?? "");
        const masked = maskSensitiveLines([{ type: line.type, line: line.line, text }]);
        const shown = masked.masked ? masked.lines[0]?.text ?? text : text;
        view.push({
          type: line.type,
          line: line.line,
          text: shown.length > limits.maxLineChars ? `${shown.slice(0, limits.maxLineChars)}\u2026` : shown
        });
        redaction.masked = redaction.masked || masked.masked;
        redaction.segments += masked.segments;
        for (const reason of masked.reasons) if (!redaction.reasons.includes(reason)) redaction.reasons.push(reason);
      }
      redaction.lines = view;
    }
    for (const line of all) {
      if (line.type === "change-header" || line.type === "note") continue;
      if (item.diff.length >= limits.maxLinesPerFile) {
        item.truncated = true;
        break;
      }
      const text = String(line.text ?? "");
      item.diff.push({
        type: line.type,
        line: line.line,
        text: text.length > limits.maxLineChars ? `${text.slice(0, limits.maxLineChars)}\u2026` : text
      });
    }
    if (sensitiveMasked && redaction.masked) {
      item.diff = redaction.lines;
      item.contentMasked = true;
      item.maskedSegments = redaction.segments;
      item.maskReasons = redaction.reasons;
      item.note = SENSITIVE_MASK_NOTE;
    }
    return item;
  }
  /**
   * 原子写出快照（先写临时文件再 rename，Client 绝不会读到半个 JSON）。
   *
   * ★ 复用 `src/store.ts` 的 `writeFileAtomic()`，**不再自写一份**：
   *   本函数原先用 `${target}.tmp-${process.pid}` 手写 tmp + `renameSync`，
   *   而那条路径**没有**失败清理 —— 实测在盘上留下过
   *   `review.json.tmp-6892`（1329 B）残骸：`rename` 抛 `EPERM` 后 tmp 无人回收
   *   （对比：`store.ts:107-121` 的 `writeFileAtomic()` 在 rename 失败时会
   *   `unlinkSync(tmp)` 再抛）。同一件事两种口径 ⇒ 审批侧的提交失败会**污染 store**。
   *   `publish()` 有 6 个调用点（本文件 :432/:451/:807/:866/:936 + `host-plugin.ts:239`），
   *   收口到一处即全部修好。
   *
   * 语义变化**只有**"失败时不留 tmp"：原错误照旧上抛（不吞、不降级），
   * 因此调用方与断言对错误路径的观察不变。
   */
  /**
   * 强制自动对准基线，**失败只记 error 日志**，绝不影响调用方。
   *
   * ⚠ 缺陷②（F5b）收窄后：这里**只**对准无损漂移（见 `autoRebaseDrifted()`）。
   * 有内容丢失风险的漂移会原样留在清单里（返回值里的 `blocked`），继续可见、继续拒绝批准。
   *
   * 调用点（收窄后）：显式 rebase 路径与自测/人工诊断。**不再**由
   * `reload()` / `publish()` / `afterMutation()` / `approve()` 调用。
   */
  autoAlignQuietly() {
    try {
      return this.autoRebaseDrifted({ force: true });
    } catch (error) {
      try {
        this.logError(`\u81EA\u52A8\u5BF9\u51C6\u57FA\u7EBF\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u672C\u6B21\u64CD\u4F5C\uFF09\uFF1A${error?.message ?? error}`);
      } catch {
      }
      return { rebased: [], discarded: [], blocked: [], skipped: false, failed: true };
    }
  }
  publish() {
    const snapshot = this.snapshot();
    writeFileAtomic(this.reviewPath(), JSON.stringify(snapshot));
    return snapshot;
  }
  /**
   * **只读**轮询复核（缺陷② F5b 的"正确触发点"）。
   *
   * ── 为什么需要它 ────────────────────────────────────────────────────────────
   * `review.json` 只在"变更 / 命令"时发布。shell（`pwsh` 工具）绕过 `ctx.fs`
   * 直接写真实磁盘 **不产生任何** 上述事件 ⇒ 快照的 `generatedAt` 会一直冻在
   * 上一次发布（F5b 实测：90 s 一次都没重发布），面板于是长期显示一条与现实
   * 不符的"新增"行，且 `staleBaseline = 0`。
   *
   * 本方法是**读路径**，三条纪律：
   *   1. **绝不改状态**：不 `init()` 之外的写、不 rebase、不 discard、不冻结候选。
   *      不这样的话，"轮询"本身就会变成那个把外部内容盖掉的动作；
   *   2. **代价受控**：先比一个便宜的指纹（发布时记下的"清单 mtime + 净 diff 的
   *      before/after hash"），指纹没变就直接返回 —— 调用方因此可以按秒级节拍
   *      轮询而不产生可见负载；
   *   3. **指纹变了才写盘**：只在真的需要把新事实告诉面板时才 `publish()`。
   *
   * 返回里 `changed` = 本次是否重发布；`stale` = 当前漂移清单（含形状），
   * 供宿主把它送上**人工侧**诊断通道（`review-service.ts` 的 `logError` 契约：
   * 绝不进模型可见的 stdout/stderr / 命令文本）。
   *
   * @returns {{changed: boolean, snapshot: object, stale: Array<{path:string,reason:string,expected:string,found:string}>}}
   */
  reviewDrift() {
    const ws = this.reload();
    const changes = ws.diffEntries();
    const stale = [];
    const parts = [];
    for (const change of changes) {
      const drift = ws.baselineDrift(change.path);
      if (!drift.stale) continue;
      stale.push({ path: change.path, reason: drift.reason, expected: drift.expected, found: drift.found });
      parts.push(`${change.path}:${drift.reason}:${drift.found}`);
    }
    let stamp;
    try {
      stamp = statSync5(ws.store.manifestPath).mtimeMs;
    } catch {
      stamp = "none";
    }
    for (const change of changes) parts.push(`${change.path}|${change.before?.hash ?? ""}|${change.after?.hash ?? ""}`);
    const fingerprint = `${stamp}\0${parts.join("")}`;
    if (this.driftFingerprint === fingerprint && this.driftSnapshot) {
      return { changed: false, snapshot: this.driftSnapshot, stale };
    }
    this.driftFingerprint = fingerprint;
    this.driftSnapshot = this.publish();
    return { changed: true, snapshot: this.driftSnapshot, stale };
  }
  /**
   * 把漂移送上**人工侧**诊断通道（宿主 logger / 宿主 stderr），按"形状 + 路径 + 两侧 hash"
   * 去重 ⇒ 同一次漂移只报一次，真实文件又被改一次（hash 变）才会再报。
   *
   * ⚠ 契约（`shell-executor.ts:1319-1335` 的分离纪律）：这里**只**写人工通道，
   * 绝不写模型可见的 stdout/stderr，也不进任何命令的 `text` 返回值。
   * @returns {number} 本次真正报出的条数
   */
  emitDriftDiagnostics(stale) {
    if (!Array.isArray(stale) || stale.length === 0) {
      if (this.reportedDrift instanceof Set && this.reportedDrift.size > 0) this.reportedDrift.clear();
      return 0;
    }
    if (!(this.reportedDrift instanceof Set)) this.reportedDrift = /* @__PURE__ */ new Set();
    const live = new Set(stale.map((item) => item.path));
    for (const key of this.reportedDrift) {
      if (!live.has(key.split("\0")[0])) this.reportedDrift.delete(key);
    }
    let emitted = 0;
    for (const item of stale) {
      const key = `${item.path}\0${item.reason}\0${item.expected}\0${item.found}`;
      if (this.reportedDrift.has(key)) continue;
      this.reportedDrift.add(key);
      this.logError(
        `\u57FA\u7EBF\u8FC7\u671F\uFF08${item.reason}\uFF09\uFF1A${item.path} \u2014\u2014 ${driftReasonText(item.reason)}\uFF1B\u5DF2\u62D2\u7EDD\u9759\u9ED8\u843D\u76D8\uFF0C\u5904\u7406\uFF1A/winstage rebase [\u8DEF\u5F84\u2026] \u4EE5\u771F\u5B9E\u6587\u4EF6\u4E3A\u57FA\u7EBF\u91CD\u65B0\u6682\u5B58\uFF0C\u6216 /winstage reject [\u8DEF\u5F84\u2026] \u4E22\u5F03\u8FD9\u4EFD\u6682\u5B58\u3002`
      );
      emitted += 1;
    }
    return emitted;
  }
  /**
   * 批准：把候选（可只选部分路径）写进真实工作区。
   * 逐文件条件检查由 `applyCandidate` 承担：真实文件自暂存以来被外部改动 →
   * 该文件 `STALE_BASELINE` 失败，而不是静默覆盖（手册 #12.1）。
   */
  approve(paths, options = {}) {
    this.reload();
    const pendingBefore = this.reload().listReviews();
    const registryPending = pendingBefore.filter((candidate) => isRegistryCandidate(candidate));
    const registryKeys = new Set(
      registryPending.flatMap((candidate) => (candidate.changes || []).map((change) => compareKey(change.path)))
    );
    const selectedRegistry = paths && paths.length > 0 ? paths.filter((p) => registryKeys.has(compareKey(p))) : [];
    const wantsRegistry = registryPending.length > 0 && ((paths ?? []).length === 0 || selectedRegistry.length > 0);
    const registryOutcome = wantsRegistry ? this._approveRegistry(selectedRegistry) : void 0;
    const filePaths = wantsRegistry && paths && paths.length > 0 ? paths.filter((p) => !registryKeys.has(compareKey(p))) : paths;
    const rebaseResult = options.rebase === true ? this._rebase(filePaths) : void 0;
    const rebased = rebaseResult ? rebaseResult.rebased : [];
    const clearFailures = rebaseResult && Array.isArray(rebaseResult.failures) ? rebaseResult.failures : [];
    const withRegistry = (result2) => {
      if (!registryOutcome) return result2;
      const failed = [...result2.failed ?? [], ...registryOutcome.failed ?? []];
      return {
        ...result2,
        ok: result2.ok === true && registryOutcome.ok === true,
        approved: (result2.approved ?? 0) + (registryOutcome.approved ?? 0),
        failed,
        registry: registryOutcome,
        message: `${result2.message ?? ""}${registryOutcome.message ? `\uFF1B${registryOutcome.message}` : ""}`.trim()
      };
    };
    if (registryOutcome && Array.isArray(paths) && paths.length > 0 && filePaths.length === 0) {
      this.publish();
      this.markFresh();
      return withRegistry({ ok: true, approved: 0, failed: [], remaining: [], rebased, failures: clearFailures, message: "\u6CE8\u518C\u8868\u53D8\u66F4\u5DF2\u5904\u7406" });
    }
    if (this.workspace.diffEntries().length === 0) {
      return withRegistry({ ok: true, approved: 0, failed: [], remaining: [], rebased, failures: clearFailures, message: "\u6CA1\u6709\u5F85\u5BA1\u6587\u4EF6" });
    }
    this.ensureCandidate("approve");
    const ws = this.reload();
    const pending = ws.listReviews();
    const latest = pending[pending.length - 1];
    if (!latest) {
      return withRegistry({ ok: true, approved: 0, failed: [], remaining: [], rebased, failures: clearFailures, message: "\u6CA1\u6709\u5F85\u5BA1\u5019\u9009" });
    }
    const result = ws.applyCandidate(latest.id, {
      paths: filePaths,
      force: options.force === true,
      // 命中敏感策略时的**二次确认**（面板弹窗 / `/winstage approve --confirm-mask`）
      ...options.confirmedMasks !== void 0 ? { confirmedMasks: options.confirmedMasks } : {}
    });
    this.publish();
    this.markFresh();
    const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
    if (conflicts.length > 0) {
      return withRegistry({
        ok: false,
        candidate: result.id,
        approved: 0,
        failed: result.failed,
        conflicts,
        remaining: result.remaining,
        rebased,
        failures: clearFailures,
        message: `\u6709 ${conflicts.length} \u4E2A\u6587\u4EF6\u5728\u4F60\u8FD9\u6B21\u6539\u52A8\u88AB\u8BB0\u4E0B\u4E4B\u540E\u53C8\u88AB\u6539\u8FC7\uFF0C\u5DF2**\u62D2\u7EDD\u8986\u76D6**\uFF08\u78C1\u76D8\u4E0A\u4E00\u4E2A\u5B57\u8282\u90FD\u6CA1\u6539\uFF09\uFF1A${conflicts.map((item) => item.path).join("\u3001")}\u3002\u9010\u6761\u5217\u51FA\u5728 conflicts \u91CC\uFF08\u542B\u5B57\u8282\u6570\u3001\u65F6\u95F4\u6233\u4E0E\u4E24\u4FA7\u7684\u5185\u5BB9\u6458\u8981\uFF09\u3002\u8981\u7528\u4F60\u8FD9\u6B21\u7684\u5185\u5BB9\u8986\u76D6\uFF0C\u8BF7\u663E\u5F0F\u786E\u8BA4\uFF08\u6279\u51C6\u65F6\u5E26 force\uFF09\uFF1B\u8981\u653E\u5F03\uFF0C\u8BF7\u6267\u884C reject \u4E22\u5F03\u672C\u6B21\u5F85\u5BA1\u5185\u5BB9\u3002`
      });
    }
    if (result.failed.length === 0) {
      try {
        this.audit?.decide?.({
          candidateId: result.id,
          approved: true,
          pathCount: result.applied.length
        });
      } catch (error) {
        this.logError(`\u5BA1\u8BA1\u955C\u50CF decide \u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF0C\u4E0D\u5F71\u54CD\u6279\u51C6\uFF09\uFF1A${error?.message ?? error}`);
      }
    }
    return withRegistry({
      ok: result.failed.length === 0,
      candidate: result.id,
      approved: result.applied.length,
      failed: result.failed,
      remaining: result.remaining,
      rebased,
      // 新增键（只加不改）
      failures: clearFailures,
      message: result.failed.length === 0 ? `\u5DF2\u5E94\u7528 ${result.applied.length} \u9879` : `\u5DF2\u5E94\u7528 ${result.applied.length} \u9879\uFF0C\u5931\u8D25 ${result.failed.length} \u9879`
    });
  }
  /**
   * 注册表候选的**懒建**执行面：`sessionDir` = 本会话的存储根。
   *
   * 与文件面共用同一个 `queue.json` / `candidates/`，但 apply/discard 必须走
   * `createRegistryStage()`（它才认识覆盖层与 WAL）。拿不到 `storeDir`
   * （无会话身份的共享存储）时返回 `undefined` —— 调用方据此如实报错，
   * **绝不**假装批准成功。
   */
  registryStage() {
    if (typeof this.storeDir !== "string" || this.storeDir.length === 0) return void 0;
    if (!this._registryStage) {
      this._registryStage = createRegistryStage({
        sessionDir: this.storeDir,
        sessionId: this.sessionId,
        workspaceRoot: this.workspaceRoot,
        reader: createRegExeReader(),
        writer: createRegExeWriter({ wireBytes: registryWireBytes, log: (message) => this.log(message) })
      });
    }
    return this._registryStage;
  }
  /** 内部：批准注册表候选（`selection` 为空 = 全部）。永不抛。 */
  _approveRegistry(selection) {
    const stage = this.registryStage();
    if (!stage) {
      return {
        ok: false,
        approved: 0,
        failed: [{ path: "(registry)", error: "REG_STORE_DIR_MISSING: \u672C\u4F1A\u8BDD\u6CA1\u6709\u5B58\u50A8\u6839\uFF0C\u65E0\u6CD5\u5E94\u7528\u6CE8\u518C\u8868\u5019\u9009" }],
        message: "\u6CE8\u518C\u8868\u5019\u9009\u65E0\u6CD5\u5E94\u7528\uFF08\u7F3A sessionDir\uFF09"
      };
    }
    try {
      stage.open();
      const result = stage.apply(Array.isArray(selection) && selection.length > 0 ? { paths: selection } : {});
      const failed = [];
      for (const entry of result.failed ?? []) {
        failed.push({ path: entry.path, error: `${entry.status ?? ""} ${entry.reason ?? ""}`.trim() || "registry-apply-failed" });
      }
      for (const entry of result.blocked ?? []) {
        failed.push({ path: entry.path, error: `${entry.status ?? ""} ${entry.reason ?? ""}`.trim() || "parent-key-missing" });
      }
      const applied2 = result.applied ?? [];
      return {
        ok: failed.length === 0,
        approved: applied2.length,
        failed,
        stale: result.stale ?? [],
        message: `\u6CE8\u518C\u8868\uFF1A\u5DF2\u5E94\u7528 ${applied2.length} \u9879${failed.length ? `\uFF0C\u5931\u8D25 ${failed.length} \u9879` : ""}`
      };
    } catch (error) {
      const detail = `${error?.code ?? error?.name ?? "error"}: ${error?.message ?? error}`;
      this.logError(`\u6CE8\u518C\u8868\u6279\u51C6\u5931\u8D25\uFF08\u5982\u5B9E\u4E0A\u62A5\uFF0C\u4E0D\u5047\u88C5\u6210\u529F\uFF09\uFF1A${detail}`);
      return { ok: false, approved: 0, failed: [{ path: "(registry)", error: detail }], message: `\u6CE8\u518C\u8868\u6279\u51C6\u5931\u8D25\uFF1A${detail}` };
    }
  }
  /**
   * 内部：把基线已过期的条目重新对齐到真实文件（**不** publish）。
   *
   * 对齐后必须**重新冻结候选**：旧候选里每条 change 的 `before/after` 都是旧基线的
   * 快照，继续用它去批准仍会 STALE_BASELINE、diff 也还是错的。因此：
   *   1. 命中的候选整份 discard（`reconcileCandidates` 的 `affected` 规则，
   *      与 D2 的"discard 范围必须与回收范围一致"同一条纪律）；
   *   2. 剩下的净 diff 用 `ensureCandidate('rebase')` 重新冻结成新候选。
   * @returns {{rebased: string[], discarded: string[], reasons: Record<string,string>, failures: Array}}
   */
  _rebase(paths) {
    this.clearFailures = [];
    const ws = this.reload();
    const selected = paths && paths.length > 0 ? new Set(paths.map(compareKey)) : void 0;
    const rebased = [];
    const reasons = {};
    for (const rel of Object.keys(ws.manifest.entries)) {
      if (selected && !selected.has(compareKey(rel))) continue;
      const drift = ws.baselineDrift(rel);
      if (!drift.stale) continue;
      if (ws.rebaseEntry(rel)) {
        rebased.push(rel);
        reasons[rel] = drift.reason ?? "baseline-drifted";
      }
    }
    if (rebased.length === 0) return { rebased, discarded: [], reasons, failures: [] };
    ws.store.touch(ws.manifest);
    const affected = new Set(rebased.map(compareKey));
    const netKeys = new Set(ws.diffEntries().map((change) => compareKey(change.path)));
    const discarded = this.reconcileCandidates(ws, { reason: "rebase", affected, netKeys });
    if (ws.diffEntries().length > 0) this.ensureCandidate("rebase");
    return { rebased, discarded, reasons, failures: this.clearFailures.slice() };
  }
  /**
   * 以真实文件为基线重新暂存（`/winstage rebase [路径…]`）。
   *
   * 为什么不自动做：`STALE_BASELINE` 是**故意的**安全闸（手册 #12.1）——它保证
   * "被外部改动过的文件不会被悄悄覆盖"。rebase 把基线换成现实、同时把真实内容
   * 放进 diff 的 before（用户看得见自己将要替换什么），是显式、可复核的出路，
   * 而不是把闸门删掉。
   *   - 不给路径 = 对所有基线过期的条目生效；
   *   - 真实内容恰好等于暂存内容时，该条目变成"无净变化"，自动退出视图。
   */
  rebase(paths) {
    const result = this._rebase(paths);
    const snapshot = this.publish();
    this.markFresh();
    return {
      ok: true,
      rebased: result.rebased,
      discarded: result.discarded,
      // 新增键（只加不改）：清除路径上"没清干净"的项
      failures: Array.isArray(result.failures) ? result.failures : [],
      remaining: snapshot.counts.net,
      message: result.rebased.length === 0 ? "\u6CA1\u6709\u57FA\u7EBF\u8FC7\u671F\u7684\u5F85\u5BA1\u6761\u76EE\uFF08\u89C6\u56FE\u5DF2\u7ECF\u4E0E\u771F\u5B9E\u78C1\u76D8\u4E00\u81F4\uFF09" : `\u5DF2\u4EE5\u771F\u5B9E\u6587\u4EF6\u4E3A\u57FA\u7EBF\u91CD\u65B0\u6682\u5B58 ${result.rebased.length} \u9879` + (Object.values(result.reasons || {}).includes("baseline-appeared") ? '\uFF08\u5176\u4E2D\u542B"\u771F\u5B9E\u6587\u4EF6\u5728\u6682\u5B58\u4E4B\u540E\u51FA\u73B0"\u7684\u6761\u76EE\uFF1A\u73B0\u5728\u9762\u677F\u663E\u793A\u7684 before \u5C31\u662F\u78C1\u76D8\u4E0A\u7684\u771F\u5B9E\u5185\u5BB9\uFF09' : "")
    };
  }
  /**
   * 拒绝：把这些路径的暂存改动**退回真实磁盘视图**（不是删文件）。
   *
   * ── 语义（逐条，含 D2 修好之后的行为）────────────────────────────────────────
   *   - 删除清单条目 + 回收暂存对象 → 读取重新落到真实文件；
   *   - **discard 的范围必须与回收的范围一致（实测缺陷 D2）**：旧实现对全部净 diff
   *     路径做 `revert()`，却只 `discardCandidate(latest)` ⇒ 其它"被回收光了暂存内容"
   *     的候选留在 `queue.json` 里当 `pending`（本轮 `cs_0002` 就是 host 事后补 discard 的）。
   *     现在改为：**所有受本次拒绝影响、或已经失去全部可审内容的候选一并 discard**
   *     （`reconcileCandidates()`），因此拒绝之后**不会再留下空壳 pending**；
   *   - 仍有暂存内容的剩余改动重新冻结成**一份新候选**，否则被拒绝的路径仍留在候选里，
   *     下次批准会把它又写回去（#12.2 的反例）；
   *   - **拒绝全部（未给路径）= 清空全部暂存 + 终结全部候选**。因此它之后
   *     `pending=false` ⇒ **面板整体卸载是设计，不是缺陷**（没有任何东西可审了）。
   *     旧版"只 discard 最新候选"会让面板先卸载、队列里却留着 pending —— 那才是缺陷。
   *   - 给了路径时只影响这些路径所属的候选；其余候选照旧留在面板上。
   */
  reject(paths) {
    this.clearFailures = [];
    const registryPending = this.reload().listReviews().filter((candidate) => isRegistryCandidate(candidate));
    const registryKeys = new Set(
      registryPending.flatMap((candidate) => (candidate.changes || []).map((change) => compareKey(change.path)))
    );
    const selectedRegistryDiscard = paths && paths.length > 0 ? paths.filter((p) => registryKeys.has(compareKey(p))) : [];
    const wantsRegistryDiscard = registryPending.length > 0 && ((paths ?? []).length === 0 || selectedRegistryDiscard.length > 0);
    let registryDiscard;
    if (wantsRegistryDiscard) {
      const stage = this.registryStage();
      if (stage) {
        try {
          stage.open();
          registryDiscard = stage.discard({ reason: "user-rejected" });
        } catch (error) {
          const detail = `${error?.code ?? error?.name ?? "error"}: ${error?.message ?? error}`;
          this.logError(`\u6CE8\u518C\u8868\u5019\u9009\u4E22\u5F03\u5931\u8D25\uFF08\u771F\u5B9E hive \u4ECE\u672A\u88AB\u6539\uFF0C\u6545\u65E0\u6B8B\u7559\uFF09\uFF1A${detail}`);
          registryDiscard = { error: detail };
        }
      } else {
        registryDiscard = { error: "REG_STORE_DIR_MISSING" };
      }
    }
    const rejectPaths = wantsRegistryDiscard && paths && paths.length > 0 ? paths.filter((p) => !registryKeys.has(compareKey(p))) : paths;
    if (wantsRegistryDiscard && Array.isArray(paths) && paths.length > 0 && rejectPaths.length === 0) {
      this.publish();
      this.markFresh();
      return {
        ok: registryDiscard?.error === void 0,
        rejected: 0,
        paths: [],
        discarded: [],
        registryDiscarded: registryDiscard,
        failures: registryDiscard?.error ? [{ path: "(registry)", error: registryDiscard.error }] : [],
        message: registryDiscard?.error ? `\u6CE8\u518C\u8868\u5019\u9009\u4E22\u5F03\u5931\u8D25\uFF1A${registryDiscard.error}` : "\u6CE8\u518C\u8868\u5019\u9009\u5DF2\u4E22\u5F03\uFF08\u771F\u5B9E\u6CE8\u518C\u8868\u4ECE\u672A\u88AB\u6539\uFF09"
      };
    }
    const ws = this.reload();
    const changes = ws.diffEntries();
    const netKeys = new Set(changes.map((change) => compareKey(change.path)));
    const liveBefore = ws.listReviews();
    const selected = rejectPaths && rejectPaths.length > 0 ? new Set(rejectPaths.map(compareKey)) : void 0;
    if (!selected && changes.length === 0 && liveBefore.length === 0) {
      return {
        ok: true,
        rejected: 0,
        paths: [],
        discarded: [],
        ...registryDiscard ? { registryDiscarded: registryDiscard } : {},
        message: registryDiscard ? "\u6CE8\u518C\u8868\u5019\u9009\u5DF2\u4E22\u5F03" : "\u6CA1\u6709\u5F85\u5BA1\u6587\u4EF6"
      };
    }
    const targets = selected ? changes.filter((c) => selected.has(compareKey(c.path))) : changes;
    const affected = new Set(selected || netKeys);
    if (!selected) {
      for (const candidate of liveBefore) {
        for (const change of candidate.changes || []) affected.add(compareKey(change.path));
      }
    } else {
      const touchesCandidate = liveBefore.some(
        (candidate) => (candidate.changes || []).some((change) => selected.has(compareKey(change.path)))
      );
      if (targets.length === 0 && !touchesCandidate) {
        return { ok: true, rejected: 0, paths: [], discarded: [], message: "\u6240\u9009\u8DEF\u5F84\u6CA1\u6709\u5F85\u5BA1\u6539\u52A8" };
      }
    }
    for (const change of targets) this.revert(ws, change.path);
    ws.store.touch(ws.manifest);
    const discarded = this.reconcileCandidates(ws, { reason: "user-rejected", affected, netKeys });
    if (ws.diffEntries().length > 0) this.ensureCandidate("reject-remaining");
    this.publish();
    this.markFresh();
    try {
      const affectedKeys = affected instanceof Set ? affected : /* @__PURE__ */ new Set();
      const closedIds = new Set(Array.isArray(discarded) ? discarded : []);
      for (const candidate of liveBefore) {
        const hit = (candidate.changes || []).some((change) => affectedKeys.has(compareKey(change.path)));
        if (hit) closedIds.add(candidate.id);
      }
      for (const candidateId of closedIds) {
        this.audit?.decide?.({ candidateId, approved: false, note: "user-rejected" });
      }
    } catch (error) {
      this.logError(`\u5BA1\u8BA1\u955C\u50CF reject-decide \u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF0C\u4E0D\u5F71\u54CD\u62D2\u7EDD\uFF09\uFF1A${error?.message ?? error}`);
    }
    return {
      ok: true,
      rejected: targets.length,
      paths: targets.map((c) => c.path),
      discarded,
      ...registryDiscard ? { registryDiscarded: registryDiscard } : {},
      failures: this.clearFailures.slice()
    };
  }
  /**
   * 候选对账（D2）：把**已经没有可审内容**的候选一并 `discard`，让 discard 的范围
   * 与暂存回收的范围一致。
   *
   * 判据（两条，任一命中即终结该候选；两条都只依赖 host 侧真值）：
   *   1. `affected` 命中：候选的某条冻结路径正是本次被拒绝的路径 —— 候选的冻结清单
   *      已经与现实不符，而产品没有"从候选里摘掉一条 change"的 API，只能整份终结
   *      （剩下的净 diff 路径会由 `ensureCandidate('reject-remaining')` 重新冻结）；
   *   2. 已经是空壳：候选的**每一条**冻结路径都不在当前净 diff 里 ⇒ 它一条都批不了
   *      （写入面按净 diff 过滤），留着只会污染"待审数"口径。
   *
   * 只在**变更路径**（`reject()`）调用：轮询只读路径绝不改状态。
   */
  reconcileCandidates(ws, options = {}) {
    const netKeys = options.netKeys || new Set(ws.diffEntries().map((change) => compareKey(change.path)));
    const affected = options.affected;
    const reason = options.reason || "no-stageable-paths";
    const discarded = [];
    for (const candidate of ws.listReviews()) {
      const keys = (candidate.changes || []).map((change) => compareKey(change.path));
      if (keys.length === 0) continue;
      const touched = affected ? keys.some((key) => affected.has(key)) : false;
      const noStageable = keys.every((key) => !netKeys.has(key));
      if (!touched && !noStageable) continue;
      try {
        ws.discardCandidate(candidate.id, { reason });
        discarded.push(candidate.id);
      } catch (error) {
        this.logError(`\u5019\u9009\u5BF9\u8D26\uFF1A\u4E22\u5F03 ${candidate.id} \u5931\u8D25\uFF1A${error.message}`);
        this.noteClearFailure({ candidateId: candidate.id, code: "ECANDIDATE_DISCARD_FAILED", message: error.message });
      }
    }
    return discarded;
  }
  /** 解除一个路径的暂存引用并回收其暂存对象（先落状态、再回收，#13.1） */
  revert(ws, rel) {
    const entry = ws.entryOf(rel);
    if (!entry) return false;
    const stagedPath = ws.staged(rel);
    delete ws.manifest.entries[rel];
    if (existsSync8(stagedPath)) {
      try {
        makeRemovable(stagedPath);
        rmSync7(stagedPath, { recursive: true, force: true });
      } catch (error) {
        this.logError(`\u56DE\u6536\u6682\u5B58\u5BF9\u8C61\u5931\u8D25 ${rel}\uFF1A${error.message}`);
        this.noteClearFailure({ path: rel, code: "ESTAGED_RECLAIM_FAILED", message: error.message });
      }
    }
    this.pruneEmptyDirs(ws);
    return true;
  }
  pruneEmptyDirs(ws) {
    let removed = 0;
    for (const [rel, entry] of Object.entries(ws.manifest.entries)) {
      if (entry.kind !== "dir") continue;
      const prefix = childPrefix(rel);
      const hasChild = Object.keys(ws.manifest.entries).some((other) => other !== rel && compareKey(other).startsWith(prefix));
      if (hasChild) continue;
      if (existsSync8(ws.absolute(rel))) continue;
      delete ws.manifest.entries[rel];
      removed += 1;
    }
    return removed;
  }
};
var SERVICES = /* @__PURE__ */ new Map();
function fnv1a32(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
function sessionDirKey(sessionId) {
  const raw = typeof sessionId === "string" ? sessionId.trim() : "";
  if (raw.length === 0) return "";
  if (/^[A-Za-z0-9._-]{1,64}$/.test(raw)) return raw;
  return `s_${fnv1a32(raw)}_${raw.length}`;
}
function adoptLegacyStore(workspaceRoot, targetDir) {
  try {
    const legacyDir = legacyWorkspaceStoreDir(workspaceRoot);
    const legacyManifest = join12(legacyDir, "manifest.json");
    if (!targetDir || !existsSync8(legacyManifest) || existsSync8(targetDir)) return false;
    const claimDir = join12(legacyDir, "sessions");
    mkdirSync7(claimDir, { recursive: true });
    try {
      writeFileSync8(join12(claimDir, ".legacy-claimed"), "", { flag: "wx" });
    } catch {
      return false;
    }
    mkdirSync7(targetDir, { recursive: true });
    let moved = 0;
    for (const name of ["manifest.json", "queue.json", "blobs", "staged", "staged-ext", "candidates", "real", "private", "cache"]) {
      const from = join12(legacyDir, name);
      if (!existsSync8(from)) continue;
      try {
        renameSync5(from, join12(targetDir, name));
        moved += 1;
      } catch {
      }
    }
    return moved > 0;
  } catch {
    return false;
  }
}
function copyTreeMissing(src, dst) {
  let info;
  try {
    info = statSync5(src);
  } catch {
    return;
  }
  if (info.isDirectory()) {
    mkdirSync7(dst, { recursive: true });
    let names = [];
    try {
      names = readdirSync5(src);
    } catch {
      return;
    }
    for (const name of names) copyTreeMissing(join12(src, name), join12(dst, name));
    return;
  }
  if (!info.isFile() || existsSync8(dst)) return;
  try {
    mkdirSync7(dirname8(dst), { recursive: true });
    copyFileSync2(src, dst);
  } catch {
  }
}
function listReviewServices(workspaceRoot) {
  const wanted = workspaceRoot ? canonical(workspaceRoot) : void 0;
  const out = [];
  for (const service of SERVICES.values()) {
    if (!service || typeof service.reviewDrift !== "function") continue;
    if (wanted && canonical(service.workspaceRoot) !== wanted) continue;
    out.push(service);
  }
  return out;
}
function getReviewService(options = {}) {
  if (!options?.workspaceRoot) throw new Error("getReviewService: workspaceRoot is required");
  const root = canonical(options.workspaceRoot);
  const sessionKey = sessionDirKey(options.sessionId);
  const key = sessionKey ? `${root}#${sessionKey}` : root;
  let service = SERVICES.get(key);
  if (!service) {
    const storeDir = resolveReviewStoreDir({
      workspaceRoot: root,
      sessionId: options.sessionId,
      storeDir: options.storeDir,
      stageRoot: options.stageRoot,
      env: options.env
    });
    if (storeDir && options.claimShared !== false) adoptLegacyStore(root, storeDir);
    service = new ReviewService({ ...options, workspaceRoot: root, storeDir });
    SERVICES.set(key, service);
  } else if (options.log && !service.log) {
    service.log = options.log;
  }
  if (options.logger && !service.logger) service.logger = options.logger;
  if (sessionKey && options.claimShared !== false && typeof service.absorbSharedStore === "function") service.absorbSharedStore();
  return service;
}

// dsh-plugin/session-identity.ts
function rootSessionIdOf(ctx, session) {
  if (!session || typeof session !== "object") return void 0;
  const sessions = ctx && typeof ctx.get === "function" ? ctx.get("sessions") : ctx?.sessions;
  let current = session;
  const seen = /* @__PURE__ */ new Set();
  for (let depth = 0; depth < 16; depth += 1) {
    const id = typeof current?.id === "string" ? current.id : "";
    if (id.length === 0) return void 0;
    if (seen.has(id)) return id;
    seen.add(id);
    const parentId = current?.header?.parentSession;
    if (typeof parentId !== "string" || parentId.length === 0) return id;
    const parent = sessions && typeof sessions.get === "function" ? sessions.get(parentId) : void 0;
    if (!parent) {
      return parentId;
    }
    current = parent;
  }
  return current?.id;
}
function rootSessionIdFor(ctx, sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return void 0;
  const sessions = ctx && typeof ctx.get === "function" ? ctx.get("sessions") : ctx?.sessions;
  const session = sessions && typeof sessions.get === "function" ? sessions.get(sessionId) : void 0;
  if (!session) return sessionId;
  return rootSessionIdOf(ctx, session) ?? sessionId;
}

export {
  STAGE_ROOT_LOST,
  STAGE_GUARD_UNAVAILABLE,
  verifyStageRootAlive,
  checkTransparentMessages,
  WINDOWS_HIDE,
  suppressWindowsCriticalErrorDialogs,
  resolveDshModuleRoot,
  WindowsStageExecutor,
  FAILURE_SEMANTICS,
  FAILURE_CODE_ENVIRONMENT,
  FAILURE_CATEGORY_CODES,
  transparencyViolations,
  classifyFailureSemantics,
  detectCleartextSecret,
  CLEARTEXT_SECRET_FAILURE,
  canonical,
  compareKey,
  maskKey,
  maskReason,
  STATE,
  sha256Buffer,
  hashAbsent,
  isExternalKey,
  writeFileAtomic,
  renderCandidateDiff,
  UNSTAGED_REASONS,
  recordUnstaged,
  registryWireBytes,
  createRegistryStage,
  createRegExeReader,
  createRegExeWriter,
  REVIEW_BASENAME,
  noteEffectiveStaging,
  resolveReviewStoreDir,
  setReadVisibilityPolicy,
  recordReadVisibility,
  listReviewServices,
  getReviewService,
  rootSessionIdOf,
  rootSessionIdFor
};
