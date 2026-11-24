/* WinStageSandbox -- process creation + shim injection core (see ws_launch.h). */
#include "ws_launch.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <tlhelp32.h>

static void stage_copy(wchar_t *dst, size_t cch, const wchar_t *src)
{
    if (cch == 0) {
        return;
    }
    wcsncpy(dst, src ? src : L"", cch - 1);
    dst[cch - 1] = 0;
}

static void set_fail(WsLaunchResult *res, const wchar_t *stage, const wchar_t *detail, DWORD error)
{
    res->ok = 0;
    res->error = error;
    stage_copy(res->stage, WS_LAUNCH_STAGE_MAX, stage);
    stage_copy(res->detail, WS_LAUNCH_DETAIL_MAX, detail);
}

BOOL ws_resolve_executable(const wchar_t *in, wchar_t *out, DWORD cch)
{
    out[0] = 0;
    wchar_t found[4096];
    DWORD n = 0;
    if (!in || !in[0]) {
        return FALSE;
    }
    if (wcschr(in, L'\\') || wcschr(in, L'/')) {
        if (GetFileAttributesW(in) != INVALID_FILE_ATTRIBUTES) {
            n = GetFullPathNameW(in, cch, out, NULL);
            return n > 0 && n < cch;
        }
        return FALSE;
    }
    if (SearchPathW(NULL, in, NULL, 4096, found, NULL) > 0) {
        n = GetFullPathNameW(found, cch, out, NULL);
        return n > 0 && n < cch;
    }
    if (SearchPathW(NULL, in, L".exe", 4096, found, NULL) > 0) {
        n = GetFullPathNameW(found, cch, out, NULL);
        return n > 0 && n < cch;
    }
    return FALSE;
}

BOOL ws_append_quoted_arg(wchar_t *buf, size_t cap, size_t *pos, const wchar_t *arg)
{
    size_t len = wcslen(arg);
    int needQuote = (len == 0);
    for (size_t i = 0; i < len; i++) {
        if (arg[i] == L' ' || arg[i] == L'\t' || arg[i] == L'"') {
            needQuote = 1;
            break;
        }
    }
    if (*pos + 1 >= cap) {
        return FALSE;
    }
    if (needQuote) {
        buf[(*pos)++] = L'"';
    }
    size_t backslashes = 0;
    for (size_t i = 0; i < len; i++) {
        if (arg[i] == L'\\') {
            backslashes++;
            continue;
        }
        if (arg[i] == L'"') {
            for (size_t k = 0; k < backslashes * 2 + 1; k++) {
                if (*pos + 1 >= cap) return FALSE;
                buf[(*pos)++] = L'\\';
            }
            if (*pos + 1 >= cap) return FALSE;
            buf[(*pos)++] = L'"';
            backslashes = 0;
            continue;
        }
        for (size_t k = 0; k < backslashes; k++) {
            if (*pos + 1 >= cap) return FALSE;
            buf[(*pos)++] = L'\\';
        }
        backslashes = 0;
        if (*pos + 1 >= cap) return FALSE;
        buf[(*pos)++] = arg[i];
    }
    /* trailing backslashes must be doubled inside quotes */
    for (size_t k = 0; k < backslashes * (needQuote ? 2 : 1); k++) {
        if (*pos + 1 >= cap) return FALSE;
        buf[(*pos)++] = L'\\';
    }
    if (needQuote) {
        if (*pos + 1 >= cap) return FALSE;
        buf[(*pos)++] = L'"';
    }
    buf[*pos] = 0;
    return TRUE;
}

BOOL ws_build_env_block(const wchar_t *const *entries, int count, int mergeCurrent, wchar_t **out)
{
    size_t cap = 65536;
    wchar_t *block = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, cap * sizeof(wchar_t));
    if (!block) {
        return FALSE;
    }
    size_t used = 0;
    if (mergeCurrent) {
        wchar_t *cur = GetEnvironmentStringsW();
        if (!cur) {
            HeapFree(GetProcessHeap(), 0, block);
            return FALSE;
        }
        for (wchar_t *p = cur; *p; p += wcslen(p) + 1) {
            size_t len = wcslen(p);
            if (used + len + 2 >= cap) {
                break;
            }
            memcpy(block + used, p, (len + 1) * sizeof(wchar_t));
            used += len;
            block[used++] = L'\0';
        }
        FreeEnvironmentStringsW(cur);
    }
    for (int i = 0; i < count; i++) {
        const wchar_t *kv = entries[i];
        if (!kv) {
            continue;
        }
        const wchar_t *eq = wcschr(kv, L'=');
        if (!eq || eq == kv) {
            continue;
        }
        size_t nameLen = (size_t)(eq - kv);
        /* remove an existing entry with the same name (case-insensitive) */
        wchar_t *w = block;
        while (*w) {
            size_t len = wcslen(w);
            if (_wcsnicmp(w, kv, nameLen) == 0 && w[nameLen] == L'=') {
                memmove(w, w + len + 1, (used - (size_t)(w - block) - len) * sizeof(wchar_t));
                used -= len + 1;
                continue;
            }
            w += len + 1;
        }
        size_t len = wcslen(kv);
        if (used + len + 2 >= cap) {
            continue;
        }
        memcpy(block + used, kv, (len + 1) * sizeof(wchar_t));
        used += len;
        block[used++] = L'\0';
    }
    /* Environment blocks are sequence-of-NUL-terminated-strings + final NUL. */
    block[used] = L'\0';
    *out = block;
    return TRUE;
}

BOOL ws_build_environment(const wchar_t *sets[], int setCount, wchar_t **out)
{
    return ws_build_env_block((const wchar_t *const *)sets, setCount, 1, out);
}

/* Find the module base of the DLL we just loaded in the target process.
 *
 * `LoadLibraryW` in a remote thread only returns a DWORD through
 * GetExitCodeThread, which truncates a 64-bit HMODULE on x64; enumerating the
 * target's module list recovers the real base (measured, see the long comment
 * in the original injector). */
static HMODULE find_remote_module(DWORD pid, const wchar_t *dllPath)
{
    if (!dllPath) {
        return NULL;
    }
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
    if (snap == INVALID_HANDLE_VALUE) {
        return NULL;
    }
    MODULEENTRY32W me;
    memset(&me, 0, sizeof(me));
    me.dwSize = sizeof(me);
    HMODULE found = NULL;
    if (Module32FirstW(snap, &me)) {
        do {
            if (me.szExePath[0] && _wcsicmp(me.szExePath, dllPath) == 0) {
                found = (HMODULE)(void *)me.modBaseAddr;
                break;
            }
            const wchar_t *a = wcsrchr(me.szExePath, L'\\');
            const wchar_t *b = wcsrchr(dllPath, L'\\');
            if (a && b && _wcsicmp(a + 1, b + 1) == 0) {
                found = (HMODULE)(void *)me.modBaseAddr;
                break;
            }
        } while (Module32NextW(snap, &me));
    }
    CloseHandle(snap);
    return found;
}

static FARPROC resolve_remote_export(HMODULE remoteModule, const wchar_t *dllPath)
{
    if (!remoteModule || !dllPath) {
        SetLastError(ERROR_INVALID_HANDLE);
        return NULL;
    }
    HMODULE local = LoadLibraryExW(dllPath, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!local) {
        return NULL;
    }
    FARPROC localFn = GetProcAddress(local, "WinstageShimInit");
    FARPROC remoteFn = NULL;
    if (localFn) {
        remoteFn = (FARPROC)((BYTE *)(ULONG_PTR)remoteModule + ((BYTE *)localFn - (BYTE *)local));
    } else {
        SetLastError(ERROR_PROC_NOT_FOUND);
    }
    FreeLibrary(local);
    return remoteFn;
}

int ws_launch(const WsLaunchRequest *req, WsLaunchResult *res)
{
    if (!res) {
        return 0;
    }
    memset(res, 0, sizeof(*res));
    if (!req || !req->dll || !req->dll[0] || !req->exe || !req->exe[0]) {
        set_fail(res, L"args", L"missing dll or executable", ERROR_INVALID_PARAMETER);
        return 0;
    }
    DWORD timeoutMs = req->timeoutMs ? req->timeoutMs : 30000;

    wchar_t resolvedExe[4096];
    if (!ws_resolve_executable(req->exe, resolvedExe, 4096)) {
        set_fail(res, L"resolve-executable",
                 L"cannot resolve the target executable (give an absolute path; PATHEXT/App Paths are not implied)",
                 GetLastError() ? GetLastError() : ERROR_FILE_NOT_FOUND);
        return 0;
    }

    size_t clLen = 0;
    for (int k = 0; k < req->argCount; k++) {
        clLen += wcslen(req->args[k]) * 2 + 16;
    }
    clLen += wcslen(resolvedExe) * 2 + 16;
    wchar_t *cmdline = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, clLen * sizeof(wchar_t));
    if (!cmdline) {
        set_fail(res, L"alloc", L"cannot allocate command line", GetLastError());
        return 0;
    }
    size_t pos = 0;
    if (!ws_append_quoted_arg(cmdline, clLen, &pos, resolvedExe)) {
        HeapFree(GetProcessHeap(), 0, cmdline);
        set_fail(res, L"args", L"command line too long", ERROR_FILENAME_EXCED_RANGE);
        return 0;
    }
    for (int k = 0; k < req->argCount; k++) {
        if (pos + 1 >= clLen) {
            HeapFree(GetProcessHeap(), 0, cmdline);
            set_fail(res, L"args", L"command line too long", ERROR_FILENAME_EXCED_RANGE);
            return 0;
        }
        cmdline[pos++] = L' ';
        cmdline[pos] = 0;
        if (!ws_append_quoted_arg(cmdline, clLen, &pos, req->args[k])) {
            HeapFree(GetProcessHeap(), 0, cmdline);
            set_fail(res, L"args", L"command line too long", ERROR_FILENAME_EXCED_RANGE);
            return 0;
        }
    }

    if ((wcslen(req->dll) + 1) * sizeof(wchar_t) > 32767) {
        HeapFree(GetProcessHeap(), 0, cmdline);
        set_fail(res, L"args", L"dll path too long", ERROR_FILENAME_EXCED_RANGE);
        return 0;
    }

    wchar_t fullDll[4096];
    {
        DWORD n = GetFullPathNameW(req->dll, 4096, fullDll, NULL);
        if (n == 0 || n >= 4096) {
            HeapFree(GetProcessHeap(), 0, cmdline);
            set_fail(res, L"precheck", L"cannot normalize the dll path", GetLastError());
            return 0;
        }
        /* A freshly written DLL can be briefly locked by a crash handler or the
         * virus scanner; retry the existence check before declaring failure. */
        int attemptsLeft = 4;
        while (GetFileAttributesW(fullDll) == INVALID_FILE_ATTRIBUTES && attemptsLeft-- > 0) {
            Sleep(250);
        }
        if (GetFileAttributesW(fullDll) == INVALID_FILE_ATTRIBUTES) {
            DWORD err = GetLastError();
            HeapFree(GetProcessHeap(), 0, cmdline);
            set_fail(res, L"precheck",
                     (err == ERROR_PATH_NOT_FOUND || err == ERROR_FILE_NOT_FOUND)
                         ? L"dll file does not exist at the normalized path"
                         : L"dll file is not accessible (locked?)",
                     err);
            return 0;
        }
    }

    STARTUPINFOEXW six;
    PROCESS_INFORMATION pi;
    memset(&six, 0, sizeof(six));
    memset(&pi, 0, sizeof(pi));
    six.StartupInfo.cb = sizeof(six);

    DWORD creationFlags = CREATE_UNICODE_ENVIRONMENT;
    if (!req->noSuspend) {
        creationFlags |= CREATE_SUSPENDED;
    }
    if (req->noWindow && (req->forceNoWindow || !GetConsoleWindow())) {
        creationFlags |= CREATE_NO_WINDOW;
    }

    /* Only the three std handles may be inherited: the host process owns many
     * other handles (sockets, files, event loop ports) and leaking them into
     * every child would both confuse the child and keep our own files open.
     * PROC_THREAD_ATTRIBUTE_HANDLE_LIST is harmless when it fails (then the
     * plain bInheritHandles rule applies, as in the injector). */
    HANDLE inheritList[3];
    int inheritCount = 0;
    if (req->stdinHandle) inheritList[inheritCount++] = req->stdinHandle;
    if (req->stdoutHandle) inheritList[inheritCount++] = req->stdoutHandle;
    if (req->stderrHandle) inheritList[inheritCount++] = req->stderrHandle;
    if (inheritCount > 0) {
        six.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
        six.StartupInfo.hStdInput = req->stdinHandle ? req->stdinHandle : GetStdHandle(STD_INPUT_HANDLE);
        six.StartupInfo.hStdOutput = req->stdoutHandle ? req->stdoutHandle : GetStdHandle(STD_OUTPUT_HANDLE);
        six.StartupInfo.hStdError = req->stderrHandle ? req->stderrHandle : GetStdHandle(STD_ERROR_HANDLE);
    }
    LPPROC_THREAD_ATTRIBUTE_LIST attrList = NULL;
    if (inheritCount > 0 && !req->noInheritHandles) {
        SIZE_T attrBytes = 0;
        InitializeProcThreadAttributeList(NULL, 1, 0, &attrBytes);
        attrList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attrBytes);
        if (attrList &&
            InitializeProcThreadAttributeList(attrList, 1, 0, &attrBytes) &&
            UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inheritList,
                                      (SIZE_T)inheritCount * sizeof(HANDLE), NULL, NULL)) {
            six.lpAttributeList = attrList;
            creationFlags |= EXTENDED_STARTUPINFO_PRESENT;
        } else {
            if (attrList) {
                HeapFree(GetProcessHeap(), 0, attrList);
            }
            attrList = NULL;
        }
    }

    BOOL created = CreateProcessW(resolvedExe, cmdline, NULL, NULL,
                                  req->noInheritHandles ? FALSE : TRUE, creationFlags,
                                  (LPVOID)(LPCWSTR)req->envBlock, req->cwd, &six.StartupInfo, &pi);
    DWORD createError = created ? 0 : GetLastError();
    if (attrList) {
        DeleteProcThreadAttributeList(attrList);
        HeapFree(GetProcessHeap(), 0, attrList);
    }
    HeapFree(GetProcessHeap(), 0, cmdline);
    if (!created) {
        set_fail(res, L"CreateProcessW", L"cannot create the target process", createError);
        return 0;
    }

    res->pid = pi.dwProcessId;
    res->hProcess = pi.hProcess;
    res->hThread = pi.hThread;
    res->ok = 1;
    stage_copy(res->stage, WS_LAUNCH_STAGE_MAX, L"created");

    size_t dllBytes = (wcslen(fullDll) + 1) * sizeof(wchar_t);
    int injected = 0;
    if (req->noInject) {
        injected = 1;
        res->shimInitRc = 0;
        res->haveShimInitRc = 1;
    } else {
        DWORD injectErr = 0;
        void *remoteMem = VirtualAllocEx(pi.hProcess, NULL, dllBytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        SIZE_T written = 0;
        if (!remoteMem) {
            injectErr = GetLastError();
        } else if (!WriteProcessMemory(pi.hProcess, remoteMem, fullDll, dllBytes, &written) || written != dllBytes) {
            injectErr = GetLastError() ? GetLastError() : ERROR_PARTIAL_COPY;
        }
        if (!injectErr) {
            HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
            FARPROC pLoadLibraryW = GetProcAddress(k32, "LoadLibraryW");
            if (!pLoadLibraryW) {
                injectErr = ERROR_PROC_NOT_FOUND;
            } else {
                HANDLE th = CreateRemoteThread(pi.hProcess, NULL, 0,
                                               (LPTHREAD_START_ROUTINE)pLoadLibraryW, remoteMem, 0, NULL);
                if (!th) {
                    injectErr = GetLastError();
                } else {
                    DWORD wait = WaitForSingleObject(th, timeoutMs);
                    if (wait != WAIT_OBJECT_0) {
                        injectErr = ERROR_TIMEOUT;
                    } else {
                        DWORD moduleResult = 0;
                        if (!GetExitCodeThread(th, &moduleResult)) {
                            injectErr = GetLastError();
                        } else {
                            res->remoteThreadExit = moduleResult;
                            res->haveRemoteThreadExit = 1;
                            if (moduleResult == 0) {
                                injectErr = ERROR_DLL_INIT_FAILED;
                            } else {
                                res->remoteModule = find_remote_module(pi.dwProcessId, fullDll);
                                if (!res->remoteModule) {
                                    res->remoteModule = (HMODULE)(ULONG_PTR)moduleResult;
                                }
                                injected = 1;
                            }
                        }
                    }
                    CloseHandle(th);
                }
            }
        }
        if (!injected) {
            set_fail(res, L"inject-failed", L"remote LoadLibraryW failed", injectErr);
        } else if (res->remoteModule) {
            stage_copy(res->stage, WS_LAUNCH_STAGE_MAX, L"loaded");
            FARPROC remoteInit = resolve_remote_export(res->remoteModule, fullDll);
            if (!remoteInit) {
                res->shimInitFailed = 1;
                injected = 0;
                set_fail(res, L"inject-failed", L"remote WinstageShimInit failed",
                         GetLastError() ? GetLastError() : ERROR_PROC_NOT_FOUND);
            } else {
                HANDLE ith = CreateRemoteThread(pi.hProcess, NULL, 0,
                                                (LPTHREAD_START_ROUTINE)remoteInit, NULL, 0, NULL);
                if (!ith) {
                    res->shimInitFailed = 1;
                    injected = 0;
                    set_fail(res, L"inject-failed", L"remote WinstageShimInit failed", GetLastError());
                } else {
                    DWORD initWait = WaitForSingleObject(ith, timeoutMs);
                    DWORD initRc = 0;
                    if (initWait != WAIT_OBJECT_0) {
                        res->shimInitFailed = 1;
                        injected = 0;
                        set_fail(res, L"inject-failed", L"remote WinstageShimInit failed", ERROR_TIMEOUT);
                    } else if (!GetExitCodeThread(ith, &initRc)) {
                        DWORD err = GetLastError();
                        res->shimInitFailed = 1;
                        injected = 0;
                        set_fail(res, L"inject-failed", L"remote WinstageShimInit failed", err);
                    } else {
                        res->shimInitRc = initRc;
                        res->haveShimInitRc = 1;
                        if ((initRc & 0x80000000u) != 0) {
                            /* Exception exit code => hooks were not installed. */
                            res->shimInitFailed = 1;
                            injected = 0;
                            set_fail(res, L"inject-failed", L"remote WinstageShimInit failed", initRc);
                        }
                    }
                    CloseHandle(ith);
                }
            }
        }
    }

    if (!injected) {
        /* Never leave an un-injected child running (fail closed at the caller). */
        TerminateProcess(pi.hProcess, 111);
        WaitForSingleObject(pi.hProcess, 5000);
        res->ok = 0;
        return 0;
    }

    /* Kill-on-close job: the child (and its grandchildren) die when the caller
     * goes away, however it goes away. Best effort -- a host that does not allow
     * nested jobs keeps today's behaviour. */
    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli;
        memset(&jeli, 0, sizeof(jeli));
        jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli)) ||
            !AssignProcessToJobObject(job, pi.hProcess)) {
            CloseHandle(job);
            job = NULL;
        }
    }
    res->hJob = job;

    ResumeThread(pi.hThread);
    stage_copy(res->stage, WS_LAUNCH_STAGE_MAX, L"resumed");
    return 1;
}

int ws_terminate(HANDLE hProcess, UINT code)
{
    if (!hProcess) {
        return 0;
    }
    return TerminateProcess(hProcess, code) ? 1 : 0;
}
