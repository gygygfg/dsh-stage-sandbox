/* WinStageSandbox -- host-side native addon (N-API).
 *
 * WHY THIS EXISTS (2026-11-24)
 * ----------------------------
 * The transparent lane used to spawn `bin\elevate.exe` (winstage-inject.exe) for
 * every command, so an agent that listed processes saw
 *
 *     DeepSeek Harness.exe -> elevate.exe -- cmd.exe /d /c ...\run-<hex>.cmd
 *
 * Renaming the helper made the names neutral, but the extra process itself is
 * still visible. PPID spoofing (PROC_THREAD_ATTRIBUTE_PARENT_PROCESS) was tried
 * twice and both times broke the shim init ("remote WinstageShimInit failed"),
 * so the only way to remove the layer is to create the child **in the harness
 * process**. This addon does exactly that: it runs the same ws_launch() core
 * the CLI injector uses and hands the PID back to JS.
 *
 * The addon deliberately links against **no** libnode import library: every
 * N-API entry point is resolved with GetProcAddress from the host module. That
 * keeps the build to a single `zig cc -shared` (no node-gyp/MSVC/node.lib) and
 * makes the same binary work under node.exe, electron.exe or any renamed host
 * (the harness ships as `DeepSeek Harness.exe`).
 */
#include <windows.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <uchar.h>
#include <wchar.h>

#include "../injector/ws_launch.h"

/* ── minimal N-API surface (stable ABI; no headers, no import library) ────── */
typedef void *napi_env;
typedef void *napi_value;
typedef void *napi_callback_info;
typedef int napi_status;
typedef napi_value (*ws_napi_callback)(napi_env, napi_callback_info);

#define NAPI_OK 0
#define NAPI_UNDEFINED 0

typedef napi_status (*napi_get_cb_info_fn)(napi_env, napi_callback_info, size_t *, napi_value *,
                                           napi_value *, void **);
typedef napi_status (*napi_typeof_fn)(napi_env, napi_value, int *);
typedef napi_status (*napi_get_undefined_fn)(napi_env, napi_value *);
typedef napi_status (*napi_get_null_fn)(napi_env, napi_value *);
typedef napi_status (*napi_create_object_fn)(napi_env, napi_value *);
typedef napi_status (*napi_create_function_fn)(napi_env, const char *, size_t, ws_napi_callback,
                                              void *, napi_value *);
typedef napi_status (*napi_set_named_property_fn)(napi_env, napi_value, const char *, napi_value);
typedef napi_status (*napi_get_named_property_fn)(napi_env, napi_value, const char *, napi_value *);
typedef napi_status (*napi_get_property_names_fn)(napi_env, napi_value, napi_value *);
typedef napi_status (*napi_get_element_fn)(napi_env, napi_value, uint32_t, napi_value *);
typedef napi_status (*napi_get_array_length_fn)(napi_env, napi_value, uint32_t *);
typedef napi_status (*napi_is_array_fn)(napi_env, napi_value, bool *);
typedef napi_status (*napi_get_value_string_utf16_fn)(napi_env, napi_value, char16_t *, size_t,
                                                      size_t *);
typedef napi_status (*napi_get_value_string_utf8_fn)(napi_env, napi_value, char *, size_t, size_t *);
typedef napi_status (*napi_get_value_uint32_fn)(napi_env, napi_value, uint32_t *);
typedef napi_status (*napi_get_value_bool_fn)(napi_env, napi_value, bool *);
typedef napi_status (*napi_create_uint32_fn)(napi_env, uint32_t, napi_value *);
typedef napi_status (*napi_create_int32_fn)(napi_env, int32_t, napi_value *);
typedef napi_status (*napi_create_string_utf8_fn)(napi_env, const char *, size_t, napi_value *);
typedef napi_status (*napi_throw_error_fn)(napi_env, const char *, const char *);

/* N-API length sentinel for "NUL-terminated" (node_api.h: NAPI_AUTO_LENGTH). */
#define NAPI_AUTO_LENGTH ((size_t)-1)

typedef struct {
    napi_get_cb_info_fn get_cb_info;
    napi_typeof_fn type_of;
    napi_get_undefined_fn get_undefined;
    napi_get_null_fn get_null;
    napi_create_object_fn create_object;
    napi_create_function_fn create_function;
    napi_set_named_property_fn set_named_property;
    napi_get_named_property_fn get_named_property;
    napi_get_property_names_fn get_property_names;
    napi_get_element_fn get_element;
    napi_get_array_length_fn get_array_length;
    napi_is_array_fn is_array;
    napi_get_value_string_utf16_fn get_value_string_utf16;
    napi_get_value_string_utf8_fn get_value_string_utf8;
    napi_get_value_uint32_fn get_value_uint32;
    napi_get_value_bool_fn get_value_bool;
    napi_create_uint32_fn create_uint32;
    napi_create_int32_fn create_int32;
    napi_create_string_utf8_fn create_string_utf8;
    napi_throw_error_fn throw_error;
} NapiApi;

static NapiApi g_napi;
static int g_napi_ready = 0;

static FARPROC host_symbol(const char *name)
{
    static const wchar_t *modules[] = { NULL, L"node.dll", L"libnode.dll" };
    for (size_t i = 0; i < sizeof(modules) / sizeof(modules[0]); i++) {
        HMODULE h = modules[i] ? GetModuleHandleW(modules[i]) : GetModuleHandleW(NULL);
        if (!h) {
            continue;
        }
        FARPROC fn = GetProcAddress(h, name);
        if (fn) {
            return fn;
        }
    }
    return NULL;
}

static int napi_resolve(void)
{
    if (g_napi_ready) {
        return g_napi_ready > 0;
    }
#define RESOLVE(field, type, name)                                     \
    do {                                                               \
        g_napi.field = (type)host_symbol(name);                        \
        if (!g_napi.field) {                                           \
            g_napi_ready = -1;                                         \
            return 0;                                                  \
        }                                                              \
    } while (0)
    RESOLVE(get_cb_info, napi_get_cb_info_fn, "napi_get_cb_info");
    RESOLVE(type_of, napi_typeof_fn, "napi_typeof");
    RESOLVE(get_undefined, napi_get_undefined_fn, "napi_get_undefined");
    RESOLVE(get_null, napi_get_null_fn, "napi_get_null");
    RESOLVE(create_object, napi_create_object_fn, "napi_create_object");
    RESOLVE(create_function, napi_create_function_fn, "napi_create_function");
    RESOLVE(set_named_property, napi_set_named_property_fn, "napi_set_named_property");
    RESOLVE(get_named_property, napi_get_named_property_fn, "napi_get_named_property");
    RESOLVE(get_property_names, napi_get_property_names_fn, "napi_get_property_names");
    RESOLVE(get_element, napi_get_element_fn, "napi_get_element");
    RESOLVE(get_array_length, napi_get_array_length_fn, "napi_get_array_length");
    RESOLVE(is_array, napi_is_array_fn, "napi_is_array");
    RESOLVE(get_value_string_utf16, napi_get_value_string_utf16_fn, "napi_get_value_string_utf16");
    RESOLVE(get_value_string_utf8, napi_get_value_string_utf8_fn, "napi_get_value_string_utf8");
    RESOLVE(get_value_uint32, napi_get_value_uint32_fn, "napi_get_value_uint32");
    RESOLVE(get_value_bool, napi_get_value_bool_fn, "napi_get_value_bool");
    RESOLVE(create_uint32, napi_create_uint32_fn, "napi_create_uint32");
    RESOLVE(create_int32, napi_create_int32_fn, "napi_create_int32");
    RESOLVE(create_string_utf8, napi_create_string_utf8_fn, "napi_create_string_utf8");
    RESOLVE(throw_error, napi_throw_error_fn, "napi_throw_error");
#undef RESOLVE
    g_napi_ready = 1;
    return 1;
}

/* ── small helpers ───────────────────────────────────────────────────────── */
static wchar_t *wcs_from_value(napi_env env, napi_value value)
{
    size_t len = 0;
    if (!value || g_napi.get_value_string_utf16(env, value, NULL, 0, &len) != NAPI_OK) {
        return NULL;
    }
    wchar_t *buf = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (len + 1) * sizeof(wchar_t));
    if (!buf) {
        return NULL;
    }
    size_t copied = 0;
    if (g_napi.get_value_string_utf16(env, value, (char16_t *)buf, len + 1, &copied) != NAPI_OK) {
        HeapFree(GetProcessHeap(), 0, buf);
        return NULL;
    }
    buf[copied] = 0;
    return buf;
}

/** Read an optional string property; returns NULL when absent/null/not a string. */
static wchar_t *prop_wstring(napi_env env, napi_value obj, const char *name)
{
    napi_value value = NULL;
    if (!obj || g_napi.get_named_property(env, obj, name, &value) != NAPI_OK || !value) {
        return NULL;
    }
    int type = 0;
    if (g_napi.type_of(env, value, &type) != NAPI_OK || type != 4 /* napi_string */) {
        return NULL;
    }
    return wcs_from_value(env, value);
}

static int prop_uint(napi_env env, napi_value obj, const char *name, uint32_t *out)
{
    napi_value value = NULL;
    if (!obj || g_napi.get_named_property(env, obj, name, &value) != NAPI_OK || !value) {
        return 0;
    }
    int type = 0;
    if (g_napi.type_of(env, value, &type) != NAPI_OK || type != 3 /* napi_number */) {
        return 0;
    }
    return g_napi.get_value_uint32(env, value, out) == NAPI_OK;
}

static napi_value make_uint(napi_env env, uint32_t v)
{
    napi_value out = NULL;
    if (g_napi.create_uint32(env, v, &out) != NAPI_OK) {
        out = NULL;
    }
    return out;
}

static void throw_text(napi_env env, const char *message)
{
    g_napi.throw_error(env, NULL, message);
}

static HANDLE open_capture(const wchar_t *path)
{
    if (!path) {
        return NULL;
    }
    SECURITY_ATTRIBUTES sa;
    memset(&sa, 0, sizeof(sa));
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    return CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, CREATE_ALWAYS,
                       FILE_ATTRIBUTE_NORMAL, NULL);
}

static void write_json_file(const wchar_t *path, const char *json)
{
    if (!path) {
        return;
    }
    HANDLE h = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        return;
    }
    DWORD wrote = 0;
    WriteFile(h, json, (DWORD)strlen(json), &wrote, NULL);
    CloseHandle(h);
}

static void json_escape(const wchar_t *text, char *out, size_t cch)
{
    char utf8[4096];
    utf8[0] = 0;
    WideCharToMultiByte(CP_UTF8, 0, text ? text : L"", -1, utf8, sizeof(utf8), NULL, NULL);
    size_t o = 0;
    for (size_t i = 0; utf8[i] && o + 3 < cch; i++) {
        if (utf8[i] == '\\' || utf8[i] == '"') {
            out[o++] = '\\';
        }
        out[o++] = utf8[i];
    }
    out[o] = 0;
}

/* ── live child table (the JS side polls; no threads, no uv handles) ─────── */
#define WS_SLOT_MAX 64
typedef struct {
    int used;
    DWORD pid;
    HANDLE hProcess;
    HANDLE hJob;
} Slot;

static Slot g_slots[WS_SLOT_MAX];
static SRWLOCK g_slot_lock = SRWLOCK_INIT;

static Slot *slot_alloc(void)
{
    for (int i = 0; i < WS_SLOT_MAX; i++) {
        if (!g_slots[i].used) {
            memset(&g_slots[i], 0, sizeof(g_slots[i]));
            g_slots[i].used = 1;
            return &g_slots[i];
        }
    }
    return NULL;
}

/* ── launch(options) -> { pid } ──────────────────────────────────────────── */
static napi_value addon_launch(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1] = { NULL };
    g_napi.get_cb_info(env, info, &argc, argv, NULL, NULL);
    if (argc < 1 || !argv[0]) {
        throw_text(env, "launch(): missing options object");
        return NULL;
    }

    wchar_t *dll = prop_wstring(env, argv[0], "dll");
    wchar_t *exe = prop_wstring(env, argv[0], "exe");
    wchar_t *cwd = prop_wstring(env, argv[0], "cwd");
    wchar_t *stdoutPath = prop_wstring(env, argv[0], "stdoutPath");
    wchar_t *stderrPath = prop_wstring(env, argv[0], "stderrPath");
    wchar_t *stdinText = prop_wstring(env, argv[0], "stdin");
    wchar_t *reportPath = prop_wstring(env, argv[0], "reportPath");
    uint32_t timeoutMs = 30000;
    prop_uint(env, argv[0], "timeoutMs", &timeoutMs);

    napi_value rc = NULL;
    char errbuf[1024];
    wchar_t **args = NULL;
    int argCount = 0;
    wchar_t *envBlock = NULL;
    HANDLE outHandle = NULL;
    HANDLE errHandle = NULL;
    HANDLE stdinRead = NULL;
    HANDLE stdinWrite = NULL;

    if (!dll || !exe) {
        throw_text(env, "launch(): 'dll' and 'exe' are required strings");
        goto cleanup;
    }

    /* args: array of strings */
    {
        napi_value arr = NULL;
        bool isArr = false;
        if (g_napi.get_named_property(env, argv[0], "args", &arr) == NAPI_OK && arr &&
            g_napi.is_array(env, arr, &isArr) == NAPI_OK && isArr) {
            uint32_t len = 0;
            g_napi.get_array_length(env, arr, &len);
            argCount = (int)len;
            if (argCount > 0) {
                args = (wchar_t **)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
                                             (size_t)argCount * sizeof(wchar_t *));
                if (!args) {
                    throw_text(env, "launch(): out of memory (args)");
                    goto cleanup;
                }
                for (int k = 0; k < argCount; k++) {
                    napi_value elem = NULL;
                    if (g_napi.get_element(env, arr, (uint32_t)k, &elem) != NAPI_OK || !elem) {
                        args[k] = NULL;
                        continue;
                    }
                    args[k] = wcs_from_value(env, elem);
                    if (!args[k]) {
                        args[k] = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(wchar_t));
                    }
                }
            }
        }
    }

    /* env: object of NAME -> VALUE (complete block, like spawn(env)) */
    {
        napi_value envObj = NULL;
        int type = 0;
        if (g_napi.get_named_property(env, argv[0], "env", &envObj) == NAPI_OK && envObj &&
            g_napi.type_of(env, envObj, &type) == NAPI_OK && type == 6 /* napi_object */) {
            napi_value names = NULL;
            uint32_t count = 0;
            if (g_napi.get_property_names(env, envObj, &names) == NAPI_OK && names &&
                g_napi.get_array_length(env, names, &count) == NAPI_OK && count > 0) {
                const wchar_t **entries = (const wchar_t **)HeapAlloc(
                    GetProcessHeap(), HEAP_ZERO_MEMORY, (size_t)count * sizeof(wchar_t *));
                int made = 0;
                if (entries) {
                    for (uint32_t k = 0; k < count; k++) {
                        napi_value nameVal = NULL, valVal = NULL;
                        if (g_napi.get_element(env, names, k, &nameVal) != NAPI_OK || !nameVal) {
                            continue;
                        }
                        wchar_t *name = wcs_from_value(env, nameVal);
                        if (!name) {
                            continue;
                        }
                        /* Use the property name to fetch the value (UTF-8 name). */
                        char nameA[512];
                        WideCharToMultiByte(CP_UTF8, 0, name, -1, nameA, sizeof(nameA), NULL, NULL);
                        if (g_napi.get_named_property(env, envObj, nameA, &valVal) != NAPI_OK || !valVal) {
                            HeapFree(GetProcessHeap(), 0, name);
                            continue;
                        }
                        wchar_t *value = wcs_from_value(env, valVal);
                        if (!value) {
                            HeapFree(GetProcessHeap(), 0, name);
                            continue;
                        }
                        size_t need = wcslen(name) + 1 + wcslen(value) + 1;
                        wchar_t *kv = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, need * sizeof(wchar_t));
                        if (kv) {
                            _snwprintf(kv, need, L"%ls=%ls", name, value);
                            kv[need - 1] = 0;
                            entries[made++] = kv;
                        }
                        HeapFree(GetProcessHeap(), 0, name);
                        HeapFree(GetProcessHeap(), 0, value);
                    }
                    wchar_t *block = NULL;
                    if (made > 0 && ws_build_env_block(entries, made, 0, &block)) {
                        envBlock = block;
                    }
                    for (int k = 0; k < made; k++) {
                        HeapFree(GetProcessHeap(), 0, (void *)entries[k]);
                    }
                }
                if (entries) {
                    HeapFree(GetProcessHeap(), 0, entries);
                }
            }
        }
    }

    outHandle = open_capture(stdoutPath);
    errHandle = open_capture(stderrPath);
    {
        SECURITY_ATTRIBUTES sa;
        memset(&sa, 0, sizeof(sa));
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = TRUE;
        if (stdinText) {
            if (!CreatePipe(&stdinRead, &stdinWrite, &sa, 0)) {
                throw_text(env, "launch(): cannot create the stdin pipe");
                goto cleanup;
            }
            SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0);
        } else {
            /* Never let the child inherit the host's stdin handle: a GUI host
             * either has none or has a handle whose read end is not ours. */
            stdinRead = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                                    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
            if (stdinRead == INVALID_HANDLE_VALUE) {
                stdinRead = NULL;
            }
        }
    }

    {
        WsLaunchRequest req;
        memset(&req, 0, sizeof(req));
        req.dll = dll;
        req.exe = exe;
        req.args = (const wchar_t *const *)args;
        req.argCount = argCount;
        req.cwd = cwd;
        req.envBlock = envBlock;
        req.stdinHandle = stdinRead;
        req.stdoutHandle = outHandle;
        req.stderrHandle = errHandle;
        req.timeoutMs = timeoutMs ? timeoutMs : 30000;
        req.noWindow = 1;
        req.forceNoWindow = 1;

        WsLaunchResult launched;
        int ok = ws_launch(&req, &launched);
        if (stdinRead) {
            CloseHandle(stdinRead);
            stdinRead = NULL;
        }
        if (!ok) {
            if (stdinWrite) {
                CloseHandle(stdinWrite);
                stdinWrite = NULL;
            }
            char stageA[WS_LAUNCH_STAGE_MAX * 2];
            char detailA[WS_LAUNCH_DETAIL_MAX * 2];
            json_escape(launched.stage, stageA, sizeof(stageA));
            json_escape(launched.detail, detailA, sizeof(detailA));
            char dllA[4096];
            json_escape(dll, dllA, sizeof(dllA));
            char exitA[32];
            char initA[32];
            if (launched.haveRemoteThreadExit) {
                snprintf(exitA, sizeof(exitA), "%lu", (unsigned long)launched.remoteThreadExit);
            } else {
                snprintf(exitA, sizeof(exitA), "null");
            }
            if (launched.haveShimInitRc) {
                snprintf(initA, sizeof(initA), "%lu", (unsigned long)launched.shimInitRc);
            } else {
                snprintf(initA, sizeof(initA), "null");
            }
            char json[8192];
            snprintf(json, sizeof(json),
                     "{\"ok\":false,\"tool\":\"winstage-native\",\"stage\":\"%s\",\"error\":\"%s\","
                     "\"win32Error\":%lu,\"remoteThreadExit\":%s,\"shimInitRc\":%s,\"dll\":\"%s\"}\n",
                     stageA, detailA, (unsigned long)launched.error, exitA, initA, dllA);
            write_json_file(reportPath, json);
            snprintf(errbuf, sizeof(errbuf), "launch failed at stage=%ls: %ls (win32=%lu)",
                     launched.stage, launched.detail, (unsigned long)launched.error);
            throw_text(env, errbuf);
            goto cleanup;
        }

        if (stdinWrite) {
            size_t off = 0;
            size_t len = wcslen(stdinText);
            while (off < len) {
                DWORD wrote = 0;
                if (!WriteFile(stdinWrite, stdinText + off, (DWORD)(len - off), &wrote, NULL) || wrote == 0) {
                    break;
                }
                off += wrote;
            }
            CloseHandle(stdinWrite);
            stdinWrite = NULL;
        }

        /* Persist the same report shape the CLI injector writes, so the
         * executor's judgeInjectorInit() keeps working unchanged. */
        {
            char dllA[4096];
            json_escape(dll, dllA, sizeof(dllA));
            char json[6144];
            snprintf(json, sizeof(json),
                     "{\"ok\":true,\"tool\":\"winstage-native\",\"dll\":\"%s\",\"childPid\":%lu,"
                     "\"childExitCode\":0,\"childTimedOut\":false,\"remoteModule\":\"0x%llx\","
                     "\"shimInitRc\":%lu}\n",
                     dllA, (unsigned long)launched.pid,
                     (unsigned long long)(ULONG_PTR)launched.remoteModule,
                     (unsigned long)launched.shimInitRc);
            write_json_file(reportPath, json);
        }

        CloseHandle(launched.hThread);
        Slot *slot = NULL;
        AcquireSRWLockExclusive(&g_slot_lock);
        slot = slot_alloc();
        if (slot) {
            slot->pid = launched.pid;
            slot->hProcess = launched.hProcess;
            slot->hJob = launched.hJob;
        }
        ReleaseSRWLockExclusive(&g_slot_lock);
        if (!slot) {
            TerminateProcess(launched.hProcess, 125);
            CloseHandle(launched.hProcess);
            if (launched.hJob) {
                CloseHandle(launched.hJob);
            }
            throw_text(env, "launch(): too many live children (slot table full)");
            goto cleanup;
        }

        napi_value result = NULL;
        if (g_napi.create_object(env, &result) == NAPI_OK && result) {
            napi_value pid = make_uint(env, launched.pid);
            if (pid) {
                g_napi.set_named_property(env, result, "pid", pid);
            }
        }
        rc = result;
    }

cleanup:
    if (outHandle) CloseHandle(outHandle);
    if (errHandle) CloseHandle(errHandle);
    if (envBlock) HeapFree(GetProcessHeap(), 0, envBlock);
    if (args) {
        for (int k = 0; k < argCount; k++) {
            if (args[k]) HeapFree(GetProcessHeap(), 0, args[k]);
        }
        HeapFree(GetProcessHeap(), 0, args);
    }
    if (dll) HeapFree(GetProcessHeap(), 0, dll);
    if (exe) HeapFree(GetProcessHeap(), 0, exe);
    if (cwd) HeapFree(GetProcessHeap(), 0, cwd);
    if (stdoutPath) HeapFree(GetProcessHeap(), 0, stdoutPath);
    if (stderrPath) HeapFree(GetProcessHeap(), 0, stderrPath);
    if (stdinText) HeapFree(GetProcessHeap(), 0, stdinText);
    if (reportPath) HeapFree(GetProcessHeap(), 0, reportPath);
    return rc;
}

/* ── poll(pid) -> null | { code } ────────────────────────────────────────── */
static napi_value addon_poll(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1] = { NULL };
    g_napi.get_cb_info(env, info, &argc, argv, NULL, NULL);
    uint32_t pid = 0;
    if (argc < 1 || !argv[0] || g_napi.get_value_uint32(env, argv[0], &pid) != NAPI_OK) {
        throw_text(env, "poll(): pid must be a number");
        return NULL;
    }
    Slot *found = NULL;
    AcquireSRWLockExclusive(&g_slot_lock);
    for (int i = 0; i < WS_SLOT_MAX; i++) {
        if (g_slots[i].used && g_slots[i].pid == pid) {
            found = &g_slots[i];
            break;
        }
    }
    if (!found) {
        ReleaseSRWLockExclusive(&g_slot_lock);
        throw_text(env, "poll(): unknown pid (never launched here or already reaped)");
        return NULL;
    }
    if (WaitForSingleObject(found->hProcess, 0) != WAIT_OBJECT_0) {
        ReleaseSRWLockExclusive(&g_slot_lock);
        napi_value nullValue = NULL;
        g_napi.get_null(env, &nullValue);
        return nullValue;
    }
    DWORD code = 0;
    GetExitCodeProcess(found->hProcess, &code);
    CloseHandle(found->hProcess);
    if (found->hJob) {
        CloseHandle(found->hJob);
    }
    memset(found, 0, sizeof(*found));
    ReleaseSRWLockExclusive(&g_slot_lock);

    napi_value result = NULL;
    if (g_napi.create_object(env, &result) == NAPI_OK && result) {
        napi_value value = make_uint(env, code);
        if (value) {
            g_napi.set_named_property(env, result, "code", value);
        }
    }
    return result;
}

/* ── terminate(pid, code) -> boolean ─────────────────────────────────────── */
static napi_value addon_terminate(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value argv[2] = { NULL, NULL };
    g_napi.get_cb_info(env, info, &argc, argv, NULL, NULL);
    uint32_t pid = 0, code = 1;
    if (argc < 1 || !argv[0] || g_napi.get_value_uint32(env, argv[0], &pid) != NAPI_OK) {
        throw_text(env, "terminate(): pid must be a number");
        return NULL;
    }
    if (argc >= 2 && argv[1]) {
        g_napi.get_value_uint32(env, argv[1], &code);
    }
    int ok = 0;
    AcquireSRWLockExclusive(&g_slot_lock);
    for (int i = 0; i < WS_SLOT_MAX; i++) {
        if (g_slots[i].used && g_slots[i].pid == pid) {
            ok = ws_terminate(g_slots[i].hProcess, code);
            break;
        }
    }
    ReleaseSRWLockExclusive(&g_slot_lock);
    napi_value result = NULL;
    if (g_napi.create_int32(env, ok ? 1 : 0, &result) != NAPI_OK) {
        result = NULL;
    }
    return result;
}

/* ── module registration (stable N-API entry point) ──────────────────────── */
static void add_function(napi_env env, napi_value exports, const char *name, ws_napi_callback fn)
{
    napi_value value = NULL;
    if (g_napi.create_function(env, name, NAPI_AUTO_LENGTH, fn, NULL, &value) == NAPI_OK && value) {
        g_napi.set_named_property(env, exports, name, value);
    }
}

__declspec(dllexport) napi_value napi_register_module_v1(napi_env env, napi_value exports)
{
    if (!napi_resolve()) {
        /* Without the host's exports there is nothing we can build. */
        return exports;
    }
    add_function(env, exports, "launch", addon_launch);
    add_function(env, exports, "poll", addon_poll);
    add_function(env, exports, "terminate", addon_terminate);
    napi_value version = NULL;
    if (g_napi.create_string_utf8(env, "winstage-native/1", NAPI_AUTO_LENGTH, &version) == NAPI_OK && version) {
        g_napi.set_named_property(env, exports, "version", version);
    }
    return exports;
}
