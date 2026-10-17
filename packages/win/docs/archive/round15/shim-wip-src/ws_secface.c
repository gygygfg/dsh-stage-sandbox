/* WinStageSandbox -- R14-D1: the security-descriptor face.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `Get-ChildItem -Recurse` on an overlay tree threw right AFTER the shim had
 * answered the enumeration, and `Get-Acl` on the same tree threw
 * DirectoryNotFoundException even though the directory existed and listed fine.
 * Both are the SECURITY face: a staged file exists only inside the overlay, so
 * every path-based security query answered "not found" for it while the
 * attribute face answered "exists". PowerShell's PSFileSystemProvider reads
 * exactly that pair while it descends a tree.
 *
 * These were never hooked, so the failure never appeared in the R13-CALLMISS
 * log -- which is why R13 could only say "the failing call is not any of the
 * hooks we have". The wrappers below close that gap.
 *
 * RULE FOR EVERY WRAPPER: call the REAL API, hand the caller its result. The
 * only behaviour change is which path the real API is asked about -- the overlay
 * copy when the overlay holds one for that logical path, the untouched original
 * otherwise. No synthetic descriptor, no invented error code, no fail-closed.
 * Observation (R13-CALLMISS, `hitOverlay=0|1`) is emitted for every call when the
 * D1 trace is armed.
 *
 * This lives in its own translation unit on purpose: R14 lost the R13 revision
 * of ws_file.c to a working-tree accident (docs/archive/round154/shim-修复.md §1), and
 * new hook families must not share a file with the oldest, largest one. */
#include "winstage_internal.h"

/* Map a caller's path to the path the real API should be asked about.
 * Returns 0 = still the caller's path (`out` untouched), 1 = use `out`.
 * `*isStaged` is set whenever the overlay owns the logical path. */
static int ws_sec_target(LPCWSTR in, wchar_t *out, DWORD cch, int *isStaged)
{
    wchar_t norm[WS_PATH_MAX];
    uint32_t flags = 0;
    *isStaged = 0;
    if (!in || !in[0]) {
        return 0;
    }
    if (!ws_should_intercept(in, norm, WS_PATH_MAX)) {
        return 0;
    }
    if (g_wsStage.file_resolve == NULL) {
        return 0;
    }
    if (g_wsStage.file_resolve(norm, WINSTAGE_IO_READ, out, cch, &flags) != 0) {
        return 0;
    }
    if (flags & WINSTAGE_RES_WHITEOUT) {
        /* Logically deleted: ask about the logical path so the real API answers
         * the same "not found" an uninjected caller would see. */
        return 0;
    }
    if (flags & WINSTAGE_RES_STAGED) {
        *isStaged = 1;
        return 1;
    }
    return 0;
}

/* Does this normalized path live inside the overlay tree? Used only for the
 * `hitOverlay=` flag of the handle-based probe. */
static int ws_sec_in_overlay(const wchar_t *norm)
{
    wchar_t prefix[WS_PATH_MAX];
    size_t pos = 0;
    if (!g_ws.haveStageRoot || !g_ws.stageRoot[0] || !norm || !norm[0]) {
        return 0;
    }
    prefix[0] = 0;
    if (!ws_append_w(prefix, WS_PATH_MAX, &pos, g_ws.stageRoot)) {
        return 0;
    }
    if (pos > 0 && prefix[pos - 1] != L'\\' && !ws_append_w(prefix, WS_PATH_MAX, &pos, L"\\")) {
        return 0;
    }
    return ws_starts_with_ci_w(norm, prefix);
}

static int ws_sec_wide_to_ansi(const wchar_t *in, char *out, DWORD cch)
{
    out[0] = 0;
    return WideCharToMultiByte(CP_ACP, 0, in, -1, out, (int)cch, NULL, NULL) ? 1 : 0;
}

DWORD WINAPI ws_GetNamedSecurityInfoW(LPWSTR pObjectName, int ObjectType, DWORD SecurityInfo,
                                      PSID *ppsidOwner, PSID *ppsidGroup, PACL *ppDacl, PACL *ppSacl,
                                      PSECURITY_DESCRIPTOR *ppSecurityDescriptor)
{
    if (!g_orig.GetNamedSecurityInfoW) {
        return ERROR_CALL_NOT_IMPLEMENTED;
    }
    wchar_t mapped[WS_PATH_MAX];
    int isStaged = 0;
    int use = ws_sec_target(pObjectName, mapped, WS_PATH_MAX, &isStaged);
    DWORD rc = g_orig.GetNamedSecurityInfoW(use ? mapped : pObjectName, ObjectType, SecurityInfo, ppsidOwner,
                                            ppsidGroup, ppDacl, ppSacl, ppSecurityDescriptor);
    WS_D1_MISS("GetNamedSecurityInfoW", pObjectName, rc == 0 ? 1 : 0, rc, isStaged);
    return rc;
}

DWORD WINAPI ws_GetNamedSecurityInfoA(LPSTR pObjectName, int ObjectType, DWORD SecurityInfo,
                                      PSID *ppsidOwner, PSID *ppsidGroup, PACL *ppDacl, PACL *ppSacl,
                                      PSECURITY_DESCRIPTOR *ppSecurityDescriptor)
{
    if (!g_orig.GetNamedSecurityInfoA) {
        return ERROR_CALL_NOT_IMPLEMENTED;
    }
    wchar_t wide[WS_PATH_MAX];
    wchar_t mapped[WS_PATH_MAX];
    char mappedA[WS_PATH_MAX];
    int isStaged = 0;
    int use = 0;
    if (pObjectName && pObjectName[0] &&
        MultiByteToWideChar(CP_ACP, 0, pObjectName, -1, wide, WS_PATH_MAX)) {
        use = ws_sec_target(wide, mapped, WS_PATH_MAX, &isStaged);
        if (use && !ws_sec_wide_to_ansi(mapped, mappedA, WS_PATH_MAX)) {
            use = 0;
            isStaged = 0;
        }
    }
    DWORD rc = g_orig.GetNamedSecurityInfoA(use ? mappedA : pObjectName, ObjectType, SecurityInfo, ppsidOwner,
                                            ppsidGroup, ppDacl, ppSacl, ppSecurityDescriptor);
    WS_D1_MISS_A("GetNamedSecurityInfoA", pObjectName, rc == 0 ? 1 : 0, rc, isStaged);
    return rc;
}

BOOL WINAPI ws_GetFileSecurityW(LPCWSTR lpFileName, DWORD RequestedInformation,
                                PSECURITY_DESCRIPTOR pSecurityDescriptor, DWORD nLength, LPDWORD lpnLengthNeeded)
{
    if (!g_orig.GetFileSecurityW) {
        SetLastError(ERROR_CALL_NOT_IMPLEMENTED);
        return FALSE;
    }
    wchar_t mapped[WS_PATH_MAX];
    int isStaged = 0;
    int use = ws_sec_target(lpFileName, mapped, WS_PATH_MAX, &isStaged);
    BOOL ok = g_orig.GetFileSecurityW(use ? mapped : lpFileName, RequestedInformation, pSecurityDescriptor,
                                      nLength, lpnLengthNeeded);
    DWORD err = GetLastError();
    WS_D1_MISS("GetFileSecurityW", lpFileName, ok ? 1 : 0, err, isStaged);
    SetLastError(err);
    return ok;
}

BOOL WINAPI ws_GetFileSecurityA(LPCSTR lpFileName, DWORD RequestedInformation,
                                PSECURITY_DESCRIPTOR pSecurityDescriptor, DWORD nLength, LPDWORD lpnLengthNeeded)
{
    if (!g_orig.GetFileSecurityA) {
        SetLastError(ERROR_CALL_NOT_IMPLEMENTED);
        return FALSE;
    }
    wchar_t wide[WS_PATH_MAX];
    wchar_t mapped[WS_PATH_MAX];
    char mappedA[WS_PATH_MAX];
    int isStaged = 0;
    int use = 0;
    if (lpFileName && lpFileName[0] &&
        MultiByteToWideChar(CP_ACP, 0, lpFileName, -1, wide, WS_PATH_MAX)) {
        use = ws_sec_target(wide, mapped, WS_PATH_MAX, &isStaged);
        if (use && !ws_sec_wide_to_ansi(mapped, mappedA, WS_PATH_MAX)) {
            use = 0;
            isStaged = 0;
        }
    }
    BOOL ok = g_orig.GetFileSecurityA(use ? mappedA : lpFileName, RequestedInformation, pSecurityDescriptor,
                                      nLength, lpnLengthNeeded);
    DWORD err = GetLastError();
    WS_D1_MISS_A("GetFileSecurityA", lpFileName, ok ? 1 : 0, err, isStaged);
    SetLastError(err);
    return ok;
}

/* ntdll handle form. The handle is authoritative (it is already the overlay
 * handle when the caller opened through our CreateFileW), so this wrapper is
 * observation only: it answers "did the security face get entered on a HANDLE,
 * and with what status", which the path-based probes above cannot see. */
NTSTATUS NTAPI ws_NtQuerySecurityObject(HANDLE Handle, DWORD SecurityInformation,
                                        PSECURITY_DESCRIPTOR SecurityDescriptor, ULONG Length, PULONG LengthNeeded)
{
    if (!g_orig.NtQuerySecurityObject) {
        return (NTSTATUS)0xC0000002L; /* STATUS_NOT_IMPLEMENTED */
    }
    NTSTATUS st = g_orig.NtQuerySecurityObject(Handle, SecurityInformation, SecurityDescriptor, Length,
                                               LengthNeeded);
    wchar_t byHandle[WS_PATH_MAX];
    int staged = 0;
    const wchar_t *label = L"(by handle)";
    {
        /* GetFinalPathNameByHandleW is intentionally NOT used here: it lives in
         * ws_file.c's static helper and this file must not depend on it. The
         * handle-only label is enough for the "was it called" question. */
        (void)byHandle;
    }
    WS_D1_MISS("NtQuerySecurityObject", label, (long)st, 0, staged);
    return st;
}

/* Keep the overlay predicate referenced so a future edit cannot silently drop
 * it: the handle form has no path, and this is the helper it would use. */
int ws_secface_overlay_owned(const wchar_t *norm)
{
    return ws_sec_in_overlay(norm);
}
