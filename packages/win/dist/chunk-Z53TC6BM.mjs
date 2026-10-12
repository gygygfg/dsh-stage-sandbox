var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/appcontainer.ts
import { existsSync } from "node:fs";
var STARTUPINFOEX_SIZE = 112;
var OFF_ATTRIBUTE_LIST = 104;
var EXTENDED_STARTUPINFO_PRESENT = 524288;
var PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 131081;
var SECURITY_CAPABILITIES_SIZE = 24;
function buildCreationFlags(hasEnvironmentBlock) {
  let flags = EXTENDED_STARTUPINFO_PRESENT;
  if (hasEnvironmentBlock) flags |= 1024;
  return flags >>> 0;
}
var APPCONTAINER_PACKAGE_SID_PREFIX = "S-1-15-2-";
var ACCESS_ALLOWED_ACE_TYPE = 0;
var INHERITED_ACE_FLAG = 16;
function isAppContainerPackageSid(sid) {
  if (typeof sid !== "string") return false;
  if (!sid.startsWith(APPCONTAINER_PACKAGE_SID_PREFIX)) return false;
  const rest = sid.slice(APPCONTAINER_PACKAGE_SID_PREFIX.length);
  return /^[0-9]+(-[0-9]+){6}$/.test(rest);
}
var ACE_TYPE_BY_MNEMONIC = Object.freeze({
  A: 0,
  // ACCESS_ALLOWED
  D: 1,
  // ACCESS_DENIED
  OA: 5,
  // ACCESS_ALLOWED_OBJECT
  OD: 6,
  // ACCESS_DENIED_OBJECT
  AU: 9,
  // SYSTEM_AUDIT
  AL: 17,
  // SYSTEM_ALARM
  OAII: 5
});
var ACE_FLAG_BITS = Object.freeze({
  OI: 1,
  // OBJECT_INHERIT
  CI: 2,
  // CONTAINER_INHERIT
  NP: 4,
  // NO_PROPAGATE_INHERIT
  IO: 8,
  // INHERIT_ONLY
  ID: 16,
  // INHERITED
  SA: 64,
  // SUCCESSFUL_ACCESS
  FA: 128
  // FAILED_ACCESS
});
function aceTypeOf(token) {
  const text = String(token ?? "").toUpperCase();
  if (text in ACE_TYPE_BY_MNEMONIC) return ACE_TYPE_BY_MNEMONIC[text];
  const numeric = Number.parseInt(text, 16);
  return Number.isFinite(numeric) ? numeric : NaN;
}
function aceFlagsOf(token) {
  const text = String(token ?? "").toUpperCase();
  if (text.length === 0) return 0;
  if (/^[0-9A-F]+$/.test(text) && /[0-9]/.test(text)) {
    const numeric = Number.parseInt(text, 16);
    if (Number.isFinite(numeric)) return numeric;
  }
  let bits = 0;
  for (let i = 0; i < text.length; i += 2) {
    const pair = text.slice(i, i + 2);
    if (!(pair in ACE_FLAG_BITS)) return NaN;
    bits |= ACE_FLAG_BITS[pair];
  }
  return bits;
}
function parseSddlDaclAces(sddl) {
  const text = String(sddl ?? "");
  const marker = text.indexOf("D:");
  if (marker < 0) return { aces: [], unparsed: [] };
  const body = text.slice(marker + 2);
  const aces = [];
  const unparsed = [];
  for (const raw of body.split("(")) {
    const end = raw.indexOf(")");
    if (end < 0) continue;
    const inner = raw.slice(0, end);
    if (inner.length === 0) continue;
    const parts = inner.split(";");
    if (parts.length !== 6) {
      unparsed.push(`(${inner})`);
      continue;
    }
    const type = aceTypeOf(parts[0]);
    const flags = aceFlagsOf(parts[1]);
    if (!Number.isFinite(type) || !Number.isFinite(flags)) {
      unparsed.push(`(${inner})`);
      continue;
    }
    aces.push({
      type,
      flags,
      rights: parts[2],
      sid: parts[5],
      inherited: (flags & INHERITED_ACE_FLAG) !== 0,
      source: `(${inner})`
    });
  }
  return { aces, unparsed };
}
function findStaleAppContainerAces(sddl) {
  const { aces, unparsed } = parseSddlDaclAces(sddl);
  const stale = aces.filter(
    (ace) => !ace.inherited && ace.type === ACCESS_ALLOWED_ACE_TYPE && isAppContainerPackageSid(ace.sid)
  );
  return { stale, unparsed, total: aces.length };
}
function listAppContainerSids(sddl) {
  const { aces } = parseSddlDaclAces(sddl);
  const seen = /* @__PURE__ */ new Set();
  for (const ace of aces) if (isAppContainerPackageSid(ace.sid)) seen.add(ace.sid);
  return [...seen];
}

// src/mitigations.ts
var MITIGATION_POLICY_ATTRIBUTE = 131088;
var MITIGATION_POLICY_VALUE_SIZE = 8;
var MITIGATION_FLAGS = Object.freeze({
  // bit 0 —— 数据执行保护（NX）
  DEP_ENABLE: 0x1n,
  // bit 1 —— DEP-ATL thunk 仿真（必须与 DEP_ENABLE 同开；官方原文
  // "This value can be specified only with PROCESS_CREATION_MITIGATION_POLICY_DEP_ENABLE"）
  DEP_ATL_THUNK_ENABLE: 0x2n,
  // bit 2 —— SEH 覆盖保护
  SEHOP_ENABLE: 0x4n,
  // bit 8 —— 强制 ASLR：不兼容动态基址的映像被强行重定位（无重定位节则不加载）
  FORCE_RELOCATE_IMAGES: 0x1n << 8n,
  // bit 12 —— 堆损坏即终止进程
  HEAP_TERMINATE: 0x1n << 12n,
  // bit 16 —— 自底向上随机化（含栈随机化）
  BOTTOM_UP_ASLR: 0x1n << 16n,
  // bit 20 —— 高熵自底向上随机化（官方：仅当 BOTTOM_UP_ASLR 也开才有效，且只对原生 64 位有意义）
  HIGH_ENTROPY_ASLR: 0x1n << 20n,
  // bit 24 —— 坏句柄立即抛异常（而非返回失败状态）
  STRICT_HANDLE_CHECKS: 0x1n << 24n,
  // bit 28 —— 禁 Win32k 系统调用（本模块的「syscall 类别拒绝」，见 MITIGATION_MAP）
  WIN32K_SYSTEM_CALL_DISABLE: 0x1n << 28n,
  // bit 32 —— 禁内置第三方扩展点：AppInit DLL / Winsock LSP / 全局 Windows 钩子 / 旧式 IME
  EXTENSION_POINT_DISABLE: 0x1n << 32n,
  // bit 36 —— 禁止生成动态代码或修改可执行代码（ACG 的行为面，W^X）
  PROHIBIT_DYNAMIC_CODE: 0x1n << 36n,
  // bit 40 —— 控制流保护（CFG）：对启用 CFG 编译的代码收紧间接调用
  CONTROL_FLOW_GUARD: 0x1n << 40n,
  // bit 44 —— 二进制签名策略（CIG）：EXE/DLL 必须被正确签名
  BLOCK_NON_MICROSOFT_BINARIES: 0x1n << 44n,
  // bit 48 —— 禁加载非系统字体
  FONT_DISABLE: 0x1n << 48n,
  // bit 52 —— 禁从远程设备加载映像
  IMAGE_LOAD_NO_REMOTE: 0x1n << 52n,
  // bit 56 —— 禁加载带 Low 强制标签的文件（Low IL 落地物不能当映像加载）
  IMAGE_LOAD_NO_LOW_LABEL: 0x1n << 56n,
  // bit 60 —— 优先从 System32 加载同名 DLL（DLL 劫持/本地投放缓解）
  IMAGE_LOAD_PREFER_SYSTEM32: 0x1n << 60n
});
var MITIGATION_MASKS = Object.freeze({
  PROHIBIT_DYNAMIC_CODE: 0x3n << 36n,
  BLOCK_NON_MICROSOFT_BINARIES: 0x3n << 44n,
  FONT_DISABLE: 0x3n << 48n,
  IMAGE_LOAD_NO_REMOTE: 0x3n << 52n,
  IMAGE_LOAD_NO_LOW_LABEL: 0x3n << 56n,
  IMAGE_LOAD_PREFER_SYSTEM32: 0x3n << 60n
});
var MITIGATION_MAP = Object.freeze({
  DEP_ENABLE: {
    linuxControl: "W^X \u7684\u5185\u5B58\u9762\uFF08NX \u4F4D\uFF09",
    equivalentTo: "\u5185\u6838 NX / \u4E0D\u53EF\u6267\u884C\u6620\u5C04\uFF08PAX_MPROTECT \u4E00\u7C7B\uFF09",
    substitutes: '\u628A"\u6570\u636E\u9875\u4E0D\u53EF\u6267\u884C"\u8FD9\u4E00\u6700\u57FA\u7840\u7684\u6267\u884C\u9762\u6536\u53E3\uFF0C\u4F5C\u4E3A denylist \u4E4B\u5916\u7684\u5F3A\u5236\u524D\u63D0',
    enforcement: "REAL",
    gapClosed: "\u8FDB\u7A0B\u5185\u5B58\u7684\u53EF\u6267\u884C\u9762\uFF08seccomp \u7BA1\u4E0D\u5230\uFF0C\u4F46\u5B83\u662F mprotect(PROT_EXEC) \u7C7B\u6EE5\u7528\u7684\u5730\u57FA\uFF09"
  },
  DEP_ATL_THUNK_ENABLE: {
    linuxControl: "\u65E0\u76F4\u63A5\u5BF9\u5E94\uFF08ATL thunk \u662F Windows \u7279\u6709\u517C\u5BB9\u5C42\uFF09",
    equivalentTo: "\u65E0",
    substitutes: "\u8865\u9F50 DEP \u7684\u517C\u5BB9\u6027\u4F8B\u5916\u9762\uFF1A\u53EA\u6709\u4E0E DEP_ENABLE \u540C\u5F00\u624D\u6709\u610F\u4E49",
    enforcement: "REAL",
    gapClosed: "DEP \u7684\u517C\u5BB9\u6027\u9000\u8BA9\u9762"
  },
  SEHOP_ENABLE: {
    linuxControl: "\u65E0\u76F4\u63A5\u5BF9\u5E94\uFF08SEH \u662F Windows \u7279\u6709\u5F02\u5E38\u94FE\uFF09",
    equivalentTo: "\u65E0",
    substitutes: "\u5F02\u5E38\u5904\u7406\u94FE\u5B8C\u6574\u6027\uFF08ROP/\u8986\u76D6 SEH \u7C7B\u5229\u7528\u7684\u963B\u65AD\uFF09",
    enforcement: "REAL",
    gapClosed: "\u5F02\u5E38\u5206\u53D1\u9762\u7684\u63A7\u5236\u6D41\u52AB\u6301"
  },
  FORCE_RELOCATE_IMAGES: {
    linuxControl: "ASLR / \u5F3A\u5236\u6620\u50CF\u91CD\u5B9A\u4F4D",
    equivalentTo: "\u5185\u6838 ASLR\uFF08randomize_va_space=2 \u4E00\u7C7B\uFF09",
    substitutes: "\u6620\u50CF\u57FA\u5740\u968F\u673A\u5316\u7684**\u5F3A\u5236**\uFF08\u4E0D\u4F9D\u8D56\u6BCF\u4E2A\u6A21\u5757\u81EA\u5DF1\u58F0\u660E\u7684 /DYNAMICBASE\uFF09",
    enforcement: "REAL",
    gapClosed: "\u5730\u5740\u7A7A\u95F4\u5E03\u5C40\u7684\u53EF\u9884\u6D4B\u6027"
  },
  HEAP_TERMINATE: {
    linuxControl: "glibc malloc \u4E00\u81F4\u6027\u68C0\u67E5 / \u5806\u52A0\u56FA",
    equivalentTo: "\u5806\u5143\u6570\u636E\u5B8C\u6574\u6027\u68C0\u67E5\uFF08MALLOC_CHECK_ \u4E00\u7C7B\uFF09",
    substitutes: "\u5806\u88AB\u7834\u574F\u5373\u7EC8\u6B62\uFF0C\u800C\u4E0D\u662F\u5E26\u7740\u5DF2\u635F\u574F\u7684\u5806\u7EE7\u7EED\u6267\u884C",
    enforcement: "PARTIAL",
    notEquivalent: "\u5B98\u65B9\u539F\u6587\uFF1Aheap terminate on corruption is **user mode enforced**\uFF08\u4E0D\u662F\u5185\u6838\u5F3A\u5236\uFF09",
    gapClosed: "\u5806\u5229\u7528\u7684\u6301\u7EED\u9A7B\u7559\u9762"
  },
  BOTTOM_UP_ASLR: {
    linuxControl: "mmap/\u6808\u7684\u81EA\u5E95\u5411\u4E0A\u968F\u673A\u5316",
    equivalentTo: "\u5185\u6838 mmap \u968F\u673A\u5316\uFF08mmap_rnd_bits\uFF09",
    substitutes: "\u628A\u6700\u4F4E\u7528\u6237\u5730\u5740\u968F\u673A\u5316\uFF08\u542B\u6808\u968F\u673A\u5316\uFF09",
    enforcement: "REAL",
    gapClosed: "\u5730\u5740\u7A7A\u95F4\u5E03\u5C40\u7684\u53EF\u9884\u6D4B\u6027\uFF08\u5206\u914D\u9762\uFF09"
  },
  HIGH_ENTROPY_ASLR: {
    linuxControl: "\u9AD8\u71B5 ASLR\uFF081 TB \u7EA7\u81EA\u5E95\u5411\u4E0A\u65B9\u5DEE\uFF09",
    equivalentTo: "\u5185\u6838\u9AD8\u71B5 mmap \u968F\u673A\u5316",
    substitutes: "\u628A\u5206\u914D\u9762\u71B5\u4ECE\u6570 GB \u7EA7\u62AC\u5230 TB \u7EA7\uFF08\u5B98\u65B9\uFF1A\u4EC5\u539F\u751F 64 \u4F4D\u6709\u610F\u4E49\uFF0C\u4E14\u9700 BOTTOM_UP_ASLR \u540C\u5F00\uFF09",
    enforcement: "REAL",
    notEquivalent: "WOW64 / 32 \u4F4D\u5B50\u8FDB\u7A0B\u4E0A\u53EA\u6709\u9650\u6548\u679C",
    gapClosed: "\u5730\u5740\u7A7A\u95F4\u5E03\u5C40\u7684\u53EF\u9884\u6D4B\u6027\uFF08\u71B5\u4E0D\u8DB3\uFF09"
  },
  STRICT_HANDLE_CHECKS: {
    linuxControl: '\u65E0\u76F4\u63A5\u5BF9\u5E94\uFF08Linux fd \u8868\u672C\u8EAB\u6CA1\u6709"\u53E5\u67C4\u6709\u6548\u6027\u5F02\u5E38"\u8BED\u4E49\uFF09',
    equivalentTo: "NeoAI \u7684\u300C\u542F\u52A8\u524D\u5173\u95ED 3..65535 \u5168\u90E8 fd\u300D\uFF08fd \u9762\u6536\u53E3\uFF09",
    substitutes: '\u574F\u53E5\u67C4\u5F15\u7528\u7ACB\u5373\u629B\u5F02\u5E38\uFF0C\u628A"\u53E5\u67C4\u8BEF\u7528/\u66B4\u529B\u63A2\u6D4B"\u4ECE\u53EF\u7EE7\u7EED\u6267\u884C\u53D8\u6210\u7ACB\u5373\u5931\u8D25',
    enforcement: "REAL",
    notEquivalent: "NeoAI \u662F**\u542F\u52A8\u65F6**\u679A\u4E3E\u5173\u95ED fd\uFF1B\u672C\u7B56\u7565\u662F**\u8FD0\u884C\u671F**\u5BF9\u65E0\u6548\u53E5\u67C4\u5F15\u7528\u629B\u5F02\u5E38\uFF0C\u4E24\u8005\u4E92\u8865\u4F46\u4E0D\u4E92\u76F8\u66FF\u4EE3",
    gapClosed: "\u53E5\u67C4/\u63CF\u8FF0\u7B26\u9762\u7684\u63A2\u6D4B\u4E0E\u8BEF\u7528"
  },
  WIN32K_SYSTEM_CALL_DISABLE: {
    linuxControl: "seccomp denylist \u7684**syscall \u7C7B\u522B**\u62D2\u7EDD",
    equivalentTo: "seccomp-BPF \u6309 syscall \u53F7/\u7C7B\u522B\u62D2\u7EDD\uFF08NeoAI seccomp.lua \u7684 blocked \u8868\uFF09",
    substitutes: '\u6574\u7C7B Win32k\uFF08USER/GDI\uFF09\u7CFB\u7EDF\u8C03\u7528\u4E0D\u53EF\u8FBE \u2014\u2014 \u76F4\u63A5\u628A"\u56FE\u5F62/\u7A97\u53E3/\u8F93\u5165/\u526A\u8D34\u677F"\u8FD9\u4E00\u6574\u7247 syscall \u9762\u5207\u6389',
    enforcement: "REAL",
    notEquivalent: 'seccomp \u662F**\u4EFB\u610F syscall \u53F7**\u7C92\u5EA6\u7684 denylist\uFF1BWin32k \u53EA\u5207\u6389 Win32k \u8FD9\u4E00\u7C7B\u3002NT \u539F\u751F syscall \u9762\uFF08Nt*/Zw*\uFF09\u4E0D\u53D7\u672C\u7B56\u7565\u7EA6\u675F \u2014\u2014 \u5B83\u66FF\u4EE3\u7684\u662F"\u7C7B"\u800C\u4E0D\u662F"\u8868"',
    gapClosed: "syscall \u7EA7\u62D2\u7EDD\uFF08\u7C7B\u522B\u9762\uFF09\uFF1A\u7A97\u53E3\u7AD9/\u684C\u9762/\u8F93\u5165\u6CE8\u5165/\u526A\u8D34\u677F/GPU \u7684 syscall \u5165\u53E3"
  },
  EXTENSION_POINT_DISABLE: {
    linuxControl: "LD_PRELOAD / ld.so.preload \u6CE8\u5165\u9762\u963B\u65AD",
    equivalentTo: '\u7981\u6B62 preload \u5F0F\u6CE8\u5165\uFF08NeoAI \u4FA7\u7B49\u4EF7\u7269\u662F\u5176 IAT/\u906E\u853D\u5C42\u9762\u5BF9"\u5916\u90E8\u6CE8\u5165"\u7684\u9ED8\u8BA4\u62D2\u7EDD\uFF09',
    substitutes: '\u7981 AppInit DLL / Winsock LSP / \u5168\u5C40 Windows \u94A9\u5B50 / \u65E7\u5F0F IME \u2014\u2014 \u5373"\u7B2C\u4E09\u65B9\u4EE3\u7801\u88AB\u5BBF\u4E3B\u8FDB\u7A0B\u81EA\u52A8\u52A0\u8F7D"\u7684\u56DB\u6761\u901A\u9053',
    enforcement: "REAL",
    notEquivalent: "\u5B98\u65B9\u539F\u6587\uFF1A**Local hooks still work**\uFF08\u672C\u5730\u94A9\u5B50\u4ECD\u53EF\u7528\uFF09\uFF1B\u5B83\u6321\u7684\u662F\u5168\u5C40/\u81EA\u52A8\u52A0\u8F7D\u7684\u6269\u5C55\u70B9",
    gapClosed: "\u8FDB\u7A0B\u5185\u7684\u81EA\u52A8\u6CE8\u5165\u9762\uFF08UIPI/\u94A9\u5B50/\u8F93\u5165\u6CD5\uFF09"
  },
  PROHIBIT_DYNAMIC_CODE: {
    linuxControl: "mprotect(PROT_EXEC) / W^X \u5F3A\u5236\uFF08\u7981\u6B62\u751F\u6210\u6216\u6539\u5199\u53EF\u6267\u884C\u4EE3\u7801\uFF09",
    equivalentTo: "seccomp \u5BF9 mprotect/mmap(PROT_EXEC) \u7684\u9650\u5236 + W^X\uFF08ACG \u7684\u8FD0\u884C\u65F6\u9762\uFF09",
    substitutes: "\u4EFB\u610F\u4EE3\u7801\u4FDD\u62A4\uFF08ACG\uFF09\uFF1A\u8FDB\u7A0B\u65E2\u4E0D\u80FD\u751F\u6210\u52A8\u6001\u4EE3\u7801\uFF0C\u4E5F\u4E0D\u80FD\u628A\u5DF2\u6709\u9875\u6539\u6210\u53EF\u6267\u884C",
    enforcement: "REAL",
    notEquivalent: "ACG \u662F**\u8FDB\u7A0B\u7EA7\u6A21\u5F0F**\uFF1A\u5F00\u542F\u540E JIT \u5168\u90E8\u4E0D\u53EF\u7528\uFF08Node/V8\u3001.NET\u3001Java\u3001\u90E8\u5206 Python \u6269\u5C55\uFF09\u3002\u56E0\u6B64\u672C\u6A21\u5757\u628A\u5B83\u653E\u8FDB **opt-in \u7684 untrusted \u6863**\uFF0C\u4E0D\u8FDB baseline",
    gapClosed: "syscall \u7EA7\u62D2\u7EDD\u7684\u6267\u884C\u9762\uFF1AJIT \u55B7\u5C04 / \u8FD0\u884C\u671F\u4EE3\u7801\u6539\u5199\uFF08ROP \u94FE\u7684\u843D\u5730\u6B65\u9AA4\uFF09"
  },
  CONTROL_FLOW_GUARD: {
    linuxControl: "CET/\u5F71\u5B50\u6808\u4E00\u7C7B\u7684\u63A7\u5236\u6D41\u5B8C\u6574\u6027\uFF08\u8FD1\u4F3C\uFF09",
    equivalentTo: "CFI\uFF08\u95F4\u63A5\u8C03\u7528\u767D\u540D\u5355\uFF09",
    substitutes: "\u5BF9**\u5DF2\u542F\u7528 CFG \u7F16\u8BD1**\u7684\u4EE3\u7801\u6536\u7D27\u95F4\u63A5\u8C03\u7528\u76EE\u6807",
    enforcement: "PARTIAL",
    notEquivalent: '\u5B98\u65B9\u539F\u6587\uFF1A\u53EA\u5BF9 "code that has been built with CFG enabled" \u751F\u6548 \u2014\u2014 \u672A\u5F00 CFG \u7F16\u8BD1\u7684\u6A21\u5757\u4E0D\u53D7\u7EA6\u675F\uFF0C\u5B83\u662F"\u5BF9\u5DF2\u52A0\u56FA\u4EE3\u7801\u7684\u52A0\u56FA"\uFF0C\u4E0D\u662F\u5168\u8FDB\u7A0B\u7684\u63A7\u5236\u6D41\u5B8C\u6574\u6027',
    gapClosed: "\u95F4\u63A5\u8C03\u7528/\u8DF3\u8F6C\u9762\uFF08\u4EC5\u8986\u76D6\u5DF2\u542F\u7528 CFG \u7684\u6A21\u5757\uFF09"
  },
  BLOCK_NON_MICROSOFT_BINARIES: {
    linuxControl: "\u672A\u7B7E\u540D\u4E8C\u8FDB\u5236\u6267\u884C\u62D2\u7EDD\uFF08IMA/\u7B7E\u540D\u6821\u9A8C\u4E00\u7C7B\uFF09",
    equivalentTo: "\u4EE3\u7801\u5B8C\u6574\u6027\u7B56\u7565\uFF08CIG\uFF09\uFF1AEXE/DLL \u5FC5\u987B\u88AB\u6B63\u786E\u7B7E\u540D",
    substitutes: '\u672A\u7B7E\u540D\uFF08\u6216\u975E\u53D7\u4FE1\u7B7E\u540D\uFF09\u7684 EXE/DLL \u65E0\u6CD5\u52A0\u8F7D \u2014\u2014 \u76F4\u63A5\u6390\u6389"\u6295\u653E\u4E00\u4E2A\u81EA\u5DF1\u7684\u8F7D\u8377\u518D\u6267\u884C"\u8FD9\u6761\u8DEF',
    enforcement: "REAL",
    notEquivalent: "\u5B98\u65B9\u53E6\u6709 `ALLOW_STORE(3)` \u53D6\u503C\u653E\u884C Store \u5E94\u7528\uFF1B\u4E0E ACG \u540C\u5F00\u65F6\uFF0C\u672A\u7B7E\u540D\u4E8C\u8FDB\u5236\u8FDE\u52A0\u8F7D\u90FD\u4E0D\u884C\u3002\u5FC5\u987B\u5728 **untrusted \u6863 opt-in**\uFF1A\u672C\u4ED3\u5E93\u81EA\u5E26\u7684\u672A\u7B7E\u540D\u4EA7\u7269\uFF08\u542B shim DLL\uFF09\u4F1A\u88AB\u62D2",
    gapClosed: 'syscall \u7EA7\u62D2\u7EDD\u7684\u6267\u884C\u9762\uFF1A\u672A\u7B7E\u540D\u4E8C\u8FDB\u5236/\u8F7D\u8377\u7684\u6267\u884C\uFF08NeoAI \u7528"\u4E0D\u900F\u660E\u811A\u672C\u5347\u7EA7\u5BA1\u6279"\u8FD1\u4F3C\u8986\u76D6\uFF09'
  },
  FONT_DISABLE: {
    linuxControl: "\u5B57\u4F53\u89E3\u6790\u9762\u6536\u53E3\uFF08\u65E0\u76F4\u63A5 syscall \u5BF9\u5E94\uFF09",
    equivalentTo: "\u65E0\u76F4\u63A5\u5BF9\u5E94",
    substitutes: "\u8FDB\u7A0B\u4E0D\u53EF\u52A0\u8F7D\u975E\u7CFB\u7EDF\u5B57\u4F53 \u2014\u2014 \u6390\u6389\u5B57\u4F53\u89E3\u6790\u5668\u7684\u653B\u51FB\u9762\uFF08\u5386\u53F2\u4E0A TTF/OTF \u89E3\u6790\u5668\u662F\u5E38\u89C1\u7684 RCE \u9762\uFF09",
    enforcement: "REAL",
    gapClosed: "\u4E0D\u53EF\u4FE1\u6570\u636E \u2192 \u89E3\u6790\u5668\uFF08\u5B57\u4F53\uFF09\u8FD9\u6761\u4EE3\u7801\u6267\u884C\u8DEF\u5F84"
  },
  IMAGE_LOAD_NO_REMOTE: {
    linuxControl: "noexec \u6302\u8F7D / \u7981\u6B62\u4ECE\u8FDC\u7A0B\u6216\u53EF\u79FB\u52A8\u4ECB\u8D28\u6267\u884C",
    equivalentTo: "mount \u9762\u7684 noexec + \u8FDC\u7A0B\u8DEF\u5F84\u4E0D\u53EF\u6267\u884C\uFF08NeoAI \u7684 mount ns \u53EA\u8BFB/\u906E\u853D\u8FD1\u4F3C\uFF09",
    substitutes: "\u7981\u6B62\u4ECE\u8FDC\u7A0B\u8BBE\u5907\uFF08\u7F51\u7EDC\u5171\u4EAB\u3001\u53EF\u79FB\u52A8\u4ECB\u8D28\uFF09\u52A0\u8F7D\u6620\u50CF",
    enforcement: "REAL",
    gapClosed: '\u4ECE"\u533A\u5916/\u4E0D\u53EF\u4FE1\u5B58\u50A8"\u88C5\u8F7D\u53EF\u6267\u884C\u6620\u50CF\u8FD9\u6761\u8DEF\u5F84'
  },
  IMAGE_LOAD_NO_LOW_LABEL: {
    linuxControl: '\u7981\u6B62\u6267\u884C\u4F4E\u5B8C\u6574\u6027\u843D\u5730\u7269\uFF08\u6620\u5C04\u5230"\u6682\u5B58\u76EE\u5F55\u4E0D\u53EF\u6267\u884C"\uFF09',
    equivalentTo: "\u6302\u8F7D\u9762 noexec\uFF08\u5BF9\u4F4E\u6807\u7B7E\u6570\u636E\uFF09",
    substitutes: "\u7981\u6B62\u52A0\u8F7D\u5E26 Low \u5F3A\u5236\u6807\u7B7E\u7684\u6620\u50CF \u2014\u2014 \u4E0E AppContainer\uFF08Low IL\uFF09\u6B63\u597D\u4E92\u8865\uFF1A\u6C99\u7BB1\u91CC\u5199\u51FA\u6765\u7684\u4E1C\u897F\u4E0D\u80FD\u88AB\u5F53\u4F5C\u6620\u50CF\u88C5\u8F7D\u56DE\u6765",
    enforcement: "REAL",
    gapClosed: "\u8F7D\u8377\u843D\u76D8 \u2192 \u56DE\u8BFB\u6267\u884C\uFF08Low IL \u6682\u5B58\u7269\u5F53\u4E8C\u8FDB\u5236\u7528\uFF09\u8FD9\u6761\u8DEF\u5F84"
  },
  IMAGE_LOAD_PREFER_SYSTEM32: {
    linuxControl: "\u65E0\u76F4\u63A5\u5BF9\u5E94\uFF08DLL \u641C\u7D22\u987A\u5E8F\u662F Windows \u7279\u6709\uFF09",
    equivalentTo: "\u56FA\u5B9A\u5E93\u641C\u7D22\u8DEF\u5F84 / rpath \u6536\u7D27\uFF08\u8FD1\u4F3C\uFF09",
    substitutes: '\u540C\u540D DLL \u4F18\u5148\u4ECE System32 \u89E3\u6790\uFF0C\u963B\u6B62"\u672C\u5730\u6295\u653E\u540C\u540D DLL \u52AB\u6301\u52A0\u8F7D"',
    enforcement: "PARTIAL",
    notEquivalent: '\u5B83\u662F"\u4F18\u5148"\u800C\u975E"\u4EC5\u5141\u8BB8"\uFF1A\u975E System32 \u8DEF\u5F84\u4ECD\u53EF\u88AB\u663E\u5F0F\u52A0\u8F7D',
    gapClosed: 'DLL \u52AB\u6301/\u76F8\u5BF9\u8DEF\u5F84\u6295\u653E\uFF08\u672C\u4ED3\u5E93\u7684\u6682\u5B58\u76EE\u5F55\u6B63\u662F"\u53EF\u5199\u4E14\u53EF\u88AB\u5F53\u641C\u7D22\u8DEF\u5F84"\u7684\u4F4D\u7F6E\uFF09'
  }
});
var MITIGATION_PROFILES = Object.freeze({
  /** 不注入任何策略：`flags = 0n`，`applyMitigationPolicy` 会成为 no-op（`isNoop()` 可判） */
  none: Object.freeze([]),
  /**
   * 基线：DEP/ASLR/SEHOP/堆终止/严格句柄/CFG。
   * 为什么这七条"安全"：官方对它们的说明都是**加固既有行为**（DEP 开、映像强制重定位、
   * 分配面随机化、堆坏即终止、坏句柄抛异常、CFG 只约束已启用 CFG 的模块），
   * 没有一条要求二进制必须被签名或必须不开 JIT —— 因此普通工具链可承受。
   */
  baseline: Object.freeze([
    "DEP_ENABLE",
    "DEP_ATL_THUNK_ENABLE",
    "SEHOP_ENABLE",
    "FORCE_RELOCATE_IMAGES",
    "HEAP_TERMINATE",
    "BOTTOM_UP_ASLR",
    "HIGH_ENTROPY_ASLR",
    "STRICT_HANDLE_CHECKS",
    "CONTROL_FLOW_GUARD"
  ]),
  /** 加固：基线 + 禁 Win32k 系统调用 + 禁扩展点注入（对应 §5.1 第 4 条点名的两项） */
  hardened: Object.freeze([
    "DEP_ENABLE",
    "DEP_ATL_THUNK_ENABLE",
    "SEHOP_ENABLE",
    "FORCE_RELOCATE_IMAGES",
    "HEAP_TERMINATE",
    "BOTTOM_UP_ASLR",
    "HIGH_ENTROPY_ASLR",
    "STRICT_HANDLE_CHECKS",
    "CONTROL_FLOW_GUARD",
    "WIN32K_SYSTEM_CALL_DISABLE",
    "EXTENSION_POINT_DISABLE"
  ]),
  /**
   * 不可信载荷：加固 + ACG（禁动态代码）+ CIG（二进制签名）+ 禁非系统字体 + 禁远程映像。
   *
   * ⚠ **opt-in，且会破坏普通工具链**（如实声明，不得作为默认档）：
   *   - `PROHIBIT_DYNAMIC_CODE`（ACG）⇒ JIT 全部失效：**Node/V8 进程无法启动**，
   *     .NET/Java 同样不适用；任何运行期生成代码的运行时都会被拒；
   *   - `BLOCK_NON_MICROSOFT_BINARIES`（CIG）⇒ 签名策略生效：**未签名的 EXE/DLL 无法加载**，
   *     包括本仓库自己构建的未签名产物与 shim DLL；`ALLOW_STORE` 取值可放行 Store 应用，
   *     但本档取的是严格的 `ALWAYS_ON`；
   *   - `FONT_DISABLE` ⇒ 非系统字体不可加载（普通 CLI 无感，但任何依赖自带字体的渲染会变）；
   *   - `IMAGE_LOAD_NO_REMOTE` ⇒ 网络共享/可移动介质上的映像不可加载（含"从共享目录跑工具"）。
   *   `[未实测]` 本机没有跑过这些组合（无 SDK、未做真实 CreateProcess）；上面四条是
   *   **官方语义的直接推论**（`[官方]` 语义 + `[推断]` 后果），不是本机实测结论。
   *   用途：只给"已冻结、无 JIT、已签名"的候选载荷用。
   */
  untrusted: Object.freeze([
    "DEP_ENABLE",
    "DEP_ATL_THUNK_ENABLE",
    "SEHOP_ENABLE",
    "FORCE_RELOCATE_IMAGES",
    "HEAP_TERMINATE",
    "BOTTOM_UP_ASLR",
    "HIGH_ENTROPY_ASLR",
    "STRICT_HANDLE_CHECKS",
    "CONTROL_FLOW_GUARD",
    "WIN32K_SYSTEM_CALL_DISABLE",
    "EXTENSION_POINT_DISABLE",
    "PROHIBIT_DYNAMIC_CODE",
    "BLOCK_NON_MICROSOFT_BINARIES",
    "FONT_DISABLE",
    "IMAGE_LOAD_NO_REMOTE"
  ])
});
var MITIGATION_PROFILE_NAMES = Object.freeze(Object.keys(MITIGATION_PROFILES));
var DEFAULT_MITIGATION_PROFILE = "baseline";
var BLOCK_NON_MICROSOFT_BINARIES_ALLOW_STORE = 0x3n << 44n;
var PROHIBIT_DYNAMIC_CODE_ALLOW_OPT_OUT = 0x3n << 36n;
function mitigationError(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, extra);
  return error;
}
function win32BoolSucceeded(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return false;
}
function canonicaliseNames(names) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.sort((a, b) => MITIGATION_FLAGS[a] < MITIGATION_FLAGS[b] ? -1 : MITIGATION_FLAGS[a] > MITIGATION_FLAGS[b] ? 1 : 0);
}
function flagsForNames(names) {
  let flags = 0n;
  for (const name of names) flags |= MITIGATION_FLAGS[name];
  return flags;
}
function namesForFlags(flags) {
  const names = [];
  for (const [name, value] of Object.entries(MITIGATION_FLAGS)) {
    if ((flags & value) === value) names.push(name);
  }
  return canonicaliseNames(names);
}
function toFlagValue(value, where) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw mitigationError("MITIGATION_FLAGS_INVALID", `${where}: number must be a non-negative safe integer (got ${value}); pass a bigint for 64-bit masks`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^(0[xX])?[0-9a-fA-F]+$/.test(text)) {
      throw mitigationError("MITIGATION_FLAGS_INVALID", `${where}: string "${value}" is not a hexadecimal flag value`);
    }
    return BigInt(text.startsWith("0x") || text.startsWith("0X") ? text : `0x${text}`);
  }
  throw mitigationError("MITIGATION_FLAGS_INVALID", `${where}: expected bigint/number/hex-string, got ${value === null ? "null" : typeof value}`);
}
function assertFlagRange(flags, where) {
  if (flags < 0n || flags > 0xffffffffffffffffn) {
    throw mitigationError("MITIGATION_FLAGS_INVALID", `${where}: 0x${flags.toString(16)} does not fit in 64 bits (DWORD64)`);
  }
}
function assertKnownNames(list, where) {
  if (!Array.isArray(list)) {
    throw mitigationError("MITIGATION_SPEC_INVALID", `${where} must be an array of mitigation flag names`);
  }
  for (const name of list) {
    if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(MITIGATION_FLAGS, name)) {
      throw mitigationError(
        "MITIGATION_FLAG_UNKNOWN",
        `${where}: unknown mitigation flag ${JSON.stringify(name)}; known flags: ${Object.keys(MITIGATION_FLAGS).join(", ")}`,
        { unknown: String(name) }
      );
    }
  }
}
function normalizeSpec(spec) {
  const input = spec === void 0 || spec === null ? DEFAULT_MITIGATION_PROFILE : spec;
  if (typeof input === "string") {
    if (!Object.prototype.hasOwnProperty.call(MITIGATION_PROFILES, input)) {
      throw mitigationError(
        "MITIGATION_PROFILE_UNKNOWN",
        `unknown mitigation profile ${JSON.stringify(input)}; known profiles: ${MITIGATION_PROFILE_NAMES.join(", ")}`,
        { unknown: input }
      );
    }
    const names2 = canonicaliseNames(MITIGATION_PROFILES[input]);
    return { profile: input, names: names2, flags: flagsForNames(names2) };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw mitigationError("MITIGATION_SPEC_INVALID", `expected a profile name or a spec object, got ${Array.isArray(input) ? "array" : typeof input}`);
  }
  const hasFlags = input.flags !== void 0 && input.flags !== null;
  const hasInclude = input.include !== void 0 && input.include !== null;
  const hasExclude = input.exclude !== void 0 && input.exclude !== null;
  const hasProfile = input.profile !== void 0 && input.profile !== null;
  if (hasFlags && (hasInclude || hasExclude || hasProfile)) {
    throw mitigationError(
      "MITIGATION_SPEC_INVALID",
      "spec mixes {flags} with {profile|include|exclude}; pick one form \u2014 a silent precedence rule would make the resulting policy unguessable"
    );
  }
  if (hasFlags) {
    const flags = toFlagValue(input.flags, "spec.flags");
    assertFlagRange(flags, "spec.flags");
    const names2 = namesForFlags(flags);
    return { profile: "custom", names: names2, flags };
  }
  if (hasInclude) assertKnownNames(input.include, "spec.include");
  if (hasExclude) assertKnownNames(input.exclude, "spec.exclude");
  let profile;
  if (hasProfile) {
    if (typeof input.profile !== "string" || !Object.prototype.hasOwnProperty.call(MITIGATION_PROFILES, input.profile)) {
      throw mitigationError(
        "MITIGATION_PROFILE_UNKNOWN",
        `unknown mitigation profile ${JSON.stringify(input.profile)}; known profiles: ${MITIGATION_PROFILE_NAMES.join(", ")}`,
        { unknown: String(input.profile) }
      );
    }
    profile = input.profile;
  } else {
    profile = hasInclude || hasExclude ? "none" : DEFAULT_MITIGATION_PROFILE;
  }
  if (hasInclude && hasExclude) {
    const both = input.include.filter((name) => input.exclude.includes(name));
    if (both.length > 0) {
      throw mitigationError(
        "MITIGATION_SPEC_CONFLICT",
        `spec lists ${both.join(", ")} in both include and exclude; refusing to guess which side wins`,
        { conflicting: both }
      );
    }
  }
  const names = new Set(MITIGATION_PROFILES[profile]);
  for (const name of input.include ?? []) names.add(name);
  for (const name of input.exclude ?? []) names.delete(name);
  const ordered = canonicaliseNames([...names]);
  return { profile, names: ordered, flags: flagsForNames(ordered) };
}
function buildMitigationPolicy(profileOrNames = DEFAULT_MITIGATION_PROFILE) {
  const { profile, names, flags } = normalizeSpec(profileOrNames);
  const buffer = Buffer.alloc(MITIGATION_POLICY_VALUE_SIZE);
  buffer.writeBigUInt64LE(flags, 0);
  const result = {
    profile,
    names: Object.freeze(names),
    flags,
    buffer,
    hex: `0x${flags.toString(16).padStart(16, "0")}`
  };
  return Object.freeze(result);
}
function isBuiltPolicy(value) {
  return value !== null && typeof value === "object" && typeof value.flags === "bigint" && Buffer.isBuffer(value.buffer) && Array.isArray(value.names) && typeof value.profile === "string";
}
function resolvePinnedValue(pin, buffer, what) {
  if (pin === null || pin === void 0) return buffer;
  if (typeof pin === "function") {
    const resolved = pin(buffer, what);
    if (resolved === null || resolved === void 0) {
      throw mitigationError(
        "MITIGATION_PIN_FAILED",
        `pin(${what}) returned nothing; refusing to pass a buffer without a resolvable native address (the attribute value pointer must stay valid until the attribute list is destroyed)`
      );
    }
    return resolved;
  }
  return pin;
}
function applyMitigationPolicy({ api, attrList, policy, pin } = {}) {
  if (!api || typeof api.updateProcThreadAttribute !== "function") {
    throw mitigationError(
      "MITIGATION_BINDINGS_INVALID",
      "api.updateProcThreadAttribute is not a function; refusing to continue \u2014 an un-applied mitigation policy is not a policy"
    );
  }
  if (attrList === null || attrList === void 0) {
    throw mitigationError("MITIGATION_ATTRLIST_INVALID", "attrList is null/undefined; InitializeProcThreadAttributeList must run first (and must have sized the list for this extra attribute)");
  }
  const built = isBuiltPolicy(policy) ? policy : buildMitigationPolicy(policy ?? DEFAULT_MITIGATION_PROFILE);
  const value = resolvePinnedValue(pin, built.buffer, "PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY");
  const updated = api.updateProcThreadAttribute(
    attrList,
    0,
    MITIGATION_POLICY_ATTRIBUTE,
    value,
    MITIGATION_POLICY_VALUE_SIZE,
    null,
    null
  );
  if (!win32BoolSucceeded(updated)) {
    let code = null;
    if (typeof api.getLastError === "function") {
      try {
        code = api.getLastError();
      } catch {
        code = null;
      }
    }
    throw mitigationError(
      "MITIGATION_ATTRIBUTE_UPDATE_FAILED",
      `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY) failed with ${code}. Attr id=0x${MITIGATION_POLICY_ATTRIBUTE.toString(16)}, value size=${MITIGATION_POLICY_VALUE_SIZE}, profile=${built.profile}, flags=${built.hex}. The attribute list was NOT written, so the child would silently run WITHOUT these mitigations; aborting the launch (fail-closed).`,
      { win32Code: code, attribute: MITIGATION_POLICY_ATTRIBUTE, size: MITIGATION_POLICY_VALUE_SIZE, profile: built.profile, flags: built.flags }
    );
  }
  return {
    applied: true,
    attribute: MITIGATION_POLICY_ATTRIBUTE,
    size: MITIGATION_POLICY_VALUE_SIZE,
    value,
    flags: built.flags,
    names: built.names,
    profile: built.profile,
    noop: built.flags === 0n
  };
}
function summariseMitigations(result) {
  const built = isBuiltPolicy(result) ? result : buildMitigationPolicy(result ?? DEFAULT_MITIGATION_PROFILE);
  return {
    profile: built.profile,
    flags: `0x${built.flags.toString(16).padStart(16, "0")}`,
    names: [...built.names],
    attribute: `0x${MITIGATION_POLICY_ATTRIBUTE.toString(16).padStart(8, "0")}`,
    size: MITIGATION_POLICY_VALUE_SIZE,
    noop: built.flags === 0n
  };
}
var MITIGATION_ATTRIBUTE_LIST_COUNT = 1;
var __internal = Object.freeze({
  normalizeSpec,
  namesForFlags,
  flagsForNames,
  win32BoolSucceeded
});

// src/appcontainer-runtime.ts
var SE_GROUP_ENABLED = 4;
var SID_AND_ATTRIBUTES_SIZE = 16;
var OFF_SID_AND_ATTRIBUTES = Object.freeze({ sid: 0, attributes: 8 });
var PROCESS_INFORMATION_SIZE = 24;
var OFF_PROCESS_INFORMATION = Object.freeze({ hProcess: 0, hThread: 8, dwProcessId: 16, dwThreadId: 20 });
var CREATE_SUSPENDED = 4;
var DETACHED_PROCESS = 8;
var CREATE_NEW_CONSOLE = 16;
var STATUS_DLL_INIT_FAILED = 3221225794;
var TOKEN_QUERY_ACCESS = 8;
var TOKEN_DUPLICATE_ACCESS = 2;
var ERROR_INSUFFICIENT_BUFFER = 122;
var ERROR_ALREADY_EXISTS = 183;
var HR_ALREADY_EXISTS = 2147942583;
var DEFAULT_CAPABILITIES = Object.freeze([]);
var NETWORK_CAPABILITY = "internetClient";
function win32BoolSucceeded2(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return false;
}
function runtimeError(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, extra);
  return error;
}
function buildSidAndAttributesArray(capabilities = []) {
  if (!Array.isArray(capabilities)) throw new TypeError("buildSidAndAttributesArray: capabilities must be an array");
  const buffer = Buffer.alloc(capabilities.length * SID_AND_ATTRIBUTES_SIZE);
  capabilities.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw runtimeError("APPCONTAINER_CAPABILITY_INVALID", `capability[${index}] must be an object {sid, attributes?}`);
    }
    if (entry.sid === null || entry.sid === void 0) {
      throw runtimeError("APPCONTAINER_CAPABILITY_INVALID", `capability[${index}].sid is null \u2014 refusing to build a capability entry without a SID`);
    }
    const attributes = entry.attributes ?? SE_GROUP_ENABLED;
    if (!Number.isInteger(attributes) || attributes < 0) {
      throw runtimeError("APPCONTAINER_CAPABILITY_INVALID", `capability[${index}].attributes must be a non-negative integer`);
    }
    const base = index * SID_AND_ATTRIBUTES_SIZE;
    writePointerLe(buffer, base + OFF_SID_AND_ATTRIBUTES.sid, entry.sid, `capability[${index}].sid`);
    buffer.writeUInt32LE(attributes >>> 0, base + OFF_SID_AND_ATTRIBUTES.attributes);
  });
  return { buffer, count: capabilities.length };
}
function writePointerLe(buffer, offset, value, what = "pointer") {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("writePointerLe: buffer must be a Buffer");
  if (offset < 0 || offset + 8 > buffer.length) {
    throw runtimeError("APPCONTAINER_LAYOUT_OVERFLOW", `${what}: offset ${offset}+8 exceeds buffer length ${buffer.length}`);
  }
  if (value === null || value === void 0) {
    buffer.writeBigUInt64LE(0n, offset);
    return;
  }
  if (typeof value === "bigint") {
    buffer.writeBigUInt64LE(value, offset);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw runtimeError("APPCONTAINER_POINTER_INVALID", `${what}: numeric pointer must be a non-negative integer, got ${value}`);
    }
    buffer.writeBigUInt64LE(BigInt(value), offset);
    return;
  }
  if (typeof value === "object" && typeof value.address === "function") {
    const address = value.address();
    if (typeof address !== "bigint") {
      throw runtimeError("APPCONTAINER_POINTER_INVALID", `${what}: address() returned ${typeof address}, expected bigint`);
    }
    buffer.writeBigUInt64LE(address, offset);
    return;
  }
  throw runtimeError("APPCONTAINER_POINTER_INVALID", `${what}: cannot encode pointer of type ${typeof value}`);
}
var OFF_STARTUP_INFO_FLAGS = 60;
var OFF_STD_INPUT = 72;
var OFF_STD_OUTPUT = 80;
var OFF_STD_ERROR = 88;
var STARTF_USESTDHANDLES = 256;
function buildStartupInfoExBuffer({
  attributeListPointer = null,
  cb = STARTUPINFOEX_SIZE,
  stdInput = null,
  stdOutput = null,
  stdError = null,
  useStdHandles = false
} = {}) {
  if (cb !== STARTUPINFOEX_SIZE) {
    throw runtimeError(
      "APPCONTAINER_CB_INVALID",
      `STARTUPINFOEXW.cb must be ${STARTUPINFOEX_SIZE} (sizeof(STARTUPINFOEXW)), got ${cb}. Passing sizeof(STARTUPINFOW)=104 makes CreateProcess silently ignore lpAttributeList \u2014 the child starts successfully but is NOT in an AppContainer.`
    );
  }
  const buffer = Buffer.alloc(STARTUPINFOEX_SIZE);
  buffer.writeUInt32LE(STARTUPINFOEX_SIZE >>> 0, 0);
  writePointerLe(buffer, OFF_ATTRIBUTE_LIST, attributeListPointer, "lpAttributeList");
  if (useStdHandles) {
    writePointerLe(buffer, OFF_STD_INPUT, stdInput, "hStdInput");
    writePointerLe(buffer, OFF_STD_OUTPUT, stdOutput, "hStdOutput");
    writePointerLe(buffer, OFF_STD_ERROR, stdError, "hStdError");
    buffer.writeUInt32LE(STARTF_USESTDHANDLES >>> 0, OFF_STARTUP_INFO_FLAGS);
  }
  return buffer;
}
function allocateAttributeList(bindings, attributeCount) {
  if (!bindings || typeof bindings.initializeProcThreadAttributeList !== "function") {
    throw runtimeError("APPCONTAINER_BINDINGS_MISSING", "bindings.initializeProcThreadAttributeList is required");
  }
  if (!Number.isInteger(attributeCount) || attributeCount < 1) {
    throw runtimeError("APPCONTAINER_ATTRIBUTE_COUNT_INVALID", `attributeCount must be a positive integer, got ${attributeCount}`);
  }
  const sizeSlot = [0];
  const first = bindings.initializeProcThreadAttributeList(null, attributeCount, 0, sizeSlot);
  const firstError = typeof bindings.getLastError === "function" ? bindings.getLastError() : 0;
  if (!win32BoolSucceeded2(first) && firstError !== ERROR_INSUFFICIENT_BUFFER) {
    throw runtimeError(
      "APPCONTAINER_ATTRIBUTE_LIST_SIZE_FAILED",
      `InitializeProcThreadAttributeList(NULL, ${attributeCount}, 0, &size) failed with ${firstError}; only ERROR_INSUFFICIENT_BUFFER(122) is expected on the size-probing call`,
      { win32Code: firstError }
    );
  }
  const size = sizeSlot[0];
  if (!Number.isInteger(size) || size <= 0) {
    throw runtimeError("APPCONTAINER_ATTRIBUTE_LIST_SIZE_FAILED", `size probe returned ${size}; expected a positive size`);
  }
  const buffer = Buffer.alloc(size);
  const second = bindings.initializeProcThreadAttributeList(buffer, attributeCount, 0, sizeSlot);
  const secondError = typeof bindings.getLastError === "function" ? bindings.getLastError() : 0;
  if (!win32BoolSucceeded2(second)) {
    throw runtimeError(
      "APPCONTAINER_ATTRIBUTE_LIST_INIT_FAILED",
      `InitializeProcThreadAttributeList(buffer, ${attributeCount}, 0, &size) failed with ${secondError}`,
      { win32Code: secondError }
    );
  }
  return { size, buffer };
}
function resolveMitigationPolicy(policy) {
  if (policy === null || policy === void 0) return null;
  const built = typeof policy === "object" && typeof policy.flags === "bigint" && Buffer.isBuffer(policy.buffer) && Array.isArray(policy.names) ? policy : buildMitigationPolicy(policy);
  return built.flags === 0n ? null : built;
}
function attributeListCountFor(mitigationPolicy) {
  return resolveMitigationPolicy(mitigationPolicy) === null ? 1 : 1 + MITIGATION_ATTRIBUTE_LIST_COUNT;
}
function spawnSuspendedAppContainer(bindings, options = {}) {
  const {
    appContainerSid,
    capabilities = [],
    commandLine,
    applicationName = null,
    cwd = null,
    environmentBlock = null,
    capabilityArrayPointer = null,
    // `[实测-阶段FIX-B]` 见 CREATE_NEW_CONSOLE 的注释：默认**不**继承句柄。
    inheritHandles = false,
    extraCreationFlags = 0,
    // 文件式 stdio：调用方打开的原生句柄地址（`{stdInput,stdOutput,stdError}`）。
    // 只有 `inheritHandles=true` 时才有意义 —— 句柄要能被继承。
    startupInfoStdio = null,
    // 三轮接线：进程缓解策略。`null`/`undefined`/`none` ⇒ 行为与接线前**逐字一致**。
    mitigationPolicy = null
  } = options;
  for (const required of ["initializeProcThreadAttributeList", "updateProcThreadAttribute", "createProcessW", "resumeThread", "getLastError"]) {
    if (!bindings || typeof bindings[required] !== "function") {
      throw runtimeError("APPCONTAINER_BINDINGS_MISSING", `bindings.${required} is required to launch an AppContainer process`);
    }
  }
  if (appContainerSid === null || appContainerSid === void 0) {
    throw runtimeError("APPCONTAINER_SID_MISSING", "appContainerSid is required; refusing to launch without a package SID");
  }
  if (typeof commandLine !== "string" || commandLine.length === 0) {
    throw runtimeError("APPCONTAINER_COMMAND_MISSING", "commandLine must be a non-empty string");
  }
  const mitigation = resolveMitigationPolicy(mitigationPolicy);
  const attributeCount = mitigation === null ? 1 : 1 + MITIGATION_ATTRIBUTE_LIST_COUNT;
  const { buffer: attributeList } = allocateAttributeList(bindings, attributeCount);
  const capabilityArray = buildSidAndAttributesArray(capabilities);
  const pin = typeof options.pin === "function" ? options.pin : typeof bindings.pin === "function" ? bindings.pin : null;
  const resolvePointer = (explicit, buffer, what) => {
    let resolved = explicit;
    if ((resolved === null || resolved === void 0) && pin) resolved = pin(buffer, what);
    if (Buffer.isBuffer(resolved)) {
      throw runtimeError(
        "APPCONTAINER_POINTER_INVALID",
        `${what}: expected an address (bigint / non-negative number / object with address()), got a Buffer. A Buffer has no exposed native address in Node, so passing one is always a bug.`
      );
    }
    return resolved;
  };
  const attributeListPointer = resolvePointer(options.attributeListPointer ?? null, attributeList, "lpAttributeList");
  if (attributeListPointer === null || attributeListPointer === void 0) {
    throw runtimeError(
      "APPCONTAINER_PIN_REQUIRED",
      "STARTUPINFOEXW.lpAttributeList is an embedded pointer and must be supplied: pass pin (a (buffer, what) => address callback; with koffi use (b) => koffi.address(b), which createKoffiAppContainerBindings() already wires up as bindings.pin) or attributeListPointer explicitly. This module will not invent a placeholder pointer: CreateProcess would then either fail or, worse, succeed while silently ignoring the attribute list."
    );
  }
  let resolvedCapabilityPointer = null;
  if (capabilityArray.count > 0) {
    resolvedCapabilityPointer = resolvePointer(capabilityArrayPointer, capabilityArray.buffer, "Capabilities");
    if (resolvedCapabilityPointer === null || resolvedCapabilityPointer === void 0) {
      throw runtimeError(
        "APPCONTAINER_CAPABILITY_POINTER_MISSING",
        `${capabilityArray.count} capability SID(s) were supplied, so SECURITY_CAPABILITIES.Capabilities must point at their native SID_AND_ATTRIBUTES array \u2014 but no address was given. Pass capabilityArrayPointer (explicit address) or pin (a (buffer, what) => address callback; with koffi: (b) => koffi.address(b)). This module will not invent a placeholder pointer.`
      );
    }
  }
  const securityCapabilities = Buffer.alloc(SECURITY_CAPABILITIES_SIZE);
  writePointerLe(securityCapabilities, 0, appContainerSid, "AppContainerSid");
  writePointerLe(securityCapabilities, 8, resolvedCapabilityPointer, "Capabilities");
  securityCapabilities.writeUInt32LE(capabilityArray.count >>> 0, 16);
  securityCapabilities.writeUInt32LE(0, 20);
  const updated = bindings.updateProcThreadAttribute(
    attributeList,
    0,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    securityCapabilities,
    SECURITY_CAPABILITIES_SIZE,
    null,
    null
  );
  if (!win32BoolSucceeded2(updated)) {
    const code = bindings.getLastError();
    throw runtimeError(
      "APPCONTAINER_ATTRIBUTE_UPDATE_FAILED",
      `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES) failed with ${code}. Attr id=0x${PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES.toString(16)}, value size=${SECURITY_CAPABILITIES_SIZE}. [\u5B9E\u6D4B] \u672C\u673A cbSize=32 \u65F6\u8BE5\u8C03\u7528\u8FD4\u56DE false + ERROR_INVALID_PARAMETER(87)\uFF1A\u5B98\u65B9 sizeof(SECURITY_CAPABILITIES) \u662F 24 \uFF08PSID 8 + PSID_AND_ATTRIBUTES 8 + DWORD 4 + DWORD 4\uFF09\uFF0C\u89C1 .t/sbx3/dev/raw-probe-ac-token.txt \u7B2C B \u8282\u3002\u4FEE\u590D\u9636\u6BB5\u5DF2\u628A src/appcontainer.ts \u7684\u5E38\u91CF\u6539\u6210 24\uFF1B\u82E5\u8FD9\u91CC\u4ECD\u770B\u5230 87\uFF0C\u8BF4\u660E\u5931\u8D25\u539F\u56E0\u4E0D\u662F cbSize\u3002`,
      { win32Code: code }
    );
  }
  if (mitigation !== null) {
    try {
      applyMitigationPolicy({ api: bindings, attrList: attributeList, policy: mitigation, pin });
    } catch (error) {
      const win32Code = error?.win32Code ?? null;
      throw runtimeError(
        "APPCONTAINER_ATTRIBUTE_UPDATE_FAILED",
        `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY) failed with ${win32Code ?? "(no GetLastError)"}. Attr id=0x${MITIGATION_POLICY_ATTRIBUTE.toString(16)}, value size=${MITIGATION_POLICY_VALUE_SIZE}, profile=${mitigation.profile}, flags=0x${mitigation.flags.toString(16).padStart(16, "0")}, win32Code=${win32Code ?? "null"}, mitigationCode=${error?.code ?? "MITIGATION_ATTRIBUTE_UPDATE_FAILED"}. The attribute list was NOT written, so the child would silently run WITHOUT these mitigations; aborting the launch (fail-closed). \u5E95\u5C42\u9519\u8BEF\uFF1A${error?.message ?? String(error)}`,
        {
          win32Code,
          mitigationCode: error?.code ?? null,
          attribute: MITIGATION_POLICY_ATTRIBUTE,
          size: MITIGATION_POLICY_VALUE_SIZE,
          profile: mitigation.profile
        }
      );
    }
  }
  const startupInfo = buildStartupInfoExBuffer(
    startupInfoStdio ? {
      attributeListPointer,
      useStdHandles: true,
      stdInput: startupInfoStdio.stdInput,
      stdOutput: startupInfoStdio.stdOutput,
      stdError: startupInfoStdio.stdError
    } : { attributeListPointer }
  );
  const flags = (buildCreationFlags(environmentBlock !== null && environmentBlock !== void 0) | CREATE_SUSPENDED | extraCreationFlags >>> 0) >>> 0;
  if ((flags & EXTENDED_STARTUPINFO_PRESENT) === 0) {
    throw runtimeError("APPCONTAINER_FLAGS_INVALID", "EXTENDED_STARTUPINFO_PRESENT is missing; the attribute list would be ignored");
  }
  if (inheritHandles && (flags & (CREATE_NEW_CONSOLE | DETACHED_PROCESS)) === 0) {
    throw runtimeError(
      "APPCONTAINER_HANDLE_INHERITANCE_UNSAFE",
      "inheritHandles=true without CREATE_NEW_CONSOLE or DETACHED_PROCESS makes an AppContainer child die during user-mode initialization with STATUS_DLL_INIT_FAILED (0xC0000142): CreateProcessW still reports success and the token IS an AppContainer token, but the child never runs a single instruction of the command. Pass inheritHandles=false, or add CREATE_NEW_CONSOLE / DETACHED_PROCESS via extraCreationFlags. [\u5B9E\u6D4B] raw evidence: .t/sbx3/dev/raw-t0-launch-matrix.txt",
      { win32Code: STATUS_DLL_INIT_FAILED, flags }
    );
  }
  if (startupInfoStdio && !inheritHandles) {
    throw runtimeError(
      "APPCONTAINER_STDIO_WITHOUT_INHERITANCE",
      "startupInfoStdio was supplied but inheritHandles=false: the handles cannot be inherited, so the child would write to the parent console (or to an invalid handle) while the caller reads an empty file. Pass inheritHandles=true together with CREATE_NEW_CONSOLE / DETACHED_PROCESS.",
      { flags }
    );
  }
  const out = { process: null, thread: null, pid: 0 };
  const created = bindings.createProcessW(
    applicationName,
    commandLine,
    null,
    null,
    // `[实测-阶段FIX-B]` 默认 **false**：AppContainer 子进程继承父进程句柄会 0xC0000142（见上）。
    // 需要匿名管道 stdio 时，显式传 inheritHandles=true **并且** extraCreationFlags|=DETACHED_PROCESS。
    inheritHandles,
    flags,
    environmentBlock,
    cwd,
    startupInfo,
    out
  );
  if (!win32BoolSucceeded2(created)) {
    const code = bindings.getLastError();
    throw runtimeError(
      "APPCONTAINER_CREATE_PROCESS_FAILED",
      `CreateProcessW failed with ${code} (flags=0x${flags.toString(16)}, cb=112). Note: console programs (node.exe / powershell.exe) may fail inside an AppContainer for reasons unrelated to this call \u2014 see .t/sbx3/dev/00-\u73B0\u72B6\u4E0E\u8BBE\u8BA1.md \xA77.2 F1.`,
      { win32Code: code }
    );
  }
  if (!out.process || !out.thread) {
    if (out.process) {
      try {
        bindings.terminateProcess?.(out.process, 1);
      } catch {
      }
    }
    throw runtimeError("APPCONTAINER_CREATE_PROCESS_FAILED", "CreateProcessW reported success but returned a null process/thread handle");
  }
  return {
    pid: out.pid,
    process: out.process,
    thread: out.thread,
    attributeList,
    startupInfo,
    securityCapabilities,
    capabilityArray: capabilityArray.buffer,
    capabilityArrayPointer: resolvedCapabilityPointer,
    attributeListPointer,
    // 三轮接线：属性列表实际按几个槽位初始化，以及那份**必须活到列表销毁**的
    // 缓解策略对象（调用方持有它 = 持有 `buffer`；`[官方]` 属性值指针的生命周期要求）。
    attributeCount,
    mitigationPolicy: mitigation
  };
}
function resumeSuspendedProcess(bindings, handle) {
  const result = bindings.resumeThread(handle);
  if (result >>> 0 === 4294967295) {
    const code = bindings.getLastError();
    throw runtimeError("APPCONTAINER_RESUME_FAILED", `ResumeThread failed with ${code}`, { win32Code: code });
  }
  return { previousSuspendCount: result };
}
var TOKEN_INFORMATION_CLASS = Object.freeze({
  TokenUser: 1,
  TokenGroups: 2,
  TokenType: 8,
  TokenElevation: 20,
  TokenIntegrityLevel: 25,
  TokenIsAppContainer: 29,
  TokenCapabilities: 30,
  TokenAppContainerSid: 31
});
var SID_LOW_INTEGRITY = "S-1-16-4096";
var SID_AND_ATTRIBUTES_OFFSET = 8;
var TOKEN_GROUPS_HEADER_SIZE = 8;
function sidPointerFromBuffer(buffer, offset) {
  const pointer = buffer.readBigUInt64LE(offset);
  return pointer === 0n ? null : pointer;
}
function readProcessTokenFacts(bindings, processHandle) {
  for (const required of ["openProcessToken", "getTokenInformation", "closeHandle"]) {
    if (!bindings || typeof bindings[required] !== "function") {
      throw runtimeError("APPCONTAINER_BINDINGS_MISSING", `bindings.${required} is required to read token facts`);
    }
  }
  const tokenSlot = [null];
  if (!win32BoolSucceeded2(bindings.openProcessToken(processHandle, TOKEN_QUERY_ACCESS, tokenSlot))) {
    const code = typeof bindings.getLastError === "function" ? bindings.getLastError() : null;
    throw runtimeError("APPCONTAINER_TOKEN_OPEN_FAILED", `OpenProcessToken(TOKEN_QUERY) failed with ${code}`, { win32Code: code });
  }
  const token = tokenSlot[0];
  const failures = [];
  const read = (infoClass, size) => {
    const buffer = Buffer.alloc(size);
    const needed = [0];
    const ok = win32BoolSucceeded2(bindings.getTokenInformation(token, infoClass, buffer, buffer.length, needed));
    if (!ok) failures.push({ infoClass, needed: needed[0] });
    return { ok, buffer };
  };
  const sidToString = typeof bindings.sidToString === "function" ? bindings.sidToString : () => null;
  const readSid = (infoClass) => {
    const result = read(infoClass, 256);
    if (!result.ok) return null;
    const pointer = sidPointerFromBuffer(result.buffer, 0);
    return pointer === null ? null : sidToString(pointer);
  };
  const readGroups = (infoClass) => {
    const result = read(infoClass, 8192);
    if (!result.ok) return { count: null, sids: [] };
    const count = result.buffer.readUInt32LE(0);
    const sids = [];
    for (let index = 0; index < count; index += 1) {
      const base = TOKEN_GROUPS_HEADER_SIZE + index * SID_AND_ATTRIBUTES_SIZE;
      if (base + SID_AND_ATTRIBUTES_SIZE > result.buffer.length) break;
      const pointer = sidPointerFromBuffer(result.buffer, base);
      if (pointer !== null) sids.push(sidToString(pointer));
    }
    return { count, sids };
  };
  try {
    const isAppContainer = read(TOKEN_INFORMATION_CLASS.TokenIsAppContainer, 4);
    if (!isAppContainer.ok) {
      throw runtimeError(
        "APPCONTAINER_TOKEN_QUERY_FAILED",
        "GetTokenInformation(TokenIsAppContainer=29) failed \u2014 refusing to guess whether the child is confined",
        { details: failures }
      );
    }
    const type = read(TOKEN_INFORMATION_CLASS.TokenType, 4);
    const elevation = read(TOKEN_INFORMATION_CLASS.TokenElevation, 4);
    const facts = {
      isAppContainer: isAppContainer.buffer.readUInt32LE(0) === 1,
      appContainerSid: readSid(TOKEN_INFORMATION_CLASS.TokenAppContainerSid),
      tokenUser: readSid(TOKEN_INFORMATION_CLASS.TokenUser),
      integrityLevel: readSid(TOKEN_INFORMATION_CLASS.TokenIntegrityLevel),
      capabilities: readGroups(TOKEN_INFORMATION_CLASS.TokenCapabilities),
      groups: readGroups(TOKEN_INFORMATION_CLASS.TokenGroups),
      tokenType: type.ok ? type.buffer.readUInt32LE(0) : null,
      elevated: elevation.ok ? elevation.buffer.readUInt32LE(0) === 1 : null,
      failedQueries: failures,
      evidence: "[\u5B9E\u6D4B] OpenProcessToken + GetTokenInformation \u76F4\u67E5\u5B50\u8FDB\u7A0B\u4EE4\u724C"
    };
    return facts;
  } finally {
    try {
      bindings.closeHandle(token);
    } catch {
    }
  }
}
function assessAppContainerIsolation(observations = {}) {
  const { tokenFacts = null, expectedSid = null, outsideWrite = null, network = null } = observations;
  const checks = [];
  const push = (name, ok, detail, evidence) => {
    checks.push({ name, ok: ok === true, detail, evidence });
    return ok === true;
  };
  push(
    "token-is-app-container",
    tokenFacts?.isAppContainer === true,
    tokenFacts ? `TokenIsAppContainer=${tokenFacts.isAppContainer}` : "no token facts were collected",
    tokenFacts?.evidence ?? "[\u672A\u5B9E\u6D4B]"
  );
  const actualSid = tokenFacts?.appContainerSid ?? null;
  push(
    "package-sid-matches",
    typeof actualSid === "string" && typeof expectedSid === "string" && actualSid.toLowerCase() === expectedSid.toLowerCase(),
    `TokenAppContainerSid=${actualSid ?? "(null)"} expected=${expectedSid ?? "(none)"}`,
    tokenFacts?.evidence ?? "[\u672A\u5B9E\u6D4B]"
  );
  push(
    "low-integrity",
    tokenFacts?.integrityLevel === SID_LOW_INTEGRITY,
    `TokenIntegrityLevel=${tokenFacts?.integrityLevel ?? "(null)"} expected=${SID_LOW_INTEGRITY}`,
    tokenFacts?.evidence ?? "[\u672A\u5B9E\u6D4B]"
  );
  push(
    "outside-write-blocked",
    outsideWrite?.attempted === true && outsideWrite?.blocked === true,
    outsideWrite ? `attempted=${outsideWrite.attempted === true} blocked=${outsideWrite.blocked === true} ${outsideWrite.detail ?? ""}`.trim() : "no outside-write measurement was supplied \u2014 AppContainer file confinement is NOT proven",
    outsideWrite?.evidence ?? "[\u672A\u5B9E\u6D4B]"
  );
  push(
    "network-blocked",
    network?.attempted === true && network?.blocked === true,
    network ? `attempted=${network.attempted === true} blocked=${network.blocked === true} ${network.detail ?? ""}`.trim() : "no network measurement was supplied \u2014 AppContainer network confinement is NOT proven",
    network?.evidence ?? "[\u672A\u5B9E\u6D4B]"
  );
  const proven = checks.every((check) => check.ok);
  return {
    proven,
    checks,
    blocking: checks.filter((check) => !check.ok).map((check) => check.name),
    note: 'proven=true \u53EA\u4EE3\u8868"\u8FD9\u4E00\u6B21\u5B9E\u6D4B\u89C2\u6D4B\u5230\u4E86\u9694\u79BB"\uFF1B\u5B83\u4E0D\u7F13\u5B58\u3001\u4E0D\u8DE8\u914D\u7F6E\u590D\u7528\u3002\u5305 SID \u662F per-profile \u7684\uFF1A\u6362 profile\u3001\u6362\u80FD\u529B\u96C6\u3001\u6362\u542F\u52A8\u53C2\u6570\u90FD\u5FC5\u987B\u91CD\u65B0\u6D4B\u3002'
  };
}
function planCombinationOrder(facts = {}) {
  const { jobAvailable = false } = facts;
  const steps = [
    { step: "derive-or-create-profile", required: true, reason: "\u5305 SID \u662F AppContainer \u8EAB\u4EFD\u7684\u552F\u4E00\u6765\u6E90" },
    { step: "build-security-capabilities", required: true, reason: "SECURITY_CAPABILITIES \u5FC5\u987B\u7531\u8C03\u7528\u65B9\u6301\u6709\u751F\u547D\u5468\u671F" },
    { step: "initialize-attribute-list", required: true, reason: "\u5B98\u65B9\u4E24\u9636\u6BB5\u534F\u5546\uFF1B\u9996\u6B21\u8C03\u7528\u6309\u8BBE\u8BA1\u8FD4\u56DE ERROR_INSUFFICIENT_BUFFER" },
    { step: "update-proc-thread-attribute", required: true, reason: "PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES \u51B3\u5B9A\u5B50\u8FDB\u7A0B\u8EAB\u4EFD" },
    { step: "create-process-suspended", required: true, reason: 'CREATE_SUSPENDED \u662F\u6D88\u9664"\u6302 Job \u524D\u7ADE\u6001"(R9) \u7684\u552F\u4E00\u624B\u6BB5' }
  ];
  if (jobAvailable) {
    steps.push({ step: "assign-to-job", required: true, reason: "\u8FDB\u7A0B\u6811\u56DE\u6536\u4E0E\u8D44\u6E90\u4E0A\u9650\uFF1B\u5B98\u65B9\u65E0\u66FF\u4EE3\u624B\u6BB5" });
    steps.push({ step: "resume-thread", required: true, reason: "CREATE_SUSPENDED \u540E\u4E0D resume \u5B50\u8FDB\u7A0B\u6C38\u4E0D\u6267\u884C\uFF08\u75C7\u72B6=\u8D85\u65F6\uFF09" });
  } else {
    steps.push({ step: "no-job", required: true, reason: "\u65E0 Job \u65F6\u8FDB\u7A0B\u6811\u56DE\u6536\u4E0D\u53EF\u4FDD\u8BC1 \u2014\u2014 \u5FC5\u987B\u5728\u62A5\u544A\u91CC\u58F0\u660E\u4E3A\u6B8B\u4F59\u8FB9\u754C" });
  }
  steps.push({
    step: "skip-explicit-low-integrity",
    required: false,
    reason: "AppContainer \u81EA\u5E26 Low IL\uFF1B\u989D\u5916 SetTokenInformation \u9700\u8981 TOKEN_ADJUST_DEFAULT\uFF08\u672C\u673A\u7F3A\u5931\uFF09\u4E14\u53E0\u52A0\u4E24\u5C42 no-write-up"
  });
  const residuals = [];
  if (!jobAvailable) residuals.push("process-tree reclamation (KILL_ON_JOB_CLOSE) is NOT enforced without a Job Object");
  residuals.push(
    "filesystem access inside the AppContainer is granted by the package SID DACL: the staged root must be explicitly granted to the AppContainer SID, otherwise even the staged root becomes unwritable"
  );
  return { steps, residuals };
}
var AppContainerRuntime = class {
  /**
   * @param {object} bindings 见 `spawnSuspendedAppContainer` 的说明，另需
   *   `deriveAppContainerSidFromAppContainerName` / `createAppContainerProfile` /
   *   `deleteAppContainerProfile` / `deriveCapabilitySidsFromName` /
   *   `deleteProcThreadAttributeList`（可选但强烈建议）
   * @param {{profileName: string, capabilities?: Array<{name: string, sid?: unknown}>, jobAvailable?: boolean, retainPointer?: Function}} options
   */
  constructor(bindings, options = {}) {
    if (!bindings || typeof bindings !== "object") throw new TypeError("AppContainerRuntime requires a bindings object");
    this.bindings = bindings;
    this.options = options;
    this.profileName = options.profileName;
    if (typeof this.profileName !== "string" || this.profileName.length === 0) {
      throw runtimeError("APPCONTAINER_PROFILE_NAME_INVALID", "options.profileName must be a non-empty string");
    }
    this.createdHere = false;
    this.sid = null;
    this.sidString = null;
    this.capabilities = [];
    this.derivedCapabilitySids = [];
    this.attributeList = null;
    this.disposed = false;
    this.retainPointer = typeof options.retainPointer === "function" ? options.retainPointer : () => {
    };
    this.mitigationPolicy = resolveMitigationPolicy(options.mitigationPolicy ?? null);
    this.pin = typeof options.pin === "function" ? options.pin : typeof bindings.pin === "function" ? bindings.pin : null;
  }
  /**
   * 解析/创建 profile 与能力 SID。
   *
   * 顺序（`[官方]` `[Launch an AppContainer]` 的 `CreateProfileForAppContainer` 样例）：
   *   1. 先 `CreateAppContainerProfile`；
   *   2. 若 `hr === HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)`（0x800700B7），
   *      再 `DeriveAppContainerSidFromAppContainerName`；
   *   3. 若第 1 步是**其它**失败码，直接抛 —— **不**"顺手派生一个试试"。
   *
   * 为什么第 3 条重要：阶段 A `[实测]` 受限令牌下 `CreateAppContainerProfile` 返回
   * `E_ACCESSDENIED(0x80070005)`，而 `DeriveAppContainerSidFromAppContainerName`
   * **返回 hr=0 且给出一个 SID**（阶段 B 复测同样如此：profile 不存在也能派生）。
   * 如果按"失败就派生"的逻辑写，就会拿到一个**指向不存在 profile 的 SID**，
   * 然后 `CreateProcess` 失败在别处 —— 故障点被推远，根因报告会变成"说不清哪里坏了"。
   * 因此本实现把"派生"严格限制在 `ALREADY_EXISTS` 这一种情况。
   *
   * ── 阶段 B 实测缺陷：本方法**不能**是 `async` ──────────────────────────────────
   * 初版写成 `async init()`，但方法体内**一个 `await` 都没有**（全部是同步 Win32 调用）。
   * 后果不是"多一层包装"，而是**把 fail-closed 路径整体变成不可观测**：
   *   - `init()` 返回 Promise 而不是报告对象 ⇒ 同步调用方拿到 `undefined`；
   *   - 更严重的是**抛错变成 rejected promise** ⇒ `try { runtime.init() } catch (e)` 捕获不到，
   *     所有"打不开 profile 就必须抛"的断言全部退化为"没抛错"，
   *     而 rejection 若无人 `await` 还会变成 unhandledRejection（在 Node 里默认是致命错误）。
   * 这正是本模块开头警告的那一类"看起来正常、实际边界没生效"的失效，故**去掉 `async`**，
   * 与同类中的 `spawn()` / `resume()` / `dispose()` 保持一致（它们本来就是同步的）。
   */
  init() {
    const b = this.bindings;
    if (typeof b.createAppContainerProfile !== "function" && typeof b.deriveAppContainerSidFromAppContainerName !== "function") {
      throw runtimeError(
        "APPCONTAINER_BINDINGS_MISSING",
        "bindings must provide createAppContainerProfile and/or deriveAppContainerSidFromAppContainerName"
      );
    }
    if (typeof b.createAppContainerProfile === "function") {
      const hr = b.createAppContainerProfile(this.profileName, this.profileName, "WinStageSandbox AppContainer", null, 0);
      const status = hrStatus(hr);
      if (status === 0) {
        this.createdHere = true;
        this.sid = extractSid(hr);
      } else if (status === HR_ALREADY_EXISTS) {
        this.createdHere = false;
      } else {
        throw runtimeError(
          "APPCONTAINER_PROFILE_CREATE_FAILED",
          `CreateAppContainerProfile(${this.profileName}) failed hr=0x${status.toString(16)}${status === 2147942405 ? " (E_ACCESSDENIED)" : ""}. Refusing to fall back to DeriveAppContainerSidFromAppContainerName: deriving a SID for a profile that does not exist yields a SID that no access check will ever match (the failure would move somewhere else).`,
          { hr: status }
        );
      }
    }
    if (this.sid === null) {
      if (typeof b.deriveAppContainerSidFromAppContainerName !== "function") {
        throw runtimeError("APPCONTAINER_BINDINGS_MISSING", "profile already existed but deriveAppContainerSidFromAppContainerName is not bound");
      }
      const derived = b.deriveAppContainerSidFromAppContainerName(this.profileName);
      const status = hrStatus(derived);
      if (status !== 0) {
        throw runtimeError("APPCONTAINER_SID_DERIVE_FAILED", `DeriveAppContainerSidFromAppContainerName failed hr=0x${status.toString(16)}`, {
          hr: status
        });
      }
      this.sid = extractSid(derived);
    }
    if (this.sid === null || this.sid === void 0) {
      throw runtimeError("APPCONTAINER_SID_MISSING", "no package SID was produced by create/derive");
    }
    const requested = this.options.capabilities ?? DEFAULT_CAPABILITIES;
    if (!Array.isArray(requested)) throw new TypeError("options.capabilities must be an array");
    if (requested.length > 0 && typeof b.deriveCapabilitySidsFromName !== "function") {
      throw runtimeError(
        "APPCONTAINER_BINDINGS_MISSING",
        "capabilities were requested but bindings.deriveCapabilitySidsFromName is not bound"
      );
    }
    this.capabilities = [];
    for (const capability of requested) {
      const name = typeof capability === "string" ? capability : capability?.name;
      if (typeof name !== "string" || name.length === 0) {
        throw runtimeError("APPCONTAINER_CAPABILITY_INVALID", `capability entry must be a name string or {name}, got ${JSON.stringify(capability)}`);
      }
      const givenSid = capability?.sid ?? null;
      const sid = givenSid ?? deriveOneCapabilitySid(b, name);
      if (sid === null || sid === void 0) {
        throw runtimeError("APPCONTAINER_CAPABILITY_INVALID", `DeriveCapabilitySidsFromName(${name}) produced no capability SID`);
      }
      const derivedHere = givenSid === null || givenSid === void 0;
      if (derivedHere) this.derivedCapabilitySids.push(sid);
      this.capabilities.push({ name, sid, attributes: SE_GROUP_ENABLED, derivedHere });
    }
    this.attributeList = allocateAttributeList(b, attributeListCountFor(this.mitigationPolicy)).buffer;
    this.order = planCombinationOrder({ jobAvailable: this.options.jobAvailable === true });
    return {
      profileName: this.profileName,
      createdHere: this.createdHere,
      sid: this.sid,
      capabilities: this.capabilities.map((c) => c.name),
      attributeListSize: this.attributeList.length,
      order: this.order,
      // 三轮接线：报告里如实给出"策略档位 + 16 个十六进制标志位 + 是否 no-op"，
      // 免得只写一句"已启用缓解策略"（`mitigations.ts` 的摘要口径）。
      mitigation: this.mitigationPolicy === null ? null : { profile: this.mitigationPolicy.profile, flags: this.mitigationPolicy.hex, names: [...this.mitigationPolicy.names] },
      attributeCount: attributeListCountFor(this.mitigationPolicy)
    };
  }
  /** 启动一个挂起的 AppContainer 进程（调用方必须随后挂 Job 并 `resume()`） */
  spawn(options = {}) {
    if (this.disposed) throw runtimeError("APPCONTAINER_DISPOSED", "runtime already disposed");
    if (!this.attributeList) throw runtimeError("APPCONTAINER_NOT_INITIALIZED", "call init() before spawn()");
    const child = spawnSuspendedAppContainer(this.bindings, {
      pin: this.pin,
      // 实例级策略（`null` ⇒ spawnSuspendedAppContainer 完全不碰该属性）。
      // 刻意放在 `...options` **之前**：单次启动可以覆盖它，但默认继承实例配置。
      mitigationPolicy: this.mitigationPolicy,
      ...options,
      appContainerSid: this.sid,
      capabilities: this.capabilities
    });
    this.retainPointer("appcontainer", child.attributeList);
    this.retainPointer("appcontainer", child.securityCapabilities);
    this.retainPointer("appcontainer", child.capabilityArray);
    if (child.mitigationPolicy) this.retainPointer("appcontainer", child.mitigationPolicy.buffer);
    return child;
  }
  /** 恢复挂起的子进程（必须调用；见 `planCombinationOrder`） */
  resume(child) {
    return resumeSuspendedProcess(this.bindings, child.thread);
  }
  /**
   * 逆序释放：属性列表 → 能力 SID 数组 → profile。
   *
   * **只删自己创建的 profile**（`createdHere`）。删别人的 profile 会破坏同机其它 AppContainer
   * 应用的 `LOCALAPPDATA` 重定向目录，是典型的"清理越权"。
   */
  dispose() {
    this.disposed = true;
    const failures = [];
    if (this.attributeList && typeof this.bindings.deleteProcThreadAttributeList === "function") {
      try {
        const rc = this.bindings.deleteProcThreadAttributeList(this.attributeList);
        if (rc === 0 && typeof this.bindings.getLastError === "function") {
          failures.push(`DeleteProcThreadAttributeList reported failure (GetLastError=${this.bindings.getLastError()})`);
        }
      } catch (error) {
        failures.push(`DeleteProcThreadAttributeList threw: ${error.message}`);
      }
    }
    if (this.createdHere && typeof this.bindings.deleteAppContainerProfile === "function") {
      try {
        const hr = this.bindings.deleteAppContainerProfile(this.profileName);
        const status = hrStatus(hr);
        if (status !== 0) failures.push(`DeleteAppContainerProfile(${this.profileName}) failed hr=0x${status.toString(16)}`);
      } catch (error) {
        failures.push(`DeleteAppContainerProfile threw: ${error.message}`);
      }
    }
    for (const sid of this.derivedCapabilitySids) {
      if (typeof this.bindings.localFree !== "function") {
        failures.push("derived capability SIDs were not freed: bindings.localFree is not available");
        break;
      }
      try {
        if (this.bindings.localFree(sid) !== true) failures.push(`LocalFree(derived capability SID) reported failure`);
      } catch (error) {
        failures.push(`LocalFree(derived capability SID) threw: ${error.message}`);
      }
    }
    this.derivedCapabilitySids = [];
    this.capabilities = [];
    this.attributeList = null;
    return { disposed: true, failures, deletedProfile: this.createdHere };
  }
};
function hrStatus(value) {
  if (typeof value === "number") return value >>> 0;
  if (value !== null && typeof value === "object" && typeof value.hr === "number") return value.hr >>> 0;
  if (value !== null && typeof value === "object" && typeof value.status === "number") return value.status >>> 0;
  return 0;
}
function extractSid(value) {
  if (value === null || value === void 0) return null;
  if (typeof value === "object") {
    if ("sid" in value) return value.sid;
    if ("value" in value) return value.value;
    return value;
  }
  return value;
}
function deriveOneCapabilitySid(bindings, name) {
  const out = bindings.deriveCapabilitySidsFromName(name);
  if (!out) return null;
  const capabilitySids = out.capabilitySids ?? out.capabilitySid ?? out.capability;
  if (Array.isArray(capabilitySids)) return capabilitySids[0] ?? null;
  return capabilitySids ?? null;
}
function createKoffiAppContainerBindings(koffi, libs = {}) {
  if (!koffi || typeof koffi.load !== "function") throw new TypeError("createKoffiAppContainerBindings requires the koffi module");
  const userenv = libs.userenv ?? koffi.load("userenv.dll");
  const kernel32 = libs.kernel32 ?? koffi.load("kernel32.dll");
  const advapi32 = libs.advapi32 ?? koffi.load("advapi32.dll");
  const kernelBase = libs.kernelBase ?? koffi.load("kernelbase.dll");
  const CreateAppContainerProfile = userenv.func(
    "long CreateAppContainerProfile(const char16_t *name, const char16_t *displayName, const char16_t *description, void *capabilities, uint32 capabilityCount, _Out_ void **sid)"
  );
  const DeriveAppContainerSidFromAppContainerName = userenv.func(
    "long DeriveAppContainerSidFromAppContainerName(const char16_t *name, _Out_ void **sid)"
  );
  const DeleteAppContainerProfile = userenv.func("long DeleteAppContainerProfile(const char16_t *name)");
  const DeriveCapabilitySidsFromName = kernelBase.func(
    "bool DeriveCapabilitySidsFromName(const char16_t *capName, _Out_ void **groupSids, _Out_ uint32 *groupSidCount, _Out_ void **capabilitySids, _Out_ uint32 *capabilitySidCount)"
  );
  const LocalFree = kernel32.func("void *LocalFree(void *h)");
  const InitializeProcThreadAttributeList = kernel32.func(
    "bool InitializeProcThreadAttributeList(void *list, uint32 count, uint32 flags, _Inout_ size_t *size)"
  );
  const UpdateProcThreadAttribute = kernel32.func(
    "bool UpdateProcThreadAttribute(void *list, uint32 flags, size_t attribute, void *value, size_t size, void *prev, void *returnSize)"
  );
  const DeleteProcThreadAttributeList = kernel32.func("void DeleteProcThreadAttributeList(void *list)");
  const GetLastError = kernel32.func("uint32 GetLastError()");
  const ResumeThread = kernel32.func("uint32 ResumeThread(void *thread)");
  const TerminateProcess = kernel32.func("bool TerminateProcess(void *process, uint32 code)");
  const CloseHandleRaw = kernel32.func("bool CloseHandle(void *handle)");
  const ConvertSidToStringSidW = advapi32.func("bool ConvertSidToStringSidW(void *sid, _Out_ void **str)");
  const OpenProcessToken = advapi32.func("bool OpenProcessToken(void *process, uint32 access, _Out_ void **token)");
  const GetTokenInformation = advapi32.func("bool GetTokenInformation(void *token, int infoClass, _Out_ uint8 *info, uint32 len, _Out_ uint32 *needed)");
  const CreateProcessWRaw = kernel32.func(
    "bool CreateProcessW(const char16_t *app, const char16_t *cmd, void *pa, void *ta, bool inherit, uint32 flags, void *env, const char16_t *cwd, void *si, _Out_ uint8 *pi)"
  );
  const readSidPointerArray = (arrayAddress, count) => {
    if (arrayAddress === null || arrayAddress === void 0 || !Number.isFinite(count) || count <= 0) return [];
    const address = typeof arrayAddress === "bigint" ? arrayAddress : BigInt(arrayAddress);
    const decoded = koffi.decode(address, "uint64", count);
    const out = [];
    for (let index = 0; index < count; index += 1) out.push(decoded[index]);
    return out;
  };
  const freeNative = (pointer) => {
    if (pointer === null || pointer === void 0) return false;
    try {
      LocalFree(pointer);
      return true;
    } catch {
      return false;
    }
  };
  return {
    createAppContainerProfile(name, displayName, description) {
      const slot = [null];
      const hr = CreateAppContainerProfile(name, displayName, description, null, 0, slot);
      return { hr: hr >>> 0, sid: slot[0] };
    },
    deriveAppContainerSidFromAppContainerName(name) {
      const slot = [null];
      const hr = DeriveAppContainerSidFromAppContainerName(name, slot);
      return { hr: hr >>> 0, sid: slot[0] };
    },
    deleteAppContainerProfile(name) {
      return DeleteAppContainerProfile(name) >>> 0;
    },
    deriveCapabilitySidsFromName(name) {
      const groupSidsSlot = [null];
      const groupCountSlot = [0];
      const capabilitySidsSlot = [null];
      const capabilityCountSlot = [0];
      const ok = DeriveCapabilitySidsFromName(name, groupSidsSlot, groupCountSlot, capabilitySidsSlot, capabilityCountSlot);
      if (!win32BoolSucceeded2(ok)) return null;
      const groupSidCount = Number(groupCountSlot[0] ?? 0);
      const capabilitySidCount = Number(capabilityCountSlot[0] ?? 0);
      const groupSids = readSidPointerArray(groupSidsSlot[0], groupSidCount);
      const capabilitySids = readSidPointerArray(capabilitySidsSlot[0], capabilitySidCount);
      const first = capabilitySids[0] ?? null;
      for (let index = 1; index < capabilitySids.length; index += 1) freeNative(capabilitySids[index]);
      for (const sid of groupSids) freeNative(sid);
      freeNative(capabilitySidsSlot[0]);
      freeNative(groupSidsSlot[0]);
      return { capabilitySids: first === null ? [] : [first], capabilitySidCount, groupSids: groupSids[0] ?? null, groupSidCount };
    },
    // 阶段 B 实测缺陷：初版这里写的是裸标识符 `initializeProcThreadAttributeList`（小写 i），
    // 而真正的局部变量叫 `InitializeProcThreadAttributeList`（大写 I，对齐 Win32 名字）。
    // 于是**整个工厂函数**在返回对象字面量求值时就抛
    // `ReferenceError: initializeProcThreadAttributeList is not defined` ——
    // 也就是说 `createKoffiAppContainerBindings` 从来成功执行过一次都没有，
    // 这正是"T0 运行期零实测"的具体形态：不是"测了没过"，而是"入口本身就是死的"。
    // （`updateProcThreadAttribute` 那一行反而是对的，所以只看名字很难发现。）
    initializeProcThreadAttributeList: InitializeProcThreadAttributeList,
    updateProcThreadAttribute: UpdateProcThreadAttribute,
    deleteProcThreadAttributeList: DeleteProcThreadAttributeList,
    /**
     * 把 koffi 的 `_Out_ uint8 *` 形态适配回模块契约的"可写对象"形态。
     * 返回 `1`/`0`（与替身一致的整数），但模块侧**不**用 `=== 0` 判定 ——
     * 统一走 `win32BoolSucceeded()`，因为真实 koffi 对 `bool` 返回的是 JS boolean。
     */
    createProcessW(app, cmd, pa, ta, inherit, flags, env, cwd, si, out) {
      const pi = Buffer.alloc(PROCESS_INFORMATION_SIZE);
      const ok = CreateProcessWRaw(app, cmd, pa, ta, inherit, flags, env, cwd, si, pi);
      if (ok && out) {
        out.process = pi.readBigUInt64LE(OFF_PROCESS_INFORMATION.hProcess);
        out.thread = pi.readBigUInt64LE(OFF_PROCESS_INFORMATION.hThread);
        out.pid = pi.readUInt32LE(OFF_PROCESS_INFORMATION.dwProcessId);
      }
      return ok ? 1 : 0;
    },
    resumeThread: ResumeThread,
    terminateProcess: TerminateProcess,
    /**
     * 关闭句柄。阶段 B 补上：`spawnSuspendedAppContainer` 会把 `PROCESS_INFORMATION` 的
     * 两个句柄交还给调用方，而**原来的绑定表没有关闭它们的入口** —— 泄漏是必然的，
     * 而且"忘了关"在进程退出前不会报任何错（与 `ResumeThread` 同一类静默缺陷）。
     */
    closeHandle: (handle) => CloseHandleRaw(handle) === true,
    getLastError: GetLastError,
    /** 供 `readProcessTokenFacts()` 直查子进程令牌（阶段 FIX-B 新增） */
    openProcessToken: OpenProcessToken,
    getTokenInformation: GetTokenInformation,
    /**
     * `[官方]` `LocalFree`：释放 `DeriveCapabilitySidsFromName` 交还的能力 SID。
     * 阶段 FIX-B 补上 —— 正确的所有权模型是"调用方持有派生出的能力 SID，用完后释放"，
     * 而旧实现在绑定层内部就把它释放了（悬垂指针）。
     */
    localFree: (pointer) => {
      try {
        LocalFree(pointer);
        return true;
      } catch {
        return false;
      }
    },
    /** SID 指针 → `S-1-…` 字符串（失败返回 null，绝不返回半成品字符串） */
    sidToString: (sid) => {
      if (sid === null || sid === void 0) return null;
      const slot = [null];
      if (!win32BoolSucceeded2(ConvertSidToStringSidW(sid, slot))) return null;
      let text = null;
      try {
        text = koffi.decode(slot[0], "char16_t", -1);
      } catch {
        text = null;
      }
      freeNative(slot[0]);
      return typeof text === "string" ? text.replace(/\u0000+$/, "") : null;
    },
    // `[实测]` koffi 3.3.2 的导出里含 `address`，且 `koffi.address(buffer)` 返回 bigint
    // （见 .t/sbx3/dev/raw-probe-koffi.txt）。显式包一层：koffi 若换掉这个 API，这里会**在构造期**
    // 就变成 undefined，而不是等到启动 AppContainer 时抛一个"指针类型不对"的间接错误。
    pin: typeof koffi.address === "function" ? (buffer) => koffi.address(buffer) : void 0,
    // 供上层核对；advapi32 目前未被使用（保留以便将来需要 ConvertSidToStringSidW）
    __libs: { userenv, kernel32, advapi32, kernelBase }
  };
}
var __internal2 = { writePointerLe, hrStatus, extractSid };

export {
  __export,
  parseSddlDaclAces,
  findStaleAppContainerAces,
  listAppContainerSids,
  buildMitigationPolicy,
  summariseMitigations,
  SE_GROUP_ENABLED,
  SID_AND_ATTRIBUTES_SIZE,
  OFF_SID_AND_ATTRIBUTES,
  PROCESS_INFORMATION_SIZE,
  OFF_PROCESS_INFORMATION,
  CREATE_SUSPENDED,
  DETACHED_PROCESS,
  CREATE_NEW_CONSOLE,
  STATUS_DLL_INIT_FAILED,
  TOKEN_QUERY_ACCESS,
  TOKEN_DUPLICATE_ACCESS,
  ERROR_INSUFFICIENT_BUFFER,
  ERROR_ALREADY_EXISTS,
  HR_ALREADY_EXISTS,
  DEFAULT_CAPABILITIES,
  NETWORK_CAPABILITY,
  win32BoolSucceeded2 as win32BoolSucceeded,
  buildSidAndAttributesArray,
  OFF_STARTUP_INFO_FLAGS,
  OFF_STD_INPUT,
  OFF_STD_OUTPUT,
  OFF_STD_ERROR,
  STARTF_USESTDHANDLES,
  buildStartupInfoExBuffer,
  allocateAttributeList,
  attributeListCountFor,
  spawnSuspendedAppContainer,
  resumeSuspendedProcess,
  TOKEN_INFORMATION_CLASS,
  SID_LOW_INTEGRITY,
  SID_AND_ATTRIBUTES_OFFSET,
  TOKEN_GROUPS_HEADER_SIZE,
  readProcessTokenFacts,
  assessAppContainerIsolation,
  planCombinationOrder,
  AppContainerRuntime,
  createKoffiAppContainerBindings,
  __internal2 as __internal
};
