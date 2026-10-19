/* WinStageSandbox -- T4 shim: file API hooks.
 *
 * Write-intent calls are redirected into the staging tree; read calls consult the
 * overlay first and fall through to the real file on a miss (readThrough).
 * Fail-closed: when the provider cannot stage a write, the call fails with
 * ERROR_ACCESS_DENIED and the real system is NOT touched.
 *
 * Two things are load-bearing and easy to regress:
 *   - the hook engine must never patch the IAT of a module the shim itself
 *     imports from (ws_hook.c `ws_collect_self_providers`), or ws_log() ->
 *     CreateFileW re-enters ws_CreateFileW and recurses (see
 *     docs/T6-门禁收敛与载体完整性报告.md §2);
 *   - stat/existence (GetFileAttributes*) must answer from the OVERLAY, or a
 *     sandboxed process cannot see its own staged writes (`Test-Path` false ->
 *     the redirect canary's read-back is skipped; docs/T6 §3).
 */
#include "winstage_internal.h"

/* offsetof() for the R20 directory-info layouts (FILE_*_DIR_INFORMATION). */
#include <stddef.h>

/* R11-D-13d-seq: shared per-process call ordinal, so log lines can be ordered and bound
 * to probe actions (existsSync -> statSync -> lstatSync -> readFileSync). */
static volatile LONG g_wsSeqN;
static long ws_seq(void) { return (long)InterlockedIncrement(&g_wsSeqN); }

/* Verbose file tracing (WINSTAGE_SHIM_VERBOSE=1). */
#define WS_TRACE_FILE(...) do { if (g_ws.verbose) ws_log(__VA_ARGS__); } while (0)

/* R20: diagnostic traces (ATTRDBG-* / read-branch / probe-stat) used to be
 * unconditional ws_log calls. An ordinary carrier (PowerShell startup) then
 * wrote multi-MB logs and paid a file append per intercepted call. They are
 * diagnostics, not audit: keep the call sites but only emit under
 * WINSTAGE_SHIM_VERBOSE=1. */
#define WS_DBG(...) do { if (g_ws.verbose) ws_log(__VA_ARGS__); } while (0)

/* Re-entrancy guard for shim-internal mutations of STAGED paths.
 *
 * kernelbase.dll's IAT is patched too (it is not one of the shim's own import
 * providers -- measured: the hook log lists kernelbase!), so the real
 * DeleteFileW/RemoveDirectoryW that we call on a staged path reaches
 * kernelbase's internal NtSetInformationFile through OUR hook. Without this
 * guard ws_DeleteFileW would recurse into ws_NtSetInformationFile, which would
 * delete the staged copy again and whiteout the logical path, forever.
 * Thread-local: another thread's delete must still be intercepted. */
static _Thread_local int t_wsFileBusy;

/* --------------------------------------------------------------- helpers */

/* Windows console/pseudo devices are not files: intercepting them turns console
 * I/O into staged file I/O. `CONOUT$` was the one that mattered: PowerShell's
 * console writes were staged, the copy-on-write of CONOUT$ failed, and the
 * fail-closed ACCESS_DENIED killed the process (0x80131623 masked as a CLR
 * error). The check is applied to the basename as well, because the path may
 * already have been made absolute. */
static int ws_is_device_name(const wchar_t *s)
{
    static const wchar_t *exact[] = {
        L"NUL", L"CON", L"PRN", L"AUX", L"CONOUT$", L"CONIN$", L"CONOUT", L"CONIN", L"CLOCK$", L"$MFT",
    };
    static const wchar_t *withExt[] = { L"CON", L"PRN", L"AUX", L"NUL" };
    if (!s || !s[0]) {
        return 0;
    }
    for (size_t i = 0; i < sizeof(exact) / sizeof(exact[0]); i++) {
        if (ws_wcscmp_ci(s, exact[i]) == 0) {
            return 1;
        }
        /* CONOUT$ can also appear as CONOUT$.something in weird callers */
        if (ws_starts_with_ci_w(s, exact[i]) && s[wcslen(exact[i])] == L'.') {
            return 1;
        }
    }
    for (size_t i = 0; i < sizeof(withExt) / sizeof(withExt[0]); i++) {
        if (ws_starts_with_ci_w(s, withExt[i])) {
            size_t n = wcslen(withExt[i]);
            if (s[n] == 0 || s[n] == L'.') {
                return 1;
            }
        }
    }
    if ((ws_starts_with_ci_w(s, L"COM") || ws_starts_with_ci_w(s, L"LPT")) &&
        s[3] >= L'1' && s[3] <= L'9' && (s[4] == 0 || s[4] == L'.')) {
        return 1;
    }
    return 0;
}

static int ws_is_device_path(const wchar_t *norm)
{
    if (ws_starts_with_ci_w(norm, L"\\\\.\\") ||
        ws_starts_with_ci_w(norm, L"\\Device\\") ||
        ws_starts_with_ci_w(norm, L"\\\\?\\GLOBALROOT") ||
        ws_starts_with_ci_w(norm, L"\\??\\")) {
        return 1;
    }
    if (ws_is_device_name(norm)) {
        return 1;
    }
    const wchar_t *base = wcsrchr(norm, L'\\');
    return ws_is_device_name(base ? base + 1 : norm);
}
/* ═══ R20 FOLLOW-UP（P0）：NT 命名空间 / Win32 设备别名 -> 普通 Win32 路径 ═══
 *
 * 现场（canonical R20 实测：`.lead/logs/file-shim/pathbypass-r20.log`）：原生用户模块
 * 用 `\Device\HarddiskVolumeN\…` / `\??\Volume{GUID}\…` 调 NtCreateFile 时，
 * `ws_nt_path_from_object()` 只认 `\??\X:\…` 与 `\??\UNC\…`，其余一律"透传" ⇒
 *   ① 写意图绕过（R17：真实盘被写）；
 *   ② 遮蔽读绕过（R18：设备路径读 `.npmrc` 得到明文）；
 *   ③ `NtOpenFile(FILE_DELETE_ON_CLOSE)` 设备路径真实删除（R19 `del` 载体同族）。
 * Win32 侧的 `\\?\GLOBALROOT\Device\…` / `\\.\X:` 是同一根因（`ws_normalize_path` 认不出）。
 *
 * 本 helper 把**可映射**的设备别名转成普通 Win32 路径，之后统一走现有管线
 * （写 deny / 遮蔽 deny / 读 overlay / delete whiteout / 枚举过滤）。逐条覆盖：
 *   `\Device\HarddiskVolumeN[\…]`            -> `X:[\…]`（QueryDosDevice 盘符缓存）
 *   `\Device\Mup\server\share[\…]`           -> `\\server\share[\…]`
 *   `\??\Volume{GUID}\…` / `\\?\Volume{GUID}\…` -> 挂载点 + rest（GetVolumePathNamesForVolumeNameW）
 *   `\??\UNC\server\share[\…]`               -> `\\server\share[\…]`
 *   `\??\X:\…` / `\DosDevices\X:\…`          -> `X:\…`（`\DosDevices` 是 `\??` 的对象管理器别名）
 *   `\SystemRoot[\…]`                        -> `<WindowsDirectory>[\…]`（GetWindowsDirectoryW）
 *   `\??\` / `\\?\` / `\\.\` + `GLOBALROOT\…` -> 剥掉 GLOBALROOT 后继续映射
 *   `\\.\X:[\…]`                             -> `X:[\…]`
 * **映射不了的**（`\\.\PhysicalDriveN`、`\Device\NamedPipe`、未知 `\Device\…`、相对名…）
 * 返回 0，由调用方按「写/删一律 deny；mask 已声明时读也 deny」处理（见
 * ws_NtCreateFile / ws_NtOpenFile / ws_NtQueryDirectoryFile），findings §6 逐条点名残余。 */
typedef struct WsDriveDev {
    wchar_t letter;
    wchar_t canonical; /* R21: smallest letter bound to the same device (subst/duplicate drive) */
    wchar_t device[WS_PATH_MAX];
} WsDriveDev;
static WsDriveDev g_driveDev[26];
static INIT_ONCE g_driveDevOnce = INIT_ONCE_STATIC_INIT;

static BOOL CALLBACK ws_drive_dev_init(PINIT_ONCE once, PVOID param, PVOID *ctx)
{
    (void)once;
    (void)param;
    (void)ctx;
    for (int i = 0; i < 26; i++) {
        wchar_t drive[3];
        drive[0] = (wchar_t)(L'A' + i);
        drive[1] = L':';
        drive[2] = 0;
        WCHAR dev[WS_PATH_MAX];
        DWORD n = QueryDosDeviceW(drive, dev, WS_PATH_MAX);
        if (n > 0 && n < WS_PATH_MAX) {
            g_driveDev[i].letter = drive[0];
            g_driveDev[i].canonical = drive[0];
            ws_strlcpy_w(g_driveDev[i].device, dev, WS_PATH_MAX);
        }
    }
    /* R21: `subst Y: C:\x` gives Y: the SAME device as C:. Normalise the alias to
     * the smallest letter of the volume so staging/mask keys cannot be split in
     * two by two spellings of the same file. */
    for (int i = 0; i < 26; i++) {
        if (!g_driveDev[i].letter) {
            continue;
        }
        for (int j = 0; j < i; j++) {
            if (!g_driveDev[j].letter) {
                continue;
            }
            if (ws_wcscmp_ci(g_driveDev[i].device, g_driveDev[j].device) == 0) {
                g_driveDev[i].canonical = g_driveDev[j].canonical;
                break;
            }
        }
    }
    return TRUE;
}

/* \\localhost\X$\rest / \\127.0.0.1\X$\rest / \\<本机名>\X$\rest -> X:\rest
 * （R21：同一本地文件经管理共享 UNC 访问时，mask 与 staging 必须落在同一个键上） */
static wchar_t g_computerName[64];
static INIT_ONCE g_computerNameOnce = INIT_ONCE_STATIC_INIT;
static BOOL CALLBACK ws_computer_name_init(PINIT_ONCE once, PVOID param, PVOID *ctx)
{
    (void)once;
    (void)param;
    (void)ctx;
    DWORD n = (DWORD)(sizeof(g_computerName) / sizeof(g_computerName[0]));
    if (!GetComputerNameW(g_computerName, &n)) {
        g_computerName[0] = 0;
    }
    return TRUE;
}

static int ws_local_admin_share(const wchar_t *p, wchar_t *out, DWORD cch)
{
    if (!p || p[0] != L'\\' || p[1] != L'\\') {
        return 0;
    }
    const wchar_t *server = p + 2;
    const wchar_t *slash = wcschr(server, L'\\');
    if (!slash || slash == server) {
        return 0;
    }
    size_t slen = (size_t)(slash - server);
    int local = (slen == 9 && _wcsnicmp(server, L"localhost", 9) == 0) ||
                (slen == 9 && _wcsnicmp(server, L"127.0.0.1", 9) == 0);
    if (!local) {
        InitOnceExecuteOnce(&g_computerNameOnce, ws_computer_name_init, NULL, NULL);
        if (g_computerName[0] && wcslen(g_computerName) == slen &&
            _wcsnicmp(server, g_computerName, (int)slen) == 0) {
            local = 1;
        }
    }
    if (!local) {
        return 0;
    }
    const wchar_t *share = slash + 1;
    if (!((share[0] >= L'A' && share[0] <= L'Z') || (share[0] >= L'a' && share[0] <= L'z')) ||
        share[1] != L'$' || (share[2] != L'\\' && share[2] != 0)) {
        return 0;
    }
    wchar_t letter = share[0];
    if (letter >= L'a' && letter <= L'z') {
        letter = (wchar_t)(letter - L'a' + L'A');
    }
    wchar_t driveBuf[3] = { letter, L':', 0 };
    size_t opos = 0;
    out[0] = 0;
    return ws_append_w(out, cch, &opos, driveBuf) && ws_append_w(out, cch, &opos, share + 2);
}

/* Drive-letter alias (subst / duplicated letters) -> canonical letter. */
static int ws_canonical_drive(const wchar_t *p, wchar_t *out, DWORD cch)
{
    if (!p || !((p[0] >= L'A' && p[0] <= L'Z') || (p[0] >= L'a' && p[0] <= L'z')) || p[1] != L':') {
        return 0;
    }
    InitOnceExecuteOnce(&g_driveDevOnce, ws_drive_dev_init, NULL, NULL);
    int idx = (p[0] >= L'a' && p[0] <= L'z') ? (int)(p[0] - L'a') : (int)(p[0] - L'A');
    if (idx < 0 || idx >= 26 || !g_driveDev[idx].letter) {
        return 0;
    }
    wchar_t upper = (p[0] >= L'a' && p[0] <= L'z') ? (wchar_t)(p[0] - L'a' + L'A') : p[0];
    wchar_t canon = g_driveDev[idx].canonical ? g_driveDev[idx].canonical : g_driveDev[idx].letter;
    if (canon != upper) {
        wchar_t driveBuf[3] = { canon, L':', 0 };
        size_t opos = 0;
        out[0] = 0;
        return ws_append_w(out, cch, &opos, driveBuf) && ws_append_w(out, cch, &opos, p + 2);
    }
    /* subst drive: QueryDosDeviceW("Y:") returns the symlink target in the
     * `\\??\\C:\\target` form (NOT the device name like "\\Device\\HarddiskVolume4"),
     * so the duplicate-device rule above cannot see it. Map `Y:\\rest` to the
     * target path + `\\rest` so the same file cannot get two staging keys. */
    const wchar_t *dev = g_driveDev[idx].device;
    if (ws_starts_with_ci_w(dev, L"\\??\\")) {
        dev += 4;
    } else {
        return 0;
    }
    if (!dev[0]) {
        return 0;
    }
    int absDrive = ((dev[0] >= L'A' && dev[0] <= L'Z') || (dev[0] >= L'a' && dev[0] <= L'z')) &&
                   dev[1] == L':' && (dev[2] == L'\\' || dev[2] == 0);
    int absUnc = dev[0] == L'\\' && dev[1] == L'\\' && dev[2] && dev[2] != L'?' && dev[2] != L'.';
    if (!absDrive && !absUnc) {
        return 0;
    }
    size_t opos = 0;
    out[0] = 0;
    return ws_append_w(out, cch, &opos, dev) && ws_append_w(out, cch, &opos, p + 2);
}

/* 8.3 short name -> long name when the object exists (R21: `LONGFI~1.TXT` and
 * `LongFileName-For-ShortName-Test.txt` must be the same staging key). */
static int ws_long_name_of(const wchar_t *p, wchar_t *out, DWORD cch)
{
    if (!p || !wcschr(p, L'~')) {
        return 0;
    }
    DWORD saved = GetLastError();
    DWORD n = GetLongPathNameW(p, out, cch);
    SetLastError(saved);
    if (n == 0 || n >= cch) {
        out[0] = 0;
        return 0;
    }
    return ws_wcscmp_ci(out, p) != 0;
}

/* R21: canonicalise the Win32-alias spellings that the IAT hooks would otherwise
 * treat as DIFFERENT files (split staging keys / split mask decisions):
 *   `\\?\C:\…` / `\\?\UNC\…`  -> plain Win32 form
 *   `\\localhost\C$\…` etc.   -> `C:\…`
 *   `Y:\…` (subst)            -> canonical drive letter (`C:\…`)
 *   `LONGFI~1.TXT`            -> long name when the object exists
 * Returns 1 only when something changed; `out` is the canonical form then. */
static int ws_canonical_aliases(const wchar_t *in, wchar_t *out, DWORD cch)
{
    if (!in || !in[0]) {
        return 0;
    }
    int maybe = 0;
    if (ws_starts_with_ci_w(in, L"\\\\?\\")) {
        maybe = 1;
    } else if (in[0] == L'\\' && in[1] == L'\\') {
        maybe = 1;
    } else if (((in[0] >= L'A' && in[0] <= L'Z') || (in[0] >= L'a' && in[0] <= L'z')) && in[1] == L':') {
        maybe = 1;
    }
    if (!maybe && !wcschr(in, L'~')) {
        return 0;
    }
    DWORD saved = GetLastError();
    wchar_t cur[WS_PATH_MAX];
    wchar_t tmp[WS_PATH_MAX];
    ws_strlcpy_w(cur, in, WS_PATH_MAX);
    int changed = 0;
    if (ws_starts_with_ci_w(cur, L"\\\\?\\UNC\\")) {
        size_t opos = 0;
        tmp[0] = 0;
        if (ws_append_w(tmp, WS_PATH_MAX, &opos, L"\\\\") && ws_append_w(tmp, WS_PATH_MAX, &opos, cur + 8)) {
            ws_strlcpy_w(cur, tmp, WS_PATH_MAX);
            changed = 1;
        }
    } else if (ws_starts_with_ci_w(cur, L"\\\\?\\")) {
        ws_strlcpy_w(cur, cur + 4, WS_PATH_MAX);
        changed = 1;
    }
    if (ws_local_admin_share(cur, tmp, WS_PATH_MAX)) {
        ws_strlcpy_w(cur, tmp, WS_PATH_MAX);
        changed = 1;
    }
    if (ws_canonical_drive(cur, tmp, WS_PATH_MAX)) {
        ws_strlcpy_w(cur, tmp, WS_PATH_MAX);
        changed = 1;
    }
    if (ws_long_name_of(cur, tmp, WS_PATH_MAX)) {
        ws_strlcpy_w(cur, tmp, WS_PATH_MAX);
        changed = 1;
    }
    SetLastError(saved);
    if (!changed) {
        out[0] = 0;
        return 0;
    }
    ws_strlcpy_w(out, cur, cch);
    return 1;
}

/* `Volume{GUID}[\rest]` -> mount-point + rest. */
static int ws_try_volume_guid(const wchar_t *p, wchar_t *out, DWORD cch)
{
    if (!ws_starts_with_ci_w(p, L"Volume{")) {
        return 0;
    }
    const wchar_t *close = wcschr(p, L'}');
    if (!close) {
        return 0;
    }
    if (close[1] != L'\\' && close[1] != 0) {
        return 0;
    }
    wchar_t volName[WS_PATH_MAX];
    size_t pos = 0;
    volName[0] = 0;
    if (!ws_append_w(volName, WS_PATH_MAX, &pos, L"\\\\?\\")) {
        return 0;
    }
    size_t guidLen = (size_t)(close - p) + 1;
    if (pos + guidLen + 2 >= WS_PATH_MAX) {
        return 0;
    }
    memcpy(volName + pos, p, guidLen * sizeof(wchar_t));
    pos += guidLen;
    volName[pos++] = L'\\';
    volName[pos] = 0;
    wchar_t paths[WS_PATH_MAX];
    DWORD plen = 0;
    if (!GetVolumePathNamesForVolumeNameW(volName, paths, WS_PATH_MAX, &plen)) {
        return 0;
    }
    if (!paths[0]) {
        return 0;
    }
    wchar_t mount[WS_PATH_MAX];
    ws_strlcpy_w(mount, paths, WS_PATH_MAX);
    size_t mlen = wcslen(mount);
    if (mlen > 1 && mount[mlen - 1] == L'\\') {
        mount[mlen - 1] = 0;
    }
    size_t opos = 0;
    if (!ws_append_w(out, cch, &opos, mount)) {
        return 0;
    }
    return ws_append_w(out, cch, &opos, close + 1);
}

/* 1 = mapped to a normal Win32 path. Never touches the caller's last error. */
static int ws_nt_device_to_win(const wchar_t *nt, wchar_t *out, DWORD cch)
{
    DWORD saved = GetLastError();
    int ok = 0;
    out[0] = 0;
    if (nt && nt[0]) {
        const wchar_t *p = nt;
        /* peel GLOBALROOT namespace prefixes: \\?\ / \\.\ / \??\ + GLOBALROOT */
        if (ws_starts_with_ci_w(p, L"\\\\?\\GLOBALROOT") || ws_starts_with_ci_w(p, L"\\\\.\\GLOBALROOT") ||
            ws_starts_with_ci_w(p, L"\\??\\GLOBALROOT")) {
            p += 14; /* namespace prefix (4 chars) + "GLOBALROOT" (10) */
        }
        /* \??\ / \DosDevices\ / \GLOBAL??\ : the same object-manager dos-devices
         * namespace under its other aliases (attacker can spell the same volume
         * three ways). */
        const wchar_t *tail = NULL;
        if (ws_starts_with_ci_w(p, L"\\??\\")) {
            tail = p + 4;
        } else if (ws_starts_with_ci_w(p, L"\\DosDevices\\")) {
            tail = p + 12;
        } else if (ws_starts_with_ci_w(p, L"\\GLOBAL??\\")) {
            tail = p + 10;
        }
        if (tail) {
            if (ws_starts_with_ci_w(tail, L"Volume{")) {
                p = tail;
            } else if (ws_starts_with_ci_w(tail, L"UNC\\")) {
                size_t opos = 0;
                ok = ws_append_w(out, cch, &opos, L"\\\\") && ws_append_w(out, cch, &opos, tail + 4);
                SetLastError(saved);
                return ok;
            } else if (((tail[0] >= L'A' && tail[0] <= L'Z') || (tail[0] >= L'a' && tail[0] <= L'z')) &&
                       tail[1] == L':' && (tail[2] == L'\\' || tail[2] == 0)) {
                size_t opos = 0;
                ok = ws_append_w(out, cch, &opos, tail);
                SetLastError(saved);
                return ok;
            } else {
                p = tail; /* e.g. \??\GLOBALROOT already peeled; fall through */
            }
        }
        if (ws_starts_with_ci_w(p, L"\\\\?\\Volume{")) {
            p += 4;
        }
        if (ws_starts_with_ci_w(p, L"Volume{")) {
            ok = ws_try_volume_guid(p, out, cch);
            SetLastError(saved);
            return ok;
        }
        if (ws_starts_with_ci_w(p, L"\\SystemRoot")) {
            wchar_t winDir[WS_PATH_MAX];
            UINT n = GetWindowsDirectoryW(winDir, WS_PATH_MAX);
            if (n > 0 && n < WS_PATH_MAX) {
                size_t opos = 0;
                ok = ws_append_w(out, cch, &opos, winDir) && ws_append_w(out, cch, &opos, p + 11);
            }
            SetLastError(saved);
            return ok;
        }
        if (ws_starts_with_ci_w(p, L"\\Device\\Mup\\")) {
            size_t opos = 0;
            ok = ws_append_w(out, cch, &opos, L"\\\\") && ws_append_w(out, cch, &opos, p + 12);
            SetLastError(saved);
            return ok;
        }
        if (ws_starts_with_ci_w(p, L"\\Device\\")) {
            InitOnceExecuteOnce(&g_driveDevOnce, ws_drive_dev_init, NULL, NULL);
            for (int i = 0; i < 26; i++) {
                if (!g_driveDev[i].letter) {
                    continue;
                }
                size_t dl = wcslen(g_driveDev[i].device);
                if (dl && ws_starts_with_ci_w(p, g_driveDev[i].device) &&
                    (p[dl] == L'\\' || p[dl] == 0)) {
                    wchar_t letterBuf[3] = { g_driveDev[i].letter, L':', 0 };
                    size_t opos = 0;
                    ok = ws_append_w(out, cch, &opos, letterBuf) && ws_append_w(out, cch, &opos, p + dl);
                    break;
                }
            }
            SetLastError(saved);
            return ok;
        }
        if (ws_starts_with_ci_w(p, L"\\\\.\\") &&
            ((p[4] >= L'A' && p[4] <= L'Z') || (p[4] >= L'a' && p[4] <= L'z')) && p[5] == L':' &&
            (p[6] == L'\\' || p[6] == 0)) {
            size_t opos = 0;
            ok = ws_append_w(out, cch, &opos, p + 4);
            SetLastError(saved);
            return ok;
        }
    }
    SetLastError(saved);
    return 0;
}

/* Cheap prefix test: is this one of the namespaces the mapper handles? Used to
 * decide "unmapped device alias => fail closed (write/delete) instead of guessing". */
static int ws_is_nt_alias(const wchar_t *p)
{
    return p && p[0] && (ws_starts_with_ci_w(p, L"\\Device\\") || ws_starts_with_ci_w(p, L"\\??\\") ||
                         ws_starts_with_ci_w(p, L"\\\\?\\") || ws_starts_with_ci_w(p, L"\\\\.\\") ||
                         ws_starts_with_ci_w(p, L"\\DosDevices\\") || ws_starts_with_ci_w(p, L"\\GLOBAL??\\") ||
                         ws_starts_with_ci_w(p, L"\\SystemRoot") || ws_starts_with_ci_w(p, L"Volume{"));
}

/* Same cheap prefix test on an OBJECT_ATTRIBUTES name (no NUL assumption). */
static int ws_is_nt_alias_oa(POBJECT_ATTRIBUTES oa)
{
    if (!oa || !oa->ObjectName || !oa->ObjectName->Buffer || oa->ObjectName->Length == 0) {
        return 0;
    }
    const UNICODE_STRING *us = oa->ObjectName;
    if (us->Length > (ULONG)((WS_PATH_MAX - 1) * sizeof(wchar_t))) {
        return 1;
    }
    wchar_t nz[WS_PATH_MAX];
    size_t n = (size_t)(us->Length / sizeof(wchar_t));
    memcpy(nz, us->Buffer, n * sizeof(wchar_t));
    nz[n] = 0;
    return ws_is_nt_alias(nz);
}

/* Map when possible. Returns 1 when `out` holds a mapped Win32 path (callers
 * only use `out` on 1); 0 means "leave the caller's path untouched". Hot path:
 * every CreateFileW/open hook calls this, so an unmapped path must not pay a
 * WS_PATH_MAX copy. LastError-transparent. */
static int ws_path_effective(const wchar_t *in, wchar_t *out, DWORD cch)
{
    DWORD saved = GetLastError();
    out[0] = 0;
    if (!in || !in[0]) {
        SetLastError(saved);
        return 0;
    }
    wchar_t stage1[WS_PATH_MAX];
    wchar_t stage2[WS_PATH_MAX];
    const wchar_t *cur = in;
    int changed = 0;
    if (ws_nt_device_to_win(cur, stage1, WS_PATH_MAX)) {
        cur = stage1;
        changed = 1;
    }
    if (ws_canonical_aliases(cur, stage2, WS_PATH_MAX)) {
        cur = stage2;
        changed = 1;
    }
    if (changed) {
        ws_strlcpy_w(out, cur, cch);
    }
    SetLastError(saved);
    return changed;
}

/* Prefix test for the staging root / passthrough entries: the prefix must end at
 * a path separator, otherwise a real file whose name merely STARTS WITH the
 * staging root (e.g. stage root "C:\s\stage" and file "C:\s\stage-report.txt")
 * would silently bypass the sandbox and be written to the real system. */
static int ws_under_prefix(const wchar_t *norm, const wchar_t *prefix)
{
    if (!ws_starts_with_ci_w(norm, prefix)) {
        return 0;
    }
    size_t n = wcslen(prefix);
    return norm[n] == 0 || norm[n] == L'\\';
}

/* 1 = intercept, 0 = pass through to the real API unchanged. */
static int ws_should_intercept(const wchar_t *path, wchar_t *norm, DWORD cch)
{
    /* ★ WP13（B5）：`GetFullPathNameW` 失败时会改 last error，而本函数是**每一个**
     * 文件钩子的第一跳，只用一个布尔结果回答"是否接管"。判断结果由返回值表达，
     * 因此入口保存、每条出口还原，对调用方在线程状态上完全透明。 */
    DWORD ws_saved_last_error = GetLastError();
    if (!path || !path[0] || !g_ws.haveStageRoot) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    /* R20 FOLLOW-UP（P0）：先剥 NT 命名空间/设备别名（\Device\…、\??\Volume{GUID}\…、
     * \\?\GLOBALROOT\Device\…、\\.\X: …），否则下面会把它们当"设备/相对路径"放行，
     * 使写遮蔽/读遮蔽/delete 全部绕过。映射不了的名字保持原样 → 后面的
     * ws_is_device_path() 照旧放行（残余逐条登记，见 helper 注释）。 */
    wchar_t eff[WS_PATH_MAX];
    const wchar_t *effPath = path;
    if (ws_path_effective(path, eff, WS_PATH_MAX)) {
        effPath = eff;
    }
    /* Device/console names first, and on the raw string: GetFullPathNameW would
     * happily turn "CONOUT$" into "<cwd>\CONOUT$". */
    wchar_t probe[WS_PATH_MAX];
    if (ws_normalize_path(effPath, probe, WS_PATH_MAX) && ws_is_device_path(probe)) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    /* Relative paths are resolved against the process CWD before staging, so a
     * relative write is staged instead of silently reaching the real disk. */
    wchar_t full[WS_PATH_MAX];
    if (!GetFullPathNameW(effPath, WS_PATH_MAX, full, NULL)) {
        /* R21：`ws_path_effective()` 会剥掉 `\\?\` 前缀；对于 >MAX_PATH 的路径，
         * 不带前缀的 GetFullPathNameW 会失败（本机 LongPathsEnabled=0）。此前这
         * 直接 return 0 ⇒ 读透传被破坏（gate-runner S2：注入后读长路径文件 ERR=3），
         * 更糟的是写意图也会落进"放行"分支。这里用**调用方原始路径**重试一次
         * （原始路径通常带 `\\?\`），拿到绝对路径后照常归一化 ⇒ 继续走暂存/遮蔽
         * 管线；写意图仍由 provider 的暂存失败 fail-closed。 */
        if (effPath != path) {
            if (!GetFullPathNameW(path, WS_PATH_MAX, full, NULL)) {
                SetLastError(ws_saved_last_error);
                return 0;
            }
        } else {
            SetLastError(ws_saved_last_error);
            return 0;
        }
    }
    if (!ws_normalize_path(full, norm, cch)) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    if (ws_is_device_path(norm)) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    if (ws_under_prefix(norm, g_ws.stageRoot)) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    for (int i = 0; i < g_ws.passthroughCount; i++) {
        if (ws_under_prefix(norm, g_ws.passthrough[i])) {
            SetLastError(ws_saved_last_error);
            return 0;
        }
    }
    SetLastError(ws_saved_last_error);
    return 1;
}

static int ws_resolve_file(const wchar_t *norm, uint32_t intent, wchar_t *out, uint32_t *flags)
{
    if (!g_wsStage.file_resolve) {
        return -1;
    }
    return g_wsStage.file_resolve(norm, intent, out, WS_PATH_MAX, flags);
}

/* ── R21：>MAX_PATH 的真实 API 前缀（本机 LongPathsEnabled=0）───────────────
 * 归一化后的路径是普通 Win32 形式；仅当长度需要扩展前缀时才加 `\\?\` /
 * `\\?\UNC\`。只在**真实 API 边界**使用（provider 仍按普通路径映射暂存树）。 */
static const wchar_t *ws_api_path(const wchar_t *in, wchar_t *buf, DWORD cch)
{
    if (!in || !in[0] || !buf) {
        return in;
    }
    size_t n = wcslen(in);
    if (n < 248 || ws_starts_with_ci_w(in, L"\\\\?\\")) {
        return in;
    }
    size_t pos = 0;
    buf[0] = 0;
    if (in[0] == L'\\' && in[1] == L'\\') {
        if (!(ws_append_w(buf, cch, &pos, L"\\\\?\\UNC\\") && ws_append_w(buf, cch, &pos, in + 2))) {
            return in;
        }
    } else if (!(ws_append_w(buf, cch, &pos, L"\\\\?\\") && ws_append_w(buf, cch, &pos, in))) {
        return in;
    }
    return buf;
}

/* Real-API accessors for the stat family. These MUST NOT re-enter the hooks:
 * they are used by ws_file_exists() (a CoW/whiteout decision about the REAL
 * file) and as the tail of the overlay-aware wrappers. The captured original is
 * preferred; the plain call is only reached before ws_hook_init captured the
 * originals (nothing is patched yet) or if a capture ever failed, and our own
 * module's import table is never patched, so it still reaches the real API.
 * R21: >MAX_PATH 的真实文件需要扩展前缀，否则 stat 会误报不存在（读透传因此断）。 */
static DWORD ws_real_attrs_w(const wchar_t *path)
{
    wchar_t apiBuf[WS_PATH_MAX];
    const wchar_t *p = ws_api_path(path, apiBuf, WS_PATH_MAX);
    return g_orig.GetFileAttributesW ? g_orig.GetFileAttributesW(p) : GetFileAttributesW(p);
}

static BOOL ws_real_attrs_ex_w(const wchar_t *path, GET_FILEEX_INFO_LEVELS level, LPVOID info)
{
    wchar_t apiBuf[WS_PATH_MAX];
    const wchar_t *p = ws_api_path(path, apiBuf, WS_PATH_MAX);
    return g_orig.GetFileAttributesExW ? g_orig.GetFileAttributesExW(p, level, info)
                                       : GetFileAttributesExW(p, level, info);
}

/* ★ WP13（B7）：这是每次 CreateFile / Delete / Move / SetFileAttributes 都会跑的
 * 探测（`ws_create_file_core` 入口就调用它），也是**运行期最高频**的 last-error 污染点。
 * 它只回答一个布尔问题，却会把 `GetFileAttributesW` 的 2/3 号错误留在调用者的线程状态上。
 * 注意 `ws_real_attrs_w` 本身**不要**改：它必须把真实 API 的错误交给这里的调用者判断，
 * 透明化点就在这一层。 */
static int ws_file_exists(const wchar_t *norm)
{
    DWORD ws_saved_last_error = GetLastError();
    int exists = ws_real_attrs_w(norm) != INVALID_FILE_ATTRIBUTES;
    SetLastError(ws_saved_last_error);
    return exists;
}

static void ws_a2w_buf(const char *in, wchar_t *out, DWORD cch)
{
    out[0] = 0;
    if (in) {
        if (!MultiByteToWideChar(CP_ACP, 0, in, -1, out, (int)cch)) {
            out[0] = 0;
        }
    }
}

#define WS_FILE_WRITE_ACCESS_MASK \
    (GENERIC_WRITE | GENERIC_ALL | FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | \
     FILE_WRITE_ATTRIBUTES | DELETE | WRITE_DAC | WRITE_OWNER | FILE_DELETE_CHILD)

/* ── R19-A1：**读边界位**（mask 判定用；Lead 拍板语义，见 ws_create_file_core 的 mask 段）
 *
 * mask 的语义是**读边界**，不是"禁止一切访问"：
 *   · desiredAccess 命中本掩码（GENERIC_READ / FILE_READ_DATA / GENERIC_ALL / MAXIMUM_ALLOWED）
 *     ⇒ 这是"读内容"意图 ⇒ ERROR_ACCESS_DENIED（`r+` = GENERIC_READ|GENERIC_WRITE 也命中，
 *     `MemoryMappedFile` / `[IO.File]::Open(...,'ReadWrite')` 同理）；
 *   · **纯写意图**（不含上述读位）⇒ 允许进暂存，但**绝不做 CoW copy-up**
 *     （不把真实明文搬进 overlay；否则写意图 open 之后用同一 handle 读，就能读到明文 ——
 *      R19 实测：`fs.openSync(masked,'r+')` + `readSync` 直接输出 marker）。
 * 这条区分是刻意的：不把"写敏感文件"整体封死，同时消灭"明文进暂存/被读回"的泄露面。 */
#define WS_FILE_READ_ACCESS_MASK (GENERIC_READ | GENERIC_ALL | MAXIMUM_ALLOWED | FILE_READ_DATA)

static uint32_t ws_intent_of_create(DWORD access, DWORD disposition)
{
    DWORD writeAccess = access & WS_FILE_WRITE_ACCESS_MASK;
    switch (disposition) {
    case CREATE_NEW:
    case CREATE_ALWAYS:
    case TRUNCATE_EXISTING:
    case OPEN_ALWAYS:
        return WINSTAGE_IO_WRITE;
    default:
        return writeAccess ? WINSTAGE_IO_WRITE : WINSTAGE_IO_READ;
    }
}

/* ── R18-KNOWN-06：写意图 open 的"零写撤销"记账 ─────────────────────────────────
 *
 * 现场（round16 D6-1 / R17 KNOWN-06）：对一个**已存在**的真实文件做"写意图 open"
 * （GENERIC_WRITE / FILE_WRITE_DATA…，一个字节都不写）时，`ws_create_file_core()`
 * 为了让后续 `ReadFile` 能读到真实内容，必须 `CopyFileW` 做 CoW ⇒ 整份明文立刻落到
 * 暂存树（敏感文件还有 blob，且 stage root 不随 run 销毁）。
 *
 * 修法（R18，Lead 授权方案 A）：copy 照做（否则 OPEN_ALWAYS 读回空的旧 bug 回归），
 * 但把这次 copy 记进本表；`WriteFile/WriteFileEx/SetEndOfFile/SetFileInformationByHandle`
 * 命中该句柄即置 `wrote`；`CloseHandle` 时若 `!wrote` **且暂存副本内容与真实文件逐字节相同**
 * （逐字节比对是防线：绕过我们钩子的写路径（如 NtWriteFile 直调）改了内容 ⇒ 保留副本），
 * 才删除暂存副本 —— host 的 `captureAfterExecution()` 按暂存树哈希差分捕获，
 * 删掉副本即等于"本轮没有变化/不产生候选"。
 *
 * 为什么还要逐字节比对而不是只看 wrote：IAT 钩子覆盖不到所有写路径（ntdll 直调等）。
 * 只按 wrote 删会把"绕过钩子的真实写入"静默丢弃；比对把方向锁在"内容确实没变"这一侧。
 * 代价：只有"写意图 open 且此前无暂存副本"的句柄才进表/才比对，正常读写路径不受影响
 * （`g_cowCount == 0` 时所有包装器都是纯转发）。 */
#define WS_COW_MAX_ENTRIES 64

typedef struct WsCowEntry {
    HANDLE handle;
    wchar_t staged[WS_PATH_MAX];
    wchar_t real[WS_PATH_MAX];
    int wrote;
} WsCowEntry;

static WsCowEntry g_cowEntries[WS_COW_MAX_ENTRIES];
static WsLock g_cowLock;
static INIT_ONCE g_cowOnce = INIT_ONCE_STATIC_INIT;
static volatile LONG g_cowCount;
static volatile LONG g_cowTableFullLogged;

static BOOL CALLBACK ws_cow_lock_once(PINIT_ONCE once, PVOID param, PVOID *ctx)
{
    (void)once;
    (void)param;
    (void)ctx;
    ws_lock_init(&g_cowLock, "cow");
    return TRUE;
}
static void ws_cow_ready(void)
{
    InitOnceExecuteOnce(&g_cowOnce, ws_cow_lock_once, NULL, NULL);
}

/* 登记一次"为了写意图 open 而新做的 CoW 副本"。表满则**不登记**（副本保留：
 * 方向是"多留一份"而不是"静默丢写"，并打一次日志）。 */
static void ws_cow_track(HANDLE h, const wchar_t *staged, const wchar_t *real)
{
    if (!h || h == INVALID_HANDLE_VALUE || !staged || !staged[0]) {
        return;
    }
    ws_cow_ready();
    ws_lock_enter(&g_cowLock);
    for (int i = 0; i < WS_COW_MAX_ENTRIES; i++) {
        if (!g_cowEntries[i].handle) {
            g_cowEntries[i].handle = h;
            ws_strlcpy_w(g_cowEntries[i].staged, staged, WS_PATH_MAX);
            ws_strlcpy_w(g_cowEntries[i].real, real ? real : L"", WS_PATH_MAX);
            g_cowEntries[i].wrote = 0;
            InterlockedIncrement(&g_cowCount);
            ws_lock_leave(&g_cowLock);
            return;
        }
    }
    ws_lock_leave(&g_cowLock);
    if (InterlockedExchange(&g_cowTableFullLogged, 1) == 0) {
        ws_log("cow tracking table full (%d); the write-intent copy is kept", WS_COW_MAX_ENTRIES);
    }
}

/* 该句柄被写入/截断 ⇒ 副本必须保留（标记后不再做零写撤销）。热点路径：
 * `g_cowCount == 0` 直接返回，不取锁。 */
static void ws_cow_mark_written(HANDLE h)
{
    if (!h || h == INVALID_HANDLE_VALUE || InterlockedCompareExchange(&g_cowCount, 0, 0) == 0) {
        return;
    }
    ws_cow_ready();
    ws_lock_enter(&g_cowLock);
    for (int i = 0; i < WS_COW_MAX_ENTRIES; i++) {
        if (g_cowEntries[i].handle == h) {
            g_cowEntries[i].wrote = 1;
            break;
        }
    }
    ws_lock_leave(&g_cowLock);
}

/* 取出并移除该句柄的登记；返回 1 表示"这是需要做零写撤销判定的 CoW 句柄"。 */
static int ws_cow_detach(HANDLE h, wchar_t *staged, DWORD stagedCch, wchar_t *real, DWORD realCch, int *wroteOut)
{
    if (!h || h == INVALID_HANDLE_VALUE || InterlockedCompareExchange(&g_cowCount, 0, 0) == 0) {
        return 0;
    }
    int found = 0;
    ws_cow_ready();
    ws_lock_enter(&g_cowLock);
    for (int i = 0; i < WS_COW_MAX_ENTRIES; i++) {
        if (g_cowEntries[i].handle != h) {
            continue;
        }
        ws_strlcpy_w(staged, g_cowEntries[i].staged, stagedCch);
        ws_strlcpy_w(real, g_cowEntries[i].real, realCch);
        if (wroteOut) {
            *wroteOut = g_cowEntries[i].wrote;
        }
        memset(&g_cowEntries[i], 0, sizeof(g_cowEntries[i]));
        InterlockedDecrement(&g_cowCount);
        found = 1;
        break;
    }
    ws_lock_leave(&g_cowLock);
    return found;
}

/* 两个文件的**内容**是否逐字节相同（打开失败/读失败 ⇒ 视为"不同"，保留副本）。 */
static int ws_cow_same_content(const wchar_t *a, const wchar_t *b)
{
    if (!a || !a[0] || !b || !b[0]) {
        return 0;
    }
    HANDLE ha = ws_open_file_raw(a, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, OPEN_EXISTING);
    if (ha == INVALID_HANDLE_VALUE) {
        return 0;
    }
    HANDLE hb = ws_open_file_raw(b, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, OPEN_EXISTING);
    if (hb == INVALID_HANDLE_VALUE) {
        CloseHandle(ha);
        return 0;
    }
    int same = 1;
    BYTE bufA[8192];
    BYTE bufB[8192];
    for (;;) {
        DWORD readA = 0;
        DWORD readB = 0;
        BOOL okA = ReadFile(ha, bufA, sizeof(bufA), &readA, NULL);
        BOOL okB = ReadFile(hb, bufB, sizeof(bufB), &readB, NULL);
        if (!okA || !okB || readA != readB || (readA && memcmp(bufA, bufB, readA) != 0)) {
            same = 0;
            break;
        }
        if (readA == 0) {
            break;
        }
    }
    CloseHandle(hb);
    CloseHandle(ha);
    return same;
}

/* Delete a path through CAPTURED ORIGINALS, bypassing every shim hook.
 *
 * Measured 2026-10-18 (c4b): `g_orig.DeleteFileW(staged)` was re-interpreted by the
 * shim's own `NtSetInformationFile` interception (kernelbase's DeleteFileW issues
 * NtSetInformationFile internally, and ntdll's export is intercepted) ⇒ instead of
 * removing the staged copy it wrote a **whiteout marker for the logical file**, so
 * the next open failed ENOENT. Calling the captured ntdll original directly cannot
 * re-enter the export interception: the staged copy disappears, no whiteout. */
static int ws_cow_delete_raw(const wchar_t *path)
{
    if (!path || !path[0] || !g_orig.CreateFileW || !g_orig.NtSetInformationFile || !g_orig.CloseHandle) {
        return 0;
    }
    HANDLE h = g_orig.CreateFileW(path, DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
                                  OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        return 0;
    }
    IO_STATUS_BLOCK iosb;
    memset(&iosb, 0, sizeof(iosb));
    BOOLEAN del = TRUE;
    NTSTATUS st = g_orig.NtSetInformationFile(h, &iosb, &del, sizeof(del), 13 /* FileDispositionInformation */);
    DWORD lastErr = GetLastError();
    g_orig.CloseHandle(h);
    SetLastError(lastErr);
    return st >= 0;
}

/* Do not lose the failing call's error code (the zero-write revoke does file IO). */
BOOL WINAPI ws_CloseHandle(HANDLE hObject)
{
    wchar_t staged[WS_PATH_MAX];
    wchar_t real[WS_PATH_MAX];
    int wrote = 0;
    int tracked = ws_cow_detach(hObject, staged, WS_PATH_MAX, real, WS_PATH_MAX, &wrote);
    BOOL ok = g_orig.CloseHandle ? g_orig.CloseHandle(hObject) : FALSE;
    DWORD lastErr = GetLastError();
    if (tracked && wrote == 0 && ws_cow_same_content(real, staged)) {
        if (ws_cow_delete_raw(staged)) {
            ws_log_w(L"CreateFileW zero-write revoke (deferred CoW copy removed)", staged);
            WS_TRACE_FILE("zero-write revoke removed the plaintext copy of %ls", real);
        }
    }
    SetLastError(lastErr);
    return ok;
}

BOOL WINAPI ws_WriteFile(HANDLE hFile, LPCVOID lpBuffer, DWORD nNumberOfBytesToWrite,
                         LPDWORD lpNumberOfBytesWritten, LPOVERLAPPED lpOverlapped)
{
    if (nNumberOfBytesToWrite > 0) {
        ws_cow_mark_written(hFile);
    }
    if (!g_orig.WriteFile) {
        return FALSE;
    }
    return g_orig.WriteFile(hFile, lpBuffer, nNumberOfBytesToWrite, lpNumberOfBytesWritten, lpOverlapped);
}

BOOL WINAPI ws_WriteFileEx(HANDLE hFile, LPCVOID lpBuffer, DWORD nNumberOfBytesToWrite,
                           LPOVERLAPPED lpOverlapped, LPOVERLAPPED_COMPLETION_ROUTINE lpCompletionRoutine)
{
    if (nNumberOfBytesToWrite > 0) {
        ws_cow_mark_written(hFile);
    }
    if (!g_orig.WriteFileEx) {
        return FALSE;
    }
    return g_orig.WriteFileEx(hFile, lpBuffer, nNumberOfBytesToWrite, lpOverlapped, lpCompletionRoutine);
}

BOOL WINAPI ws_SetEndOfFile(HANDLE hFile)
{
    ws_cow_mark_written(hFile);
    if (!g_orig.SetEndOfFile) {
        return FALSE;
    }
    return g_orig.SetEndOfFile(hFile);
}

BOOL WINAPI ws_SetFileInformationByHandle(HANDLE hFile, FILE_INFO_BY_HANDLE_CLASS FileInformationClass,
                                          LPVOID lpFileInformation, DWORD dwBufferSize)
{
    /* 保守：任何 SetFileInformationByHandle（截断/分配/改名/删除…）都按"有写入"处理，
     * 因此该句柄的 CoW 副本保留，绝不被零写撤销误删。 */
    ws_cow_mark_written(hFile);
    if (!g_orig.SetFileInformationByHandle) {
        return FALSE;
    }
    return g_orig.SetFileInformationByHandle(hFile, FileInformationClass, lpFileInformation, dwBufferSize);
}

/* ======================================================================== *
 *  R20 file-side hooks (R17 / R18 / R19)
 *
 *  R19 measured three file-side boundary holes that the IAT point-hook could
 *  not see because the names were absent from WS_TARGET:
 *    R18  hardlink alias: `mklink /H harmless.txt .npmrc` then reading the
 *         normal name returned the plaintext (the mask is a PATH blacklist);
 *    R19  directory enumeration leaked the masked file NAME/SIZE/TIME via
 *         cmd dir / Get-ChildItem / node readdir (FindFirstFile* was unhooked);
 *    R17  ReplaceFileW / NtCreateFile / CreateHardLink wrote the REAL disk.
 *
 *  Safety invariant for every hook below: the REAL system is never written.
 *  When the shim cannot stage / answer exactly, the call fails closed with
 *  ERROR_ACCESS_DENIED (Win32) or STATUS_ACCESS_DENIED (NTSTATUS), and the
 *  reason is logged. Read paths are the exception: an ordinary read that the
 *  mask does not deny is passed through, because breaking read semantics would
 *  kill every injected carrier (PowerShell/CLR/node).
 * ======================================================================== */

/* Implemented further down in this file (used by the R18/R17 helpers above the
 * main hook bodies): handle -> normalized path, staged path -> logical path. */
static int ws_path_of_handle(HANDLE h, wchar_t *out, DWORD cch);
static int ws_logical_from_staged(const wchar_t *norm, wchar_t *out, DWORD cch);
/* R21: whiteout->recreate helpers (defined further down, used by the hardlink
 * staging block above create_file_core). */
static int ws_logically_whiteouted(const wchar_t *norm);
static void ws_clear_whiteout(const wchar_t *norm);

/* ---------------------------------------------------------------- R18 ---- */
/* Thread-local guard for the hardlink enumeration itself.
 * `FindFirstFileNameW` opens the file internally; kernelbase's CreateFileW is
 * one of the IATs the hook engine patches, so that internal open CAN re-enter
 * ws_CreateFileW. While this flag is set the read/copy-up hardlink guards are
 * skipped, which makes that re-entry a bounded, single-level pass-through
 * instead of unbounded recursion. */
static _Thread_local int t_hlGuard;

/* "\Users\x" (volume-relative, FindFirstFileNameW form) -> "C:\Users\x". */
static int ws_path_from_volume_relative(const wchar_t *basePath, const wchar_t *volRel, wchar_t *out, DWORD cch)
{
    wchar_t volRoot[WS_PATH_MAX];
    out[0] = 0;
    if (!basePath || !basePath[0] || !volRel || !volRel[0]) {
        return 0;
    }
    if (!GetVolumePathNameW(basePath, volRoot, WS_PATH_MAX)) {
        return 0;
    }
    size_t n = wcslen(volRoot);
    /* drive root "C:\" -> "C:" so that "\Users" joins to "C:\Users" */
    if (n > 1 && volRoot[n - 1] == L'\\') {
        volRoot[n - 1] = 0;
    }
    size_t pos = 0;
    return ws_append_w(out, cch, &pos, volRoot) && ws_append_w(out, cch, &pos, volRel);
}

/* 1 = deny (a link name matches the read mask), 0 = allow,
 * -1 = the file has >1 link but its names cannot be enumerated (fail closed). */
static int ws_hardlink_alias_check_handle(HANDLE h, const wchar_t *path, wchar_t *outRule, DWORD outRuleCch)
{
    if (outRule && outRuleCch) {
        outRule[0] = 0;
    }
    if (!ws_mask_declared() || t_hlGuard || !h || h == INVALID_HANDLE_VALUE || !path || !path[0]) {
        return 0;
    }
    BY_HANDLE_FILE_INFORMATION bi;
    BOOL ok = g_orig.GetFileInformationByHandle ? g_orig.GetFileInformationByHandle(h, &bi)
                                                : GetFileInformationByHandle(h, &bi);
    if (!ok) {
        return 0; /* cannot even read the link count: leave the call alone */
    }
    if (bi.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
        return 0; /* directory link counts are not "hardlinks" */
    }
    if (bi.nNumberOfLinks <= 1) {
        return 0; /* the precise, cheap case: no aliases possible */
    }
    DWORD len = WS_PATH_MAX;
    wchar_t linkName[WS_PATH_MAX];
    linkName[0] = 0;
    t_hlGuard++;
    HANDLE f = FindFirstFileNameW(path, 0, &len, linkName);
    if (f == INVALID_HANDLE_VALUE) {
        t_hlGuard--;
        ws_log_w(L"read-deny: multi-link file but hardlink enumeration failed (fail-closed)", path);
        if (outRule && outRuleCch) {
            ws_strlcpy_w(outRule, L"<hardlink-enum-failed>", outRuleCch);
        }
        return -1;
    }
    int deny = 0;
    for (;;) {
        wchar_t full[WS_PATH_MAX];
        wchar_t rule[256];
        if (ws_path_from_volume_relative(path, linkName, full, WS_PATH_MAX) &&
            ws_mask_decide_read(full, rule, 256)) {
            deny = 1;
            if (outRule && outRuleCch) {
                ws_strlcpy_w(outRule, rule, outRuleCch);
            }
            ws_log_w(L"read-deny: hardlink alias matches read mask", full);
            break;
        }
        DWORD len2 = WS_PATH_MAX;
        if (!FindNextFileNameW(f, &len2, linkName)) {
            break;
        }
    }
    if (!FindClose(f)) { /* nothing sensible to do on close failure */ }
    t_hlGuard--;
    return deny;
}

/* Same guard for a path: opens the REAL file (captured original, never the
 * hook) with zero-desired-access, checks, closes. Used by paths that so far
 * have no handle (copy-up / CopyFile / move materialize). */
static int ws_path_hardlink_alias_masked(const wchar_t *realPath, wchar_t *outRule, DWORD outRuleCch)
{
    if (outRule && outRuleCch) {
        outRule[0] = 0;
    }
    if (!ws_mask_declared() || t_hlGuard || !realPath || !realPath[0] || !g_orig.CreateFileW) {
        return 0;
    }
    HANDLE h = g_orig.CreateFileW(realPath, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                  NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        return 0;
    }
    int r = ws_hardlink_alias_check_handle(h, realPath, outRule, outRuleCch);
    if (g_orig.CloseHandle) {
        g_orig.CloseHandle(h);
    }
    return r;
}

/* ---------------------------------------------------------------- R19 ---- */
/* Directory-enumeration filter. FindFirstFile* returns the first entry; if it
 * is masked we walk FindNextFile* until a visible entry or the end, then hand
 * the caller a handle whose next entry (and all following ones) are filtered
 * the same way. The directory behind each live handle is kept in a small
 * side table so FindNextFile* can rebuild "dir\name" and re-run the SAME mask
 * decision the read/open hooks use; FindClose drops the entry. */
#define WS_FIND_MAX_TRACKED 128
typedef struct WsFindEntry {
    HANDLE handle;
    wchar_t dir[WS_PATH_MAX];
} WsFindEntry;

static WsFindEntry g_findTracked[WS_FIND_MAX_TRACKED];
static WsLock g_findLock;
static INIT_ONCE g_findOnce = INIT_ONCE_STATIC_INIT;
static volatile LONG g_findTrackedCount;
static volatile LONG g_findTableFullLogged;

static BOOL CALLBACK ws_find_lock_once(PINIT_ONCE once, PVOID param, PVOID *ctx)
{
    (void)once;
    (void)param;
    (void)ctx;
    ws_lock_init(&g_findLock, "find");
    return TRUE;
}
static void ws_find_ready(void)
{
    InitOnceExecuteOnce(&g_findOnce, ws_find_lock_once, NULL, NULL);
}

static void ws_find_register(HANDLE h, const wchar_t *dir)
{
    if (!h || h == INVALID_HANDLE_VALUE || !dir || !dir[0]) {
        return;
    }
    ws_find_ready();
    ws_lock_enter(&g_findLock);
    for (int i = 0; i < WS_FIND_MAX_TRACKED; i++) {
        if (!g_findTracked[i].handle) {
            g_findTracked[i].handle = h;
            ws_strlcpy_w(g_findTracked[i].dir, dir, WS_PATH_MAX);
            InterlockedIncrement(&g_findTrackedCount);
            ws_lock_leave(&g_findLock);
            return;
        }
    }
    ws_lock_leave(&g_findLock);
    if (InterlockedExchange(&g_findTableFullLogged, 1) == 0) {
        ws_log("find filter table full (%d); enumeration of the newest handle is NOT filtered", WS_FIND_MAX_TRACKED);
    }
}

static int ws_find_lookup(HANDLE h, wchar_t *dir, DWORD cch)
{
    if (!h || h == INVALID_HANDLE_VALUE || InterlockedCompareExchange(&g_findTrackedCount, 0, 0) == 0) {
        return 0;
    }
    int found = 0;
    ws_find_ready();
    ws_lock_enter(&g_findLock);
    for (int i = 0; i < WS_FIND_MAX_TRACKED; i++) {
        if (g_findTracked[i].handle == h) {
            ws_strlcpy_w(dir, g_findTracked[i].dir, cch);
            found = 1;
            break;
        }
    }
    ws_lock_leave(&g_findLock);
    return found;
}

static void ws_find_unregister(HANDLE h)
{
    if (!h || h == INVALID_HANDLE_VALUE || InterlockedCompareExchange(&g_findTrackedCount, 0, 0) == 0) {
        return;
    }
    ws_find_ready();
    ws_lock_enter(&g_findLock);
    for (int i = 0; i < WS_FIND_MAX_TRACKED; i++) {
        if (g_findTracked[i].handle == h) {
            memset(&g_findTracked[i], 0, sizeof(g_findTracked[i]));
            InterlockedDecrement(&g_findTrackedCount);
            break;
        }
    }
    ws_lock_leave(&g_findLock);
}

static BOOL ws_find_orig_close(HANDLE h)
{
    return g_orig.FindClose ? g_orig.FindClose(h) : FindClose(h);
}

/* Directory part of a find pattern, normalized. Returns 0 when this pattern is
 * not filtered (mask undeclared, out-of-scope stage/passthrough tree, no
 * directory component, or a wildcard in the DIRECTORY component: rebuilding
 * "dir\name" would then be a guess, so filtering is skipped and the caller
 * keeps the real API's answer). */
static int ws_find_dir_of_pattern_w(const wchar_t *pattern, wchar_t *dir, DWORD cch)
{
    wchar_t full[WS_PATH_MAX];
    wchar_t norm[WS_PATH_MAX];
    dir[0] = 0;
    if (!ws_mask_declared() || !pattern || !pattern[0]) {
        return 0;
    }
    DWORD err = GetLastError();
    DWORD n = GetFullPathNameW(pattern, WS_PATH_MAX, full, NULL);
    SetLastError(err);
    if (n == 0 || n >= WS_PATH_MAX) {
        return 0;
    }
    if (!ws_normalize_path(full, norm, WS_PATH_MAX)) {
        return 0;
    }
    if (g_ws.haveStageRoot) {
        if (ws_under_prefix(norm, g_ws.stageRoot)) {
            return 0;
        }
        for (int i = 0; i < g_ws.passthroughCount; i++) {
            if (ws_under_prefix(norm, g_ws.passthrough[i])) {
                return 0;
            }
        }
    }
    const wchar_t *last = wcsrchr(norm, L'\\');
    if (!last || last == norm) {
        return 0; /* no directory component ("*" / "\*") or drive-less name */
    }
    size_t nDir = (size_t)(last - norm);
    if (nDir + 1 > cch) {
        return 0;
    }
    wchar_t cand[WS_PATH_MAX];
    memcpy(cand, norm, nDir * sizeof(wchar_t));
    cand[nDir] = 0;
    if (wcschr(cand, L'*') || wcschr(cand, L'?')) {
        return 0;
    }
    ws_strlcpy_w(dir, cand, cch);
    return 1;
}

/* Does "dir\name" (the entry the real API just returned) match a read-mask
 * rule? Overflow => deny (never leak an entry because a path was too long). */
static int ws_find_entry_masked(const wchar_t *dir, const wchar_t *name, wchar_t *outRule, DWORD outRuleCch)
{
    wchar_t full[WS_PATH_MAX];
    size_t pos = 0;
    full[0] = 0;
    if (!ws_append_w(full, WS_PATH_MAX, &pos, dir)) {
        return 1;
    }
    if (!(pos > 0 && full[pos - 1] == L'\\')) {
        if (!ws_append_w(full, WS_PATH_MAX, &pos, L"\\")) {
            return 1;
        }
    }
    if (!ws_append_w(full, WS_PATH_MAX, &pos, name)) {
        return 1;
    }
    return ws_mask_decide_read(full, outRule, outRuleCch);
}

/* ---------------------------------------------------------------- R17 ---- */
/* R17 CreateHardLink: staging semantics.
 *
 * A hardlink is a WRITE (a new directory entry / link count). Doing it on the
 * real disk while sandboxed violates the staging invariant, and the link can
 * also alias a masked file (R18). Policy:
 *   · source or destination masked           -> fail closed (ERROR_ACCESS_DENIED);
 *   · source file has a masked hardlink alias -> fail closed (precise R18 rule);
 *   · otherwise both sides are moved into the overlay: the real source content
 *     is materialized under the staging tree when needed, then the link is
 *     created between the two STAGED paths (no real disk write at all).
 * Result is an NTSTATUS so NtSetInformationFile(FileLinkInformation) can share
 * the same core. */
#define WS_R20_STATUS_OBJECT_NAME_COLLISION ((NTSTATUS)0xC0000035L)
#define WS_R20_STATUS_OBJECT_NAME_NOT_FOUND ((NTSTATUS)0xC0000034L)
#define WS_R20_STATUS_ACCESS_DENIED        ((NTSTATUS)0xC0000022L)
#define WS_R20_STATUS_NOT_SUPPORTED        ((NTSTATUS)0xC00000BBL)
#define WS_R20_STATUS_INVALID_PARAMETER    ((NTSTATUS)0xC000000DL)

static NTSTATUS ws_hardlink_stage(const wchar_t *srcNorm, const wchar_t *dstNorm, int replaceIfExists)
{
    wchar_t stagedSrc[WS_PATH_MAX];
    wchar_t stagedDst[WS_PATH_MAX];
    uint32_t fSrc = 0;
    uint32_t fDst = 0;
    if (ws_mask_declared()) {
        wchar_t rule[256];
        if (ws_mask_decide_read(srcNorm, rule, 256)) {
            ws_log_w(L"fail-closed CreateHardLink: masked source", srcNorm);
            return WS_R20_STATUS_ACCESS_DENIED;
        }
        if (ws_mask_decide_read(dstNorm, rule, 256)) {
            ws_log_w(L"fail-closed CreateHardLink: masked destination", dstNorm);
            return WS_R20_STATUS_ACCESS_DENIED;
        }
        if (ws_path_hardlink_alias_masked(srcNorm, rule, 256) != 0) {
            ws_log_w(L"fail-closed CreateHardLink: source has a masked hardlink alias", srcNorm);
            return WS_R20_STATUS_ACCESS_DENIED;
        }
    }
    if (ws_resolve_file(srcNorm, WINSTAGE_IO_READ, stagedSrc, &fSrc) != 0) {
        return WS_R20_STATUS_ACCESS_DENIED;
    }
    if (fSrc & WINSTAGE_RES_WHITEOUT) {
        return WS_R20_STATUS_OBJECT_NAME_NOT_FOUND;
    }
    if (ws_resolve_file(dstNorm, WINSTAGE_IO_WRITE, stagedDst, &fDst) != 0) {
        return WS_R20_STATUS_ACCESS_DENIED;
    }
    int srcStaged = (fSrc & WINSTAGE_RES_STAGED) != 0;
    int dstStagedExists = ws_file_exists(stagedDst);
    int dstRealExists = ws_file_exists(dstNorm);
    if (replaceIfExists) {
        if (dstStagedExists) {
            t_wsFileBusy++;
            if (g_orig.DeleteFileW) g_orig.DeleteFileW(stagedDst);
            t_wsFileBusy--;
        }
    } else if (dstStagedExists || dstRealExists) {
        return WS_R20_STATUS_OBJECT_NAME_COLLISION;
    }
    wchar_t linkSource[WS_PATH_MAX];
    if (srcStaged) {
        ws_strlcpy_w(linkSource, stagedSrc, WS_PATH_MAX);
    } else {
        if (!ws_file_exists(srcNorm)) {
            return WS_R20_STATUS_OBJECT_NAME_NOT_FOUND;
        }
        if (!ws_ensure_dirs(stagedSrc, 0)) {
            return WS_R20_STATUS_ACCESS_DENIED;
        }
        if (!ws_file_exists(stagedSrc)) {
            /* materialize into the overlay so the link is a link between two
             * STAGED names: the real file's link count / directory is untouched */
            t_wsFileBusy++;
            BOOL copied = g_orig.CopyFileW ? g_orig.CopyFileW(srcNorm, stagedSrc, FALSE) : FALSE;
            t_wsFileBusy--;
            if (!copied) {
                ws_log_w(L"fail-closed CreateHardLink (source materialize failed)", srcNorm);
                return WS_R20_STATUS_ACCESS_DENIED;
            }
        }
        ws_strlcpy_w(linkSource, stagedSrc, WS_PATH_MAX);
    }
    if (!g_orig.CreateHardLinkW) {
        return WS_R20_STATUS_NOT_SUPPORTED;
    }
    t_wsFileBusy++; /* kernelbase's CreateHardLinkW reaches NtSetInformationFile internally */
    BOOL ok = g_orig.CreateHardLinkW(stagedDst, linkSource, NULL);
    DWORD err = GetLastError();
    t_wsFileBusy--;
    if (!ok) {
        switch (err) {
        case ERROR_FILE_EXISTS:
        case ERROR_ALREADY_EXISTS:
            return WS_R20_STATUS_OBJECT_NAME_COLLISION;
        case ERROR_FILE_NOT_FOUND:
            return WS_R20_STATUS_OBJECT_NAME_NOT_FOUND;
        default:
            return WS_R20_STATUS_ACCESS_DENIED;
        }
    }
    ws_clear_whiteout(dstNorm); /* R21: linking onto a logically-deleted path recreates it */
    ws_log_w(L"CreateHardLink staged", stagedDst);
    return 0;
}

/* Win32 wrapper body for both the ANSI/WIDE entry points. */
static BOOL ws_create_hardlink_core(LPCWSTR link, LPCWSTR existing)
{
    wchar_t normLink[WS_PATH_MAX];
    wchar_t normExisting[WS_PATH_MAX];
    if (!link || !link[0] || !existing || !existing[0]) {
        SetLastError(ERROR_INVALID_PARAMETER);
        return FALSE;
    }
    int iLink = ws_should_intercept(link, normLink, WS_PATH_MAX);
    int iExisting = ws_should_intercept(existing, normExisting, WS_PATH_MAX);
    if (!iLink && !iExisting) {
        if (!g_orig.CreateHardLinkW) {
            SetLastError(ERROR_NOT_SUPPORTED);
            return FALSE;
        }
        return g_orig.CreateHardLinkW(link, existing, NULL);
    }
    if (iLink != iExisting) {
        /* one side is stage/passthrough and the other is not: half in scope,
         * cannot stage atomically -> never write the real disk */
        ws_log_w(L"fail-closed CreateHardLink (half in scope)", iLink ? link : existing);
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    NTSTATUS st = ws_hardlink_stage(normExisting, normLink, 0);
    if (st < 0) {
        SetLastError(st == WS_R20_STATUS_OBJECT_NAME_COLLISION ? ERROR_ALREADY_EXISTS
                    : st == WS_R20_STATUS_OBJECT_NAME_NOT_FOUND ? ERROR_FILE_NOT_FOUND
                                                               : ERROR_ACCESS_DENIED);
        return FALSE;
    }
    return TRUE;
}

/* R17 ReplaceFileW / ReplaceFileA: fail closed.
 *
 * ReplaceFile is an atomic 3-path transaction (replaced target + replacement +
 * optional backup). Mapping it onto the overlay needs multi-file whiteout +
 * rename journaling; the risk of a half-applied replacement is higher than the
 * benefit, so the agreed R20 policy is FAIL-CLOSED: the real system is never
 * written (measured before/after with the native carrier, see findings).
 * Calls whose every path is out of the shim's scope pass through unchanged. */
static BOOL ws_replace_file_locked(LPCWSTR replaced, LPCWSTR replacement, LPCWSTR backup, DWORD flags,
                                   LPVOID exclude, LPVOID reserved)
{
    wchar_t normReplaced[WS_PATH_MAX];
    wchar_t normReplacement[WS_PATH_MAX];
    wchar_t normBackup[WS_PATH_MAX];
    if (!replaced || !replaced[0] || !replacement || !replacement[0]) {
        SetLastError(ERROR_INVALID_PARAMETER);
        return FALSE;
    }
    int i1 = ws_should_intercept(replaced, normReplaced, WS_PATH_MAX);
    int i2 = ws_should_intercept(replacement, normReplacement, WS_PATH_MAX);
    int i3 = (backup && backup[0]) ? ws_should_intercept(backup, normBackup, WS_PATH_MAX) : 0;
    if (!i1 && !i2 && !i3) {
        return g_orig.ReplaceFileW ? g_orig.ReplaceFileW(replaced, replacement, backup, flags, exclude, reserved)
                                   : ReplaceFileW(replaced, replacement, backup, flags, exclude, reserved);
    }
    ws_log_w(L"fail-closed ReplaceFileW (real-disk zero-write; no staging model)", replaced);
    SetLastError(ERROR_ACCESS_DENIED);
    return FALSE;
}

/* Extract a Win32 normalized path from an OBJECT_ATTRIBUTES (NT name form).
 * Mirrors ws_attrbyname_overlay's measured constraints: copy by Length (the
 * buffer is not guaranteed NUL-terminated), strip `\??\` first, never guess an
 * unrepresentable NT namespace name. Returns 0 when not trustworthy. */
static int ws_nt_path_from_object(POBJECT_ATTRIBUTES oa, wchar_t *out, DWORD cch)
{
    out[0] = 0;
    if (!oa || !oa->ObjectName || !oa->ObjectName->Buffer || oa->ObjectName->Length == 0) {
        return 0;
    }
    const UNICODE_STRING *us = oa->ObjectName;
    if (us->Length > (ULONG)((WS_PATH_MAX - 1) * sizeof(wchar_t))) {
        return 0;
    }
    wchar_t nz[WS_PATH_MAX];
    size_t n = (size_t)(us->Length / sizeof(wchar_t));
    memcpy(nz, us->Buffer, n * sizeof(wchar_t));
    nz[n] = 0;
    if (ws_starts_with_ci_w(nz, L"\\??\\UNC\\")) {
        size_t len = wcslen(nz + 8);
        nz[0] = nz[1] = L'\\';
        memmove(nz + 2, nz + 8, (len + 1) * sizeof(wchar_t));
    } else if (ws_starts_with_ci_w(nz, L"\\??\\") &&
               ((nz[4] >= L'A' && nz[4] <= L'Z') || (nz[4] >= L'a' && nz[4] <= L'z')) &&
               nz[5] == L':' && (nz[6] == L'\\' || nz[6] == L'/' || nz[6] == 0)) {
        size_t len = wcslen(nz + 4);
        memmove(nz, nz + 4, (len + 1) * sizeof(wchar_t));
    }
    if (ws_starts_with_ci_w(nz, L"\\Device\\") || ws_starts_with_ci_w(nz, L"\\\\.\\") ||
        ws_starts_with_ci_w(nz, L"\\??\\") || ws_starts_with_ci_w(nz, L"\\\\?\\GLOBALROOT") ||
        ws_starts_with_ci_w(nz, L"\\\\?\\Volume{") || ws_starts_with_ci_w(nz, L"\\SystemRoot") ||
        ws_starts_with_ci_w(nz, L"\\DosDevices\\")) {
        /* R20 FOLLOW-UP（P0）：NT 命名空间/设备别名先尝试映射成普通 Win32 路径。
         * 映射成功后与普通调用走完全相同的暂存/遮蔽/delete 管线；映射不了的名字
         * 仍返回 0，由 ws_NtCreateFile 按「写/删 deny、mask 声明时读 deny」处理。 */
        wchar_t conv[WS_PATH_MAX];
        if (ws_nt_device_to_win(nz, conv, WS_PATH_MAX)) {
            ws_strlcpy_w(nz, conv, WS_PATH_MAX);
        } else {
            return 0;
        }
    }
    wchar_t abs[WS_PATH_MAX];
    DWORD err = GetLastError();
    DWORD got = GetFullPathNameW(nz, WS_PATH_MAX, abs, NULL);
    SetLastError(err);
    if (got == 0 || got >= WS_PATH_MAX) {
        ws_strlcpy_w(abs, nz, WS_PATH_MAX);
    }
    return ws_normalize_path(abs, out, cch);
}

/* Win32 path -> NT object path (only the two shapes the object manager accepts
 * for a RootDirectory==NULL open: `\??\X:\...` and `\??\UNC\...`). */
static int ws_nt_path_from_win(const wchar_t *win, wchar_t *out, DWORD cch)
{
    size_t pos = 0;
    out[0] = 0;
    if (!win || !win[0]) {
        return 0;
    }
    if (ws_starts_with_ci_w(win, L"\\??\\")) {
        return ws_append_w(out, cch, &pos, win);
    }
    if (win[0] == L'\\' && win[1] == L'\\' && win[2] && win[2] != L'?' && win[2] != L'.') {
        return ws_append_w(out, cch, &pos, L"\\??\\UNC\\") && ws_append_w(out, cch, &pos, win + 2);
    }
    if (((win[0] >= L'A' && win[0] <= L'Z') || (win[0] >= L'a' && win[0] <= L'z')) &&
        win[1] == L':' && win[2] == L'\\') {
        return ws_append_w(out, cch, &pos, L"\\??\\") && ws_append_w(out, cch, &pos, win);
    }
    return 0;
}

/* R17 NtCreateFile: direct NT create. Only USER modules' IATs carry this hook
 * (core modules are excluded by the hook engine), so this is the "native code
 * bypasses CreateFileW staging" surface. Policy:
 *   · write intent (write access bits / DELETE / FILE_CREATE / FILE_OVERWRITE /
 *     FILE_SUPERSEDE / FILE_DELETE_ON_CLOSE, or a maybe-create disposition on a
 *     path that does not exist) => fail closed with STATUS_ACCESS_DENIED: the
 *     real disk is never written;
 *   · masked path (read OR write) => STATUS_ACCESS_DENIED (same read boundary
 *     as every other read hook);
 *   · plain read intent => pass through, overlay-aware (whiteout => not found,
 *     staged copy => open the staged path instead), and the multi-link alias
 *     guard is applied on the opened handle (R18). This is what keeps carriers
 *     that statically import ntdll!NtCreateFile alive. */
static int ws_nt_create_write_intent(ACCESS_MASK access, ULONG disposition, ULONG options)
{
    if (access & (GENERIC_WRITE | GENERIC_ALL | FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA |
                  FILE_WRITE_ATTRIBUTES | DELETE | WRITE_DAC | WRITE_OWNER | FILE_DELETE_CHILD)) {
        return 1;
    }
    if (options & 0x00001000u /* FILE_DELETE_ON_CLOSE */) {
        return 1;
    }
    switch (disposition) {
    case 0: /* FILE_SUPERSEDE */
    case 2: /* FILE_CREATE */
    case 4: /* FILE_OVERWRITE */
    case 5: /* FILE_OVERWRITE_IF */
        return 1;
    default:
        return 0;
    }
}

NTSTATUS NTAPI ws_NtCreateFile(PHANDLE FileHandle, ACCESS_MASK DesiredAccess, POBJECT_ATTRIBUTES ObjectAttributes,
                               PIO_STATUS_BLOCK IoStatusBlock, PVOID AllocationSize, ULONG FileAttributes,
                               ULONG ShareAccess, ULONG CreateDisposition, ULONG CreateOptions,
                               PVOID EaBuffer, ULONG EaLength)
{
    ws_callhit_named("NtCreateFile");
    if (t_wsFileBusy || !ObjectAttributes || !ObjectAttributes->ObjectName ||
        !ObjectAttributes->ObjectName->Buffer) {
        return g_orig.NtCreateFile(FileHandle, DesiredAccess, ObjectAttributes, IoStatusBlock, AllocationSize,
                                   FileAttributes, ShareAccess, CreateDisposition, CreateOptions, EaBuffer,
                                   EaLength);
    }
    int writeIntent = ws_nt_create_write_intent(DesiredAccess, CreateDisposition, CreateOptions);
    if (ObjectAttributes->RootDirectory) {
        /* handle-relative name: the target cannot be proven -> never write; with the
         * read mask active it could also read a masked file through its directory
         * handle, so reads are denied too (A+B hybrid fallback, see findings §6.3). */
        if (writeIntent || ws_mask_declared()) {
            ws_log("fail-closed NtCreateFile: handle-relative target (unmappable)");
            if (IoStatusBlock) {
                IoStatusBlock->Status = WS_R20_STATUS_ACCESS_DENIED;
                IoStatusBlock->Information = 0;
            }
            return WS_R20_STATUS_ACCESS_DENIED;
        }
        return g_orig.NtCreateFile(FileHandle, DesiredAccess, ObjectAttributes, IoStatusBlock, AllocationSize,
                                   FileAttributes, ShareAccess, CreateDisposition, CreateOptions, EaBuffer,
                                   EaLength);
    }
    wchar_t norm[WS_PATH_MAX];
    if (!ws_nt_path_from_object(ObjectAttributes, norm, WS_PATH_MAX)) {
        /* R20 FOLLOW-UP（P0）A+B 混合兜底：设备/卷命名空间里**映射不了**的名字
         * （\\.\PhysicalDriveN、未知 \Device\…、\??\… 等）无法走暂存/遮蔽管线。
         * 写/删一律 deny（永不写真实盘）；mask 已声明时读也 deny（否则可用设备
         * 路径读回被遮蔽文件明文）。未声明 mask 且纯读时维持透传（兼容探测类调用）。 */
        if (ws_is_nt_alias_oa(ObjectAttributes) && (writeIntent || ws_mask_declared())) {
            ws_log("fail-closed NtCreateFile: unmappable NT-namespace name (write or mask-read)");
            if (IoStatusBlock) {
                IoStatusBlock->Status = WS_R20_STATUS_ACCESS_DENIED;
                IoStatusBlock->Information = 0;
            }
            return WS_R20_STATUS_ACCESS_DENIED;
        }
        return g_orig.NtCreateFile(FileHandle, DesiredAccess, ObjectAttributes, IoStatusBlock, AllocationSize,
                                   FileAttributes, ShareAccess, CreateDisposition, CreateOptions, EaBuffer,
                                   EaLength);
    }
    if (!ws_should_intercept(norm, norm, WS_PATH_MAX)) {
        /* explicit stage-root / passthrough scope */
        return g_orig.NtCreateFile(FileHandle, DesiredAccess, ObjectAttributes, IoStatusBlock, AllocationSize,
                                   FileAttributes, ShareAccess, CreateDisposition, CreateOptions, EaBuffer,
                                   EaLength);
    }
    if (ws_mask_declared()) {
        wchar_t rule[256];
        if (ws_mask_decide_read(norm, rule, 256)) {
            ws_log_w(L"read/write denied by mask (NtCreateFile)", norm);
            if (IoStatusBlock) {
                IoStatusBlock->Status = WS_R20_STATUS_ACCESS_DENIED;
                IoStatusBlock->Information = 0;
            }
            return WS_R20_STATUS_ACCESS_DENIED;
        }
    }
    if (!writeIntent && CreateDisposition == 3 /* FILE_OPEN_IF: create-if-missing */) {
        wchar_t mapped[WS_PATH_MAX];
        uint32_t flags = 0;
        int have = ws_resolve_file(norm, WINSTAGE_IO_READ, mapped, &flags) == 0;
        if (!have || (flags & WINSTAGE_RES_WHITEOUT) || !ws_file_exists(mapped)) {
            /* this "read" would CREATE a real file -> not stageable */
            ws_log_w(L"fail-closed NtCreateFile (FILE_OPEN_IF would create)", norm);
            if (IoStatusBlock) {
                IoStatusBlock->Status = WS_R20_STATUS_ACCESS_DENIED;
                IoStatusBlock->Information = 0;
            }
            return WS_R20_STATUS_ACCESS_DENIED;
        }
    }
    if (writeIntent) {
        ws_log_w(L"fail-closed NtCreateFile (write intent; real-disk zero-write)", norm);
        if (g_ws.auditPath[0]) {
            char esc[WS_PATH_MAX * 3];
            ws_audit_escape_w(norm, esc, sizeof(esc));
            ws_audit("{\"op\":\"file.ntcreate\",\"mode\":\"write\",\"decision\":\"deny\",\"path\":\"%s\"}", esc);
        }
        if (IoStatusBlock) {
            IoStatusBlock->Status = WS_R20_STATUS_ACCESS_DENIED;
            IoStatusBlock->Information = 0;
        }
        return WS_R20_STATUS_ACCESS_DENIED;
    }
    /* Plain read intent: honour the overlay exactly like ws_create_file_core's
     * read branch (whiteout -> not found; staged copy -> open the overlay path). */
    wchar_t mapped[WS_PATH_MAX];
    uint32_t flags = 0;
    if (ws_resolve_file(norm, WINSTAGE_IO_READ, mapped, &flags) == 0) {
        if (flags & WINSTAGE_RES_WHITEOUT) {
            if (IoStatusBlock) {
                IoStatusBlock->Status = WS_R20_STATUS_OBJECT_NAME_NOT_FOUND;
                IoStatusBlock->Information = 0;
            }
            return WS_R20_STATUS_OBJECT_NAME_NOT_FOUND;
        }
        if ((flags & WINSTAGE_RES_STAGED) && ws_wcscmp_ci(mapped, norm) != 0) {
            wchar_t nt[WS_PATH_MAX];
            if (ws_nt_path_from_win(mapped, nt, WS_PATH_MAX)) {
                OBJECT_ATTRIBUTES oa = *ObjectAttributes;
                UNICODE_STRING un;
                un.Buffer = nt;
                un.Length = (USHORT)(wcslen(nt) * sizeof(wchar_t));
                un.MaximumLength = (USHORT)(un.Length + sizeof(wchar_t));
                oa.ObjectName = &un;
                oa.RootDirectory = NULL;
                NTSTATUS st = g_orig.NtCreateFile(FileHandle, DesiredAccess, &oa, IoStatusBlock, AllocationSize,
                                                  FileAttributes, ShareAccess, CreateDisposition, CreateOptions,
                                                  EaBuffer, EaLength);
                ws_log_w(st < 0 ? L"NtCreateFile overlay(read) FAILED" : L"NtCreateFile overlay(read)", mapped);
                return st;
            }
        }
    }
    NTSTATUS st = g_orig.NtCreateFile(FileHandle, DesiredAccess, ObjectAttributes, IoStatusBlock, AllocationSize,
                                      FileAttributes, ShareAccess, CreateDisposition, CreateOptions, EaBuffer,
                                      EaLength);
    if (st >= 0 && FileHandle && *FileHandle && !t_hlGuard && ws_mask_declared()) {
        wchar_t rule[256];
        if (ws_hardlink_alias_check_handle(*FileHandle, norm, rule, 256) != 0) {
            if (g_orig.CloseHandle) g_orig.CloseHandle(*FileHandle);
            *FileHandle = NULL;
            if (IoStatusBlock) {
                IoStatusBlock->Status = WS_R20_STATUS_ACCESS_DENIED;
                IoStatusBlock->Information = 0;
            }
            return WS_R20_STATUS_ACCESS_DENIED;
        }
    }
    return st;
}

/* NtSetInformationFile(FileLinkInformation=11): create a hardlink through a
 * source handle. Shares ws_hardlink_stage (mask + staged semantics) so the
 * `mklink`-equivalent cannot write the real disk nor link a masked file. */
static NTSTATUS ws_nt_set_file_link(HANDLE FileHandle, PIO_STATUS_BLOCK IoStatusBlock, PVOID FileInformation,
                                    ULONG Length)
{
    if (!FileInformation || Length < sizeof(FILE_LINK_INFORMATION)) {
        return WS_R20_STATUS_INVALID_PARAMETER;
    }
    PFILE_LINK_INFORMATION li = (PFILE_LINK_INFORMATION)FileInformation;
    if (li->FileNameLength == 0 || li->FileNameLength > (ULONG)((WS_PATH_MAX - 1) * sizeof(wchar_t))) {
        return WS_R20_STATUS_INVALID_PARAMETER;
    }
    wchar_t srcPath[WS_PATH_MAX];
    wchar_t srcNorm[WS_PATH_MAX];
    if (!ws_path_of_handle(FileHandle, srcPath, WS_PATH_MAX)) {
        return WS_R20_STATUS_ACCESS_DENIED;
    }
    wchar_t logical[WS_PATH_MAX];
    int srcIsStagedCopy = 0;
    if (ws_should_intercept(srcPath, srcNorm, WS_PATH_MAX)) {
        /* handle opened on the real path */
    } else if (ws_logical_from_staged(srcPath, logical, WS_PATH_MAX) &&
               ws_should_intercept(logical, srcNorm, WS_PATH_MAX)) {
        srcIsStagedCopy = 1;
    } else {
        return g_orig.NtSetInformationFile(FileHandle, IoStatusBlock, FileInformation, Length, 11);
    }
    wchar_t nameBuf[WS_PATH_MAX];
    size_t nameCch = (size_t)(li->FileNameLength / sizeof(wchar_t));
    if (nameCch >= WS_PATH_MAX) {
        return WS_R20_STATUS_INVALID_PARAMETER;
    }
    memcpy(nameBuf, li->FileName, nameCch * sizeof(wchar_t));
    nameBuf[nameCch] = 0;
    wchar_t dstRaw[WS_PATH_MAX];
    if (li->RootDirectory) {
        wchar_t dirPath[WS_PATH_MAX];
        if (!ws_path_of_handle(li->RootDirectory, dirPath, WS_PATH_MAX)) {
            return WS_R20_STATUS_ACCESS_DENIED;
        }
        wchar_t joined[WS_PATH_MAX];
        size_t pos = 0;
        joined[0] = 0;
        if (!ws_append_w(joined, WS_PATH_MAX, &pos, dirPath)) {
            return WS_R20_STATUS_ACCESS_DENIED;
        }
        if (!(pos > 0 && joined[pos - 1] == L'\\') &&
            !ws_append_w(joined, WS_PATH_MAX, &pos, L"\\")) {
            return WS_R20_STATUS_ACCESS_DENIED;
        }
        if (!ws_append_w(joined, WS_PATH_MAX, &pos, nameBuf[0] == L'\\' ? nameBuf + 1 : nameBuf)) {
            return WS_R20_STATUS_ACCESS_DENIED;
        }
        ws_strlcpy_w(dstRaw, joined, WS_PATH_MAX);
    } else {
        wchar_t abs[WS_PATH_MAX];
        wchar_t oaName[WS_PATH_MAX];
        if (ws_starts_with_ci_w(nameBuf, L"\\??\\")) {
            OBJECT_ATTRIBUTES oa;
            UNICODE_STRING un;
            memset(&oa, 0, sizeof(oa));
            oa.Length = sizeof(oa);
            un.Buffer = nameBuf;
            un.Length = (USHORT)(nameCch * sizeof(wchar_t));
            un.MaximumLength = (USHORT)(un.Length + sizeof(wchar_t));
            oa.ObjectName = &un;
            if (!ws_nt_path_from_object(&oa, oaName, WS_PATH_MAX)) {
                return WS_R20_STATUS_ACCESS_DENIED;
            }
        } else {
            ws_strlcpy_w(oaName, nameBuf, WS_PATH_MAX);
        }
        if (!ws_should_intercept(oaName, abs, WS_PATH_MAX)) {
            /* destination outside the staged view but source inside: half in scope */
            return WS_R20_STATUS_ACCESS_DENIED;
        }
        ws_strlcpy_w(dstRaw, abs, WS_PATH_MAX);
    }
    wchar_t dstNorm[WS_PATH_MAX];
    if (!ws_should_intercept(dstRaw, dstNorm, WS_PATH_MAX)) {
        return WS_R20_STATUS_ACCESS_DENIED;
    }
    if (ws_mask_declared()) {
        wchar_t rule[256];
        if (ws_mask_decide_read(srcNorm, rule, 256) || ws_mask_decide_read(dstNorm, rule, 256)) {
            ws_log_w(L"fail-closed NtSetInformationFile(link): masked source or destination", dstNorm);
            return WS_R20_STATUS_ACCESS_DENIED;
        }
        if (!srcIsStagedCopy && ws_hardlink_alias_check_handle(FileHandle, srcPath, rule, 256) != 0) {
            return WS_R20_STATUS_ACCESS_DENIED;
        }
    }
    NTSTATUS st = ws_hardlink_stage(srcNorm, dstNorm, li->ReplaceIfExists ? 1 : 0);
    if (IoStatusBlock) {
        IoStatusBlock->Status = st;
        IoStatusBlock->Information = 0;
    }
    if (st < 0) {
        ws_log_w(L"fail-closed NtSetInformationFile(link)", dstNorm);
    }
    return st;
}

/* Keep the linker honest about ws_ReplaceFileA even though the body is shared. */

/* ---------------------------------------------------------- R17/R18 entry points */

BOOL WINAPI ws_CreateHardLinkW(LPCWSTR lpFileName, LPCWSTR lpExistingFileName, LPSECURITY_ATTRIBUTES lpSecurityAttributes)
{
    (void)lpSecurityAttributes;
    return ws_create_hardlink_core(lpFileName, lpExistingFileName);
}

BOOL WINAPI ws_CreateHardLinkA(LPCSTR lpFileName, LPCSTR lpExistingFileName, LPSECURITY_ATTRIBUTES lpSecurityAttributes)
{
    (void)lpSecurityAttributes;
    wchar_t link[WS_PATH_MAX];
    wchar_t existing[WS_PATH_MAX];
    ws_a2w_buf(lpFileName, link, WS_PATH_MAX);
    ws_a2w_buf(lpExistingFileName, existing, WS_PATH_MAX);
    return ws_create_hardlink_core(link[0] ? link : NULL, existing[0] ? existing : NULL);
}

BOOL WINAPI ws_ReplaceFileW(LPCWSTR lpReplacedFileName, LPCWSTR lpReplacementFileName,
                            LPCWSTR lpBackupFileName, DWORD dwReplaceFlags, LPVOID lpExclude, LPVOID lpReserved)
{
    return ws_replace_file_locked(lpReplacedFileName, lpReplacementFileName, lpBackupFileName,
                                  dwReplaceFlags, lpExclude, lpReserved);
}

BOOL WINAPI ws_ReplaceFileA(LPCSTR lpReplacedFileName, LPCSTR lpReplacementFileName,
                            LPCSTR lpBackupFileName, DWORD dwReplaceFlags, LPVOID lpExclude, LPVOID lpReserved)
{
    wchar_t replaced[WS_PATH_MAX];
    wchar_t replacement[WS_PATH_MAX];
    wchar_t backup[WS_PATH_MAX];
    ws_a2w_buf(lpReplacedFileName, replaced, WS_PATH_MAX);
    ws_a2w_buf(lpReplacementFileName, replacement, WS_PATH_MAX);
    if (lpBackupFileName) {
        ws_a2w_buf(lpBackupFileName, backup, WS_PATH_MAX);
    } else {
        backup[0] = 0;
    }
    return ws_replace_file_locked(replaced[0] ? replaced : NULL, replacement[0] ? replacement : NULL,
                                  backup[0] ? backup : NULL, dwReplaceFlags, lpExclude, lpReserved);
}

/* ------------------------------------------------------------ R19 enum filter */

HANDLE WINAPI ws_FindFirstFileW(LPCWSTR lpFileName, LPWIN32_FIND_DATAW lpFindFileData)
{
    ws_callhit_named("FindFirstFileW");
    HANDLE h = g_orig.FindFirstFileW ? g_orig.FindFirstFileW(lpFileName, lpFindFileData)
                                     : FindFirstFileW(lpFileName, lpFindFileData);
    if (h == INVALID_HANDLE_VALUE || !lpFindFileData || !ws_mask_declared()) {
        return h;
    }
    wchar_t dir[WS_PATH_MAX];
    if (!ws_find_dir_of_pattern_w(lpFileName, dir, WS_PATH_MAX)) {
        return h;
    }
    wchar_t rule[256];
    if (ws_mask_decide_read(dir, rule, 256)) {
        ws_find_orig_close(h);
        SetLastError(ERROR_FILE_NOT_FOUND);
        return INVALID_HANDLE_VALUE;
    }
    for (;;) {
        if (!ws_find_entry_masked(dir, lpFindFileData->cFileName, rule, 256)) {
            ws_find_register(h, dir);
            return h;
        }
        BOOL next = g_orig.FindNextFileW ? g_orig.FindNextFileW(h, lpFindFileData)
                                         : FindNextFileW(h, lpFindFileData);
        if (!next) {
            ws_find_orig_close(h);
            ws_log_w(L"FindFirstFileW: every entry hidden by the read mask", dir);
            SetLastError(ERROR_FILE_NOT_FOUND);
            return INVALID_HANDLE_VALUE;
        }
    }
}

HANDLE WINAPI ws_FindFirstFileA(LPCSTR lpFileName, LPWIN32_FIND_DATAA lpFindFileData)
{
    ws_callhit_named("FindFirstFileA");
    HANDLE h = g_orig.FindFirstFileA ? g_orig.FindFirstFileA(lpFileName, lpFindFileData)
                                     : FindFirstFileA(lpFileName, lpFindFileData);
    if (h == INVALID_HANDLE_VALUE || !lpFindFileData || !ws_mask_declared()) {
        return h;
    }
    wchar_t patternW[WS_PATH_MAX];
    ws_a2w_buf(lpFileName, patternW, WS_PATH_MAX);
    wchar_t dir[WS_PATH_MAX];
    if (!ws_find_dir_of_pattern_w(patternW, dir, WS_PATH_MAX)) {
        return h;
    }
    wchar_t rule[256];
    if (ws_mask_decide_read(dir, rule, 256)) {
        ws_find_orig_close(h);
        SetLastError(ERROR_FILE_NOT_FOUND);
        return INVALID_HANDLE_VALUE;
    }
    for (;;) {
        wchar_t nameW[WS_PATH_MAX];
        ws_a2w_buf(lpFindFileData->cFileName, nameW, WS_PATH_MAX);
        if (!ws_find_entry_masked(dir, nameW, rule, 256)) {
            ws_find_register(h, dir);
            return h;
        }
        BOOL next = g_orig.FindNextFileA ? g_orig.FindNextFileA(h, lpFindFileData)
                                         : FindNextFileA(h, lpFindFileData);
        if (!next) {
            ws_find_orig_close(h);
            ws_log_w(L"FindFirstFileA: every entry hidden by the read mask", dir);
            SetLastError(ERROR_FILE_NOT_FOUND);
            return INVALID_HANDLE_VALUE;
        }
    }
}

HANDLE WINAPI ws_FindFirstFileExW(LPCWSTR lpFileName, FINDEX_INFO_LEVELS fInfoLevelId, LPVOID lpFindFileData,
                                  FINDEX_SEARCH_OPS fSearchOp, LPVOID lpSearchFilter, DWORD dwAdditionalFlags)
{
    ws_callhit_named("FindFirstFileExW");
    HANDLE h = g_orig.FindFirstFileExW
                   ? g_orig.FindFirstFileExW(lpFileName, fInfoLevelId, lpFindFileData, fSearchOp, lpSearchFilter,
                                             dwAdditionalFlags)
                   : FindFirstFileExW(lpFileName, fInfoLevelId, lpFindFileData, fSearchOp, lpSearchFilter,
                                      dwAdditionalFlags);
    if (h == INVALID_HANDLE_VALUE || !lpFindFileData || !ws_mask_declared()) {
        return h;
    }
    /* Only the two documented info levels use the WIN32_FIND_DATA layout; any
     * other level would make "read cFileName" a guess, so it is left unfiltered. */
    if (fInfoLevelId != FindExInfoStandard && fInfoLevelId != FindExInfoBasic) {
        return h;
    }
    LPWIN32_FIND_DATAW data = (LPWIN32_FIND_DATAW)lpFindFileData;
    wchar_t dir[WS_PATH_MAX];
    if (!ws_find_dir_of_pattern_w(lpFileName, dir, WS_PATH_MAX)) {
        return h;
    }
    wchar_t rule[256];
    if (ws_mask_decide_read(dir, rule, 256)) {
        ws_find_orig_close(h);
        SetLastError(ERROR_FILE_NOT_FOUND);
        return INVALID_HANDLE_VALUE;
    }
    for (;;) {
        if (!ws_find_entry_masked(dir, data->cFileName, rule, 256)) {
            ws_find_register(h, dir);
            return h;
        }
        BOOL next = g_orig.FindNextFileW ? g_orig.FindNextFileW(h, data) : FindNextFileW(h, data);
        if (!next) {
            ws_find_orig_close(h);
            ws_log_w(L"FindFirstFileExW: every entry hidden by the read mask", dir);
            SetLastError(ERROR_FILE_NOT_FOUND);
            return INVALID_HANDLE_VALUE;
        }
    }
}

HANDLE WINAPI ws_FindFirstFileExA(LPCSTR lpFileName, FINDEX_INFO_LEVELS fInfoLevelId, LPVOID lpFindFileData,
                                  FINDEX_SEARCH_OPS fSearchOp, LPVOID lpSearchFilter, DWORD dwAdditionalFlags)
{
    ws_callhit_named("FindFirstFileExA");
    HANDLE h = g_orig.FindFirstFileExA
                   ? g_orig.FindFirstFileExA(lpFileName, fInfoLevelId, lpFindFileData, fSearchOp, lpSearchFilter,
                                             dwAdditionalFlags)
                   : FindFirstFileExA(lpFileName, fInfoLevelId, lpFindFileData, fSearchOp, lpSearchFilter,
                                      dwAdditionalFlags);
    if (h == INVALID_HANDLE_VALUE || !lpFindFileData || !ws_mask_declared()) {
        return h;
    }
    if (fInfoLevelId != FindExInfoStandard && fInfoLevelId != FindExInfoBasic) {
        return h;
    }
    LPWIN32_FIND_DATAA data = (LPWIN32_FIND_DATAA)lpFindFileData;
    wchar_t patternW[WS_PATH_MAX];
    ws_a2w_buf(lpFileName, patternW, WS_PATH_MAX);
    wchar_t dir[WS_PATH_MAX];
    if (!ws_find_dir_of_pattern_w(patternW, dir, WS_PATH_MAX)) {
        return h;
    }
    wchar_t rule[256];
    if (ws_mask_decide_read(dir, rule, 256)) {
        ws_find_orig_close(h);
        SetLastError(ERROR_FILE_NOT_FOUND);
        return INVALID_HANDLE_VALUE;
    }
    for (;;) {
        wchar_t nameW[WS_PATH_MAX];
        ws_a2w_buf(data->cFileName, nameW, WS_PATH_MAX);
        if (!ws_find_entry_masked(dir, nameW, rule, 256)) {
            ws_find_register(h, dir);
            return h;
        }
        BOOL next = g_orig.FindNextFileA ? g_orig.FindNextFileA(h, data) : FindNextFileA(h, data);
        if (!next) {
            ws_find_orig_close(h);
            ws_log_w(L"FindFirstFileExA: every entry hidden by the read mask", dir);
            SetLastError(ERROR_FILE_NOT_FOUND);
            return INVALID_HANDLE_VALUE;
        }
    }
}

BOOL WINAPI ws_FindNextFileW(HANDLE hFindFile, LPWIN32_FIND_DATAW lpFindFileData)
{
    wchar_t dir[WS_PATH_MAX];
    if (!lpFindFileData || !ws_mask_declared() || !ws_find_lookup(hFindFile, dir, WS_PATH_MAX)) {
        return g_orig.FindNextFileW ? g_orig.FindNextFileW(hFindFile, lpFindFileData)
                                    : FindNextFileW(hFindFile, lpFindFileData);
    }
    for (;;) {
        BOOL ok = g_orig.FindNextFileW ? g_orig.FindNextFileW(hFindFile, lpFindFileData)
                                       : FindNextFileW(hFindFile, lpFindFileData);
        if (!ok) {
            return FALSE;
        }
        wchar_t rule[256];
        if (!ws_find_entry_masked(dir, lpFindFileData->cFileName, rule, 256)) {
            return TRUE;
        }
    }
}

BOOL WINAPI ws_FindNextFileA(HANDLE hFindFile, LPWIN32_FIND_DATAA lpFindFileData)
{
    wchar_t dir[WS_PATH_MAX];
    if (!lpFindFileData || !ws_mask_declared() || !ws_find_lookup(hFindFile, dir, WS_PATH_MAX)) {
        return g_orig.FindNextFileA ? g_orig.FindNextFileA(hFindFile, lpFindFileData)
                                    : FindNextFileA(hFindFile, lpFindFileData);
    }
    for (;;) {
        BOOL ok = g_orig.FindNextFileA ? g_orig.FindNextFileA(hFindFile, lpFindFileData)
                                       : FindNextFileA(hFindFile, lpFindFileData);
        if (!ok) {
            return FALSE;
        }
        wchar_t nameW[WS_PATH_MAX];
        ws_a2w_buf(lpFindFileData->cFileName, nameW, WS_PATH_MAX);
        wchar_t rule[256];
        if (!ws_find_entry_masked(dir, nameW, rule, 256)) {
            return TRUE;
        }
    }
}

BOOL WINAPI ws_FindClose(HANDLE hFindFile)
{
    ws_find_unregister(hFindFile);
    return ws_find_orig_close(hFindFile);
}

/* R19 (node carrier): node/libuv's fs.readdir opens the directory with
 * CreateFileW and then calls ntdll!NtQueryDirectoryFile DIRECTLY (measured:
 * node.exe contains the string, resolves it dynamically; FindFirstFile* never
 * appears in the shim log for readdir). Filtering the returned buffer is the
 * only way to hide masked names from that carrier.
 *
 * The filter is applied IN PLACE on the caller's own buffer, preserving the
 * enumeration context held by the kernel (no side table, no re-open):
 *   · the real NtQueryDirectoryFile fills FileInformation with a linked list of
 *     entries (NextEntryOffset / FileNameLength / FileName) for the class;
 *   · every entry whose "dir\name" matches a read-mask rule is spliced out;
 *   · if EVERY entry of a batch was filtered the call is repeated to get the
 *     next batch (ReturnSingleEntry=1 included), until a visible entry or
 *     STATUS_NO_MORE_FILES remains.
 * Unknown info classes / async completions / unresolvable handles are passed
 * through unchanged (never guess, never corrupt the caller's buffer). */
#define WS_R20_STATUS_BUFFER_OVERFLOW ((NTSTATUS)0x80000005L)
#define WS_R20_STATUS_NO_MORE_FILES    ((NTSTATUS)0x80000006L)
#define WS_R20_STATUS_PENDING          ((NTSTATUS)0x00000103L)

static _Thread_local int t_dirQueryBusy;

/* Offset of FileNameLength / FileName for every directory info class we can
 * safely parse. Layouts come from the SDK structs themselves (offsetof), not
 * from hand-computed numbers. */
static int ws_dir_entry_layout(ULONG cls, ULONG *nameLenOff, ULONG *nameOff)
{
    switch (cls) {
    case FileDirectoryInformation: /* 1 */
        *nameLenOff = (ULONG)offsetof(FILE_DIRECTORY_INFORMATION, FileNameLength);
        *nameOff = (ULONG)offsetof(FILE_DIRECTORY_INFORMATION, FileName);
        return 1;
    case FileFullDirectoryInformation: /* 2 */
        *nameLenOff = (ULONG)offsetof(FILE_FULL_DIR_INFORMATION, FileNameLength);
        *nameOff = (ULONG)offsetof(FILE_FULL_DIR_INFORMATION, FileName);
        return 1;
    case FileBothDirectoryInformation: /* 3 */
        *nameLenOff = (ULONG)offsetof(FILE_BOTH_DIR_INFORMATION, FileNameLength);
        *nameOff = (ULONG)offsetof(FILE_BOTH_DIR_INFORMATION, FileName);
        return 1;
    case FileIdBothDirectoryInformation: /* 37 */
        *nameLenOff = (ULONG)offsetof(FILE_ID_BOTH_DIR_INFORMATION, FileNameLength);
        *nameOff = (ULONG)offsetof(FILE_ID_BOTH_DIR_INFORMATION, FileName);
        return 1;
    case FileIdFullDirectoryInformation: /* 38 */
        *nameLenOff = (ULONG)offsetof(FILE_ID_FULL_DIR_INFORMATION, FileNameLength);
        *nameOff = (ULONG)offsetof(FILE_ID_FULL_DIR_INFORMATION, FileName);
        return 1;
    case FileNamesInformation: /* 12 */
        *nameLenOff = (ULONG)offsetof(FILE_NAMES_INFORMATION, FileNameLength);
        *nameOff = (ULONG)offsetof(FILE_NAMES_INFORMATION, FileName);
        return 1;
    default:
        return 0;
    }
}

/* Directory path behind the enumeration handle (Win32 form, normalized).
 * GetFinalPathNameByHandleW works for the FILE_READ_DATA|SYNCHRONIZE handle
 * libuv opens (measured); failure => no filtering (bounded, logged).
 * R20 FOLLOW-UP（P0）：句柄可能来自 `\Device\HarddiskVolumeN\…` 或
 * `\??\Volume{GUID}\…` 打开（GetFinalPathNameByHandleW 返回 `\\?\Volume{…}\…`），
 * 先过 ws_nt_device_to_win 再归一化，否则该句柄的枚举不受遮蔽过滤。 */
static int ws_dir_path_of_handle(HANDLE h, wchar_t *dir, DWORD cch)
{
    dir[0] = 0;
    wchar_t raw[WS_PATH_MAX];
    DWORD n = GetFinalPathNameByHandleW(h, raw, WS_PATH_MAX, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (n == 0 || n >= WS_PATH_MAX) {
        n = GetFinalPathNameByHandleW(h, raw, WS_PATH_MAX, VOLUME_NAME_DOS);
        if (n == 0 || n >= WS_PATH_MAX) {
            return 0;
        }
    }
    if (ws_nt_device_to_win(raw, dir, cch)) {
        /* converted: volume-GUID / device-path handle */
    } else if (!ws_normalize_path(raw, dir, cch)) {
        dir[0] = 0;
        return 0;
    }
    if (ws_is_device_path(dir)) {
        dir[0] = 0;
        return 0;
    }
    /* Only absolute drive / UNC names can be combined with an entry name. */
    if (!(((dir[0] >= L'A' && dir[0] <= L'Z') || (dir[0] >= L'a' && dir[0] <= L'z')) && dir[1] == L':' &&
          dir[2] == L'\\') &&
        !(dir[0] == L'\\' && dir[1] == L'\\' && dir[2] && dir[2] != L'?' && dir[2] != L'.')) {
        dir[0] = 0;
        return 0;
    }
    return 1;
}

/* Was this handle opened through an NT-namespace/device name we could not map?
 * Used to fail closed (instead of silently enumerating unfiltered) when the read
 * mask is active. */
static int ws_handle_is_unmapped_device(HANDLE h)
{
    wchar_t raw[WS_PATH_MAX];
    DWORD n = GetFinalPathNameByHandleW(h, raw, WS_PATH_MAX, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (n == 0 || n >= WS_PATH_MAX) {
        return 0; /* cannot tell -> do not invent a denial */
    }
    wchar_t conv[WS_PATH_MAX];
    if (ws_nt_device_to_win(raw, conv, WS_PATH_MAX)) {
        return 0;
    }
    return ws_is_nt_alias(raw);
}

NTSTATUS NTAPI ws_NtQueryDirectoryFile(HANDLE FileHandle, HANDLE Event, PIO_APC_ROUTINE ApcRoutine,
                                       PVOID ApcContext, PIO_STATUS_BLOCK IoStatusBlock, PVOID FileInformation,
                                       ULONG Length, FILE_INFORMATION_CLASS FileInformationClass,
                                       BOOLEAN ReturnSingleEntry, PUNICODE_STRING FileName, BOOLEAN RestartScan)
{
    ws_callhit_named("NtQueryDirectoryFile");
    ULONG nameLenOff = 0;
    ULONG nameOff = 0;
    wchar_t dir[WS_PATH_MAX];
    if (!g_orig.NtQueryDirectoryFile || t_wsFileBusy || t_dirQueryBusy || !ws_mask_declared() ||
        !FileHandle || FileHandle == INVALID_HANDLE_VALUE || !FileInformation || Length < 64 ||
        !ws_dir_entry_layout((ULONG)FileInformationClass, &nameLenOff, &nameOff)) {
        return g_orig.NtQueryDirectoryFile(FileHandle, Event, ApcRoutine, ApcContext, IoStatusBlock,
                                           FileInformation, Length, FileInformationClass, ReturnSingleEntry,
                                           FileName, RestartScan);
    }
    if (!ws_dir_path_of_handle(FileHandle, dir, WS_PATH_MAX)) {
        /* R20 FOLLOW-UP（P0）：句柄来自映射不了的设备/卷命名空间 ⇒ 无法重建目录项
         * 全路径 ⇒ 过滤不了。mask 生效时 fail-closed（拒绝），绝不静默返回未过滤
         * 的名字；其它情况（非目录句柄/临时失败）保持透传。 */
        if (ws_handle_is_unmapped_device(FileHandle)) {
            ws_log("fail-closed NtQueryDirectoryFile: unmapped device-path handle cannot be filtered");
            if (IoStatusBlock) {
                IoStatusBlock->Status = WS_R20_STATUS_ACCESS_DENIED;
                IoStatusBlock->Information = 0;
            }
            return WS_R20_STATUS_ACCESS_DENIED;
        }
        return g_orig.NtQueryDirectoryFile(FileHandle, Event, ApcRoutine, ApcContext, IoStatusBlock,
                                           FileInformation, Length, FileInformationClass, ReturnSingleEntry,
                                           FileName, RestartScan);
    }
    BYTE *tmp = (BYTE *)HeapAlloc(GetProcessHeap(), 0, Length);
    if (!tmp) {
        return g_orig.NtQueryDirectoryFile(FileHandle, Event, ApcRoutine, ApcContext, IoStatusBlock,
                                           FileInformation, Length, FileInformationClass, ReturnSingleEntry,
                                           FileName, RestartScan);
    }
    NTSTATUS result = WS_R20_STATUS_ACCESS_DENIED;
    BOOLEAN restart = RestartScan;
    t_dirQueryBusy = 1;
    for (;;) {
        IO_STATUS_BLOCK localIosb;
        PIO_STATUS_BLOCK iosb = IoStatusBlock;
        if (!iosb) {
            memset(&localIosb, 0, sizeof(localIosb));
            iosb = &localIosb;
        }
        NTSTATUS st = g_orig.NtQueryDirectoryFile(FileHandle, Event, ApcRoutine, ApcContext, iosb,
                                                  FileInformation, Length, FileInformationClass, ReturnSingleEntry,
                                                  FileName, restart);
        restart = FALSE; /* only the caller's first request may restart the scan */
        if (st == WS_R20_STATUS_PENDING && Event && !ApcRoutine) {
            if (WaitForSingleObject(Event, 30000) == WAIT_OBJECT_0) {
                st = iosb->Status;
            }
        }
        if (st == WS_R20_STATUS_PENDING) {
            /* Async completion we cannot filter without breaking the contract.
             * Documented residual: this call is left untouched. */
            ws_log("NtQueryDirectoryFile: async completion cannot be filtered (pass-through)");
            result = st;
            break;
        }
        if (st == WS_R20_STATUS_NO_MORE_FILES) {
            iosb->Information = 0;
            result = st;
            break;
        }
        if (st < 0 && st != WS_R20_STATUS_BUFFER_OVERFLOW) {
            result = st;
            break;
        }
        ULONG info = iosb->Information;
        if (info > Length) {
            info = Length;
        }
        ULONG outOff = 0;
        ULONG pos = 0;
        ULONG visible = 0;
        ULONG total = 0;
        BYTE *lastVisible = NULL;
        while (pos + nameOff <= info && pos + nameLenOff + sizeof(ULONG) <= info) {
            BYTE *e = (BYTE *)FileInformation + pos;
            ULONG next = *(ULONG *)e;
            if (next != 0 && (next < nameOff || next > info - pos)) {
                break; /* malformed entry: stop filtering this batch */
            }
            ULONG nameLen = *(ULONG *)(e + nameLenOff);
            int hide = 0;
            if (nameLen > 0 && nameLen <= (info - pos - nameOff) && (nameLen / sizeof(wchar_t)) < WS_PATH_MAX) {
                wchar_t name[WS_PATH_MAX];
                wchar_t rule[256];
                ULONG cch = nameLen / sizeof(wchar_t);
                memcpy(name, e + nameOff, (size_t)nameLen);
                name[cch] = 0;
                hide = ws_find_entry_masked(dir, name, rule, 256);
            }
            total++;
            if (!hide) {
                ULONG copyLen = next ? next : (info - pos);
                if (outOff + copyLen <= Length) {
                    memcpy(tmp + outOff, e, copyLen);
                    if (lastVisible) {
                        *(ULONG *)lastVisible = outOff - (ULONG)(lastVisible - tmp);
                    }
                    lastVisible = tmp + outOff;
                    outOff += copyLen;
                    visible++;
                }
            }
            if (!next) {
                break;
            }
            pos += next;
        }
        if (lastVisible) {
            *(ULONG *)lastVisible = 0;
        }
        if (visible > 0) {
            memcpy(FileInformation, tmp, outOff);
            iosb->Information = outOff;
            iosb->Status = st;
            result = st;
            break;
        }
        if (st == WS_R20_STATUS_BUFFER_OVERFLOW || total == 0) {
            /* all entries filtered but the real call cannot advance (the caller's
             * buffer is too small for even one entry). Return its status with an
             * empty Information; callers then either end the scan or grow the
             * buffer. A SHORT success batch is NOT an end condition: keep asking
             * for the next batch (ReturnSingleEntry included). */
            iosb->Information = 0;
            result = st;
            break;
        }
        /* every entry of this batch was hidden: ask for the next batch */
    }
    t_dirQueryBusy = 0;
    HeapFree(GetProcessHeap(), 0, tmp);
    if (result == 0) {
        ws_log_w(L"NtQueryDirectoryFile filtered response", dir);
    }
    return result;
}

/* --------------------------------------------------------------- hooks */

/* ═══ R21：delete → recreate（whiteout 后再创建）════════════════════════════════
 *
 * `dp_file_resolve(READ)` 先查 whiteout 标记、再查暂存副本。于是沙箱内
 * `write → unlink → write` 之后：暂存树里**有**新副本、但 whiteout 标记还在 ⇒
 * 读回仍是 FILE_NOT_FOUND（R21 探针实测 `recreate.injected status=1`）。
 * 语义上"删除后又创建"应让路径重新存在，因此每次写入/建目录/改名/复制/建链接
 * 成功把路径**重新物化**时，同步清掉 whiteout 标记。
 *
 * wo 路径布局与内置 provider（ws_stage.c 文件头）一致：`<root>\wo\<drive-less 路径>`、
 * UNC 为 `<root>\wo\_unc\<server>\<share>\…`。这里刻意与 `ws_logical_from_staged`
 * 一样只做"布局镜像"，不改 provider（provider 不在本轮写域）。 */
static int ws_stage_side_path(const wchar_t *norm, const wchar_t *leaf, wchar_t *out, DWORD cch)
{
    if (!norm || !norm[0] || !g_ws.haveStageRoot || !g_ws.stageRoot[0]) {
        return 0;
    }
    size_t pos = 0;
    out[0] = 0;
    if (!ws_append_w(out, cch, &pos, g_ws.stageRoot) || !ws_append_w(out, cch, &pos, L"\\") ||
        !ws_append_w(out, cch, &pos, leaf)) {
        return 0;
    }
    if (norm[0] == L'\\' && norm[1] == L'\\') {
        return ws_append_w(out, cch, &pos, L"\\_unc") && ws_append_w(out, cch, &pos, L"\\") &&
               ws_append_w(out, cch, &pos, norm + 2);
    }
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

/* 1 = the logical path is currently whiteout-deleted in this sandbox. */
static int ws_logically_whiteouted(const wchar_t *norm)
{
    if (!g_wsStage.file_whiteouted || !norm || !norm[0]) {
        return 0;
    }
    return g_wsStage.file_whiteouted(norm) == 1;
}

/* Remove the whiteout marker so "delete then recreate" becomes visible again.
 * Best-effort by design: the write itself already succeeded; a failed marker
 * removal only keeps the old (deleted) view — it never writes the real disk. */
static void ws_clear_whiteout(const wchar_t *norm)
{
    wchar_t wo[WS_PATH_MAX];
    if (!norm || !norm[0] || !ws_stage_side_path(norm, L"wo", wo, WS_PATH_MAX) || !g_orig.DeleteFileW) {
        return;
    }
    t_wsFileBusy++;
    DWORD attrs = g_orig.GetFileAttributesW ? g_orig.GetFileAttributesW(wo) : INVALID_FILE_ATTRIBUTES;
    if (attrs != INVALID_FILE_ATTRIBUTES && !(attrs & FILE_ATTRIBUTE_DIRECTORY)) {
        if (g_orig.DeleteFileW(wo)) {
            ws_log_w(L"whiteout cleared after recreate", norm);
        }
    }
    t_wsFileBusy--;
}

/* Write-intent opens of an EXISTING real file must copy the real content into
 * the overlay first (copy-on-write). Without CoW, an OPEN_ALWAYS/GENERIC_WRITE
 * open of a real file was redirected to a non-existent overlay path, which
 * OPEN_ALWAYS then silently created as an empty file -- the caller read an empty
 * file where the real system had content. That is what broke PowerShell's
 * InitialSessionState (.NET reads files with OPEN_ALWAYS during startup). */
static HANDLE ws_create_file_core(LPCWSTR lpFileName, DWORD dwDesiredAccess, DWORD dwShareMode,
                                  LPSECURITY_ATTRIBUTES lpSecurityAttributes, DWORD dwCreationDisposition,
                                  DWORD dwFlagsAndAttributes, HANDLE hTemplateFile, int isAnsi)
{
    /* R20 FOLLOW-UP（P0）：先剥 NT 命名空间/Win32 设备别名（\\?\GLOBALROOT\Device\…、
     * \\.\X:、\??\Volume{GUID}\…）。否则下面的遮蔽判定看到的是"设备/相对名"，
     * 会跳过 mask，随后 ws_should_intercept 再映射成功 ⇒ 遮蔽读/写绕过。
     * 映射不了的设备名保持原样（后续按原逻辑 passthrough，残余见 findings §6）。 */
    wchar_t effectiveName[WS_PATH_MAX];
    LPCWSTR rawName = lpFileName;
    if (lpFileName && lpFileName[0] && ws_path_effective(lpFileName, effectiveName, WS_PATH_MAX)) {
        lpFileName = effectiveName;
    }
    /* Read masking (task-10) runs before anything else, so a sensitive path is
     * denied even if it would otherwise pass through (staging root, device names,
     * passthrough prefixes).
     *
     * ── R19-A1（Lead 拍板语义）：**mask 是读边界**，不是"一切访问都拒" ──────────────
     * 现场（R19 注入实证）：旧判据只在 `!writeAccessMask && !destructiveMask` 时查 mask，
     * 于是 `fs.openSync(masked, 'r+')`（GENERIC_READ|GENERIC_WRITE，desiredAccess=0x3）
     * 完全跳过 mask ⇒ 走 CoW copy-up 把真实明文复制进 overlay ⇒ 调用方从**同一个 handle**
     * 读回明文（`readSync` 输出 marker；`MemoryMappedFile.CreateFromFile` 同样中招）。
     *
     * 现在的三分（顺序即优先级）：
     *   ① 被 mask 命中 + desiredAccess 含**可读位**（WS_FILE_READ_ACCESS_MASK，
     *      含 `GENERIC_ALL`/`MAXIMUM_ALLOWED`/`r+`）⇒ ERROR_ACCESS_DENIED；
     *   ② 被 mask 命中 + **纯写意图**（不含可读位）⇒ 允许进暂存，但**不做 CoW copy-up**
     *      （见下方 `maskNoCopyUp`，只建空占位副本），因此同 handle 读不回真实内容；
     *   ③ 未被 mask 命中 ⇒ 与旧行为完全一致。
     * ③ 不是"写也全拒"：写敏感路径仍然成功、仍然只落暂存，只是不再把明文搬进暂存树。 */
    DWORD writeAccessMask = dwDesiredAccess & WS_FILE_WRITE_ACCESS_MASK;
    DWORD readAccessMask = dwDesiredAccess & WS_FILE_READ_ACCESS_MASK;
    int destructiveMask = (dwCreationDisposition == CREATE_NEW || dwCreationDisposition == CREATE_ALWAYS ||
                           dwCreationDisposition == TRUNCATE_EXISTING);
    int maskNoCopyUp = 0;
    /* R21：mask 判定用**调用方原始路径**：`ws_mask_normalize()` 自己会做
     * realpath/长名/盘符归一，能识别 `\\?\` 前缀与 >MAX_PATH 的真实文件；而
     * `effectiveName` 对长路径去掉了前缀，mask 归一化会失败（fail-closed 或漏判）。 */
    if (ws_mask_declared() && rawName && rawName[0]) {
        wchar_t maskedBy[256];
        if (ws_mask_decide_read(rawName, maskedBy, 256)) {
            if (readAccessMask || (!writeAccessMask && !destructiveMask)) {
                ws_log_w(L"read masked", rawName);
                WS_TRACE_FILE("CreateFile read denied by mask rule %ls", maskedBy);
                SetLastError(ERROR_ACCESS_DENIED);
                return INVALID_HANDLE_VALUE;
            }
            /* 纯写意图：写入照常进暂存，但 CoW copy-up 会泄露明文 ⇒ 改为空占位副本。 */
            maskNoCopyUp = 1;
            ws_log_w(L"masked path, write-only intent: staging without CoW copy-up", rawName);
        }
    }

    wchar_t norm[WS_PATH_MAX];
    int intercept = ws_should_intercept(lpFileName, norm, WS_PATH_MAX);
    WS_TRACE_FILE("CreateFile request raw=%ls normalized=%ls intercept=%d access=0x%lx disp=%lu",
                  lpFileName ? lpFileName : L"(null)", norm, intercept,
                  (unsigned long)dwDesiredAccess, (unsigned long)dwCreationDisposition);
    if (g_ws.auditPath[0] && lpFileName) {
        char esc[WS_PATH_MAX * 3];
        ws_audit_escape_w(lpFileName, esc, sizeof(esc));
        ws_audit("{\"op\":\"file.open\",\"mode\":\"%s\",\"path\":\"%s\",\"disp\":%lu}",
                 (writeAccessMask || destructiveMask) ? "write" : "read", esc,
                 (unsigned long)dwCreationDisposition);
    }
    if (!intercept) {
        /* R21：passthrough 用原始路径（可能带 `\\?\`，>MAX_PATH 的真实 API 需要它）。 */
        LPCWSTR passName = rawName ? rawName : lpFileName;
        return isAnsi ? g_orig.CreateFileA((LPCSTR)passName, dwDesiredAccess, dwShareMode,
                                           lpSecurityAttributes, dwCreationDisposition,
                                           dwFlagsAndAttributes, hTemplateFile)
                      : g_orig.CreateFileW(passName, dwDesiredAccess, dwShareMode,
                                           lpSecurityAttributes, dwCreationDisposition,
                                           dwFlagsAndAttributes, hTemplateFile);
    }
    DWORD writeAccess = writeAccessMask;
    int destructive = destructiveMask;
    int realExists = ws_file_exists(norm);

    /* A pure read (or a read-only OPEN_ALWAYS where the real file exists) is
     * never staged: the real API is authoritative. */
    if (!destructive && !writeAccess &&
        !(dwCreationDisposition == OPEN_ALWAYS && !realExists)) {
        wchar_t mapped[WS_PATH_MAX];
        uint32_t rflags = 0;
        if (ws_resolve_file(norm, WINSTAGE_IO_READ, mapped, &rflags) != 0) {
            ws_log_w(L"fail-closed CreateFile(read)", norm);
            SetLastError(ERROR_ACCESS_DENIED);
            return INVALID_HANDLE_VALUE;
        }
        if (rflags & WINSTAGE_RES_WHITEOUT) {
            SetLastError(ERROR_FILE_NOT_FOUND);
            return INVALID_HANDLE_VALUE;
        }
        if (g_ws.traceStagedOps) {
            /* ★ round-4 诊断：读分支此前**只在 RES_STAGED 时**打日志，读穿路径完全静默 ——
             * 失败run 的日志因此停在 "CreateFile request" 那一行，无法区分"死在我们钩子里"
             * 与"死在钩子之后"。这里记下解析结果；else 分支再记一次开启结果，两者一对比
             * 就能把死亡点夹在中间。 */
            WS_DBG("read-branch resolved flags=0x%lx mapped=%ls", (unsigned long)rflags, mapped);
        }
        HANDLE h;
        DWORD stagedErr = ERROR_SUCCESS;
        wchar_t apiPathBuf[WS_PATH_MAX];
        const wchar_t *apiMapped = ws_api_path(mapped, apiPathBuf, WS_PATH_MAX);
        wchar_t apiNormBuf[WS_PATH_MAX];
        const wchar_t *apiNorm = ws_api_path(norm, apiNormBuf, WS_PATH_MAX);
        if (rflags & WINSTAGE_RES_STAGED) {
            /* ── WP13 overlay 读穿（read-through）修复 ────────────────────────────
             * `WINSTAGE_RES_STAGED` 只是"解析那一刻 overlay 里有件"的**快照**
             * （ws_stage.c `ws_exists(staged)`）。旧实现在这里无条件返回这次打开的
             * 结果，于是"快照命中、对象随后不可用"就变成一次**没有回落**的失败。
             * 实测形态（shim.log，PID 6104）：
             *   [5] CreateFileW staged(write) ...\dsh-stage-temp\<uuid>\__PSScriptPolicyTest_*.rnf.ps1
             *   [7] CreateFile overlay(read)  <同一路径>
             * 第二条实测路径（同一份日志，PID 3412/12072/5444/12020/11060/2180/2640/1584/3804 同形）：
             *   ...\AppData\Local\Microsoft\Windows\PowerShell\StartupProfileData-NonInteractive
             * 这正是 PowerShell 启动期/策略探针把读取路由成 overlay 读、缺件时拿不到真实文件
             * ⇒ `0x80070002`（进而 `0xE0434352`）的来源。
             *
             * 修法：**仅当 overlay 打开失败**且**调用方不是破坏性打开**时，回落一次真实
             * 路径。三条同时成立才回落，任何一条不满足就原样返回，fail-closed 语义不被放宽：
             *   ① `!destructive`：CREATE_ALWAYS/TRUNCATE_EXISTING 绝不能借回落去动真实文件
             *      （本分支由外层 if 已保证，这里再断言一次）；
             *   ② `wcscmp(mapped, norm) != 0`：真回落，不是同一路径空转；
             *   ③ `ws_file_exists(norm)`：真实文件确实存在（否则回落也只是换个
             *      ERROR_FILE_NOT_FOUND，白付一次系统调用）。
             * 回落失败时**保留 overlay 那次错误**（否则调用者看到 3 而非 2，语义漂移）。
             * 幂等/不递归：回落目标 `norm` 位于 stageRoot 与 passthrough 之外
             * （ws_should_intercept 已排除），且经 `g_orig.CreateFileW` 直调、不进钩子。 */
            h = g_orig.CreateFileW(apiMapped, dwDesiredAccess, dwShareMode, lpSecurityAttributes,
                                   dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
            stagedErr = GetLastError();
    { /* R11-D-13d-ovl: record the overlay open's own outcome (zero semantic change) */
        DWORD ovl_se = GetLastError();
        WS_DBG("ATTRDBG-CFW-OVL handle=%p valid=%d err=%lu path=%ls", (void *)h,
               (h != INVALID_HANDLE_VALUE) ? 1 : 0, (unsigned long)stagedErr, lpFileName);
        SetLastError(ovl_se);
    }
            if (h == INVALID_HANDLE_VALUE && !destructive &&
                ws_wcscmp_ci(mapped, norm) != 0 && ws_file_exists(norm)) {
                ws_log_w(L"CreateFile overlay(read) miss -> read-through real", norm);
                HANDLE hReal = g_orig.CreateFileW(apiNorm, dwDesiredAccess, dwShareMode, lpSecurityAttributes,
                                                  dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
                h = hReal;
                stagedErr = (hReal == INVALID_HANDLE_VALUE) ? stagedErr : ERROR_SUCCESS;
            }
        } else {
            h = g_orig.CreateFileW(apiMapped, dwDesiredAccess, dwShareMode, lpSecurityAttributes,
                                   dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
            stagedErr = GetLastError();
            if (g_ws.traceStagedOps) {
                /* ★ round-4 诊断：读穿（RES_REAL）分支的**开启结果**。与上面的
                 * "read-branch resolved" 配对：若失败run 只有 resolved 没有这一行，
                 * 死亡点就在 `g_orig.CreateFileW` 之内/紧后；若两行都有，则死在钩子之外。 */
                WS_DBG("read-branch real-open ok=%d err=%lu", h != INVALID_HANDLE_VALUE,
                       (unsigned long)stagedErr);
            }
        }
        if (g_ws.traceStagedOps && (rflags & WINSTAGE_RES_STAGED)) {
            /* ★ round-4 诊断：这条日志此前**成败共用同一行**，于是失败run 的日志
             * 里根本看不出那次 overlay 读到底成没成。失败时补上错误码与
             * "真实文件是否存在"，用于区分：
             *   err=2  ⇒ 暂存副本不在（写侧与读侧口径不一致/被删）
             *   err=5  ⇒ 暂存副本在但打不开（ACL/共享/CoW 痕迹）
             *   err=32 ⇒ 被别的句柄占用（共享模式不匹配） */
            if (h == INVALID_HANDLE_VALUE) {
                ws_log("CreateFile overlay(read) FAILED mapped=%ls err=%lu realExists=%d", mapped,
                       (unsigned long)stagedErr, ws_file_exists(norm));
            } else {
                ws_log_w(L"CreateFile overlay(read)", mapped);
            }
            SetLastError(stagedErr);
        }
        /* R18: the opened file may be a hardlink alias of a masked file. The
         * mask check above only saw the caller's path; enumerate the file's
         * link names once the handle exists and deny if ANY of them is masked. */
        if (h != INVALID_HANDLE_VALUE && !t_hlGuard && ws_mask_declared()) {
            wchar_t hlRule[256];
            if (ws_hardlink_alias_check_handle(h, mapped, hlRule, 256) != 0) {
                if (g_orig.CloseHandle) {
                    g_orig.CloseHandle(h);
                }
                ws_log_w(L"read denied: hardlink alias of a masked file", norm);
                SetLastError(ERROR_ACCESS_DENIED);
                return INVALID_HANDLE_VALUE;
            }
        }
        return h;
    }

    wchar_t staged[WS_PATH_MAX];
    uint32_t wflags = 0;
    if (ws_resolve_file(norm, WINSTAGE_IO_WRITE, staged, &wflags) != 0) {
        ws_log_w(L"fail-closed CreateFileW", norm);
        SetLastError(ERROR_ACCESS_DENIED);
        return INVALID_HANDLE_VALUE;
    }
    int stagedExists = ws_file_exists(staged);
    /* R21: delete-then-recreate. A whiteout marker makes the logical path absent
     * even when a staged copy exists, so the open/create decisions below must use
     * the LOGICAL existence, not the real one. */
    int logicalWhiteout = ws_logically_whiteouted(norm);
    /* R18-KNOWN-06: remember whether THIS open created the CoW copy. Only that
     * shape is revocable at close (a pre-existing staged copy belongs to an
     * earlier, possibly real, modification and must never be revoked here). */
    int copiedForDeferredCoW = 0;
    if (dwCreationDisposition == CREATE_NEW && (stagedExists || (realExists && !logicalWhiteout))) {
        SetLastError(ERROR_FILE_EXISTS);
        return INVALID_HANDLE_VALUE;
    }
    if (logicalWhiteout && !stagedExists && !writeAccess && !destructive &&
        dwCreationDisposition == OPEN_EXISTING) {
        SetLastError(ERROR_FILE_NOT_FOUND);
        return INVALID_HANDLE_VALUE;
    }
    if (logicalWhiteout && !stagedExists && dwCreationDisposition == TRUNCATE_EXISTING) {
        /* logically deleted: the real content must not be resurrected */
        SetLastError(ERROR_FILE_NOT_FOUND);
        return INVALID_HANDLE_VALUE;
    }
    /* R18: a hardlink can give a MASKED file a harmless-looking second name.
     * CoW copy-up would then move the plaintext into the overlay (readable
     * through the same handle). Detect it BEFORE copying: treat exactly like
     * the masked write-intent case above (overlay placeholder, no plaintext). */
    if (ws_mask_declared() && !maskNoCopyUp && !t_hlGuard && realExists && !stagedExists) {
        wchar_t hlRule[256];
        if (ws_path_hardlink_alias_masked(norm, hlRule, 256) != 0) {
            maskNoCopyUp = 1;
            ws_log_w(L"write-intent open: file has a masked hardlink alias -> staging without CoW copy-up", norm);
        }
    }
    /* R19-A1 ②：被遮蔽路径的**纯写意图** open —— 绝不 CoW copy-up。
     * 目的：让后续写/截断仍有 overlay 目标可操作（OPEN_ALWAYS / TRUNCATE_EXISTING 不会因
     * 缺件变成 ERROR_FILE_NOT_FOUND），同时 overlay 里**没有任何真实明文**：
     * 调用方即便用同一个 handle 读回，也只会读到"空文件 + 自己写进去的内容"。
     * 目录形态无法用"空文件占位"表达（且被遮蔽目录的写意图 open 本就该拒绝）⇒ fail-closed。 */
    if (maskNoCopyUp) {
        DWORD realAttrsMasked = ws_real_attrs_w(norm);
        if (realAttrsMasked != INVALID_FILE_ATTRIBUTES && (realAttrsMasked & FILE_ATTRIBUTE_DIRECTORY)) {
            ws_log_w(L"fail-closed CreateFileW (masked write-intent on a directory)", norm);
            SetLastError(ERROR_ACCESS_DENIED);
            return INVALID_HANDLE_VALUE;
        }
        if (!stagedExists) {
            /* 父链必须先建：直接 CreateFileW 不会补目录（否则 AppData\…\PSReadLine\
             * ConsoleHost_history.txt 这类正常写会被误拒）。失败仍 fail-closed。 */
            if (!ws_ensure_dirs(staged, 0)) {
                ws_log_w(L"fail-closed CreateFileW (masked write-intent placeholder dirs failed)", staged);
                SetLastError(ERROR_ACCESS_DENIED);
                return INVALID_HANDLE_VALUE;
            }
            HANDLE ph = g_orig.CreateFileW(staged, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                           NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
            if (ph == INVALID_HANDLE_VALUE) {
                ws_log_w(L"fail-closed CreateFileW (masked write-intent placeholder failed)", staged);
                SetLastError(ERROR_ACCESS_DENIED);
                return INVALID_HANDLE_VALUE;
            }
            CloseHandle(ph);
            ws_log_w(L"CreateFileW masked write-intent: empty placeholder (no plaintext copy-up)", staged);
            stagedExists = ws_file_exists(staged);
        }
    }
    /* Copy-on-write. Needed for every write-intent open whose overlay content is
     * kept (OPEN_* with write access) AND for TRUNCATE_EXISTING: a truncate still
     * needs an overlay file to act on, otherwise the staged open fails with
     * ERROR_FILE_NOT_FOUND even though the real file exists (PowerShell's
     * FileMode.Truncate hit exactly that: disp=5 reached the shim, .NET reported
     * "Cannot create <path>", and no overlay file was created). Copying instead
     * of creating an empty file also preserves a read-only attribute, so the
     * truncate then fails with ERROR_ACCESS_DENIED exactly like the real API.
     * CREATE_ALWAYS discards the content in the open itself and CREATE_NEW was
     * already rejected above, so neither needs the copy. */
    if (!stagedExists && realExists && !logicalWhiteout &&
        (!destructive || dwCreationDisposition == TRUNCATE_EXISTING)) {
        DWORD realAttrs = ws_real_attrs_w(norm);
        if (realAttrs != INVALID_FILE_ATTRIBUTES && (realAttrs & FILE_ATTRIBUTE_DIRECTORY)) {            /* ★ round-4 修复：**目录不能 CoW** —— `CopyFileW` 对目录必然失败，旧代码于是把
             * "打开一个已存在的目录"误判成 `copy-on-write failed` 并 fail-closed 拒绝。
             * 实测受害路径：`C:\ProgramData\Microsoft\Windows\WER\Temp`（WER 注册自己的临时
             * 目录；真实文件系统允许这种打开，我们的拒绝让 .NET 的错误报告路径拿不到目录，
             * 随后放大了它自己的失败）。正确做法：在覆盖层**镜像一个目录**，然后照常继续
             * （调用方的 FILE_FLAG_BACKUP_SEMANTICS 等标志原样传下去，语义与真实 API 一致）。 */
            if (!ws_ensure_dirs(staged, 1)) {
                ws_log_w(L"fail-closed CreateFileW (staged dir create failed)", staged);
                SetLastError(ERROR_ACCESS_DENIED);
                return INVALID_HANDLE_VALUE;
            }
            ws_log_w(L"CreateFileW stage-directory", staged);
        } else if (!g_orig.CopyFileW(norm, staged, FALSE)) {
            ws_log_w(L"fail-closed CreateFileW (copy-on-write failed)", norm);
            SetLastError(ERROR_ACCESS_DENIED);
            return INVALID_HANDLE_VALUE;
        } else {
            copiedForDeferredCoW = 1;
            ws_log_w(L"CreateFileW copy-on-write", staged);
        }
    }
    HANDLE h = g_orig.CreateFileW(staged, dwDesiredAccess, dwShareMode, lpSecurityAttributes,
                                  dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
    /* R18-KNOWN-06: register the copy so CloseHandle can revoke it when this open
     * never writes/truncates anything (the plaintext-copy-up leak). */
    if (copiedForDeferredCoW && h != INVALID_HANDLE_VALUE) {
        ws_cow_track(h, staged, norm);
    }
    if (h != INVALID_HANDLE_VALUE) {
        /* R21: this open wrote/created the logical path again => it must stop
         * looking deleted (whiteout marker cleared). */
        ws_clear_whiteout(norm);
    }
    if (g_ws.traceStagedOps && (writeAccess || destructive)) {
        /* Do not lose the failing call's error code while tracing it (see the
         * read branch above): the sandboxed caller must see the same error an
         * uninjected caller sees. */
        DWORD lastErr = GetLastError();
        ws_log_w(h == INVALID_HANDLE_VALUE ? L"CreateFileW staged FAILED" : L"CreateFileW staged(write)", staged);
        SetLastError(lastErr);
    }
    return h;
}

HANDLE WINAPI ws_CreateFileW(LPCWSTR lpFileName, DWORD dwDesiredAccess, DWORD dwShareMode,
                             LPSECURITY_ATTRIBUTES lpSecurityAttributes, DWORD dwCreationDisposition,
                             DWORD dwFlagsAndAttributes, HANDLE hTemplateFile)
{
    { /* R11-D-13d-cfw: open-form log, LastError-safe (zero semantic change) */
        DWORD cfw_se = GetLastError();
        WS_DBG("ATTRDBG-CFW seq=%ld desiredAccess=0x%lx share=0x%lx disposition=%lu flags=0x%lx path=%ls", /* R11-D-13d-seq */
               ws_seq(), (unsigned long)dwDesiredAccess, (unsigned long)dwShareMode, (unsigned long)dwCreationDisposition,
               (unsigned long)dwFlagsAndAttributes, lpFileName);
        SetLastError(cfw_se);
    }
    ws_callhit_named("CreateFileW"); /* R11-D-13d */
    WS_STUCK("CreateFileW");
    ws_stuck_path(lpFileName);
    return ws_create_file_core(lpFileName, dwDesiredAccess, dwShareMode, lpSecurityAttributes,
                               dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile, 0);
}
HANDLE WINAPI ws_CreateFileA(LPCSTR lpFileName, DWORD dwDesiredAccess, DWORD dwShareMode,
                             LPSECURITY_ATTRIBUTES lpSecurityAttributes, DWORD dwCreationDisposition,
                             DWORD dwFlagsAndAttributes, HANDLE hTemplateFile)
{
    wchar_t wide[WS_PATH_MAX];
    ws_a2w_buf(lpFileName, wide, WS_PATH_MAX);
    return ws_create_file_core(wide[0] ? wide : NULL, dwDesiredAccess, dwShareMode, lpSecurityAttributes,
                               dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile, 0);
}

BOOL WINAPI ws_CreateDirectoryW(LPCWSTR lpPathName, LPSECURITY_ATTRIBUTES lpSecurityAttributes)
{
    wchar_t norm[WS_PATH_MAX];
    if (!ws_should_intercept(lpPathName, norm, WS_PATH_MAX)) {
        return g_orig.CreateDirectoryW(lpPathName, lpSecurityAttributes);
    }
    if (ws_file_exists(norm)) {
        SetLastError(ERROR_ALREADY_EXISTS);
        return FALSE;
    }
    wchar_t mapped[WS_PATH_MAX];
    uint32_t flags = 0;
    if (ws_resolve_file(norm, WINSTAGE_IO_WRITE, mapped, &flags) != 0) {
        ws_log_w(L"fail-closed CreateDirectoryW", norm);
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    BOOL ok = g_orig.CreateDirectoryW(mapped, lpSecurityAttributes);
    DWORD lastErr = GetLastError();
    if (ok) {
        ws_clear_whiteout(norm); /* R21: delete dir -> recreate dir */
    }
    ws_log_w(ok ? L"CreateDirectoryW staged" : L"CreateDirectoryW staged FAILED", mapped);
    SetLastError(lastErr);
    return ok;
}

BOOL WINAPI ws_CreateDirectoryA(LPCSTR lpPathName, LPSECURITY_ATTRIBUTES lpSecurityAttributes)
{
    wchar_t wide[WS_PATH_MAX];
    ws_a2w_buf(lpPathName, wide, WS_PATH_MAX);
    return ws_CreateDirectoryW(wide[0] ? wide : NULL, lpSecurityAttributes);
}

BOOL WINAPI ws_DeleteFileW(LPCWSTR lpFileName)
{
    WS_STUCK("DeleteFileW");
    ws_stuck_path(lpFileName);
    wchar_t norm[WS_PATH_MAX];
    int intercept = ws_should_intercept(lpFileName, norm, WS_PATH_MAX);
    WS_TRACE_FILE("DeleteFileW request raw=%ls normalized=%ls intercept=%d",
                  lpFileName ? lpFileName : L"(null)", norm, intercept);
    if (g_ws.auditPath[0]) {
        ws_audit_path("file.delete", lpFileName, NULL);
    }
    if (!intercept) {
        return g_orig.DeleteFileW(lpFileName);
    }
    int realExists = ws_file_exists(norm);
    wchar_t mapped[WS_PATH_MAX];
    uint32_t flags = 0;
    if (ws_resolve_file(norm, WINSTAGE_IO_DELETE, mapped, &flags) != 0) {
        ws_log_w(L"fail-closed DeleteFileW", norm);
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    int stagedExists = ws_file_exists(mapped);
    BOOL deletedStaged = TRUE;
    if (stagedExists) {
        /* see t_wsFileBusy: kernelbase's internals re-enter our Nt hook */
        t_wsFileBusy++;
        deletedStaged = g_orig.DeleteFileW(mapped);
        t_wsFileBusy--;
    }
    if (!realExists && !stagedExists) {
        SetLastError(ERROR_FILE_NOT_FOUND);
        return FALSE;
    }
    if (!deletedStaged) {
        return FALSE;
    }
    /* readonly attribute on the real file would have blocked a real delete */
    DWORD attrs = GetFileAttributesW(norm);
    if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY)) {
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    if (g_wsStage.file_whiteout) {
        g_wsStage.file_whiteout(norm);
    }
    DWORD lastErr = GetLastError(); /* keep the API's error, not the log write's */
    ws_log_w(L"DeleteFileW staged+whiteout", norm);
    SetLastError(lastErr);
    return TRUE;
}

BOOL WINAPI ws_DeleteFileA(LPCSTR lpFileName)
{
    wchar_t wide[WS_PATH_MAX];
    ws_a2w_buf(lpFileName, wide, WS_PATH_MAX);
    return ws_DeleteFileW(wide[0] ? wide : NULL);
}

static BOOL ws_move_locked(LPCWSTR src, LPCWSTR dst, DWORD flags)
{
    wchar_t normSrc[WS_PATH_MAX], normDst[WS_PATH_MAX];
    if (!ws_should_intercept(src, normSrc, WS_PATH_MAX) || !ws_should_intercept(dst, normDst, WS_PATH_MAX)) {
        return g_orig.MoveFileExW(src, dst, flags);
    }
    wchar_t stagedSrc[WS_PATH_MAX], stagedDst[WS_PATH_MAX];
    uint32_t fSrc = 0, fDst = 0;
    if (ws_resolve_file(normSrc, WINSTAGE_IO_WRITE, stagedSrc, &fSrc) != 0 ||
        ws_resolve_file(normDst, WINSTAGE_IO_WRITE, stagedDst, &fDst) != 0) {
        ws_log_w(L"fail-closed MoveFileExW", normDst);
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    int stagedSrcExists = ws_file_exists(stagedSrc);
    int realSrcExists = ws_file_exists(normSrc);
    if (!stagedSrcExists && !realSrcExists) {
        SetLastError(ERROR_FILE_NOT_FOUND);
        return FALSE;
    }
    BOOL ok;
    if (stagedSrcExists) {
        t_wsFileBusy++; /* kernelbase's MoveFileExW reaches NtSetInformationFile */
        ok = g_orig.MoveFileExW(stagedSrc, stagedDst, flags);
        t_wsFileBusy--;
    } else {
        /* materialize the real source into the overlay, then hide the original */
        DWORD realAttrs = GetFileAttributesW(normSrc);
        if (ws_mask_declared()) {
            wchar_t hlRule[256];
            if (ws_path_hardlink_alias_masked(normSrc, hlRule, 256) != 0) {
                ws_log_w(L"MoveFile denied: source is a hardlink alias of a masked file", normSrc);
                SetLastError(ERROR_ACCESS_DENIED);
                return FALSE;
            }
        }
        DWORD copyFlags = flags;
        (void)copyFlags;
        ok = g_orig.CopyFileW ? g_orig.CopyFileW(normSrc, stagedDst, FALSE) : FALSE;
        if (ok && g_wsStage.file_whiteout) {
            g_wsStage.file_whiteout(normSrc);
        }
        (void)realAttrs;
    }
    if (ok) {
        DWORD lastErr = GetLastError(); /* the log write must not become the caller's error */
        ws_clear_whiteout(normDst);     /* R21: move onto a logically-deleted path recreates it */
        ws_log_w(L"MoveFileExW staged", stagedDst);
        SetLastError(lastErr);
    }
    return ok;
}

BOOL WINAPI ws_MoveFileExW(LPCWSTR lpExistingFileName, LPCWSTR lpNewFileName, DWORD dwFlags)
{
    WS_STUCK("MoveFileExW");
    ws_stuck_path(lpExistingFileName);
    if (g_ws.auditPath[0]) {
        char e1[WS_PATH_MAX * 3];
        char e2[WS_PATH_MAX * 3];
        ws_audit_escape_w(lpExistingFileName, e1, sizeof(e1));
        ws_audit_escape_w(lpNewFileName, e2, sizeof(e2));
        ws_audit("{\"op\":\"file.move\",\"from\":\"%s\",\"to\":\"%s\"}", e1, e2);
    }
    return ws_move_locked(lpExistingFileName, lpNewFileName, dwFlags);
}

BOOL WINAPI ws_MoveFileExA(LPCSTR a, LPCSTR b, DWORD dwFlags)
{
    wchar_t wa[WS_PATH_MAX], wb[WS_PATH_MAX];
    ws_a2w_buf(a, wa, WS_PATH_MAX);
    ws_a2w_buf(b, wb, WS_PATH_MAX);
    return ws_move_locked(wa[0] ? wa : NULL, wb[0] ? wb : NULL, dwFlags);
}

BOOL WINAPI ws_MoveFileW(LPCWSTR a, LPCWSTR b)
{
    return ws_move_locked(a, b, MOVEFILE_COPY_ALLOWED);
}

BOOL WINAPI ws_MoveFileA(LPCSTR a, LPCSTR b)
{
    wchar_t wa[WS_PATH_MAX], wb[WS_PATH_MAX];
    ws_a2w_buf(a, wa, WS_PATH_MAX);
    ws_a2w_buf(b, wb, WS_PATH_MAX);
    return ws_move_locked(wa[0] ? wa : NULL, wb[0] ? wb : NULL, MOVEFILE_COPY_ALLOWED);
}

static BOOL ws_remove_directory_locked(LPCWSTR path)
{
    wchar_t norm[WS_PATH_MAX];
    if (!ws_should_intercept(path, norm, WS_PATH_MAX)) {
        return g_orig.RemoveDirectoryW(path);
    }
    wchar_t staged[WS_PATH_MAX];
    uint32_t flags = 0;
    if (ws_resolve_file(norm, WINSTAGE_IO_DELETE, staged, &flags) != 0) {
        ws_log_w(L"fail-closed RemoveDirectoryW", norm);
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    int stagedExists = ws_file_exists(staged);
    int realExists = ws_file_exists(norm);
    if (!stagedExists && !realExists) {
        SetLastError(ERROR_PATH_NOT_FOUND);
        return FALSE;
    }
    if (stagedExists) {
        t_wsFileBusy++; /* RemoveDirectoryW also reaches NtSetInformationFile(kernelbase) */
        BOOL okDir = g_orig.RemoveDirectoryW(staged);
        t_wsFileBusy--;
        if (!okDir) {
            return FALSE; /* e.g. ERROR_DIR_NOT_EMPTY, same as the real API */
        }
    } else {
        /* real-only: mirror the real API's emptiness check before hiding it */
        wchar_t pattern[WS_PATH_MAX];
        size_t pos = 0;
        pattern[0] = 0;
        ws_append_w(pattern, WS_PATH_MAX, &pos, norm);
        ws_append_w(pattern, WS_PATH_MAX, &pos, L"\\*");
        WIN32_FIND_DATAW fd;
        HANDLE h = FindFirstFileW(pattern, &fd);
        if (h != INVALID_HANDLE_VALUE) {
            int nonEmpty = 0;
            do {
                if (wcscmp(fd.cFileName, L".") != 0 && wcscmp(fd.cFileName, L"..") != 0) {
                    nonEmpty = 1;
                    break;
                }
            } while (FindNextFileW(h, &fd));
            FindClose(h);
            if (nonEmpty) {
                SetLastError(ERROR_DIR_NOT_EMPTY);
                return FALSE;
            }
        }
    }
    /* ★ round-4 修复（WP13 审计 B11 邻近项）：错误必须在**调用 whiteout 之前**取走 ——
     * `g_wsStage.file_whiteout()` 内部会做文件 IO 并把**它自己**的错误留在 last error 上，
     * 旧代码在它之后才 `GetLastError()`，于是"保留 API 的错误"实际上保留成了 whiteout 的错误。 */
    DWORD lastErr = GetLastError();
    if (g_wsStage.file_whiteout) {
        g_wsStage.file_whiteout(norm);
    }
    ws_log_w(L"RemoveDirectoryW staged+whiteout", norm);
    SetLastError(lastErr);
    return TRUE;
}

BOOL WINAPI ws_RemoveDirectoryW(LPCWSTR lpPathName)
{
    WS_STUCK("RemoveDirectoryW");
    ws_stuck_path(lpPathName);
    return ws_remove_directory_locked(lpPathName);
}

BOOL WINAPI ws_RemoveDirectoryA(LPCSTR lpPathName)
{
    wchar_t wide[WS_PATH_MAX];
    ws_a2w_buf(lpPathName, wide, WS_PATH_MAX);
    return ws_remove_directory_locked(wide[0] ? wide : NULL);
}

static BOOL ws_copy_file_locked(LPCWSTR src, LPCWSTR dst, BOOL failIfExists)
{
    /* R20 FOLLOW-UP（P0）：设备/卷命名空间路径先映射成普通 Win32，否则 mask 看到的是
     * `\\?\GLOBALROOT\Device\…` 这类名字（不匹配 leaf 遮蔽规则）⇒ 明文被复制。 */
    wchar_t effSrc[WS_PATH_MAX];
    wchar_t effDst[WS_PATH_MAX];
    if (src && src[0] && ws_path_effective(src, effSrc, WS_PATH_MAX)) {
        src = effSrc;
    }
    if (dst && dst[0] && ws_path_effective(dst, effDst, WS_PATH_MAX)) {
        dst = effDst;
    }
    /* ═══ R19-A2：CopyFileW/A 必须先过 mask 判定 ═══════════════════════════════
     * 现场（R19 注入实证）：旧实现直接 `ws_resolve_file(src, WINSTAGE_IO_READ)` 取真实路径
     * 再 CopyFileW ⇒ 被遮蔽文件的内容被整份复制进 overlay（暂存树/候选面出现明文 marker），
     * `.NET File.Copy`（走 CopyFileW）同样命中；而"读"本该被 mask 拒绝。
     * 判据：mask 是读边界 —— src 与 dst **任一**命中遮蔽表都拒绝（dst 落在敏感目录同理：
     * 那是把内容写进被遮蔽位置，同样属于不该发生的跨边界拷贝）。 */
    if (ws_mask_declared()) {
        wchar_t maskedBy[256];
        if (src && src[0] && ws_mask_decide_read(src, maskedBy, 256)) {
            ws_log_w(L"CopyFile masked source denied", src);
            SetLastError(ERROR_ACCESS_DENIED);
            return FALSE;
        }
        if (dst && dst[0] && ws_mask_decide_read(dst, maskedBy, 256)) {
            ws_log_w(L"CopyFile masked destination denied", dst);
            SetLastError(ERROR_ACCESS_DENIED);
            return FALSE;
        }
    }
    wchar_t normSrc[WS_PATH_MAX], normDst[WS_PATH_MAX];
    if (!ws_should_intercept(src, normSrc, WS_PATH_MAX) || !ws_should_intercept(dst, normDst, WS_PATH_MAX)) {
        return g_orig.CopyFileW(src, dst, failIfExists);
    }
    wchar_t stagedSrc[WS_PATH_MAX], stagedDst[WS_PATH_MAX];
    uint32_t fSrc = 0, fDst = 0;
    if (ws_resolve_file(normSrc, WINSTAGE_IO_READ, stagedSrc, &fSrc) != 0 ||
        ws_resolve_file(normDst, WINSTAGE_IO_WRITE, stagedDst, &fDst) != 0) {
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    /* R18: the source may be a hardlink alias of a masked file (the path mask
     * check above cannot see a second name). Deny before copying a byte. */
    if (ws_mask_declared() && !(fSrc & WINSTAGE_RES_STAGED)) {
        wchar_t hlRule[256];
        if (ws_path_hardlink_alias_masked(stagedSrc, hlRule, 256) != 0) {
            ws_log_w(L"CopyFile denied: source is a hardlink alias of a masked file", stagedSrc);
            SetLastError(ERROR_ACCESS_DENIED);
            return FALSE;
        }
    }
    if (fSrc & (WINSTAGE_RES_WHITEOUT)) {
        SetLastError(ERROR_FILE_NOT_FOUND);
        return FALSE;
    }
    if (failIfExists && ws_file_exists(normDst)) {
        SetLastError(ERROR_FILE_EXISTS);
        return FALSE;
    }
    BOOL copied = g_orig.CopyFileW(stagedSrc, stagedDst, FALSE);
    if (copied) {
        ws_clear_whiteout(normDst); /* R21: copy onto a logically-deleted path recreates it */
    }
    return copied;
}

BOOL WINAPI ws_CopyFileW(LPCWSTR src, LPCWSTR dst, BOOL failIfExists)
{
    return ws_copy_file_locked(src, dst, failIfExists);
}

BOOL WINAPI ws_CopyFileA(LPCSTR src, LPCSTR dst, BOOL failIfExists)
{
    wchar_t a[WS_PATH_MAX], b[WS_PATH_MAX];
    ws_a2w_buf(src, a, WS_PATH_MAX);
    ws_a2w_buf(dst, b, WS_PATH_MAX);
    return ws_copy_file_locked(a[0] ? a : NULL, b[0] ? b : NULL, failIfExists);
}

/* R19-A2b: `CopyFileExW/A` — robocopy and other real callers use THIS entry, not
 * CopyFileW. Before the hook they wrote the REAL disk directly (measured by
 * security-auditor: injected robocopy leaked a plaintext .npmrc into the real
 * workspace) because the name was absent from WS_TARGET. Semantics:
 *   · both paths non-intercepted -> original CopyFileEx (no behaviour change);
 *   · otherwise -> the same staging + read-mask path as CopyFileW;
 *     `COPY_FILE_FAIL_IF_EXISTS` maps to failIfExists; the progress callback is
 *     honoured at start/end (the staged copy is one real CopyFileW, so there is no
 *     per-chunk progress to report) and a pre-cancelled call aborts BEFORE writing
 *     anything (ERROR_REQUEST_ABORTED), exactly like the real API. */
BOOL WINAPI ws_CopyFileExW(LPCWSTR src, LPCWSTR dst, LPPROGRESS_ROUTINE progress,
                           LPVOID progressData, LPBOOL cancel, DWORD flags)
{
    WS_STUCK("CopyFileExW");
    ws_stuck_path(src);
    wchar_t normSrc[WS_PATH_MAX], normDst[WS_PATH_MAX];
    if (!ws_should_intercept(src, normSrc, WS_PATH_MAX) || !ws_should_intercept(dst, normDst, WS_PATH_MAX)) {
        if (g_orig.CopyFileExW) {
            return g_orig.CopyFileExW(src, dst, progress, progressData, cancel, flags);
        }
        return ws_copy_file_locked(src, dst, (flags & COPY_FILE_FAIL_IF_EXISTS) != 0);
    }
    if (cancel && *cancel) {
        SetLastError(ERROR_REQUEST_ABORTED);
        return FALSE;
    }
    BOOL failIfExists = (flags & COPY_FILE_FAIL_IF_EXISTS) != 0;
    LARGE_INTEGER total = { .QuadPart = 0 };
    LARGE_INTEGER zero = { .QuadPart = 0 };
    if (progress) {
        WIN32_FILE_ATTRIBUTE_DATA fad;
        if (GetFileAttributesExW(src, GetFileExInfoStandard, &fad)) {
            total.HighPart = (LONG)fad.nFileSizeHigh;
            total.LowPart = fad.nFileSizeLow;
        }
        DWORD stop = progress(zero, zero, zero, zero, 0, CALLBACK_STREAM_SWITCH, NULL, NULL, progressData);
        if (stop == PROGRESS_CANCEL) {
            SetLastError(ERROR_REQUEST_ABORTED);
            return FALSE;
        }
        if (stop == PROGRESS_STOP) {
            SetLastError(ERROR_REQUEST_ABORTED);
            return FALSE;
        }
        if (stop == PROGRESS_QUIET) {
            progress = NULL; /* caller asked us to stop calling it */
        }
    }
    BOOL ok = ws_copy_file_locked(src, dst, failIfExists);
    DWORD lastErr = GetLastError();
    if (ok && progress) {
        progress(total, total, total, total, 0, CALLBACK_CHUNK_FINISHED, NULL, NULL, progressData);
    }
    if (ok) {
        ws_log_w(L"CopyFileExW staged", dst);
    }
    SetLastError(lastErr);
    return ok;
}

BOOL WINAPI ws_CopyFileExA(LPCSTR src, LPCSTR dst, LPPROGRESS_ROUTINE progress,
                           LPVOID progressData, LPBOOL cancel, DWORD flags)
{
    wchar_t a[WS_PATH_MAX], b[WS_PATH_MAX];
    ws_a2w_buf(src, a, WS_PATH_MAX);
    ws_a2w_buf(dst, b, WS_PATH_MAX);
    return ws_CopyFileExW(a[0] ? a : NULL, b[0] ? b : NULL, progress, progressData, cancel, flags);
}

/* robocopy calls CopyFile2 (resolved dynamically: CopyFileExW never appeared in the
 * injected shim log). Same policy as CopyFileExW: staging + mask, HRESULT contract. */
HRESULT WINAPI ws_CopyFile2(PCWSTR src, PCWSTR dst, COPYFILE2_EXTENDED_PARAMETERS *params)
{
    WS_STUCK("CopyFile2");
    ws_stuck_path(src);
    wchar_t normSrc[WS_PATH_MAX], normDst[WS_PATH_MAX];
    if (!ws_should_intercept(src, normSrc, WS_PATH_MAX) || !ws_should_intercept(dst, normDst, WS_PATH_MAX)) {
        if (g_orig.CopyFile2) return g_orig.CopyFile2(src, dst, params);
        return HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED);
    }
    BOOL failIfExists = params && (params->dwCopyFlags & COPY_FILE_FAIL_IF_EXISTS) != 0;
    DWORD cancelFlag = params ? params->dwCopyFlags : 0;
    (void)cancelFlag;
    if (ws_copy_file_locked(src, dst, failIfExists)) {
        ws_log_w(L"CopyFile2 staged", dst);
        return S_OK;
    }
    DWORD err = GetLastError();
    if (err == 0) err = ERROR_ACCESS_DENIED;
    return HRESULT_FROM_WIN32(err);
}

BOOL WINAPI ws_SetFileAttributesW(LPCWSTR lpFileName, DWORD dwFileAttributes)
{
    wchar_t norm[WS_PATH_MAX];
    int intercept = ws_should_intercept(lpFileName, norm, WS_PATH_MAX);
    WS_TRACE_FILE("SetFileAttributesW request raw=%ls normalized=%ls intercept=%d attrs=0x%lx",
                  lpFileName ? lpFileName : L"(null)", norm, intercept, (unsigned long)dwFileAttributes);
    if (!intercept) {
        return g_orig.SetFileAttributesW(lpFileName, dwFileAttributes);
    }
    wchar_t mapped[WS_PATH_MAX];
    uint32_t flags = 0;
    if (ws_resolve_file(norm, WINSTAGE_IO_WRITE, mapped, &flags) != 0) {
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    if (!ws_file_exists(mapped)) {
        if (!ws_file_exists(norm)) {
            SetLastError(ERROR_FILE_NOT_FOUND);
            return FALSE;
        }
        /* materialize so the attribute change is visible in the overlay */
        if (ws_mask_declared()) {
            wchar_t hlRule[256];
            if (ws_path_hardlink_alias_masked(norm, hlRule, 256) != 0) {
                ws_log_w(L"SetFileAttributes denied: hardlink alias of a masked file", norm);
                SetLastError(ERROR_ACCESS_DENIED);
                return FALSE;
            }
        }
        if (!g_orig.CopyFileW(norm, mapped, FALSE)) {
            return FALSE;
        }
    }
    BOOL ok = g_orig.SetFileAttributesW(mapped, dwFileAttributes);
    DWORD lastErr = GetLastError();
    ws_log_w(ok ? L"SetFileAttributesW staged" : L"SetFileAttributesW staged FAILED", mapped);
    SetLastError(lastErr);
    return ok;
}

/* ------------------------------------------------ stat / existence queries
 *
 * GetFileAttributes* is how runtimes ask "does this file exist?": PowerShell's
 * Test-Path, .NET File.Exists/Directory.Exists, cmd's `if exist`, CRT _access.
 * They are not file opens, so before these wrappers an existence check went
 * straight to the real disk, missed the overlay copy and made the caller skip a
 * read that would have been served from the overlay. That is the second half of
 * the redirect gap: the write was staged correctly, but the injected PowerShell
 * canary (`if (Test-Path -LiteralPath $f) { Get-Content $f }`) decided the file
 * did not exist and never opened it (no `CreateFile overlay(read)` in the log).
 *
 * Resolution mirrors a read open:
 *   !intercept          -> the real API on the caller's own path
 *   read-masked         -> look missing (existence must not leak the path)
 *   whiteout            -> look missing, ERROR_FILE_NOT_FOUND
 *   overlay copy exists -> report the OVERLAY file's attributes/data
 *   otherwise           -> report the REAL file's attributes/data
 *
 * The provider is never asked to fail closed here: a stat that cannot be
 * resolved is a read, and reads fall through to the real API.
 * ws_file_exists() deliberately keeps using the real API on the real path: it
 * decides CoW and whether a real file may be hidden, so it must never consult
 * the overlay (and it must never re-enter these wrappers). */
static int ws_stat_read_masked(LPCWSTR lpFileName)
{
    /* R20 FOLLOW-UP（P0）：设备/卷命名空间路径先映射，否则遮蔽判定看到的是
     * `\\?\GLOBALROOT\Device\…` 形态 ⇒ stat/exists 泄漏被遮蔽路径的元数据。 */
    wchar_t eff[WS_PATH_MAX];
    const wchar_t *p = lpFileName;
    if (lpFileName && lpFileName[0] && ws_path_effective(lpFileName, eff, WS_PATH_MAX)) {
        p = eff;
    }
    wchar_t maskedBy[256];
    return ws_mask_declared() && p && p[0] && ws_mask_decide_read(p, maskedBy, 256);
}

/* PowerShell's AppLocker / App-Control lock-down probe.
 *
 * Before it decides whether scripts may run, PowerShell writes
 * "%TEMP%\__PSScriptPolicyTest_<random>.ps1" and ".psm1" (PowerShell 7.x also
 * uses __PSAppLockerTest__*) and then asks whether those files exist -- measured
 * in the shim log: GetFileAttributesExW on the probe path, then
 * `if exists -> DeleteFileW`. If the existence answer is "yes" for a file whose
 * content is only in the overlay (the OS code path that PowerShell uses to
 * actually run the probe cannot see it), PowerShell concludes that script
 * execution is blocked, enters a locked-down state and refuses to load its own
 * .psm1 script modules: Write-Output, Out-File (hence every `>` redirect) and
 * Get-ChildItem all become "not recognized". Measured: 13/13 injected
 * PowerShell 5.1 startups lost their cmdlets as soon as GetFileAttributesExW
 * reported the probe files as existing, and the same binary with the stat hooks
 * disabled kept them.
 *
 * The probe asks the OS about the OS, not about the sandbox, so it keeps the
 * real filesystem's answer; every other path stays overlay-aware.
 *
 * Measured second, independent cause of the same symptom: the provider's whiteout
 * lookup counted a DIRECTORY in the wo tree as a marker, so C:\ (and every
 * ancestor directory of any whiteout) was reported deleted. Fixed in
 * ws_stage.c (ws_marker_exists) -- see tests/file-cow-dispositions.mjs c10. */
static int ws_is_lockdown_probe(const wchar_t *path)
{
    if (!path) {
        return 0;
    }
    const wchar_t *base = wcsrchr(path, L'\\');
    base = base ? base + 1 : path;
    return ws_starts_with_ci_w(base, L"__PSScriptPolicyTest_") ||
           ws_starts_with_ci_w(base, L"__PSAppLockerTest__");
}

/* Shared resolution for the stat family. Returns 1 when the caller must look
 * "missing"; otherwise 0 with `mapped` holding the path the real API should be
 * asked about and `isStaged` telling whether that path is the overlay copy. */
static int ws_stat_resolve(LPCWSTR lpFileName, wchar_t *mapped, DWORD cch, int *isStaged)
{
    *isStaged = 0;
    if (ws_is_lockdown_probe(lpFileName)) {
        /* Delegate the raw path: the real API answers, no overlay copy is offered
         * (see ws_is_lockdown_probe). */
        /* ★ round-4 诊断：探针的 stat 是"写暂存 / 看真实"这对刻意不对称的一半，
         * 这里把**真实答案**记下来，事后可与写/读两侧对齐（失败run 里我们只能看到
         * 写成功与一次 overlay 读，看不到 stat 的回答）。 */
        {
            DWORD probeAttrs = ws_real_attrs_w(lpFileName);
            DWORD probeErr = GetLastError();
            WS_DBG("lockdown-probe stat: exists=%d err=%lu path=%ls",
                   probeAttrs != INVALID_FILE_ATTRIBUTES, (unsigned long)probeErr, lpFileName);
        }
        ws_strlcpy_w(mapped, lpFileName, cch);
        return 0;
    }
    wchar_t norm[WS_PATH_MAX];
    if (!ws_should_intercept(lpFileName, norm, WS_PATH_MAX)) {
        ws_strlcpy_w(mapped, lpFileName, cch);
        return 0;
    }
    uint32_t flags = 0;
    if (ws_resolve_file(norm, WINSTAGE_IO_READ, mapped, &flags) != 0) {
        ws_strlcpy_w(mapped, norm, cch); /* real API, real path */
        return 0;
    }
    if (flags & WINSTAGE_RES_WHITEOUT) {
        return 1;
    }
    *isStaged = (flags & WINSTAGE_RES_STAGED) ? 1 : 0;
    return 0;
}

/* R11-D-13d-attr: path-only logging for the attribute/open face. ZERO semantic change:
 * no argument/return/LastError touch; the sole added work is one ws_log line, and a
 * re-entrancy guard stops a log write from recursing back through our own hooks. */
static volatile LONG g_attrLogBusy;
static void ws_attr_log(const char *api, const wchar_t *path)
{
    if (InterlockedExchange(&g_attrLogBusy, 1) != 0) {
        return;
    }
    if (path) {
        WS_DBG("ATTRDBG seq=%ld api=%s path=%ls", ws_seq(), api, path); /* R11-D-13d-seq */
    } else {
        WS_DBG("ATTRDBG api=%s path=<null>", api);
    }
    InterlockedExchange(&g_attrLogBusy, 0);
}
static void ws_attr_log_nt(const char *api, const UNICODE_STRING *us)
{
    if (InterlockedExchange(&g_attrLogBusy, 1) != 0) {
        return;
    }
    if (us && us->Buffer) {
        WS_DBG("ATTRDBG api=%s path=%.*ls", api, (int)(us->Length / sizeof(wchar_t)), us->Buffer);
    } else {
        WS_DBG("ATTRDBG api=%s path=<null>", api);
    }
    InterlockedExchange(&g_attrLogBusy, 0);
}

DWORD WINAPI ws_GetFileAttributesW(LPCWSTR lpFileName)
{
    ws_attr_log("GetFileAttributesW", lpFileName); /* R11-D-13d-attr */
    ws_callhit_named("GetFileAttributesW"); /* R11-D-13d */
    if (ws_stat_read_masked(lpFileName)) {
        WS_DBG("ATTRDBG-W branch=masked in=%ls", lpFileName); /* R11-D-13d-w */
        SetLastError(ERROR_FILE_NOT_FOUND);
        return INVALID_FILE_ATTRIBUTES;
    }
    wchar_t mapped[WS_PATH_MAX];
    int isStaged = 0;
    if (ws_stat_resolve(lpFileName, mapped, WS_PATH_MAX, &isStaged)) {
        WS_DBG("ATTRDBG-W branch=resolve-fail in=%ls", lpFileName); /* R11-D-13d-w */
        SetLastError(ERROR_FILE_NOT_FOUND);
        return INVALID_FILE_ATTRIBUTES;
    }
    DWORD attrs = ws_real_attrs_w(mapped);
    /* The trace writes the log file, which leaves ERROR_ALREADY_EXISTS in this
     * thread's last error. Save/restore it: callers legitimately read
     * GetLastError after an existence query -- the CLR does exactly that, and with
     * verbose tracing on it aborted startup with "Starting the CLR failed with
     * HRESULT 800700b7" (183, the very value the log write leaves behind). */
    DWORD lastErr = GetLastError();
    WS_TRACE_FILE("GetFileAttributesW mapped=%ls staged=%d -> attrs=0x%lx err=%lu",
                  mapped, isStaged, (unsigned long)attrs, (unsigned long)lastErr);
    WS_DBG("ATTRDBG-W rc=0 in=%ls mapped=%ls staged=%d attrs=0x%lx err=%lu", lpFileName, mapped, isStaged, (unsigned long)attrs, (unsigned long)lastErr); /* R11-D-13d-w */
    SetLastError(lastErr);
    return attrs;
}

BOOL WINAPI ws_GetFileAttributesExW(LPCWSTR lpFileName, GET_FILEEX_INFO_LEVELS level, LPVOID info)
{
    ws_attr_log("GetFileAttributesExW", lpFileName); /* R11-D-13d-attr */
    ws_callhit_named("GetFileAttributesExW"); /* R11-D-13d */
    if (ws_stat_read_masked(lpFileName)) {
        WS_DBG("ATTRDBG-ExW branch=masked in=%ls", lpFileName); /* R11-D-13d-w */
        SetLastError(ERROR_FILE_NOT_FOUND);
        return FALSE;
    }
    wchar_t mapped[WS_PATH_MAX];
    int isStaged = 0;
    if (ws_stat_resolve(lpFileName, mapped, WS_PATH_MAX, &isStaged)) {
        WS_DBG("ATTRDBG-ExW branch=resolve-fail in=%ls", lpFileName); /* R11-D-13d-w */
        SetLastError(ERROR_FILE_NOT_FOUND);
        return FALSE;
    }
    BOOL ok = ws_real_attrs_ex_w(mapped, level, info);
    DWORD lastErr = GetLastError(); /* see ws_GetFileAttributesW: the trace clobbers it */
    WS_TRACE_FILE("GetFileAttributesExW mapped=%ls staged=%d -> ok=%d err=%lu",
                  mapped, isStaged, (int)ok, (unsigned long)lastErr);
    WS_DBG("ATTRDBG-ExW rc=0 in=%ls mapped=%ls staged=%d ok=%d err=%lu", lpFileName, mapped, isStaged, (int)ok, (unsigned long)lastErr); /* R11-D-13d-w */
    SetLastError(lastErr);
    return ok;
}

DWORD WINAPI ws_GetFileAttributesA(LPCSTR lpFileName)
{
    ws_callhit_named("GetFileAttributesA"); /* R11-D-13d */
    wchar_t wide[WS_PATH_MAX];
    ws_a2w_buf(lpFileName, wide, WS_PATH_MAX);
    ws_attr_log("GetFileAttributesA", wide); /* R11-D-13d-attr */
    if (!wide[0]) {
        return g_orig.GetFileAttributesA(lpFileName);
    }
    return ws_GetFileAttributesW(wide);
}

BOOL WINAPI ws_GetFileAttributesExA(LPCSTR lpFileName, GET_FILEEX_INFO_LEVELS level, LPVOID info)
{
    ws_callhit_named("GetFileAttributesExA"); /* R11-D-13d */
    wchar_t wide[WS_PATH_MAX];
    ws_a2w_buf(lpFileName, wide, WS_PATH_MAX);
    ws_attr_log("GetFileAttributesExA", wide); /* R11-D-13d-attr */
    if (!wide[0]) {
        return g_orig.GetFileAttributesExA(lpFileName, level, info);
    }
    return ws_GetFileAttributesExW(wide, level, info);
}


/* ======================================================================== *
 *  Deletion directives that never cross DeleteFileW / RemoveDirectoryW
 *
 *  Measured (shim log, WINSTAGE_SHIM_VERBOSE=1, injected cmd.exe; see
 *  docs/边界缺陷修复-①TS档删除绕过.md §3):
 *
 *    - `del` / `erase`  -> cmd.exe's own IAT slot for DeleteFileW was patched
 *      (3 sites) and our ws_DeleteFileW was NEVER entered: cmd calls
 *      ntdll!NtOpenFile(DELETE, FILE_DELETE_ON_CLOSE|FILE_NON_DIRECTORY_FILE
 *      |FILE_OPEN_FOR_BACKUP_INTENT) and the kernel deletes the real file when
 *      the handle is closed. No NtSetInformationFile(FileDispositionInformation)
 *      call is involved.
 *    - `ren`            -> MoveFileWithProgressW (a separate export that was not
 *      hooked) -> NtOpenFile + NtSetInformationFile(FileRenameInformation=10).
 *    - `rd` (empty dir) -> RemoveDirectoryW (already hooked; measured working).
 *    - `move /y`        -> MoveFileExW (already hooked; measured working).
 *    - node (libuv) / .NET callers use DeleteFileW and/or
 *      SetFileInformationByHandle(FileDispositionInfo(Ex)) -> kernelbase's
 *      internal NtSetInformationFile.
 *
 *  Everything below funnels into ONE rule: the logical path is recorded as a
 *  deletion (whiteout) in the overlay, the real file is never touched. When the
 *  overlay cannot record it, the call fails (STATUS_ACCESS_DENIED) -- never a
 *  silent write-through. */

#define WS_NT_FILE_DIRECTORY_FILE     0x00000001u
#define WS_NT_FILE_DELETE_ON_CLOSE    0x00001000u
#define WS_FID_DISPOSITION            13u          /* FileDispositionInformation */
#define WS_FID_DISPOSITION_EX         64u          /* FileDispositionInformationEx */
#define WS_FDISPOSITION_FLAG_DELETE   0x00000001u

/* Normalized path behind a file handle (GetFinalPathNameByHandleW). */
static int ws_path_of_handle(HANDLE h, wchar_t *out, DWORD cch)
{
    /* ★ WP13（B9）：`GetFinalPathNameByHandleW` 失败时会改 last error，而本函数
     * 只用一个布尔结果回答"拿到路径没有" ⇒ 入口保存、三条出口还原。 */
    DWORD ws_saved_last_error = GetLastError();
    out[0] = 0;
    if (!h || h == INVALID_HANDLE_VALUE) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    wchar_t raw[WS_PATH_MAX];
    DWORD n = GetFinalPathNameByHandleW(h, raw, WS_PATH_MAX, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (n == 0 || n >= WS_PATH_MAX) {
        n = GetFinalPathNameByHandleW(h, raw, WS_PATH_MAX, VOLUME_NAME_DOS);
        if (n == 0 || n >= WS_PATH_MAX) {
            SetLastError(ws_saved_last_error);
            return 0;
        }
    }
    int ok = ws_normalize_path(raw, out, cch);
    SetLastError(ws_saved_last_error);
    return ok;
}

/* Inverse of the built-in provider's layout (`<root>\fs\C\a\b` -> `C:\a\b`,
 * `<root>\fs\_unc\server\share\x` -> `\\server\share\x`; ws_stage.c:34-73).
 * Needed because a delete directive can arrive on a handle that OUR OWN
 * CreateFileW hook redirected to the staged copy (libuv opens with DELETE and
 * then calls SetFileInformationByHandle), so the handle's path is the staged
 * path and the whiteout must still be written for the logical path. */
static int ws_logical_from_staged(const wchar_t *norm, wchar_t *out, DWORD cch)
{
    if (!g_ws.haveStageRoot || !g_ws.stageRoot[0]) {
        return 0;
    }
    wchar_t prefix[WS_PATH_MAX];
    size_t pos = 0;
    prefix[0] = 0;
    if (!ws_append_w(prefix, WS_PATH_MAX, &pos, g_ws.stageRoot) ||
        !ws_append_w(prefix, WS_PATH_MAX, &pos, L"\\fs\\")) {
        return 0;
    }
    if (!ws_starts_with_ci_w(norm, prefix)) {
        return 0;
    }
    const wchar_t *rest = norm + wcslen(prefix);
    pos = 0;
    out[0] = 0;
    if (ws_starts_with_ci_w(rest, L"_unc\\")) {
        return ws_append_w(out, cch, &pos, L"\\\\") && ws_append_w(out, cch, &pos, rest + 5);
    }
    /* "C\a\b" -> "C:\a\b" (only the drive letter may be a single leading char) */
    if (rest[0] && rest[1] == L'\\') {
        out[pos++] = rest[0];
        out[pos++] = L':';
        out[pos] = 0;
        return ws_append_w(out, cch, &pos, rest + 1);
    }
    return 0;
}

/* Is the REAL directory empty? Mirrors the check in ws_remove_directory_locked:
 * a directory delete must fail exactly like the real API when it is not empty. */
static int ws_real_dir_is_empty(const wchar_t *norm)
{
    /* ★ WP13（B10）：`FindFirstFileW`/`FindNextFileW`/`FindClose` 都会改 last error，
     * 而本函数只返回"空/非空"这一位布尔 ⇒ 入口保存、三条出口还原。 */
    DWORD ws_saved_last_error = GetLastError();
    wchar_t pattern[WS_PATH_MAX];
    size_t pos = 0;
    pattern[0] = 0;
    if (!ws_append_w(pattern, WS_PATH_MAX, &pos, norm) ||
        !ws_append_w(pattern, WS_PATH_MAX, &pos, L"\\*")) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(pattern, &fd);
    if (h == INVALID_HANDLE_VALUE) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    int empty = 1;
    do {
        if (wcscmp(fd.cFileName, L".") != 0 && wcscmp(fd.cFileName, L"..") != 0) {
            empty = 0;
            break;
        }
    } while (FindNextFileW(h, &fd));
    FindClose(h);
    SetLastError(ws_saved_last_error);
    return empty;
}

/* Record "the logical path has been deleted" in the overlay: drop the staged
 * copy (best effort -- the whiteout is authoritative for reads, see
 * dp_file_resolve) and write the whiteout marker. Returns 1 only when the
 * overlay really recorded it. NEVER touches the real file. */
static int ws_record_delete(const wchar_t *norm, int isDir)
{
    /* ★ WP13（B11）：`ws_resolve_file`（provider）/ `GetFileAttributesW` /
     * `RemoveDirectoryW` / `DeleteFileW` / whiteout 都会改 last error；本函数结果由
     * 返回值表达 ⇒ 出口还原。**例外**：`ERROR_DIR_NOT_EMPTY` 是刻意留给调用方的
     * 真实错误，那条出口**不还原**。 */
    DWORD ws_saved_last_error = GetLastError();
    if (!g_wsStage.file_whiteout) {
        ws_log_w(L"fail-closed delete (provider cannot whiteout)", norm);
        SetLastError(ws_saved_last_error);
        return 0;
    }
    if (isDir && !ws_real_dir_is_empty(norm)) {
        /* 刻意不还原：调用方必须看到 ERROR_DIR_NOT_EMPTY */
        SetLastError(ERROR_DIR_NOT_EMPTY);
        return 0;
    }
    wchar_t staged[WS_PATH_MAX];
    uint32_t flags = 0;
    if (ws_resolve_file(norm, WINSTAGE_IO_DELETE, staged, &flags) != 0) {
        ws_log_w(L"fail-closed delete (resolve failed)", norm);
        SetLastError(ws_saved_last_error);
        return 0;
    }
    t_wsFileBusy++;
    DWORD attrs = GetFileAttributesW(staged);
    if (attrs != INVALID_FILE_ATTRIBUTES) {
        if (attrs & FILE_ATTRIBUTE_DIRECTORY) {
            g_orig.RemoveDirectoryW(staged);
        } else {
            g_orig.DeleteFileW(staged);
        }
    }
    t_wsFileBusy--;
    if (g_wsStage.file_whiteout(norm) != 0) {
        ws_log_w(L"fail-closed delete (whiteout write failed)", norm);
        SetLastError(ws_saved_last_error);
        return 0;
    }
    SetLastError(ws_saved_last_error);
    return 1;
}

/* ntdll!NtOpenFile: the FILE_DELETE_ON_CLOSE carrier (`del`/`erase`).
 * The flag is stripped before the real open so the kernel can never delete the
 * real file; the deletion is emulated in the overlay instead. Only recorded
 * when the real open SUCCEEDED, so "delete a file that never existed" stays a
 * plain open failure with no bogus deletion candidate. */
NTSTATUS NTAPI ws_NtOpenFile(PHANDLE FileHandle, ACCESS_MASK DesiredAccess, POBJECT_ATTRIBUTES ObjectAttributes,
                             PIO_STATUS_BLOCK IoStatusBlock, ULONG ShareAccess, ULONG OpenOptions)
{
    ws_attr_log_nt("NtOpenFile", ObjectAttributes ? ObjectAttributes->ObjectName : 0); /* R11-D-13d-attr */
    ws_callhit_named("NtOpenFile"); /* R11-D-13d */
    if (t_wsFileBusy || !(OpenOptions & WS_NT_FILE_DELETE_ON_CLOSE) || !ObjectAttributes ||
        !ObjectAttributes->ObjectName || !ObjectAttributes->ObjectName->Buffer ||
        ObjectAttributes->RootDirectory) {
        return g_orig.NtOpenFile(FileHandle, DesiredAccess, ObjectAttributes, IoStatusBlock, ShareAccess, OpenOptions);
    }
    wchar_t raw[WS_PATH_MAX];
    DWORD cch = ObjectAttributes->ObjectName->Length / sizeof(wchar_t);
    if (cch >= WS_PATH_MAX) {
        cch = WS_PATH_MAX - 1;
    }
    for (DWORD i = 0; i < cch; i++) {
        raw[i] = ObjectAttributes->ObjectName->Buffer[i];
    }
    raw[cch] = 0;
    /* R20 FOLLOW-UP（P0）：delete-on-close 也必须先剥设备/卷命名空间，否则
     * `\Device\HarddiskVolumeN\…` 会被当成"设备路径"透传 ⇒ 内核真实删除。 */
    wchar_t conv[WS_PATH_MAX];
    if (ws_nt_device_to_win(raw, conv, WS_PATH_MAX)) {
        ws_strlcpy_w(raw, conv, WS_PATH_MAX);
    } else if (ws_starts_with_ci_w(raw, L"\\??\\")) {
        memmove(raw, raw + 4, (wcslen(raw + 4) + 1) * sizeof(wchar_t));
        if (ws_nt_device_to_win(raw, conv, WS_PATH_MAX)) {
            ws_strlcpy_w(raw, conv, WS_PATH_MAX);
        }
    }
    wchar_t norm[WS_PATH_MAX];
    if (!ws_should_intercept(raw, norm, WS_PATH_MAX)) {
        /* delete-on-close on an NT alias that could not be mapped to Win32: never pass
         * FILE_DELETE_ON_CLOSE through to the kernel (real disk would be deleted). */
        if (ws_is_nt_alias(raw)) {
            if (IoStatusBlock) {
                IoStatusBlock->Status = (NTSTATUS)0xC0000022; /* STATUS_ACCESS_DENIED */
                IoStatusBlock->Information = 0;
            }
            ws_log_w(L"fail-closed NtOpenFile(delete-on-close, unmapped NT alias)", raw);
            return (NTSTATUS)0xC0000022;
        }
        return g_orig.NtOpenFile(FileHandle, DesiredAccess, ObjectAttributes, IoStatusBlock, ShareAccess, OpenOptions);
    }
    WS_TRACE_FILE("NtOpenFile delete-on-close request raw=%ls normalized=%ls intercept=1 options=0x%lx",
                  raw, norm, (unsigned long)OpenOptions);
    ULONG stripped = OpenOptions & ~WS_NT_FILE_DELETE_ON_CLOSE;
    NTSTATUS st = g_orig.NtOpenFile(FileHandle, DesiredAccess, ObjectAttributes, IoStatusBlock, ShareAccess, stripped);
    if (st < 0) {
        return st; /* no file -> no whiteout (negative control) */
    }
    DWORD attrs = GetFileAttributesW(norm);
    int isDir = ((attrs != INVALID_FILE_ATTRIBUTES) && (attrs & FILE_ATTRIBUTE_DIRECTORY)) ||
                ((OpenOptions & WS_NT_FILE_DIRECTORY_FILE) != 0);
    if (!ws_record_delete(norm, isDir)) {
        if (FileHandle && *FileHandle) {
            CloseHandle(*FileHandle);
            *FileHandle = NULL;
        }
        if (IoStatusBlock) {
            IoStatusBlock->Status = (NTSTATUS)0xC0000022; /* STATUS_ACCESS_DENIED */
            IoStatusBlock->Information = 0;
        }
        ws_log_w(L"fail-closed NtOpenFile(delete-on-close)", norm);
        return (NTSTATUS)0xC0000022;
    }
    ws_log_w(L"NtOpenFile delete-on-close staged+whiteout", norm);
    return st;
}

/* ntdll!NtSetInformationFile: FileDispositionInformation(13) /
 * FileDispositionInformationEx(64) -- what SetFileInformationByHandle()
 * (kernelbase, libuv, .NET) and kernelbase's own DeleteFileW use internally. */
NTSTATUS NTAPI ws_NtSetInformationFile(HANDLE FileHandle, PIO_STATUS_BLOCK IoStatusBlock, PVOID FileInformation,
                                       ULONG Length, FILE_INFORMATION_CLASS FileInformationClass)
{
    ws_callhit_named("NtSetInformationFile"); /* R11-D-13d */
    ULONG cls = (ULONG)FileInformationClass;
    /* R17/R18: FileLinkInformation(11) is a hardlink CREATE (a write). It is
     * routed through the staged hardlink core so it can neither write the real
     * disk nor link a masked file. Handled before the disposition classes. */
    if (!t_wsFileBusy && FileHandle && cls == 11 /* FileLinkInformation */) {
        return ws_nt_set_file_link(FileHandle, IoStatusBlock, FileInformation, Length);
    }
    int wantDelete = 0;
    if (!t_wsFileBusy && FileHandle && cls == WS_FID_DISPOSITION && FileInformation &&
        Length >= sizeof(BOOLEAN)) {
        wantDelete = (*(BOOLEAN *)FileInformation) != 0;
    } else if (!t_wsFileBusy && FileHandle && cls == WS_FID_DISPOSITION_EX && FileInformation &&
               Length >= sizeof(ULONG)) {
        wantDelete = (*(ULONG *)FileInformation & WS_FDISPOSITION_FLAG_DELETE) != 0;
    }
    if (!wantDelete) {
        return g_orig.NtSetInformationFile(FileHandle, IoStatusBlock, FileInformation, Length, FileInformationClass);
    }
    wchar_t path[WS_PATH_MAX], norm[WS_PATH_MAX], logical[WS_PATH_MAX];
    if (!ws_path_of_handle(FileHandle, path, WS_PATH_MAX)) {
        /* Cannot prove the target is out of scope -> fail closed, never guess. */
        ws_log("fail-closed NtSetInformationFile(disposition): cannot resolve the path behind the handle");
        if (IoStatusBlock) {
            IoStatusBlock->Status = (NTSTATUS)0xC0000022;
            IoStatusBlock->Information = 0;
        }
        return (NTSTATUS)0xC0000022;
    }
    int isStagedCopy = 0;
    if (ws_should_intercept(path, norm, WS_PATH_MAX)) {
        /* handle opened on the REAL path (cmd's delete-on-close, NtOpenFile) */
    } else if (ws_logical_from_staged(path, logical, WS_PATH_MAX) &&
               ws_should_intercept(logical, norm, WS_PATH_MAX)) {
        /* handle opened on OUR staged copy (CreateFileW(DELETE) + disposition) */
        isStagedCopy = 1;
    } else {
        return g_orig.NtSetInformationFile(FileHandle, IoStatusBlock, FileInformation, Length, FileInformationClass);
    }
    WS_TRACE_FILE("NtSetInformationFile disposition class=%lu raw=%ls logical=%ls staged=%d",
                  (unsigned long)cls, path, norm, isStagedCopy);
    DWORD attrs = GetFileAttributesW(norm);
    int isDir = (attrs != INVALID_FILE_ATTRIBUTES) && (attrs & FILE_ATTRIBUTE_DIRECTORY);
    if (!ws_record_delete(norm, isDir)) {
        ws_log_w(L"fail-closed NtSetInformationFile(disposition)", norm);
        if (IoStatusBlock) {
            IoStatusBlock->Status = (NTSTATUS)0xC0000022;
            IoStatusBlock->Information = 0;
        }
        return (NTSTATUS)0xC0000022;
    }
    if (IoStatusBlock) {
        IoStatusBlock->Status = 0;
        IoStatusBlock->Information = 0;
    }
    ws_log_w(L"NtSetInformationFile disposition staged+whiteout", norm);
    return 0;
}

/* MoveFileWithProgressW: the export cmd's `ren` really calls (measured). */
BOOL WINAPI ws_MoveFileWithProgressW(LPCWSTR lpExistingFileName, LPCWSTR lpNewFileName,
                                     LPPROGRESS_ROUTINE lpProgressRoutine, LPVOID lpData, DWORD dwFlags)
{
    (void)lpProgressRoutine;
    (void)lpData;
    return ws_move_locked(lpExistingFileName, lpNewFileName, dwFlags);
}


/* ---------------------------------------------------------------- R11-D-13d-gfibh
 * ONE new target: GetFileInformationByHandle (count + per-call rc/err).
 * Safety: NEVER fail-closed -- if the captured original is missing we call the
 * real API directly (this module's own import table is never patched, so the
 * direct call still reaches kernel32). Counting itself does no I/O; the log is
 * LastError-transparent. */
BOOL WINAPI ws_GetFileInformationByHandle(HANDLE hFile, LPVOID lpFileInformation)
{
    ws_callhit_named("GetFileInformationByHandle");
    BOOL ok;
    if (g_orig.GetFileInformationByHandle) {
        ok = g_orig.GetFileInformationByHandle(hFile, lpFileInformation);
    } else {
        ok = GetFileInformationByHandle(hFile, (LPBY_HANDLE_FILE_INFORMATION)lpFileInformation);
    }
    DWORD e = GetLastError();
    WS_DBG("ATTRDBG-GFIBH seq=%ld handle=%p ok=%d err=%lu", ws_seq(), (void *)hFile, (int)ok, (unsigned long)e); /* R11-D-13d-seq */
    SetLastError(e);
    return ok;
}

/* ---------------------------------------------------------------- R11-D-13d-ntqif
 * ONE new ntdll target: NtQueryInformationFile (count + per-call status).
 * The original is resolved EXPLICITLY from ntdll.dll (lazily, cached); if that
 * fails we call the API directly -- this module's own import table is never
 * patched, so the direct call still reaches ntdll. NEVER fail-closed. */
static NTSTATUS(NTAPI *ws_ntqif_orig)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, int);
static volatile LONG ws_ntqifResolved;

NTSTATUS NTAPI ws_NtQueryInformationFile(HANDLE FileHandle, PIO_STATUS_BLOCK IoStatusBlock,
                                         PVOID FileInformation, ULONG Length, int FileInformationClass)
{
    ws_callhit_named("NtQueryInformationFile");
    if (!ws_ntqif_orig && InterlockedCompareExchange(&ws_ntqifResolved, 1, 0) == 0) {
        HMODULE nt = GetModuleHandleW(L"ntdll.dll");
        if (nt) {
            ws_ntqif_orig = (NTSTATUS(NTAPI *)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, int))
                GetProcAddress(nt, "NtQueryInformationFile");
        }
    }
    NTSTATUS st;
    if (ws_ntqif_orig) {
        st = ws_ntqif_orig(FileHandle, IoStatusBlock, FileInformation, Length, FileInformationClass);
    } else {
        st = NtQueryInformationFile(FileHandle, IoStatusBlock, FileInformation, Length, FileInformationClass);
    }
    WS_DBG("ATTRDBG-NTQIF seq=%ld handle=%p class=%d status=0x%lx", /* R11-D-13d-seq */
           ws_seq(), (void *)FileHandle, FileInformationClass, (unsigned long)st);
    return st;
}

/* ---------------------------------------------------------------- R11-D-13d-gfibhex
 * ONE new target: GetFileInformationByHandleEx (count + per-call ok/err).
 * NEVER fail-closed: if the captured original is missing we call the real API
 * directly (this module's own import table is never patched). Win32 family =>
 * LastError is saved/restored around the log. */
BOOL WINAPI ws_GetFileInformationByHandleEx(HANDLE hFile, int FileInformationClass,
                                           LPVOID lpFileInformation, DWORD dwBufferSize)
{
    ws_callhit_named("GetFileInformationByHandleEx");
    BOOL ok;
    if (g_orig.GetFileInformationByHandleEx) {
        ok = g_orig.GetFileInformationByHandleEx(hFile, FileInformationClass, lpFileInformation, dwBufferSize);
    } else {
        ok = GetFileInformationByHandleEx(hFile, (FILE_INFO_BY_HANDLE_CLASS)FileInformationClass,
                                          lpFileInformation, dwBufferSize);
    }
    DWORD e = GetLastError();
    WS_DBG("ATTRDBG-GFIBHEX handle=%p class=%d ok=%d err=%lu",
           (void *)hFile, FileInformationClass, (int)ok, (unsigned long)e);
    SetLastError(e);
    return ok;
}

/* ---------------------------------------------------------------- R11-D-99-attrbyname
 * D-FILE-5: overlay-aware name resolution shared by the two *attribute-by-name*
 * wrappers (NtQueryAttributesFile / NtQueryFullAttributesFile). **Neither has an
 * IoStatusBlock** -- the only outputs are the NTSTATUS and the caller's
 * FileInformation buffer -- so a whiteout is answered by the RETURN CODE
 * (0xC0000034) and, on an overlay hit, the real API fills FileInformation itself
 * from the overlay copy (that is exactly the "answer from the overlay" contract).
 *
 * Returns:
 *   -1  not attempted / untrustworthy name => caller passes the ORIGINAL through
 *    0  resolve chain ran, no overlay copy  => caller passes the ORIGINAL through
 *    1  overlay copy exists                 => caller calls the real API with `nt_out`
 *    2  whiteout                            => caller returns 0xC0000034, NO real call
 * Out params: `path_out` = logical name after the NT-prefix strip (for `path=`);
 *             `win_out`  = Win32 path produced by the resolve chain (for `mapped=`);
 *             `nt_out`   = NT object path for the real API (only meaningful when 1).
 *
 * The constraints are the measured D96/D98 ones, verbatim:
 *   - ObjectName may be NOT NUL-terminated => copy by Length;
 *   - GetFullPathNameW does NOT strip `\??\` -- it MANGLES it into `C:\??\C:\...`
 *     (D96 probe) => strip the NT prefix FIRST, then absolute-ise with the CWD;
 *   - the real API requires the NT form (`\??\C:\...` / `\??\UNC\...`); only three
 *     shapes can be converted, anything else passes the original through (never guess);
 *   - never fail-closed, never fabricate success, never touch the caller's structure. */
/* R11-D-99-v2：**重入守卫**（= 诊断件 A 的守卫，逐字保留；A 已实测救活载体）。
 * 病因已双向定案：A（仅守卫、栈不动）载体存活，B（仅缩栈、无守卫）仍 0xC00000FD
 * ⇒ 本次崩溃由**重入（递归）**造成。环（`exe` 源码级定名）：
 *   NQAF/NQFAF → ws_attrbyname_overlay → ws_stat_resolve →
 *   （仅当 ws_is_lockdown_probe(path)）ws_real_attrs_w → g_orig.GetFileAttributesW →
 *   kernelbase → NtQueryAttributesFile → **回到我们的 NQAF** ⇒ 无界递归。
 * 触发名族（PowerShell 启动会碰）：`__PSScriptPolicyTest_*` / `__PSAppLockerTest__`。
 * 同一 `_Thread_local` 标志也被 NQIFBN 包装检查/置位（同族环，见其 overlay 入口）。 */
static _Thread_local int t_wsAttrBusy;

static int ws_attrbyname_overlay(int have_orig, POBJECT_ATTRIBUTES ObjectAttributes,
                                 wchar_t *path_out, wchar_t *win_out, wchar_t *nt_out)
{
    int ret = -1;
    path_out[0] = 0;
    win_out[0] = 0;
    nt_out[0] = 0;
    if (!have_orig || t_wsFileBusy || t_wsAttrBusy || !ObjectAttributes) {
        return -1; /* original not resolved, busy, or re-entrant: pass the call through */
    }
    t_wsAttrBusy = 1; /* single entry; every exit goes through the clear below */
    do {
        const UNICODE_STRING *us = ObjectAttributes->ObjectName;
        if (!us || !us->Buffer || us->Length == 0 ||
            us->Length > (ULONG)((WS_PATH_MAX - 1) * sizeof(wchar_t)) ||
            ObjectAttributes->RootDirectory != NULL) {
            ret = -1; /* empty/oversized name, or a handle-relative name: never guess */
            break;
        }
        wchar_t nz[WS_PATH_MAX];
        wchar_t abs[WS_PATH_MAX];
        size_t n = (size_t)(us->Length / sizeof(wchar_t));
        memcpy(nz, us->Buffer, n * sizeof(wchar_t));
        nz[n] = 0;
        /* NT namespace -> Win32 (the `\\?\` strip still happens in ws_normalize_path below). */
        if (ws_starts_with_ci_w(nz, L"\\??\\UNC\\")) {
            size_t len = wcslen(nz + 8);
            nz[0] = nz[1] = L'\\';
            memmove(nz + 2, nz + 8, (len + 1) * sizeof(wchar_t));
        } else if (ws_starts_with_ci_w(nz, L"\\??\\") &&
                   ((nz[4] >= L'A' && nz[4] <= L'Z') || (nz[4] >= L'a' && nz[4] <= L'z')) &&
                   nz[5] == L':' && (nz[6] == L'\\' || nz[6] == L'/' || nz[6] == 0)) {
            size_t len = wcslen(nz + 4);
            memmove(nz, nz + 4, (len + 1) * sizeof(wchar_t));
        }
        if (ws_starts_with_ci_w(nz, L"\\Device\\") || ws_starts_with_ci_w(nz, L"\\\\.\\") ||
            ws_starts_with_ci_w(nz, L"\\??\\") || ws_starts_with_ci_w(nz, L"\\\\?\\GLOBALROOT")) {
            ret = -1; /* still in the NT namespace: Win32 cannot express it -> pass through */
            break;
        }
        ws_strlcpy_w(path_out, nz, WS_PATH_MAX);
        DWORD err_save = GetLastError();
        if (GetFullPathNameW(nz, WS_PATH_MAX, abs, NULL) == 0) {
            ws_strlcpy_w(abs, nz, WS_PATH_MAX);
        }
        SetLastError(err_save);
        int isStaged = 0;
        if (ws_stat_resolve(abs, win_out, WS_PATH_MAX, &isStaged)) {
            ret = 2; /* whiteout */
            break;
        }
        if (!isStaged || ws_wcscmp_ci(win_out, abs) == 0) {
            ret = 0; /* no overlay copy (or unchanged path): the original goes to the real API */
            break;
        }
        size_t pos = 0;
        int ok = 0;
        if (ws_starts_with_ci_w(win_out, L"\\??\\") && win_out[4]) {
            ok = ws_append_w(nt_out, WS_PATH_MAX, &pos, win_out); /* already NT: no double prefix */
        } else if (win_out[0] == L'\\' && win_out[1] == L'\\' && win_out[2] &&
                   win_out[2] != L'?' && win_out[2] != L'.') {
            ok = ws_append_w(nt_out, WS_PATH_MAX, &pos, L"\\??\\UNC\\") &&
                 ws_append_w(nt_out, WS_PATH_MAX, &pos, win_out + 2);
        } else if (((win_out[0] >= L'A' && win_out[0] <= L'Z') ||
                    (win_out[0] >= L'a' && win_out[0] <= L'z')) &&
                   win_out[1] == L':' && win_out[2] == L'\\') {
            ok = ws_append_w(nt_out, WS_PATH_MAX, &pos, L"\\??\\") &&
                 ws_append_w(nt_out, WS_PATH_MAX, &pos, win_out);
        }
        if (!ok || pos == 0) {
            nt_out[0] = 0;
            /* overlay hit but no trustworthy NT form: `mapped` keeps the overlay Win32 path,
             * `nt=<none>`, `staged=0` => the "middle state" the acceptance keys on. */
            ret = 0;
            break;
        }
        ret = 1;
    } while (0);
    t_wsAttrBusy = 0;
    return ret;
}

/* ---------------------------------------------------------------- R11-D-13d-nqaf
 * 线A#1: ONE new ntdll target, NtQueryAttributesFile (count + per-call status).
 * Explicit ntdll resolution, lazy + CAS cached; unresolved => call the API
 * directly => NEVER fail-closed. Declared explicitly: unlike NtQueryInformationFile,
 * winternl.h does NOT declare NtQueryAttributesFile (compile check caught this).
 * Zero path I/O; ntdll family => LastError is NOT wrapped. */
extern NTSTATUS NTAPI NtQueryAttributesFile(POBJECT_ATTRIBUTES, PVOID);
static NTSTATUS(NTAPI *ws_nqaf_orig)(POBJECT_ATTRIBUTES, PVOID);
static volatile LONG ws_nqafResolved;

NTSTATUS NTAPI ws_NtQueryAttributesFile(POBJECT_ATTRIBUTES ObjectAttributes, PVOID FileInformation)
{
    ws_callhit_named("NtQueryAttributesFile");
    if (!ws_nqaf_orig && InterlockedCompareExchange(&ws_nqafResolved, 1, 0) == 0) {
        HMODULE nt = GetModuleHandleW(L"ntdll.dll");
        if (nt) {
            ws_nqaf_orig = (NTSTATUS(NTAPI *)(POBJECT_ATTRIBUTES, PVOID))
                GetProcAddress(nt, "NtQueryAttributesFile");
        }
    }
    /* ------------------------------------------------- R11-D-99-nqaf (D-FILE-5)
     * overlay 感知：命中覆盖层就把**覆盖层的 NT 形态路径**交给真实 API（本 API 没有
     * IoStatusBlock ⇒ whiteout 只能用返回码回答，真实 API 自己填 FileInformation）。
     * 未命中 / 路径未变 / 名字不可信 / busy ⇒ 原样透传，绝不 fail-closed。 */
    wchar_t ws_path[WS_PATH_MAX];
    wchar_t ws_win[WS_PATH_MAX];
    wchar_t ws_nt[WS_PATH_MAX];
    int ws_r = ws_attrbyname_overlay(ws_nqaf_orig != 0, ObjectAttributes, ws_path, ws_win, ws_nt);
    if (ws_r == 2) {
        NTSTATUS ws_gone = (NTSTATUS)0xC0000034L; /* STATUS_OBJECT_NAME_NOT_FOUND */
        WS_DBG("ATTRDBG-NQAF pid=%lu handle=%p path=%ls mapped=<whiteout> nt=<none> staged=0 status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), (void *)0, ws_path, (unsigned long)ws_gone,
               (unsigned long)0, ws_seq());
        return ws_gone;
    }
    if (ws_r == 1) {
        OBJECT_ATTRIBUTES ws_oa = *ObjectAttributes;
        UNICODE_STRING ws_un;
        ws_un.Buffer = ws_nt;
        ws_un.Length = (USHORT)(wcslen(ws_nt) * sizeof(wchar_t));
        ws_un.MaximumLength = (USHORT)(ws_un.Length + sizeof(wchar_t));
        ws_oa.ObjectName = &ws_un;
        ws_oa.RootDirectory = NULL;
        NTSTATUS ws_st = ws_nqaf_orig(&ws_oa, FileInformation);
        WS_DBG("ATTRDBG-NQAF pid=%lu handle=%p path=%ls mapped=%ls nt=%ls staged=1 status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), (void *)0, ws_path, ws_win, ws_nt,
               (unsigned long)ws_st, (unsigned long)0, ws_seq());
        return ws_st;
    }
    NTSTATUS st;
    if (ws_nqaf_orig) {
        st = ws_nqaf_orig(ObjectAttributes, FileInformation);
    } else {
        st = NtQueryAttributesFile(ObjectAttributes, FileInformation);
    }
    const UNICODE_STRING *us = (ObjectAttributes ? ObjectAttributes->ObjectName : 0);
    const wchar_t *ws_map_log = (ws_r == 0 && ws_win[0]) ? ws_win : L"<none>";
    if (us && us->Buffer) {
        WS_DBG("ATTRDBG-NQAF pid=%lu handle=%p path=%.*ls mapped=%ls nt=<none> staged=%d status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), (void *)0, (int)(us->Length / sizeof(wchar_t)),
               us->Buffer, ws_map_log, ws_r, (unsigned long)st, (unsigned long)0, ws_seq());
    } else {
        WS_DBG("ATTRDBG-NQAF pid=%lu handle=%p path=<null> mapped=%ls nt=<none> staged=%d status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), (void *)0, ws_map_log, ws_r, (unsigned long)st,
               (unsigned long)0, ws_seq());
    }
    return st;
}

/* ---------------------------------------------------------------- R11-D-13d-nqfaf
 * 线A#2: ONE new ntdll target, NtQueryFullAttributesFile (count + per-call status).
 * Same safety contract as NtQueryAttributesFile: explicit ntdll resolution (lazy+CAS),
 * unresolved => direct call => NEVER fail-closed; zero path I/O; no LastError wrap;
 * winternl.h does not declare it either => explicit extern. */
extern NTSTATUS NTAPI NtQueryFullAttributesFile(POBJECT_ATTRIBUTES, PVOID);
static NTSTATUS(NTAPI *ws_nqfaf_orig)(POBJECT_ATTRIBUTES, PVOID);
static volatile LONG ws_nqfafResolved;

NTSTATUS NTAPI ws_NtQueryFullAttributesFile(POBJECT_ATTRIBUTES ObjectAttributes, PVOID FileInformation)
{
    ws_callhit_named("NtQueryFullAttributesFile");
    if (!ws_nqfaf_orig && InterlockedCompareExchange(&ws_nqfafResolved, 1, 0) == 0) {
        HMODULE nt = GetModuleHandleW(L"ntdll.dll");
        if (nt) {
            ws_nqfaf_orig = (NTSTATUS(NTAPI *)(POBJECT_ATTRIBUTES, PVOID))
                GetProcAddress(nt, "NtQueryFullAttributesFile");
        }
    }
    /* ------------------------------------------------ R11-D-99-nqfaf (D-FILE-5)
     * 与 NQAF 同口径（同一 helper）：命中覆盖层 ⇒ NT 形态换名；whiteout ⇒ 返回码答
     * `0xC0000034`（本 API 同样没有 IoStatusBlock）；其余一律原样透传。 */
    wchar_t ws_path[WS_PATH_MAX];
    wchar_t ws_win[WS_PATH_MAX];
    wchar_t ws_nt[WS_PATH_MAX];
    int ws_r = ws_attrbyname_overlay(ws_nqfaf_orig != 0, ObjectAttributes, ws_path, ws_win, ws_nt);
    if (ws_r == 2) {
        NTSTATUS ws_gone = (NTSTATUS)0xC0000034L; /* STATUS_OBJECT_NAME_NOT_FOUND */
        WS_DBG("ATTRDBG-NQFAF pid=%lu handle=%p path=%ls mapped=<whiteout> nt=<none> staged=0 status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), (void *)0, ws_path, (unsigned long)ws_gone,
               (unsigned long)0, ws_seq());
        return ws_gone;
    }
    if (ws_r == 1) {
        OBJECT_ATTRIBUTES ws_oa = *ObjectAttributes;
        UNICODE_STRING ws_un;
        ws_un.Buffer = ws_nt;
        ws_un.Length = (USHORT)(wcslen(ws_nt) * sizeof(wchar_t));
        ws_un.MaximumLength = (USHORT)(ws_un.Length + sizeof(wchar_t));
        ws_oa.ObjectName = &ws_un;
        ws_oa.RootDirectory = NULL;
        NTSTATUS ws_st = ws_nqfaf_orig(&ws_oa, FileInformation);
        WS_DBG("ATTRDBG-NQFAF pid=%lu handle=%p path=%ls mapped=%ls nt=%ls staged=1 status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), (void *)0, ws_path, ws_win, ws_nt,
               (unsigned long)ws_st, (unsigned long)0, ws_seq());
        return ws_st;
    }
    NTSTATUS st;
    if (ws_nqfaf_orig) {
        st = ws_nqfaf_orig(ObjectAttributes, FileInformation);
    } else {
        st = NtQueryFullAttributesFile(ObjectAttributes, FileInformation);
    }
    const UNICODE_STRING *us = (ObjectAttributes ? ObjectAttributes->ObjectName : 0);
    const wchar_t *ws_map_log = (ws_r == 0 && ws_win[0]) ? ws_win : L"<none>";
    if (us && us->Buffer) {
        WS_DBG("ATTRDBG-NQFAF pid=%lu handle=%p path=%.*ls mapped=%ls nt=<none> staged=%d status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), (void *)0, (int)(us->Length / sizeof(wchar_t)),
               us->Buffer, ws_map_log, ws_r, (unsigned long)st, (unsigned long)0, ws_seq());
    } else {
        WS_DBG("ATTRDBG-NQFAF pid=%lu handle=%p path=<null> mapped=%ls nt=<none> staged=%d status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), (void *)0, ws_map_log, ws_r, (unsigned long)st,
               (unsigned long)0, ws_seq());
    }
    return st;
}

/* ---------------------------------------------------------------- R11-D-13d-nqifbn
 * 线A#3 (last): ONE new ntdll target, NtQueryInformationByName (count + status).
 * Same safety contract: explicit ntdll resolution (lazy+CAS); unresolved => direct
 * call => NEVER fail-closed; zero path I/O; no LastError wrap; explicit extern
 * because winternl.h does not declare it either. */
extern NTSTATUS NTAPI NtQueryInformationByName(POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PVOID, ULONG, int);
static NTSTATUS(NTAPI *ws_nqifbn_orig)(POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PVOID, ULONG, int);
static volatile LONG ws_nqifbnResolved;

NTSTATUS NTAPI ws_NtQueryInformationByName(POBJECT_ATTRIBUTES ObjectAttributes, PIO_STATUS_BLOCK IoStatusBlock,
                                           PVOID FileInformation, ULONG Length, int FileInformationClass)
{
    ws_callhit_named("NtQueryInformationByName");
    if (!ws_nqifbn_orig && InterlockedCompareExchange(&ws_nqifbnResolved, 1, 0) == 0) {
        HMODULE nt = GetModuleHandleW(L"ntdll.dll");
        if (nt) {
            ws_nqifbn_orig = (NTSTATUS(NTAPI *)(POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PVOID, ULONG, int))
                GetProcAddress(nt, "NtQueryInformationByName");
        }
    }
    /* ------------------------------------------------------- R11-D-96-nqifbn
     * 线A#3 overlay 感知（D-FILE-6）：按名查询先问覆盖层，命中才换名。
     *
     * 三条被实测钉死的约束（不要"顺手简化"）：
     *   ① `ObjectName` 常见形态是 NT 名 `\??\C:\...`，而 `GetFullPathNameW` **不剥**
     *      `\??\`：D96 实测它把 `\??\C:\x` 编成 `C:\??\C:\x` ⇒ 必须**先**剥 NT 前缀、
     *      再绝对化，否则解析链永远 no-op；
     *   ② 相对名（`stage0-target.txt`）在 `ws_stat_resolve` 里是 no-op（D95 第 0 步：
     *      `isStaged=0`、`mapped==in`）⇒ 用 CWD 绝对化是必需步骤，不是保险；
     *   ③ `ObjectName` **不保证 NUL 结尾** ⇒ 一律按 `Length` 复制。
     *
     * 安全口径：只有 `isStaged==1`（provider 读分支，**覆盖层副本确实存在**）才换名；
     * whiteout 直接答"不存在"且不调真实 API；其余一切（未命中 / 路径未变 / orig 未解析 /
     * busy / RootDirectory 非空 / 名字为空或超长 / 任何解析失败）**原样透传**——
     * 绝不 fail-closed、绝不伪造成功、绝不就地改写调用方结构；本包装自身零路径 I/O。 */
    wchar_t ws_abs[WS_PATH_MAX];
    wchar_t ws_map[WS_PATH_MAX];
    ws_map[0] = 0;
    int ws_staged = -1; /* -1 = 没走到解析链；0 = 走到但无覆盖层副本；1 = 命中覆盖层 */
    const UNICODE_STRING *ws_us = (ObjectAttributes ? ObjectAttributes->ObjectName : 0);
    if (!t_wsFileBusy && !t_wsAttrBusy && ws_nqifbn_orig && IoStatusBlock && ObjectAttributes && ws_us && ws_us->Buffer &&
        ws_us->Length > 0 && ws_us->Length <= (ULONG)((WS_PATH_MAX - 1) * sizeof(wchar_t)) &&
        ObjectAttributes->RootDirectory == NULL) {
        wchar_t ws_nz[WS_PATH_MAX]; /* 按 Length 取值、补 NUL 后的逻辑名 */
        size_t ws_n = (size_t)(ws_us->Length / sizeof(wchar_t));
        memcpy(ws_nz, ws_us->Buffer, ws_n * sizeof(wchar_t));
        ws_nz[ws_n] = 0;
        /* NT 命名空间 -> Win32（见①；`\\?\` 的剥离仍由解析链里的 ws_normalize_path 负责）。 */
        if (ws_starts_with_ci_w(ws_nz, L"\\??\\UNC\\")) {
            size_t ws_len = wcslen(ws_nz + 8);
            ws_nz[0] = ws_nz[1] = L'\\';
            memmove(ws_nz + 2, ws_nz + 8, (ws_len + 1) * sizeof(wchar_t));
        } else if (ws_starts_with_ci_w(ws_nz, L"\\??\\") &&
                   ((ws_nz[4] >= L'A' && ws_nz[4] <= L'Z') || (ws_nz[4] >= L'a' && ws_nz[4] <= L'z')) &&
                   ws_nz[5] == L':' && (ws_nz[6] == L'\\' || ws_nz[6] == L'/' || ws_nz[6] == 0)) {
            /* 只剥**盘符绝对**形态 `\??\C:\...`：`\??\C:x.txt`（驱动器相对）与
             * `\??\Volume{...}`（卷 GUID）都不剥，落进下面的 NT 命名空间黑名单 ⇒ 透传。 */
            size_t ws_len = wcslen(ws_nz + 4);
            memmove(ws_nz, ws_nz + 4, (ws_len + 1) * sizeof(wchar_t));
        }
        /* 仍留在 NT 命名空间里的名字（`\Device\` / `\\.\` / `\??\` / GLOBALROOT）Win32
         * 解释不了，GetFullPathNameW 只会编出一个假盘符路径 ⇒ 不猜，原样透传。 */
        if (!(ws_starts_with_ci_w(ws_nz, L"\\Device\\") || ws_starts_with_ci_w(ws_nz, L"\\\\.\\") ||
              ws_starts_with_ci_w(ws_nz, L"\\??\\") || ws_starts_with_ci_w(ws_nz, L"\\\\?\\GLOBALROOT"))) {
            /* GetFullPathNameW 会改 last error ⇒ 单点保存/恢复（用法同 ws_mask.c:603）。 */
            DWORD ws_err = GetLastError();
            if (GetFullPathNameW(ws_nz, WS_PATH_MAX, ws_abs, NULL) == 0) {
                ws_strlcpy_w(ws_abs, ws_nz, WS_PATH_MAX);
            }
            SetLastError(ws_err);
            int ws_isStaged = 0;
            /* v2：同款重入守卫覆盖 NQIFBN 的**唯一**重入向量（就是这一次解析调用）——
             * 它可能经 ws_is_lockdown_probe → ws_real_attrs_w → kernelbase 回到本族包装。
             * 置位期间到达的嵌套调用在入口即 `!t_wsAttrBusy` 失败 ⇒ 原样透传，环可终止。 */
            t_wsAttrBusy = 1;
            int ws_wo = ws_stat_resolve(ws_abs, ws_map, WS_PATH_MAX, &ws_isStaged);
            t_wsAttrBusy = 0;
            if (ws_wo) {
                /* whiteout：按契约直接答"不存在"，**不调真实 API**、不伪造成功。 */
                NTSTATUS ws_gone = (NTSTATUS)0xC0000034L; /* STATUS_OBJECT_NAME_NOT_FOUND */
                IoStatusBlock->Status = ws_gone;
                IoStatusBlock->Information = 0;
                WS_DBG("ATTRDBG-NQIFBN pid=%lu handle=%p path=%ls mapped=<whiteout> nt=<none> staged=0 status=0x%lx class=%lu seq=%ld",
                       (unsigned long)GetCurrentProcessId(), (void *)0, ws_nz, (unsigned long)ws_gone,
                       (unsigned long)FileInformationClass, ws_seq());
                return ws_gone;
            }
            ws_staged = ws_isStaged;
            if (ws_isStaged && ws_wcscmp_ci(ws_map, ws_abs) != 0) {
                /* ★ D98：交回真实 API 的 ObjectName 必须是 **NT 对象路径**。
                 * 规格 §3 骨架的 `un.Buffer = mapped;`（Win32 `C:\…`）是**缺陷**：
                 * RootDirectory=NULL 时对象管理器把 `C:\…` 当成根下的 `\C:\…`
                 * ⇒ 0xC000003B（STATUS_OBJECT_PATH_SYNTAX_BAD，实测定案）。
                 * 同文件先例 ws_NtOpenFile：`\??\` 只用于自己的判断，交回真实 API 时保持 NT 原名。
                 * 只认三种可安全转换的形态，其它一律不换名、原样透传（绝不猜）。 */
                wchar_t ws_nt[WS_PATH_MAX]; /* 独立缓冲：ws_map 仍要留给 Win32 的 mapped= 日志 */
                size_t ws_ntPos = 0;
                int ws_ntOk = 0;
                ws_nt[0] = 0;
                if (ws_starts_with_ci_w(ws_map, L"\\??\\") && ws_map[4]) {
                    /* 已是 NT 形态：原样使用，不重复加前缀 */
                    ws_ntOk = ws_append_w(ws_nt, WS_PATH_MAX, &ws_ntPos, ws_map);
                } else if (ws_map[0] == L'\\' && ws_map[1] == L'\\' && ws_map[2] &&
                           ws_map[2] != L'?' && ws_map[2] != L'.') {
                    /* 真 UNC：\\server\share\p -> \??\UNC\server\share\p。
                     * `\\?\…`（含 `\\?\Volume{…}` / `\\?\GLOBALROOT…`）与 `\\.\…` 是设备命名空间，
                     * **不**属于此形态 ⇒ 落到下面 ⇒ 不换名、原样透传。 */
                    ws_ntOk = ws_append_w(ws_nt, WS_PATH_MAX, &ws_ntPos, L"\\??\\UNC\\") &&
                              ws_append_w(ws_nt, WS_PATH_MAX, &ws_ntPos, ws_map + 2);
                } else if (((ws_map[0] >= L'A' && ws_map[0] <= L'Z') ||
                            (ws_map[0] >= L'a' && ws_map[0] <= L'z')) &&
                           ws_map[1] == L':' && ws_map[2] == L'\\') {
                    /* 盘符绝对：X:\p -> \??\X:\p（大小写皆可） */
                    ws_ntOk = ws_append_w(ws_nt, WS_PATH_MAX, &ws_ntPos, L"\\??\\") &&
                              ws_append_w(ws_nt, WS_PATH_MAX, &ws_ntPos, ws_map);
                }
                /* 其它一切形态（`\\?\…`、`\\.\…`、`\Device\…`、`\\?\GLOBALROOT`、单 `\` 开头、
                 * 相对名…）都构造不出可信 NT 名 ⇒ ws_ntOk==0 ⇒ 不换名、原样透传。 */
                if (ws_ntOk && ws_ntPos > 0) {
                    /* 本地副本：ObjectName 指向**覆盖层 NT 路径**、RootDirectory=NULL，
                     * 其余字段逐字保留；Length/MaximumLength 按 NT 串重算；调用方结构一字节不动。 */
                    OBJECT_ATTRIBUTES ws_oa = *ObjectAttributes;
                    UNICODE_STRING ws_un;
                    ws_un.Buffer = ws_nt;
                    ws_un.Length = (USHORT)(ws_ntPos * sizeof(wchar_t));
                    ws_un.MaximumLength = (USHORT)(ws_un.Length + sizeof(wchar_t));
                    ws_oa.ObjectName = &ws_un;
                    ws_oa.RootDirectory = NULL;
                    NTSTATUS ws_st = ws_nqifbn_orig(&ws_oa, IoStatusBlock, FileInformation, Length, FileInformationClass);
                    WS_DBG("ATTRDBG-NQIFBN pid=%lu handle=%p path=%ls mapped=%ls nt=%ls staged=1 status=0x%lx class=%lu seq=%ld",
                           (unsigned long)GetCurrentProcessId(), (void *)0, ws_nz, ws_map, ws_nt,
                           (unsigned long)ws_st, (unsigned long)FileInformationClass, ws_seq());
                    return ws_st;
                }
                /* 无法安全构造 NT 形态 ⇒ 不换名、原样透传（日志 staged=1 / nt=<none> 可区分）。 */
            }
        }
    }

    NTSTATUS st;
    if (ws_nqifbn_orig) {
        st = ws_nqifbn_orig(ObjectAttributes, IoStatusBlock, FileInformation, Length, FileInformationClass);
    } else {
        st = NtQueryInformationByName(ObjectAttributes, IoStatusBlock, FileInformation, Length, FileInformationClass);
    }
    const UNICODE_STRING *us = (ObjectAttributes ? ObjectAttributes->ObjectName : 0);
    const wchar_t *ws_map_log = (ws_staged >= 0 && ws_map[0]) ? ws_map : L"<none>";
    if (us && us->Buffer) {
        WS_DBG("ATTRDBG-NQIFBN pid=%lu handle=%p path=%.*ls mapped=%ls nt=<none> staged=%d status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), (void *)0, (int)(us->Length / sizeof(wchar_t)),
               us->Buffer, ws_map_log, ws_staged, (unsigned long)st, (unsigned long)FileInformationClass,
               ws_seq());
    } else {
        WS_DBG("ATTRDBG-NQIFBN pid=%lu handle=%p path=<null> mapped=%ls nt=<none> staged=%d status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), (void *)0, ws_map_log, ws_staged, (unsigned long)st,
               (unsigned long)FileInformationClass, ws_seq());
    }
    return st;
}
