import {
  CLEARTEXT_SECRET_FAILURE,
  FAILURE_CATEGORY_CODES,
  FAILURE_SEMANTICS,
  WindowsStageExecutor,
  classifyFailureSemantics,
  createRegExeReader,
  createRegExeWriter,
  createRegistryStage,
  detectCleartextSecret,
  getReviewService,
  registryWireBytes,
  resolveDshModuleRoot,
  rootSessionIdFor,
  rootSessionIdOf,
  transparencyViolations
} from "./chunk-JQDMKSOE.mjs";

// dsh-plugin/shell-executor.ts
import { appendFileSync, existsSync as existsSync2, lstatSync, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
import { pathToFileURL } from "node:url";

// src/audit-report.ts
var AUDIT_PREFIX = /^\[winstage-audit\]\[\d+\]\[\d+\]\s*/;
function aggregateAudit(lines, opts = {}) {
  const root = opts.root;
  const rootNorm = typeof root === "string" && root.length > 0 ? root.replace(/[\\/]+$/, "").toLowerCase() : null;
  const scopeOf = (p) => rootNorm !== null && typeof p === "string" && p.toLowerCase().startsWith(rootNorm) ? "workspace" : "outside";
  const files = { read: /* @__PURE__ */ new Map(), written: /* @__PURE__ */ new Map(), deleted: /* @__PURE__ */ new Map(), moved: [] };
  const registry = { read: /* @__PURE__ */ new Map(), written: /* @__PURE__ */ new Map() };
  let parsed = 0;
  let malformed = 0;
  const malformedSamples = [];
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  for (const raw of lines) {
    if (raw.length === 0) continue;
    const body = AUDIT_PREFIX.test(raw) ? raw.replace(AUDIT_PREFIX, "") : raw;
    let e;
    try {
      e = JSON.parse(body);
    } catch {
      malformed += 1;
      if (malformedSamples.length < 5) malformedSamples.push(raw.slice(0, 120));
      continue;
    }
    parsed += 1;
    switch (e.op) {
      case "file.open":
        bump(e.mode === "write" ? files.written : files.read, e.path);
        break;
      case "file.delete":
        bump(files.deleted, e.path);
        break;
      case "file.move":
        files.moved.push({ from: e.from, to: e.to });
        break;
      case "reg.open":
      case "reg.query":
        bump(registry.read, e.value ? `${e.key}#${e.value}` : e.key);
        break;
      case "reg.create":
      case "reg.set":
      case "reg.deleteKey":
      case "reg.deleteValue":
        bump(registry.written, e.value ? `${e.key}#${e.value}` : e.key);
        break;
      default:
        break;
    }
  }
  const toArr = (map) => [...map.entries()].map(([path, count]) => ({ path, count, scope: scopeOf(path) })).sort((a, b) => a.path.localeCompare(b.path));
  const toArrReg = (map) => [...map.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path));
  const countScope = (arr, scope) => arr.filter((e) => e.scope === scope).length;
  const writtenArr = toArr(files.written);
  const deletedArr = toArr(files.deleted);
  return {
    files: {
      read: toArr(files.read),
      written: writtenArr,
      deleted: deletedArr,
      moved: files.moved.map((m) => ({ ...m, scope: scopeOf(m.to) }))
    },
    registry: { read: toArrReg(registry.read), written: toArrReg(registry.written) },
    counts: { parsed, malformed, malformedSamples },
    summary: {
      filesRead: files.read.size,
      filesWritten: files.written.size,
      filesDeleted: files.deleted.size,
      filesMoved: files.moved.length,
      registryRead: registry.read.size,
      registryWritten: registry.written.size,
      filesWrittenInWorkspace: countScope(writtenArr, "workspace"),
      filesWrittenOutside: countScope(writtenArr, "outside"),
      filesDeletedInWorkspace: countScope(deletedArr, "workspace")
    }
  };
}
function buildAuditReport(lines, opts = {}) {
  const agg = aggregateAudit(lines, { root: opts.root });
  return {
    generatedAt: opts.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
    root: opts.root ?? null,
    source: {
      audits: opts.audits ?? [],
      lines: lines.length,
      parsed: agg.counts.parsed,
      malformed: agg.counts.malformed,
      malformedSamples: agg.counts.malformedSamples
    },
    files: agg.files,
    registry: agg.registry,
    summary: agg.summary
  };
}
function summarizeAudit(summary) {
  if (!summary) return "\u5BA1\u8BA1\uFF1A\u65E0";
  return `\u5BA1\u8BA1\uFF1A\u6587\u4EF6 \u8BFB${summary.filesRead} \u5199${summary.filesWritten}\uFF08\u5DE5\u4F5C\u533A\u5185${summary.filesWrittenInWorkspace}/\u5916${summary.filesWrittenOutside}\uFF09 \u5220${summary.filesDeleted}\uFF1B\u6CE8\u518C\u8868 \u8BFB${summary.registryRead} \u5199${summary.registryWritten}`;
}

// dsh-plugin/registry-capture.ts
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
var HOST_CAPTURE_MARKER = "host-capture.json";
function registryDirOf(sessionDir) {
  return join(sessionDir, "registry");
}
function journalPathOf(sessionDir) {
  return join(registryDirOf(sessionDir), "overlay.journal");
}
function markerPathOf(sessionDir) {
  return join(registryDirOf(sessionDir), HOST_CAPTURE_MARKER);
}
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
function sweepDeadOverlayHives(sessionDir, options = {}) {
  const isAlive = options.isAlive ?? defaultIsAlive;
  const dir = registryDirOf(sessionDir);
  if (!existsSync(dir)) return { removed: [], kept: 0 };
  const removed = [];
  let kept = 0;
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return { removed, kept };
  }
  const dead = /* @__PURE__ */ new Set();
  for (const name of entries) {
    const m = /^overlay\.(\d+)\.hive(?:\.LOG[12])?$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (isAlive(pid)) {
      kept += 1;
      continue;
    }
    dead.add(pid);
  }
  for (const name of entries) {
    const m = /^overlay\.(\d+)\.hive(?:\.LOG[12])?$/.exec(name);
    if (!m) continue;
    if (!dead.has(Number(m[1]))) continue;
    const full = join(dir, name);
    try {
      unlinkSync(full);
      removed.push(name);
    } catch {
    }
  }
  return { removed, kept };
}
function readMarker(sessionDir) {
  try {
    const parsed = JSON.parse(readFileSync(markerPathOf(sessionDir), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function writeMarker(sessionDir, marker) {
  try {
    writeFileSync(markerPathOf(sessionDir), `${JSON.stringify(marker, null, 2)}
`, "utf8");
  } catch {
  }
}
function captureRegistryChanges(options = {}) {
  const sessionDir = typeof options.sessionDir === "string" ? options.sessionDir : "";
  const log = options.log ?? (() => {
  });
  const logError = options.logError ?? (() => {
  });
  const errors = [];
  const fail = (reason, error) => {
    const detail = `${reason}: ${error?.message ?? error ?? ""}`.trim();
    errors.push(detail);
    logError(`\u6CE8\u518C\u8868\u6355\u83B7\u5931\u8D25 \u2014\u2014 ${detail}`);
    return { handled: false, reason, errors };
  };
  if (sessionDir.length === 0) return { handled: false, reason: "no-session-dir", errors };
  const journalPath = journalPathOf(sessionDir);
  if (!existsSync(journalPath)) return { handled: false, reason: "no-wal", errors };
  let size = 0;
  try {
    size = statSync(journalPath).size;
  } catch (error) {
    return fail("wal-unreadable", error);
  }
  if (size <= 0) return { handled: false, reason: "no-wal-records", errors };
  const marker = readMarker(sessionDir);
  const consumed = Number.isInteger(marker?.bytes) ? marker.bytes : -1;
  if (consumed === size) return { handled: false, reason: "no-new-records", errors };
  if (consumed > size) log(`\u6CE8\u518C\u8868 WAL \u53D8\u5C0F\uFF08${consumed} \u2192 ${size}\uFF09\uFF1A\u6309\u65B0 WAL \u91CD\u65B0\u51BB\u7ED3\u3002`);
  let stage;
  try {
    stage = createRegistryStage({
      sessionDir,
      ...typeof options.sessionId === "string" && options.sessionId.length > 0 ? { sessionId: options.sessionId } : {},
      ...typeof options.workspaceRoot === "string" ? { workspaceRoot: options.workspaceRoot } : {},
      reader: createRegExeReader(options.bindingOptions),
      writer: createRegExeWriter({
        ...options.bindingOptions ?? {},
        wireBytes: registryWireBytes,
        log
      })
    });
  } catch (error) {
    return fail("stage-construct-failed", error);
  }
  let frozen;
  try {
    stage.open();
    frozen = stage.freezeCandidate();
  } catch (error) {
    return fail("freeze-failed", error);
  }
  if (frozen?.enqueued === true) {
    log(
      `\u6CE8\u518C\u8868\u5019\u9009\u5DF2\u51BB\u7ED3\uFF1A${frozen.changes?.length ?? 0} \u6761\u51C0\u53D8\u5316\uFF08\u5019\u9009 ${frozen.candidate?.id ?? "?"}\uFF09\u3002${frozen.unreadable?.length ? ` \u5176\u4E2D ${frozen.unreadable.length} \u4E2A\u952E\u8BFB\u4E0D\u5230\u57FA\u7EBF\u3002` : ""}`
    );
    for (const unit of frozen.unreadable ?? []) errors.push(`unreadable-baseline: ${unit}`);
  } else {
    log(`\u6CE8\u518C\u8868 WAL \u6709\u8BB0\u5F55\u4F46\u6CA1\u6709\u51C0\u53D8\u5316\uFF08${frozen?.reason ?? "no-net-change"}\uFF09\u3002`);
  }
  sweepDeadOverlayHives(sessionDir, { isAlive: options.isAlive });
  writeMarker(sessionDir, {
    bytes: size,
    records: frozen?.changes?.length ?? 0,
    enqueued: frozen?.enqueued === true,
    candidateId: frozen?.candidate?.id ?? null,
    at: new Date(options.nowMs ?? Date.now()).toISOString()
  });
  return {
    handled: true,
    reason: frozen?.enqueued === true ? "enqueued" : frozen?.reason ?? "no-net-change",
    changes: frozen?.changes?.length ?? 0,
    enqueued: frozen?.enqueued === true,
    candidateId: frozen?.candidate?.id ?? null,
    errors
  };
}

// dsh-plugin/shell-executor.ts
var DEFAULT_TIMEOUT_MS = 12e4;
var DEFAULT_MAX_TIMEOUT_MS = 6e5;
var DEFAULT_MAX_OUTPUT_BYTES = 64e3;
var ENV_OVERRIDES = { NO_COLOR: "1", PAGER: "cat", GIT_PAGER: "cat" };
var ENCODING_PREAMBLE = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ";
var LANE_JOURNAL_BASENAME = "sandbox-lane.json";
var CARRIER_INIT_FAILED_TEXT = "\u8F7D\u4F53\u8FDB\u7A0B\u521D\u59CB\u5316\u5931\u8D25\uFF08\u6CE8\u5165\u6210\u529F\u4F46\u5B50\u8FDB\u7A0B CLR/.NET \u542F\u52A8\u671F\u9000\u51FA\uFF1B\u4E0D\u662F\u80FD\u529B/ABI \u95EE\u9898\uFF09";
function classifyLaneFallback(reason) {
  const raw = typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : null;
  if (raw === null) return { code: "none", text: "\u6CA1\u6709\u56DE\u9000\u539F\u56E0\uFF08\u672C\u6B21\u6863\u4F4D\u662F\u76F4\u63A5\u9009\u5B9A\u7684\uFF09", raw: null };
  const lowered = raw.toLowerCase();
  const lower = lowered.replace(/[—–-]?\s*fail-closed fallback to the restricted-token mode\.?/g, " ");
  const hit = (code, text, re) => re.test(lower) ? { code, text, raw } : void 0;
  const structured = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*):/.exec(lowered);
  if (structured !== null && structured[1] === "carrier-init-failed") {
    return { code: "carrier-init-failed", text: CARRIER_INIT_FAILED_TEXT, raw };
  }
  return hit("carrier-init-failed", CARRIER_INIT_FAILED_TEXT, /carrier-init-failed|injector exit=(0x)?ffff0000|4294901760|the shell cannot be started|could not load file or assembly|exception from hresult|0x8007054f|0x800700b7|0xe0434352|status_dll_init_failed|0xc0000142/) ?? hit("artifact-missing", "shim \u4EA7\u7269\u7F3A\u5931\u6216\u4E0D\u5B8C\u6574\uFF08DLL / winstage-inject.exe / winstage-probe.exe\uFF09", /not found:|no such file|enoent|incomplete|artifacts missing/) ?? hit("acl-denied", "ACL/\u5199\u6743\u9650\u88AB\u62D2\uFF08EPERM / ACCESS_DENIED / \u6682\u5B58\u6839\u5EFA\u4E0D\u51FA\u6765\uFF09", /access is denied|eperm|eacces|privilege not held|cannot create|cannot write|dacl/) ?? hit("env-missing", "\u73AF\u5883\u7F3A\u4EF6\uFF08\u6682\u5B58\u6839\u672A\u7ED9\u51FA\u3001shim \u914D\u7F6E/\u73AF\u5883\u53D8\u91CF\u5199\u4E0D\u8FDB\uFF09", /stagingroot|stage-root|environment|env\b|not set|required|config/) ?? hit("token-restricted", "\u53D7\u9650\u4EE4\u724C\u80FD\u529B\u4E0D\u53EF\u7528\uFF08\u521B\u5EFA\u4EE4\u724C / \u6743\u9650\u4E0D\u8DB3\uFF09", /token|logon|privilege|seclogon|restricted/) ?? // ⚠ 这里的 `fail(ed|ure)` **必须带归因作用域**，不能裸放：裸放会让任何只是"提到 failure"
  // 的未知原因都被贴成"探测未通过"——分类重新变成**措辞**的函数（§4.2 那类缺陷的翻版），
  // 也违反"无法归类必须原样透出成 unclassified"的契约。
  // 因此只在**归因于注入器/shim/透明通道**时才认（`injector … injection failure` 要判
  // probe-failed），而 `some brand new failure nobody has seen` 这类无归因散文必须留 unclassified。
  // 载体初始化失败另有更强的判据：上面的结构化前缀与具体错误码
  // （0x8007054f / 0xc0000142 / could not load file or assembly …）。
  hit("probe-failed", "\u63A2\u6D4B\u672A\u901A\u8FC7\uFF08\u91D1\u4E1D\u96C0\u80FD\u529B / selftest / ABI \u4E0D\u5339\u914D\uFF09", /probe|canary|selftest|self-test|abi|unavailable|(?:injector|shim|transparent)[^.]{0,40}?fail(ed|ure)/) ?? {
    code: "unclassified",
    text: `\u672A\u5F52\u7C7B\u7684\u56DE\u9000\u539F\u56E0\uFF1A${raw}`,
    raw
  };
}
function summarizeLane(lane) {
  const record = lane && typeof lane === "object" ? lane : {};
  const reported = typeof record.launchMode === "string" && record.launchMode.length > 0 ? record.launchMode : null;
  const launchMode = reported === "unknown" ? null : reported;
  const off = record.winStageEnabled === false;
  const fallback = classifyLaneFallback(record.fallbackReason);
  const tier = record.tierEffective ?? null;
  const base = {
    /**
     * 对外**原样**透出执行器报出的通道名（`'unknown'` 也如实显示）；
     * 判定用的是下面归一后的 `launchMode`（`'unknown'` ⇒ 按"未证实已生效"对待）。
     */
    launchMode: reported ?? null,
    tierEffective: tier,
    requestedTier: record.requestedTier ?? null,
    winStageEnabled: !off,
    fallback: fallback.code,
    fallbackText: fallback.text,
    at: record.at ?? null
  };
  if (launchMode === null) {
    return {
      ...base,
      status: "unknown",
      degraded: null,
      conclusion: reported === "unknown" ? '\u6C99\u7BB1\u6863\u4F4D\u672A\u77E5\uFF1A\u6267\u884C\u5668\u6CA1\u6709\u62A5\u51FA launchMode\uFF08\u65E0\u6CD5\u5224\u65AD\u662F\u5426\u8D70\u4E86 shim \u901A\u9053\uFF09\u2014\u2014 \u6309"\u672A\u8BC1\u5B9E\u5DF2\u751F\u6548"\u5BF9\u5F85\u3002' : "\u6C99\u7BB1\u6863\u4F4D\u672A\u77E5\uFF1A\u672C\u4F1A\u8BDD\u8FD8\u6CA1\u6709\u8BB0\u5F55\u5230\u4EFB\u4F55\u4E00\u6B21\u6863\u4F4D\u5224\u5B9A\uFF08\u6CA1\u6709\u547D\u4EE4\u7ECF\u8FC7\u6267\u884C\u5668\uFF09\u3002\u4E0B\u4E00\u6B65\uFF1A\u8DD1\u4E00\u6761 pwsh \u547D\u4EE4\u540E\u518D\u770B\u8FD9\u91CC\u3002"
    };
  }
  if (launchMode === "shim") {
    return {
      ...base,
      status: "active",
      degraded: false,
      conclusion: `\u6C99\u7BB1\u5DF2\u751F\u6548\uFF1A\u547D\u4EE4\u8D70\u900F\u660E\u57AB\u7247\uFF08\u53BB\u4EE4\u724C\u5316\uFF09\u901A\u9053\uFF08tier=${tier ?? "?"}\uFF09\uFF0C\u6587\u4EF6\u4E0E\u6CE8\u518C\u8868\u5199\u5165\u8FDB\u6682\u5B58\u3002`
    };
  }
  const cause = fallback.code === "none" ? "\uFF08\u6CA1\u6709\u56DE\u9000\u539F\u56E0\u8BB0\u5F55\uFF1A\u8FD9\u4E2A\u6863\u4F4D\u662F\u88AB\u76F4\u63A5\u9009\u5B9A\u7684\uFF0C\u5E76\u975E\u63A2\u6D4B\u5931\u8D25\u540E\u7684\u56DE\u9000\uFF09" : `\uFF08\u56DE\u9000\u5206\u7C7B\uFF1A${fallback.code} \u2014 ${fallback.text}\uFF09`;
  if (off) {
    return {
      ...base,
      status: "off",
      degraded: true,
      conclusion: `WinStage \u5F00\u5173\u4E3A\u5173\u95ED\u6001\uFF1A\u6863\u4F4D=${launchMode}\uFF08tier=${tier ?? "?"}\uFF09\uFF0C\u6CA1\u6709 shim \u901A\u9053 \u2014\u2014 \u672C\u6267\u884C\u5668\u6B64\u523B\u4E0D\u63A5\u7BA1\u6682\u5B58\u9762\uFF0C\u6B64\u5F62\u6001\u5C5E\u9884\u671F\uFF0C\u4EC5\u4F5C\u8BB0\u5F55\u3002${cause}`
    };
  }
  const laneText = launchMode === "appcontainer" ? "AppContainer \u6863\uFF08T0\uFF09" : "\u53D7\u9650\u4EE4\u724C\u6863";
  const remedy = fallback.code === "carrier-init-failed" ? "\u6CE8\u5165\u5668\u81EA\u62A5 ok=true \u21D2 \u4E0D\u662F\u4EA7\u7269/\u6CE8\u5165\u5668\u95EE\u9898\uFF1A\u662F\u8F7D\u4F53\u8FDB\u7A0B\u81EA\u8EAB\uFF08powershell.exe \u7684 CLR/.NET\uFF09\u5728\u521D\u59CB\u5316\u671F\u9000\u51FA\uFF0C\u9000\u51FA\u7801/HRESULT \u5DF2\u539F\u6837\u4FDD\u7559\u5728\u8BE5\u56DE\u9000\u539F\u56E0\u5C3E\u90E8\u3002" : "\u8BF7\u68C0\u67E5 shim \u4EA7\u7269\u662F\u5426\u9F50\u5907\u3002";
  return {
    ...base,
    status: "degraded",
    degraded: true,
    conclusion: `\u6C99\u7BB1\u672A\u751F\u6548\uFF1A\u547D\u4EE4\u5728${laneText}\uFF08launchMode=${launchMode}, tier=${tier ?? "?"}\uFF09\u6267\u884C\uFF0C\u5199\u5165\u53EA\u5269\u5185\u6838\u786C\u62D2\u3001\u5B50\u8FDB\u7A0B stdio \u53EF\u80FD\u88AB\u6390\u65AD\u3001\u6587\u4EF6\u4EA7\u51FA\u4E0D\u8FDB\u6682\u5B58\uFF1B${remedy}${cause}`
  };
}
function readLaneJournalFile(dir) {
  const file = typeof dir === "string" && dir.length > 0 ? join2(dir, LANE_JOURNAL_BASENAME) : void 0;
  if (file === void 0) return { available: false, reason: "no-store-dir", file };
  if (!existsSync2(file)) return { available: false, reason: "not-recorded", file };
  try {
    return { available: true, reason: "recorded", file, record: JSON.parse(readFileSync2(file, "utf8")) };
  } catch (error) {
    return { available: false, reason: `unreadable: ${error?.message ?? error}`, file };
  }
}
function summarizeLaneHistory(record) {
  const history = record && typeof record === "object" && record.history && typeof record.history === "object" ? record.history : {};
  const first = history.firstDegrade && typeof history.firstDegrade === "object" ? history.firstDegrade : null;
  const loss = history.rootLoss && typeof history.rootLoss === "object" ? history.rootLoss : null;
  const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  return {
    commandSeq: Number.isFinite(Number(record?.seq)) ? Number(record.seq) : null,
    shimCount: num(history.shimCount),
    degradeCount: num(history.degradeCount),
    /** "是否曾掉档" = 有首次掉档记录（与 `degradeCount > 0` 同真同假，断言钉住） */
    everDegraded: first !== null,
    firstDegrade: first ? {
      at: first.at ?? null,
      seq: Number.isFinite(Number(first.seq)) ? Number(first.seq) : null,
      launchMode: first.launchMode ?? null,
      tierEffective: first.tierEffective ?? null,
      fallbackClass: first.fallbackClass ?? null,
      fallbackReason: first.fallbackReason ?? null
    } : null,
    rootLoss: loss ? {
      everLost: loss.everLost === true,
      count: num(loss.count),
      lastReason: loss.lastReason ?? null,
      lastAt: loss.lastAt ?? null,
      lastPhase: loss.lastPhase ?? null,
      lastSeq: Number.isFinite(Number(loss.lastSeq)) ? Number(loss.lastSeq) : null,
      observedAt: Array.isArray(loss.observedAt) ? [...loss.observedAt] : []
    } : null
  };
}
function advanceLaneHistory(previous, lane) {
  const record = previous && typeof previous === "object" ? previous : {};
  const prior = summarizeLaneHistory(record);
  const degraded = lane?.degraded === true;
  const commandSeq = (prior.commandSeq ?? 0) + 1;
  const firstDegrade = prior.firstDegrade ?? (degraded ? {
    at: lane?.at ?? (/* @__PURE__ */ new Date()).toISOString(),
    seq: commandSeq,
    launchMode: lane?.launchMode ?? null,
    tierEffective: lane?.tierEffective ?? null,
    fallbackClass: lane?.fallbackClass ?? classifyLaneFallback(lane?.fallbackReason).code,
    fallbackReason: lane?.fallbackReason ?? null
  } : null);
  return {
    commandSeq,
    shimCount: prior.shimCount + (degraded ? 0 : 1),
    degradeCount: prior.degradeCount + (degraded ? 1 : 0),
    firstDegrade,
    rootLoss: prior.rootLoss
  };
}
function noteStageRootLoss(dir, info = {}) {
  if (typeof dir !== "string" || dir.length === 0) return null;
  const previous = readLaneJournalFile(dir).record;
  const prior = summarizeLaneHistory(previous);
  const entry = {
    everLost: true,
    count: (prior.rootLoss?.count ?? 0) + 1,
    lastReason: info.reason ?? "unknown",
    lastAt: info.at ?? (/* @__PURE__ */ new Date()).toISOString(),
    lastPhase: info.phase ?? "unknown",
    lastSeq: Number.isFinite(Number(previous?.seq)) ? Number(previous.seq) : null,
    observedAt: [...new Set([...prior.rootLoss?.observedAt ?? [], info.phase ?? "unknown"].filter((x) => typeof x === "string"))]
  };
  try {
    writeFileSync2(
      join2(dir, LANE_JOURNAL_BASENAME),
      `${JSON.stringify(
        {
          ...previous ?? {},
          kind: previous?.kind ?? "winstage-sandbox-lane",
          history: { ...previous?.history ?? {}, ...prior, rootLoss: entry }
        },
        null,
        2
      )}
`,
      "utf8"
    );
    return entry;
  } catch {
    return null;
  }
}
function locatePackageFile(relativePath, rootsOverride) {
  let roots = [];
  try {
    roots = rootsOverride ?? resolveDshModuleRoot() ?? [];
  } catch {
    roots = [];
  }
  for (const root of roots) {
    if (!root) continue;
    const candidate = join2(root, relativePath);
    if (existsSync2(candidate)) return candidate;
  }
  return void 0;
}
function sameRootText(a, b) {
  const norm = (value) => typeof value === "string" ? value.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() : "";
  const left = norm(a);
  return left.length > 0 && left === norm(b);
}
function workspaceRootsOfLoaderRows(data) {
  const out = {};
  if (!Array.isArray(data)) return out;
  const rows = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    rows.push(item);
    if (Array.isArray(item.insert)) {
      for (const inner of item.insert) if (inner && typeof inner === "object") rows.push(inner);
    }
  }
  const text = (value) => typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
  for (const row of rows) {
    const config = row.config;
    if (!config || typeof config !== "object") continue;
    if (row.id === "winstage-fs") out.fsRoot = text(config.cwd) ?? text(config.workspaceRoot);
    else if (row.id === "winstage-shell") out.shellRoot = text(config.workspaceRoot);
  }
  return out;
}
var NeutralShellExecutorBase = class {
  constructor() {
  }
};
function defaultResolveShellModule() {
  return locatePackageFile(join2("@deepseek-ai", "dsh-shell", "lib", "index.js"));
}
var NATIVE_PWSH_MODULE = "@deepseek-ai/dsh-pwsh-local/lib/index.js";
function resolvePwshPath(configured, env = process.env) {
  if (typeof configured === "string" && configured.length > 0) return configured;
  const spawnable = (candidate) => {
    try {
      const stat = lstatSync(candidate);
      return stat.isFile() || stat.isSymbolicLink();
    } catch {
      return false;
    }
  };
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? "C:\\Program Files";
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  const candidates = [join2(programFiles, "PowerShell", "7", "pwsh.exe")];
  for (const entry of String(env.PATH ?? "").split(";")) {
    const trimmed = entry.trim().replace(/^"|"$/g, "");
    if (trimmed.length === 0) continue;
    candidates.push(join2(trimmed, "pwsh.exe"));
  }
  candidates.push(join2(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  for (const candidate of candidates) if (spawnable(candidate)) return candidate;
  return "pwsh";
}
var PWSH_LEADING = /^(?:(?<launcher>"[^"]+"|(?!-)\S+)(?=\s)\s+)?(?<flags>(?:-\S+\s+)*?)-command\s+(?<script>[\s\S]+)$/i;
var PWSH_EXE = /(?:^|[\\/])pwsh(?:\.exe)?$/i;
var LEGACY_POWERSHELL_EXE = /(?:^|[\\/])powershell(?:\.exe)?$/i;
function buildCommandArgv(command, pwshPath) {
  const text = String(command ?? "");
  const match = PWSH_LEADING.exec(text);
  if (match?.groups?.script !== void 0) {
    const script = match.groups.script;
    const launcher = (match.groups.launcher ?? "").trim().replace(/^"|"$/g, "");
    const flags = String(match.groups.flags ?? "").trim().split(/\s+/).filter((token) => token.length > 0);
    if (launcher.length === 0 || PWSH_EXE.test(launcher) || LEGACY_POWERSHELL_EXE.test(launcher)) {
      return {
        command: pwshPath,
        args: [...flags, "-Command", `${ENCODING_PREAMBLE}${script}`],
        recognized: true
      };
    }
  }
  const foreignCommand = /^(?:"[^"]+"|(?!-)\S+)(?=\s)\s+(?:-\S+\s+)*-command\s+[\s\S]+$/i.test(text);
  if (!foreignCommand) {
    return { command: pwshPath, args: ["-Command", `${ENCODING_PREAMBLE}${text}`], recognized: true };
  }
  const tokens = text.match(/"[^"]*"|\S+/g) ?? [];
  const first = (tokens[0] ?? "").replace(/^"|"$/g, "");
  if (first.length === 0) return { command: pwshPath, args: ["-Command", ENCODING_PREAMBLE], recognized: false };
  return {
    command: first,
    args: tokens.slice(1).map((token) => token.replace(/^"|"$/g, "")),
    recognized: false
  };
}
function numericOption(raw, key, fallback) {
  const slot = raw?.[key];
  const value = slot && typeof slot === "object" && typeof slot.get === "function" ? slot.get() : slot;
  return Number.isFinite(value) && value > 0 ? Number(value) : fallback;
}
function stringOption(raw, key) {
  const slot = raw?.[key];
  const value = slot && typeof slot === "object" && typeof slot.get === "function" ? slot.get() : slot;
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
var NETWORK_TIERS = /* @__PURE__ */ new Set(["OBSERVED_ONLINE", "OFFLINE"]);
function normalizeNetworkTier(value) {
  if (typeof value !== "string" || value.length === 0) return "OBSERVED_ONLINE";
  const upper = value.toUpperCase();
  return NETWORK_TIERS.has(upper) ? upper : "OBSERVED_ONLINE";
}
function boundedOutput(text, maxBytes) {
  const buffer = Buffer.from(text ?? "", "utf8");
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_OUTPUT_BYTES;
  if (buffer.length <= cap) return { text: buffer.toString("utf8"), truncated: false };
  return { text: buffer.subarray(buffer.length - cap).toString("utf8"), truncated: true };
}
function makeOffsetReader(text) {
  const buffer = Buffer.from(String(text ?? ""), "utf8");
  return {
    readFrom(fromByte) {
      const from = Number.isFinite(fromByte) && fromByte > 0 ? Math.floor(fromByte) : 0;
      const lossy = from > buffer.length;
      return {
        text: buffer.subarray(lossy ? 0 : from).toString("utf8"),
        nextOffset: buffer.length,
        lossy
      };
    }
  };
}
function publishWorkspaceSnapshot(sessionId, workspaceRoot) {
  const service = getReviewService({
    workspaceRoot,
    ...typeof sessionId === "string" && sessionId.length > 0 ? { sessionId } : {}
  });
  return service.publish();
}
function shellFailure(code, message) {
  const error = new Error(String(message));
  error.code = code;
  error.winstage = { code, executed: false };
  return error;
}
var MSI_UNSUPPORTED_MESSAGE = "MSI \u5B89\u88C5\uFF08msiexec / msiserver\uFF09\u5728\u5F53\u524D\u6A21\u5F0F\u4E0B\u4E0D\u88AB\u5141\u8BB8\uFF0C\u672C\u6B21\u672A\u6267\u884C\uFF1B\u8BE5\u65B9\u5F0F\u4F9D\u8D56\u7CFB\u7EDF\u7EA7\u5B89\u88C5\u670D\u52A1\uFF0C\u8BF7\u6539\u7528\u4FBF\u643A\u5F0F/\u514D\u5B89\u88C5\u5206\u53D1\u65B9\u5F0F\uFF0C\u6216\u6539\u7528\u4E0D\u4F9D\u8D56 MSI \u670D\u52A1\u7684\u5B89\u88C5\u65B9\u5F0F\uFF08\u89C1 docs/round16/exe-\u7F3A\u9677.md \u7684 R16-D3-2\uFF09\u3002";
var SHELL_FAILURE_CLASSIFICATION = Object.freeze({
  // ③ 普通失败：**输入/用法**问题（空命令）不是"策略拒绝"，也不是"环境坏了"
  WINSTAGE_SHELL_BAD_COMMAND: { category: FAILURE_SEMANTICS.COMMAND },
  // ② 环境故障：可重试；**不得**与策略拒绝共用文案
  WINSTAGE_SHELL_NO_WORKSPACE: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  WINSTAGE_SHELL_NO_STAGED_ROOT: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  WINSTAGE_SHELL_EXECUTION_BACKEND_UNAVAILABLE: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  WINSTAGE_SHELL_EXECUTOR_INVALID: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  WINSTAGE_SHELL_INIT_FAILED: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  WINSTAGE_SHELL_MATERIALIZE_FAILED: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  WINSTAGE_SHELL_BASE_MISSING: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  WINSTAGE_SHELL_BASE_LOAD_FAILED: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  WINSTAGE_SHELL_WORKSPACE_FAILED: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  // ── R16-D3-2：MSI 家族命令在 WinStage 接管时 fail-closed ─────────────────────────
  //   category 选 **POLICY**：本表 policy 族的定义就是"**本就不允许的操作**"
  //   （`src/executor.ts:4188`）；"该命令在**当前模式**下不被允许"正是这个语义，
  //   且 `CLEARTEXT_CREDENTIAL_IN_REQUEST`（下一行）已是"模式相关拒绝"的先例。
  //   为什么不选 ENVIRONMENT：那会让 `retryable=true`，把"重试一万次也不会成功"
  //   说成"可重试的环境故障"—— 与事实相反。
  //   为什么不选 COMMAND：其文案是 `COMMAND_FAILED: 命令失败。`，会被读成
  //   "命令跑了但失败"；而本闸门在**任何执行动作之前**抛错 ⇒ 事实是"未执行"。
  //   （Lead 2026-10-11 裁定：D1=POLICY、D2=fail-closed、D3=保守触发面。）
  WINSTAGE_SHELL_MSI_UNSUPPORTED: { category: FAILURE_SEMANTICS.POLICY, presetMessage: MSI_UNSUPPORTED_MESSAGE },
  // WP7′：明文出站请求里出现密钥形态 ⇒ 判定"该请求不被允许"（policy 族，独立机读码）
  CLEARTEXT_CREDENTIAL_IN_REQUEST: { category: FAILURE_SEMANTICS.POLICY, presetMessage: CLEARTEXT_SECRET_FAILURE.message },
  // ③ 普通失败（`RUN_FAILED` 逐条命令判定；见 `runFailureClassification()`）
  WINSTAGE_SHELL_RUN_FAILED: { category: FAILURE_SEMANTICS.COMMAND }
});
function semanticCodeOf(category) {
  return FAILURE_CATEGORY_CODES[category] ?? FAILURE_CATEGORY_CODES[FAILURE_SEMANTICS.COMMAND];
}
function semanticShellFailure(technicalCode, options = {}) {
  const entry = SHELL_FAILURE_CLASSIFICATION[technicalCode];
  const category = options.category ?? entry?.category ?? FAILURE_SEMANTICS.COMMAND;
  const code = semanticCodeOf(category);
  const classified = classifyFailureSemantics({ code: technicalCode, category });
  const detail = typeof options.detail === "string" ? options.detail : "";
  const baseMessage = options.presetMessage ?? classified.message;
  const message = `${code}: ${baseMessage}${detail.length > 0 ? ` ${detail}` : ""}`;
  const violations = transparencyViolations(message);
  const error = shellFailure(code, message);
  error.category = category;
  error.retryable = classified.retryable === true;
  error.indeterminate = options.indeterminate === true;
  error.winstage = {
    code,
    technicalCode,
    category,
    classification: classified.classification,
    retryable: classified.retryable === true,
    indeterminate: options.indeterminate === true,
    executed: options.indeterminate === true ? "unknown" : false,
    transparencyViolations: violations,
    ...options.winstage ?? {}
  };
  return error;
}
function msiFamilyCommandVerdict(command) {
  const verdict = { blocked: false, matched: null, head: null };
  const text = typeof command === "string" ? command : "";
  if (text.trim().length === 0) return verdict;
  const basename = (token) => {
    let t = String(token).trim().replace(/^["']+|["']+$/g, "");
    t = t.replace(/[.,;:]+$/g, "").replace(/\.exe$/i, "");
    const cut = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
    return (cut >= 0 ? t.slice(cut + 1) : t).toLowerCase();
  };
  const tokenize = (s) => s.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const LAUNCHERS = /* @__PURE__ */ new Set(["cmd", "powershell", "pwsh", "start-process", "iex", "invoke-expression", "start-job"]);
  const isFlag = (tok) => {
    const s = String(tok).trim().replace(/^["']|["']$/g, "");
    if (s.startsWith("-")) return true;
    if (s.startsWith("/")) return !/[/\\]/.test(s.slice(1));
    return false;
  };
  const scan = (segment, depth) => {
    const tokens = tokenize(segment);
    let i = 0;
    while (i < tokens.length) {
      if (LAUNCHERS.has(basename(tokens[i])) || isFlag(tokens[i])) {
        i++;
        continue;
      }
      break;
    }
    if (i >= tokens.length) return null;
    const headToken = tokens[i];
    const head = basename(headToken);
    if (head === "msiexec" || head === "msiserver") return { matched: head, head: headToken };
    for (let j = i; j + 2 < tokens.length; j++) {
      const a = basename(tokens[j]);
      const b = basename(tokens[j + 1]);
      const c = basename(tokens[j + 2]);
      if ((a === "sc" || a === "net") && b === "start" && c === "msiserver") {
        return { matched: `${a} start msiserver`, head: tokens[j] };
      }
    }
    if (depth < 2 && /^["']/.test(headToken)) {
      const inner = headToken.replace(/^["']|["']$/g, "");
      if (/\s/.test(inner)) return scan(inner, depth + 1);
    }
    return null;
  };
  for (const segment of text.split(/\r?\n|;|\|\||&&|&|\|/g)) {
    const hit = scan(segment, 0);
    if (hit) return { blocked: true, matched: hit.matched, head: hit.head };
  }
  return verdict;
}
function runFailureClassification(error) {
  const message = String(error?.message ?? error ?? "");
  const stdout = String(error?.stdout ?? "");
  const producedOutput = stdout.trim().length > 0;
  const observedSideEffects = error?.sideEffectsObserved === true || error?.childRan === true;
  const channelNote = /dsh-stage:/i.test(message);
  const evidence = [];
  if (producedOutput) evidence.push("stdout-has-output");
  if (observedSideEffects) evidence.push("side-effects-observed");
  if (channelNote) evidence.push("runner-note-present");
  const contradiction = /access is denied|0x80070005|e_accessdenied|unauthorizedaccessexception|permissiondenied/i.test(message);
  const indeterminate = evidence.length > 0 || contradiction;
  return {
    category: FAILURE_SEMANTICS.COMMAND,
    indeterminate,
    evidence,
    /** 用户侧一句话（可含机制措辞）：这条**不进**模型可见通道 */
    userDetail: indeterminate ? '\u6267\u884C\u901A\u9053\u62A5\u9519\uFF0C\u4F46\u540C\u65F6\u5B58\u5728\u6267\u884C\u8BC1\u636E/\u62D2\u7EDD\u58F0\u660E\u77DB\u76FE \u21D2 \u7ED3\u8BBA\u964D\u7EA7\u4E3A"\u4E0D\u786E\u5B9A"\uFF0C\u4E0D\u5F97\u65AD\u8A00\u672A\u6267\u884C\u3002' : "\u6267\u884C\u901A\u9053\u672A\u7ED9\u51FA\u53EF\u7528\u7ED3\u679C\uFF0C\u4E14\u6CA1\u6709\u6267\u884C\u8BC1\u636E\u3002"
  };
}
function currentWorkspaceOf(source) {
  if (!source) return void 0;
  if (typeof source === "function") return currentWorkspaceOf(source());
  if (typeof source === "object" && typeof source.reload === "function") {
    try {
      source.reload();
    } catch {
    }
    return source.workspace ?? source;
  }
  return source;
}
function createWinStageShellExecutor(options = {}) {
  const injectedBase = options.base;
  if (injectedBase !== void 0 && typeof injectedBase !== "function") {
    throw new TypeError("createWinStageShellExecutor: options.base must be a class when supplied");
  }
  const Base = injectedBase ?? NeutralShellExecutorBase;
  const resolveShellModule = options.resolveShellModule ?? defaultResolveShellModule;
  const createExecutor = options.createExecutor;
  const configDefaults = options.config ?? {};
  const workspaceFor = typeof options.workspaceFor === "function" ? options.workspaceFor : void 0;
  return class WinStageShellExecutor extends Base {
    /**
     * ★ **刻意不声明 `static Config`** —— 这是一个实测出来的**激活阻断**，不是遗漏。
     *
     * 曾经这里是普通对象 `{ cwd:'', timeoutMs:… }`，注释还写着"普通对象也是合法 schema"。
     * 那句话是**错的**：cordis 的 `resolveConfig` 会调 `Config['~standard'].validate(...)`
     * （`cordis/lib/index.js:958`），普通对象没有 `~standard` ⇒ 抛
     *   `TypeError: Cannot read properties of undefined (reading 'validate')`
     * ⇒ 本行**根本没激活**（`ctx.shell` 不存在）⇒ `tool-pwsh` 永远
     *   `pending (waiting for service: shell)` ⇒ **会话里连 pwsh 工具都没有**。
     * 实测证据：`.t/shell-e2e.log` 的 `dsh: warning: 3 entries did not activate`；
     * `dsh-plugin/schema.js` 的文件头逐字记着同一个失败形态（那里是为了另一个行解决的）。
     *
     * 基类 `ShellExecutor` 本身**没有** `Config`，行 config 依然会被传进构造函数，
     * 所以"不声明"既不丢功能也不改变契约。若将来确实要 schema 校验，必须用
     * `schema.js` 那套自带 `~standard.validate` + `toJSON()` 的节点，**不能**用普通对象。
     */
    static inject = [];
    constructor(ctx, config) {
      super(ctx, "shell", config);
      try {
        options.onConfig?.(config ?? void 0);
      } catch (error) {
        try {
          console.error(`[winstage-shell] onConfig \u5931\u8D25\uFF08\u884C config \u672A\u80FD\u4EA4\u7ED9\u88C5\u914D\u65B9\uFF09\uFF1A${error?.message ?? error}`);
        } catch {
        }
      }
      const raw = { ...configDefaults, ...config ?? {} };
      this.rawConfig = raw;
      this.log = options.log ?? ((message) => {
        try {
          const logger = ctx?.logger;
          if (logger && typeof logger.info === "function") return logger.info(message);
        } catch {
        }
        try {
          console.log(`[winstage-shell] ${message}`);
        } catch {
        }
      });
      this.logError = options.logError ?? ((message) => {
        const line = `[winstage-shell] ${message}`;
        try {
          const logger = ctx?.logger;
          if (logger && typeof logger.warn === "function") return logger.warn(line);
          if (logger && typeof logger.error === "function") return logger.error(line);
        } catch {
        }
        try {
          console.error(line);
        } catch {
        }
      });
      this.timeoutMs = numericOption(raw, "timeoutMs", DEFAULT_TIMEOUT_MS);
      this.maxTimeoutMs = Math.max(numericOption(raw, "maxTimeoutMs", DEFAULT_MAX_TIMEOUT_MS), this.timeoutMs);
      this.stdoutMaxBytes = numericOption(raw, "maxOutputBytes", DEFAULT_MAX_OUTPUT_BYTES);
      this.pwshPathConfig = stringOption(raw, "pwshPath");
      this.mode = stringOption(raw, "mode") ?? "workspace-write";
      this.tier = stringOption(raw, "tier") ?? stringOption(process.env, "WINSTAGE_TIER") ?? "auto";
      this.networkTier = normalizeNetworkTier(
        stringOption(process.env, "WINSTAGE_NETWORK_TIER") ?? stringOption(raw, "networkTier")
      );
      this.workspaceSource = options.workspace ?? options.store;
      this.fixedSessionId = stringOption(options, "sessionId");
      this.declaredRoot = stringOption(raw, "workspaceRoot");
      this.diagLogPath = stringOption(raw, "diagLog") ?? stringOption(process.env, "WINSTAGE_DIAG_LOG");
      this.publishFor = typeof options.publishFor === "function" ? options.publishFor : publishWorkspaceSnapshot;
      this.resolveShellModule = resolveShellModule;
      this.executorFactory = createExecutor;
      this.resolvedBasePromise = void 0;
      this.baseUnavailable = false;
      this.rootEntry = ctx?.fiber?.entry;
      this.nativeExecutor = void 0;
      this.nativeExecutorPromise = void 0;
    }
    // ==================== 能力/围栏事实 ====================
    /**
     * loader patch 组合后的行表（`entry.parent.data`）。读不到就返回 `undefined`
     * （离线自测、行被移除、ctx 形态不同）—— 调用方必须能在这条通路上失败。
     */
    loaderRows() {
      try {
        return (this.rootEntry ?? this.ctx?.fiber?.entry)?.parent?.data;
      } catch {
        return void 0;
      }
    }
    /**
     * **生效的工作区根** —— shell 半边与 fs 半边取同一个根的唯一入口。
     *
     * 取值顺序与理由见 `shell-entry.ts` 文件头"工作区根从哪来"。要点：
     *   1. `winstage-fs` 行的 `cwd`（fs 半边真正的存储根）**权威**；
     *   2. `winstage-shell` 行的 `workspaceRoot`（同一根的另一处声明）；
     *   3. 行 config 经 `onConfig` 落下的显式值（`this.declaredRoot`）。
     * 1 与 2 都在且不同 ⇒ **error 级报警**（人工侧）并**以 fs 根为准**：宁可响，
     * 也绝不让 `getReviewService` 按两个根分叉出第二个单例（面板看不到命令产出）。
     *
     * 返回 `undefined` 时由入口的 `declaredWorkspaceRoot()` **抛错**（不再猜 cwd）。
     */
    effectiveWorkspaceRoot() {
      let fsRoot;
      let shellRoot;
      try {
        ;
        ({ fsRoot, shellRoot } = workspaceRootsOfLoaderRows(this.loaderRows()));
      } catch {
        fsRoot = void 0;
        shellRoot = void 0;
      }
      if (fsRoot && shellRoot && !sameRootText(fsRoot, shellRoot)) {
        this.logError(
          `\u914D\u7F6E\u6F02\u79FB\uFF1Afs \u884C cwd(${fsRoot}) \u4E0E shell \u884C workspaceRoot(${shellRoot}) \u4E0D\u662F\u540C\u4E00\u4E2A\u6839\uFF1B\u5DF2\u6309 fs \u884C\u7684\u6839\u7EE7\u7EED\uFF08\u5426\u5219\u6309\u6839\u505A\u5355\u4F8B\u7684\u5BA1\u9605\u670D\u52A1\u4F1A\u5206\u53C9\uFF0C\u9762\u677F\u770B\u4E0D\u5230\u547D\u4EE4\u4EA7\u51FA\uFF09\u3002\u8BF7\u8BA9 profile \u8986\u76D6\u5C42\u628A\u4E24\u4E2A\u952E\u91CD\u8FF0\u6210\u540C\u4E00\u4E2A\u503C\uFF08bundle \u5C42\u7528 YAML \u951A\u70B9\u7ED1\u6B7B\uFF09\u3002`
        );
        return fsRoot;
      }
      return fsRoot ?? shellRoot ?? this.declaredRoot;
    }
    /**
     * WinStage **此刻**是否应当接管执行面 —— 与 `staging-fs.stagingEnabled()`
     * **同一个真源、同一套读法**：读 loader 行 `winstage-sandbox` 的 `config.enabled`，
     * 每次调用现读（`rootEntry.parent.data` 是 patch 组合后的那一份，改开关即时生效）。
     *
     * 树里找不到该行（离线自测、行被移除）时默认 `true`：保持"接管"这一历史行为，
     * 与 `staging-fs` 的 fail-open 口径一致（关不掉比静默不管更安全）。
     */
    winStageEnabled() {
      try {
        const data = this.loaderRows();
        if (!Array.isArray(data)) return true;
        const row = data.find((item) => item && item.id === "winstage-sandbox");
        if (!row || !row.config) return true;
        return row.config.enabled !== false;
      } catch {
        return true;
      }
    }
    /**
     * **显式诊断出口**（默认关闭）：把沙箱事实写进一个人工指定的 JSONL 文件。
     *
     * 这是"痕迹清除"的落点之一：模型可见的 stdout/stderr 必须与命令自己的输出
     * **逐字节一致**，因此本插件不再往 stderr 注入任何注记；诊断只在人工显式给出
     * `WINSTAGE_DIAG_LOG`（或装配方注入 `config.diagLog`）时才落盘。任何失败都吞掉
     * ——诊断绝不影响命令结果。
     */
    writeDiagnostics(record) {
      if (!this.diagLogPath) return;
      try {
        appendFileSync(this.diagLogPath, `${JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), ...record })}
`, "utf8");
      } catch {
      }
    }
    /**
     * ★ BUG-B：把"最近一次档位判定"落成**可查询产物**（会话存储根 `sandbox-lane.json`）。
     *
     * 为什么落盘而不是只留在内存里：`/winstage status` 由**另一个模块**
     * （`host-plugin.ts`）渲染，而且用户排查时进程可能已经重启过 ——
     * 内存里的 `lastLane` 活不过一次重启，"沙箱是否真的生效"就又要靠猜。
     *
     * 落点选 `workspace.store.dir`（= 会话存储根，manifest/queue/review 那一层，
     * 不是暂存树）：写进暂存树会被"提取暂存树变化"当成工作区改动摄取。
     *
     * 失败**必须响**（error 级日志，人工侧），但绝不改变命令结果、绝不进模型通道。
     *
     * @param {object} lane 档位记录（`launchMode/tierEffective/fallbackReason/requestedTier/…`）
     * @param {object} workspace 本次执行的工作区（取 `store.dir`）
     */
    persistLane(lane, workspace) {
      this.lastLane = lane;
      const dir = workspace?.store?.dir;
      if (typeof dir !== "string" || dir.length === 0) return void 0;
      const file = join2(dir, LANE_JOURNAL_BASENAME);
      try {
        const previous = readLaneJournalFile(dir).record;
        const history = advanceLaneHistory(previous, lane);
        const record = {
          kind: "winstage-sandbox-lane",
          ...lane,
          summary: summarizeLane(lane),
          /** 持久化的命令序号（跨进程续算）："第几条命令掉档"的"条"就是它 */
          seq: history.commandSeq,
          history
        };
        writeFileSync2(file, `${JSON.stringify(record, null, 2)}
`, "utf8");
        return history;
      } catch (error) {
        this.logError(
          `\u6863\u4F4D\u5224\u5B9A\u8BB0\u5F55\u5199\u76D8\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u547D\u4EE4\u7ED3\u679C\u3001\u4E0D\u6539\u53D8\u547D\u4EE4\u8F93\u51FA\uFF09\uFF1A${file}\uFF1A${error?.message ?? error}\u3002\u8BE5\u6B21\u5224\u5B9A\u4ECD\u53EF\u4ECE\u672C\u6B21\u6267\u884C\u7684 handle.winstage.notes \u770B\u5230\u3002`
        );
        return void 0;
      }
    }
    /**
     * ★ WP3：**失根观测**（每次命令执行前跑一次）。
     *
     * `verifyStageRootAlive()` 只在有人**问**的时候才回答 —— 没人问，"根被外部清掉"
     * 就没有任何历史痕迹，用户看到的仍是上一次的"一切正常"。这里把观测点钉在
     * **每次命令执行前**，失败计数落进同一份档位产物（`history.rootLoss`）。
     *
     * 观测**不改变本次执行的任何结论**：不抛、不改返回值、不进模型可见输出，
     * 只在用户侧（error 级日志）如实记一条。真正抛 `STAGE_ROOT_LOST` 的是写入路径
     * （`src/store.ts::assertStageAvailable()`），本方法只负责"让这件事看得见"。
     *
     * @returns {{alive: boolean, reason?: string, root?: string}|undefined}
     */
    observeStageRoot(workspace, phase = "exec") {
      const store = workspace?.store;
      if (!store || typeof store.stageStatus !== "function") return void 0;
      let status;
      try {
        status = store.stageStatus();
      } catch (error) {
        status = { alive: false, reason: `status-threw: ${error?.message ?? error}` };
      }
      if (status?.alive === true) return status;
      const entry = noteStageRootLoss(store.dir, { reason: status?.reason ?? "not-alive", phase });
      this.logError(
        `\u5931\u6839\u89C2\u6D4B\uFF08${phase}\uFF09\uFF1A\u4F1A\u8BDD\u5DE5\u4F5C\u6839\u4E0D\u53EF\u7528\uFF08reason=${status?.reason ?? "not-alive"}\uFF09${entry ? `\uFF1B\u672C\u4F1A\u8BDD\u7D2F\u8BA1\u89C2\u6D4B\u5230 ${entry.count} \u6B21\uFF0C\u6700\u8FD1\u4E00\u6B21 ${entry.lastAt}` : "\uFF1B\u672C\u6B21\u672A\u80FD\u843D\u76D8\u8BB0\u5F55"}\u3002\u5728\u5B83\u6062\u590D\u4E4B\u524D\uFF0C\u5199\u5165\u4F1A\u4EE5 STAGE_ROOT_LOST \u5931\u8D25\uFF08\u4E0D\u4F1A\u9759\u9ED8\u6539\u5199\u771F\u5B9E\u6587\u4EF6\uFF09\u3002`
      );
      return status;
    }
    /**
     * ⚠ **保留但不再调用** —— "把执行面交还平台原生执行器"这条路已实测**不可行**。
     *
     * 三次实测的原始报错（按此顺序）：
     *   ① `new PwshLocalExecutor(ctx, cfg)` ⇒
     *      `service "shell" has been registered at <WinStageShellExecutor>`
     *      （`ShellExecutor extends Service`，构造即 `ctx.provide('shell', this)`，
     *      与本行占用的单例名冲突；`cordis/lib/index.js:813`）
     *   ② 用 no-op `provide` 的替身 ctx 绕过注册 ⇒ 构造通过，但原生 `execute()`
     *      经 `this.ctx.subprocess.spawn(...)`（`dsh-pwsh-local/lib/index.js:306`）⇒
     *      `cannot get property "subprocess" without inject`
     *      （`subprocess` 未注入本 fiber；替身 ctx 不改变 Cordis 的属性访问门）
     *   ③ 捕获②并降级执行 ⇒ 该报错仍从 try 之外逸出（根因在 ctx 属性访问层，未定位）
     *
     * ⇒ 现行语义（`execute()`）：**不交还**；档位不匹配时按本执行器自己的
     * `workspace-write` 围栏执行，并把不匹配**显式报响**（error 级日志 + 返回注记）。
     * 本方法连同 `NATIVE_PWSH_MODULE` 已无调用点，**不再删除**只为保留上述取证位置；
     * 它已不参与任何执行路径。
     */
    async nativeExecutorFor() {
      if (this.nativeExecutor) return this.nativeExecutor;
      if (!this.nativeExecutorPromise) {
        this.nativeExecutorPromise = (async () => {
          const modulePath = locatePackageFile(NATIVE_PWSH_MODULE);
          if (!modulePath) {
            throw shellFailure(
              "WINSTAGE_SHELL_NATIVE_MISSING",
              `\u65E0\u6CD5\u5B9A\u4F4D ${NATIVE_PWSH_MODULE}\uFF1B\u8BF7\u63D0\u4F9B\u5305\u542B @deepseek-ai/* \u7684 node_modules \u6839\u3002`
            );
          }
          let loaded;
          try {
            loaded = await import(pathToFileURL(modulePath).href);
          } catch (error) {
            throw shellFailure(
              "WINSTAGE_SHELL_NATIVE_LOAD_FAILED",
              `\u65E0\u6CD5 import ${modulePath}\uFF1A${error?.message ?? error}\u3002`
            );
          }
          const klass = loaded?.PwshLocalExecutor ?? loaded?.default;
          if (typeof klass !== "function") {
            throw shellFailure(
              "WINSTAGE_SHELL_NATIVE_LOAD_FAILED",
              `${modulePath} \u6CA1\u6709\u5BFC\u51FA PwshLocalExecutor\u3002`
            );
          }
          const nativeProps = {};
          try {
            if (klass.Config && typeof klass.Config === "function") {
              nativeProps.config = klass.Config(this.rawConfig ?? {});
            }
          } catch {
            nativeProps.config = this.rawConfig ?? {};
          }
          const stubCtx = Object.create(this.ctx);
          stubCtx.provide = () => {
          };
          const instance = new klass(stubCtx, nativeProps.config ?? this.rawConfig ?? {});
          instance.ctx = this.ctx;
          this.nativeExecutor = instance;
          return instance;
        })();
      }
      return this.nativeExecutorPromise;
    }
    /**
     * ★★ **不要改回 `undefined`** —— 这一行是**实测挡下来**的，不是图省事。★★
     *
     * 必须报一个模式：`dsh-permission-presets`（在 `dsh-base` 里、**默认必装**）会拒绝装配，
     * 原始报错（**原始日志**：`.t/e2e2.log:1-2`）：
     *   `dsh: warning: 1 entry did not activate`
     *   `permission (@deepseek-ai/dsh-permission-presets): Error: permission: the mounted bash
     *    executor does not confine (no sandboxMode) — presets bundle a sandbox mode, so composing
     *    this plugin over an unconfined executor is a misconfiguration`
     * ⇒ 报 `undefined` 会让 `permission` 那一行**装不上**（`sandboxPolicy` 服务随之缺失）。
     *
     * 反过来说，报一个模式会让 `dsh-tool-pwsh` 向模型广告 `sandbox_permissions` 升权并期望
     * 本执行器按 `sandboxPolicy` 围栏 —— 那是**另一条**实测结论：本执行器**不接受任何升权**，
     * 请求更宽档位只记 error 级日志 + 返还注记（`execute()` 的 `mismatched` 分支），
     * 绝不改写语义、绝不放大权限。两者相加才是现在的形态：**报最窄可用档位 + 拒绝放大**。
     *
     * 对应断言（改这一行会立刻见红，别绕过它们去改断言）：
     *   `.t/shell-selftest.ts` S1.2 / S1.2b / S1.2c（必须 === `'workspace-write'`、不得 undefined、
     *   不得广告更宽档位）、S3b.2（变异体只摘 fail-closed 闸时本值不变）、M1（变异体改成
     *   `undefined` ⇒ 上述断言必然 FAIL）。
     *
     * 历史备注（保留取证，勿据此改回）：本文件早期确实刻意报过 `undefined`
     * （理由：我们自己就是围栏、不广告升权），那正是 `.t/e2e2.log` 记下的那次装配失败。
     */
    get sandboxMode() {
      return "workspace-write";
    }
    /**
     * 当前工作区（可能来自函数/服务/实例三种形态）。
     *
     * `resolve()` 用 `{ bestEffort: true }` 调用：那一步承诺**不碰磁盘**，
     * 而 `getReviewService` 会做 `adoptLegacyStore`/`absorbSharedStore` 这类
     * "认领别处内容"的动作 —— 在填默认值的时候顺手搬存储是意外副作用。
     * `execute()` 用严格模式：拿不到工作区就是 fail-closed 抛错。
     */
    currentWorkspace({ bestEffort = false } = {}) {
      if (workspaceFor) {
        let resolved;
        try {
          resolved = workspaceFor(this.sessionIdOf(), this.effectiveWorkspaceRoot());
        } catch (error) {
          if (bestEffort) return void 0;
          this.logError(
            `\u89E3\u6790\u672C\u6B21\u4F1A\u8BDD\u7684\u5DE5\u4F5C\u533A\u5931\u8D25\uFF08\u4F1A\u8BDD ${this.sessionIdOf() ?? "(none)"}\uFF09\uFF1A${error?.message ?? error}`
          );
          throw semanticShellFailure("WINSTAGE_SHELL_WORKSPACE_FAILED", {
            winstage: { technicalDetail: String(error?.message ?? error) }
          });
        }
        return resolved;
      }
      try {
        return currentWorkspaceOf(this.workspaceSource);
      } catch (error) {
        if (bestEffort) return void 0;
        this.logError(`\u89E3\u6790\u5DE5\u4F5C\u533A\u5931\u8D25\uFF1A${error?.message ?? error}`);
        throw semanticShellFailure("WINSTAGE_SHELL_WORKSPACE_FAILED", {
          winstage: { technicalDetail: String(error?.message ?? error) }
        });
      }
    }
    /**
     * 调用方的**会话身份** —— 与 `staging-fs.ts` 同一个口径：
     *   1. 构造时显式注入的 `sessionId`（装配/自测）；
     *   2. 本次执行的 `sandboxPolicy.sessionId`（工具层按**调用方会话**解析后塞进 spec）；
     *   3. ambient initiator（`ctx.agents.currentInitiator()`）。
     * 拿不到 ⇒ `undefined` ⇒ 落到共享存储（与 `staging-fs` 的降级行为一致）。
     *
     * ── 本轮修复（用户报障"子 agent 没有包含在沙箱里"）────────────────────────────
     * ① **不再刻意忽略 `sandboxPolicy.sessionId`**：旧注释写"本执行器不接受升权，
     *    也就不需要策略里的任何东西"——那句话把"升权档位"与"调用方身份"混为一谈。
     *    身份是**审批面归属**，不是权限；忽略它 ⇒ 子 agent 的命令产出落到别处
     *    （或共享存储），父会话面板上一行都不出现。
     * ② 无论身份来自哪一档，都经 `rootSessionIdOf()` **归到顶层祖先会话**：
     *    DSH 给每个委派子会话一个自己的 id，而用户是**一轮任务一个面板**。
     *    不归并的话，子 agent 的改动落进一个用户看不见的暂存区 —— 既批不了也拒不了，
     *    正是"静默"这一类缺陷。归并**不放宽任何围栏**（写仍先落暂存、仍要手势）。
     */
    sessionIdOf() {
      if (this.fixedSessionId) return this.fixedSessionId;
      const fromSpec = this.currentSpec?.sandboxPolicy && typeof this.currentSpec.sandboxPolicy.sessionId === "string" ? this.currentSpec.sandboxPolicy.sessionId : void 0;
      if (typeof fromSpec === "string" && fromSpec.length > 0) {
        return rootSessionIdFor(this.ctx, fromSpec) ?? fromSpec;
      }
      try {
        const ctx = this.ctx;
        const agents = ctx && typeof ctx.get === "function" ? ctx.get("agents") : ctx?.agents;
        const session = agents?.currentInitiator?.()?.session;
        const id = session?.id;
        if (typeof id === "string" && id.length > 0) return rootSessionIdOf(ctx, session) ?? id;
      } catch {
      }
      return void 0;
    }
    // ==================== resolve：纯计算 ====================
    /**
     * 填默认值与封顶。**不碰磁盘**：不建目录、不建沙箱、不物化
     * （物化只在 `execute()` 里做，因为那才是"真的要执行"的时刻）。
     */
    resolve(request) {
      const workspace = this.currentWorkspace({ bestEffort: true });
      const logicalRoot = (typeof request?.workdir === "string" && request.workdir.length > 0 ? request.workdir : void 0) ?? (typeof workspace?.root === "string" && workspace.root.length > 0 ? workspace.root : void 0) ?? "";
      const requested = request?.timeoutMs;
      if (requested !== void 0 && (!Number.isFinite(requested) || requested <= 0)) {
        throw new Error("request.timeoutMs must be a positive finite number");
      }
      const requestedStdout = request?.stdoutMaxBytes;
      if (requestedStdout !== void 0 && (!Number.isFinite(requestedStdout) || requestedStdout <= 0)) {
        throw new Error("request.stdoutMaxBytes must be a positive finite number");
      }
      return {
        command: String(request?.command ?? ""),
        // 逻辑 workdir：**展示**与"相对路径的解析基准"用这里；真实执行 cwd 是命令自己的
        // 工作目录树（`execute()` 里取 `workspace.store.stagedDir`），模型可见通道里
        // **不会**出现它（见 `settledExecution()`）。
        workdir: logicalRoot,
        timeoutMs: Math.min(requested ?? this.timeoutMs, this.maxTimeoutMs),
        onExpiry: request?.onExpiry ?? "kill",
        stdoutMaxBytes: Math.min(requestedStdout ?? this.stdoutMaxBytes, this.stdoutMaxBytes),
        ...request?.signal ? { signal: request.signal } : {},
        ...request?.stdin !== void 0 ? { stdin: request.stdin } : {},
        ...request?.env !== void 0 ? { env: request.env } : {},
        ...request?.dshEnv !== void 0 ? { dshEnv: request.dshEnv } : {},
        // ★ 把策略**带下去**，不要丢掉：`execute()` 要据它**拒绝任何更宽的请求**。
        //   丢弃它会让"用户批准了更宽权限"变成一次**静默无效**的批准 —— 那是说谎。
        sandboxPolicy: request?.sandboxPolicy
      };
    }
    // ==================== execute：要么在沙箱里跑完，要么抛错 ====================
    /**
     * @param {object} spec `resolve()` 的返回值
     * @returns {Promise<object>} 已结算的 `ShellExecution`
     */
    async execute(spec) {
      this.currentSpec = spec;
      try {
        return await this.executeInner(spec);
      } finally {
        this.currentSpec = void 0;
      }
    }
    /**
     * `execute()` 的主体（外层只负责"本次执行的 spec 生命周期"）。
     *
     * 拆出来的原因：`currentSpec` 必须在**所有**返回路径上被清掉，
     * 而原实现是一个超长函数、有多个 return/throw —— 用 try/finally 包一层最省事、
     * 也最不容易漏。
     *
     * @param {object} spec `resolve()` 的返回值
     */
    async executeInner(spec) {
      const requestedMode = spec?.sandboxPolicy?.mode;
      const mismatched = requestedMode !== void 0 && requestedMode !== "workspace-write";
      if (mismatched) {
        this.logError(
          `\u8BF7\u6C42\u7684\u6863\u4F4D "${requestedMode}" \u6BD4\u672C\u6267\u884C\u5668\u5B9E\u9645\u751F\u6548\u7684\u6863\u4F4D\u5BBD\uFF08"workspace-write"\uFF09\uFF1B\u672C\u6B21\u6309\u751F\u6548\u6863\u4F4D\u6267\u884C\uFF08\u53EF\u5199 = \u547D\u4EE4\u81EA\u5DF1\u7684\u5DE5\u4F5C\u76EE\u5F55\uFF09\uFF0C\u6743\u9650\u672A\u88AB\u653E\u5927\u3002` + (this.winStageEnabled() ? "" : "\uFF08\u6CE8\u610F\uFF1AWinStage \u5F00\u5173\u5F53\u524D\u4E3A\u5173\u95ED\u6001\u3002\uFF09")
        );
      }
      return this.executeConfined(spec, {
        requestedMode,
        ...mismatched ? {
          degradeNote: `\u8BF7\u6C42\u6863\u4F4D "${requestedMode}" \u6BD4\u672C\u6B21\u5B9E\u9645\u751F\u6548\u7684\u6863\u4F4D\uFF08"workspace-write"\uFF09\u66F4\u5BBD\uFF1B\u547D\u4EE4\u5DF2\u6309\u751F\u6548\u6863\u4F4D\u6267\u884C\uFF0C\u6743\u9650\u672A\u88AB\u653E\u5927\u3002`
        } : {}
      });
    }
    /**
     * **在 WinStage 围栏内**执行（可写 = 暂存树）。`execute()` 的两条路径共用它，
     * 避免"交还分支"与"接管分支"各写一份执行体。
     *
     * @param {object} spec `resolve()` 的返回值
     * @param {{requestedMode?: string, degradeNote?: string}} context
     *   `degradeNote` 非空表示这是"交还失败后的降级执行"⇒ 进 error 级日志 + 注记。
     */
    async executeConfined(spec, context = {}) {
      const notes = [];
      const warn = (message) => {
        notes.push(message);
        this.logError(message);
      };
      if (typeof context.degradeNote === "string" && context.degradeNote.length > 0) {
        warn(context.degradeNote);
      }
      if (!spec || typeof spec.command !== "string" || spec.command.trim().length === 0) {
        throw semanticShellFailure("WINSTAGE_SHELL_BAD_COMMAND", {
          detail: "command must be a non-empty string."
        });
      }
      const msiVerdict = msiFamilyCommandVerdict(spec.command);
      if (msiVerdict.blocked) {
        this.logError(
          `MSI \u5BB6\u65CF\u547D\u4EE4\u88AB fail-closed \u62D2\u7EDD\uFF08matched=${msiVerdict.matched}\uFF09\uFF1Amsiexec \u7684\u5B9E\u9645\u5199\u5165\u7531\u8FDB\u7A0B\u5916 msiserver \u670D\u52A1\u5B8C\u6210\uFF0C\u4E0D\u7ECF\u8FC7\u672C\u8FDB\u7A0B\u7684\u6302\u63A5\u70B9\uFF0C\u65E0\u6CD5\u8FDB\u5165\u6682\u5B58/\u8986\u76D6\u5C42\uFF1B\u4F9D\u636E docs/round16/exe-\u7F3A\u9677.md \u7684 R16-D3-2\u3002`
        );
        throw semanticShellFailure("WINSTAGE_SHELL_MSI_UNSUPPORTED", {
          presetMessage: MSI_UNSUPPORTED_MESSAGE,
          winstage: {
            msiGate: true,
            matched: msiVerdict.matched,
            matchedHead: msiVerdict.head,
            reason: "msiserver \u662F\u8FDB\u7A0B\u5916\u670D\u52A1\uFF1A\u5176\u6587\u4EF6\u5199\u5165\u4E0D\u7ECF\u8FC7\u672C\u8FDB\u7A0B\u7684\u6302\u63A5\u70B9\uFF0C\u65E0\u6CD5\u8FDB\u5165\u6682\u5B58/\u8986\u76D6\u5C42\u3002",
            doc: "docs/round16/exe-\u7F3A\u9677.md#R16-D3-2",
            evidence: "docs/round16/exe-\u62A5\u544A.md \xA74.3\uFF08\u771F\u5B9E\u76D8 +2,449 \u6587\u4EF6 / 134,868,847 B\uFF09"
          }
        });
      }
      await this.loadBaseClass();
      const workspace = this.currentWorkspace();
      if (!workspace || typeof workspace !== "object") {
        throw semanticShellFailure("WINSTAGE_SHELL_NO_WORKSPACE");
      }
      const stagedDir = this.stagedDirOf(workspace);
      const factory = this.executorFactory ?? ((opts) => {
        const instance = new WindowsStageExecutor(opts);
        instance.capabilities = () => WindowsStageExecutor.capabilities();
        return instance;
      });
      const executor = factory({
        stagingRoot: stagedDir,
        // ── 注册表覆盖层落在**会话存储根**（= manifest/review/queue 那一层）─────────
        // 不能落在 `stagedDir`（暂存树）里：`WINSTAGE_STAGE_ROOT` 同时是文件族重定向根与
        // 注册表 overlay 的默认 sessionDir，覆盖层写进暂存树后会被"提取暂存树变化"
        // 当成工作区改动去摄取（本机实测 `EPERM ... overlay.<pid>.hive.LOG1`）。
        // 指到 `store.dir` 后：① 暂存树保持干净；② overlay/WAL 与候选队列同根，
        // 正是 `src/registry-stage.ts::createRegistryStage()` 的契约布局。
        registryStageDir: workspace.store?.dir,
        mode: this.mode,
        tier: this.tier,
        /** R14：把网络档位真正交给执行器（此前从不传 ⇒ 永远停在默认档） */
        networkTier: this.networkTier,
        timeoutMs: spec.timeoutMs
      });
      try {
        const capabilities = typeof executor.capabilities === "function" ? executor.capabilities() : { aclAvailable: false };
        if (!capabilities || capabilities.aclAvailable !== true) {
          this.logError(
            `\u6267\u884C\u540E\u7AEF\u4E0D\u53EF\u7528\uFF1AaclAvailable=${JSON.stringify(capabilities?.aclAvailable ?? null)}${capabilities?.aclError ? `, ${capabilities.aclError}` : ""}\uFF1B\u672C\u8BBE\u8BA1\u4E0D\u5141\u8BB8\u9000\u56DE\u672A\u53D7\u9650\u6267\u884C \u21D2 \u672C\u6B21\u547D\u4EE4\u6CA1\u6709\u6267\u884C\u3002`
          );
          throw semanticShellFailure("WINSTAGE_SHELL_EXECUTION_BACKEND_UNAVAILABLE", {
            winstage: {
              aclAvailable: capabilities?.aclAvailable ?? null,
              aclError: capabilities?.aclError ?? null
            }
          });
        }
        if (typeof executor.init !== "function" || typeof executor.run !== "function") {
          throw semanticShellFailure("WINSTAGE_SHELL_EXECUTOR_INVALID");
        }
        try {
          await executor.init();
        } catch (error) {
          this.logError(
            `\u6267\u884C\u540E\u7AEF\u521D\u59CB\u5316\u5931\u8D25\uFF08${error?.code ?? "no-code"} ${error?.message ?? error}\uFF09\uFF1B\u672C\u8BBE\u8BA1\u4E0D\u5141\u8BB8\u9000\u56DE\u672A\u53D7\u9650\u6267\u884C \u21D2 \u672C\u6B21\u547D\u4EE4\u6CA1\u6709\u6267\u884C\u3002`
          );
          throw semanticShellFailure("WINSTAGE_SHELL_INIT_FAILED", {
            winstage: { technicalDetail: String(error?.message ?? error), runnerCode: error?.code }
          });
        }
        const effectiveLane = typeof executor.launchMode === "string" ? executor.launchMode : "unknown";
        const laneEnabled = this.winStageEnabled();
        const lane = {
          launchMode: effectiveLane,
          tierEffective: executor.tierEffective ?? null,
          fallbackReason: executor.fallbackReason ?? null,
          requestedTier: this.tier,
          winStageEnabled: laneEnabled,
          fallbackClass: classifyLaneFallback(executor.fallbackReason).code,
          degraded: effectiveLane !== "shim",
          at: (/* @__PURE__ */ new Date()).toISOString(),
          /**
           * ── R14 修复 · D5-N2/N5：网络姿态**进 lane 产物** ──────────────────────
           * R11 实测：`sandbox-lane.json` 12 个键里**零网络字段**，于是"有没有网络策略
           * 在生效"只能靠读源码回答。这里把执行器的网络摘要原样带上（`state/enforced/
           * verified/reason` 全部来自 `src/netpolicy.ts`，不在这里重算、不伪造），
           * 并如实标注"逐条网络 op 的审计尚未实现"。
           */
          network: {
            requested: this.networkTier,
            state: executor.networkPolicy && typeof executor.networkPolicy.state === "string" ? executor.networkPolicy.state : "not-evaluated",
            enforced: Boolean(executor.networkPolicy && executor.networkPolicy.enforced === true),
            verified: Boolean(executor.networkPolicy && executor.networkPolicy.verified === true),
            reason: executor.networkPolicy && typeof executor.networkPolicy.reason === "string" ? executor.networkPolicy.reason : null,
            perOpAudit: false,
            note: '\u9010\u6761\u7F51\u7EDC\u64CD\u4F5C\uFF08connect/bind\uFF09\u7684\u5BA1\u8BA1\u672A\u5B9E\u73B0\uFF1B\u672C\u5B57\u6BB5\u53EA\u56DE\u7B54"\u5F53\u524D\u6863\u4F4D\u4E0E\u662F\u5426\u771F\u7684\u5F3A\u5236"\u3002\u9ED8\u8BA4\u6863 OBSERVED_ONLINE \u4E0B\u672C\u673A\u4E0D\u5B89\u88C5\u4EFB\u4F55\u771F\u5B9E WFP \u8FC7\u6EE4\u5668\uFF08R11 \u5B9E\u6D4B netsh wfp \u524D\u540E\u9010\u5B57\u8282\u76F8\u540C\uFF09\u3002'
          }
        };
        this.persistLane(lane, workspace);
        this.observeStageRoot(workspace, "exec");
        if (effectiveLane !== "shim") {
          const laneSummary = summarizeLane(lane);
          notes.push(laneSummary.conclusion);
          if (laneEnabled) {
            this.logError(
              `\u6C99\u7BB1\u901A\u9053\u56DE\u9000\uFF1A\u671F\u671B\u53BB\u4EE4\u724C\u5316\uFF08shim\uFF09\u901A\u9053\uFF0C\u5B9E\u9645=${effectiveLane}\uFF08tier=${executor.tierEffective ?? executor.tier ?? "?"}\uFF09\uFF1A${executor.fallbackReason ?? "\u672A\u7ED9\u51FA\u539F\u56E0"}\u3002\u8BE5\u901A\u9053\u4E0B**\u6CA1\u6709 shim** \u21D2 \u6CE8\u518C\u8868\u5199\u65E0\u6CD5\u8FDB\u8986\u76D6\u5C42\uFF08\u53EA\u5269\u5185\u6838\u786C\u62D2\uFF09\uFF0C\u6587\u4EF6\u4EA7\u51FA\u4E5F\u4E0D\u8FDB\u6682\u5B58\u3002 \u4E00\u53E5\u8BDD\u7ED3\u8BBA\uFF1A${laneSummary.conclusion}`
            );
          } else {
            this.log(`\u6863\u4F4D\u8BB0\u5F55\uFF08WinStage \u5F00\u5173\u4E3A\u5173\u95ED\u6001\uFF09\uFF1A${laneSummary.conclusion}`);
          }
        }
        try {
          workspace.materializeForExecution();
        } catch (error) {
          this.logError(`\u6267\u884C\u524D\u51C6\u5907\u5DE5\u4F5C\u526F\u672C\u5931\u8D25\uFF1A${error?.message ?? error}\uFF1B\u672C\u6B21\u547D\u4EE4\u6CA1\u6709\u6267\u884C\u3002`);
          throw semanticShellFailure("WINSTAGE_SHELL_MATERIALIZE_FAILED", {
            winstage: { technicalDetail: String(error?.message ?? error) }
          });
        }
        const before = workspace.snapshotStagedTree();
        if (spec.signal?.aborted === true) {
          return this.settledExecution({
            spec,
            workspace,
            stagedDir,
            notes,
            execution: { exitCode: null, stdout: "", stderr: "", timedOut: false, envRejected: [] },
            aborted: true,
            capture: void 0
          });
        }
        const argv = buildCommandArgv(spec.command, resolvePwshPath(this.pwshPathConfig));
        if (!argv.recognized) {
          this.log(
            `\u547D\u4EE4\u672A\u5E26 pwsh/powershell \u524D\u7F00\uFF0C\u6309"\u88F8\u7A0B\u5E8F + \u53C2\u6570"\u5904\u7406\uFF1A${argv.command}\uFF08args=${argv.args.length}\uFF09\uFF1B\u4E0D\u505A\u4EFB\u4F55 shell \u5C55\u5F00\u3002`
          );
        }
        const environment = { ...ENV_OVERRIDES, ...spec.dshEnv ?? {}, ...spec.env ?? {} };
        {
          const cleartextSecret = detectCleartextSecret(spec.command);
          if (cleartextSecret.matched) {
            this.logError(
              `\u9650\u5236\u5373\u5931\u8D25\uFF1A\u547D\u4EE4\u6587\u672C\u91CC\u68C0\u51FA\u660E\u6587\u5F62\u6001\u51ED\u636E\uFF08kind=${cleartextSecret.kind}\uFF0C${cleartextSecret.snippet}\uFF09\uFF1B\u5DF2\u6309"\u8BE5\u8BF7\u6C42\u4E0D\u88AB\u5141\u8BB8"\u62D2\u7EDD\uFF0C\u672A\u521B\u5EFA\u4EFB\u4F55\u5B50\u8FDB\u7A0B\u3002\u6B8B\u4F59\u8FB9\u754C\uFF1ATLS \u6B63\u6587\u4E0E\u8FD0\u884C\u671F\u624D\u8BFB\u51FA\u7684\u5BC6\u94A5\u68C0\u6D4B\u4E0D\u5230 \u2014\u2014 \u672C\u68C0\u6D4B\u4E0D\u6784\u6210"\u51FA\u7AD9\u51ED\u636E\u4E0D\u4F1A\u6CC4\u6F0F"\u7684\u4FDD\u8BC1\u3002`
            );
            throw semanticShellFailure(CLEARTEXT_SECRET_FAILURE.code, {
              category: FAILURE_SEMANTICS.POLICY,
              winstage: { secretKind: cleartextSecret.kind, secretSnippet: cleartextSecret.snippet, executed: false }
            });
          }
        }
        if (spec.stdin !== void 0 && spec.stdin !== null && String(spec.stdin).length > 0) {
          warn(
            "spec.stdin \u88AB\u4F20\u8FDB\u6765\u4E86\uFF0C\u4F46\u65E0\u6CD5\u63A5\u8FDB\u53D7\u9650\u5B50\u8FDB\u7A0B\uFF08CreateProcessAsUserW \u6CA1\u6709 stdin \u901A\u9053\uFF09\uFF1B\u5B83\u88AB**\u4E22\u5F03**\u4E86 \u2014\u2014 \u5982\u5B9E\u8BB0\u5728\u8FD9\u91CC\uFF0C\u4E0D\u9759\u9ED8\u6D88\u8D39\u3001\u4E5F\u4E0D\u5047\u88C5\u6210\u529F\u3002"
          );
        }
        let execution;
        try {
          execution = await executor.run({
            command: argv.command,
            args: argv.args,
            cwd: stagedDir,
            logicalCwd: workspace.root,
            timeoutMs: spec.timeoutMs,
            env: environment
          });
        } catch (error) {
          const classification = runFailureClassification(error);
          this.logError(
            `\u6267\u884C\u901A\u9053\u629B\u9519\uFF08\u6280\u672F\u7801=${error?.code ?? "no-code"}\uFF0C\u5206\u7C7B=${classification.category}\uFF0Cindeterminate=${classification.indeterminate}\uFF0C\u8BC1\u636E=[${classification.evidence.join(", ")}]\uFF09\uFF1A${error?.message ?? error}\u3002${classification.userDetail}`
          );
          throw semanticShellFailure("WINSTAGE_SHELL_RUN_FAILED", {
            category: classification.category,
            indeterminate: classification.indeterminate,
            winstage: {
              technicalDetail: String(error?.message ?? error),
              runnerCode: error?.code,
              evidence: classification.evidence
            }
          });
        }
        const timedOut = execution?.timedOut === true;
        const aborted = !timedOut && spec.signal?.aborted === true;
        const capture = this.captureStagedChanges(workspace, before, warn);
        const registryCapture = captureRegistryChanges({
          sessionDir: workspace.store?.dir,
          sessionId: this.sessionIdOf(),
          workspaceRoot: workspace.root,
          log: (message) => this.log(message),
          logError: (message) => this.logError(message)
        });
        if (registryCapture.handled && registryCapture.enqueued) {
          notes.push(
            `\u6CE8\u518C\u8868\u6539\u52A8\u5DF2\u8FDB\u6682\u5B58\uFF1A${registryCapture.changes} \u6761\u51C0\u53D8\u5316\uFF0C\u5019\u9009 ${registryCapture.candidateId}\uFF08\u6279\u51C6\u540E\u624D\u5199\u771F\u5B9E\u6CE8\u518C\u8868\uFF09\u3002`
          );
        }
        const auditCapture = this.captureAudit(executor, workspace, warn);
        if (auditCapture.handled) {
          notes.push(`${auditCapture.text}\uFF08\u5DF2\u5199\u5165 sandbox-audit.json\uFF09`);
        }
        const envRejected = Array.isArray(execution?.envRejected) ? execution.envRejected : [];
        for (const name of envRejected) {
          warn(`\u73AF\u5883\u53D8\u91CF ${name} \u672A\u88AB\u91C7\u7EB3\uFF08\u540D\u5B57\u50CF\u51ED\u636E\uFF09\uFF0C\u672A\u8FDB\u5165\u5B50\u8FDB\u7A0B\u3002`);
        }
        const publish = this.publishSnapshotIfChanged({ capture, workspace, sessionId: this.sessionIdOf() });
        this.log(
          `\u53D7\u9650\u6267\u884C\u5B8C\u6BD5 exit=${execution?.exitCode ?? "?"} timedOut=${timedOut}\uFF1B\u6355\u83B7 ${capture.captured} \u6761\u3001\u5E76\u5165 ${capture.ingested} \u6761\u3001\u5220\u9664 ${capture.deletions} \u6761\u3001\u5019\u9009=${capture.candidate?.frozen === true ? capture.candidate.candidate?.id : `\u672A\u65B0\u5EFA(${capture.candidate?.reason ?? "n/a"})`}\uFF1B\u6CE8\u518C\u8868=${registryCapture.handled ? `${registryCapture.reason}(${registryCapture.changes ?? 0})` : registryCapture.reason}\uFF1B\u5FEB\u7167\u53D1\u5E03=${publish.published ? "\u5DF2\u53D1\u5E03" : `\u8DF3\u8FC7(${publish.reason})`}`
        );
        return this.settledExecution({
          spec,
          workspace,
          stagedDir,
          notes,
          execution: {
            exitCode: execution?.exitCode ?? null,
            stdout: execution?.stdout,
            stderr: execution?.stderr,
            timedOut,
            envRejected
          },
          aborted,
          capture,
          publish
        });
      } finally {
        try {
          executor.dispose?.();
        } catch (error) {
          this.logError(`executor.dispose() \u5931\u8D25\uFF08\u4E0D\u63A9\u76D6\u547D\u4EE4\u7ED3\u679C\uFF09\uFF1A${error?.message ?? error}`);
        }
      }
    }
    // ==================== 内部：装配 ====================
    /**
     * 取到运行时那一份 `ShellExecutor` **基类**。
     *
     * 只在**第一次 execute()** 时 import：
     *   - 拿不到包 ⇒ 可读的 fail-closed 错误（而不是整条 loader 行加载失败）；
     *   - 包在、但不够格 ⇒ cordis 会直接报"重复的 shell 服务"，用户能看见。
     * 绝不用 `ShellExecutor` 之外的替身冒充基类（那会注册出一个假的 `ctx.shell` 变体）。
     */
    async loadBaseClass() {
      if (injectedBase) return injectedBase;
      if (this.baseUnavailable) {
        this.logError("\u65E0\u6CD5\u5B9A\u4F4D\u57FA\u7C7B\u6A21\u5757 @deepseek-ai/dsh-shell \u21D2 fail-closed\u3002\u8BF7\u63D0\u4F9B\u542B @deepseek-ai/* \u7684 node_modules \u6839\u3002");
        throw semanticShellFailure("WINSTAGE_SHELL_BASE_MISSING");
      }
      if (!this.resolvedBasePromise) {
        this.resolvedBasePromise = (async () => {
          const modulePath = this.resolveShellModule();
          let loaded;
          let source = modulePath;
          try {
            if (modulePath) {
              loaded = await import(pathToFileURL(modulePath).href);
            } else {
              source = "@deepseek-ai/dsh-shell";
              loaded = await import(source);
            }
          } catch (error) {
            this.logError(`import ${source ?? "@deepseek-ai/dsh-shell"} \u5931\u8D25\uFF1A${error?.message ?? error}`);
            throw semanticShellFailure("WINSTAGE_SHELL_BASE_LOAD_FAILED", {
              winstage: { technicalDetail: String(error?.message ?? error), modulePath: source }
            });
          }
          const klass = loaded?.ShellExecutor ?? loaded?.default;
          if (typeof klass !== "function") {
            this.logError(`${source} \u6CA1\u6709\u5BFC\u51FA ShellExecutor \u7C7B\u3002`);
            throw semanticShellFailure("WINSTAGE_SHELL_BASE_LOAD_FAILED", {
              winstage: { technicalDetail: `${source} did not export a ShellExecutor class`, modulePath: source }
            });
          }
          return klass;
        })();
      }
      return this.resolvedBasePromise;
    }
    /**
     * **有净变化才发布一次审阅快照**（命令产出"立刻可见"）。
     *
     * 纪律（逐条都是硬要求）：
     *   1. **同一条调用**：默认走 `publishWorkspaceSnapshot()` = `getReviewService(...).publish()`，
     *      也就是 `/winstage refresh` 与 `staging-fs.afterMutation()` 用的那条（不另造路径）；
     *   2. **无净变化不发布**：沿用 `freezeIfNeeded()`「无净变化不入队」的同一口径，
     *      否则每条命令（含只读命令）都会刷一次盘；
     *   3. **零痕迹**：这是**纯人工侧**动作，绝不写 stdout/stderr（task-5 契约）；
     *   4. **失败不影响命令**：任何异常只记一条 error 级日志（人工侧），
     *      退出码/输出/`winstage.capture.*` 一律照原样返回。
     *
     * 根守卫：只在**行表给出的权威根**与本次实际用的 `workspace.root` 同根时才发布
     * （根统一之后必然同根；离线自测注入假工作区时通常拿不到权威根 ⇒ 自动跳过，
     * 绝不会把假工作区的改动写进真实存储）。
     *
     * @returns {{published: boolean, reason: string, error?: string}}
     */
    publishSnapshotIfChanged({ capture, workspace, sessionId }) {
      const changed = Boolean(capture) && (capture.captured > 0 || capture.ingested > 0 || capture.deletions > 0 || capture.candidate?.frozen === true);
      if (!changed) return { published: false, reason: "no-net-change" };
      let root;
      try {
        root = this.effectiveWorkspaceRoot();
      } catch {
        root = void 0;
      }
      if (typeof root !== "string" || root.length === 0) return { published: false, reason: "no-workspace-root" };
      if (!sameRootText(root, workspace?.root)) return { published: false, reason: "root-mismatch" };
      if (typeof this.publishFor !== "function") return { published: false, reason: "no-publisher" };
      try {
        this.publishFor(sessionId, root);
        return { published: true, reason: "published" };
      } catch (error) {
        const message = String(error?.message ?? error);
        try {
          this.logError(`\u53D1\u5E03\u5BA1\u9605\u5FEB\u7167\u5931\u8D25\uFF08\u547D\u4EE4\u7ED3\u679C\u4E0D\u53D7\u5F71\u54CD\uFF09\uFF1A${message}`);
        } catch {
        }
        return { published: false, reason: "publish-failed", error: message };
      }
    }
    /**
     * 暂存树根 = 命令的真实 cwd。
     * 优先 `workspace.store.stagedDir`（与 `src/cli.ts` 的 `exec` 分支逐字一致）。
     */
    stagedDirOf(workspace) {
      const stagedDir = workspace?.store?.stagedDir;
      if (typeof stagedDir !== "string" || stagedDir.length === 0) {
        this.logError("\u5DE5\u4F5C\u533A\u6CA1\u6709\u7ED9\u51FA\u53EF\u7528\u5DE5\u4F5C\u76EE\u5F55\uFF08store.stagedDir \u4E3A\u7A7A\uFF09\u21D2 \u62D2\u7EDD\u7528\u4E00\u4E2A\u672A\u6307\u5B9A\u7684\u76EE\u5F55\u53BB\u8DD1\u3002");
        throw semanticShellFailure("WINSTAGE_SHELL_NO_STAGED_ROOT", {
          detail: "refusing to run with an unspecified working directory."
        });
      }
      return stagedDir;
    }
    /**
     * 执行后的捕获链：`captureAfterExecution` → `ingestCapturedChanges` → `freezeIfNeeded`。
     * 与 `src/cli.ts` 的 `exec` 分支同一顺序（那里是唯一权威）。
     * **任何一步失败都走 error 级日志**，并把失败信息如实带回（绝不静默）。
     */
    captureStagedChanges(workspace, before, warn) {
      const report = { captured: 0, ingested: 0, deletions: 0, skipped: [], candidate: void 0, failures: [] };
      if (typeof workspace.captureAfterExecution !== "function") {
        report.failures.push("captureAfterExecution is not available on this workspace");
        warn("\u5DE5\u4F5C\u533A\u6CA1\u6709 captureAfterExecution()\uFF1A\u547D\u4EE4\u4EA7\u51FA**\u4E0D\u4F1A**\u8FDB\u5165\u6E05\u5355\uFF08\u672C\u6B21\u6267\u884C\u7ED3\u679C\u4ECD\u7136\u5982\u5B9E\u8FD4\u56DE\uFF09\u3002");
        return report;
      }
      let captured;
      try {
        captured = workspace.captureAfterExecution(before);
        report.captured = Array.isArray(captured) ? captured.length : 0;
      } catch (error) {
        report.failures.push(`captureAfterExecution: ${error?.message ?? error}`);
        warn(`\u6355\u83B7\u547D\u4EE4\u4EA7\u751F\u7684\u53D8\u66F4\u5931\u8D25\uFF1A${error?.message ?? error}\uFF08\u547D\u4EE4\u5DF2\u6267\u884C\uFF0C\u4F46\u4EA7\u51FA\u6CA1\u6709\u88AB\u5E76\u5165\u6E05\u5355\uFF09`);
        return report;
      }
      try {
        const ingested = workspace.ingestCapturedChanges(captured);
        report.ingested = ingested?.ingested ?? 0;
        report.deletions = ingested?.deletions ?? 0;
        for (const skip of ingested?.skipped ?? []) {
          report.skipped.push(skip);
          warn(`\u5E76\u5165\u6E05\u5355\u65F6\u8DF3\u8FC7 ${skip.path}\uFF1A${skip.reason}`);
        }
      } catch (error) {
        report.failures.push(`ingestCapturedChanges: ${error?.message ?? error}`);
        warn(`\u628A\u6355\u83B7\u7ED3\u679C\u5E76\u5165\u6E05\u5355\u5931\u8D25\uFF1A${error?.message ?? error}`);
        return report;
      }
      try {
        report.candidate = workspace.freezeIfNeeded({ source: "shell" });
      } catch (error) {
        report.failures.push(`freezeIfNeeded: ${error?.message ?? error}`);
        warn(`\u51BB\u7ED3\u5F85\u5BA1\u5019\u9009\u5931\u8D25\uFF1A${error?.message ?? error}\uFF08\u53D8\u66F4\u5DF2\u5728\u6E05\u5355\u91CC\uFF0C\u4F46\u6CA1\u6709\u751F\u6210\u5019\u9009\uFF09`);
      }
      return report;
    }
    /**
     * Method A 主线：把 shim 的结构化审计（`executor.auditPath`，JSONL）聚合成
     * `sandbox-audit.json`，落在**会话存储根**（与 `review.json` 同处）⇒ 面板与 CLI
     * 读的是同一份。内容 = AI 的进程树**读了/改了/删了哪些文件、读了/改了哪些注册表键**，
     * 按 `workspace/outside` 分类。
     *
     * 这是**收尾动作**：任何失败都进 warn 并如实返回 `handled:false`，**绝不打断命令**
     * （与 `captureRegistryChanges` 同一纪律）。
     */
    captureAudit(executor, workspace, warn) {
      const auditPath = executor?.auditPath;
      const storeDir = workspace?.store?.dir;
      if (typeof auditPath !== "string" || auditPath.length === 0) return { handled: false, reason: "audit-disabled" };
      if (typeof storeDir !== "string" || storeDir.length === 0) return { handled: false, reason: "no-store-dir" };
      try {
        if (!existsSync2(auditPath)) return { handled: false, reason: "no-audit-file" };
        const lines = readFileSync2(auditPath, "utf8").split(/\r?\n/);
        const report = buildAuditReport(lines, { root: workspace.root, audits: [auditPath] });
        const out = join2(storeDir, "sandbox-audit.json");
        writeFileSync2(out, `${JSON.stringify(report, null, 2)}
`);
        return { handled: true, path: out, summary: report.summary, text: summarizeAudit(report.summary) };
      } catch (error) {
        warn(`\u805A\u5408\u5BA1\u8BA1\u5931\u8D25\uFF08\u547D\u4EE4\u7ED3\u679C\u4E0D\u53D7\u5F71\u54CD\uFF09\uFF1A${error?.message ?? error}`);
        return { handled: false, reason: `error:${error?.message ?? error}` };
      }
    }
    // ==================== 内部：返回形状 ====================
    /**
     * 构造**已结算**的 `ShellExecution`（契约允许：dsh-shell/lib/types/index.d.ts:40
     * "Expiry during preparation returns a settled timed-out handle without output"）。
     *
     * 形状逐项对齐：status / exitCode / signal / done / sandbox? / readOutput() /
     * observed / kill() / result()。另有 `winstage` 这个**附加**可观测面（不属于契约，
     * 便于诊断：暂存树路径、捕获计数、候选 id、失败原因）。
     */
    settledExecution({ spec, workspace, stagedDir, notes, execution, aborted, capture, publish }) {
      const timedOut = execution.timedOut === true;
      const exitCode = timedOut ? 124 : aborted ? null : execution.exitCode ?? null;
      const stdoutOut = boundedOutput(execution.stdout, spec.stdoutMaxBytes);
      const stderrOut = boundedOutput(execution.stderr, spec.stdoutMaxBytes);
      this.writeDiagnostics({
        event: "shell-execution",
        workspaceRoot: workspace.root,
        workingDirectory: stagedDir,
        /**
         * ★ 本次执行**实际走的是哪条通道**（本轮加）——
         * 用户报障"注册表更改直接失败"的根因之一就是这条通道**静默**降级：
         * `tier:'auto'` 探测不过 ⇒ 受限令牌档 ⇒ 没有 shim ⇒ 注册表写只剩内核硬拒。
         * 人工排查时必须能一眼看到它，否则"沙箱开着"与"沙箱退化了"长得一模一样。
         */
        lanes: this.lastLane ?? { launchMode: null, tierEffective: null, fallbackReason: "not-recorded" },
        notes,
        publish: publish ?? { published: false, reason: "not-attempted" },
        capture: capture ? {
          captured: capture.captured,
          ingested: capture.ingested,
          deletions: capture.deletions,
          skipped: capture.skipped,
          frozen: capture.candidate?.frozen === true,
          candidateId: capture.candidate?.candidate?.id,
          reason: capture.candidate?.reason,
          failures: capture.failures
        } : { available: false, failures: ["captureAfterExecution unavailable"] }
      });
      const stderrJoined = stderrOut.text;
      const stderrFinal = stderrOut;
      const runResult = {
        exitCode,
        signal: null,
        timedOut,
        aborted,
        timeoutMs: spec.timeoutMs,
        stdout: { text: stdoutOut.text, truncated: stdoutOut.truncated },
        // stderr **逐字节**等于命令自己的 stderr（`stderrFinal === stderrOut`）。
        stderr: { text: stderrFinal.text, truncated: stderrFinal.truncated }
        // sandbox 事实**刻意不报**：本执行器已经广告 sandboxMode === undefined，
        // 报出 mode 会让 dsh-tool-pwsh 走 sandboxDenialMarker(mode) 渲染路径
        // （tool-pwsh/lib/index.js:165-168）—— 一个我们并不使用的模式。
      };
      let drained = false;
      return {
        status: "completed",
        exitCode,
        signal: null,
        done: Promise.resolve(),
        /** 前台投影（契约：只在基础设施故障时 reject；这里总是 resolve） */
        result: () => Promise.resolve(runResult),
        /** 消费式读：首次给全文，之后给空（连续读不重复投递） */
        readOutput() {
          if (drained) return { delta: "", lossy: false };
          drained = true;
          return {
            delta: `${stdoutOut.text}${stderrOut.text.length > 0 ? `
[stderr]
${stderrOut.text}` : ""}`,
            lossy: false
          };
        },
        /** 非消费式偏移读：两个流各一个 reader，独立于 readOutput 的游标 */
        observed: {
          stdout: makeOffsetReader(execution.stdout),
          stderr: makeOffsetReader(stderrJoined)
        },
        /** 已结算 ⇒ 没有可终止的区间（契约里"已经结束 ⇒ no-op"的语义） */
        kill() {
          return false;
        },
        // —— 附加可观测面（不属于 ShellExecution 契约）——
        winstage: {
          kind: "win-stage-sandbox",
          stagedDir,
          logicalWorkspaceRoot: workspace.root,
          capture: capture ? {
            captured: capture.captured,
            ingested: capture.ingested,
            deletions: capture.deletions,
            skipped: capture.skipped,
            frozen: capture.candidate?.frozen === true,
            candidateId: capture.candidate?.candidate?.id,
            reason: capture.candidate?.reason,
            failures: capture.failures
          } : { available: false, failures: ["captureAfterExecution unavailable"] },
          /**
           * 发布结果（人工侧）：`{published, reason}`。命令产出"立刻可见"的可观测落点，
           * 面板/自测据此断言"有净变化 ⇒ 已发布 / 无净变化 ⇒ 跳过"。
           */
          publish: publish ?? { published: false, reason: "not-attempted" },
          envRejected: execution.envRejected ?? [],
          /**
           * ★ BUG-B：本次执行**实际走的通道**（结构化，人工/命令侧可见）。
           * `verdict.status === 'degraded'` ⇒ 沙箱未生效（没有 shim ⇒ 写入只剩内核硬拒、
           * 文件产出不进暂存）。放在这里是为了让断言/排查**不必读日志**就能分辨
           * "沙箱生效"与"沙箱退化成拒绝一切"；它同样**不进**模型可见的 stdout/stderr。
           */
          lane: this.lastLane ? { ...this.lastLane, verdict: summarizeLane(this.lastLane) } : void 0,
          notes
        }
      };
    }
  };
}

export {
  summarizeLane,
  readLaneJournalFile,
  summarizeLaneHistory,
  noteStageRootLoss,
  locatePackageFile,
  workspaceRootsOfLoaderRows,
  createWinStageShellExecutor
};
