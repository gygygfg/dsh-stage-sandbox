import {
  createWinStageShellExecutor,
  locatePackageFile,
  workspaceRootsOfLoaderRows
} from "./chunk-B6IQC4A2.mjs";
import {
  getReviewService
} from "./chunk-JQDMKSOE.mjs";
import "./chunk-Z53TC6BM.mjs";

// dsh-plugin/shell-entry.ts
var SHELL_MODULE = locatePackageFile("@deepseek-ai/dsh-shell/lib/index.js");
var configuredRoot;
function configureShellWorkspaceRoot(root) {
  configuredRoot = typeof root === "string" && root.length > 0 ? root : void 0;
  return configuredRoot;
}
function declaredWorkspaceRoot(rows) {
  const fromRows = rows && typeof rows === "object" ? rows.fsRoot ?? rows.shellRoot : void 0;
  if (typeof fromRows === "string" && fromRows.length > 0) return fromRows;
  if (configuredRoot) return configuredRoot;
  const fromEnv = process.env.WINSTAGE_SHELL_WORKSPACE;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const error = new Error(
    'no workspace root is configured: the loader row config carries no "workspaceRoot" (and no explicit assembly value / WINSTAGE_SHELL_WORKSPACE is set). \u672C\u6B21\u547D\u4EE4\u6CA1\u6709\u6267\u884C \u2014\u2014 \u62D2\u7EDD\u7528 process.cwd() \u53BB\u731C\u4E00\u4E2A\u6839\uFF08\u731C\u51FA\u6765\u7684\u6839\u4F1A\u8BA9\u4E24\u4FA7\u5206\u53C9\uFF09\u3002'
  );
  error.code = "WINSTAGE_SHELL_NO_WORKSPACE_ROOT";
  error.winstage = { code: error.code, executed: false };
  throw error;
}
function workspaceFor(sessionId, rootOverride) {
  const rows = typeof rootOverride === "string" && rootOverride.length > 0 ? { fsRoot: rootOverride } : void 0;
  const service = getReviewService({
    workspaceRoot: declaredWorkspaceRoot(rows),
    ...typeof sessionId === "string" && sessionId.length > 0 ? { sessionId } : {}
  });
  service.reload();
  return service.workspace;
}
async function loadShellBase() {
  let loaded;
  if (SHELL_MODULE) {
    loaded = await import(`file:///${SHELL_MODULE.replace(/\\/g, "/")}`);
  } else {
    loaded = await import("@deepseek-ai/dsh-shell");
  }
  const klass = loaded?.ShellExecutor ?? loaded?.default;
  if (typeof klass !== "function") {
    throw new Error(
      "WinStage \u6C99\u7BB1 shell\uFF1A@deepseek-ai/dsh-shell \u6CA1\u6709\u5BFC\u51FA ShellExecutor \u7C7B\u3002\u62FF\u4E0D\u5230 ShellExecutor \u670D\u52A1\u5B9A\u4E49\u5C31\u4E0D\u80FD\u5B89\u5168\u63A5\u7BA1\u6267\u884C\u9762\uFF08\u7EDD\u4E0D\u8BA9 pwsh \u843D\u56DE\u4E3B\u673A\u76F4\u8DD1\uFF09\uFF0C\u56E0\u6B64\u8FD9\u91CC fail-closed\u3002\u8BF7\u63D0\u4F9B\u5305\u542B @deepseek-ai/* \u7684 node_modules \u6839\u3002"
    );
  }
  return klass;
}
var WinStageShellExecutor = createWinStageShellExecutor({
  workspaceFor,
  // 磁盘绝对路径优先；打包 App（asar）退回运行时裸名解析（见 loadShellBase）
  base: await loadShellBase(),
  // ★ 让**行 config** 也能定根：cordis 会把正规化后的 config 交给构造函数，
  //   这里现读 `config.workspaceRoot`。
  onConfig: (config) => {
    const root = config && typeof config.workspaceRoot === "string" ? config.workspaceRoot : "";
    if (root.length > 0) configureShellWorkspaceRoot(root);
  }
});
var shell_entry_default = WinStageShellExecutor;
export {
  SHELL_MODULE,
  WinStageShellExecutor,
  configureShellWorkspaceRoot,
  declaredWorkspaceRoot,
  shell_entry_default as default,
  workspaceFor,
  workspaceRootsOfLoaderRows
};
