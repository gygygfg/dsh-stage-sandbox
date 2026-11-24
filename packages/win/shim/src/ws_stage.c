/* WinStageSandbox -- T4 shim: built-in staging provider.
 *
 * File layer layout under the staging root:
 *   <root>\fs\C\Windows\Temp\probe.txt   staged file content (drive colon dropped)
 *   <root>\fs\_unc\server\share\file     staged UNC content
 *   <root>\wo\C\Windows\Temp\probe.txt   whiteout marker (empty file)
 *
 * The registry layer is NOT implemented here: it lives in ws_regstore.c and is
 * backed by T3's app hive + WAL (docs/T3-?.md). There is exactly one
 * registry storage -- no parallel per-key files.
 *
 * Directory enumeration is not merged with the real directory (documented
 * limitation of path-substitution shims).
 *
 * Every Win32 call in this file comes from the shim DLL, whose own import table
 * is never patched (see ws_util.c), so there is no re-entrancy.
 */
#include "winstage_internal.h"

#include <stdio.h>
#include <stdlib.h>

/* R23：provider 侧 >MAX_PATH 支持（定义在 ws_util.c）。暂存树路径
 * （root + 长相对路径）会超过 MAX_PATH；真实 API 边界需要扩展前缀。 */
extern const wchar_t *ws_path_api_w(const wchar_t *in, wchar_t *buf, DWORD cch);

/* --------------------------------------------------------------- helpers */

static int ws_stage_root_path(wchar_t *out, DWORD cch)
{
    if (!g_ws.haveStageRoot || !g_ws.stageRoot[0]) {
        return 0;
    }
    ws_strlcpy_w(out, g_ws.stageRoot, cch);
    return 1;
}

/* Map a normalized absolute path to "<root>\<leafRoot>\<...>". */
static int ws_fs_map(const wchar_t *norm, const wchar_t *leafRoot, wchar_t *out, DWORD cch)
{
    WS_PATH_BUF(root);
    if (!ws_stage_root_path(root, WS_PATH_MAX)) {
        return 0;
    }
    size_t pos = 0;
    out[0] = 0;
    if (!ws_append_w(out, cch, &pos, root) ||
        !ws_append_w(out, cch, &pos, L"\\") ||
        !ws_append_w(out, cch, &pos, leafRoot)) {
        return 0;
    }
    if (norm[0] == L'\\' && norm[1] == L'\\') {
        /* UNC: \\server\share\x -> \_unc\server\share\x */
        if (!ws_append_w(out, cch, &pos, L"\\_unc")) {
            return 0;
        }
        if (!ws_append_w(out, cch, &pos, L"\\") || !ws_append_w(out, cch, &pos, norm + 2)) {
            return 0;
        }
        return 1;
    }
    /* "C:\a\b" -> "\C\a\b" (drive colon dropped, rest kept verbatim) */
    if (!ws_append_w(out, cch, &pos, L"\\")) {
        return 0;
    }
    for (const wchar_t *p = norm; *p; p++) {
        if (*p == L':') {
            continue;
        }
        if (pos + 1 >= cch) {
            return 0;
        }
        out[pos++] = *p;
        out[pos] = 0;
    }
    return 1;
}

static int ws_fs_path(const wchar_t *real, wchar_t *out, DWORD cch)
{
    WS_PATH_BUF(norm);
    if (!ws_normalize_path(real, norm, WS_PATH_MAX)) {
        return 0;
    }
    return ws_fs_map(norm, L"fs", out, cch);
}

static int ws_wo_path(const wchar_t *real, wchar_t *out, DWORD cch)
{
    WS_PATH_BUF(norm);
    if (!ws_normalize_path(real, norm, WS_PATH_MAX)) {
        return 0;
    }
    return ws_fs_map(norm, L"wo", out, cch);
}

/* ★ WP13：`GetFileAttributesW` 在"缺件"时把 `ERROR_FILE_NOT_FOUND(2)` /
 * `ERROR_PATH_NOT_FOUND(3)` 写进**调用线程**。这两个探测函数在**每一次** overlay
 * 解析里都跑（一次失败的 read 就是一次 miss），所以"overlay miss → last error 留 2"
 * 是被注入载体在 CLR 初始化期最常见的 last-error 污染源（实测形态见 WP13 交付件 §0）。
 * 探测结果是由**返回值**表达的，不是由 last error 表达的 ⇒ 入口保存、出口还原，
 * 让本函数对调用方在线程状态上完全透明。 */
static int ws_exists(const wchar_t *path)
{
    DWORD ws_saved_last_error = GetLastError();
    WS_PATH_BUF(apiBuf);
    const wchar_t *api = ws_path_api_w(path, apiBuf, WS_PATH_MAX);
    DWORD a = GetFileAttributesW(api);
    SetLastError(ws_saved_last_error);
    return a != INVALID_FILE_ATTRIBUTES;
}

/* Is there a whiteout MARKER at this path?
 *
 * A marker is always a regular FILE (dp_file_whiteout creates one with
 * CreateFileW). A DIRECTORY at the same place is only the parent chain of a
 * deeper marker: ws_fs_map drops the drive colon, so <root>\wo\C is the parent
 * of every marker for a path on C:, and GetFileAttributesW succeeds for it.
 * Counting that directory as a marker whiteouted C:\ itself -- and, one level
 * down, C:\Users, C:\Users\<user>, ... for every whiteout anywhere below them.
 * Latent while existence checks went to the real disk; once the overlay-aware
 * GetFileAttributes* hooks (ws_file.c) shipped, PowerShell's startup saw C:\ as
 * deleted, decided the session was locked down and refused to load its .psm1
 * modules (Write-Output / Out-File / Test-Path all became "not recognized"). */
/* ── 2026-11-24 审计实测：暂存树里的重解析点 = 真实盘逃逸 ─────────────────────
 *
 * 复现（真实模型审计，`audit6.json` 第 32-38 步）：
 *     mklink /J C:\audit-junc C:\Windows\System32
 *     echo junc > C:\audit-junc\audit-2f-junc.txt
 *     read_file C:\Windows\System32\audit-2f-junc.txt   ->  "junc"   ← 真的写进 System32
 *
 * 机理：`mklink` 的目录创建被垫片映射成 `<stage>\fs\C\audit-junc`，随后
 * `DeviceIoControl(FSCTL_SET_REPARSE_POINT)` 在那个**暂存目录**上建了一个指向真实
 * `C:\Windows\System32` 的联接点。之后所有形如 `C:\audit-junc\x` 的路径都被映射成
 * `<stage>\fs\C\audit-junc\x`，而**文件系统**会穿过那个联接点 —— 落在真实盘上。
 * 读也会穿：读 `C:\audit-junc\SAM` 会真的读到 SAM，绕过读遮蔽。
 *
 * 不变式：暂存树里不允许出现任何重解析点。这里在**解析期**判定，只检查**已存在**
 * 的路径段（尚不存在的段由 ws_ensure_dirs 以普通目录创建，本身安全）。命中即
 * fail-closed（返回 1 → provider 返回 -1 → 钩子返回 ERROR_ACCESS_DENIED）。 */
static int ws_stage_tree_has_reparse(const wchar_t *staged)
{
    if (!g_ws.haveStageRoot || !g_ws.stageRoot[0] || !staged || !staged[0]) {
        return 0;
    }
    size_t rootLen = wcslen(g_ws.stageRoot);
    if (wcslen(staged) <= rootLen || _wcsnicmp(staged, g_ws.stageRoot, rootLen) != 0) {
        return 0;
    }
    DWORD ws_saved_last_error = GetLastError();
    WS_PATH_BUF(cur);
    ws_strlcpy_w(cur, g_ws.stageRoot, WS_PATH_MAX);
    const wchar_t *p = staged + rootLen;
    while (*p == L'\\') {
        p++;
    }
    int hit = 0;
    while (*p) {
        const wchar_t *segEnd = p;
        while (*segEnd && *segEnd != L'\\') {
            segEnd++;
        }
        size_t curLen = wcslen(cur);
        size_t segLen = (size_t)(segEnd - p);
        if (curLen + 1 + segLen + 1 >= (size_t)WS_PATH_MAX) {
            break;
        }
        cur[curLen] = L'\\';
        memcpy(cur + curLen + 1, p, segLen * sizeof(wchar_t));
        cur[curLen + 1 + segLen] = 0;
        WS_PATH_BUF(apiBuf);
        const wchar_t *api = ws_path_api_w(cur, apiBuf, WS_PATH_MAX);
        DWORD attrs = GetFileAttributesW(api);
        if (attrs == INVALID_FILE_ATTRIBUTES) {
            break; /* not created yet: ws_ensure_dirs will make a plain directory */
        }
        if (attrs & FILE_ATTRIBUTE_REPARSE_POINT) {
            ws_log_w(L"staged path crosses a reparse point (refusing)", cur);
            hit = 1;
            break;
        }
        p = segEnd;
        while (*p == L'\\') {
            p++;
        }
    }
    SetLastError(ws_saved_last_error);
    return hit;
}

static int ws_marker_exists(const wchar_t *path)
{
    /* 同 `ws_exists()`：探测结果由返回值表达，不能让 GetFileAttributesW 的
     * "缺件"错误留在调用线程上（whiteout 判定每次打开都会问一次）。 */
    DWORD ws_saved_last_error = GetLastError();
    WS_PATH_BUF(apiBuf);
    const wchar_t *api = ws_path_api_w(path, apiBuf, WS_PATH_MAX);
    DWORD a = GetFileAttributesW(api);
    SetLastError(ws_saved_last_error);
    return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

/* ------------------------------------------------------------ file provider */

static int dp_file_resolve(const wchar_t *real_path, uint32_t intent, wchar_t *out_path,
                           uint32_t out_cch, uint32_t *out_flags)
{
    if (!real_path || !out_path || !out_flags || !g_ws.haveStageRoot) {
        return -1;
    }
    WS_PATH_BUF(staged);
    if (!ws_fs_path(real_path, staged, WS_PATH_MAX)) {
        return -1;
    }
    *out_flags = 0;
    out_path[0] = 0;

    if (intent == WINSTAGE_IO_READ) {
        WS_PATH_BUF(wo);
        if (ws_wo_path(real_path, wo, WS_PATH_MAX) && ws_marker_exists(wo)) {
            *out_flags = WINSTAGE_RES_WHITEOUT;
            return 0;
        }
        if (ws_exists(staged)) {
            if (ws_stage_tree_has_reparse(staged)) {
                return -1;
            }
            ws_strlcpy_w(out_path, staged, out_cch);
            *out_flags = WINSTAGE_RES_STAGED | WINSTAGE_RES_EXISTS;
            return 0;
        }
        ws_strlcpy_w(out_path, real_path, out_cch);
        *out_flags = WINSTAGE_RES_REAL;
        return 0;
    }

    /* write / delete */
    if (ws_stage_tree_has_reparse(staged)) {
        return -1;
    }
    if (!ws_ensure_dirs(staged, 0)) {
        ws_log_w(L"stage parent unreachable", staged);
        return -1;
    }
    ws_strlcpy_w(out_path, staged, out_cch);
    *out_flags = WINSTAGE_RES_STAGED;
    return 0;
}

static int dp_file_whiteout(const wchar_t *real_path)
{
    WS_PATH_BUF(wo);
    if (!ws_wo_path(real_path, wo, WS_PATH_MAX)) {
        return -1;
    }
    if (ws_exists(wo)) {
        return 0;
    }
    if (ws_stage_tree_has_reparse(wo)) {
        return -1;
    }
    if (!ws_ensure_dirs(wo, 0)) {
        return -1;
    }
    HANDLE h = ws_open_file_raw(wo, GENERIC_WRITE, 0, CREATE_ALWAYS);
    if (h == INVALID_HANDLE_VALUE) {
        return -1;
    }
    CloseHandle(h);
    return 0;
}

static int dp_file_whiteouted(const wchar_t *real_path)
{
    WS_PATH_BUF(wo);
    if (!ws_wo_path(real_path, wo, WS_PATH_MAX)) {
        return -1;
    }
    return ws_marker_exists(wo) ? 1 : 0;
}

/* ------------------------------------------------------------------ vtable */

const WinstageStageApi g_defaultStage = {
    WINSTAGE_STAGE_ABI_VERSION,
    (uint32_t)sizeof(WinstageStageApi),
    L"builtin-t3reg",
    dp_file_resolve,
    dp_file_whiteout,
    dp_file_whiteouted,
    ws_rstore_key_resolve,
    ws_rstore_value_set,
    ws_rstore_value_get,
    ws_rstore_value_delete,
    ws_rstore_key_delete,
    ws_rstore_value_enum,
    ws_rstore_key_enum,
};

const WinstageStageApi *ws_stage_default_get(void)
{
    return &g_defaultStage;
}
