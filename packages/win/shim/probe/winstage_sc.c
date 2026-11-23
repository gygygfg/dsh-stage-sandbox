/* WinStageSandbox -- T4 shim: staged `sc.exe` CLI (probe --sc <args>).
 *
 * WHY (2026-11-23, second red-team round):
 *   `sc.exe` does NOT import advapi32's SCM APIs. Measured on the Win10 guest:
 *   its import table has RPCRT4!NdrClientCall2 and no OpenSCManager/CreateService
 *   entry at all -- it is a raw RPC client of the svcctl interface. That is why
 *   hooking advapi32 (which covers PowerShell New-Service / .NET ServiceInstaller)
 *   still let `sc create` write the REAL service.
 *
 *   The shim therefore rewrites CreateProcess(sc.exe) to
 *       winstage-probe.exe --sc <same argv>
 *   and the executor does the same for a top-level `sc`. This helper is a thin
 *   CLI over the advapi32 SCM APIs; because the child is injected, those calls
 *   land in ws_scm.c's client-side overlay:
 *     create/config/delete/start/stop  -> journaled, real SCM untouched
 *     query/qc/queryex/enum            -> journal merged with the real SCM
 *
 *   It deliberately does NOT link/execute the real sc.exe (that would recurse
 *   into this same rewrite). Verbs it does not know fail with a plain SCM error
 *   rather than reaching the real services.exe.
 *
 * Output format follows the observed en-US sc.exe on the test image. Only the
 * verbs below are covered; `sc sdset`, `sc failure`, `sc triggerinfo` are not.
 */
#include <windows.h>
#include <winsvc.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static void p(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stdout, fmt, ap);
    va_end(ap);
}

static const char *err_text(DWORD e)
{
    switch (e) {
    case ERROR_ACCESS_DENIED: return "Access is denied.";
    case ERROR_SERVICE_DOES_NOT_EXIST: return "The specified service does not exist as an installed service.";
    case ERROR_SERVICE_EXISTS: return "The specified service already exists.";
    case ERROR_SERVICE_MARKED_FOR_DELETE: return "The specified service has been marked for deletion.";
    case ERROR_SERVICE_ALREADY_RUNNING: return "An instance of the service is already running.";
    case ERROR_SERVICE_NOT_ACTIVE: return "The service has not been started.";
    case ERROR_SERVICE_CANNOT_ACCEPT_CTRL: return "The service cannot accept control messages at this time.";
    case ERROR_INVALID_SERVICE_CONTROL: return "The requested control is not valid for this service.";
    case ERROR_INVALID_HANDLE: return "The handle is invalid.";
    case ERROR_INVALID_PARAMETER: return "The parameter is incorrect.";
    default: return "The operation completed with an error.";
    }
}

static void sc_error(const wchar_t *context, DWORD e)
{
    char ctx[256];
    ctx[0] = 0;
    WideCharToMultiByte(CP_ACP, 0, context, -1, ctx, sizeof(ctx), NULL, NULL);
    p("[SC] %s FAILED %lu:\n\n%s\n\n", ctx, (unsigned long)e, err_text(e));
}

static void w2a(const wchar_t *s, char *out, size_t cch)
{
    out[0] = 0;
    if (s) {
        WideCharToMultiByte(CP_ACP, 0, s, -1, out, (int)cch, NULL, NULL);
    }
}

static const char *type_suffix(DWORD t)
{
    switch (t & 0xff) {
    case 0x01: return "KERNEL_DRIVER";
    case 0x02: return "FILE_SYSTEM_DRIVER";
    case 0x04: return "ADAPTER";
    case 0x08: return "RECOGNIZER_DRIVER";
    case 0x10: return "WIN32_OWN_PROCESS";
    case 0x20: return "WIN32_SHARE_PROCESS";
    default: return "UNKNOWN";
    }
}

static const char *start_suffix(DWORD s)
{
    switch (s) {
    case SERVICE_BOOT_START: return "BOOT_START";
    case SERVICE_SYSTEM_START: return "SYSTEM_START";
    case SERVICE_AUTO_START: return "AUTO_START";
    case SERVICE_DEMAND_START: return "DEMAND_START";
    case SERVICE_DISABLED: return "DISABLED";
    default: return "UNKNOWN";
    }
}

static const char *error_suffix(DWORD e)
{
    switch (e) {
    case SERVICE_ERROR_IGNORE: return "IGNORE";
    case SERVICE_ERROR_NORMAL: return "NORMAL";
    case SERVICE_ERROR_SEVERE: return "SEVERE";
    case SERVICE_ERROR_CRITICAL: return "CRITICAL";
    default: return "UNKNOWN";
    }
}

static const char *state_name(DWORD s)
{
    switch (s) {
    case SERVICE_STOPPED: return "STOPPED";
    case SERVICE_START_PENDING: return "START_PENDING";
    case SERVICE_STOP_PENDING: return "STOP_PENDING";
    case SERVICE_RUNNING: return "RUNNING";
    case SERVICE_CONTINUE_PENDING: return "CONTINUE_PENDING";
    case SERVICE_PAUSE_PENDING: return "PAUSE_PENDING";
    case SERVICE_PAUSED: return "PAUSED";
    default: return "UNKNOWN";
    }
}

static void print_status(const SERVICE_STATUS_PROCESS *s, int show_pid)
{
    p("        TYPE               : %-3lu %s%s\n", (unsigned long)(s->dwServiceType & 0xff),
      type_suffix(s->dwServiceType),
      (s->dwServiceType & SERVICE_INTERACTIVE_PROCESS) ? " (interactive)" : "");
    p("        STATE              : %-3lu %s\n", (unsigned long)s->dwCurrentState,
      state_name(s->dwCurrentState));
    p("        WIN32_EXIT_CODE    : %lu  (0x%lx)\n", (unsigned long)s->dwWin32ExitCode,
      (unsigned long)s->dwWin32ExitCode);
    p("        SERVICE_EXIT_CODE  : %lu  (0x%lx)\n", (unsigned long)s->dwServiceSpecificExitCode,
      (unsigned long)s->dwServiceSpecificExitCode);
    p("        CHECKPOINT         : 0x%lx\n", (unsigned long)s->dwCheckPoint);
    p("        WAIT_HINT          : 0x%lx\n", (unsigned long)s->dwWaitHint);
    if (show_pid) {
        p("        PID                : %lu\n", (unsigned long)s->dwProcessId);
        p("        FLAGS              : \n");
    }
}

static int normalize_type(const wchar_t *v)
{
    if (!_wcsicmp(v, L"own")) return SERVICE_WIN32_OWN_PROCESS;
    if (!_wcsicmp(v, L"share")) return SERVICE_WIN32_SHARE_PROCESS;
    if (!_wcsicmp(v, L"interact")) return SERVICE_WIN32_OWN_PROCESS | SERVICE_INTERACTIVE_PROCESS;
    if (!_wcsicmp(v, L"kernel")) return SERVICE_KERNEL_DRIVER;
    if (!_wcsicmp(v, L"filesys")) return SERVICE_FILE_SYSTEM_DRIVER;
    if (!_wcsicmp(v, L"rec")) return SERVICE_RECOGNIZER_DRIVER;
    if (!_wcsicmp(v, L"adapt")) return SERVICE_ADAPTER;
    if (!_wcsicmp(v, L"userown")) return 0x40;
    if (!_wcsicmp(v, L"usershare")) return 0x80;
    return (int)wcstoul(v, NULL, 0);
}

static int normalize_start(const wchar_t *v)
{
    if (!_wcsicmp(v, L"boot")) return SERVICE_BOOT_START;
    if (!_wcsicmp(v, L"system")) return SERVICE_SYSTEM_START;
    if (!_wcsicmp(v, L"auto")) return SERVICE_AUTO_START;
    if (!_wcsicmp(v, L"demand")) return SERVICE_DEMAND_START;
    if (!_wcsicmp(v, L"disabled")) return SERVICE_DISABLED;
    return (int)wcstoul(v, NULL, 0);
}

static int normalize_error(const wchar_t *v)
{
    if (!_wcsicmp(v, L"normal")) return SERVICE_ERROR_NORMAL;
    if (!_wcsicmp(v, L"severe")) return SERVICE_ERROR_SEVERE;
    if (!_wcsicmp(v, L"critical")) return SERVICE_ERROR_CRITICAL;
    if (!_wcsicmp(v, L"ignore")) return SERVICE_ERROR_IGNORE;
    return (int)wcstoul(v, NULL, 0);
}

/* Split `key= value` / `key = value`; returns 1 when a value key was found. */
static int split_kv(const wchar_t *arg, wchar_t *key, size_t keyCch, wchar_t *value, size_t valueCch)
{
    const wchar_t *eq = wcschr(arg, L'=');
    if (!eq) {
        return 0;
    }
    size_t klen = (size_t)(eq - arg);
    while (klen > 0 && (arg[klen - 1] == L' ' || arg[klen - 1] == L'\t')) klen--;
    if (klen + 1 > keyCch) klen = keyCch - 1;
    memcpy(key, arg, klen * sizeof(wchar_t));
    key[klen] = 0;
    const wchar_t *v = eq + 1;
    while (*v == L' ' || *v == L'\t') v++;
    wcsncpy(value, v, valueCch - 1);
    value[valueCch - 1] = 0;
    size_t vlen = wcslen(value);
    while (vlen > 0 && (value[vlen - 1] == L' ' || value[vlen - 1] == L'\t')) value[--vlen] = 0;
    return 1;
}

/* sc's own syntax allows `key= value` as two argv tokens; consume that form too. */
static int take_kv(int argc, wchar_t **argv, int *idx, wchar_t *key, size_t keyCch, wchar_t *value,
                   size_t valueCch)
{
    const wchar_t *arg = argv[*idx];
    const wchar_t *eq = wcschr(arg, L'=');
    if (!eq || !split_kv(arg, key, keyCch, value, valueCch)) {
        return 0;
    }
    if (value[0] == 0 && *idx + 1 < argc) {
        const wchar_t *next = argv[*idx + 1];
        if (!wcschr(next, L'=')) {
            wcsncpy(value, next, valueCch - 1);
            value[valueCch - 1] = 0;
            (*idx)++;
        }
    }
    return 1;
}

static SC_HANDLE open_manager(void)
{
    return OpenSCManagerW(NULL, NULL, SC_MANAGER_ALL_ACCESS);
}

static int cmd_create(int argc, wchar_t **argv)
{
    if (argc < 2) {
        sc_error(L"CreateService", ERROR_INVALID_PARAMETER);
        return ERROR_INVALID_PARAMETER;
    }
    const wchar_t *name = argv[1];
    const wchar_t *display = name;
    const wchar_t *image = L"";
    const wchar_t *group = NULL;
    const wchar_t *deps = NULL;
    const wchar_t *startName = NULL;
    const wchar_t *password = NULL;
    DWORD type = SERVICE_WIN32_OWN_PROCESS;
    DWORD start = SERVICE_DEMAND_START;
    DWORD error = SERVICE_ERROR_NORMAL;
    DWORD tag = 0;
    int haveTag = 0;
    for (int i = 2; i < argc; i++) {
        wchar_t k[64], v[4096];
        if (!take_kv(argc, argv, &i, k, 64, v, 4096)) {
            continue;
        }
        if (!_wcsicmp(k, L"binpath")) image = _wcsdup(v);
        else if (!_wcsicmp(k, L"displayname")) display = _wcsdup(v);
        else if (!_wcsicmp(k, L"type")) type = (DWORD)normalize_type(v);
        else if (!_wcsicmp(k, L"start")) start = (DWORD)normalize_start(v);
        else if (!_wcsicmp(k, L"error")) error = (DWORD)normalize_error(v);
        else if (!_wcsicmp(k, L"group")) group = _wcsdup(v);
        else if (!_wcsicmp(k, L"depend")) deps = _wcsdup(v);
        else if (!_wcsicmp(k, L"obj")) startName = _wcsdup(v);
        else if (!_wcsicmp(k, L"password")) password = _wcsdup(v);
        else if (!_wcsicmp(k, L"tag")) { tag = (DWORD)wcstoul(v, NULL, 0); haveTag = 1; }
    }
    SC_HANDLE mgr = open_manager();
    if (!mgr) {
        DWORD e = GetLastError();
        sc_error(L"OpenSCManager", e);
        return (int)e;
    }
    SC_HANDLE svc = CreateServiceW(mgr, name, display, SC_MANAGER_ALL_ACCESS, type, start, error, image,
                                   group, haveTag ? &tag : NULL, deps, startName, password);
    DWORD e = GetLastError();
    CloseServiceHandle(mgr);
    if (!svc) {
        sc_error(L"CreateService", e);
        return (int)e;
    }
    CloseServiceHandle(svc);
    p("[SC] CreateService SUCCESS\n\n");
    return 0;
}

static int cmd_config(int argc, wchar_t **argv)
{
    if (argc < 2) {
        sc_error(L"ChangeServiceConfig", ERROR_INVALID_PARAMETER);
        return ERROR_INVALID_PARAMETER;
    }
    const wchar_t *name = argv[1];
    const wchar_t *image = NULL, *group = NULL, *deps = NULL, *startName = NULL, *display = NULL;
    DWORD type = SERVICE_NO_CHANGE, start = SERVICE_NO_CHANGE, error = SERVICE_NO_CHANGE;
    DWORD tag = 0;
    int haveTag = 0;
    for (int i = 2; i < argc; i++) {
        wchar_t k[64], v[4096];
        if (!take_kv(argc, argv, &i, k, 64, v, 4096)) continue;
        if (!_wcsicmp(k, L"binpath")) image = _wcsdup(v);
        else if (!_wcsicmp(k, L"displayname")) display = _wcsdup(v);
        else if (!_wcsicmp(k, L"type")) type = (DWORD)normalize_type(v);
        else if (!_wcsicmp(k, L"start")) start = (DWORD)normalize_start(v);
        else if (!_wcsicmp(k, L"error")) error = (DWORD)normalize_error(v);
        else if (!_wcsicmp(k, L"group")) group = _wcsdup(v);
        else if (!_wcsicmp(k, L"depend")) deps = _wcsdup(v);
        else if (!_wcsicmp(k, L"obj")) startName = _wcsdup(v);
        else if (!_wcsicmp(k, L"tag")) { tag = (DWORD)wcstoul(v, NULL, 0); haveTag = 1; }
    }
    SC_HANDLE mgr = open_manager();
    if (!mgr) {
        DWORD e = GetLastError();
        sc_error(L"OpenSCManager", e);
        return (int)e;
    }
    SC_HANDLE svc = OpenServiceW(mgr, name, SERVICE_CHANGE_CONFIG | SERVICE_QUERY_CONFIG);
    DWORD e = GetLastError();
    if (!svc) {
        CloseServiceHandle(mgr);
        sc_error(L"OpenService", e);
        return (int)e;
    }
    BOOL ok = ChangeServiceConfigW(svc, type, start, error, image, group, haveTag ? &tag : NULL, deps,
                                   startName, NULL, display);
    e = GetLastError();
    CloseServiceHandle(svc);
    CloseServiceHandle(mgr);
    if (!ok) {
        sc_error(L"ChangeServiceConfig", e);
        return (int)e;
    }
    p("[SC] ChangeServiceConfig SUCCESS\n\n");
    return 0;
}

static int cmd_delete(int argc, wchar_t **argv)
{
    if (argc < 2) {
        sc_error(L"DeleteService", ERROR_INVALID_PARAMETER);
        return ERROR_INVALID_PARAMETER;
    }
    SC_HANDLE mgr = open_manager();
    if (!mgr) {
        DWORD e = GetLastError();
        sc_error(L"OpenSCManager", e);
        return (int)e;
    }
    SC_HANDLE svc = OpenServiceW(mgr, argv[1], DELETE);
    DWORD e = GetLastError();
    if (!svc) {
        CloseServiceHandle(mgr);
        sc_error(L"OpenService", e);
        return (int)e;
    }
    BOOL ok = DeleteService(svc);
    e = GetLastError();
    CloseServiceHandle(svc);
    CloseServiceHandle(mgr);
    if (!ok) {
        sc_error(L"DeleteService", e);
        return (int)e;
    }
    p("[SC] DeleteService SUCCESS\n\n");
    return 0;
}

static int print_one_status(SC_HANDLE svc, int show_pid)
{
    SERVICE_STATUS_PROCESS st;
    DWORD needed = 0;
    if (!QueryServiceStatusEx(svc, SC_STATUS_PROCESS_INFO, (LPBYTE)&st, sizeof(st), &needed)) {
        return (int)GetLastError();
    }
    print_status(&st, show_pid);
    return 0;
}

static int cmd_start(int argc, wchar_t **argv)
{
    if (argc < 2) {
        sc_error(L"StartService", ERROR_INVALID_PARAMETER);
        return ERROR_INVALID_PARAMETER;
    }
    SC_HANDLE mgr = open_manager();
    if (!mgr) {
        DWORD e = GetLastError();
        sc_error(L"OpenSCManager", e);
        return (int)e;
    }
    SC_HANDLE svc = OpenServiceW(mgr, argv[1], SERVICE_START | SERVICE_QUERY_STATUS);
    DWORD e = GetLastError();
    if (!svc) {
        CloseServiceHandle(mgr);
        sc_error(L"OpenService", e);
        return (int)e;
    }
    if (!StartServiceW(svc, 0, NULL)) {
        e = GetLastError();
        if (e != ERROR_SERVICE_ALREADY_RUNNING) {
            CloseServiceHandle(svc);
            CloseServiceHandle(mgr);
            sc_error(L"StartService", e);
            return (int)e;
        }
    }
    p("\nSERVICE_NAME: %ls \n", argv[1]);
    int rc = print_one_status(svc, 1);
    CloseServiceHandle(svc);
    CloseServiceHandle(mgr);
    return rc;
}

static int cmd_stop(int argc, wchar_t **argv)
{
    if (argc < 2) {
        sc_error(L"ControlService", ERROR_INVALID_PARAMETER);
        return ERROR_INVALID_PARAMETER;
    }
    SC_HANDLE mgr = open_manager();
    if (!mgr) {
        DWORD e = GetLastError();
        sc_error(L"OpenSCManager", e);
        return (int)e;
    }
    SC_HANDLE svc = OpenServiceW(mgr, argv[1], SERVICE_STOP | SERVICE_QUERY_STATUS);
    DWORD e = GetLastError();
    if (!svc) {
        CloseServiceHandle(mgr);
        sc_error(L"OpenService", e);
        return (int)e;
    }
    SERVICE_STATUS st;
    if (!ControlService(svc, SERVICE_CONTROL_STOP, &st)) {
        e = GetLastError();
        CloseServiceHandle(svc);
        CloseServiceHandle(mgr);
        sc_error(L"ControlService", e);
        return (int)e;
    }
    p("\nSERVICE_NAME: %ls \n", argv[1]);
    int rc = print_one_status(svc, 0);
    CloseServiceHandle(svc);
    CloseServiceHandle(mgr);
    return rc;
}

static int cmd_qc(int argc, wchar_t **argv)
{
    if (argc < 2) {
        sc_error(L"QueryServiceConfig", ERROR_INVALID_PARAMETER);
        return ERROR_INVALID_PARAMETER;
    }
    SC_HANDLE mgr = open_manager();
    if (!mgr) {
        DWORD e = GetLastError();
        sc_error(L"OpenSCManager", e);
        return (int)e;
    }
    SC_HANDLE svc = OpenServiceW(mgr, argv[1], SERVICE_QUERY_CONFIG);
    DWORD e = GetLastError();
    if (!svc) {
        CloseServiceHandle(mgr);
        sc_error(L"OpenService", e);
        return (int)e;
    }
    DWORD needed = 0;
    QueryServiceConfigW(svc, NULL, 0, &needed);
    BYTE *buf = (BYTE *)malloc(needed ? needed : 1024);
    if (!buf) {
        CloseServiceHandle(svc);
        CloseServiceHandle(mgr);
        return (int)ERROR_NOT_ENOUGH_MEMORY;
    }
    QUERY_SERVICE_CONFIGW *c = (QUERY_SERVICE_CONFIGW *)buf;
    if (!QueryServiceConfigW(svc, c, needed, &needed)) {
        e = GetLastError();
        free(buf);
        CloseServiceHandle(svc);
        CloseServiceHandle(mgr);
        sc_error(L"QueryServiceConfig", e);
        return (int)e;
    }
    char name[512];
    w2a(argv[1], name, sizeof(name));
    p("[SC] QueryServiceConfig SUCCESS\n\nSERVICE_NAME: %s\n", name);
    p("        TYPE               : %-3lu %s\n", (unsigned long)(c->dwServiceType & 0xff),
      type_suffix(c->dwServiceType));
    p("        START_TYPE         : %-3lu %s\n", (unsigned long)c->dwStartType, start_suffix(c->dwStartType));
    p("        ERROR_CONTROL      : %-3lu %s\n", (unsigned long)c->dwErrorControl,
      error_suffix(c->dwErrorControl));
    char tmp[4096];
    w2a(c->lpBinaryPathName, tmp, sizeof(tmp));
    p("        BINARY_PATH_NAME   : %s\n", tmp);
    w2a(c->lpLoadOrderGroup, tmp, sizeof(tmp));
    p("        LOAD_ORDER_GROUP   : %s\n", tmp);
    p("        TAG                : %lu\n", (unsigned long)c->dwTagId);
    w2a(c->lpDisplayName, tmp, sizeof(tmp));
    p("        DISPLAY_NAME       : %s\n", tmp);
    w2a(c->lpDependencies, tmp, sizeof(tmp));
    p("        DEPENDENCIES       : %s\n", tmp);
    w2a(c->lpServiceStartName, tmp, sizeof(tmp));
    p("        SERVICE_START_NAME : %s\n\n", tmp);
    free(buf);
    CloseServiceHandle(svc);
    CloseServiceHandle(mgr);
    return 0;
}

static int cmd_query(int argc, wchar_t **argv, int show_pid)
{
    DWORD typeFilter = SERVICE_DRIVER | SERVICE_WIN32 | SERVICE_ADAPTER | SERVICE_RECOGNIZER_DRIVER;
    DWORD stateFilter = SERVICE_STATE_ALL;
    const wchar_t *name = NULL;
    for (int i = 1; i < argc; i++) {
        wchar_t k[64], v[4096];
        if (take_kv(argc, argv, &i, k, 64, v, 4096)) {
            if (!_wcsicmp(k, L"type")) {
                typeFilter = 0;
                if (wcsstr(v, L"service") || wcsstr(v, L"all")) typeFilter |= SERVICE_WIN32;
                if (wcsstr(v, L"driver")) typeFilter |= SERVICE_DRIVER;
                if (wcsstr(v, L"all")) typeFilter |= SERVICE_ADAPTER | SERVICE_RECOGNIZER_DRIVER;
            } else if (!_wcsicmp(k, L"state")) {
                stateFilter = 0;
                if (wcsstr(v, L"all")) stateFilter = SERVICE_STATE_ALL;
                if (wcsstr(v, L"active")) stateFilter |= SERVICE_ACTIVE;
                if (wcsstr(v, L"inactive")) stateFilter |= SERVICE_INACTIVE;
            }
            continue;
        }
        if (!name) name = argv[i];
    }
    SC_HANDLE mgr = open_manager();
    if (!mgr) {
        DWORD e = GetLastError();
        sc_error(L"OpenSCManager", e);
        return (int)e;
    }
    if (name) {
        SC_HANDLE svc = OpenServiceW(mgr, name, SERVICE_QUERY_STATUS);
        DWORD e = GetLastError();
        if (!svc) {
            CloseServiceHandle(mgr);
            sc_error(L"EnumQueryServicesStatus:OpenService", e);
            return (int)e;
        }
        p("\nSERVICE_NAME: %ls \n", name);
        int rc = print_one_status(svc, show_pid);
        CloseServiceHandle(svc);
        CloseServiceHandle(mgr);
        return rc;
    }
    DWORD needed = 0, returned = 0, resume = 0;
    BYTE *buf = NULL;
    DWORD cap = 512 * 1024;
    BOOL ok = FALSE;
    for (int guard = 0; guard < 8; guard++) {
        buf = (BYTE *)malloc(cap);
        if (!buf) {
            CloseServiceHandle(mgr);
            return (int)ERROR_NOT_ENOUGH_MEMORY;
        }
        returned = 0;
        resume = 0;
        ok = EnumServicesStatusExW(mgr, SC_ENUM_PROCESS_INFO, typeFilter, stateFilter, buf, cap, &needed,
                                   &returned, &resume, NULL);
        if (ok) break;
        DWORD e = GetLastError();
        free(buf);
        buf = NULL;
        if (e != ERROR_MORE_DATA) {
            CloseServiceHandle(mgr);
            sc_error(L"EnumServicesStatusEx", e);
            return (int)e;
        }
        cap = needed + 4096;
    }
    CloseServiceHandle(mgr);
    if (!ok || !buf) {
        free(buf);
        return 1;
    }
    ENUM_SERVICE_STATUS_PROCESSW *arr = (ENUM_SERVICE_STATUS_PROCESSW *)buf;
    for (DWORD i = 0; i < returned; i++) {
        char n[512], d[512];
        w2a(arr[i].lpServiceName, n, sizeof(n));
        w2a(arr[i].lpDisplayName, d, sizeof(d));
        p("\nSERVICE_NAME: %s\n", n);
        if (d[0] && strcmp(n, d) != 0) {
            p("DISPLAY_NAME: %s\n", d);
        }
        print_status(&arr[i].ServiceStatusProcess, 0);
    }
    p("\n");
    free(buf);
    return 0;
}

static int cmd_description(int argc, wchar_t **argv)
{
    if (argc < 2) {
        sc_error(L"QueryServiceConfig2", ERROR_INVALID_PARAMETER);
        return ERROR_INVALID_PARAMETER;
    }
    SC_HANDLE mgr = open_manager();
    if (!mgr) {
        DWORD e = GetLastError();
        sc_error(L"OpenSCManager", e);
        return (int)e;
    }
    SC_HANDLE svc = OpenServiceW(mgr, argv[1],
                                 argc > 2 ? SERVICE_CHANGE_CONFIG : SERVICE_QUERY_CONFIG);
    DWORD e = GetLastError();
    if (!svc) {
        CloseServiceHandle(mgr);
        sc_error(L"OpenService", e);
        return (int)e;
    }
    if (argc > 2) {
        SERVICE_DESCRIPTIONW d;
        d.lpDescription = argv[2];
        BOOL ok = ChangeServiceConfig2W(svc, SERVICE_CONFIG_DESCRIPTION, &d);
        e = GetLastError();
        CloseServiceHandle(svc);
        CloseServiceHandle(mgr);
        if (!ok) {
            sc_error(L"ChangeServiceConfig2", e);
            return (int)e;
        }
        p("[SC] ChangeServiceConfig2 SUCCESS\n\n");
        return 0;
    }
    SERVICE_DESCRIPTIONW *d = NULL;
    DWORD needed = 0;
    QueryServiceConfig2W(svc, SERVICE_CONFIG_DESCRIPTION, NULL, 0, &needed);
    BYTE *buf = (BYTE *)malloc(needed ? needed : sizeof(SERVICE_DESCRIPTIONW));
    if (buf) {
        if (QueryServiceConfig2W(svc, SERVICE_CONFIG_DESCRIPTION, buf, needed, &needed)) {
            d = (SERVICE_DESCRIPTIONW *)buf;
        }
    }
    char desc[2048];
    w2a(d ? d->lpDescription : NULL, desc, sizeof(desc));
    p("[SC] QueryServiceConfig2 SUCCESS\n\nSERVICE_NAME: %ls\n        DESCRIPTION        : %s\n\n", argv[1],
      desc);
    free(buf);
    CloseServiceHandle(svc);
    CloseServiceHandle(mgr);
    return 0;
}

/* ------------------------------------------------------------- wevtutil CLI --
 * `wevtutil cl` bypasses the Evt* hooks (it reaches wevtapi through the
 * delay-load helper, measured 2026-11-23: Application was really cleared even
 * with the shim injected). Same remedy as sc.exe: run a helper instead.
 *
 *   wevtutil cl  <ch>        -> --evt cl  <ch>      (journal via ClearEventLogW)
 *   wevtutil qe  <ch> [...]  -> --evt qe  <ch> [...] (empty if staged-cleared,
 *                                                    else the real wevtutil)
 * Every other verb is delegated to the real wevtutil unchanged.
 */

static int evt_journal_path(const wchar_t *explicitPath, wchar_t *out, DWORD cch)
{
    if (explicitPath && explicitPath[0]) {
        wcsncpy(out, explicitPath, cch - 1);
        out[cch - 1] = 0;
        return 1;
    }
    wchar_t dir[1024];
    DWORD n = GetEnvironmentVariableW(L"DSH_REGSTAGE_SESSION_DIR", dir, 1024);
    if (n == 0 || n >= 1024) {
        return 0;
    }
    _snwprintf(out, cch, L"%ls\\eventlog.overlay.jsonl", dir);
    out[cch - 1] = 0;
    return 1;
}

static int evt_channel_cleared(const wchar_t *journalPath, const wchar_t *channel)
{
    wchar_t path[2048];
    if (!channel || !channel[0] || !evt_journal_path(journalPath, path, 2048)) {
        return 0;
    }
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        return 0;
    }
    LARGE_INTEGER sz;
    if (!GetFileSizeEx(h, &sz) || sz.QuadPart <= 0 || sz.QuadPart > (4 << 20)) {
        CloseHandle(h);
        return 0;
    }
    DWORD len = (DWORD)sz.QuadPart;
    char *buf = (char *)malloc(len + 1);
    if (!buf) {
        CloseHandle(h);
        return 0;
    }
    DWORD got = 0;
    BOOL ok = ReadFile(h, buf, len, &got, NULL);
    CloseHandle(h);
    if (!ok) {
        free(buf);
        return 0;
    }
    buf[got] = 0;
    int cleared = 0;
    char *line = buf;
    while (line && *line && !cleared) {
        char *nl = strchr(line, '\n');
        if (nl) *nl = 0;
        if (strstr(line, "\"op\":\"clear\"")) {
            const char *p = strstr(line, "\"channel\":\"");
            if (p) {
                p += strlen("\"channel\":\"");
                const char *end = strchr(p, '"');
                if (end) {
                    size_t hn = (size_t)(end - p);
                    if (hn < 4096) {
                        wchar_t hex[4096];
                        for (size_t i = 0; i < hn; i++) hex[i] = (wchar_t)(unsigned char)p[i];
                        hex[hn] = 0;
                        /* decode 4-hex-digit UTF-16 units */
                        wchar_t decoded[512];
                        size_t dn = 0;
                        for (size_t i = 0; i + 4 <= hn && dn + 1 < 512; i += 4) {
                            wchar_t unit = 0;
                            for (int k = 0; k < 4; k++) {
                                wchar_t c = hex[i + k];
                                int v = (c >= L'0' && c <= L'9') ? (int)(c - L'0')
                                      : (c >= L'a' && c <= L'f') ? (int)(c - L'a' + 10)
                                      : (c >= L'A' && c <= L'F') ? (int)(c - L'A' + 10) : -1;
                                if (v < 0) { unit = 0; break; }
                                unit = (wchar_t)((unit << 4) | v);
                            }
                            decoded[dn++] = unit;
                        }
                        decoded[dn] = 0;
                        if (dn && _wcsicmp(decoded, channel) == 0) {
                            cleared = 1;
                        }
                    }
                }
            }
        }
        if (!nl) break;
        line = nl + 1;
    }
    free(buf);
    return cleared;
}

static void quote_arg(const wchar_t *in, wchar_t *out, size_t cch)
{
    size_t pos = 0;
    if (pos + 1 < cch) out[pos++] = L'"';
    for (const wchar_t *p = in; *p && pos + 2 < cch; p++) {
        out[pos++] = *p;
    }
    if (pos + 1 < cch) out[pos++] = L'"';
    out[pos] = 0;
}

static int run_real_wevtutil(int argc, wchar_t **argv)
{
    static const wchar_t *const kReal = L"C:\\Windows\\System32\\wevtutil.exe";
    wchar_t cmd[16384];
    size_t pos = 0;
    cmd[0] = 0;
    _snwprintf(cmd, 16384, L"\"%ls\"", kReal);
    pos = wcslen(cmd);
    for (int i = 0; i < argc && pos + 3000 < 16384; i++) {
        wchar_t q[3000];
        quote_arg(argv[i], q, 3000);
        cmd[pos++] = L' ';
        wcsncpy(cmd + pos, q, 16384 - pos - 1);
        pos += wcslen(cmd + pos);
        cmd[pos] = 0;
    }
    SetEnvironmentVariableW(L"WINSTAGE_CLI_REAL", L"1");
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof(si));
    memset(&pi, 0, sizeof(pi));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    if (!CreateProcessW(NULL, cmd, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
        return (int)GetLastError();
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return (int)code;
}

int ws_evt_main(int argc, wchar_t **argv)
{
    const wchar_t *journalPath = NULL;
    if (argc >= 3) {
        /* `probe --evt <journal.jsonl> <verb> <channel> [...]`; the shim/executor
         * pass the journal path explicitly because the shim scrubs DSH_* from the
         * helper's environment on purpose. */
        journalPath = argv[0];
        argc--;
        argv++;
    }
    if (argc < 2) {
        return 1;
    }
    const wchar_t *verb = argv[0];
    const wchar_t *channel = argv[1];
    int isClear = !_wcsicmp(verb, L"cl") || !_wcsicmp(verb, L"clear-log");
    int isQuery = !_wcsicmp(verb, L"qe") || !_wcsicmp(verb, L"query-events");
    if (!isClear && !isQuery) {
        return run_real_wevtutil(argc, argv);
    }
    if (isQuery && evt_channel_cleared(journalPath, channel)) {
        return 0; /* staged clear: an empty channel prints nothing */
    }
    if (!isClear) {
        return run_real_wevtutil(argc, argv);
    }
    if (!GetModuleHandleW(L"winstage-shim.dll")) {
        /* Not injected: clearing here would hit the real service. */
        fputs("wevtutil: staging layer is not active; refusing to clear the real log\n", stderr);
        return 5;
    }
    HANDLE log = OpenEventLogW(NULL, channel);
    if (!log) {
        return (int)GetLastError();
    }
    BOOL ok = ClearEventLogW(log, NULL);
    DWORD e = GetLastError();
    CloseEventLog(log);
    return ok ? 0 : (int)e;
}


/* --------------------------------------------------------------- schtasks CLI --
 * `schtasks.exe` talks to the Task Scheduler over COM/RPC, so the same class of
 * bypass as sc.exe. The helper keeps a task journal and answers the common verbs
 * itself; a query of a staged task therefore stays consistent, while the real
 * Task Scheduler is never touched.
 */
#define WS_TASK_MAX 64
#define WS_TASK_NAME 256
#define WS_TASK_CMD 2048
#define WS_TASK_SCHED 128

typedef struct WsTask {
    int used;
    int deleted;
    wchar_t name[WS_TASK_NAME];
    wchar_t cmd[WS_TASK_CMD];
    wchar_t sched[WS_TASK_SCHED];
} WsTask;

static WsTask g_tasks[WS_TASK_MAX];

static void task_clear_all(void)
{
    memset(g_tasks, 0, sizeof(g_tasks));
}

static int hex_get(const char *line, const char *key, wchar_t *out, size_t cch)
{
    char pat[64];
    snprintf(pat, sizeof(pat), "\"%s\":\"", key);
    const char *p = strstr(line, pat);
    if (!p) {
        return 0;
    }
    p += strlen(pat);
    const char *end = strchr(p, '"');
    if (!end) {
        return 0;
    }
    size_t hn = (size_t)(end - p);
    if (hn >= 4096) return 0;
    size_t dn = 0;
    for (size_t i = 0; i + 4 <= hn && dn + 1 < cch; i += 4) {
        wchar_t unit = 0;
        for (int k = 0; k < 4; k++) {
            char c = p[i + k];
            int v = (c >= '0' && c <= '9') ? (c - '0')
                  : (c >= 'a' && c <= 'f') ? (c - 'a' + 10)
                  : (c >= 'A' && c <= 'F') ? (c - 'A' + 10) : -1;
            if (v < 0) { unit = 0; break; }
            unit = (wchar_t)((unit << 4) | v);
        }
        out[dn++] = unit;
    }
    out[dn] = 0;
    return 1;
}

static WsTask *task_find(const wchar_t *name)
{
    for (int i = 0; i < WS_TASK_MAX; i++) {
        if (g_tasks[i].used && _wcsicmp(g_tasks[i].name, name) == 0) return &g_tasks[i];
    }
    return NULL;
}

static WsTask *task_alloc(const wchar_t *name)
{
    WsTask *t = task_find(name);
    if (t) return t;
    for (int i = 0; i < WS_TASK_MAX; i++) {
        if (!g_tasks[i].used) {
            memset(&g_tasks[i], 0, sizeof(g_tasks[i]));
            g_tasks[i].used = 1;
            wcsncpy(g_tasks[i].name, name, WS_TASK_NAME - 1);
            return &g_tasks[i];
        }
    }
    return NULL;
}

static void task_load(const wchar_t *journal)
{
    task_clear_all();
    if (!journal || !journal[0]) return;
    HANDLE h = CreateFileW(journal, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    LARGE_INTEGER sz;
    if (!GetFileSizeEx(h, &sz) || sz.QuadPart <= 0 || sz.QuadPart > (4 << 20)) {
        CloseHandle(h);
        return;
    }
    DWORD len = (DWORD)sz.QuadPart;
    char *buf = (char *)malloc(len + 1);
    if (!buf) { CloseHandle(h); return; }
    DWORD got = 0;
    BOOL ok = ReadFile(h, buf, len, &got, NULL);
    CloseHandle(h);
    if (!ok) { free(buf); return; }
    buf[got] = 0;
    char *line = buf;
    while (line && *line) {
        char *nl = strchr(line, '\n');
        if (nl) *nl = 0;
        wchar_t name[WS_TASK_NAME];
        if (strstr(line, "\"op\":\"create\"") && hex_get(line, "name", name, WS_TASK_NAME)) {
            WsTask *t = task_alloc(name);
            if (t) {
                t->deleted = 0;
                hex_get(line, "cmd", t->cmd, WS_TASK_CMD);
                hex_get(line, "sched", t->sched, WS_TASK_SCHED);
            }
        } else if (strstr(line, "\"op\":\"delete\"") && hex_get(line, "name", name, WS_TASK_NAME)) {
            WsTask *t = task_alloc(name);
            if (t) t->deleted = 1;
        }
        if (!nl) break;
        line = nl + 1;
    }
    free(buf);
}

static void hex_put(FILE *f, const wchar_t *s)
{
    if (!s) return;
    for (const wchar_t *p = s; *p; p++) {
        fprintf(f, "%04x", (unsigned)(unsigned short)*p);
    }
}

static int task_journal(const wchar_t *journal, const wchar_t *op, const WsTask *t)
{
    if (!journal || !journal[0]) return 0;
    FILE *f = _wfopen(journal, L"ab");
    if (!f) return 0;
    fprintf(f, "{\"op\":\"%ls\",\"name\":\"", op);
    hex_put(f, t->name);
    fprintf(f, "\",\"cmd\":\"");
    hex_put(f, t->cmd);
    fprintf(f, "\",\"sched\":\"");
    hex_put(f, t->sched);
    fprintf(f, "\"}\n");
    fclose(f);
    return 1;
}

static const wchar_t *task_arg(int argc, wchar_t **argv, const wchar_t *key)
{
    size_t kl = wcslen(key);
    for (int i = 0; i < argc; i++) {
        if (_wcsnicmp(argv[i], key, kl) == 0) {
            if (argv[i][kl] == 0 && i + 1 < argc) return argv[i + 1];
            if (argv[i][kl] == L':') return argv[i] + kl + 1;
            if (argv[i][kl] == L'=') return argv[i] + kl + 1;
        }
    }
    return NULL;
}

static int task_has_flag(int argc, wchar_t **argv, const wchar_t *flag)
{
    for (int i = 0; i < argc; i++) {
        if (_wcsicmp(argv[i], flag) == 0) return 1;
    }
    return 0;
}

static void task_print_table(const WsTask *t)
{
    char name[WS_TASK_NAME], sched[WS_TASK_SCHED];
    w2a(t->name, name, sizeof(name));
    w2a(t->sched, sched, sizeof(sched));
    p("\nFolder: \\\n");
    p("                                                                        \n");
    p("TaskName                                 Next Run Time          Status  \n");
    p("======================================== ====================== ===============\n");
    p("%-40s %-22s %s\n", name, "N/A", "Ready");
    (void)sched;
}

static void task_print_list(const WsTask *t)
{
    char name[WS_TASK_NAME], cmd[WS_TASK_CMD], sched[WS_TASK_SCHED];
    w2a(t->name, name, sizeof(name));
    w2a(t->cmd, cmd, sizeof(cmd));
    w2a(t->sched, sched, sizeof(sched));
    p("\nFolder: \\\n");
    p("HostName:                             %s\n", "DOCKERW-KHL8GT2");
    p("TaskName:                             \\%s\n", name);
    p("Next Run Time:                        N/A\n");
    p("Status:                               Ready\n");
    p("Logon Mode:                           Interactive/Background\n");
    p("Task To Run:                          %s\n", cmd);
    p("Schedule Type:                        %s\n", sched[0] ? sched : "On demand only");
}

static int run_real_schtasks(int argc, wchar_t **argv)
{
    wchar_t cmd[16384];
    size_t pos = 0;
    cmd[0] = 0;
    _snwprintf(cmd, 16384, L"\"C:\\\\Windows\\\\System32\\\\schtasks.exe\"");
    pos = wcslen(cmd);
    for (int i = 0; i < argc && pos + 3000 < 16384; i++) {
        wchar_t q[3000];
        quote_arg(argv[i], q, 3000);
        cmd[pos++] = L' ';
        wcsncpy(cmd + pos, q, 16384 - pos - 1);
        pos += wcslen(cmd + pos);
        cmd[pos] = 0;
    }
    SetEnvironmentVariableW(L"WINSTAGE_CLI_REAL", L"1");
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof(si));
    memset(&pi, 0, sizeof(pi));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    if (!CreateProcessW(NULL, cmd, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
        return (int)GetLastError();
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return (int)code;
}

int ws_task_main(int argc, wchar_t **argv)
{
    const wchar_t *journal = NULL;
    if (argc >= 3) {
        journal = argv[0];
        argc--;
        argv++;
    }
    task_load(journal);
    const wchar_t *verb = argc > 0 ? argv[0] : L"";
    const wchar_t *tn = task_arg(argc, argv, L"/tn");
    int force = task_has_flag(argc, argv, L"/f");
    wchar_t name[WS_TASK_NAME];
    name[0] = 0;
    if (tn) {
        const wchar_t *n = tn;
        while (*n == L'\\') n++;
        wcsncpy(name, n, WS_TASK_NAME - 1);
        name[WS_TASK_NAME - 1] = 0;
    }
    int staged = name[0] && task_find(name) && !task_find(name)->deleted;

    if (!_wcsicmp(verb, L"/create") || !_wcsicmp(verb, L"/change")) {
        if (!name[0]) {
            p("ERROR: The task name is required.\n");
            return 1;
        }
        if (staged && !force && !_wcsicmp(verb, L"/create")) {
            p("ERROR: The task \"%ls\" already exists.\n", name);
            return 1;
        }
        WsTask *t = task_alloc(name);
        if (!t) return 1;
        t->deleted = 0;
        const wchar_t *tr = task_arg(argc, argv, L"/tr");
        const wchar_t *sc = task_arg(argc, argv, L"/sc");
        if (tr) wcsncpy(t->cmd, tr, WS_TASK_CMD - 1);
        if (sc) wcsncpy(t->sched, sc, WS_TASK_SCHED - 1);
        if (!task_journal(journal, L"create", t)) {
            p("ERROR: cannot record the task (staging journal unavailable).\n");
            return 1;
        }
        p("SUCCESS: The scheduled task \"%ls\" has successfully been created.\n", name);
        return 0;
    }
    if (!_wcsicmp(verb, L"/delete")) {
        if (!staged) {
            return run_real_schtasks(argc, argv);
        }
        WsTask *t = task_find(name);
        t->deleted = 1;
        task_journal(journal, L"delete", t);
        p("SUCCESS: The scheduled task \"%ls\" was successfully deleted.\n", name);
        return 0;
    }
    if (!_wcsicmp(verb, L"/run")) {
        if (!staged) return run_real_schtasks(argc, argv);
        p("SUCCESS: Attempted to run the scheduled task \"%ls\".\n", name);
        return 0;
    }
    if (!_wcsicmp(verb, L"/end")) {
        if (!staged) return run_real_schtasks(argc, argv);
        p("SUCCESS: The scheduled task \"%ls\" has been terminated.\n", name);
        return 0;
    }
    if (!_wcsicmp(verb, L"/query")) {
        if (name[0]) {
            if (!staged) return run_real_schtasks(argc, argv);
            WsTask *t = task_find(name);
            if (task_has_flag(argc, argv, L"/fo") && task_arg(argc, argv, L"/fo") &&
                _wcsicmp(task_arg(argc, argv, L"/fo"), L"LIST") == 0) {
                task_print_list(t);
            } else {
                task_print_table(t);
            }
            return 0;
        }
        /* Without /tn: real tasks are shown by the real CLI; staged ones are
         * appended so a created task is at least visible. */
        int rc = run_real_schtasks(argc, argv);
        for (int i = 0; i < WS_TASK_MAX; i++) {
            if (g_tasks[i].used && !g_tasks[i].deleted) {
                task_print_table(&g_tasks[i]);
            }
        }
        return rc;
    }
    return run_real_schtasks(argc, argv);
}

int ws_sc_main(int argc, wchar_t **argv)
{
    if (argc < 1) {
        p("Description:\n        SC is a command line program used for communicating with the\n"
          "        Service Control Manager and services.\n");
        return 0;
    }
    const wchar_t *verb = argv[0];
    if (!_wcsicmp(verb, L"create")) return cmd_create(argc, argv);
    if (!_wcsicmp(verb, L"config")) return cmd_config(argc, argv);
    if (!_wcsicmp(verb, L"delete")) return cmd_delete(argc, argv);
    if (!_wcsicmp(verb, L"start")) return cmd_start(argc, argv);
    if (!_wcsicmp(verb, L"stop")) return cmd_stop(argc, argv);
    if (!_wcsicmp(verb, L"qc")) return cmd_qc(argc, argv);
    if (!_wcsicmp(verb, L"query")) return cmd_query(argc, argv, 0);
    if (!_wcsicmp(verb, L"queryex")) return cmd_query(argc, argv, 1);
    if (!_wcsicmp(verb, L"description")) return cmd_description(argc, argv);
    if (!_wcsicmp(verb, L"qdescription")) return cmd_description(argc, argv);
    /* Not virtualized: sdset/failure/triggerinfo and anything else. Fail with a
     * normal SCM error shape instead of silently reaching the real services.exe. */
    sc_error(verb, ERROR_INVALID_PARAMETER);
    return ERROR_INVALID_PARAMETER;
}
