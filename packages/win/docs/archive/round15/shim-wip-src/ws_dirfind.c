/* WinStageSandbox -- R12-P0: overlay-aware Win32 directory enumeration.
 *
 * THE DEFECT THIS FIXES
 * ---------------------
 * Measured on the golden DLL (.t/r12/accept/out2): inside the sandbox an
 * overlay-only directory is invisible to every enumeration API --
 *
 *   Get-ChildItem  $ws\A            -> DirectoryNotFoundException
 *   [IO.Directory]::GetFiles($ws\A) -> DirectoryNotFoundException
 *   Get-ChildItem  $ws              -> only the real seed, overlay entries gone
 *   [IO.Directory]::Delete($ws\A,true) -> fails (recursive delete enumerates)
 *
 * while the attribute face and direct reads are correct (Test-Path, Exists,
 * GetAttributes, ReadAllText). Root cause: g_targets[] in ws_hook.c contained
 * only GetFileAttributes*, so enumeration fell straight through to the real
 * disk, which does not contain the staged tree.
 *
 * DESIGN (why Win32 and not NtQueryDirectoryFile)
 * -----------------------------------------------
 * The previous attempt hooked NtQueryDirectoryFile and merged in the NT
 * information-class buffer. It was measured to be *installed but never entered*
 * (kernel32/kernelbase import ntdll!NtQueryDirectoryFile, but the Win32
 * FindFirstFile* implementation does not reach the kernel through those import
 * slots), it needed a shared merge engine in a second file, and it shipped a
 * launch-mode regression. This file instead hooks the seam callers actually
 * enter: FindFirstFileW / FindFirstFileExW / FindNextFileW / FindClose.
 *
 *   - The request "dir\pattern" is split into D and P.
 *   - The real directory D is enumerated with the ORIGINAL API (preserving the
 *     caller's FINDEX_INFO_LEVELS, and therefore its alignment expectation).
 *   - The staged directory map(D) = <stageRoot>\fs\<drive-colon-dropped path> is
 *     enumerated when it exists. Two files: <stageRoot>\fs\... is the staged body,
 *     <stageRoot>\wo\... is a whiteout marker ("logically deleted").
 *   - The two name lists are merged case-insensitively; a staged entry REPLACES
 *     the real entry of the same name (staged wins, including its size/times).
 *   - An entry whose logical path is whiteouted (real GetFileAttributesW on the
 *     logical path reports "missing", because dp_file_resolve answers WHITEOUT
 *     before it answers STAGED) is dropped -- that is the `Remove-Item` case.
 *   - The union is filtered by the caller's pattern and then handed out through
 *     a synthetic handle. Unknown handles are passed to the real API untouched:
 *     we never guess about a handle we did not create.
 *
 * RE-ENTRANCY
 * -----------
 * The shim's own module is NEVER in the patched set (ws_hook_install skips
 * g_selfModule), so our FindFirstFileW/GetFileAttributesW calls below reach the
 * real kernel32/kernelbase implementations directly. On top of that the
 * enumeration helpers below ask for the CAPTURED ORIGINAL through g_orig, and
 * t_selfWalk is a belt-and-braces guard: if a call ever re-enters this file
 * while a walk is in progress, it is forwarded verbatim to the original.
 *
 * FAILURE SEMANTICS
 * -----------------
 * The real API is authoritative for whether a search succeeds: when D is
 * missing from BOTH layers we return INVALID_HANDLE_VALUE and set
 * ERROR_FILE_NOT_FOUND (we never invent a directory on the real disk just to
 * enumerate). Patterns that are not name-match searches, and searches that
 * cannot be mapped into the overlay at all, are forwarded untouched.
 */
#include "winstage_internal.h"
#include <stdio.h>

#define WS_FIND_MAX 64

typedef struct WsFindEntry {
    WCHAR name[260];
    DWORD attrs;
    DWORD sizeHigh;
    DWORD sizeLow;
    FILETIME creation;
    FILETIME access;
    FILETIME write;
} WsFindEntry;

typedef struct WsFind {
    HANDLE h;   /* synthetic handle == a real event object we own */
    int count;
    int pos;    /* next entry to hand out */
    WsFindEntry *e;
} WsFind;

static WsFind g_find[WS_FIND_MAX];
static int g_findN;
static volatile LONG g_findLock;

/* R14-D1: which directories have been REPORTED as merged views. Purely
 * diagnostic: it answers "did the walk reach this directory and did we answer
 * it with an overlay-aware view" in one grep. Capped: extra directories are
 * dropped rather than costing anything (the cap only ever trims log detail). */
#define WS_FIND_DESC_MAX 64
static wchar_t g_described[WS_FIND_DESC_MAX][WS_PATH_MAX];
static int g_describedN;
static volatile LONG g_describeLock;

void ws_dirfind_describe(const wchar_t *dir)
{
    if (!dir || !dir[0]) {
        return;
    }
    while (InterlockedCompareExchange(&g_describeLock, 1, 0) != 0) {
        SwitchToThread();
    }
    for (int i = 0; i < g_describedN; i++) {
        if (ws_wcscmp_ci(g_described[i], dir) == 0) {
            InterlockedExchange(&g_describeLock, 0);
            return;
        }
    }
    if (g_describedN < WS_FIND_DESC_MAX) {
        ws_strlcpy_w(g_described[g_describedN], dir, WS_PATH_MAX);
        g_describedN++;
    }
    InterlockedExchange(&g_describeLock, 0);
    ws_log("R14-DIR real-created path=%ls n=%d", dir, g_describedN);
}

/* Re-entrancy guard for our own walks. THREAD-LOCAL on purpose: a process-global
 * counter can be left set by any thread that dies inside a guard, and every
 * later enumeration on every thread would then silently fall through to the real
 * disk (measured: FindFirstFileW n=5 with zero merged views). */
static _Thread_local int t_selfWalk;

/* A plain spin lock. These critical sections are pure memory work: no I/O, no
 * logging, no lock nesting, so a spin here cannot deadlock. */
static void ws_find_lock(void)
{
    while (InterlockedCompareExchange(&g_findLock, 1, 0) != 0) {
        SwitchToThread();
    }
}

static void ws_find_unlock(void)
{
    InterlockedExchange(&g_findLock, 0);
}

static WsFind *ws_find_lookup(HANDLE h)
{
    if (!h || h == INVALID_HANDLE_VALUE) {
        return NULL;
    }
    for (int i = 0; i < g_findN; i++) {
        if (g_find[i].h == h) {
            return &g_find[i];
        }
    }
    return NULL;
}

/* Whiteout marker is authoritative for BOTH layers (R12 review defect D2):
 * deleting a REAL file leaves a marker under <stageRoot>\wo\... while the bytes
 * stay on the real disk, so the real-side listing must consult it too -- the
 * staged-side check alone never fires for that case (there is no same-named
 * staged entry to filter). */
static int ws_logical_deleted(const wchar_t *logical)
{
    if (g_wsStage.file_whiteouted == NULL) {
        return 0;
    }
    return g_wsStage.file_whiteouted(logical) == 1 ? 1 : 0;
}

/* The whiteout decision, asked of the REAL API: dp_file_resolve answers
 * WINSTAGE_RES_WHITEOUT for a read before it answers STAGED, so a whiteouted
 * logical path reports INVALID_FILE_ATTRIBUTES here even while its bytes are
 * still on the real disk. t_selfWalk keeps this probe from recursing. */
static int ws_logical_present(const wchar_t *logical)
{
    DWORD saved = GetLastError();
    t_selfWalk++;
    DWORD a = g_orig.GetFileAttributesW ? g_orig.GetFileAttributesW(logical)
                                        : GetFileAttributesW(logical);
    t_selfWalk--;
    SetLastError(saved);
    return a != INVALID_FILE_ATTRIBUTES;
}

/* ------------------------------------------------------------ real API calls */

static HANDLE ws_real_first_w(const wchar_t *path, LPWIN32_FIND_DATAW data)
{
    if (g_orig.FindFirstFileW) {
        return g_orig.FindFirstFileW(path, data);
    }
    return FindFirstFileW(path, data);
}

static BOOL ws_real_next_w(HANDLE h, LPWIN32_FIND_DATAW data)
{
    if (g_orig.FindNextFileW) {
        return g_orig.FindNextFileW(h, data);
    }
    return FindNextFileW(h, data);
}

static BOOL ws_real_close(HANDLE h)
{
    if (g_orig.FindClose) {
        return g_orig.FindClose(h);
    }
    return FindClose(h);
}

/* --------------------------------------------------------- path translation */

/* "C:\a\b" -> "<stageRoot>\fs\C\a\b"; UNC "\\srv\sh\f" -> "<root>\fs\_unc\srv\sh\f".
 * Mirrors ws_stage.c's ws_fs_map() exactly (the colon is dropped from the drive). */
static int ws_stage_map(const wchar_t *norm, const wchar_t *leaf, wchar_t *out, DWORD cch)
{
    if (!g_ws.haveStageRoot || !g_ws.stageRoot[0]) {
        return 0;
    }
    size_t pos = 0;
    out[0] = 0;
    if (!ws_append_w(out, cch, &pos, g_ws.stageRoot) ||
        !ws_append_w(out, cch, &pos, L"\\") ||
        !ws_append_w(out, cch, &pos, leaf)) {
        return 0;
    }
    if (norm[0] == L'\\' && norm[1] == L'\\') {
        if (!ws_append_w(out, cch, &pos, L"\\_unc\\") ||
            !ws_append_w(out, cch, &pos, norm + 2)) {
            return 0;
        }
        return 1;
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

/* Join "<dir>\<name>" without doubling a separator. */
static void ws_join_wname(const wchar_t *dir, const wchar_t *name, wchar_t *out, DWORD cch)
{
    size_t pos = 0;
    out[0] = 0;
    ws_append_w(out, cch, &pos, dir);
    if (pos > 0 && out[pos - 1] != L'\\') {
        ws_append_w(out, cch, &pos, L"\\");
    }
    ws_append_w(out, cch, &pos, name);
}

/* "<root>\fs\...\D" + "\" + "*" -> the staged search path. */
static void ws_stage_search_path(const wchar_t *stageDir, wchar_t *out, DWORD cch)
{
    size_t pos = 0;
    out[0] = 0;
    ws_append_w(out, cch, &pos, stageDir);
    if (pos > 0 && out[pos - 1] != L'\\') {
        ws_append_w(out, cch, &pos, L"\\");
    }
    ws_append_w(out, cch, &pos, L"*");
}

/* -------------------------------------------------------------- name matching */

static WCHAR ws_lower_w(WCHAR c)
{
    if (c >= L'A' && c <= L'Z') {
        return (WCHAR)(c - L'A' + L'a');
    }
    return c;
}

/* Win32 wildcard match: '?' matches exactly one character, '*' any run.
 * Case-insensitive. This is what FindFirstFileW("dir\*.txt") needs. */
static int ws_match_w(const wchar_t *pat, const wchar_t *name)
{
    while (*pat) {
        if (*pat == L'*') {
            pat++;
            if (!*pat) {
                return 1;
            }
            for (const wchar_t *t = name; ; t++) {
                if (ws_match_w(pat, t)) {
                    return 1;
                }
                if (!*t) {
                    return 0;
                }
            }
        }
        if (!*name) {
            return 0;
        }
        if (*pat != L'?' && ws_lower_w(*pat) != ws_lower_w(*name)) {
            return 0;
        }
        pat++;
        name++;
    }
    return *name == 0;
}

/* --------------------------------------------------------------- view builder */

static int ws_ent_equal_ci(const wchar_t *a, const wchar_t *b)
{
    for (;; a++, b++) {
        WCHAR ca = ws_lower_w(*a);
        WCHAR cb = ws_lower_w(*b);
        if (ca != cb) {
            return 0;
        }
        if (!ca) {
            return 1;
        }
    }
}

static void ws_ent_from_data(WsFindEntry *e, const WIN32_FIND_DATAW *d)
{
    int i = 0;
    for (; i < 259 && d->cFileName[i]; i++) {
        e->name[i] = d->cFileName[i];
    }
    e->name[i] = 0;
    e->attrs = d->dwFileAttributes;
    e->sizeHigh = d->nFileSizeHigh;
    e->sizeLow = d->nFileSizeLow;
    e->creation = d->ftCreationTime;
    e->access = d->ftLastAccessTime;
    e->write = d->ftLastWriteTime;
}

static void ws_ent_to_data(const WsFindEntry *e, WIN32_FIND_DATAW *d)
{
    memset(d, 0, sizeof(*d));
    d->dwFileAttributes = e->attrs;
    d->nFileSizeHigh = e->sizeHigh;
    d->nFileSizeLow = e->sizeLow;
    d->ftCreationTime = e->creation;
    d->ftLastAccessTime = e->access;
    d->ftLastWriteTime = e->write;
    int i = 0;
    for (; i < 259 && e->name[i]; i++) {
        d->cFileName[i] = e->name[i];
    }
    d->cFileName[i] = 0;
    /* cAlternateFileName intentionally left zero-filled. */
}

/* Grow the entry list by one. HeapReAlloc(NULL, ...) is NOT malloc: it fails
 * with ERROR_INVALID_PARAMETER, which silently produced an EMPTY merged view for
 * every directory (measured: "entries=0 first=1 raw=3 allocFail=1", and the
 * carrier then reported ".NET Framework is not installed" because
 * C:\Windows\Microsoft.NET\Framework64 enumerated as empty). */
static WsFindEntry *ws_ent_grow(WsFindEntry *ents, int count)
{
    SIZE_T bytes = (SIZE_T)(count + 1) * sizeof(WsFindEntry);
    if (!ents) {
        return (WsFindEntry *)HeapAlloc(GetProcessHeap(), 0, bytes);
    }
    return (WsFindEntry *)HeapReAlloc(GetProcessHeap(), 0, ents, bytes);
}

/* Does the caller's "dir\pattern" resolve to a directory we may enumerate?
 * Returns 1 and fills dir/pattern. 0 = the real API must answer untouched. */
static int ws_find_split(LPCWSTR lpFileName, wchar_t *dir, DWORD dirCch,
                         wchar_t *pattern, DWORD patCch)
{
    wchar_t norm[WS_PATH_MAX];
    if (!lpFileName || !lpFileName[0]) {
        return 0;
    }
    /* ws_should_intercept() rejects device names, paths already inside the
     * staging tree, passthrough prefixes and a missing stage root; it also
     * resolves relative paths against the process CWD. */
    if (!ws_should_intercept(lpFileName, norm, WS_PATH_MAX)) {
        return 0;
    }
    size_t n = wcslen(norm);
    while (n > 0 && norm[n - 1] == L'\\') {
        norm[--n] = 0; /* "C:\a\" == "C:\a\*" */
    }
    if (n == 0) {
        return 0;
    }
    const wchar_t *slash = wcsrchr(norm, L'\\');
    if (!slash) {
        return 0;
    }
    size_t dirLen = (size_t)(slash - norm);
    const wchar_t *pat = slash + 1;
    if (dirLen == 0) {
        /* "\pattern" on the current drive: the root itself. */
        ws_strlcpy_w(dir, L"\\", dirCch);
    } else {
        if (dirLen >= dirCch) {
            return 0;
        }
        memcpy(dir, norm, dirLen * sizeof(wchar_t));
        dir[dirLen] = 0;
    }
    if (!pat[0] || !wcscmp(pat, L"*") || !wcscmp(pat, L"*.*")) {
        pattern[0] = 0; /* match everything */
    } else {
        ws_strlcpy_w(pattern, pat, patCch);
    }
    return 1;
}

/* Build the merged view for "dir\pattern".
 * Returns 0 = caller must forward to the real API, 1 = merged view (possibly
 * empty) and *outCount set, 2 = the search cannot succeed at all.
 *
 * `realNeedsWildcard` is 1 for FindFirstFileW, whose contract is that
 * lpFileName may be a plain file name: the real call must then be issued
 * against "dir\*" while our own filter still applies `pattern`. */
static int ws_find_build(LPCWSTR lpFileName, FINDEX_INFO_LEVELS level, int realNeedsWildcard,
                         WsFindEntry **out, int *outCount, int *outDeleted)
{
    wchar_t dir[WS_PATH_MAX];
    wchar_t pattern[WS_PATH_MAX];
    *out = NULL;
    *outCount = 0;
    *outDeleted = 0;

    if (!ws_find_split(lpFileName, dir, WS_PATH_MAX, pattern, WS_PATH_MAX)) {
        return 0;
    }

    /* A LITERAL name is a plain existence query ("...\v4.0.30319"), not a
     * listing. The real API already answers it through the overlay's own
     * decided path (the attribute face), and re-answering it from a merged list
     * would invent a different answer for a name whose staged copy is not
     * materialised -- measured: PowerShell's .NET probe asks for the literal
     * Framework64 version directory and must see the same thing
     * GetFileAttributesW reports. Only wildcard searches are merged.
     *
     * R12 review defect D1: passthrough is only safe while the REAL path
     * exists -- then the real answer and the overlay agree. For an overlay-only
     * path (staged file/dir with no real counterpart) the real search answers
     * ERROR_FILE_NOT_FOUND, which contradicts GetFileAttributesW and breaks
     * callers that walk a tree by name (measured: `Get-ChildItem -Recurse`
     * throws Win32Exception on an overlay-only subtree while every level on its
     * own lists fine). So serve the single staged entry ourselves in that case. */
    if (pattern[0] && !wcschr(pattern, L'*') && !wcschr(pattern, L'?')) {
        DWORD realAttrsLit;
        t_selfWalk++;
        realAttrsLit = g_orig.GetFileAttributesW ? g_orig.GetFileAttributesW(lpFileName)
                                                 : GetFileAttributesW(lpFileName);
        t_selfWalk--;
        if (realAttrsLit != INVALID_FILE_ATTRIBUTES) {
            return 0;
        }
        wchar_t litStageDir[WS_PATH_MAX];
        wchar_t litStageChild[WS_PATH_MAX];
        if (!ws_stage_map(dir, L"fs", litStageDir, WS_PATH_MAX)) {
            return 0;
        }
        ws_join_wname(litStageDir, pattern, litStageChild, WS_PATH_MAX);
        WIN32_FIND_DATAW lwfd;
        HANDLE lh;
        memset(&lwfd, 0, sizeof(lwfd));
        t_selfWalk++;
        wchar_t litStageExt[WS_PATH_MAX];
        const wchar_t *litUse = ws_extend_path(litStageChild, litStageExt, WS_PATH_MAX) ? litStageExt
                                                                                        : litStageChild;
        lh = ws_real_first_w(litUse, &lwfd);
        if (lh != INVALID_HANDLE_VALUE) {
            ws_real_close(lh);
        }
        t_selfWalk--;
        if (lh == INVALID_HANDLE_VALUE || !lwfd.cFileName[0]) {
            return 0;
        }
        WsFindEntry *one = (WsFindEntry *)HeapAlloc(GetProcessHeap(), 0, sizeof(WsFindEntry));
        if (!one) {
            return 0;
        }
        memset(one, 0, sizeof(*one));
        ws_ent_from_data(one, &lwfd);
        ws_strlcpy_w(one->name, pattern, 260);
        *out = one;
        *outCount = 1;
        *outDeleted = 0;
        return 1;
    }

    /* The staged directory this logical directory maps to. */
    wchar_t stageDir[WS_PATH_MAX];
    int haveStage = ws_stage_map(dir, L"fs", stageDir, WS_PATH_MAX);

    wchar_t realSearch[WS_PATH_MAX];
    if (realNeedsWildcard) {
        size_t pos = 0;
        realSearch[0] = 0;
        if (!ws_append_w(realSearch, WS_PATH_MAX, &pos, dir) ||
            !ws_append_w(realSearch, WS_PATH_MAX, &pos, L"\\*")) {
            return 0;
        }
    } else {
        ws_strlcpy_w(realSearch, lpFileName, WS_PATH_MAX);
    }

    /* Directory existence, asked without going through the hooks. */
    t_selfWalk++;
    DWORD realAttrs = g_orig.GetFileAttributesW ? g_orig.GetFileAttributesW(dir)
                                                : GetFileAttributesW(dir);
    t_selfWalk--;

    WsFindEntry *ents = NULL;
    int count = 0;
    DWORD realErr = ERROR_FILE_NOT_FOUND;
    int realListed = 0;
    int realFirstOk = 0;
    int realRaw = 0;
    int realSkipped = 0;
    int realAllocFail = 0;

    if (realAttrs != INVALID_FILE_ATTRIBUTES && (realAttrs & FILE_ATTRIBUTE_DIRECTORY)) {
        WIN32_FIND_DATAW wfd;
        memset(&wfd, 0, sizeof(wfd));
        /* R13-P2 follow-up: the search string can itself cross MAX_PATH once the
         * logical directory is deep (`dir` is the caller's logical path here, but
         * the staged search below is always long). Hand the real API the `\\?\`
         * form whenever the string is long enough to need it. */
        wchar_t realSearchExt[WS_PATH_MAX];
        const wchar_t *searchUse = ws_extend_path(realSearch, realSearchExt, WS_PATH_MAX) ? realSearchExt
                                                                                         : realSearch;
        HANDLE h = ws_real_first_w(searchUse, &wfd);
        if (h == INVALID_HANDLE_VALUE) {
            realErr = GetLastError();
        } else {
            realListed = 1;
            realFirstOk = 1;
            for (;;) {
                realRaw++;
                if (wfd.cFileName[0] && wcscmp(wfd.cFileName, L".") && wcscmp(wfd.cFileName, L"..")) {
                    /* R12-D2: a whiteouted name must never be listed, even when
                     * its bytes are still on the real disk. */
                    wchar_t realLogical[WS_PATH_MAX];
                    ws_join_wname(dir, wfd.cFileName, realLogical, WS_PATH_MAX);
                    if (ws_logical_deleted(realLogical)) {
                        realSkipped++;
                    } else {
                        WsFindEntry *p = ws_ent_grow(ents, count);
                        if (!p) {
                            realAllocFail = 1;
                            break;
                        }
                        ents = p;
                        ws_ent_from_data(&ents[count], &wfd);
                        count++;
                    }
                } else {
                    realSkipped++;
                }
                memset(&wfd, 0, sizeof(wfd));
                if (!ws_real_next_w(h, &wfd)) {
                    break;
                }
            }
            ws_real_close(h);
        }
    } else if (realAttrs != INVALID_FILE_ATTRIBUTES) {
        /* "dir\pattern" where dir is actually a file: no directory to list. */
        realErr = ERROR_PATH_NOT_FOUND;
    }

    /* Staged layer: union in names that are not already present (real entries
     * win only when the staged copy carries the identical name, which is the
     * case that must prefer the staged body). We build a separate list and then
     * let staged entries replace real ones by name. */
    if (haveStage) {
        wchar_t stageAttrsProbe[WS_PATH_MAX];
        wchar_t stageAttrsExt[WS_PATH_MAX];
        ws_strlcpy_w(stageAttrsProbe, stageDir, WS_PATH_MAX);
        const wchar_t *stageProbeUse =
            ws_extend_path(stageAttrsProbe, stageAttrsExt, WS_PATH_MAX) ? stageAttrsExt : stageAttrsProbe;
        t_selfWalk++;
        DWORD sattrs = g_orig.GetFileAttributesW ? g_orig.GetFileAttributesW(stageProbeUse)
                                                 : GetFileAttributesW(stageProbeUse);
        t_selfWalk--;
        if (sattrs != INVALID_FILE_ATTRIBUTES && (sattrs & FILE_ATTRIBUTE_DIRECTORY)) {
            wchar_t stageSearch[WS_PATH_MAX];
            wchar_t stageSearchExt[WS_PATH_MAX];
            ws_stage_search_path(stageDir, stageSearch, WS_PATH_MAX);
            const wchar_t *stageUse = ws_extend_path(stageSearch, stageSearchExt, WS_PATH_MAX) ? stageSearchExt
                                                                                               : stageSearch;
            WIN32_FIND_DATAW wfd;
            memset(&wfd, 0, sizeof(wfd));
            HANDLE h = ws_real_first_w(stageUse, &wfd);
            if (h != INVALID_HANDLE_VALUE) {
                for (;;) {
                    if (wfd.cFileName[0] && wcscmp(wfd.cFileName, L".") && wcscmp(wfd.cFileName, L"..") &&
                        (pattern[0] == 0 || ws_match_w(pattern, wfd.cFileName))) {
                        WsFindEntry cand;
                        ws_ent_from_data(&cand, &wfd);
                        /* Whiteout: the logical path is gone even if the bytes
                         * are still in the staged body. */
                        wchar_t logical[WS_PATH_MAX];
                        ws_join_wname(dir, cand.name, logical, WS_PATH_MAX);
                        if (ws_logical_present(logical) && !ws_logical_deleted(logical)) {
                            int idx = -1;
                            for (int k = 0; k < count; k++) {
                                if (ws_ent_equal_ci(ents[k].name, cand.name)) {
                                    idx = k;
                                    break;
                                }
                            }
                            if (idx >= 0) {
                                ents[idx] = cand; /* staged wins: body + metadata */
                            } else {
                                WsFindEntry *p = ws_ent_grow(ents, count);
                                if (!p) {
                                    break;
                                }
                                ents = p;
                                ents[count] = cand;
                                count++;
                            }
                        }
                    }
                    memset(&wfd, 0, sizeof(wfd));
                    if (!ws_real_next_w(h, &wfd)) {
                        break;
                    }
                }
                ws_real_close(h);
            }
        }
    }

    /* No layer has the directory: report "not found" rather than an empty
     * successful search, so callers keep the real DirectoryNotFoundException. */
    if (!realListed && count == 0) {
        if (ents) {
            HeapFree(GetProcessHeap(), 0, ents);
        }
        *outDeleted = 1;
        SetLastError(realErr != ERROR_SUCCESS ? realErr : ERROR_FILE_NOT_FOUND);
        return 2;
    }

    if (ents && pattern[0]) {
        /* Staged entries were filtered while collecting; the real entries were
         * requested with the caller's own pattern (or the '*' we synthesised),
         * so filter the whole list once for the synthesised case only. */
        if (realNeedsWildcard) {
            int w = 0;
            for (int k = 0; k < count; k++) {
                if (ws_match_w(pattern, ents[k].name)) {
                    ents[w++] = ents[k];
                }
            }
            count = w;
        }
    }

    *out = ents;
    *outCount = count;
    ws_log("R12-DIR build dir=%ls pattern=%ls real=%d stage=%d entries=%d first=%d raw=%d skipped=%d allocFail=%d err=%lu",
           dir, pattern, realListed, haveStage, count, realFirstOk, realRaw, realSkipped, realAllocFail,
           (unsigned long)realErr);
    return 1;
}
/* ------------------------------------------------------------------ handles */

/* Create a slot. Returns NULL when the table is exhausted or the allocation
 * failed; the caller then degrades to the real API or to ERROR_NOT_ENOUGH_MEMORY. */
static WsFind *ws_find_new_slot(HANDLE *outHandle)
{
    if (g_findN >= WS_FIND_MAX) {
        return NULL;
    }
    HANDLE ev = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!ev) {
        return NULL;
    }
    WsFind *f = &g_find[g_findN];
    memset(f, 0, sizeof(*f));
    f->h = ev;
    g_findN++;
    *outHandle = ev;
    return f;
}

static void ws_find_release(WsFind *f)
{
    if (!f) {
        return;
    }
    if (f->e) {
        HeapFree(GetProcessHeap(), 0, f->e);
    }
    HANDLE h = f->h;
    for (int i = 0; i < g_findN; i++) {
        if (&g_find[i] == f) {
            g_find[i] = g_find[g_findN - 1];
            /* The moved slot must not keep a stale event handle or the old
             * caller's heap pointer: ws_find_lookup() matches on f->h, so a
             * leftover there would hand another caller's enumeration to us. */
            memset(&g_find[g_findN - 1], 0, sizeof(WsFind));
            g_findN--;
            break;
        }
    }
    if (h) {
        CloseHandle(h);
    }
}

/* Install a merged view into a fresh slot and hand back its first entry.
 * Returns the synthetic handle, or INVALID_HANDLE_VALUE with the error set. */
static HANDLE ws_find_publish(WsFindEntry *ents, int count, LPWIN32_FIND_DATAW lpFindFileData)
{
    if (count == 0) {
        if (ents) {
            HeapFree(GetProcessHeap(), 0, ents);
        }
        SetLastError(ERROR_FILE_NOT_FOUND);
        return INVALID_HANDLE_VALUE;
    }
    ws_find_lock();
    HANDLE res = INVALID_HANDLE_VALUE;
    WsFind *f = ws_find_new_slot(&res);
    if (!f) {
        ws_find_unlock();
        HeapFree(GetProcessHeap(), 0, ents);
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return INVALID_HANDLE_VALUE;
    }
    f->e = ents;
    f->count = count;
    f->pos = 1;
    ws_ent_to_data(&f->e[0], lpFindFileData);
    ws_find_unlock();
    return res;
}

/* --------------------------------------------------------------- entry points */

HANDLE WINAPI ws_FindFirstFileW(LPCWSTR lpFileName, LPWIN32_FIND_DATAW lpFindFileData)
{
    ws_callhit_named("FindFirstFileW");
    if (t_selfWalk || !lpFindFileData) {
        return ws_real_first_w(lpFileName, lpFindFileData);
    }
    DWORD saved = GetLastError();
    WsFindEntry *ents = NULL;
    int count = 0;
    int deleted = 0;
    int rc = ws_find_build(lpFileName, FindExInfoStandard, 1, &ents, &count, &deleted);

    if (rc == 2) {
        WS_D1_MISS("FindFirstFileW(build)", lpFileName, 0, 0, 0);
        return INVALID_HANDLE_VALUE; /* last error already set by the builder */
    }
    if (rc == 0) {
        SetLastError(saved);
        HANDLE rh = ws_real_first_w(lpFileName, lpFindFileData);
        DWORD re = GetLastError();
        /* R13-D1: this is the pass-through that can answer NOT_FOUND for an
         * overlay path the attribute face reports as present. */
        if (rh == INVALID_HANDLE_VALUE) {
            ws_callmiss("FindFirstFileW(pass)", lpFileName, 0, re, "path=passthrough");
        }
        WS_D1_MISS("FindFirstFileW(pass)", lpFileName, rh == INVALID_HANDLE_VALUE ? 0 : 1, re, 0);
        SetLastError(re);
        return rh;
    }
    HANDLE h = ws_find_publish(ents, count, lpFindFileData);
    if (h == INVALID_HANDLE_VALUE) {
        DWORD pe = GetLastError();
        ws_callmiss("FindFirstFileW(publish)", lpFileName, 0, pe, "path=merged-empty");
        WS_D1_MISS("FindFirstFileW(publish)", lpFileName, 0, pe, 1);
        SetLastError(pe);
        return h; /* ERROR_FILE_NOT_FOUND / ERROR_NOT_ENOUGH_MEMORY */
    }
    WS_D1_MISS("FindFirstFileW", lpFileName, 1, 0, 1);
    ws_log("R12-DIR FindFirstFileW path=%ls entries=%d handle=%p", lpFileName, count, (void *)h);
    SetLastError(saved);
    return h;
}

HANDLE WINAPI ws_FindFirstFileExW(LPCWSTR lpFileName, FINDEX_INFO_LEVELS fInfoLevelId,
                                  LPVOID lpFindFileData, FINDEX_SEARCH_OPS fSearchOp,
                                  LPVOID lpSearchFilter, DWORD dwAdditionalFlags)
{
    ws_callhit_named("FindFirstFileExW");
    if (t_selfWalk || !lpFindFileData) {
        return g_orig.FindFirstFileExW(lpFileName, fInfoLevelId, lpFindFileData, fSearchOp,
                                       lpSearchFilter, dwAdditionalFlags);
    }
    if (fSearchOp != FindExSearchNameMatch) {
        /* FindExSearchLimitToDirectories / LimitToDevices have no overlay
         * analogue: keep the real behaviour rather than guess. */
        return g_orig.FindFirstFileExW(lpFileName, fInfoLevelId, lpFindFileData, fSearchOp,
                                       lpSearchFilter, dwAdditionalFlags);
    }
    DWORD saved = GetLastError();
    WsFindEntry *ents = NULL;
    int count = 0;
    int deleted = 0;
    int rc = ws_find_build(lpFileName, fInfoLevelId, 0, &ents, &count, &deleted);
    if (rc == 2) {
        ws_callmiss("FindFirstFileExW(build)", lpFileName, 0, GetLastError(), "path=no-layer-has-dir");
        WS_D1_MISS("FindFirstFileExW(build)", lpFileName, 0, 0, 0);
        return INVALID_HANDLE_VALUE;
    }
    if (rc == 0) {
        SetLastError(saved);
        HANDLE rh = g_orig.FindFirstFileExW(lpFileName, fInfoLevelId, lpFindFileData, fSearchOp,
                                            lpSearchFilter, dwAdditionalFlags);
        DWORD re = GetLastError();
        if (rh == INVALID_HANDLE_VALUE) {
            ws_callmiss("FindFirstFileExW(pass)", lpFileName, 0, re, "path=passthrough");
        }
        WS_D1_MISS("FindFirstFileExW(pass)", lpFileName, rh == INVALID_HANDLE_VALUE ? 0 : 1, re, 0);
        SetLastError(re);
        return rh;
    }
    /* Hand out a real slot even though this entry point cannot return a handle:
     * its caller passes its own iterator (or the value it kept) straight to
     * FindNextFileW/FindClose, and a made-up non-handle there is handed to the
     * real API by our own pass-through path. A slot keeps the remainder valid. */
    HANDLE h = ws_find_publish(ents, count, (LPWIN32_FIND_DATAW)lpFindFileData);
    if (h == INVALID_HANDLE_VALUE) {
        DWORD pe = GetLastError();
        ws_callmiss("FindFirstFileExW(publish)", lpFileName, 0, pe, "path=merged-empty");
        WS_D1_MISS("FindFirstFileExW(publish)", lpFileName, 0, pe, 1);
        SetLastError(pe);
        return h;
    }
    WS_D1_MISS("FindFirstFileExW", lpFileName, 1, 0, 1);
    ws_log("R12-DIR FindFirstFileExW path=%ls level=%d entries=%d handle=%p",
           lpFileName, (int)fInfoLevelId, count, (void *)h);
    SetLastError(saved);
    return h;
}

BOOL WINAPI ws_FindNextFileW(HANDLE hFindFile, LPWIN32_FIND_DATAW lpFindFileData)
{
    ws_callhit_named("FindNextFileW");
    if (t_selfWalk || !lpFindFileData) {
        return ws_real_next_w(hFindFile, lpFindFileData);
    }
    ws_find_lock();
    WsFind *f = ws_find_lookup(hFindFile);
    if (!f) {
        ws_find_unlock();
        /* A handle we did not create: the real API owns its semantics. */
        BOOL rn = ws_real_next_w(hFindFile, lpFindFileData);
        DWORD rne = GetLastError();
        SetLastError(rne);
        return rn;
    }
    if (f->pos >= f->count) {
        ws_find_unlock();
        SetLastError(ERROR_NO_MORE_FILES);
        return FALSE;
    }
    ws_ent_to_data(&f->e[f->pos], lpFindFileData);
    f->pos++;
    ws_find_unlock();
    return TRUE;
}

BOOL WINAPI ws_FindClose(HANDLE hFindFile)
{
    ws_callhit_named("FindClose");
    if (t_selfWalk) {
        return ws_real_close(hFindFile);
    }
    ws_find_lock();
    WsFind *f = ws_find_lookup(hFindFile);
    if (f) {
        ws_find_release(f);
        ws_find_unlock();
        return TRUE;
    }
    ws_find_unlock();
    return ws_real_close(hFindFile);
}

/* ------------------------------------------------- R13-D1 observe-only hooks
 * FindFirstFileA / FindFirstFileExA: PASS-THROUGH, byte for byte. They exist so
 * one diagnostic run can answer "does the failing caller use the ANSI face?"
 * without changing any answer. The trace is written on BOTH outcomes and is
 * gated on WINSTAGE_TRACE_D1=1, so on a normal run these hooks cost one env
 * lookup (cached) and one comparison. */
HANDLE WINAPI ws_FindFirstFileA(LPCSTR lpFileName, LPWIN32_FIND_DATAA lpFindFileData)
{
    HANDLE h = g_orig.FindFirstFileA ? g_orig.FindFirstFileA(lpFileName, lpFindFileData)
                                     : FindFirstFileA(lpFileName, lpFindFileData);
    DWORD e = GetLastError();
    char extra[192];
    if (lpFindFileData) {
        char name[128];
        int i = 0;
        for (; i < 127 && lpFindFileData->cFileName[i]; i++) {
            name[i] = lpFindFileData->cFileName[i];
        }
        name[i] = 0;
        snprintf(extra, sizeof(extra), "path=ansi-observe first=%s", name);
    } else {
        snprintf(extra, sizeof(extra), "path=ansi-observe first=<no-buffer>");
    }
    ws_callmiss_a("FindFirstFileA(observe)", lpFileName, h == INVALID_HANDLE_VALUE ? 0 : 1, e, extra);
    SetLastError(e);
    return h;
}
HANDLE WINAPI ws_FindFirstFileExA(LPCSTR lpFileName, FINDEX_INFO_LEVELS fInfoLevelId, LPVOID lpFindFileData,
                                  FINDEX_SEARCH_OPS fSearchOp, LPVOID lpSearchFilter, DWORD dwAdditionalFlags)
{
    HANDLE h = g_orig.FindFirstFileExA
                   ? g_orig.FindFirstFileExA(lpFileName, fInfoLevelId, lpFindFileData, fSearchOp,
                                             lpSearchFilter, dwAdditionalFlags)
                   : FindFirstFileExA(lpFileName, fInfoLevelId, lpFindFileData, fSearchOp, lpSearchFilter,
                                      dwAdditionalFlags);
    DWORD e = GetLastError();
    char extra[128];
    snprintf(extra, sizeof(extra), "path=ansi-observe level=%d op=%d", (int)fInfoLevelId, (int)fSearchOp);
    ws_callmiss_a("FindFirstFileExA(observe)", lpFileName, h == INVALID_HANDLE_VALUE ? 0 : 1, e, extra);
    SetLastError(e);
    return h;
}
