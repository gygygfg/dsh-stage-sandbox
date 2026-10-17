// @ts-nocheck —— 全量 TS 化过渡脚手架：本文件由 .mjs 机械转换而来，类型待逐步补齐。
/**
 * R12 修复 · D2：**产出侧敏感内容掩码**（review payload 的值级遮蔽）
 *
 * ── 这是什么，为什么单独一个模块 ────────────────────────────────────────────────
 * R11 D2 实测：`stage-root/review.json`（142735 B）里内嵌了
 * `~/.dsh/.credentials.yaml` 的 **53 字节连续明文片段**（最长实测 57 B）。
 * 那是**产出侧泄漏**：`review.json` 是评审/审计载荷，可能被展示、被上传、
 * 被 Client 用 `ctx.remote.workspaceFiles.read` 整份读进浏览器。
 *
 * 根因**不是**"没写掩码"，而是"掩码的门太窄"：
 * `review-service.renderChange()` 只对 `safety === 'danger'` 的条目清空 `diff`，
 * 而 `.dsh/.credentials.yaml` 命中的是 `MASK_CLASSES` 里**更早**的宽规则
 * `dsh-home`（`\\\.dsh(\\|$)`，排在更窄的 `dsh-credentials` 之前 ⇒
 * `maskReason()` 返回第一个命中项），而 `dsh-home` **不在**
 * `DANGER_MASK_IDS` 里 ⇒ `safety === 'risk'` ⇒ 整份明文照写进 `diff`。
 *
 * ── 本模块的契约（Lead 口径）──────────────────────────────────────────────────
 *   1. **保留结构**：键名 / 缩进 / 分隔符 / 行数与原文一致；
 *   2. **保留长度与前缀**：`len=` 记的是**被遮蔽那一段的真实 UTF-16 长度**
 *      （与 `String.length` 同一口径，因此面板能说"这里少了 N 个字符"）；
 *   3. **哈希语义不变**：本模块**只影响展示文本**，绝不参与
 *      `before/after` 哈希计算 —— 哈希永远按真实字节算
 *      （`src/workspace.ts` 的 `entry.stagedHash` / `hashFile()`，本模块不接触）。
 *      因此"掩码后仍能比对"这件事是结构性成立的，不需要额外的例外规则；
 *   4. **绝不静默**：调用方必须能把"哪些字段被掩码了"写进 `review.json`
 *      （见 `review-service.ts` 的 `snapshot().redactions`），本模块只负责
 *      返回 `masked / segments / reason` 三个事实。
 *
 * ── 为什么是"值级"而不是"整行打码"────────────────────────────────────────────
 * 整行清空（danger 档的现有做法）在**可读性**上是有代价的：用户看不到
 * "改的是哪个键"。值级掩码让面板仍然能说"`DEEPSEEK_API_KEY:` 这一行的值变了、
 * 长度从 35 变成 43"，而秘密本身一个字节都不进 payload。
 *
 * 纯函数、零 IO、零依赖 ⇒ 可离线断言（见 `tests/integration-wiring.ts` 与
 * `.t\r12\plugin\scans/**` 的扫描器）。
 */

/** 被遮蔽段的统一占位形态（**不含任何原文字节**，只带长度） */
export const REDACTED_PREFIX = '<REDACTED'
export const REDACTED_SUFFIX = '>'

/** 掩码理由（机读码，进 `review.json.redactions.fields[].reason`） */
export const MASK_REASON = Object.freeze({
  /** 结构化行：`key: value` / `key=value` / `"key": "value"` —— 只遮值 */
  STRUCTURED_VALUE: 'structured-value',
  /** 裸 token：没有分隔符、但形状像密钥/令牌（长度 + 字符集 + 字符类多样性） */
  BARE_TOKEN: 'bare-token',
  /** 二进制/控制字符占比过高（evtx / 私钥派生体 / UTF-16 转储）—— 整行遮蔽 */
  BINARY_LINE: 'binary-line',
  /** 已知密钥形态（`sk-…` / `Bearer …`）—— 保留标记、遮蔽随机段 */
  KNOWN_SECRET: 'known-secret',
  /** 键名本身是凭据名（`token`/`password`/`secret`/`apiKey`…）⇒ 值无条件遮蔽 */
  CREDENTIAL_KEY: 'credential-key',
})

/** `len=` 只报长度，不报内容 */
export function redactedToken(length) {
  const n = Number.isFinite(length) && length > 0 ? Math.trunc(length) : 0
  return `${REDACTED_PREFIX} len=${n}${REDACTED_SUFFIX}`
}

/**
 * 结构化行的分隔符（**值从分隔符之后开始**）。
 *
 * 四种形态，按"键的引号/括号风格"区分；`m[0]` 是分隔符本身：
 *   1. `"key":`  → 键是 JSON 字符串（闭合引号必须先吃掉，否则它会被当成值的一部分）
 *   2. `key:`    → YAML / 对象字面量
 *   3. `key=`    → .env / .ini / properties
 *   4. `key =`   → 允许等号两侧空白
 */
const DELIMITER_RE = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|"[^"]*|[A-Za-z_][\w.\-[\]]*)\s*(?::|=)/

/**
 * 裸 token 的候选形状：连续 16+ 个"像 base64/hex/JWT 片段"的字符。
 *
 * 为什么不是更宽：宽到 `[\w.]+` 会把每一行正常文字都吃掉，掩码退化成"整行清空"，
 * 那份 payload 对审计就没用了（本模块的第 1 条契约是保留结构）。
 * 误报的代价是"多遮一段无秘密的 token"，漏报的代价是"明文泄漏" ⇒ 取保守侧。
 */
const BARE_TOKEN_RE = /[A-Za-z0-9+/_][A-Za-z0-9+/=_.-]{15,}/g

/** `scheme://…` / `file:` / `wss:` 之类的 URI 形态（用于 `isLocationLike`） */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/|\\\\)?[^\s]*$/

/** 已知秘密形态：`sk-…`（OpenAI/DeepSeek 风格密钥前缀）与 `Bearer <token>`。 */
const KNOWN_SECRET_RE = /\b(?:sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9+/=_.-]{16,})/g

/**
 * **凭据键名**（分隔符之前那段，小写比较）。
 *
 * 为什么需要它（交叉验证实测出的漏报）：`valueNeedsMask()` 只能看**值的形状**，
 * 于是 `token: abcdefghijklmnopqrst`（20 个纯小写字母）在形状上和一个 slug 无从区分，
 * 整串明文留在 `review.json` 里。但**键名**已经说死了这一行是什么 —— 键名是凭据时
 * 值就必须是秘密，不需要再赌形状。这与本模块"未知形状按秘密处理"是同一条 fail-closed
 * 纪律，只是把判据从"值像不像"换成"这一行本来就写着它是凭据"。
 */
const CREDENTIAL_KEY_RE =
  /(?:^|[^a-z0-9])(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer|token|secret|password|passwd|pwd|credential|credentials|private[_-]?key|client[_-]?secret|session[_-]?key|encryption[_-]?key|signing[_-]?key)(?![a-z0-9])/i

/** 键名形态判定（对**已去掉分隔符**的那一段求值）。 */
export function isCredentialKey(key) {
  return CREDENTIAL_KEY_RE.test(String(key ?? '').toLowerCase())
}

/**
 * 为**已知形态**生成"保留标记、遮蔽随机段"的占位文本。
 *
 * `sk-R12PROBE0123456789abcdefghijklmnop` → `sk-<REDACTED len=31>`
 *   · 保留 `sk-` 的作用是让面板仍然能说"这是一个 API 密钥"，而不是一团空白；
 *   · `len=` 报的是**被遮掉的随机段**长度（31），不是整串长度。
 * `Bearer <token>` 同理（保留 `Bearer `）。
 */
function maskKnownSecret(match) {
  if (match.startsWith('Bearer')) {
    const rest = match.slice('Bearer'.length)
    const lead = rest.match(/^\s*/)[0]
    const token = rest.slice(lead.length)
    return `Bearer${lead}${redactedToken(token.length)}`
  }
  const dash = match.indexOf('-')
  return `${match.slice(0, dash + 1)}${redactedToken(match.length - dash - 1)}`
}

/**
 * 一个裸 token 是否**形状上**值得遮蔽。
 *
 * 两条独立的命中条件（任一成立即遮）：
 *   1. **字符类多样性**：小写/大写/数字/符号 四类里占 ≥3 类
 *      （`sk-R12PROBE0123456789abcdefghijklmnop` = 4 类）；
 *      纯小写单词（`content-location`）只有 2 类 ⇒ 不遮，保住可读性；
 *   2. **存在 ≥16 个连续相同字符**（`XXXX…X` 这类"同形替换/填充"块）——
 *      R12 实测：R11 泄漏样本里正是这样一行 57 字节的重复块，
 *      只按第 1 条判会**整段放行**（`residualLongestRun=58`）。
 */
export function looksSecretLike(token) {
  const text = String(token ?? '')
  if (text.length < 16) return false
  if (hasLongRepeat(text)) return true
  if (!/[A-Za-z]/.test(text)) return false
  const classes =
    (/[a-z]/.test(text) ? 1 : 0) +
    (/[A-Z]/.test(text) ? 1 : 0) +
    (/[0-9]/.test(text) ? 1 : 0) +
    (/[+/=_.-]/.test(text) ? 1 : 0)
  return classes >= 3
}

/**
 * `value` 是否"不能原样进 payload"——即 `key: value` 里的 `value` 是否必须被遮蔽。
 *
 * ── 为什么判据收敛到"短标量例外"这一条（R12 实测教训）────────────────────────
 * 最初的写法是"**只要**有分隔符就遮值"。R11 泄漏样本里有一行
 * ` XXXXXXXX…X`（57 字符、纯 ASCII，前缀是一个空格）—— 它被那个规则当成
 * `key: value` 的结构行，于是 **57 字节明文原样留在 payload 里**
 * （实测 `masker-check` 的 `residualLongestRun=58`）。
 *
 * 真正的判据不是"有没有分隔符"，而是**值本身像不像可读标量**：
 *   · `1` / `true` / `grant` / `C:\path\x.txt` / `normal-file-ok` → 短、可读 ⇒ 不遮；
 *   · 长且字符高度集中的（base64 块、hex、`XXXX…X` 这类同形替换的假秘密）⇒ 遮。
 * 因此这里用"短标量白名单"而不是"长秘密黑名单"：**未知形状按秘密处理**（fail-closed）。
 *
 * @param {string} value 分隔符之后的原始值（**未裁剪**）
 */
export function valueNeedsMask(value) {
  const text = String(value ?? '')
  if (text.length === 0) return false
  if (looksBinaryLine(text)) return true
  if (hasLongRepeat(text)) return true
  // ── 短标量白名单（唯一允许原样进 payload 的一类）──────────────────────────────
  //   · ≤24 字符：`1` / `true` / `grant` / `normal-file-ok` / `local` / `wss` …
  //     （实测样本里 DSH 凭据的 `secret` 值是 17–44 字符的混合大小写串，
  //      长度本身不足以判定 ⇒ 靠下面的"形态"规则，不靠长度）
  //   · 有空格、且"不同字符/长度"足够高（≥0.55）⇒ 读起来像句子，不是秘密
  //   · **路径 / URI / 邮箱形态** ⇒ 是位置而不是秘密（`path: C:\…\x.txt`）
  //   · 其余（无空格的长串、低多样性的长串）= 未知形状 ⇒ **按秘密处理**（fail-closed）
  //
  // ★ 缺陷（交叉验证实测）：旧写法是裸的 `if (text.length <= 24) return false`
  //   ⇒ **任何 ≤24 字符的高熵值都原样进 payload**。实测漏报：
  //     `password: Abc123Xyz789Qwer2`（20 字符、大小写 + 数字）整串明文留在 review.json。
  //   而 DSH 凭据里 `secret` 值的长度区间恰好是 17–44 字符 —— 短的那半段**整段漏**。
  //   因此白名单只在"这段值本身不像秘密"时才生效（形状判定不受 24 字符门槛约束）。
  if (text.length <= 24 && !looksSecretLike(text)) return false
  if (isLocationLike(text)) {
    // 位置形态豁免**只给真·路径 / URI / 邮箱**：它们不是秘密
    // （路径本来就在 `item.path` 里逐字给出，遮掉会退化成"看不见改的是哪个文件"）。
    if (isPathForm(text)) return false
    if (SCHEME_RE.test(text)) return false
    if (/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(text)) return false
    if (/^[A-Za-z0-9._-]+:\d{1,5}$/.test(text)) return false
    // 剩下的是"含分隔符但不成路径形态"这一档。旧判据把它一律当路径放行，
    // 于是 `1//0eXaMpLe-Of-A-VerY-Long-Token`（OAuth 刷新令牌）整串明文进 payload ——
    // 它含 `/` 与 `-` 看着像路径，实际是秘密 ⇒ 再过一次形状判定。
    return looksSecretLike(text)
  }
  if (/\s/.test(text) && text.length <= 96) {
    const distinct = new Set(text.replace(/\s+/g, '')).size
    if (distinct / text.length >= 0.55) return false
  }
  return true
}

/**
 * `value` 是否"是一个位置"而不是"一个秘密"：
 *   · Windows 绝对路径 / UNC / 含分隔符的相对路径；
 *   · URI（`scheme://…`、`file:`、`wss:`…）；
 *   · 邮箱；`localhost:port`。
 *
 * 为什么需要它：R12 实测 `path: C:\Users\Administrator\Desktop\…\.t\r12\x.txt`
 * （69 字符、一个空格、distinct/len ≈ 0.44）会被上面的"像句子"判据判成秘密，
 * 于是每一条路径都被掩码 —— 掩码退化成"看不见改的是哪个文件"，
 * 而**路径不是秘密**（它本来就在 `item.path` 里逐字给出）。
 *
 * 注意：这里**不**对含 `sk-` 的值豁免 —— 那是最需要遮的形态，
 * 即使它长得像 URI 也必须遮（见 `valueNeedsMask` 的调用点注释）。
 */
export function isLocationLike(value) {
  const text = String(value ?? '')
  if (text.length === 0) return false
  if (SCHEME_RE.test(text)) return true
  if (/^[A-Za-z]:[\\/]/.test(text)) return true
  if (/^\\\\[^\\]/.test(text)) return true // UNC
  if (/^(\.{1,2}[\\/]|[\\/])/.test(text)) return true
  // 含分隔符的形态：只在**没有空格**或**有盘符**时才当路径
  // （带空格的自由文本里出现一个 `/` 不该被判成路径）
  if (/\\|\//.test(text) && !text.includes('=') && (!/\s/.test(text) || /^[A-Za-z]:/.test(text))) return true
  if (/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(text)) return true
  if (/^[A-Za-z0-9._-]+:\d{1,5}$/.test(text)) return true
  return false
}

/**
 * 是否**真·路径形态**（盘符 / UNC / 前导分隔符 / `./` / `scheme:` 开头）。
 *
 * 为什么与 `isLocationLike()` 分开：`isLocationLike()` 里有一条很宽的
 * "含 `\` 或 `/` 就算路径"分支，它把 `1//0eXaMpLe-Of-A-VerY-Long-Token` 这类
 * **长得像路径的令牌**也豁免掉了。本函数只认"从第一个字符就能看出是路径"的形态，
 * 因此 `1//0…`（数字开头、无盘符、无前导分隔符）**不**算路径。
 */
export function isPathForm(value) {
  const text = String(value ?? '')
  if (text.length === 0) return false
  if (/^[A-Za-z]:[\\/]/.test(text)) return true // C:\… / C:/…
  if (/^\\\\/.test(text)) return true // UNC \\server\share
  if (/^[\\/]/.test(text)) return true // \foo / /foo
  if (/^\.{1,2}[\\/]/.test(text)) return true // ./ ../ .\
  if (/^[A-Za-z][A-Za-z0-9+.-]*:[\\/]/.test(text)) return true // scheme:/…
  return false
}

/** 是否存在 >=16 个连续相同字符（同形替换/填充块的特征；不遮它就会成段泄漏） */
export function hasLongRepeat(text) {
  const value = String(text ?? '')
  let run = 1
  for (let i = 1; i < value.length; i += 1) {
    if (value[i] === value[i - 1]) {
      run += 1
      if (run >= 16) return true
    } else run = 1
  }
  return false
}

/** 控制字符 / 非 ASCII 占比是否已经不像"可读文本"（二进制、编码转储、UTF-16） */
export function looksBinaryLine(text) {
  const value = String(text ?? '')
  if (value.length === 0) return false
  let controls = 0
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue
    if (code < 0x20 || code === 0x7f || code > 0x7e) controls += 1
  }
  return controls >= 4 && controls / value.length >= 0.02
}

/**
 * **单行**值级掩码。
 *
 * @param {string} line 原始展示行（来自候选 blob，**可能含秘密**）
 * @returns {{text:string, masked:boolean, segments:number, reasons:string[]}}
 *   `text` 是**可写进 review.json** 的文本；`segments` 是被遮蔽的段数。
 */
export function maskSensitiveLine(line) {
  const original = typeof line === 'string' ? line : String(line ?? '')
  if (original.length === 0) return { text: original, masked: false, segments: 0, reasons: [] }

  // 行尾 CR 属于行分隔符（blob 按 \n 切分），不参与"像不像秘密"的判定
  const trailing = original.endsWith('\r') ? '\r' : ''
  const body = trailing ? original.slice(0, -1) : original

  if (looksBinaryLine(body)) {
    // 整行遮蔽：长度必须照实报（面板要能说"这里少了 N 个字符"）
    return {
      text: `${redactedToken(body.length)}${trailing}`,
      masked: true,
      segments: 1,
      reasons: [MASK_REASON.BINARY_LINE],
    }
  }

  const reasons = []
  let segments = 0

  /**
   * ★ **已知形态优先**（顺序不可颠倒）。
   *
   * 先把 `sk-…` / `Bearer …` 这类**确定是密钥**的片段换成占位（保留 `sk-` 标记），
   * 再用"值级启发式"处理剩下的未遮区域。颠倒顺序的后果实测过：
   * `secret: sk-abcdefghijklmnop` 里的值只有 20 字符、多样性低，
   * 启发式判成"可读标量"⇒ **整串明文留在 payload 里**。
   */
  let text = body
  KNOWN_SECRET_RE.lastIndex = 0
  text = text.replace(KNOWN_SECRET_RE, (match) => {
    segments += 1
    if (!reasons.includes(MASK_REASON.KNOWN_SECRET)) reasons.push(MASK_REASON.KNOWN_SECRET)
    return maskKnownSecret(match)
  })

  if (segments === 0) {
    // 没有已知形态 ⇒ 走结构 / 裸 token 两条启发式
    const delim = DELIMITER_RE.exec(body)
    if (delim) {
      // `valueStart` = 分隔符 + 其后的空白：空白留在外面，让 `key: <REDACTED>` 读起来正常
      let at = delim[0].length
      while (at < body.length && (body[at] === ' ' || body[at] === '\t')) at += 1
      const value = body.slice(at)
      // ★ 键名已经是凭据名时**不再赌值的形状**：`token: abcdefghijklmnopqrst`
      //   在形状上和 slug 无从区分（20 个纯小写字母），但键名说死了它就是凭据。
      const keyIsCredential = isCredentialKey(body.slice(0, delim[0].length))
      if (value.length > 0 && (keyIsCredential || valueNeedsMask(value))) {
        text = `${body.slice(0, at)}${redactedToken(value.length)}`
        segments += 1
        reasons.push(keyIsCredential ? MASK_REASON.CREDENTIAL_KEY : MASK_REASON.STRUCTURED_VALUE)
      }
    } else {
      // 没有分隔符：逐个裸 token 判定（列表项、私钥主体、JWT 等）
      const parts = []
      let cursor = 0
      BARE_TOKEN_RE.lastIndex = 0
      let match
      while ((match = BARE_TOKEN_RE.exec(body)) !== null) {
        const token = match[0]
        if (!looksSecretLike(token)) continue
        parts.push(body.slice(cursor, match.index))
        parts.push(redactedToken(token.length))
        cursor = match.index + token.length
        segments += 1
        if (!reasons.includes(MASK_REASON.BARE_TOKEN)) reasons.push(MASK_REASON.BARE_TOKEN)
      }
      parts.push(body.slice(cursor))
      if (segments > 0) text = parts.join('')
    }
  }

  if (segments === 0) return { text: original, masked: false, segments: 0, reasons: [] }
  return { text: `${text}${trailing}`, masked: true, segments, reasons }
}

/**
 * 多行掩码（`renderChange` 的入口）。
 *
 * @param {Array<{type:string,line?:number,text?:string}>} lines
 * @returns {{lines:Array<object>, masked:boolean, segments:number, reasons:string[]}}
 */
export function maskSensitiveLines(lines) {
  const out = []
  let segments = 0
  const reasons = new Set()
  for (const item of Array.isArray(lines) ? lines : []) {
    if (!item || typeof item !== 'object') {
      out.push(item)
      continue
    }
    const result = maskSensitiveLine(item.text ?? '')
    segments += result.segments
    for (const reason of result.reasons) reasons.add(reason)
    out.push(result.masked ? { ...item, text: result.text, redacted: true } : item)
  }
  return { lines: out, masked: segments > 0, segments, reasons: [...reasons] }
}
