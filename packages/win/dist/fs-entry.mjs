import {
  FAILURE_CODE_ENVIRONMENT,
  FAILURE_SEMANTICS,
  STAGE_GUARD_UNAVAILABLE,
  STAGE_ROOT_LOST,
  STATE,
  UNSTAGED_REASONS,
  canonical,
  checkTransparentMessages,
  getReviewService,
  hashAbsent,
  isExternalKey,
  maskKey,
  maskReason,
  noteEffectiveStaging,
  recordReadVisibility,
  recordUnstaged,
  resolveDshModuleRoot,
  rootSessionIdFor,
  rootSessionIdOf,
  setReadVisibilityPolicy
} from "./chunk-JQDMKSOE.mjs";
import "./chunk-Z53TC6BM.mjs";

// dsh-plugin/staging-fs.ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
function locatePackageFile(relativePath) {
  let roots = [];
  try {
    roots = resolveDshModuleRoot() || [];
  } catch {
    roots = [];
  }
  for (const root of roots) {
    if (!root) continue;
    const candidate = join(root, relativePath);
    if (existsSync(candidate)) return candidate;
  }
  return void 0;
}
async function importPlatformModule(spec, relativePath) {
  const file = locatePackageFile(relativePath);
  const errors = [];
  if (file) {
    try {
      return { mod: await import(pathToFileURL(file).href), from: file };
    } catch (error) {
      errors.push(`${file}: ${error?.message ?? error}`);
    }
  }
  try {
    return { mod: await import(spec), from: spec };
  } catch (error) {
    errors.push(`${spec}: ${error?.message ?? error}`);
    return { mod: void 0, from: spec, error: new Error(errors.join(" | ")) };
  }
}
var fsImport = await importPlatformModule("@deepseek-ai/dsh-fs", join("@deepseek-ai", "dsh-fs", "lib", "index.js"));
var fsLocalImport = await importPlatformModule("@deepseek-ai/dsh-fs-local", join("@deepseek-ai", "dsh-fs-local", "lib", "index.js"));
if (!fsImport.mod || !fsLocalImport.mod) {
  throw new Error(
    `WinStage \u6682\u5B58\u6587\u4EF6\u7CFB\u7EDF\uFF1A\u65E0\u6CD5\u5B9A\u4F4D @deepseek-ai/dsh-fs \u6216 @deepseek-ai/dsh-fs-local\u3002\u8BF7\u8BBE\u7F6E DSH_SANDBOX_NODE_ROOT \u6307\u5411\u542B @deepseek-ai/* \u7684 node_modules\u3002\uFF08\u78C1\u76D8\u4E0E\u8FD0\u884C\u65F6\u89E3\u6790\u5747\u5931\u8D25\uFF1Adsh-fs=${fsImport.error ? fsImport.error.message : "ok"}\uFF1Bdsh-fs-local=${fsLocalImport.error ? fsLocalImport.error.message : "ok"}\uFF09`
  );
}
var { FsError, FsVersion, FsTargetKey } = fsImport.mod;
var { LocalFileSystem } = fsLocalImport.mod;
var sandboxImport = await importPlatformModule("@deepseek-ai/dsh-fs-sandbox", join("@deepseek-ai", "dsh-fs-sandbox", "lib", "index.js"));
var SandboxedFileSystem = sandboxImport.mod ? sandboxImport.mod.SandboxedFileSystem : void 0;
function normalizeLineEndings(text) {
  return String(text).replace(/\r\n?/g, "\n");
}
function lineEndingOf(text) {
  return String(text).includes("\r\n") ? "\r\n" : "\n";
}
function restoreLineEndings(text, eol) {
  return eol === "\r\n" ? String(text).replace(/\n/g, "\r\n") : String(text);
}
function sameRoot(a, b) {
  try {
    return canonical(String(a)).toLowerCase() === canonical(String(b)).toLowerCase();
  } catch {
    return String(a).toLowerCase() === String(b).toLowerCase();
  }
}
function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
var ENV_FAULT_RETRYABLE = FAILURE_CODE_ENVIRONMENT;
var STAGE_LOSS_CODES = /* @__PURE__ */ new Set([STAGE_ROOT_LOST, STAGE_GUARD_UNAVAILABLE]);
function isStageLossError(error) {
  return typeof error?.code === "string" && STAGE_LOSS_CODES.has(error.code);
}
var EXTRA_FORBIDDEN_TOKENS = Object.freeze(["stage_root_lost", "stage_guard_unavailable", "overlay"]);
function transparencyReport(texts = []) {
  const base = checkTransparentMessages(texts);
  const violations = [...base.violations];
  for (const text of texts) {
    const lower = String(text).toLowerCase();
    for (const token of EXTRA_FORBIDDEN_TOKENS) {
      if (lower.includes(token)) violations.push({ text: String(text), word: token });
    }
  }
  return { ok: violations.length === 0, violations };
}
var MODEL_VISIBLE_FAILURE_TEXTS = Object.freeze({
  /** 写入回读失败（产物不存在/内容不一致）⇒ 不返回成功 */
  writeNotPersisted: (displayPath) => `cannot save "${displayPath}": the change could not be read back from disk and is not reported as applied`,
  /** 根丢失 / 守卫不可用 ⇒ 可重试的环境类普通失败 */
  environmentRetryable: (displayPath) => `cannot complete the operation on "${displayPath}": the session working directory is temporarily unavailable, retry this operation`,
  /** 读侧 `readPolicy:'block'` 命中遮蔽表（默认 `record` 时**不会**出现） */
  readDenied: (displayPath) => `cannot read "${displayPath}": this path is not readable under the current read policy`,
  /** 拒绝经 `ctx.fs` 写本工具自身的状态机（自指条目） */
  storeWriteDenied: (displayPath) => `refusing to modify "${displayPath}": this path belongs to this tool's own bookkeeping files, and a change there could never be approved`,
  /**
   * 清单条目指向的内容对象在磁盘上不见了（历史上这句话写的是
   * `staged content for "…" is missing` —— 含 `staged`（= 禁用词 `stage` 的子串）
   * 且泄漏机制；这里改成普通失败口径，细节仍走 `logError` 与 `error.code`）。
   */
  contentMissing: (displayPath) => `content for "${displayPath}" is not available`,
  /**
   * `stageOutside: 'deny'`：工作区外写入被显式拒绝（opt-in 档）。
   *
   * 措辞要求：**诚实**（说清"没有写、也不在待批队列里"）+ **零机制字样**
   * （不出现 staging/staged/暂存/替代路径）。因此它说的是"this tool is configured to
   * refuse writes outside the workspace"，而不是"已进暂存等你批准"。
   * 注意与 `'stage'` 档的区别：那一档**确实**写成功了（进待批队列），只是没落真实盘；
   * 那一档的诚实信息走非枚举 diagnostics（见 `locationDiagnostics()`），因为
   * `dsh-tool-fs` 的输出 schema 是 `additionalProperties:false` 且渲染器只认
   * `operation`，**回执里加键到不了模型**（实测见修复报告 §1.2）。
   */
  outsideWriteDenied: (displayPath) => `refusing to write "${displayPath}": this tool is configured to refuse writes outside the workspace, and nothing was written`
});
function assertTransparentFailureTexts() {
  const sample = "C:\\ws\\a.txt";
  const samples = [
    MODEL_VISIBLE_FAILURE_TEXTS.writeNotPersisted(sample),
    MODEL_VISIBLE_FAILURE_TEXTS.environmentRetryable(sample),
    MODEL_VISIBLE_FAILURE_TEXTS.readDenied(sample),
    MODEL_VISIBLE_FAILURE_TEXTS.storeWriteDenied(sample),
    MODEL_VISIBLE_FAILURE_TEXTS.contentMissing(sample),
    MODEL_VISIBLE_FAILURE_TEXTS.outsideWriteDenied(sample)
  ];
  const result = transparencyReport(samples);
  if (!result.ok) {
    throw new Error(`transparency violation: ${JSON.stringify(result.violations)}`);
  }
  return { ok: true, checked: samples.length };
}
assertTransparentFailureTexts();
var STAGE_DIAGNOSTICS = /* @__PURE__ */ Symbol.for("winstage.stagingFs.diagnostics");
function attachStageDiagnostics(outcome, diagnostics) {
  if (outcome === null || typeof outcome !== "object") return outcome;
  try {
    Object.defineProperty(outcome, STAGE_DIAGNOSTICS, {
      value: Object.freeze({ ...diagnostics }),
      enumerable: false,
      writable: false,
      configurable: false
    });
  } catch {
  }
  return outcome;
}
var STAGE_ROOT_MARKERS = Object.freeze([".dshstage", "staged-ext", `${sep}staged${sep}`]);
var SUCCESS_OUTCOME_KEYS = Object.freeze(["operation", "version", "before", "after", "logicalPath"]);
function checkTransparentSuccessOutcome(outcome, allowedKeys = SUCCESS_OUTCOME_KEYS) {
  const violations = [];
  if (outcome === null || typeof outcome !== "object") {
    return { ok: false, violations: [{ word: "not-an-object", text: String(outcome) }], visibleKeys: [] };
  }
  const visibleKeys = Object.keys(outcome);
  for (const key of visibleKeys) {
    if (!allowedKeys.includes(key)) violations.push({ word: `unexpected-visible-key:${key}`, text: key });
  }
  const allStrings = [];
  for (const key of visibleKeys) {
    const value = outcome[key];
    if (typeof value === "string") allStrings.push({ key, value });
  }
  violations.push(...checkTransparentMessages([String(outcome.operation ?? "")]).violations);
  for (const { key, value } of allStrings) {
    const lower = value.toLowerCase();
    for (const token of STAGE_ROOT_MARKERS) {
      if (lower.includes(token.toLowerCase())) violations.push({ word: `${token} (in ${key})`, text: value });
    }
  }
  return { ok: violations.length === 0, violations, visibleKeys };
}
function assertTransparentSuccessOutcome() {
  const clean = checkTransparentSuccessOutcome({
    operation: "create",
    version: "winstage:0000",
    before: null,
    after: "hello\n",
    logicalPath: "C:\\ws\\a.txt"
  });
  if (!clean.ok) throw new Error(`success-path transparency violation: ${JSON.stringify(clean.violations)}`);
  const dirtyKey = checkTransparentSuccessOutcome({ operation: "create", version: "winstage:0000", logicalPath: "C:\\ws\\a.txt", stagedPath: "C:\\stage\\staged\\a.txt" });
  if (dirtyKey.ok) throw new Error("success-path transparency checker is not armed (extra visible key passed)");
  const dirtyPath = checkTransparentSuccessOutcome({ operation: "create", version: "winstage:0000", logicalPath: `C:\\x\\.dshstage\\staged\\a.txt` });
  if (dirtyPath.ok) throw new Error("success-path transparency checker is not armed (stage root in logicalPath passed)");
  return { ok: true, checked: 3 };
}
assertTransparentSuccessOutcome();
var SHIM_FS_LEAF = "fs";
var SHIM_WHITEOUT_LEAF = "wo";
function splitLogicalPath(abs) {
  const normalized = normalize(String(abs));
  if (normalized.startsWith("\\\\")) {
    const parts2 = normalized.slice(2).split(/[\\/]+/).filter((part) => part.length > 0);
    return parts2.length === 0 ? void 0 : { drive: "_unc", parts: parts2 };
  }
  const match = /^([a-zA-Z]):[\\/]?(.*)$/.exec(normalized);
  if (!match) return void 0;
  const parts = match[2].split(/[\\/]+/).filter((part) => part.length > 0);
  return { drive: match[1].toUpperCase(), parts };
}
function shimLayoutPathOf(stagedDir, abs, leaf = SHIM_FS_LEAF) {
  if (typeof stagedDir !== "string" || stagedDir.length === 0) return void 0;
  const parsed = splitLogicalPath(abs);
  if (parsed === void 0) return void 0;
  return join(stagedDir, leaf, parsed.drive, ...parsed.parts);
}
function logicalFromShimLayout(stagedDir, abs, leaf = SHIM_FS_LEAF) {
  if (typeof stagedDir !== "string" || typeof abs !== "string") return void 0;
  let rel;
  try {
    rel = relative(join(stagedDir, leaf), normalize(abs));
  } catch {
    return void 0;
  }
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return void 0;
  const parts = rel.split(/[\\/]+/).filter((part) => part.length > 0);
  if (parts.length < 1) return void 0;
  const [head, ...rest] = parts;
  if (head.toLowerCase() === "_unc") return rest.length > 0 ? `\\\\${rest.join("\\")}` : void 0;
  if (!/^[a-zA-Z]$/.test(head)) return void 0;
  return rest.length > 0 ? `${head.toUpperCase()}:\\${rest.join("\\")}` : `${head.toUpperCase()}:\\`;
}
var STORE_SEGMENT_TAIL = "\\.dshstage\\";
var STORE_METADATA_FILES = /* @__PURE__ */ new Set(["manifest.json", "review.json", "queue.json"]);
var STORE_STATE_DIRS = /* @__PURE__ */ new Set(["blobs", "staged", "staged-ext", "candidates", "sessions", "real", "private", "cache"]);
function isStoreStatePath(abs) {
  if (typeof abs !== "string" || abs.length === 0) return false;
  const normalized = abs.replace(/\//g, "\\");
  const at = normalized.toLowerCase().lastIndexOf(STORE_SEGMENT_TAIL);
  if (at < 0) return false;
  const rest = normalized.slice(at + STORE_SEGMENT_TAIL.length);
  if (rest.length === 0) return false;
  const slash = rest.indexOf("\\");
  if (slash < 0) return STORE_METADATA_FILES.has(rest.toLowerCase());
  return STORE_STATE_DIRS.has(rest.slice(0, slash).toLowerCase());
}
function applyLiteralEdit(text, edit, displayPath) {
  if (!edit || typeof edit.oldString !== "string" || edit.oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": oldString must be a non-empty string`, "FS_EDIT_NOT_FOUND");
  }
  const occurrences = text.split(edit.oldString).length - 1;
  if (occurrences === 0) {
    throw new FsError(`cannot edit "${displayPath}": the text to replace was not found`, "FS_EDIT_NOT_FOUND");
  }
  if (occurrences > 1 && edit.replaceAll !== true) {
    throw new FsError(`cannot edit "${displayPath}": the text to replace is ambiguous (${occurrences} matches)`, "FS_AMBIGUOUS_EDIT");
  }
  const next = edit.replaceAll === true ? text.split(edit.oldString).join(edit.newString ?? "") : text.replace(edit.oldString, edit.newString ?? "");
  return next;
}
function createStagingFileSystem(options = {}) {
  const rawStageOutside = options.stageOutside;
  const stageOutside = rawStageOutside === "direct" || rawStageOutside === "deny" || rawStageOutside === "stage" ? rawStageOutside : "stage";
  const Base = options.base || SandboxedFileSystem || LocalFileSystem;
  const enabledOverride = typeof options.enabled === "function" ? options.enabled : void 0;
  return class StagingFileSystem extends Base {
    /**
     * `cwd` / `diffBasisMaxBytes` 的 schema 来自基类，这里显式声明为**自有**静态属性：
     * 静态属性虽然可继承，但把配置契约摆在自己身上更稳（装配器读的是 `plugin.Config`）。
     */
    static Config = Base.Config;
    constructor(ctx, config) {
      super(ctx, config);
      this.rootEntry = ctx?.fiber?.entry;
      const logger = ctx?.logger;
      this.log = options.log || ((message) => {
        if (logger && typeof logger.info === "function") logger.info(message);
        else console.log(`[winstage-fs] ${message}`);
      });
      this.logger = logger;
      this.logError = (message) => {
        const line = `[winstage-fs] ${message}`;
        try {
          if (logger && typeof logger.warn === "function") return logger.warn(line);
          if (logger && typeof logger.error === "function") return logger.error(line);
        } catch {
        }
        try {
          console.error(line);
        } catch {
        }
      };
      const drift = config?.workspaceRoot !== void 0 && config?.workspaceRoot !== null && String(config.workspaceRoot).length > 0 && String(config?.cwd ?? "").length > 0 && !sameRoot(config.cwd, config.workspaceRoot);
      if (drift) {
        const error = new Error(
          `WinStage \u6682\u5B58\u6587\u4EF6\u7CFB\u7EDF\uFF1A\u914D\u7F6E\u6F02\u79FB \u2014\u2014 workspaceRoot(${config.workspaceRoot}) \u4E0E cwd(${config.cwd}) \u5FC5\u987B\u6307\u5411\u540C\u4E00\u4E2A\u6682\u5B58\u6839\uFF0C\u5426\u5219"\u6682\u5B58\u5199\u5230 A\u3001\u5FEB\u7167\u53D1\u5E03\u5728 B"`
        );
        error.code = "FS_STAGE_ROOT_DRIFT";
        throw error;
      }
      this.workspaceRoot = canonical(config?.cwd || process.cwd());
      this.fixedSessionId = typeof options.sessionId === "string" && options.sessionId.length > 0 ? options.sessionId : void 0;
      this.sessionServices = /* @__PURE__ */ new Map();
      this.staging = this.stagingFor(void 0);
      this.unstagedLedgerDir = this.staging?.storeDir ?? this.staging?.workspace?.store?.dir;
      this.warnedUnstaged = /* @__PURE__ */ new Set();
      this.watchers = /* @__PURE__ */ new Set();
      this.readPolicy = options.readPolicy === "block" ? "block" : "record";
      this.warnedSplits = /* @__PURE__ */ new Set();
      this.log(
        `\u6682\u5B58\u6587\u4EF6\u7CFB\u7EDF\u5DF2\u6302\u8F7D\uFF1A\u5DE5\u4F5C\u533A = ${this.workspaceRoot}\uFF1B\u5B58\u50A8 = \u6309\u4F1A\u8BDD\u9694\u79BB\uFF08\u65E0\u4F1A\u8BDD\u65F6 .dshstage/ \u6839\uFF09\uFF1B\u5DE5\u4F5C\u533A\u5916\u5199\u5165 = ${stageOutside === "direct" ? "direct\uFF08\u663E\u5F0F\u9003\u751F\u53E3\uFF09" : "stage\uFF08\u8FDB\u6682\u5B58\uFF0C\u7B49\u6279\u51C6\uFF09"}`
      );
    }
    /**
     * 本次调用的**会话身份**（审批内容隔离的根）。按优先级：
     *   1. 构造时显式注入的 `sessionId`（装配/自测）；
     *   2. `sandboxPolicy.sessionId` —— 工具层按会话解析后**随每次写调用**传进来
     *      （dsh-sandbox-policy 的 resolve() 在带 session 时返回它）；
     *   3. **调用方 ctx 上的 ambient initiator**（`ctx.agents.currentInitiator()`）：
     *      agent loop 用 `withInitiator` 包住整轮驱动，所以 read/stat/listDir 这些
     *      **没有 policy 参数**的调用也能拿到身份。
     * 都拿不到 ⇒ `undefined` ⇒ 走共享存储（与升级前逐字一致）。
     */
    sessionIdOf(sandboxPolicy) {
      if (this.fixedSessionId) return this.fixedSessionId;
      if (sandboxPolicy && typeof sandboxPolicy.sessionId === "string" && sandboxPolicy.sessionId.length > 0) {
        return rootSessionIdFor(this.ctx, sandboxPolicy.sessionId) ?? sandboxPolicy.sessionId;
      }
      try {
        const agents = this.ctx && typeof this.ctx.get === "function" ? this.ctx.get("agents") : this.ctx?.agents;
        const session = agents?.currentInitiator?.();
        const id = session?.session?.id ?? session?.id;
        const agentSession = session?.session ?? session?.agent?.session ?? void 0;
        if (typeof id === "string" && id.length > 0) return rootSessionIdOf(this.ctx, agentSession ?? session) ?? id;
      } catch {
      }
      if (!this.warnedNoSession) {
        this.warnedNoSession = true;
        this.log(
          "\u62FF\u4E0D\u5230\u8C03\u7528\u65B9\u4F1A\u8BDD\u8EAB\u4EFD\uFF08sandboxPolicy.sessionId \u4E0E ctx.agents.currentInitiator() \u90FD\u4E0D\u53EF\u7528\uFF09\uFF1A\u672C\u6B21\u53D8\u66F4\u4F1A\u843D\u5728\u5171\u4EAB .dshstage/ \u5B58\u50A8\uFF1B\u4E0B\u4E00\u6B21\u5E26\u4F1A\u8BDD\u8EAB\u4EFD\u7684\u5199/\u547D\u4EE4\u4F1A\u81EA\u52A8\u628A\u5B83\u5E76\u5165\u4F1A\u8BDD\u5B58\u50A8\u3002"
        );
      }
      return void 0;
    }
    /**
     * 本次调用的**会话工作区根**（会话自己的 cwd）。
     * 写路径来自 `sandboxPolicy.workspaceRoot`（策略服务按会话 cwd 解析）；读路径没有 policy
     * 参数，改从 ambient initiator 的 `session.header.cwd` 取。
     * @returns {string|undefined} canonical 根；拿不到返回 undefined
     */
    sessionWorkspaceOf(sandboxPolicy) {
      if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === "string" && sandboxPolicy.workspaceRoot.length > 0) {
        try {
          return canonical(sandboxPolicy.workspaceRoot);
        } catch {
        }
      }
      try {
        const agents = this.ctx && typeof this.ctx.get === "function" ? this.ctx.get("agents") : this.ctx?.agents;
        const cwd = agents?.currentInitiator?.()?.session?.header?.cwd;
        if (typeof cwd === "string" && cwd.length > 0) return canonical(cwd);
      } catch {
      }
      return void 0;
    }
    /**
     * 本会话是否属于**插件配置的暂存根**。
     *
     * 不匹配时**绝不假装暂存**（那会让"写成功"回执与真实磁盘脱节，且内容进了一个
     * 该会话看不见的待审存储）：调用方改为直接 `super`（平台沙箱/审批面）。
     * 拿不到会话工作区（agentless 调用）时按"属于"处理，保持升级前行为。
     */
    inConfiguredWorkspace(sandboxPolicy) {
      const sessionRoot = this.sessionWorkspaceOf(sandboxPolicy);
      if (sessionRoot === void 0) return true;
      try {
        return sameRoot(sessionRoot, this.workspaceRoot);
      } catch {
        return true;
      }
    }
    /**
     * 不匹配时的**一次性**日志（每次调用都刷屏没有意义；但静默更糟）。
     */
    warnForeignWorkspace(sandboxPolicy) {
      if (this.warnedForeignWorkspace) return;
      this.warnedForeignWorkspace = true;
      this.logError(
        `\u4F1A\u8BDD\u5DE5\u4F5C\u533A\uFF08${this.sessionWorkspaceOf(sandboxPolicy) ?? "\u672A\u77E5"}\uFF09\u4E0E WinStage \u914D\u7F6E\u7684\u6682\u5B58\u6839\uFF08${this.workspaceRoot}\uFF09\u4E0D\u540C\uFF1A\u672C\u4F1A\u8BDD\u7684\u5199\u5165**\u4ECD\u7136\u8FDB\u6682\u5B58**\uFF08\u6682\u5B58\u4F18\u5148\uFF0CR12 D7-a \u4FEE\u590D\uFF09\uFF0C\u5E76\u4F1A\u8BB0\u4E00\u6761"\u914D\u7F6E\u6839\u4E0D\u4E00\u81F4"\u7684\u8D26\u5230 review.json \u7684 unstaged \u6BB5\u3002`
      );
    }
    /**
     * R12 修复 · D7-a：**"本次操作没有走暂存"必须落账，绝不静默**。
     *
     * 落点选择（为什么是账本文件而不是只打日志）：
     *   · 日志只有读宿主日志的人看得到；R11 D7-a 的实测结论正是"**界面与审计零提示**"；
     *   · 账本写在**与 `review.json` 同一个存储根**，`ReviewService.publish()` 会把
     *     它并进快照的 `unstaged` 段 ⇒ 面板/审计/复核者都必然看得到。
     *
     * 本方法**绝不抛**（记账失败不能把一次正常写入变成失败），失败只走 error 日志。
     *
     * @returns {{reason:string, path:string, appliedToDisk:boolean}|undefined}
     */
    noteUnstaged(op, path, reason, extras = {}) {
      const display = String(path ?? "");
      const record = recordUnstaged(
        this.unstagedLedgerDir,
        {
          op,
          path: display,
          reason,
          appliedToDisk: extras.appliedToDisk === true,
          physical: extras.physical,
          sessionId: extras.sessionId
        },
        { onError: (message) => this.logError(message) }
      );
      const key = `${op}\0${reason}`;
      if (!this.warnedUnstaged.has(key)) {
        this.warnedUnstaged.add(key);
        this.logError(
          `\u672C\u6B21 ${op} **\u6CA1\u6709\u8D70\u6682\u5B58**\uFF08\u539F\u56E0 ${reason}\uFF09\uFF1A"${display}" ${extras.appliedToDisk === true ? "\u5DF2\u76F4\u63A5\u843D\u5230\u771F\u5B9E\u78C1\u76D8" : "\u843D\u5728\u5E73\u53F0\u9762"}${extras.physical ? `\uFF08\u7269\u7406\u843D\u70B9 ${extras.physical}\uFF09` : ""}\u3002\u8BE5\u52A8\u4F5C\u4E0D\u4F1A\u51FA\u73B0\u5728\u5F85\u5BA1\u9762\u677F\u91CC\uFF0C\u4E5F\u65E0\u6CD5\u88AB\u62D2\u7EDD \u2014\u2014 \u8FD9\u6761\u4E8B\u5B9E\u5DF2\u8BB0\u5165 review.json \u7684 unstaged \u6BB5\u3002`
        );
      }
      return record ? { reason, path: display, appliedToDisk: record.appliedToDisk } : void 0;
    }
    /**
     * 会话工作区与配置暂存根不一致时的处理（R12 修复 · D7-a 第 ① 条：**暂存优先**）。
     *
     * ── 为什么改掉旧的"直接 `super.*`"（本次修复的核心决定）──────────────────────
     * 旧实现：`inConfiguredWorkspace()` 为假 ⇒ 立刻 `return super.writeText(...)`。
     * 后果（R11 D7-a 实测）：写入**绕过暂存**、不进 `manifest.json`、不进 `staged\`、
     * 不进待审面板，**却真实落到磁盘**，而界面与审计零提示 ——
     * 一个**配置问题**（暂存根与会话工作区不一致）被翻译成了**隔离悄悄失效**。
     *
     * 现在的口径：**仍然进暂存**，另记一条 `foreign-session-workspace` 的账。
     * 于是"工具说写成功"与"真实磁盘未变"始终一致，面板也一定看得见这条。
     */
    stageOverForeignWorkspace(op, target, sandboxPolicy) {
      const sessionRoot = this.sessionWorkspaceOf(sandboxPolicy);
      this.warnForeignWorkspace(sandboxPolicy);
      this.noteUnstaged(op, target?.displayPath ?? target?.targetKey, UNSTAGED_REASONS.FOREIGN_WORKSPACE, {
        sessionId: this.sessionIdOf(sandboxPolicy),
        physical: sessionRoot
      });
    }
    /** 会话身份 → 该会话自己的审阅服务（缓存；`undefined` ⇒ 共享存储） */
    stagingFor(sessionId) {
      const key = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : "";
      let service = this.sessionServices.get(key);
      if (!service) {
        const self = this;
        service = getReviewService({
          workspaceRoot: this.workspaceRoot,
          ...key ? { sessionId: key } : {},
          // T3d：只有"本行此刻接管"时才允许认领共享存储里的条目；关闭态一律不认领。
          // （写路径上还有一次显式 `absorbSharedStore()`，在 `!stagingEnabled()` 早退**之后**，
          //   所以关闭态的写既不走暂存也不会认领。）
          claimShared: this.stagingEnabled(),
          ...this.logger ? { logger: this.logger } : {},
          /**
           * R12 修复 · D7-b/d：把**生效值**注入审阅服务（与 `stagingEnabled()` 同一处真值）。
           *
           * 这是 `effectiveStagingHint` 的唯一生产来源：`snapshot()` 拿它写出
           * `staging.{effective, mismatch}`，界面因此不会再把"配置值"当成"生效值"。
           * 用 getter 而不是一个固定布尔：开关是**每次现读**的（见 `stagingEnabled()` 注释），
           * 注入快照值会把"热切换"变成"要重启"。
           */
          get effectiveStaging() {
            return { enabled: self.stagingEnabled() };
          }
        });
        this.sessionServices.set(key, service);
      }
      return service;
    }
    /**
     * 本行此刻是否应当接管变更面 —— **开关的唯一真源**。
     *
     * 读的是 loader 行 `winstage-sandbox`（设置页那一行）的 `config.enabled`，而且
     * **每次调用都现读**：`rootEntry.parent.data` 是 patch 组合后的那一份，设置改动走
     * configEditor → reconcileProfilePatches → `EntryGroup.update()` 会把整份换新
     * （`parent` 这个 EntryGroup 对象本身不变，只有它的 `data` 被换）。
     * 因此"关掉/打开"即时生效，且**不需要卸载或重挂任何行**；命令面与面板也按
     * 同一个开关现读，所以三处不会漂移。
     *
     * 树里找不到该行（离线自测、行被移除）时默认 `true`：保持"接管"这一历史行为。
     */
    stagingEnabled() {
      const enabled = this.stagingEnabledRaw();
      try {
        noteEffectiveStaging(this.workspaceRoot, enabled);
      } catch {
      }
      return enabled;
    }
    /** `stagingEnabled()` 的原始判定（登记逻辑见上面的包装） */
    stagingEnabledRaw() {
      if (enabledOverride) return enabledOverride() !== false;
      try {
        const data = (this.rootEntry ?? this.ctx?.fiber?.entry)?.parent?.data;
        if (!Array.isArray(data)) return true;
        const row = data.find((item) => item && item.id === "winstage-sandbox");
        if (!row || !row.config) return true;
        return row.config.enabled !== false;
      } catch {
        return true;
      }
    }
    /**
     * 围栏能力**只跟着开关的面走**：
     *   - 开启（暂存面）：报 `undefined`，`dsh-tool-fs` 就不向模型广告
     *     `sandbox_permissions` —— 升权了变更也仍进暂存，广告它只会失真；
     *   - 关闭（平台面）：报平台后端自己的默认模式（`super.sandboxMode`），
     *     于是 `[sandbox: …]` 拒绝与同回合升权提示都与"没装本插件"逐字一致。
     */
    get sandboxMode() {
      if (this.stagingEnabled()) return void 0;
      return super.sandboxMode;
    }
    // ==================== 暂存落点：命名空间互见 + 原子 mkdir + 回读闸门 ====================
    //
    // 这一节是 BUG-1 / BUG-2 / BUG-8 的修复面，三条口径写在这里、不要在别处另立一套：
    //   ① **不静默**：任何暂存写入都要**回读**确认产物真的存在且内容一致，才允许返回成功
    //      （`verifyPersistedWrite()` → `staging_write_not_persisted`）；
    //   ② **互见**：读取时清单落点与 shim/shell 落点**两边都看**；写入归一到清单落点；
    //      两边同时存在且指向同一逻辑目标时，给一条可见告警并把真实落点写进写入回执
    //      （`shimContentOf()` / `locationReceipt()` / `warnSplitOnce()`）；
    //   ③ **原子**：多级目录逐层创建、逐层回读，失败回滚并点名**具体哪一层**
    //      （`ensureStagedParentsAtomic()` → `staging_mkdir_failed`）。
    /** shim/shell 布局的存储根（= `Store.stagedDir`；`fs/` 与 `wo/` 就挂在它下面） */
    stagedDirOf(ws) {
      const dir = ws?.store?.stagedDir;
      return typeof dir === "string" && dir.length > 0 ? dir : void 0;
    }
    /** 本插件通道里该清单键的物化落点（`staged/<rel>` 或 `staged-ext/<分桶>/<叶名>`） */
    stagedPathOf(ws, key) {
      try {
        return ws.store.stagedPath(key);
      } catch {
        return void 0;
      }
    }
    /** 同一逻辑目标在 shim/shell 通道里的物理落点（内容树） */
    shimMirrorOf(ws, abs) {
      return shimLayoutPathOf(this.stagedDirOf(ws), abs, SHIM_FS_LEAF);
    }
    /**
     * **读取时两边都看**（BUG-2）：清单/`staged/<rel>` 之外，再看 shim/shell 通道的
     * `<staged>\fs\<盘符>\<绝对路径>`；命中就返回与 `currentOf()` 同形状的结果。
     *
     * `version` 是内容的稳定函数（`winstage:shimfs:<sha256>`）：同一内容永远同一版本，
     * 满足 `dsh-tool-fs` 的观测契约（与文件头契约 ① 同一条）。
     * 内容树里没有、但 `wo\` 有删除标记 ⇒ 按**已删除**处理（`workspace.ts` 同口径）。
     */
    shimContentOf(ws, target, abs) {
      const mirror = this.shimMirrorOf(ws, abs);
      if (mirror === void 0) return void 0;
      let info;
      try {
        info = statSync(mirror);
      } catch {
        return void 0;
      }
      if (info.isDirectory()) {
        return {
          exists: true,
          kind: "dir",
          version: `winstage:shimfs:dir:${String(abs).toLowerCase()}`,
          layout: "shim-fs",
          physical: mirror
        };
      }
      if (!info.isFile()) return void 0;
      let buffer;
      try {
        buffer = readFileSync(mirror);
      } catch {
        return void 0;
      }
      const hash = sha256Of(buffer);
      return {
        exists: true,
        kind: "file",
        text: buffer.toString("utf8"),
        version: `winstage:shimfs:${hash}`,
        hash,
        layout: "shim-fs",
        physical: mirror
      };
    }
    /** shim/shell 通道的删除标记（`<staged>\wo\<盘符>\<绝对路径>`）；没有返回 `undefined` */
    shimWhiteoutOf(ws, abs) {
      const marker = shimLayoutPathOf(this.stagedDirOf(ws), abs, SHIM_WHITEOUT_LEAF);
      if (marker === void 0) return void 0;
      try {
        return statSync(marker).isFile() ? marker : void 0;
      } catch {
        return void 0;
      }
    }
    /**
     * 该清单键在两套布局里**有没有本插件可见的内容**：清单里有**构成净变化的**条目，
     * 或 shim/shell 通道的落点存在，或 shim 的删除标记存在。
     *
     * 读取面据此决定"要不要走暂存投影"。判据必须是 `hasEntry()`（净变化）而不是
     * "条目存在"：后者的语义是"这条已经被批准过、磁盘就是真值"，那样会让
     * `readText` 绕过基线后端的二进制/解码校验（返回空串而不是抛错）。
     */
    hasStagedContent(ws, key, abs) {
      if (this.hasEntry(ws, key)) return true;
      const mirror = this.shimMirrorOf(ws, abs);
      if (mirror !== void 0) {
        try {
          if (existsSync(mirror)) return true;
        } catch {
        }
      }
      return this.shimWhiteoutOf(ws, abs) !== void 0;
    }
    /**
     * shim 布局里某个目录的**直接子项**（`listDir` 合并用）。
     *
     * 返回 `{ entries, deleted }`：`deleted` 是被 `wo\` 标记删除的子项名（小写）——
     * 调用方据此**压掉**真实磁盘/清单里的同名项，"删除"这一逻辑状态才不会被宿主一侧复活。
     * 目录不存在 ⇒ `undefined`（调用方按"该布局没有这个目录"处理）。
     */
    shimChildrenOf(ws, shimDir) {
      if (shimDir === void 0) return void 0;
      const stagedDir = this.stagedDirOf(ws);
      let dirents;
      try {
        dirents = readdirSync(shimDir, { withFileTypes: true });
      } catch {
        return void 0;
      }
      const entries = [];
      const deleted = /* @__PURE__ */ new Set();
      for (const dirent of dirents) {
        const childDir = join(shimDir, dirent.name);
        const childAbs = logicalFromShimLayout(stagedDir, childDir, SHIM_FS_LEAF);
        if (childAbs === void 0) continue;
        let target;
        try {
          target = { targetKey: FsTargetKey(canonical(childAbs)), displayPath: childAbs };
        } catch {
          continue;
        }
        if (this.shimWhiteoutOf(ws, childAbs) !== void 0) {
          deleted.add(dirent.name.toLowerCase());
          continue;
        }
        if (dirent.isDirectory()) {
          entries.push({ name: dirent.name, type: "directory", target });
          continue;
        }
        if (!dirent.isFile()) continue;
        let size;
        let version;
        try {
          const info = statSync(childDir);
          size = info.size;
          version = FsVersion(`winstage:shimfs:${sha256Of(readFileSync(childDir))}`);
        } catch {
          continue;
        }
        entries.push({ name: dirent.name, type: "file", target, version, size });
      }
      return { entries, deleted };
    }
    /**
     * ★ R11-D（`readdir` vs `stat` 一致性）：`wo\` 布局里某个**逻辑目录**的直接子项删除标记。
     *
     * 为什么必须单独有它：`shimChildrenOf()` 只能**从内容树 `fs\` 出发**发现删除标记
     * （`staged\fs\<盘符>\<绝对路径>` 的每个子项再看它有没有同名 `wo\` 标记）。于是当
     * **真实磁盘上的文件被删除、而内容树里没有它的对应项**时（这是删除的常见形态：
     * 目标本来只存在于真实盘），`shimChildrenOf()` 返回的 `deleted` 永远是空集，
     * 更糟的是内容目录 `fs\...\<dir>` 根本不存在 ⇒ 它返回 `undefined` ⇒
     * `listDirInner()` 直接早退回 `super.listDir()`，**整棵 `wo\` 树被忽略**。
     *
     * 实测形态（`.t/round10/fileio/toolface-consistency.ts` 的 C6/C7）：
     *   · `listDir(dir)` **列着** `realdel.txt`（真实盘那一侧给出来的）；
     *   · `stat(realdel.txt)` 返回**不存在**（`currentOf()` 走 `shimWhiteoutOf()`）。
     *   ⇒ 同一目录上 `readdir` 与 `stat` **自相矛盾**（与 `exe` 域 D-EXE-6 同形）。
     *
     * 判据与 `currentOf()` 的 `shimWhiteoutOf()` **同一棵树、同一个口径**：`wo\` 镜像
     * 逻辑目录结构，其下的每个直接子项名 = 该子项被逻辑删除。目录自身被标记删除时
     * 返回空集与 `selfDeleted: true`，调用方据此返回空列表（与 `stat` 的"不存在"一致）。
     */
    shimDeletionsOf(ws, dirAbs) {
      const stagedDir = this.stagedDirOf(ws);
      const woDir = shimLayoutPathOf(stagedDir, dirAbs, SHIM_WHITEOUT_LEAF);
      if (woDir === void 0) return void 0;
      let dirents;
      try {
        dirents = readdirSync(woDir, { withFileTypes: true });
      } catch {
        return void 0;
      }
      const deleted = /* @__PURE__ */ new Set();
      for (const dirent of dirents) deleted.add(dirent.name.toLowerCase());
      return { deleted, selfDeleted: this.shimWhiteoutOf(ws, dirAbs) !== void 0 };
    }
    /**
     * ★ **BUG-8：多级目录原子化 + 逐层回读**。
     *
     * 现场（3081 `session-d6e30323` FS-03，原始输出见 `_r3\bugc-evidence-final.txt`）：
     * `New-Item -Force` 建 8 层深目录，只有最深两层报 `…is denied`，a–f 层**一句报错都没有**，
     * 而暂存树里一个目录都没落下（`staged_exists=False`、`deep_depth_ok=False`）——
     * "报成功但产物不存在"的目录版。
     *
     * 这里把"建目录"从 `mkdirSync(recursive:true)`（只有一次成败、失败还说不出是哪一层）
     * 换成**逐层非递归 + 每层立刻回读**：
     *   · 任一层失败 ⇒ 把**本次调用新建的层**按深度倒序回滚（不留半成品），
     *     再抛 `staging_mkdir_failed`：`error.level` = 失败的那一层（**具体到层**）、
     *     `error.createdLevels` / `error.rollback` = 建了哪些、回滚结果；
     *   · 每层建完**立刻** `statSync().isDirectory()` 复核 —— "mkdir 没抛错"不算成功证据。
     *
     * @param {string} stagedParent 物化对象的**父目录**（`dirname(stagedPath)`）
     * @param {string} stagedPath 物化对象本身（只用于报错时给出完整落点）
     */
    ensureStagedParentsAtomic(stagedParent, stagedPath) {
      if (typeof stagedParent !== "string" || stagedParent.length === 0) return { created: [], levels: 0 };
      const missing = [];
      let cursor = stagedParent;
      while (typeof cursor === "string" && cursor.length > 0) {
        let isDir = false;
        try {
          isDir = statSync(cursor).isDirectory();
        } catch {
          isDir = false;
        }
        if (isDir) break;
        missing.push(cursor);
        const parent = dirname(cursor);
        if (parent === cursor || parent.length === 0) break;
        cursor = parent;
      }
      missing.reverse();
      const created = [];
      const rollback = [];
      const fail = (level, error) => {
        for (const done of [...created].reverse()) {
          try {
            rmdirSync(done);
          } catch (cleanupError) {
            rollback.push({ path: done, code: cleanupError.code, message: cleanupError.message });
          }
        }
        const detail = [error?.code, error?.message].filter(Boolean).join(": ");
        this.logError(
          `\u6682\u5B58\u76EE\u5F55\u521B\u5EFA\u5931\u8D25\uFF08BUG-8\uFF09\uFF1A${level ?? stagedPath} \u2014\u2014 ${detail || "\u672A\u77E5\u9519\u8BEF"}\uFF08\u672C\u6B21\u65B0\u5EFA ${created.length} \u5C42\uFF0C\u5DF2\u56DE\u6EDA ${created.length - rollback.length} \u5C42\uFF09`
        );
        const failure = new FsError(
          `cannot create the staging directory for "${stagedPath}": failed at level "${level}"${detail ? ` (${detail})` : ""} \u2014 ${created.length} level(s) created by this call were rolled back; nothing was staged.`,
          "staging_mkdir_failed"
        );
        failure.level = level;
        failure.stagedPath = stagedPath;
        failure.createdLevels = [...created];
        failure.rollback = rollback;
        failure.cause = error;
        throw failure;
      };
      for (const level of missing) {
        let alreadyDir = false;
        try {
          alreadyDir = statSync(level).isDirectory();
        } catch {
          alreadyDir = false;
        }
        if (!alreadyDir) {
          try {
            mkdirSync(level);
          } catch (error) {
            if (error.code !== "EEXIST") return fail(level, error);
          }
        }
        let verified = false;
        try {
          verified = statSync(level).isDirectory();
        } catch {
          verified = false;
        }
        if (!verified) {
          return fail(level, Object.assign(new Error("mkdir reported success but the directory is not there"), { code: "EPERSIST" }));
        }
        if (!created.includes(level)) created.push(level);
      }
      return { created, levels: missing.length };
    }
    /**
     * ★ **BUG-1 的闸门：只有回读证明产物真的存在且内容一致，才允许返回成功**。
     *
     * 三条独立判据（缺一不可）：
     *   ① 清单条目声明的 `stagedHash` == 提交内容的 sha256；且**磁盘上的 `manifest.json`**
     *      里也是同一个 hash（"本进程内存里自洽"不算证据，新进程读的是磁盘那一份）；
     *   ② 内容对象 blob 在磁盘上、且**逐字节等于**提交内容 —— `Store.putBlob()` 对已存在的
     *      `<blobs>/<aa>/<hash>` 是**信任式**的（只看路径在不在，不校验内容），
     *      这正是"进程内自洽、落盘不一致"能成立的那条缝；
     *   ③ 物化暂存对象（`staged/<rel>` 或 `staged-ext/<分桶>/<叶名>`）存在、是普通文件、
     *      逐字节相等 —— 3079/3081 实测 BUG-1 的形态正是 `staged_exists=False`。
     *
     * 任一不成立 ⇒ 抛 `staging_write_not_persisted`（**不是**返回成功，也**不是**返回一个
     * "看起来对"的 version），同时留一条 error 级日志与清单上的 `persistenceFailure` 记账。
     */
    verifyPersistedWrite({ ws, key, abs, buffer, displayPath }) {
      const entry = ws.entryOf(key);
      const hash = sha256Of(buffer);
      const stagedPath = this.stagedPathOf(ws, key);
      const problems = [];
      const fail = (reason, detail) => {
        problems.push({ check: reason, ...detail ? { detail } : {} });
      };
      if (!entry) fail("manifest-entry-missing", `no manifest entry for "${key}"`);
      else {
        if (entry.state !== STATE.FILE) fail("manifest-entry-not-a-file", `state=${entry.state} (expected ${STATE.FILE})`);
        if (entry.kind !== "file") fail("manifest-entry-kind", `kind=${entry.kind}`);
        if (entry.stagedHash !== hash) fail("manifest-hash-mismatch", `stagedHash=${entry.stagedHash} expected=${hash}`);
      }
      let blobBytes;
      try {
        if (!ws.store.hasBlob(hash)) fail("blob-missing", `no blob at ${ws.store.blobPath(hash)}`);
        else {
          blobBytes = ws.store.readBlob(hash);
          if (!blobBytes.equals(buffer)) {
            fail("blob-content-mismatch", `${blobBytes.length} bytes on disk vs ${buffer.length} submitted`);
          }
        }
      } catch (error) {
        fail("blob-unreadable", `${error?.code ?? ""} ${error?.message ?? error}`.trim());
      }
      try {
        const info = statSync(stagedPath);
        if (!info.isFile()) fail("staged-object-not-a-regular-file", `type at ${stagedPath}`);
        else {
          const onDisk = readFileSync(stagedPath);
          if (!onDisk.equals(buffer)) {
            fail("staged-object-content-mismatch", `${onDisk.length} bytes at ${stagedPath} vs ${buffer.length} submitted`);
          }
        }
      } catch (error) {
        fail("staged-object-missing", `${error?.code ?? ""} at ${stagedPath}`.trim());
      }
      try {
        const raw = JSON.parse(readFileSync(ws.store.manifestPath, "utf8"));
        const persisted = raw?.entries?.[key];
        if (!persisted) fail("manifest-not-persisted", `no entry for "${key}" in ${ws.store.manifestPath}`);
        else if (persisted.stagedHash !== hash) {
          fail("manifest-persisted-hash-mismatch", `${persisted.stagedHash} on disk vs ${hash} submitted`);
        }
      } catch (error) {
        fail("manifest-unreadable", `${error?.code ?? ""} ${error?.message ?? error}`.trim());
      }
      if (problems.length === 0) return { hash, stagedPath, verified: true };
      const summary = problems.map((item) => `${item.check}${item.detail ? ` (${item.detail})` : ""}`).join("; ");
      this.logError(
        `\u6682\u5B58\u5199\u5165**\u6CA1\u6709**\u6301\u4E45\u5316\uFF08BUG-1\uFF09\uFF1A"${displayPath}" \u2192 ${stagedPath} \u2014\u2014 ${summary}\u3002\u672C\u6B21\u5199\u5165\u4E0D\u8FD4\u56DE\u6210\u529F\u3002`
      );
      if (entry) {
        entry.persistenceFailure = { at: (/* @__PURE__ */ new Date()).toISOString(), hash, stagedPath, problems };
        try {
          ws.store.touch(ws.manifest);
        } catch {
        }
      }
      const failure = new FsError(
        // ★ WP2 透明性：这句话是**模型可见**的 ⇒ 零机制字样（不出现 staging/stage/暂存/
        //   替代路径/overlay），也**不回显**暂存落点。诊断细节一律挂下面的非 message 属性，
        //   完整原因进 `logError`（人工侧）。自检见 `assertTransparentFailureTexts()`。
        MODEL_VISIBLE_FAILURE_TEXTS.writeNotPersisted(displayPath),
        "staging_write_not_persisted"
      );
      failure.stagedPath = stagedPath;
      failure.expectedHash = hash;
      failure.problems = problems;
      throw failure;
    }
    /** 分裂告警：同一逻辑目标在两套布局里都有落点时，报**一条**（不刷屏、也不静默） */
    warnSplitOnce(abs, stagedPath, foreign) {
      const key = String(abs).toLowerCase();
      if (this.warnedSplits.size > 200) this.warnedSplits.clear();
      if (this.warnedSplits.has(key)) return;
      this.warnedSplits.add(key);
      this.logError(
        `\u6682\u5B58\u843D\u70B9\u5206\u88C2\uFF08BUG-2\uFF09\uFF1A\u540C\u4E00\u903B\u8F91\u76EE\u6807 ${abs} \u540C\u65F6\u5B58\u5728\u4E8E\u4E24\u5957\u4E92\u4E0D\u53EF\u89C1\u7684\u5E03\u5C40 \u2014\u2014 \u672C\u63D2\u4EF6\u843D\u70B9 ${stagedPath}\uFF08\u672C\u6B21\u5199\u5165\u5DF2\u5F52\u4E00\u5230\u8FD9\u91CC\uFF0C\u8BFB\u53D6\u65F6\u4E24\u8FB9\u90FD\u770B\uFF09\uFF1Bshim/shell \u901A\u9053\u843D\u70B9 ${foreign}\u3002\u6E05\u5355/\u5BA1\u6279/\u5FEB\u7167\u53EA\u8BA4\u524D\u8005\uFF0C\u540E\u8005\u4E0D\u4F1A\u88AB\u81EA\u52A8\u6E05\u7406\u3002`
      );
    }
    /**
     * 写入回执（WP9 之后：**可见的那一段**只带真实工作区路径）。
     *
     * 历史（BUG-2）要求"把真实落点写进写入回执"，当时的做法是把
     * `layout`（`staged` / `staged-ext`）与 `stagedPath`（暂存根下的物理落点）
     * 直接塞进 `writeText` 的返回对象。实证结论见本文件 WP9 段：
     * `dsh-tool-fs` 只取 `operation`/`version`/`before`/`after`，**不渲染**这些键 ——
     * 但它们是"一次展开或 JSON 化就到模型"的形状（`staged` / `staged-ext` / `.dshstage`
     * 全在里面）。因此：
     *   · 可见面只留 `logicalPath`（= 真实工作区绝对路径，模型本就该看到它）；
     *   · 真实落点 / 第二套布局 / 分裂标记全部走 `STAGE_DIAGNOSTICS` 非枚举旁路
     *     （见 `attachStageDiagnostics()`），人工侧与自测用 `stageDiagnosticsOf()` 读。
     */
    locationReceipt(ws, key, abs, current) {
      return { logicalPath: abs };
    }
    /** 真实落点诊断（**非模型可见**；BUG-2 的 `stagedPath` / `otherLayout` / `splitDetected`） */
    locationDiagnostics(ws, key, abs, current) {
      const stagedPath = this.stagedPathOf(ws, key);
      const diagnostics = {
        layout: isExternalKey(key) ? "staged-ext" : "staged",
        stagedPath,
        logicalPath: abs
      };
      if (isExternalKey(key)) {
        diagnostics.outsideWorkspace = true;
        diagnostics.stageOutside = stageOutside;
        diagnostics.appliedToDisk = stageOutside === "direct";
        diagnostics.pendingApproval = stageOutside !== "direct";
      }
      const mirror = this.shimMirrorOf(ws, abs);
      let foreign = current && current.layout === "shim-fs" ? current.physical : void 0;
      if (foreign === void 0 && mirror !== void 0) {
        try {
          if (existsSync(mirror)) foreign = mirror;
        } catch {
          foreign = void 0;
        }
      }
      if (foreign !== void 0) {
        diagnostics.otherLayout = { layout: "shim-fs", path: foreign };
        diagnostics.splitDetected = true;
        this.warnSplitOnce(abs, stagedPath, foreign);
      }
      return diagnostics;
    }
    // ==================== 路径映射 ====================
    /**
     * `FsTarget` → **清单键**（S3a）。
     *
     *   工作区**内** → `{ key: <相对路径>, external: false, abs }`（根为 `''`）
     *   工作区**外** → `{ key: <规范化绝对路径>, external: true, abs }`
     *
     * 根返回 `''` 而不是 `undefined` 是**必须**的：根自身不参与暂存（写根会报错），
     * 但根的**目录枚举**必须合并暂存子项 —— 早期版本在这里返回 `undefined`，
     * 导致"只在暂存里存在的新目录"在根枚举中消失（自测抓到）。
     *
     * 外部键用**绝对路径**（与 `src/workspace.ts` 的 `keyOf()` 同一模型），
     * 因此 `entryOf()` 对两种条目是同一个查找，键空间天然不相交。
     */
    /**
     * P0-8：**经 `ctx.fs` 的存储写入一律拒绝**（"失败必须响"）。
     *
     * 抛 `FsError` + `FS_SANDBOX_DENIED`：`dsh-tool-fs` 的 `mapError()`（实测
     * `dsh-tool-fs/lib/index.js:1159-1163`）会把**这条 message 整体换成**平台的
     * `[sandbox: <mode>]` 拒绝标记 + 同回合升权提示 —— 也就是说模型看到的是平台那套
     * 原生拒绝文案（与"没装本插件"逐字一致），本函数的 message 只进日志/`cause`。
     * 因此这里的话术只需对**人工侧**负责：不含暂存/机制行话，也不假装是策略边界。
     */
    denyStoreWrite(place, verb) {
      const target = String(place?.abs ?? "");
      this.logError(`P0-8 refused to ${verb} WinStage's own store: ${target}`);
      throw new FsError(
        MODEL_VISIBLE_FAILURE_TEXTS.storeWriteDenied(target),
        "FS_SANDBOX_DENIED"
      );
    }
    /**
     * `stageOutside: 'deny'`：工作区外写入的**显式拒绝**（opt-in，默认仍是 `'stage'`）。
     *
     * 语义与"暂存"档的区别，只在这两件事上：
     *   · 不产生任何条目/候选（真实盘与暂存树**都不动**）；
     *   · 抛 `FS_SANDBOX_DENIED`，模型面看到一条失败回执。
     *
     * 为什么文案按"普通失败"口径写：`dsh-tool-fs` 的 `mapError()` 只在
     * `error.code === 'FS_SANDBOX_DENIED'` 时把 message 换成平台 `[sandbox: <mode>]`
     * 标记 + 同回合升权提示。**本插件的暂存面 `sandboxMode` 返回 `undefined`**
     * ⇒ 该组合下 `FsSandboxController.policy === undefined`（`escalationModes === []`），
     * 实测（`evidence/fix/probe-store-deny/`，经同一 `denyStoreWrite` 通道）模型看到的
     * 是**本插件自己的文案**，既没有标记、也没有崩（读码上 `mapError` 会读
     * `policy.mode`，但该分支实测未被走到）。因此这里的话术必须自己就诚实、可读，
     * 不能指望平台标记兜底。
     */
    denyOutsideWrite(place, verb) {
      const target = String(place?.abs ?? "");
      this.logError(
        `stageOutside='deny' refused to ${verb} outside the workspace: ${target}\uFF08\u672A\u5199\u771F\u5B9E\u78C1\u76D8\u3001\u672A\u4EA7\u751F\u6761\u76EE/\u5019\u9009\uFF09`
      );
      throw new FsError(MODEL_VISIBLE_FAILURE_TEXTS.outsideWriteDenied(target), "FS_SANDBOX_DENIED");
    }
    keyOf(target) {
      try {
        const abs = canonical(target.targetKey);
        const root = this.workspaceRoot;
        const rel = relative(root, abs);
        if (rel === "") return { key: "", external: false, abs: root };
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { key: abs, external: true, abs };
        return { key: rel, external: false, abs };
      } catch {
        return void 0;
      }
    }
    entryOf(ws, rel) {
      return ws.entryOf(rel);
    }
    /**
     * 该路径是否存在**构成净变化的**暂存条目。
     *
     * 不再是"清单里有条目就算"：批准过的条目**不会**从清单里消失 —— `applyOneChange()`
     * 只是把 `baseHash = stagedHash` 标记为"已是新基线"（src/workspace.ts:1002-1015）。
     * 此后真实文件若被外部改过，暂存 blob 仍是**批准当时**的旧内容；继续遮蔽真实磁盘就会
     * 让用户看到"净 diff 是空的、read 却是陈旧内容" —— 那正是面板那句"已不在当前净 diff：
     * 暂存内容已被取代，无法再批准"不可见的那一半。
     */
    hasEntry(ws, rel) {
      return this.projectsEntry(ws.entryOf(rel));
    }
    /**
     * 该暂存条目是否构成**净变化** —— 只有净变化才允许遮蔽真实磁盘。
     *
     * 判据与 `src/workspace.ts:780 diffEntries()` **逐条对齐**（同一个仓库不能有两套
     * "什么算变化"的口径）：删除类看真实基线是否曾经存在、目录类只看**非合成**的 mkdir、
     * 文件类看 `stagedHash !== baseHash`。
     */
    projectsEntry(entry) {
      if (!entry) return false;
      if (entry.state === STATE.DELETED) {
        return !(entry.baseHash === hashAbsent() && entry.baseKind === void 0);
      }
      if (entry.kind === "dir") return entry.baseKind !== "dir" && entry.synthetic !== true;
      return entry.stagedHash !== entry.baseHash;
    }
    /**
     * 该目录下（含自身）是否有暂存条目；根（`''`）表示"暂存树里是否有工作区内条目"。
     * 键空间隔离：列工作区内目录时不把外部条目算进来（反之亦然）——
     * 否则 `C:\out` 会被当成工作区根的直接子项（`c:`）混进根枚举。
     */
    hasEntryUnder(ws, rel) {
      const external = isExternalKey(rel);
      const inSpace = (entry) => entry.external === true === external;
      const projects = (entry) => this.projectsEntry(entry);
      if (rel === "") {
        return Object.values(ws.manifest.entries).some((entry) => entry.external !== true && projects(entry));
      }
      if (this.hasEntry(ws, rel)) return true;
      const prefix = `${rel}${sep}`.toLowerCase();
      return Object.entries(ws.manifest.entries).some(
        ([key, entry]) => inSpace(entry) && projects(entry) && key.toLowerCase().startsWith(prefix)
      );
    }
    /** 变更前把该会话的 Workspace 重建成最新（另一进程/会话可能刚改过） */
    reloaded(service) {
      service.reload();
      return service.workspace;
    }
    // ==================== 变更面 ====================
    /**
     * 把"根丢了 / 守卫不可用"归一成**可重试的环境类普通失败**（WP2 口径④）。
     *
     * 其余错误**原样抛出**（绝不吞、绝不改写 `code`）：平台沙箱的 `FS_SANDBOX_DENIED`、
     * 回读闸门的 `staging_write_not_persisted`、陈旧版本 … 各自的语义各有归属。
     */
    mapStageFailure(error, displayPath) {
      if (!isStageLossError(error)) return error;
      this.logError(
        `\u4F1A\u8BDD\u5DE5\u4F5C\u6839\u4E0D\u53EF\u7528\uFF08code=${error.code}\uFF0Creason=${error.reason ?? "n/a"}\uFF0Croot=${error.root ?? "n/a"}\uFF09\uFF1A"${displayPath}" \u7684\u672C\u6B21\u64CD\u4F5C**\u6CA1\u6709**\u5B8C\u6210\uFF0C\u6309\u53EF\u91CD\u8BD5\u7684\u73AF\u5883\u7C7B\u5931\u8D25\u4E0A\u62A5\uFF1B\u673A\u5236\u7EC6\u8282\u53EA\u5728\u8FD9\u4E00\u884C\u65E5\u5FD7\u91CC\u51FA\u73B0\u3002`
      );
      const failure = new FsError(
        MODEL_VISIBLE_FAILURE_TEXTS.environmentRetryable(displayPath),
        ENV_FAULT_RETRYABLE
      );
      failure.category = FAILURE_SEMANTICS.ENVIRONMENT;
      failure.retryable = true;
      failure.classification = "environment-fault";
      failure.technicalCode = error.code;
      failure.reason = error.reason;
      failure.root = error.root;
      failure.detail = error.message;
      return failure;
    }
    /** 统一的"环境类失败映射"外壳（八个模型可见入口共用同一份判定，不各写一遍） */
    async withStageFailureMap(displayPath, run) {
      try {
        return await run();
      } catch (error) {
        throw this.mapStageFailure(error, displayPath ?? "unknown");
      }
    }
    async writeText(target, content, expected, signal, sandboxPolicy) {
      return this.withStageFailureMap(
        target?.displayPath ?? target?.targetKey,
        () => this.writeTextStaged(target, content, expected, signal, sandboxPolicy)
      );
    }
    async writeTextStaged(target, content, expected, signal, sandboxPolicy) {
      if (!this.stagingEnabled()) return super.writeText(target, content, expected, signal, sandboxPolicy);
      if (!this.inConfiguredWorkspace(sandboxPolicy)) this.stageOverForeignWorkspace("write", target, sandboxPolicy);
      if (signal?.aborted) throw new FsError("write aborted", "FS_ABORTED");
      const place = this.keyOf(target);
      if (place === void 0) {
        this.noteUnstaged("write", target?.displayPath ?? target?.targetKey, UNSTAGED_REASONS.UNRESOLVED_TARGET, {
          sessionId: this.sessionIdOf(sandboxPolicy),
          appliedToDisk: true
        });
        return super.writeText(target, content, expected, signal, sandboxPolicy);
      }
      if (place.key === "") {
        throw new FsError(`cannot write "${target.displayPath}": the workspace root is not a regular file`, "FS_NOT_REGULAR_FILE");
      }
      if (isStoreStatePath(place.abs)) this.denyStoreWrite(place, "write");
      if (place.external && stageOutside === "direct") {
        this.noteUnstaged("write", target?.displayPath ?? place.abs, UNSTAGED_REASONS.STAGE_OUTSIDE_DIRECT, {
          sessionId: this.sessionIdOf(sandboxPolicy),
          appliedToDisk: true
        });
        return super.writeText(target, content, expected, signal, sandboxPolicy);
      }
      if (place.external && stageOutside === "deny") this.denyOutsideWrite(place, "write");
      const service = this.stagingFor(this.sessionIdOf(sandboxPolicy));
      service.absorbSharedStore?.();
      return this.withLock(String(target.targetKey), async () => {
        const ws = this.reloaded(service);
        const abs = place.abs;
        const current = await this.currentOf(ws, target, place.key, signal, abs);
        if (current.exists && current.kind !== "file") {
          throw new FsError(`cannot write "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
        }
        if (expected?.kind === "replaceIfVersion") {
          if (!current.exists) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, "FS_STALE_VERSION");
          if (current.version !== String(expected.version)) {
            throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
          }
        } else if (expected?.kind === "createIfAbsent" && current.exists) {
          throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, "FS_NOT_OBSERVED");
        }
        const before = current.exists && Buffer.byteLength(String(content), "utf8") < (this.config?.diffBasisMaxBytes ?? 0) ? normalizeLineEndings(current.text) : null;
        const buffer = Buffer.from(String(content), "utf8");
        const stagedPath = this.stagedPathOf(ws, place.key);
        this.ensureStagedParentsAtomic(dirname(stagedPath), stagedPath);
        const result = ws.writeFile(abs, String(content), { origin: "dsh-tool" });
        this.verifyPersistedWrite({ ws, key: place.key, abs, buffer, displayPath: target.displayPath });
        const after = normalizeLineEndings(content);
        service.markFresh();
        service.afterMutation("dsh-write");
        this.notifyStagedChange(place.key);
        return attachStageDiagnostics(
          {
            operation: current.exists ? "update" : "create",
            version: FsVersion(`winstage:${result.hash}`),
            before,
            after,
            ...this.locationReceipt(ws, place.key, abs, current)
          },
          this.locationDiagnostics(ws, place.key, abs, current)
        );
      });
    }
    async editText(target, edit, expected, signal, sandboxPolicy) {
      return this.withStageFailureMap(
        target?.displayPath ?? target?.targetKey,
        () => this.editTextStaged(target, edit, expected, signal, sandboxPolicy)
      );
    }
    async editTextStaged(target, edit, expected, signal, sandboxPolicy) {
      if (!this.stagingEnabled()) return super.editText(target, edit, expected, signal, sandboxPolicy);
      if (!this.inConfiguredWorkspace(sandboxPolicy)) this.stageOverForeignWorkspace("edit", target, sandboxPolicy);
      if (signal?.aborted) throw new FsError("edit aborted", "FS_ABORTED");
      const place = this.keyOf(target);
      if (place === void 0) {
        this.noteUnstaged("edit", target?.displayPath ?? target?.targetKey, UNSTAGED_REASONS.UNRESOLVED_TARGET, {
          sessionId: this.sessionIdOf(sandboxPolicy),
          appliedToDisk: true
        });
        return super.editText(target, edit, expected, signal, sandboxPolicy);
      }
      if (place.key === "") {
        throw new FsError(`cannot edit "${target.displayPath}": the workspace root is not a regular file`, "FS_NOT_REGULAR_FILE");
      }
      if (isStoreStatePath(place.abs)) this.denyStoreWrite(place, "edit");
      if (place.external && stageOutside === "direct") {
        this.noteUnstaged("edit", target?.displayPath ?? place.abs, UNSTAGED_REASONS.STAGE_OUTSIDE_DIRECT, {
          sessionId: this.sessionIdOf(sandboxPolicy),
          appliedToDisk: true
        });
        return super.editText(target, edit, expected, signal, sandboxPolicy);
      }
      if (place.external && stageOutside === "deny") this.denyOutsideWrite(place, "edit");
      const service = this.stagingFor(this.sessionIdOf(sandboxPolicy));
      service.absorbSharedStore?.();
      return this.withLock(String(target.targetKey), async () => {
        const ws = this.reloaded(service);
        const abs = place.abs;
        const current = await this.currentOf(ws, target, place.key, signal, abs);
        if (!current.exists) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
        if (current.kind !== "file") throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
        if (expected && current.version !== String(expected.version)) {
          throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
        }
        const normalized = normalizeLineEndings(current.text);
        const edited = applyLiteralEdit(normalized, edit, target.displayPath);
        const storage = restoreLineEndings(edited, lineEndingOf(current.text));
        const buffer = Buffer.from(storage, "utf8");
        const stagedPath = this.stagedPathOf(ws, place.key);
        this.ensureStagedParentsAtomic(dirname(stagedPath), stagedPath);
        const result = ws.writeFile(abs, storage, { origin: "dsh-tool" });
        this.verifyPersistedWrite({ ws, key: place.key, abs, buffer, displayPath: target.displayPath });
        service.markFresh();
        service.afterMutation("dsh-edit");
        this.notifyStagedChange(place.key);
        return attachStageDiagnostics(
          {
            version: FsVersion(`winstage:${result.hash}`),
            before: normalized,
            after: edited,
            ...this.locationReceipt(ws, place.key, abs, current)
          },
          this.locationDiagnostics(ws, place.key, abs, current)
        );
      });
    }
    // ==================== 监听面（S7） ====================
    /**
     * 覆写 `watch`：**超类观察者照旧**（真实磁盘变更仍然通知），
     * 另把**暂存变更**也转成失效通知。
     *
     * 为什么需要：基类 `LocalFileSystem.watch`（dsh-fs-local/lib/index.js:726-750）
     * 只盯真实磁盘；暂存写入从不碰真实磁盘，所以走 `write`/`edit` 的改动过去不会让
     * `ctx.remote.workspaceFiles.changes` 的客户端文件视图失效（S7）。
     *
     * 契约（dsh-fs `watch(target, changed, signal)`）：回调**没有事件类型、没有路径**，
     * 只表示"这个 target 失效了"；所以这里只需决定"该不该叫醒它"。
     * 判定与超类逐字对齐（`:731-739`）：**目录** target 对**直接子项**通知；
     * **文件** target 只对该文件本身通知。
     *
     * 残余边界（如实标注，不做假承诺）：**跨进程**改动
     * （CLI / 另一个 DSH 实例写同一份暂存树）仍然不会通知 —— 超类的本地观察者也看不到。
     */
    async watch(target, changed, signal) {
      if (!this.stagingEnabled()) return super.watch(target, changed, signal);
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace();
        return super.watch(target, changed, signal);
      }
      const close = await super.watch(target, changed, signal);
      const place = this.keyOf(target);
      if (place === void 0) return close;
      const rel = place.key;
      let isDir = rel === "";
      if (!isDir) {
        try {
          isDir = (await super.stat(target, signal))?.type === "directory";
        } catch {
          isDir = false;
        }
      }
      const entry = { rel, isDir, changed };
      this.watchers.add(entry);
      return async () => {
        this.watchers.delete(entry);
        await close();
      };
    }
    /**
     * 暂存变更 → 本地失效通知。
     * 只触碰本次登记的观察者；**任何异常都在这里吞掉**（chokidar 的回调抛错会变成
     * error 分支，而写路径绝不能因为"通知"失败而失败）。
     */
    notifyStagedChange(rel) {
      if (this.watchers.size === 0) return;
      const changedRel = String(rel);
      const parentOf = (value) => {
        const dir = dirname(value === "" ? "." : value);
        return dir === "" ? "." : dir;
      };
      for (const entry of [...this.watchers]) {
        try {
          const hit = entry.isDir ? parentOf(changedRel) === (entry.rel === "" ? "." : entry.rel) : changedRel === entry.rel;
          if (hit) entry.changed();
        } catch (error) {
          this.log(`\u6682\u5B58\u53D8\u66F4\u901A\u77E5\u5931\u8D25\uFF08${changedRel}\uFF09\uFF1A${error?.message ?? error}`);
        }
      }
    }
    // ==================== 读取面 ====================
    /**
     * 当前状态：本插件暂存条目 → **shim/shell 通道的同一逻辑目标** → 真实磁盘。
     * `key` 既可以是工作区相对路径，也可以是工作区外条目的绝对路径键（S3a）。
     * @param {string} [explicitAbs] `keyOf()` 给出的规范化绝对路径（shim 布局映射要用它；
     *   不传时按 `key` 现推，工作区外键就是它自己，工作区内的用 `store.realPath()`）
     * @returns {{exists: boolean, kind?: 'file'|'dir', text?: string, version?: string, layout?: string}}
     */
    async currentOf(ws, target, key, signal, explicitAbs) {
      const entry = ws.entryOf(key);
      const abs = explicitAbs ?? (isExternalKey(key) ? key : (() => {
        try {
          return ws.store.realPath(key);
        } catch {
          return key;
        }
      })());
      const projected = this.projectsEntry(entry);
      if (projected && entry.state === STATE.DELETED) return { exists: false };
      if (projected && entry.state !== STATE.DELETED) {
        if (entry.kind === "dir") return { exists: true, kind: "dir", version: `winstage:dir:${key}` };
        if (!ws.store.hasBlob(entry.stagedHash)) {
          this.logError(`\u6E05\u5355\u6761\u76EE\u7684\u5185\u5BB9\u5BF9\u8C61\u4E0D\u5728\u78C1\u76D8\u4E0A\uFF1Akey=${key} hash=${entry.stagedHash}`);
          throw new FsError(MODEL_VISIBLE_FAILURE_TEXTS.contentMissing(target.displayPath), "FS_IO_ERROR");
        }
        return {
          exists: true,
          kind: "file",
          text: ws.store.readBlob(entry.stagedHash).toString("utf8"),
          version: `winstage:${entry.stagedHash}`
        };
      }
      if (this.hasEntryUnder(ws, key)) return { exists: true, kind: "dir", version: `winstage:dir:${key}` };
      const mirror = this.shimContentOf(ws, target, abs);
      if (mirror !== void 0) return mirror;
      const whiteout = this.shimWhiteoutOf(ws, abs);
      if (whiteout !== void 0) return { exists: false, layout: "shim-fs", physical: whiteout, whiteout: true };
      const info = await super.stat(target, signal);
      if (!info) return { exists: false };
      if (info.type === "directory") return { exists: true, kind: "dir", version: String(info.version) };
      if (info.type !== "file") return { exists: true, kind: "other", version: String(info.version) };
      let text;
      try {
        text = await super.readText(target, signal);
      } catch {
        text = void 0;
      }
      return { exists: true, kind: "file", version: String(info.version), text };
    }
    async stat(target, signal) {
      return this.withStageFailureMap(target?.displayPath ?? target?.targetKey, () => this.statInner(target, signal));
    }
    async statInner(target, signal) {
      if (!this.stagingEnabled()) return super.stat(target, signal);
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace();
        return super.stat(target, signal);
      }
      const place = this.keyOf(target);
      if (place === void 0) return super.stat(target, signal);
      const ws = this.stagingFor(this.sessionIdOf()).fresh();
      const current = await this.currentOf(ws, target, place.key, signal, place.abs);
      if (!current.exists) return void 0;
      if (current.kind === "dir") return { version: FsVersion(current.version), type: "directory", size: 0 };
      if (current.kind !== "file") return { version: FsVersion(current.version), type: "other" };
      return { version: FsVersion(current.version), type: "file", size: Buffer.byteLength(current.text ?? "", "utf8") };
    }
    async lstat(path, opts, signal) {
      return this.withStageFailureMap(typeof path === "string" ? path : void 0, () => this.lstatInner(path, opts, signal));
    }
    async lstatInner(path, opts, signal) {
      if (!this.stagingEnabled()) return super.lstat(path, opts, signal);
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace();
        return super.lstat(path, opts, signal);
      }
      if (typeof path !== "string" || path.trim().length === 0) {
        throw new FsError("file_path must be a non-empty string", "FS_NOT_FOUND");
      }
      const base = opts?.cwd || this.config?.cwd || process.cwd();
      const abs = canonical(isAbsolute(path) ? path : join(base, path));
      const place = this.keyOf({ targetKey: FsTargetKey(abs), displayPath: path });
      if (place === void 0) return super.lstat(path, opts, signal);
      const ws = this.stagingFor(this.sessionIdOf()).fresh();
      const current = await this.currentOf(ws, { targetKey: FsTargetKey(abs), displayPath: path }, place.key, signal, place.abs);
      if (!current.exists) return void 0;
      if (current.kind === "dir") return { version: FsVersion(current.version), type: "directory", size: 0 };
      if (current.kind !== "file") return { version: FsVersion(current.version), type: "other" };
      return { version: FsVersion(current.version), type: "file", size: Buffer.byteLength(current.text ?? "", "utf8") };
    }
    // ==================== 读取面：WP4 读侧可见性 ====================
    //
    // 四条读入口（`readText` / `readBytes` / `readByteRange` / `listDir`）在**做任何事之前**
    // 先把逻辑绝对路径喂给 `src/paths.ts` 的 29 条 `MASK_CLASSES`（经 `maskReason()`）。
    //
    // 默认 `readPolicy: 'record'`（**只记不拦**）：命中 ⇒ 记一条**会话级去重计数**
    // （去重键 = `maskId + maskKey`，同一个对象读一百次只有一条），至多发一条用户侧合并提示；
    // **读成功性一位不改**（返回值、异常、时序都不动）。
    //
    // `readPolicy: 'block'` 才拦：命中即抛普通失败（`FS_READ_DENIED`），文案同上"普通失败"口径；
    // `listDir` 还会把命中的**子项**从列表里去掉。这一档默认关闭，理由见 owner 决策：
    // **黑名单不是边界**（换个名字就绕过），只记不拦才是诚实面对这个事实的做法；
    // 真边界在 T0（AppContainer），而它的接线状态见 `docs\T2-T0接线契约.md`。
    /** 逻辑绝对路径 → 是否命中遮蔽表（纯查询；任何异常都当"没命中"，绝不因此让读失败） */
    maskedHitOf(abs) {
      if (typeof abs !== "string" || abs.length === 0) return void 0;
      try {
        return maskReason(abs);
      } catch {
        return void 0;
      }
    }
    /**
     * 读入口的遮蔽判定 + 登记（`readPolicy:'record'` 时**只记不拦**）。
     *
     * @param {object} target `FsTarget`
     * @param {string} op 读入口名（进登记项的 `ops`，供面板显示"是哪种读命中的"）
     * @returns {{id: string, reason?: string}|undefined} 命中项；未命中 `undefined`
     */
    guardMaskedRead(target, op) {
      const place = this.keyOf(target);
      let abs = place?.abs;
      if (abs === void 0) {
        try {
          abs = canonical(String(target?.targetKey ?? target?.displayPath ?? ""));
        } catch {
          abs = void 0;
        }
      }
      const hit = this.maskedHitOf(abs);
      if (!hit) return void 0;
      this.noteMaskedRead(abs, hit, op, target);
      if (this.readPolicy === "block") {
        this.logError(`\u8BFB\u7B56\u7565 block\uFF1A\u62D2\u7EDD\u8BFB\u53D6\u547D\u4E2D\u906E\u853D\u7C7B ${hit.id} \u7684\u8DEF\u5F84\uFF08${abs}\uFF09`);
        const error = new FsError(
          MODEL_VISIBLE_FAILURE_TEXTS.readDenied(target?.displayPath ?? abs),
          "FS_READ_DENIED"
        );
        error.maskId = hit.id;
        error.readPolicy = this.readPolicy;
        throw error;
      }
      return hit;
    }
    /**
     * 登记一次命中（**去重计数**与会话绑定；提示按"新命中的遮蔽类"至多一条）。
     * `listDir` 的子项也走这里（它没有 `target`，`displayPath` 由调用方给出）。
     */
    noteMaskedRead(abs, hit, op, target) {
      const sessionId = this.sessionIdOf();
      setReadVisibilityPolicy(sessionId, this.readPolicy);
      let result;
      try {
        result = recordReadVisibility({
          sessionId,
          maskId: hit.id,
          maskKey: maskKey(abs),
          reason: hit.reason,
          op
        });
      } catch (error) {
        this.logError(`\u8BFB\u4FA7\u53EF\u89C1\u6027\u767B\u8BB0\u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF0C\u8BFB\u7ED3\u679C\u4E0D\u53D7\u5F71\u54CD\uFF09\uFF1A${error?.message ?? error}`);
        return;
      }
      if (result.firstForMaskId) {
        const where = target?.displayPath ?? abs;
        this.log(
          `\u8BFB\u4FA7\u53EF\u89C1\u6027\uFF08readPolicy=${this.readPolicy}\uFF09\uFF1A\u672C\u6B21\u4F1A\u8BDD\u8BB0\u5F55\u5230\u65B0\u7684\u654F\u611F\u7C7B\u8BFB\u53D6 \u2014\u2014 \u906E\u853D\u7C7B ${hit.id}\uFF08\u4F8B\uFF1A${where}\uFF09\u3002\u53EA\u8BB0\u5F55\u3001\u4E0D\u62E6\u622A\uFF1B\u53BB\u91CD\u952E = maskId + maskKey\uFF08\u540C\u4E00\u5BF9\u8C61\u91CD\u590D\u8BFB\u53EA\u7D2F\u8BA1\u6B21\u6570\uFF09\u3002\u5B8C\u6574\u6E05\u5355\u89C1 review.json \u7684 readVisibility \u6BB5\u3002`
        );
      }
    }
    /**
     * `listDir` 的子项面：命中遮蔽表的子项**记录**；`readPolicy:'block'` 时从结果里去掉。
     * 只记不拦档下这个方法**不改变列表内容**（返回入参原样，且绝不在调用方的对象上写字段）。
     */
    filterMaskedChildren(dirAbs, entries, op) {
      if (!Array.isArray(entries)) return entries;
      const maskedNames = /* @__PURE__ */ new Set();
      for (const entry of entries) {
        const name = entry?.name;
        if (typeof name !== "string" || name.length === 0) continue;
        const childAbs = dirAbs === void 0 ? void 0 : join(dirAbs, name);
        const hit = this.maskedHitOf(childAbs);
        if (!hit) continue;
        this.noteMaskedRead(childAbs, hit, op, { displayPath: childAbs });
        maskedNames.add(name.toLowerCase());
      }
      if (this.readPolicy !== "block" || maskedNames.size === 0) return entries;
      this.logError(`\u8BFB\u7B56\u7565 block\uFF1A\u4ECE\u76EE\u5F55\u5217\u8868\u4E2D\u79FB\u9664 ${maskedNames.size} \u4E2A\u547D\u4E2D\u906E\u853D\u8868\u7684\u5B50\u9879`);
      return entries.filter((entry) => !maskedNames.has(String(entry?.name ?? "").toLowerCase()));
    }
    async readText(target, signal) {
      return this.withStageFailureMap(target?.displayPath ?? target?.targetKey, () => this.readTextInner(target, signal));
    }
    async readTextInner(target, signal) {
      this.guardMaskedRead(target, "readText");
      if (!this.stagingEnabled()) return super.readText(target, signal);
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace();
        return super.readText(target, signal);
      }
      const place = this.keyOf(target);
      if (place === void 0) return super.readText(target, signal);
      const ws = this.stagingFor(this.sessionIdOf()).fresh();
      if (!this.hasStagedContent(ws, place.key, place.abs)) return super.readText(target, signal);
      const current = await this.currentOf(ws, target, place.key, signal, place.abs);
      if (!current.exists) throw new FsError(`"${target.displayPath}" does not exist`, "FS_NOT_FOUND");
      if (current.kind === "dir") throw new FsError(`cannot read "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
      return current.text ?? "";
    }
    async streamText(target, signal) {
      if (!this.stagingEnabled()) return super.streamText(target, signal);
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace();
        return super.streamText(target, signal);
      }
      const text = await this.readText(target, signal);
      return (async function* stream() {
        yield text;
      })();
    }
    async readBytes(target, signal, maxBytes) {
      return this.withStageFailureMap(
        target?.displayPath ?? target?.targetKey,
        () => this.readBytesInner(target, signal, maxBytes)
      );
    }
    async readBytesInner(target, signal, maxBytes) {
      this.guardMaskedRead(target, "readBytes");
      if (!this.stagingEnabled()) return super.readBytes(target, signal, maxBytes);
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace();
        return super.readBytes(target, signal, maxBytes);
      }
      const place = this.keyOf(target);
      if (place === void 0) return super.readBytes(target, signal, maxBytes);
      const ws = this.stagingFor(this.sessionIdOf()).fresh();
      if (!this.hasStagedContent(ws, place.key, place.abs)) return super.readBytes(target, signal, maxBytes);
      const current = await this.currentOf(ws, target, place.key, signal, place.abs);
      if (!current.exists) throw new FsError(`"${target.displayPath}" does not exist`, "FS_NOT_FOUND");
      if (current.kind === "dir") throw new FsError(`cannot read "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
      const buffer = Buffer.from(current.text ?? "", "utf8");
      if (Number.isSafeInteger(maxBytes) && buffer.length > maxBytes) {
        throw new FsError(`cannot read "${target.displayPath}": file is larger than ${maxBytes} bytes`, "FS_TOO_LARGE");
      }
      return new Uint8Array(buffer);
    }
    async readByteRange(target, range, signal) {
      return this.withStageFailureMap(
        target?.displayPath ?? target?.targetKey,
        () => this.readByteRangeInner(target, range, signal)
      );
    }
    async readByteRangeInner(target, range, signal) {
      this.guardMaskedRead(target, "readByteRange");
      if (!this.stagingEnabled()) return super.readByteRange(target, range, signal);
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace();
        return super.readByteRange(target, range, signal);
      }
      const place = this.keyOf(target);
      if (place === void 0) return super.readByteRange(target, range, signal);
      const ws = this.stagingFor(this.sessionIdOf()).fresh();
      if (!this.hasStagedContent(ws, place.key, place.abs)) return super.readByteRange(target, range, signal);
      const current = await this.currentOf(ws, target, place.key, signal, place.abs);
      if (!current.exists) throw new FsError(`"${target.displayPath}" does not exist`, "FS_NOT_FOUND");
      if (current.kind === "dir") throw new FsError(`cannot read "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
      const buffer = Buffer.from(current.text ?? "", "utf8");
      const offset = Number(range?.offset ?? 0);
      const length = Number(range?.length ?? buffer.length);
      return new Uint8Array(buffer.subarray(offset, Math.min(buffer.length, offset + length)));
    }
    async listDir(target, signal) {
      return this.withStageFailureMap(target?.displayPath ?? target?.targetKey, () => this.listDirInner(target, signal));
    }
    async listDirInner(target, signal) {
      this.guardMaskedRead(target, "listDir");
      const dirPlace = this.keyOf(target);
      const dirAbs = dirPlace?.abs;
      const finish = (entries) => this.filterMaskedChildren(dirAbs, entries, "listDir");
      if (!this.stagingEnabled()) return finish(await super.listDir(target, signal));
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace();
        return finish(await super.listDir(target, signal));
      }
      const place = this.keyOf(target);
      if (place === void 0) return finish(await super.listDir(target, signal));
      const rel = place.key;
      const ws = this.stagingFor(this.sessionIdOf()).fresh();
      const shimDir = this.shimMirrorOf(ws, place.abs);
      const shim = this.shimChildrenOf(ws, shimDir);
      const wo = this.shimDeletionsOf(ws, place.abs);
      if (wo?.selfDeleted) return finish([]);
      const woDeleted = wo?.deleted;
      if (!this.hasEntryUnder(ws, rel) && shim === void 0 && (woDeleted === void 0 || woDeleted.size === 0)) {
        return finish(await super.listDir(target, signal));
      }
      const merged = /* @__PURE__ */ new Map();
      try {
        for (const entry of await super.listDir(target, signal)) {
          merged.set(entry.name.toLowerCase(), entry);
        }
      } catch {
      }
      if (shim !== void 0) {
        for (const name of shim.deleted) merged.delete(name);
        for (const entry of shim.entries) merged.set(entry.name.toLowerCase(), entry);
      }
      if (woDeleted !== void 0) {
        for (const name of woDeleted) merged.delete(name);
      }
      const external = place.external;
      const prefix = rel === "" ? "" : `${rel}${sep}`.toLowerCase();
      for (const [key, entry] of Object.entries(ws.manifest.entries)) {
        if (entry.external === true !== external) continue;
        if (!this.projectsEntry(entry)) continue;
        const lower = key.toLowerCase();
        if (rel !== "" && !lower.startsWith(prefix)) continue;
        const rest = rel === "" ? key : key.slice(rel.length + 1);
        if (rest.length === 0) continue;
        const head = rest.split(/[\\/]/)[0];
        const childRel = join(rel, head);
        const isDirect = !rest.slice(head.length).match(/[\\/]/);
        const childAbs = ws.absolute(childRel);
        const targetOfChild = { targetKey: FsTargetKey(canonical(childAbs)), displayPath: childAbs };
        const keyOfChild = head.toLowerCase();
        if (entry.state === STATE.DELETED && isDirect) {
          merged.delete(keyOfChild);
          continue;
        }
        const direct = isDirect ? entry : void 0;
        const kind = direct ? direct.kind : "dir";
        if (kind === "dir") {
          merged.set(keyOfChild, { name: head, type: "directory", target: targetOfChild });
          continue;
        }
        merged.set(keyOfChild, {
          name: head,
          type: "file",
          target: targetOfChild,
          version: FsVersion(`winstage:${direct.stagedHash}`),
          size: direct.size
        });
      }
      return finish([...merged.values()]);
    }
  };
}

// dsh-plugin/fs-entry.ts
if (!SandboxedFileSystem) {
  throw new Error(
    "WinStage \u6682\u5B58\u6587\u4EF6\u7CFB\u7EDF\uFF1A\u65E0\u6CD5\u5B9A\u4F4D @deepseek-ai/dsh-fs-sandbox\u3002\u5173\u95ED\u5F00\u5173\u8981\u9000\u56DE\u5E73\u53F0\u6C99\u7BB1\uFF08\u5BA1\u6279\uFF09\u9762\uFF0C\u56E0\u6B64\u8FD9\u91CC fail-closed\u3002\u8BF7\u8BBE\u7F6E DSH_SANDBOX_NODE_ROOT \u6307\u5411\u542B @deepseek-ai/* \u7684 node_modules\u3002"
  );
}
var STAGE_OUTSIDE_VALUES = /* @__PURE__ */ new Set(["stage", "deny", "direct"]);
var stageOutsideFromEnv = (() => {
  const raw = process.env.WINSTAGE_STAGE_OUTSIDE;
  return typeof raw === "string" && STAGE_OUTSIDE_VALUES.has(raw) ? raw : "stage";
})();
var StagingFileSystem = createStagingFileSystem({
  stageOutside: stageOutsideFromEnv,
  base: SandboxedFileSystem
});
var fs_entry_default = StagingFileSystem;
export {
  StagingFileSystem,
  fs_entry_default as default
};
