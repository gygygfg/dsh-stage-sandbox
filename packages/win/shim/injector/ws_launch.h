/* WinStageSandbox -- process creation + shim injection core.
 *
 * Extracted from `winstage-inject.c` (2026-11-24) so that two callers can share
 * exactly one implementation:
 *
 *   - `winstage-inject.exe` (the helper process, kept as the fallback lane)
 *   - the host's native addon (`shim/addon/winstage-addon.c`), which creates the
 *     child **inside the harness process** so that no helper process appears in
 *     the process tree at all (`DeepSeek Harness.exe -> cmd.exe`).
 *
 * The split is deliberate: process creation, argument quoting, the remote
 * LoadLibraryW + WinstageShimInit sequence and the kill-on-close job all live
 * here, so the two callers cannot drift apart.
 */
#ifndef WINSTAGE_WS_LAUNCH_H
#define WINSTAGE_WS_LAUNCH_H

#include <windows.h>

#ifdef __cplusplus
extern "C" {
#endif

#define WS_LAUNCH_STAGE_MAX  64
#define WS_LAUNCH_DETAIL_MAX 512

typedef struct WsLaunchRequest {
    const wchar_t *dll;         /* shim DLL, required (absolute is best) */
    const wchar_t *exe;         /* target executable: absolute path or bare name */
    const wchar_t *const *args; /* argv[1..argCount]; argv[0] is derived from exe */
    int argCount;
    const wchar_t *cwd;         /* NULL = inherit */
    const wchar_t *envBlock;    /* CREATE_UNICODE_ENVIRONMENT block, NULL = inherit */
    HANDLE stdinHandle;         /* NULL = inherit */
    HANDLE stdoutHandle;        /* NULL = inherit */
    HANDLE stderrHandle;        /* NULL = inherit */
    DWORD timeoutMs;            /* injection timeouts (0 => 30000) */
    int noInject;               /* diagnostic: create + resume without the remote load */
    int noSuspend;              /* diagnostic: do not CREATE_SUSPENDED */
    int noInheritHandles;       /* diagnostic: bInheritHandles=FALSE */
    int noWindow;               /* CREATE_NO_WINDOW when we own no console */
    int forceNoWindow;          /* CREATE_NO_WINDOW even if a console exists (host lane) */
} WsLaunchRequest;

typedef struct WsLaunchResult {
    int ok;             /* 1 = child created, injected and resumed */
    DWORD pid;
    HANDLE hProcess;    /* handed to the caller (never closed here) */
    HANDLE hThread;     /* already resumed; caller closes it */
    HANDLE hJob;        /* kill-on-close job, or NULL; caller owns it */
    HMODULE remoteModule;
    DWORD error;        /* Win32 / injection error */
    DWORD remoteThreadExit;
    int haveRemoteThreadExit;
    DWORD shimInitRc;
    int haveShimInitRc;
    int shimInitFailed;
    wchar_t stage[WS_LAUNCH_STAGE_MAX];   /* where it stopped */
    wchar_t detail[WS_LAUNCH_DETAIL_MAX]; /* human-readable reason */
} WsLaunchResult;

/* Resolve like CreateProcessW would NOT (SearchPathW + ".exe"), or accept an
 * absolute/relative path that exists. */
BOOL ws_resolve_executable(const wchar_t *in, wchar_t *out, DWORD cch);

/* Append one argument with the CommandLineToArgvW/MSVCRT quoting rules. */
BOOL ws_append_quoted_arg(wchar_t *buf, size_t cap, size_t *pos, const wchar_t *arg);

/* Build an environment block from NAME=VALUE entries. `mergeCurrent` starts from
 * this process's own environment (the CLI injector's contract); 0 produces
 * exactly the given entries (what `spawn(env)` does for the native lane). */
BOOL ws_build_env_block(const wchar_t *const *entries, int count, int mergeCurrent,
                        wchar_t **out);

/* Convenience wrapper: ws_build_env_block(sets, count, 1, out). */
BOOL ws_build_environment(const wchar_t *sets[], int setCount, wchar_t **out);

/* Create the child suspended, inject the DLL, call WinstageShimInit remotely,
 * assign a kill-on-close job and resume the main thread. Returns 1 on success. */
int ws_launch(const WsLaunchRequest *req, WsLaunchResult *res);

/* Terminate a child created by ws_launch (whole tree, via the job). */
int ws_terminate(HANDLE hProcess, UINT code);

#ifdef __cplusplus
}
#endif

#endif /* WINSTAGE_WS_LAUNCH_H */
