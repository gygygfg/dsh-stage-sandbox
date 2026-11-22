// @ts-nocheck —— 与 host-plugin.ts 同一过渡策略。
/**
 * B1：profile 覆盖层的 BOM / CRLF 保真。
 *
 * DSH 0.2.2-rc.5 的 `dsh-config-editor` 用 `parseDocument` + `String(document)` 写回：
 *   · CRLF 会被规范成 LF；
 *   · BOM 会让 `parseDocument` 直接报 8 个错误（“Unexpected scalar at node end”），
 *     编辑根本无法开始。
 *
 * 本模块在**插件侧**做两件事，不改 app.asar：
 *   1. `stripBomForEditor()`：编辑前若文件有 BOM，先写一份无 BOM 的临时内容，让
 *      configEditor 能解析；失败时由调用方恢复原字节。
 *   2. `restoreProfileFormatting()`：编辑成功后按原文件恢复 BOM 与 CRLF。
 *
 * 只做格式，不改键值/注释；内容相同则返回原 Buffer，避免无谓写盘。
 *
 * @module winstage-sandbox/profile-format
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export function hasBom(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
}

export function stripBomBytes(buffer) {
  if (!Buffer.isBuffer(buffer)) return Buffer.alloc(0)
  return hasBom(buffer) ? buffer.subarray(3) : buffer
}

/** 编辑前的文本：只去 BOM，CRLF 保留（parseDocument 接受 CRLF）。 */
export function editorInputBuffer(buffer) {
  return stripBomBytes(buffer)
}

/**
 * 按 before 的 BOM/CRLF 风格恢复 after；无变化时返回 after 本身（引用相同）。
 * @param {Buffer} before 原始文件
 * @param {Buffer} after configEditor 写完的文件
 * @returns {Buffer}
 */
export function restoreProfileFormatting(before, after) {
  if (!Buffer.isBuffer(before) || !Buffer.isBuffer(after)) return after
  const bom = hasBom(before)
  const crlf = before.includes(Buffer.from('\r\n'))
  if (!bom && !crlf) return after
  let text = after.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (crlf) text = `${text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')}`
  if (bom) text = `\ufeff${text}`
  const restored = Buffer.from(text, 'utf8')
  return restored.equals(after) ? after : restored
}

/** 同目录临时文件 + rename，尽量保持原子性（Windows 上 rename 覆盖同卷文件）。 */
export function writeBytesAtomic(path, bytes) {
  const temp = `${path}.winstage-format.tmp`
  writeFileSync(temp, bytes)
  try {
    renameSync(temp, path)
  } catch (error) {
    try { writeFileSync(path, bytes) } catch { /* 调用方决定是否 fail-closed */ }
    try { writeFileSync(temp, '') } catch { /* best effort */ }
    throw error
  }
}

/**
 * 给 `ctx.configEditor.edit` 加格式保真壳。
 * @param {object} ctx Cordis context
 * @param {(message:string)=>void} [log]
 * @returns {() => void} disposer（恢复原 edit）
 */
export function installProfileFormattingGuard(ctx, log = () => {}) {
  const editor = typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined
  if (!editor || typeof editor.edit !== 'function') return () => {}
  const original = editor.edit
  const callOriginal = original.bind(editor)
  const guard = async (entry, change) => {
    let path
    try {
      path = typeof editor.documentPath === 'string' ? editor.documentPath : undefined
    } catch {
      path = undefined
    }
    let before = null
    if (path) {
      try { before = readFileSync(path) } catch { before = null }
    }
    let normalized = false
    if (before && hasBom(before)) {
      try {
        writeBytesAtomic(path, stripBomBytes(before))
        normalized = true
      } catch (error) {
        log(`[winstage] profile BOM strip failed: ${String(error?.message ?? error)}`)
      }
    }
    try {
      const result = await callOriginal(entry, change)
      if (before && path) {
        try {
          const after = readFileSync(path)
          const restored = restoreProfileFormatting(before, after)
          if (restored !== after && !restored.equals(after)) writeBytesAtomic(path, restored)
        } catch (error) {
          log(`[winstage] profile format restore failed: ${String(error?.message ?? error)}`)
        }
      }
      return result
    } catch (error) {
      if (normalized && before && path) {
        try { writeBytesAtomic(path, before) } catch (restoreError) {
          log(`[winstage] profile rollback after edit failure failed: ${String(restoreError?.message ?? restoreError)}`)
        }
      }
      throw error
    }
  }
  editor.edit = guard
  return () => {
    if (editor.edit === guard) editor.edit = original
  }
}
