/* WinStageSandbox -- R14: the D1 observation switch (see winstage_internal.h).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * R13 kept this state inside ws_file.c. R14 lost that file's R13 revision in a
 * working-tree accident (see docs/archive/round154/shim-修复.md §1), and the R14 rebuild
 * has to re-establish the pieces other translation units depend on. The switch
 * itself is self-contained, so it lives in its own file from now on: losing one
 * hook file can no longer take the trace down with it.
 *
 * WHAT IT DOES
 * ------------
 * Answers "is the R13-CALLMISS trace armed in THIS process?" and, once per
 * process, resolves it from:
 *   1. the `WINSTAGE_TRACE_D1` environment variable (0/1/2), when the host can
 *      set the carrier's environment, else
 *   2. a marker FILE the probe creates inside the overlay, which every injected
 *      process sees through the staging root:
 *        <stageRoot>\staged\r14-d1trace.on        -> level 1
 *        <stageRoot>\staged\r14-d1trace.on = "2"  -> level 2 (also trace
 *                                                    directory-form CreateFileW)
 * The marker is read with the captured original open, so no hook re-enters.
 * Once resolved the value is cached in g_wsD1Trace and the hot path pays one
 * volatile read.
 *
 * CONTRACT FOR THE EMITTERS (in winstage_internal.h): LastError-transparent,
 * re-entrancy guarded, never changes a return value. g_wsCallMissBusy is the
 * process-wide guard; ws_callmiss_try/release are its only accessors so that no
 * emitter can leave it set. */
#include "winstage_internal.h"

void ws_d1trace_probe_log(int level); /* forward: keeps this file self-contained */

static int ws_d1trace_read_marker(void)
{
    if (!g_ws.haveStageRoot || !g_ws.stageRoot[0]) {
        return 0;
    }
    wchar_t mark[WS_PATH_MAX];
    size_t pos = 0;
    mark[0] = 0;
    if (!ws_append_w(mark, WS_PATH_MAX, &pos, g_ws.stageRoot)) {
        return 0;
    }
    if (pos > 0 && mark[pos - 1] != L'\\' && !ws_append_w(mark, WS_PATH_MAX, &pos, L"\\")) {
        return 0;
    }
    if (!ws_append_w(mark, WS_PATH_MAX, &pos, L"r14-d1trace.on")) {
        return 0;
    }
    DWORD saved = GetLastError();
    HANDLE h = ws_open_file_raw_flags(mark, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL);
    if (h == INVALID_HANDLE_VALUE) {
        SetLastError(saved);
        return 0;
    }
    char buf[16];
    DWORD got = 0;
    BOOL ok = ReadFile(h, buf, sizeof(buf) - 1, &got, NULL);
    CloseHandle(h);
    SetLastError(saved);
    if (!ok || got == 0) {
        return 1; /* marker present, no level byte: level 1 */
    }
    buf[got] = 0;
    for (DWORD i = 0; i < got; i++) {
        if (buf[i] == '2') {
            return 2;
        }
        if (buf[i] == '1') {
            return 1;
        }
    }
    return 1;
}

int ws_d1trace_on(void)
{
    LONG v = g_wsD1Trace;
    if (v >= 0) {
        return (int)v;
    }
    int lvl = 0;
    wchar_t buf[8];
    DWORD n = GetEnvironmentVariableW(L"WINSTAGE_TRACE_D1", buf, 8);
    if (n > 0 && n < 8) {
        if (buf[0] == L'2') {
            lvl = 2;
        } else if (buf[0] == L'1') {
            lvl = 1;
        }
    }
    if (lvl == 0) {
        lvl = ws_d1trace_read_marker();
    }
    if (g_wsD1Trace < 0) {
        InterlockedExchange(&g_wsD1Trace, lvl);
        InterlockedExchange(&g_wsD1CfgLoaded, 1);
        ws_d1trace_probe_log(lvl);
    }
    return (int)g_wsD1Trace;
}

void ws_d1trace_probe_log(int level)
{
    /* One line per process, only when armed: makes "the trace was on in THIS
     * process" provable without turning on verbose logging everywhere. */
    if (level > 0) {
        ws_log("R14-D1TRACE armed level=%d pid=%lu", level, (unsigned long)GetCurrentProcessId());
    }
}
