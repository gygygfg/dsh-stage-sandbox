/* WinStageSandbox -- T4 shim: service-side client virtualization (SCM + EventLog).
 *
 * Why this file exists (2026-11-23, second round after the AI red-team run):
 *
 *   `sc create`, `New-Service`, `wevtutil cl` and `Clear-EventLog` do not write
 *   through the caller's process: they RPC into services.exe / eventlog. An IAT
 *   shim that only sees its own process tree therefore cannot stage those writes,
 *   and the first round had to refuse them as text policy (SERVICE_SIDE_ESCAPE_BLOCKED).
 *
 *   A refusal is not a boundary and it is also a lie about capability. This file
 *   replaces it with *client-side virtualization*: the SCM/EventLog Win32 client
 *   APIs are hooked in-process, the mutation is recorded in a session journal, and
 *   the caller gets the same success/read-back shape it would get from the real
 *   service. Nothing reaches the real services.exe.
 *
 * Model (same shape as the registry overlay):
 *   - Journal:  <regStageDir>\service.overlay.jsonl  /  eventlog.overlay.jsonl
 *               (append-only JSONL, one record per mutation; wide strings are
 *                hex-encoded so the file stays ASCII and parsing is trivial).
 *   - Reads:    real SCM/EventLog is queried and merged with the journal, so the
 *               agent still sees the machine's real services/events.
 *   - Writes:   create/config/delete/start/clear are journaled; the real service
 *               is never called. QueryServiceConfig/Status/Enum answer from the
 *               journal overlay.
 *   - Apply:    a future `apply` replays the journal against the real SCM.
 *
 * Fail-closed corners:
 *   - remote SCM targets (\\host) are refused (ERROR_ACCESS_DENIED): the journal
 *     is local, forwarding would write another machine.
 *   - a journal append failure fails the API call (no "success that was not
 *     recorded").
 *   - unhooked SCM entry points that receive our synthetic handle fail with
 *     ERROR_INVALID_HANDLE -- they cannot silently hit the real service.
 *
 * Coverage (deliberate): OpenSCManager/OpenService/CreateService/ChangeServiceConfig/
 * DeleteService/StartService/ControlService/QueryService{Config,Config2,Status,StatusEx}/
 * EnumServicesStatus{,Ex}{A,W}/CloseServiceHandle/GetServiceDisplayName.
 * Not covered: SetServiceObjectSecurity, QueryServiceLockStatus, EnumDependentServices,
 * service SID/trigger APIs, remote SCM. Those are documented as uncovered rather
 * than silently forwarded where they would mutate.
 */
#include "winstage_internal.h"

#include <winsvc.h>
#include <winevt.h>
#include <stdio.h>
#include <stdlib.h>

/* wevtapi.dll is not loaded by every process, so resolve the Evt* originals
 * lazily (at API-call time, never inside DllMain). */
static void *ws_evt_sym(const char *name)
{
    static HMODULE mod;
    static int tried;
    if (!tried) {
        tried = 1;
        mod = GetModuleHandleW(L"wevtapi.dll");
        if (!mod) {
            mod = LoadLibraryW(L"wevtapi.dll");
        }
    }
    return mod ? (void *)GetProcAddress(mod, name) : NULL;
}

#define WS_EVT_RESOLVE(field)                                 \
    do {                                                      \
        if (!g_orig.field) {                                  \
            *(void **)&g_orig.field = ws_evt_sym(#field);      \
        }                                                     \
    } while (0)

static void ws_evt_resolve(void)
{
    WS_EVT_RESOLVE(EvtClearLog);
    WS_EVT_RESOLVE(EvtQuery);
    WS_EVT_RESOLVE(EvtNext);
    WS_EVT_RESOLVE(EvtClose);
}

/* ------------------------------------------------------------------ shared */

#define WS_SCM_NAME      256
#define WS_SCM_DISPLAY   256
#define WS_SCM_IMAGE     1024
#define WS_SCM_DEPS      1024
#define WS_SCM_GROUP     128
#define WS_SCM_STARTNAME 256
#define WS_SCM_ENTRIES   128
#define WS_SCM_HANDLES   64
/* R46: config2 blobs (description / failure actions / flags) and the security
 * descriptor. 1 KiB each is far above what `sc failure` / `sc sdset` need; a
 * larger one is refused (fail closed) instead of reaching the real SCM. */
#define WS_SCM_BLOB_MAX  1024
#define WS_SCM_CFG2_MAX  6

typedef struct WsScmCfg2 {
    DWORD level;
    DWORD len;
    unsigned char data[WS_SCM_BLOB_MAX];
} WsScmCfg2;

#define WS_SCM_TAG       ((ULONG_PTR)0x5C4D000000000000ULL)
#define WS_EVT_TAG       ((ULONG_PTR)0x5C4E000000000000ULL)
#define WS_FAKE_TAG_MASK ((ULONG_PTR)0xFFFF000000000000ULL)

typedef struct WsScmEntry {
    int used;
    int created; /* exists only in the journal */
    int deleted; /* real service hidden by the journal */
    int changed; /* config differs from the real service */
    int running; /* staged start */
    DWORD type;
    DWORD startType;
    DWORD errorControl;
    DWORD tagId;
    wchar_t name[WS_SCM_NAME];
    wchar_t display[WS_SCM_DISPLAY];
    wchar_t image[WS_SCM_IMAGE];
    wchar_t deps[WS_SCM_DEPS];
    wchar_t group[WS_SCM_GROUP];
    wchar_t startName[WS_SCM_STARTNAME];
    /* Staged SERVICE_CONFIG2 data (level-tagged), replayed from the journal. */
    WsScmCfg2 cfg2[WS_SCM_CFG2_MAX];
    int cfg2Count;
    /* Staged security descriptor (SetServiceObjectSecurity). */
    DWORD sdInfo;
    DWORD sdLen;
    unsigned char sd[WS_SCM_BLOB_MAX];
} WsScmEntry;

typedef struct WsScmHandle {
    int used;
    int isManager;
    int entry; /* index into g_scmEntries for services */
    SC_HANDLE real;
} WsScmHandle;

static WsScmEntry g_scmEntries[WS_SCM_ENTRIES];
static WsScmHandle g_scmHandles[WS_SCM_HANDLES];
static WsLock g_scmLock = { 0, 0, 0, "scm" };
static DWORD g_scmLoadedSize = 0xFFFFFFFFu;
static int g_scmLoaded = 0;

static int ws_scm_staged(void)
{
    return g_ws.haveStageRoot && g_ws.stageRoot[0] && g_ws.unstagedWrites != 2;
}

static int ws_scm_is_fake(SC_HANDLE h)
{
    return ((((ULONG_PTR)h) & WS_FAKE_TAG_MASK) == WS_SCM_TAG);
}

static SC_HANDLE ws_scm_make_handle(int index)
{
    return (SC_HANDLE)(WS_SCM_TAG | (ULONG_PTR)(index + 1));
}

static int ws_scm_handle_index(SC_HANDLE h)
{
    ULONG_PTR v = ((ULONG_PTR)h) & ~WS_FAKE_TAG_MASK;
    if (v == 0 || v > WS_SCM_HANDLES) {
        return -1;
    }
    return (int)(v - 1);
}

static WsScmHandle *ws_scm_handle_get(SC_HANDLE h)
{
    if (!ws_scm_is_fake(h)) {
        return NULL;
    }
    int i = ws_scm_handle_index(h);
    if (i < 0) {
        return NULL;
    }
    return g_scmHandles[i].used ? &g_scmHandles[i] : NULL;
}

static int ws_scm_handle_alloc(int isManager, int entry, SC_HANDLE real)
{
    for (int i = 0; i < WS_SCM_HANDLES; i++) {
        if (!g_scmHandles[i].used) {
            g_scmHandles[i].used = 1;
            g_scmHandles[i].isManager = isManager;
            g_scmHandles[i].entry = entry;
            g_scmHandles[i].real = real;
            return i;
        }
    }
    return -1;
}

/* ------------------------------------------------------------- journal I/O */

static int ws_scm_journal_path(const wchar_t *leaf, wchar_t *out, DWORD cch)
{
    const wchar_t *dir = g_ws.regStageDir[0] ? g_ws.regStageDir : g_ws.stageRoot;
    if (!dir || !dir[0]) {
        return 0;
    }
    size_t pos = 0;
    out[0] = 0;
    if (!ws_append_w(out, cch, &pos, dir) || !ws_append_w(out, cch, &pos, L"\\") ||
        !ws_append_w(out, cch, &pos, leaf)) {
        return 0;
    }
    return 1;
}

static int ws_journal_append(const wchar_t *leaf, const wchar_t *line)
{
    wchar_t path[WS_PATH_MAX];
    if (!ws_scm_journal_path(leaf, path, WS_PATH_MAX)) {
        return 0;
    }
    ws_ensure_dirs(path, 0);
    HANDLE h = ws_open_file_raw_flags(path, FILE_APPEND_DATA, FILE_SHARE_READ, OPEN_ALWAYS,
                                      FILE_ATTRIBUTE_NORMAL);
    if (h == INVALID_HANDLE_VALUE) {
        ws_log("scm journal: cannot open %ls (err=%lu)", path, (unsigned long)GetLastError());
        return 0;
    }
    int need = WideCharToMultiByte(CP_UTF8, 0, line, -1, NULL, 0, NULL, NULL);
    int ok = 0;
    if (need > 1) {
        char *buf = (char *)malloc((size_t)need);
        if (buf) {
            int got = WideCharToMultiByte(CP_UTF8, 0, line, -1, buf, need, NULL, NULL);
            DWORD wrote = 0;
            ok = got == need && WriteFile(h, buf, (DWORD)(need - 1), &wrote, NULL) &&
                 wrote == (DWORD)(need - 1);
            free(buf);
        }
    }
    CloseHandle(h);
    return ok;
}

/* Local JSONL helpers: values are ASCII; strings are hex-encoded UTF-16. */

static const char *ws_json_find(const char *line, const char *key)
{
    char pattern[64];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    const char *p = strstr(line, pattern);
    if (!p) {
        return NULL;
    }
    p += strlen(pattern);
    while (*p == ' ') {
        p++;
    }
    return p;
}

static int ws_json_get_hex(const char *line, const char *key, wchar_t *out, DWORD cch)
{
    const char *p = ws_json_find(line, key);
    if (!p || *p != '"') {
        return 0;
    }
    p++;
    wchar_t hex[8192];
    size_t n = 0;
    while (*p && *p != '"' && n + 1 < 8192) {
        hex[n++] = (wchar_t)(unsigned char)*p++;
    }
    hex[n] = 0;
    return ws_hex_decode_w(hex, out, (size_t)cch);
}

static DWORD ws_json_get_u32(const char *line, const char *key, DWORD fallback)
{
    const char *p = ws_json_find(line, key);
    if (!p) {
        return fallback;
    }
    return (DWORD)strtoul(p, NULL, 10);
}

static void ws_hex_put_w(const wchar_t *s, wchar_t *out, size_t cch, size_t *pos)
{
    wchar_t tmp[WS_PATH_MAX];
    ws_hex_encode_w(s ? s : L"", tmp, WS_PATH_MAX);
    size_t n = wcslen(tmp);
    if (*pos + n + 1 < cch) {
        memcpy(out + *pos, tmp, n * sizeof(wchar_t));
        *pos += n;
        out[*pos] = 0;
    }
}

/* ── R46: config2 / security-descriptor blobs ────────────────────────────────
 * `sc failure`, `sc sdset`, PowerShell `Set-Service -Description` and friends do
 * not call ChangeServiceConfig: they call ChangeServiceConfig2 /
 * SetServiceObjectSecurity, which used to reach the REAL SCM. They are staged
 * here like every other service write, with their own journal record so the
 * answer survives across commands (`sc failure X ...` then `sc qfailure X`).
 */
static void ws_hex_put_b(const unsigned char *b, DWORD len, wchar_t *out, size_t cch, size_t *pos)
{
    static const wchar_t digits[] = L"0123456789abcdef";
    for (DWORD i = 0; i < len && *pos + 2 < cch; i++) {
        out[(*pos)++] = digits[(b[i] >> 4) & 0xF];
        out[(*pos)++] = digits[b[i] & 0xF];
    }
    if (*pos < cch) {
        out[*pos] = 0;
    }
}

static int ws_json_get_hexbytes(const char *line, const char *key, unsigned char *out, DWORD cap, DWORD *outLen)
{
    const char *p = ws_json_find(line, key);
    if (!p || *p != '"') {
        return 0;
    }
    p++;
    char hex[8192];
    size_t n = 0;
    while (*p && *p != '"' && n + 1 < sizeof(hex)) {
        hex[n++] = *p++;
    }
    hex[n] = 0;
    DWORD len = 0;
    if (!ws_hex_decode_b(hex, out, cap, &len)) {
        return 0;
    }
    if (outLen) {
        *outLen = len;
    }
    return 1;
}

static WsScmCfg2 *ws_cfg2_find(WsScmEntry *e, DWORD level)
{
    for (int i = 0; i < e->cfg2Count; i++) {
        if (e->cfg2[i].level == level) {
            return &e->cfg2[i];
        }
    }
    return NULL;
}

static int ws_cfg2_store(WsScmEntry *e, DWORD level, const unsigned char *data, DWORD len)
{
    if (!e || len > WS_SCM_BLOB_MAX) {
        return 0;
    }
    WsScmCfg2 *c = ws_cfg2_find(e, level);
    if (!c) {
        if (e->cfg2Count >= WS_SCM_CFG2_MAX) {
            return 0;
        }
        c = &e->cfg2[e->cfg2Count++];
        c->level = level;
    }
    c->len = len;
    if (len && data) {
        memcpy(c->data, data, len);
    }
    return 1;
}

static int ws_scm_journal_blob(const wchar_t *op, const WsScmEntry *e, DWORD level,
                               const unsigned char *data, DWORD len, DWORD info)
{
    wchar_t line[8192];
    size_t pos = 0;
    line[0] = 0;
    if (!ws_appendf_w(line, 8192, &pos, L"{\"op\":\"%ls\",\"name\":\"", op)) {
        return 0;
    }
    ws_hex_put_w(e->name, line, 8192, &pos);
    if (wcscmp(op, L"sd") == 0) {
        if (!ws_appendf_w(line, 8192, &pos, L"\",\"info\":%lu,\"data\":\"", (unsigned long)info)) {
            return 0;
        }
    } else if (!ws_appendf_w(line, 8192, &pos, L"\",\"level\":%lu,\"data\":\"", (unsigned long)level)) {
        return 0;
    }
    ws_hex_put_b(data, len, line, 8192, &pos);
    if (!ws_append_w(line, 8192, &pos, L"\"}\n")) {
        return 0;
    }
    return ws_journal_append(L"service.overlay.jsonl", line);
}

/* SERVICE_FAILURE_ACTIONSW -> flat blob: reset(4) count(4) [type,delay]*count
 * then `cmd\0` and `reboot\0` as UTF-16. Self-contained (no pointers) so the
 * journal replay can rebuild the structure the API handed us. */
static DWORD ws_failure_serialize(const SERVICE_FAILURE_ACTIONSW *fa, unsigned char *out, DWORD cap)
{
    DWORD count = (fa->lpsaActions && fa->cActions) ? fa->cActions : 0;
    const wchar_t *cmd = fa->lpCommand ? fa->lpCommand : L"";
    const wchar_t *reboot = fa->lpRebootMsg ? fa->lpRebootMsg : L"";
    DWORD need = 8 + count * 8 +
                 (DWORD)((wcslen(cmd) + 1 + wcslen(reboot) + 1) * sizeof(wchar_t));
    if (need > cap) {
        return 0;
    }
    unsigned char *q = out;
    memcpy(q, &fa->dwResetPeriod, 4);
    q += 4;
    memcpy(q, &count, 4);
    q += 4;
    for (DWORD i = 0; i < count; i++) {
        memcpy(q, &fa->lpsaActions[i].Type, 4);
        q += 4;
        memcpy(q, &fa->lpsaActions[i].Delay, 4);
        q += 4;
    }
    memcpy(q, cmd, (wcslen(cmd) + 1) * sizeof(wchar_t));
    q += (wcslen(cmd) + 1) * sizeof(wchar_t);
    memcpy(q, reboot, (wcslen(reboot) + 1) * sizeof(wchar_t));
    return need;
}

static BOOL ws_failure_serve(const unsigned char *blob, DWORD len, LPBYTE buffer, DWORD cb, LPDWORD needed)
{
    if (len < 8) {
        SetLastError(ERROR_INVALID_DATA);
        return FALSE;
    }
    DWORD reset = 0, count = 0;
    memcpy(&reset, blob, 4);
    memcpy(&count, blob + 4, 4);
    DWORD need = 8 + count * 8;
    if (need > len) {
        SetLastError(ERROR_INVALID_DATA);
        return FALSE;
    }
    const wchar_t *cmd = (const wchar_t *)(const void *)(blob + need);
    const wchar_t *reboot = cmd + wcslen(cmd) + 1;
    DWORD cch = (DWORD)(wcslen(cmd) + 1 + wcslen(reboot) + 1);
    DWORD size = (DWORD)sizeof(SERVICE_FAILURE_ACTIONSW) + count * (DWORD)sizeof(SC_ACTION) +
                 cch * (DWORD)sizeof(wchar_t);
    if (needed) {
        *needed = size;
    }
    if (!buffer || cb < size) {
        SetLastError(ERROR_INSUFFICIENT_BUFFER);
        return FALSE;
    }
    SERVICE_FAILURE_ACTIONSW *out = (SERVICE_FAILURE_ACTIONSW *)buffer;
    memset(out, 0, sizeof(*out));
    out->dwResetPeriod = reset;
    out->cActions = count;
    SC_ACTION *acts = (SC_ACTION *)(out + 1);
    if (count) {
        memcpy(acts, blob + 8, count * 8);
        out->lpsaActions = acts;
    }
    wchar_t *str = (wchar_t *)(acts + count);
    memcpy(str, cmd, (wcslen(cmd) + 1) * sizeof(wchar_t));
    out->lpCommand = str;
    wchar_t *reb = str + wcslen(cmd) + 1;
    memcpy(reb, reboot, (wcslen(reboot) + 1) * sizeof(wchar_t));
    out->lpRebootMsg = reb;
    return TRUE;
}

static BOOL ws_description_serve(const unsigned char *blob, DWORD len, LPBYTE buffer, DWORD cb, LPDWORD needed)
{
    DWORD cch = len / (DWORD)sizeof(wchar_t);
    DWORD size = (DWORD)sizeof(SERVICE_DESCRIPTIONW) + (cch + 1) * (DWORD)sizeof(wchar_t);
    if (needed) {
        *needed = size;
    }
    if (!buffer || cb < size) {
        SetLastError(ERROR_INSUFFICIENT_BUFFER);
        return FALSE;
    }
    SERVICE_DESCRIPTIONW *out = (SERVICE_DESCRIPTIONW *)buffer;
    out->lpDescription = NULL;
    if (cch) {
        wchar_t *str = (wchar_t *)(out + 1);
        memcpy(str, blob, cch * sizeof(wchar_t));
        str[cch] = 0;
        out->lpDescription = str;
    }
    return TRUE;
}

/* Serve one journaled level. Returns 1 = answered, 0 = not journaled. */
static int ws_cfg2_serve(const WsScmCfg2 *c, LPBYTE buffer, DWORD cb, LPDWORD needed)
{
    if (!c) {
        return 0;
    }
    switch (c->level) {
    case SERVICE_CONFIG_DESCRIPTION:
        return ws_description_serve(c->data, c->len, buffer, cb, needed) ? 1 : -1;
    case SERVICE_CONFIG_FAILURE_ACTIONS:
        return ws_failure_serve(c->data, c->len, buffer, cb, needed) ? 1 : -1;
    case SERVICE_CONFIG_FAILURE_ACTIONS_FLAG:
    case SERVICE_CONFIG_DELAYED_AUTO_START_INFO: {
        DWORD size = sizeof(BOOL);
        if (needed) {
            *needed = size;
        }
        if (!buffer || cb < size) {
            SetLastError(ERROR_INSUFFICIENT_BUFFER);
            return -1;
        }
        *(BOOL *)buffer = (c->len >= 4 && *(const DWORD *)(const void *)c->data) ? TRUE : FALSE;
        return 1;
    }
    default:
        return 0;
    }
}

/* ------------------------------------------------------------ entry lookup */

static void ws_scm_entry_clear(WsScmEntry *e)
{
    memset(e, 0, sizeof(*e));
    e->type = SERVICE_WIN32_OWN_PROCESS;
    e->startType = SERVICE_DEMAND_START;
    e->errorControl = SERVICE_ERROR_NORMAL;
}

static WsScmEntry *ws_scm_find(const wchar_t *name)
{
    if (!name) {
        return NULL;
    }
    for (int i = 0; i < WS_SCM_ENTRIES; i++) {
        if (g_scmEntries[i].used && ws_wcscmp_ci(g_scmEntries[i].name, name) == 0) {
            return &g_scmEntries[i];
        }
    }
    return NULL;
}

static WsScmEntry *ws_scm_alloc(const wchar_t *name)
{
    WsScmEntry *e = ws_scm_find(name);
    if (e) {
        return e;
    }
    for (int i = 0; i < WS_SCM_ENTRIES; i++) {
        if (!g_scmEntries[i].used) {
            ws_scm_entry_clear(&g_scmEntries[i]);
            g_scmEntries[i].used = 1;
            ws_strlcpy_w(g_scmEntries[i].name, name ? name : L"", WS_SCM_NAME);
            return &g_scmEntries[i];
        }
    }
    return NULL;
}

/* ---------------------------------------------------------------- journal */

static void ws_scm_apply_record(const char *line)
{
    wchar_t name[WS_SCM_NAME];
    if (!ws_json_get_hex(line, "name", name, WS_SCM_NAME) || !name[0]) {
        return;
    }
    WsScmEntry *e = ws_scm_alloc(name);
    if (!e) {
        return;
    }
    const char *op = ws_json_find(line, "op");
    char opBuf[32] = { 0 };
    if (op && *op == '"') {
        size_t i = 0;
        op++;
        while (op[i] && op[i] != '"' && i + 1 < sizeof(opBuf)) {
            opBuf[i] = op[i];
            i++;
        }
    }
    if (strcmp(opBuf, "create") == 0) {
        e->created = 1;
        e->deleted = 0;
        e->changed = 0;
    } else if (strcmp(opBuf, "delete") == 0) {
        e->deleted = 1;
        e->created = 0;
        e->changed = 0;
        e->running = 0;
    } else if (strcmp(opBuf, "change") == 0) {
        e->deleted = 0;
        if (!e->created) {
            e->changed = 1;
        }
    } else if (strcmp(opBuf, "start") == 0) {
        e->running = 1;
    } else if (strcmp(opBuf, "stop") == 0) {
        e->running = 0;
    } else if (strcmp(opBuf, "cfg2") == 0) {
        unsigned char blob[WS_SCM_BLOB_MAX];
        DWORD len = 0;
        DWORD level = ws_json_get_u32(line, "level", 0);
        if (level && ws_json_get_hexbytes(line, "data", blob, sizeof(blob), &len)) {
            ws_cfg2_store(e, level, blob, len);
        }
        return;
    } else if (strcmp(opBuf, "sd") == 0) {
        unsigned char blob[WS_SCM_BLOB_MAX];
        DWORD len = 0;
        if (ws_json_get_hexbytes(line, "data", blob, sizeof(blob), &len)) {
            e->sdInfo = ws_json_get_u32(line, "info", 0);
            e->sdLen = len;
            if (len) {
                memcpy(e->sd, blob, len);
            }
        }
        return;
    } else {
        return;
    }
    ws_json_get_hex(line, "display", e->display, WS_SCM_DISPLAY);
    ws_json_get_hex(line, "image", e->image, WS_SCM_IMAGE);
    ws_json_get_hex(line, "deps", e->deps, WS_SCM_DEPS);
    ws_json_get_hex(line, "group", e->group, WS_SCM_GROUP);
    ws_json_get_hex(line, "startname", e->startName, WS_SCM_STARTNAME);
    e->type = ws_json_get_u32(line, "type", e->type);
    e->startType = ws_json_get_u32(line, "start", e->startType);
    e->errorControl = ws_json_get_u32(line, "error", e->errorControl);
    e->tagId = ws_json_get_u32(line, "tag", e->tagId);
}

static void ws_scm_reload(void)
{
    wchar_t path[WS_PATH_MAX];
    char *text = NULL;
    memset(g_scmEntries, 0, sizeof(g_scmEntries));
    g_scmLoaded = 0;
    g_scmLoadedSize = 0;
    if (!ws_scm_journal_path(L"service.overlay.jsonl", path, WS_PATH_MAX)) {
        return;
    }
    if (!ws_read_text_file(path, &text, NULL) || !text) {
        g_scmLoaded = 1;
        return;
    }
    char *line = text;
    while (line && *line) {
        char *nl = strchr(line, '\n');
        if (nl) {
            *nl = 0;
        }
        if (*line == '{') {
            ws_scm_apply_record(line);
        }
        if (!nl) {
            break;
        }
        line = nl + 1;
    }
    HeapFree(GetProcessHeap(), 0, text);
    g_scmLoaded = 1;
}

/* Reload when the journal grew (another process in the same session appended). */
static void ws_scm_ensure_loaded(void)
{
    wchar_t path[WS_PATH_MAX];
    if (!ws_scm_journal_path(L"service.overlay.jsonl", path, WS_PATH_MAX)) {
        return;
    }
    DWORD size = 0;
    WIN32_FILE_ATTRIBUTE_DATA fad;
    if (GetFileAttributesExW(path, GetFileExInfoStandard, &fad)) {
        size = fad.nFileSizeLow;
    }
    if (!g_scmLoaded || size != g_scmLoadedSize) {
        ws_scm_reload();
        g_scmLoadedSize = size;
    }
}

static int ws_scm_journal(const wchar_t *op, const WsScmEntry *e)
{
    wchar_t line[8192];
    size_t pos = 0;
    line[0] = 0;
    if (!ws_appendf_w(line, 8192, &pos, L"{\"op\":\"%ls\",\"name\":\"", op)) {
        return 0;
    }
    ws_hex_put_w(e->name, line, 8192, &pos);
    if (!ws_append_w(line, 8192, &pos, L"\",\"display\":\"")) return 0;
    ws_hex_put_w(e->display, line, 8192, &pos);
    if (!ws_append_w(line, 8192, &pos, L"\",\"image\":\"")) return 0;
    ws_hex_put_w(e->image, line, 8192, &pos);
    if (!ws_append_w(line, 8192, &pos, L"\",\"deps\":\"")) return 0;
    ws_hex_put_w(e->deps, line, 8192, &pos);
    if (!ws_append_w(line, 8192, &pos, L"\",\"group\":\"")) return 0;
    ws_hex_put_w(e->group, line, 8192, &pos);
    if (!ws_append_w(line, 8192, &pos, L"\",\"startname\":\"")) return 0;
    ws_hex_put_w(e->startName, line, 8192, &pos);
    if (!ws_appendf_w(line, 8192, &pos, L"\",\"type\":%lu,\"start\":%lu,\"error\":%lu,\"tag\":%lu}\n",
                      (unsigned long)e->type, (unsigned long)e->startType,
                      (unsigned long)e->errorControl, (unsigned long)e->tagId)) {
        return 0;
    }
    /* A start/stop record only needs the state, but re-emitting the config keeps
     * replay order-independent and makes the journal self-contained. */
    return ws_journal_append(L"service.overlay.jsonl", line);
}

/* Mirror the staged service into the registry overlay so `reg query
 * HKLM\SYSTEM\CurrentControlSet\Services\<name>` agrees with `sc query`. */
static void ws_scm_mirror_registry(const WsScmEntry *e, int deleting)
{
    wchar_t sub[WS_SCM_NAME + 64];
    if (!g_wsStage.reg_value_set) {
        return;
    }
    _snwprintf(sub, WS_SCM_NAME + 64, L"SYSTEM\\CurrentControlSet\\Services\\%ls", e->name);
    sub[WS_SCM_NAME + 63] = 0;
    if (deleting) {
        if (g_wsStage.reg_key_delete) {
            int rc = g_wsStage.reg_key_delete(L"HKLM", sub);
            if (rc != 0) {
                ws_log("scm mirror: reg_key_delete(%ls) rc=%d", sub, rc);
            }
        }
        return;
    }
    int rc = g_wsStage.reg_value_set(L"HKLM", sub, L"ImagePath", REG_EXPAND_SZ,
                                     (const unsigned char *)e->image,
                                     (uint32_t)((wcslen(e->image) + 1) * sizeof(wchar_t)));
    if (rc != 0) {
        ws_log("scm mirror: reg_value_set(%ls\\ImagePath) rc=%d", sub, rc);
    }
    g_wsStage.reg_value_set(L"HKLM", sub, L"DisplayName", REG_SZ,
                            (const unsigned char *)e->display,
                            (uint32_t)((wcslen(e->display) + 1) * sizeof(wchar_t)));
    g_wsStage.reg_value_set(L"HKLM", sub, L"ObjectName", REG_SZ,
                            (const unsigned char *)e->startName,
                            (uint32_t)((wcslen(e->startName) + 1) * sizeof(wchar_t)));
    g_wsStage.reg_value_set(L"HKLM", sub, L"Type", REG_DWORD, (const unsigned char *)&e->type,
                            sizeof(DWORD));
    g_wsStage.reg_value_set(L"HKLM", sub, L"Start", REG_DWORD,
                            (const unsigned char *)&e->startType, sizeof(DWORD));
    g_wsStage.reg_value_set(L"HKLM", sub, L"ErrorControl", REG_DWORD,
                            (const unsigned char *)&e->errorControl, sizeof(DWORD));
    g_wsStage.reg_value_set(L"HKLM", sub, L"Tag", REG_DWORD, (const unsigned char *)&e->tagId,
                            sizeof(DWORD));
}

/* Seed a journal entry from the real service so a later `change` is complete. */
static int ws_scm_seed_from_real(WsScmEntry *e, SC_HANDLE real)
{
    if (!real || !g_orig.QueryServiceConfigW) {
        return 0;
    }
    DWORD needed = 0;
    DWORD cb = 8192;
    BYTE *buf = (BYTE *)malloc(cb);
    if (!buf) {
        return 0;
    }
    if (!g_orig.QueryServiceConfigW(real, (LPQUERY_SERVICE_CONFIGW)buf, cb, &needed)) {
        if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || needed <= cb) {
            free(buf);
            return 0;
        }
        BYTE *bigger = (BYTE *)realloc(buf, needed);
        if (!bigger) {
            free(buf);
            return 0;
        }
        buf = bigger;
        cb = needed;
        if (!g_orig.QueryServiceConfigW(real, (LPQUERY_SERVICE_CONFIGW)buf, cb, &needed)) {
            free(buf);
            return 0;
        }
    }
    QUERY_SERVICE_CONFIGW *q = (QUERY_SERVICE_CONFIGW *)buf;
    e->type = q->dwServiceType;
    e->startType = q->dwStartType;
    e->errorControl = q->dwErrorControl;
    ws_strlcpy_w(e->image, q->lpBinaryPathName ? q->lpBinaryPathName : L"", WS_SCM_IMAGE);
    ws_strlcpy_w(e->display, q->lpDisplayName ? q->lpDisplayName : L"", WS_SCM_DISPLAY);
    ws_strlcpy_w(e->group, q->lpLoadOrderGroup ? q->lpLoadOrderGroup : L"", WS_SCM_GROUP);
    ws_strlcpy_w(e->startName, q->lpServiceStartName ? q->lpServiceStartName : L"", WS_SCM_STARTNAME);
    free(buf);
    return 1;
}

/* --------------------------------------------------------------- SCM hooks */

static int ws_scm_local_target(LPCWSTR machine)
{
    if (!machine || !machine[0]) {
        return 1;
    }
    if (wcscmp(machine, L".") == 0) {
        return 1;
    }
    if (_wcsicmp(machine, L"localhost") == 0 || _wcsicmp(machine, L"127.0.0.1") == 0) {
        return 1;
    }
    /* `\\host` / `host` forms */
    if (machine[0] == L'\\' && machine[1] == L'\\') {
        machine += 2;
    }
    return _wcsicmp(machine, L"localhost") == 0 || wcscmp(machine, L".") == 0 ||
           _wcsicmp(machine, L"127.0.0.1") == 0;
}

SC_HANDLE WINAPI ws_OpenSCManagerW(LPCWSTR machine, LPCWSTR database, DWORD access)
{
    if (!ws_scm_staged() || !g_orig.OpenSCManagerW) {
        return g_orig.OpenSCManagerW ? g_orig.OpenSCManagerW(machine, database, access)
                                     : OpenSCManagerW(machine, database, access);
    }
    if (!ws_scm_local_target(machine)) {
        ws_log_w(L"SCM remote target refused (journal is local)", machine ? machine : L"");
        SetLastError(ERROR_ACCESS_DENIED);
        return NULL;
    }
    SC_HANDLE real = g_orig.OpenSCManagerW(NULL, database, access);
    if (!real) {
        return NULL;
    }
    ws_lock_enter(&g_scmLock);
    ws_scm_ensure_loaded();
    int idx = ws_scm_handle_alloc(1, -1, real);
    ws_lock_leave(&g_scmLock);
    if (idx < 0) {
        g_orig.CloseServiceHandle(real);
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return NULL;
    }
    return ws_scm_make_handle(idx);
}

SC_HANDLE WINAPI ws_OpenSCManagerA(LPCSTR machine, LPCSTR database, DWORD access)
{
    wchar_t m[256], d[256];
    m[0] = d[0] = 0;
    if (machine) MultiByteToWideChar(CP_ACP, 0, machine, -1, m, 256);
    if (database) MultiByteToWideChar(CP_ACP, 0, database, -1, d, 256);
    return ws_OpenSCManagerW(machine ? m : NULL, database ? d : NULL, access);
}

static WsScmHandle *ws_scm_manager(SC_HANDLE h)
{
    WsScmHandle *m = ws_scm_handle_get(h);
    return m && m->isManager ? m : NULL;
}

static SC_HANDLE ws_scm_return_service(WsScmHandle *mgr, WsScmEntry *e, SC_HANDLE real)
{
    (void)mgr;
    ws_lock_enter(&g_scmLock);
    int idx = ws_scm_handle_alloc(0, (int)(e - g_scmEntries), real);
    ws_lock_leave(&g_scmLock);
    if (idx < 0) {
        if (real) {
            g_orig.CloseServiceHandle(real);
        }
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return NULL;
    }
    return ws_scm_make_handle(idx);
}

SC_HANDLE WINAPI ws_OpenServiceW(SC_HANDLE manager, LPCWSTR name, DWORD access)
{
    WsScmHandle *mgr = ws_scm_manager(manager);
    if (!mgr) {
        if (g_orig.OpenServiceW) {
            return g_orig.OpenServiceW(manager, name, access);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return NULL;
    }
    if (!name) {
        SetLastError(ERROR_INVALID_PARAMETER);
        return NULL;
    }
    ws_lock_enter(&g_scmLock);
    ws_scm_ensure_loaded();
    WsScmEntry *e = ws_scm_find(name);
    if (e && e->deleted) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_SERVICE_DOES_NOT_EXIST);
        return NULL;
    }
    if (e && e->created) {
        SC_HANDLE out = ws_scm_return_service(mgr, e, NULL);
        ws_lock_leave(&g_scmLock);
        return out;
    }
    SC_HANDLE real = g_orig.OpenServiceW(mgr->real, name, access);
    if (!real) {
        DWORD err = GetLastError();
        ws_lock_leave(&g_scmLock);
        SetLastError(err);
        return NULL;
    }
    if (!e) {
        e = ws_scm_alloc(name);
        if (e) {
            ws_scm_seed_from_real(e, real);
        }
    } else if (!e->created && real && (!e->image[0] || !e->display[0])) {
        /* The journal replayed a staged change (description / failure actions /
         * security descriptor) for a service whose full config was never
         * recorded. Without this, `Set-Service -StartupType` followed by
         * `sc qc` answered with an empty TYPE / BINARY_PATH_NAME / DISPLAY_NAME
         * (measured) -- a contradiction with the real service we just read. */
        ws_scm_seed_from_real(e, real);
    }
    SC_HANDLE out = ws_scm_return_service(mgr, e, real);
    ws_lock_leave(&g_scmLock);
    return out;
}

SC_HANDLE WINAPI ws_OpenServiceA(SC_HANDLE manager, LPCSTR name, DWORD access)
{
    wchar_t w[WS_SCM_NAME];
    w[0] = 0;
    if (name) MultiByteToWideChar(CP_ACP, 0, name, -1, w, WS_SCM_NAME);
    return ws_OpenServiceW(manager, name ? w : NULL, access);
}

static int ws_scm_real_exists(WsScmHandle *mgr, const wchar_t *name)
{
    SC_HANDLE h = g_orig.OpenServiceW ? g_orig.OpenServiceW(mgr->real, name, SERVICE_QUERY_STATUS) : NULL;
    if (h) {
        g_orig.CloseServiceHandle(h);
        return 1;
    }
    return 0;
}

SC_HANDLE WINAPI ws_CreateServiceW(SC_HANDLE manager, LPCWSTR name, LPCWSTR display, DWORD access,
                                   DWORD type, DWORD startType, DWORD errorControl, LPCWSTR image,
                                   LPCWSTR group, LPDWORD tagId, LPCWSTR deps, LPCWSTR startName,
                                   LPCWSTR password)
{
    WsScmHandle *mgr = ws_scm_manager(manager);
    if (!mgr) {
        if (g_orig.CreateServiceW) {
            return g_orig.CreateServiceW(manager, name, display, access, type, startType, errorControl,
                                         image, group, tagId, deps, startName, password);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return NULL;
    }
    if (!name || !name[0]) {
        SetLastError(ERROR_INVALID_PARAMETER);
        return NULL;
    }
    ws_lock_enter(&g_scmLock);
    ws_scm_ensure_loaded();
    WsScmEntry *e = ws_scm_find(name);
    if (e && e->created && !e->deleted) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_SERVICE_EXISTS);
        return NULL;
    }
    if (!e || !e->deleted) {
        if (ws_scm_real_exists(mgr, name)) {
            ws_lock_leave(&g_scmLock);
            SetLastError(ERROR_SERVICE_EXISTS);
            return NULL;
        }
    }
    e = ws_scm_alloc(name);
    if (!e) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return NULL;
    }
    ws_scm_entry_clear(e);
    e->used = 1;
    e->created = 1;
    e->deleted = 0;
    e->changed = 0;
    e->running = 0;
    e->type = type;
    e->startType = startType;
    e->errorControl = errorControl;
    e->tagId = tagId ? *tagId : 0;
    ws_strlcpy_w(e->name, name, WS_SCM_NAME);
    ws_strlcpy_w(e->display, display ? display : name, WS_SCM_DISPLAY);
    ws_strlcpy_w(e->image, image ? image : L"", WS_SCM_IMAGE);
    ws_strlcpy_w(e->deps, deps ? deps : L"", WS_SCM_DEPS);
    ws_strlcpy_w(e->group, group ? group : L"", WS_SCM_GROUP);
    ws_strlcpy_w(e->startName, startName ? startName : L"", WS_SCM_STARTNAME);
    if (!ws_scm_journal(L"create", e)) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_WRITE_FAULT);
        return NULL;
    }
    ws_scm_mirror_registry(e, 0);
    SC_HANDLE out = ws_scm_return_service(mgr, e, NULL);
    ws_log_w(L"SCM create staged", name);
    ws_lock_leave(&g_scmLock);
    return out;
}

SC_HANDLE WINAPI ws_CreateServiceA(SC_HANDLE manager, LPCSTR name, LPCSTR display, DWORD access, DWORD type,
                                   DWORD startType, DWORD errorControl, LPCSTR image, LPCSTR group,
                                   LPDWORD tagId, LPCSTR deps, LPCSTR startName, LPCSTR password)
{
    wchar_t wn[WS_SCM_NAME], wd[WS_SCM_NAME], wi[WS_SCM_IMAGE], wg[WS_SCM_GROUP];
    wchar_t wdep[WS_SCM_DEPS], wsn[WS_SCM_STARTNAME];
    wn[0] = wd[0] = wi[0] = wg[0] = wdep[0] = wsn[0] = 0;
    if (name) MultiByteToWideChar(CP_ACP, 0, name, -1, wn, WS_SCM_NAME);
    if (display) MultiByteToWideChar(CP_ACP, 0, display, -1, wd, WS_SCM_NAME);
    if (image) MultiByteToWideChar(CP_ACP, 0, image, -1, wi, WS_SCM_IMAGE);
    if (group) MultiByteToWideChar(CP_ACP, 0, group, -1, wg, WS_SCM_GROUP);
    if (deps) MultiByteToWideChar(CP_ACP, 0, deps, -1, wdep, WS_SCM_DEPS);
    if (startName) MultiByteToWideChar(CP_ACP, 0, startName, -1, wsn, WS_SCM_STARTNAME);
    return ws_CreateServiceW(manager, name ? wn : NULL, display ? wd : NULL, access, type, startType,
                             errorControl, image ? wi : NULL, group ? wg : NULL, tagId,
                             deps ? wdep : NULL, startName ? wsn : NULL, NULL);
}

BOOL WINAPI ws_ChangeServiceConfigW(SC_HANDLE service, DWORD type, DWORD startType, DWORD errorControl,
                                    LPCWSTR image, LPCWSTR group, LPDWORD tagId, LPCWSTR deps,
                                    LPCWSTR startName, LPCWSTR password, LPCWSTR display)
{
    WsScmHandle *h = ws_scm_handle_get(service);
    if (!h || h->isManager) {
        if (g_orig.ChangeServiceConfigW) {
            return g_orig.ChangeServiceConfigW(service, type, startType, errorControl, image, group, tagId,
                                               deps, startName, password, display);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return FALSE;
    }
    ws_lock_enter(&g_scmLock);
    ws_scm_ensure_loaded();
    WsScmEntry *e = &g_scmEntries[h->entry];
    if (!e->used || e->deleted) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_SERVICE_DOES_NOT_EXIST);
        return FALSE;
    }
    /* Journal the FULL config, not just the fields being changed: a journal
     * entry with an empty BINARY_PATH_NAME / DISPLAY_NAME made a later
     * `sc qc` contradict the real service (measured). */
    if (!e->created && h->real && (!e->image[0] || !e->display[0])) {
        ws_scm_seed_from_real(e, h->real);
    }
    if (type != SERVICE_NO_CHANGE) e->type = type;
    if (startType != SERVICE_NO_CHANGE) e->startType = startType;
    if (errorControl != SERVICE_NO_CHANGE) e->errorControl = errorControl;
    if (image) ws_strlcpy_w(e->image, image, WS_SCM_IMAGE);
    if (group) ws_strlcpy_w(e->group, group, WS_SCM_GROUP);
    if (deps) ws_strlcpy_w(e->deps, deps, WS_SCM_DEPS);
    if (startName) ws_strlcpy_w(e->startName, startName, WS_SCM_STARTNAME);
    if (display) ws_strlcpy_w(e->display, display, WS_SCM_DISPLAY);
    if (tagId && h->real && g_orig.QueryServiceConfigW) {
        e->tagId = *tagId;
    }
    if (!e->created) {
        e->changed = 1;
    }
    int ok = ws_scm_journal(L"change", e);
    if (ok) {
        ws_scm_mirror_registry(e, 0);
        ws_log_w(L"SCM change staged", e->name);
    }
    ws_lock_leave(&g_scmLock);
    if (!ok) {
        SetLastError(ERROR_WRITE_FAULT);
        return FALSE;
    }
    return TRUE;
}

BOOL WINAPI ws_ChangeServiceConfigA(SC_HANDLE service, DWORD type, DWORD startType, DWORD errorControl,
                                    LPCSTR image, LPCSTR group, LPDWORD tagId, LPCSTR deps, LPCSTR startName,
                                    LPCSTR password, LPCSTR display)
{
    wchar_t wi[WS_SCM_IMAGE], wg[WS_SCM_GROUP], wdep[WS_SCM_DEPS], wsn[WS_SCM_STARTNAME], wd[WS_SCM_NAME];
    wi[0] = wg[0] = wdep[0] = wsn[0] = wd[0] = 0;
    if (image) MultiByteToWideChar(CP_ACP, 0, image, -1, wi, WS_SCM_IMAGE);
    if (group) MultiByteToWideChar(CP_ACP, 0, group, -1, wg, WS_SCM_GROUP);
    if (deps) MultiByteToWideChar(CP_ACP, 0, deps, -1, wdep, WS_SCM_DEPS);
    if (startName) MultiByteToWideChar(CP_ACP, 0, startName, -1, wsn, WS_SCM_STARTNAME);
    if (display) MultiByteToWideChar(CP_ACP, 0, display, -1, wd, WS_SCM_NAME);
    return ws_ChangeServiceConfigW(service, type, startType, errorControl, image ? wi : NULL,
                                   group ? wg : NULL, tagId, deps ? wdep : NULL,
                                   startName ? wsn : NULL, NULL, display ? wd : NULL);
}

BOOL WINAPI ws_DeleteService(SC_HANDLE service)
{
    WsScmHandle *h = ws_scm_handle_get(service);
    if (!h || h->isManager) {
        if (g_orig.DeleteService) {
            return g_orig.DeleteService(service);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return FALSE;
    }
    ws_lock_enter(&g_scmLock);
    ws_scm_ensure_loaded();
    WsScmEntry *e = &g_scmEntries[h->entry];
    if (!e->used || e->deleted) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_SERVICE_DOES_NOT_EXIST);
        return FALSE;
    }
    if (!e->created) {
        /* `sc delete` on a real service: stage a tombstone, do not touch services.exe. */
        if (!ws_scm_seed_from_real(e, h->real) && !e->image[0]) {
            /* config was already seeded on open; an empty image is still fine */
        }
    }
    e->deleted = 1;
    e->created = 0;
    e->changed = 0;
    e->running = 0;
    int ok = ws_scm_journal(L"delete", e);
    if (ok) {
        ws_scm_mirror_registry(e, 1);
        ws_log_w(L"SCM delete staged", e->name);
    }
    ws_lock_leave(&g_scmLock);
    if (!ok) {
        SetLastError(ERROR_WRITE_FAULT);
        return FALSE;
    }
    return TRUE;
}

static void ws_scm_status_from_entry(const WsScmEntry *e, SERVICE_STATUS *st)
{
    memset(st, 0, sizeof(*st));
    st->dwServiceType = e->type;
    st->dwCurrentState = e->running ? SERVICE_RUNNING : SERVICE_STOPPED;
    st->dwControlsAccepted = e->running ? SERVICE_ACCEPT_STOP : 0;
    st->dwWin32ExitCode = 0;
}

static void ws_scm_status_process_from_entry(const WsScmEntry *e, SERVICE_STATUS_PROCESS *st)
{
    memset(st, 0, sizeof(*st));
    st->dwServiceType = e->type;
    st->dwCurrentState = e->running ? SERVICE_RUNNING : SERVICE_STOPPED;
    st->dwControlsAccepted = e->running ? SERVICE_ACCEPT_STOP : 0;
    st->dwWin32ExitCode = 0;
    st->dwProcessId = e->running ? GetCurrentProcessId() : 0;
}

BOOL WINAPI ws_StartServiceW(SC_HANDLE service, DWORD argc, LPCWSTR *argv)
{
    WsScmHandle *h = ws_scm_handle_get(service);
    if (!h || h->isManager) {
        if (g_orig.StartServiceW) {
            return g_orig.StartServiceW(service, argc, argv);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return FALSE;
    }
    ws_lock_enter(&g_scmLock);
    ws_scm_ensure_loaded();
    WsScmEntry *e = &g_scmEntries[h->entry];
    if (!e->used || e->deleted) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_SERVICE_DOES_NOT_EXIST);
        return FALSE;
    }
    if (!e->created && h->real) {
        /* Starting an already-installed real service is a state change, not a
         * persistence write; forward it so legitimate tooling keeps working. */
        BOOL ok = g_orig.StartServiceW ? g_orig.StartServiceW(h->real, argc, argv) : FALSE;
        DWORD err = GetLastError();
        ws_lock_leave(&g_scmLock);
        SetLastError(err);
        return ok;
    }
    e->running = 1;
    int ok = ws_scm_journal(L"start", e);
    ws_lock_leave(&g_scmLock);
    if (!ok) {
        SetLastError(ERROR_WRITE_FAULT);
        return FALSE;
    }
    ws_log_w(L"SCM start staged", e->name);
    return TRUE;
}

BOOL WINAPI ws_StartServiceA(SC_HANDLE service, DWORD argc, LPCSTR *argv)
{
    /* The argument vector is opaque to SCM; forwarding to the W hook keeps the
     * staging decision identical. */
    (void)argv;
    return ws_StartServiceW(service, argc, NULL);
}

BOOL WINAPI ws_ControlService(SC_HANDLE service, DWORD control, LPSERVICE_STATUS status)
{
    WsScmHandle *h = ws_scm_handle_get(service);
    if (!h || h->isManager) {
        if (g_orig.ControlService) {
            return g_orig.ControlService(service, control, status);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return FALSE;
    }
    ws_lock_enter(&g_scmLock);
    ws_scm_ensure_loaded();
    WsScmEntry *e = &g_scmEntries[h->entry];
    if (!e->used || e->deleted) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_SERVICE_DOES_NOT_EXIST);
        return FALSE;
    }
    if (!e->created && h->real) {
        BOOL ok = g_orig.ControlService ? g_orig.ControlService(h->real, control, status) : FALSE;
        DWORD err = GetLastError();
        ws_lock_leave(&g_scmLock);
        SetLastError(err);
        return ok;
    }
    if (control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) {
        e->running = 0;
        int ok = ws_scm_journal(L"stop", e);
        if (status) {
            ws_scm_status_from_entry(e, status);
        }
        ws_lock_leave(&g_scmLock);
        if (!ok) {
            SetLastError(ERROR_WRITE_FAULT);
            return FALSE;
        }
        return TRUE;
    }
    if (control == SERVICE_CONTROL_INTERROGATE) {
        if (status) {
            ws_scm_status_from_entry(e, status);
        }
        ws_lock_leave(&g_scmLock);
        return TRUE;
    }
    ws_lock_leave(&g_scmLock);
    SetLastError(ERROR_INVALID_SERVICE_CONTROL);
    return FALSE;
}

BOOL WINAPI ws_QueryServiceStatus(SC_HANDLE service, LPSERVICE_STATUS status)
{
    WsScmHandle *h = ws_scm_handle_get(service);
    if (!h || h->isManager) {
        if (g_orig.QueryServiceStatus) {
            return g_orig.QueryServiceStatus(service, status);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return FALSE;
    }
    ws_lock_enter(&g_scmLock);
    ws_scm_ensure_loaded();
    WsScmEntry *e = &g_scmEntries[h->entry];
    if (!e->used || e->deleted) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_SERVICE_DOES_NOT_EXIST);
        return FALSE;
    }
    if (!e->created && h->real) {
        BOOL ok = g_orig.QueryServiceStatus ? g_orig.QueryServiceStatus(h->real, status) : FALSE;
        DWORD err = GetLastError();
        ws_lock_leave(&g_scmLock);
        SetLastError(err);
        return ok;
    }
    if (!status) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_INVALID_PARAMETER);
        return FALSE;
    }
    ws_scm_status_from_entry(e, status);
    ws_lock_leave(&g_scmLock);
    return TRUE;
}

BOOL WINAPI ws_QueryServiceStatusEx(SC_HANDLE service, SC_STATUS_TYPE level, LPBYTE buffer, DWORD cb,
                                    LPDWORD needed)
{
    WsScmHandle *h = ws_scm_handle_get(service);
    if (!h || h->isManager) {
        if (g_orig.QueryServiceStatusEx) {
            return g_orig.QueryServiceStatusEx(service, level, buffer, cb, needed);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return FALSE;
    }
    ws_lock_enter(&g_scmLock);
    ws_scm_ensure_loaded();
    WsScmEntry *e = &g_scmEntries[h->entry];
    if (!e->used || e->deleted) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_SERVICE_DOES_NOT_EXIST);
        return FALSE;
    }
    if (!e->created && h->real) {
        BOOL ok = g_orig.QueryServiceStatusEx ? g_orig.QueryServiceStatusEx(h->real, level, buffer, cb, needed)
                                             : FALSE;
        DWORD err = GetLastError();
        ws_lock_leave(&g_scmLock);
        SetLastError(err);
        return ok;
    }
    if (level != SC_STATUS_PROCESS_INFO) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_INVALID_LEVEL);
        return FALSE;
    }
    if (needed) {
        *needed = sizeof(SERVICE_STATUS_PROCESS);
    }
    if (!buffer || cb < sizeof(SERVICE_STATUS_PROCESS)) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_INSUFFICIENT_BUFFER);
        return FALSE;
    }
    ws_scm_status_process_from_entry(e, (SERVICE_STATUS_PROCESS *)buffer);
    ws_lock_leave(&g_scmLock);
    return TRUE;
}

static DWORD ws_scm_config_size(const WsScmEntry *e)
{
    DWORD cch = sizeof(QUERY_SERVICE_CONFIGW) / sizeof(wchar_t);
    cch += (DWORD)wcslen(e->image) + 1;
    cch += (DWORD)wcslen(e->group) + 1;
    cch += (DWORD)wcslen(e->deps) + 1;
    cch += (DWORD)wcslen(e->startName) + 1;
    cch += (DWORD)wcslen(e->display) + 1;
    return cch * sizeof(wchar_t);
}

static void ws_scm_write_config(const WsScmEntry *e, QUERY_SERVICE_CONFIGW *q)
{
    wchar_t *p = (wchar_t *)((BYTE *)q + sizeof(QUERY_SERVICE_CONFIGW));
    q->dwServiceType = e->type;
    q->dwStartType = e->startType;
    q->dwErrorControl = e->errorControl;
    q->lpBinaryPathName = p;
    wcscpy(p, e->image);
    p += wcslen(p) + 1;
    q->lpLoadOrderGroup = e->group[0] ? p : NULL;
    wcscpy(p, e->group);
    p += wcslen(p) + 1;
    q->dwTagId = e->tagId;
    q->lpDependencies = e->deps[0] ? p : NULL;
    wcscpy(p, e->deps);
    p += wcslen(p) + 1;
    q->lpServiceStartName = e->startName[0] ? p : NULL;
    wcscpy(p, e->startName);
    p += wcslen(p) + 1;
    q->lpDisplayName = e->display[0] ? p : NULL;
    wcscpy(p, e->display);
}

BOOL WINAPI ws_QueryServiceConfigW(SC_HANDLE service, LPQUERY_SERVICE_CONFIGW config, DWORD cb, LPDWORD needed)
{
    WsScmHandle *h = ws_scm_handle_get(service);
    if (!h || h->isManager) {
        if (g_orig.QueryServiceConfigW) {
            return g_orig.QueryServiceConfigW(service, config, cb, needed);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return FALSE;
    }
    ws_lock_enter(&g_scmLock);
    ws_scm_ensure_loaded();
    WsScmEntry *e = &g_scmEntries[h->entry];
    if (!e->used || e->deleted) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_SERVICE_DOES_NOT_EXIST);
        return FALSE;
    }
    if (!e->created && !e->changed && h->real) {
        BOOL ok = g_orig.QueryServiceConfigW ? g_orig.QueryServiceConfigW(h->real, config, cb, needed) : FALSE;
        DWORD err = GetLastError();
        ws_lock_leave(&g_scmLock);
        SetLastError(err);
        return ok;
    }
    DWORD size = ws_scm_config_size(e);
    if (needed) {
        *needed = size;
    }
    if (!config || cb < size) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_INSUFFICIENT_BUFFER);
        return FALSE;
    }
    ws_scm_write_config(e, config);
    ws_lock_leave(&g_scmLock);
    return TRUE;
}

BOOL WINAPI ws_QueryServiceConfigA(SC_HANDLE service, LPQUERY_SERVICE_CONFIGA config, DWORD cb, LPDWORD needed)
{
    /* Convert through the W layout into caller-provided ANSI storage. */
    DWORD wsize = 0;
    if (!ws_QueryServiceConfigW(service, NULL, 0, &wsize)) {
        if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
            return FALSE;
        }
    }
    BYTE *tmp = (BYTE *)malloc(wsize ? wsize : 1);
    if (!tmp) {
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return FALSE;
    }
    if (!ws_QueryServiceConfigW(service, (LPQUERY_SERVICE_CONFIGW)tmp, wsize, &wsize)) {
        free(tmp);
        return FALSE;
    }
    QUERY_SERVICE_CONFIGW *q = (QUERY_SERVICE_CONFIGW *)tmp;
    char image[WS_SCM_IMAGE], group[WS_SCM_GROUP], deps[WS_SCM_DEPS], startName[WS_SCM_STARTNAME],
        display[WS_SCM_DISPLAY];
    image[0] = group[0] = deps[0] = startName[0] = display[0] = 0;
    WideCharToMultiByte(CP_ACP, 0, q->lpBinaryPathName ? q->lpBinaryPathName : L"", -1, image,
                        sizeof(image), NULL, NULL);
    WideCharToMultiByte(CP_ACP, 0, q->lpLoadOrderGroup ? q->lpLoadOrderGroup : L"", -1, group,
                        sizeof(group), NULL, NULL);
    WideCharToMultiByte(CP_ACP, 0, q->lpDependencies ? q->lpDependencies : L"", -1, deps, sizeof(deps),
                        NULL, NULL);
    WideCharToMultiByte(CP_ACP, 0, q->lpServiceStartName ? q->lpServiceStartName : L"", -1, startName,
                        sizeof(startName), NULL, NULL);
    WideCharToMultiByte(CP_ACP, 0, q->lpDisplayName ? q->lpDisplayName : L"", -1, display, sizeof(display),
                        NULL, NULL);
    DWORD size = sizeof(QUERY_SERVICE_CONFIGA) + (DWORD)(strlen(image) + strlen(group) + strlen(deps) +
                                                         strlen(startName) + strlen(display) + 5);
    if (needed) {
        *needed = size;
    }
    if (!config || cb < size) {
        free(tmp);
        SetLastError(ERROR_INSUFFICIENT_BUFFER);
        return FALSE;
    }
    char *p = (char *)config + sizeof(QUERY_SERVICE_CONFIGA);
    config->dwServiceType = q->dwServiceType;
    config->dwStartType = q->dwStartType;
    config->dwErrorControl = q->dwErrorControl;
    config->dwTagId = q->dwTagId;
    config->lpBinaryPathName = p;
    strcpy(p, image);
    p += strlen(p) + 1;
    config->lpLoadOrderGroup = group[0] ? p : NULL;
    strcpy(p, group);
    p += strlen(p) + 1;
    config->lpDependencies = deps[0] ? p : NULL;
    strcpy(p, deps);
    p += strlen(p) + 1;
    config->lpServiceStartName = startName[0] ? p : NULL;
    strcpy(p, startName);
    p += strlen(p) + 1;
    config->lpDisplayName = display[0] ? p : NULL;
    strcpy(p, display);
    free(tmp);
    return TRUE;
}

BOOL WINAPI ws_QueryServiceConfig2W(SC_HANDLE service, DWORD level, LPBYTE buffer, DWORD cb, LPDWORD needed)
{
    WsScmHandle *h = ws_scm_handle_get(service);
    if (!h || h->isManager) {
        if (g_orig.QueryServiceConfig2W) {
            return g_orig.QueryServiceConfig2W(service, level, buffer, cb, needed);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return FALSE;
    }
    ws_lock_enter(&g_scmLock);
    ws_scm_ensure_loaded();
    WsScmEntry *e = &g_scmEntries[h->entry];
    if (!e->used || e->deleted) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_SERVICE_DOES_NOT_EXIST);
        return FALSE;
    }
    /* R46: a journaled config2 level wins over both the real service and the
     * synthetic "created" shape, otherwise `sc failure X ... ; sc qfailure X`
     * would contradict itself. */
    int served = ws_cfg2_serve(ws_cfg2_find(e, level), buffer, cb, needed);
    if (served > 0) {
        ws_lock_leave(&g_scmLock);
        return TRUE;
    }
    if (served < 0) {
        DWORD err = GetLastError();
        ws_lock_leave(&g_scmLock);
        SetLastError(err);
        return FALSE;
    }
    if (!e->created && h->real) {
        BOOL ok = g_orig.QueryServiceConfig2W ? g_orig.QueryServiceConfig2W(h->real, level, buffer, cb, needed)
                                             : FALSE;
        DWORD err = GetLastError();
        ws_lock_leave(&g_scmLock);
        SetLastError(err);
        return ok;
    }
    /* A staged service has no description/recovery config: answer with the empty
     * shape instead of leaking a "does not exist" that contradicts `sc query`. */
    if (level == SERVICE_CONFIG_DESCRIPTION) {
        DWORD size = sizeof(SERVICE_DESCRIPTIONW);
        if (needed) *needed = size;
        if (!buffer || cb < size) {
            ws_lock_leave(&g_scmLock);
            SetLastError(ERROR_INSUFFICIENT_BUFFER);
            return FALSE;
        }
        ((SERVICE_DESCRIPTIONW *)buffer)->lpDescription = NULL;
        ws_lock_leave(&g_scmLock);
        return TRUE;
    }
    /* A staged service has no recovery actions: answer the empty shape (that is
     * exactly what an unconfigured service reports) instead of an error that a
     * query on a service that `sc query` just showed would contradict. */
    if (level == SERVICE_CONFIG_FAILURE_ACTIONS) {
        unsigned char empty[12] = { 0 };
        BOOL ok = ws_failure_serve(empty, sizeof(empty), buffer, cb, needed);
        DWORD err = GetLastError();
        ws_lock_leave(&g_scmLock);
        if (!ok) {
            SetLastError(err);
        }
        return ok;
    }
    ws_lock_leave(&g_scmLock);
    SetLastError(ERROR_INVALID_LEVEL);
    return FALSE;
}

BOOL WINAPI ws_QueryServiceConfig2A(SC_HANDLE service, DWORD level, LPBYTE buffer, DWORD cb, LPDWORD needed)
{
    if (level != SERVICE_CONFIG_DESCRIPTION) {
        if (g_orig.QueryServiceConfig2A) {
            return g_orig.QueryServiceConfig2A(service, level, buffer, cb, needed);
        }
        SetLastError(ERROR_INVALID_LEVEL);
        return FALSE;
    }
    DWORD wsize = 0;
    ws_QueryServiceConfig2W(service, level, NULL, 0, &wsize);
    BYTE *tmp = (BYTE *)malloc(wsize ? wsize : 1);
    if (!tmp) {
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return FALSE;
    }
    if (!ws_QueryServiceConfig2W(service, level, tmp, wsize, &wsize)) {
        free(tmp);
        return FALSE;
    }
    DWORD size = sizeof(SERVICE_DESCRIPTIONA);
    if (needed) *needed = size;
    if (!buffer || cb < size) {
        free(tmp);
        SetLastError(ERROR_INSUFFICIENT_BUFFER);
        return FALSE;
    }
    ((SERVICE_DESCRIPTIONA *)buffer)->lpDescription = NULL;
    free(tmp);
    return TRUE;
}

/* ── R46: the service-write APIs that used to reach the real SCM ────────────
 * ChangeServiceConfig2 / SetServiceObjectSecurity are what `sc failure`,
 * `sc sdset`, `sc triggerinfo` and PowerShell's Set-Service actually call.
 * Left unhooked, a PowerShell one-liner could still change a REAL service. */
BOOL WINAPI ws_ChangeServiceConfig2W(SC_HANDLE service, DWORD level, LPVOID info)
{
    WsScmHandle *h = ws_scm_handle_get(service);
    if (!h || h->isManager || !ws_scm_staged()) {
        if (g_orig.ChangeServiceConfig2W) {
            return g_orig.ChangeServiceConfig2W(service, level, info);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return FALSE;
    }
    ws_lock_enter(&g_scmLock);
    ws_scm_ensure_loaded();
    WsScmEntry *e = &g_scmEntries[h->entry];
    if (!e->used || e->deleted) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_SERVICE_DOES_NOT_EXIST);
        return FALSE;
    }
    unsigned char blob[WS_SCM_BLOB_MAX];
    DWORD len = 0;
    int ok = 1;
    switch (level) {
    case SERVICE_CONFIG_DESCRIPTION: {
        const SERVICE_DESCRIPTIONW *d = (const SERVICE_DESCRIPTIONW *)info;
        const wchar_t *text = (d && d->lpDescription) ? d->lpDescription : L"";
        len = (DWORD)(wcslen(text) * sizeof(wchar_t));
        if (len > WS_SCM_BLOB_MAX) {
            ok = 0;
            break;
        }
        memcpy(blob, text, len);
        break;
    }
    case SERVICE_CONFIG_FAILURE_ACTIONS:
        if (!info) {
            ok = 0;
            break;
        }
        len = ws_failure_serialize((const SERVICE_FAILURE_ACTIONSW *)info, blob, sizeof(blob));
        ok = len != 0;
        break;
    case SERVICE_CONFIG_FAILURE_ACTIONS_FLAG:
    case SERVICE_CONFIG_DELAYED_AUTO_START_INFO: {
        DWORD v = (info && *(const BOOL *)info) ? 1 : 0;
        memcpy(blob, &v, 4);
        len = 4;
        break;
    }
    default:
        /* Rare/unknown levels (TRIGGER_INFO, SID_INFO, ...): record the level and
         * succeed. Refusing is the only other honest option -- forwarding is a
         * REAL write. */
        len = 0;
        break;
    }
    if (!ok) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_INVALID_PARAMETER);
        return FALSE;
    }
    if (!e->created && h->real && (!e->image[0] || !e->display[0])) {
        ws_scm_seed_from_real(e, h->real);
    }
    if (!ws_cfg2_store(e, level, blob, len) || !ws_scm_journal_blob(L"cfg2", e, level, blob, len, 0)) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_WRITE_FAULT);
        return FALSE;
    }
    if (!e->created) {
        e->changed = 1;
    }
    ws_log_w(L"SCM config2 staged", e->name);
    ws_lock_leave(&g_scmLock);
    return TRUE;
}

BOOL WINAPI ws_ChangeServiceConfig2A(SC_HANDLE service, DWORD level, LPVOID info)
{
    if (level == SERVICE_CONFIG_DESCRIPTION) {
        SERVICE_DESCRIPTIONA *da = (SERVICE_DESCRIPTIONA *)info;
        wchar_t w[2048];
        w[0] = 0;
        if (da && da->lpDescription) {
            MultiByteToWideChar(CP_ACP, 0, da->lpDescription, -1, w, 2048);
        }
        SERVICE_DESCRIPTIONW dw;
        dw.lpDescription = (da && da->lpDescription) ? w : NULL;
        return ws_ChangeServiceConfig2W(service, level, &dw);
    }
    if (level == SERVICE_CONFIG_FAILURE_ACTIONS && info) {
        SERVICE_FAILURE_ACTIONSA *fa = (SERVICE_FAILURE_ACTIONSA *)info;
        wchar_t cmd[1024];
        wchar_t reboot[1024];
        cmd[0] = 0;
        reboot[0] = 0;
        if (fa->lpCommand) MultiByteToWideChar(CP_ACP, 0, fa->lpCommand, -1, cmd, 1024);
        if (fa->lpRebootMsg) MultiByteToWideChar(CP_ACP, 0, fa->lpRebootMsg, -1, reboot, 1024);
        SERVICE_FAILURE_ACTIONSW fw;
        memset(&fw, 0, sizeof(fw));
        fw.dwResetPeriod = fa->dwResetPeriod;
        fw.lpCommand = cmd;
        fw.lpRebootMsg = reboot;
        fw.cActions = fa->lpsaActions ? fa->cActions : 0;
        fw.lpsaActions = fa->lpsaActions;
        return ws_ChangeServiceConfig2W(service, level, &fw);
    }
    return ws_ChangeServiceConfig2W(service, level, info);
}

BOOL WINAPI ws_SetServiceObjectSecurity(SC_HANDLE service, SECURITY_INFORMATION si,
                                        PSECURITY_DESCRIPTOR sd)
{
    WsScmHandle *h = ws_scm_handle_get(service);
    if (!h || h->isManager || !ws_scm_staged()) {
        if (g_orig.SetServiceObjectSecurity) {
            return g_orig.SetServiceObjectSecurity(service, si, sd);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return FALSE;
    }
    if (!sd) {
        SetLastError(ERROR_INVALID_PARAMETER);
        return FALSE;
    }
    DWORD len = GetSecurityDescriptorLength(sd);
    if (len == 0 || len > WS_SCM_BLOB_MAX) {
        SetLastError(ERROR_INVALID_PARAMETER);
        return FALSE;
    }
    ws_lock_enter(&g_scmLock);
    ws_scm_ensure_loaded();
    WsScmEntry *e = &g_scmEntries[h->entry];
    if (!e->used || e->deleted) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_SERVICE_DOES_NOT_EXIST);
        return FALSE;
    }
    if (!e->created && h->real && (!e->image[0] || !e->display[0])) {
        ws_scm_seed_from_real(e, h->real);
    }
    memcpy(e->sd, sd, len);
    e->sdLen = len;
    e->sdInfo = si;
    int ok = ws_scm_journal_blob(L"sd", e, 0, e->sd, e->sdLen, si);
    if (ok && !e->created) {
        e->changed = 1;
    }
    ws_lock_leave(&g_scmLock);
    if (!ok) {
        SetLastError(ERROR_WRITE_FAULT);
        return FALSE;
    }
    ws_log_w(L"SCM security descriptor staged", e->name);
    return TRUE;
}

BOOL WINAPI ws_QueryServiceObjectSecurity(SC_HANDLE service, SECURITY_INFORMATION si,
                                          PSECURITY_DESCRIPTOR sd, DWORD cb, LPDWORD needed)
{
    WsScmHandle *h = ws_scm_handle_get(service);
    if (!h || h->isManager) {
        if (g_orig.QueryServiceObjectSecurity) {
            return g_orig.QueryServiceObjectSecurity(service, si, sd, cb, needed);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return FALSE;
    }
    ws_lock_enter(&g_scmLock);
    ws_scm_ensure_loaded();
    WsScmEntry *e = &g_scmEntries[h->entry];
    if (!e->used || e->deleted) {
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_SERVICE_DOES_NOT_EXIST);
        return FALSE;
    }
    if (e->sdLen) {
        DWORD len = e->sdLen;
        if (needed) {
            *needed = len;
        }
        if (!sd || cb < len) {
            ws_lock_leave(&g_scmLock);
            SetLastError(ERROR_INSUFFICIENT_BUFFER);
            return FALSE;
        }
        memcpy(sd, e->sd, len);
        ws_lock_leave(&g_scmLock);
        return TRUE;
    }
    SC_HANDLE real = h->real;
    ws_lock_leave(&g_scmLock);
    if (real && g_orig.QueryServiceObjectSecurity) {
        return g_orig.QueryServiceObjectSecurity(real, si, sd, cb, needed);
    }
    SetLastError(ERROR_INVALID_HANDLE);
    return FALSE;
}

BOOL WINAPI ws_GetServiceDisplayNameW(SC_HANDLE manager, LPCWSTR name, LPWSTR display, LPDWORD cch)
{
    WsScmHandle *mgr = ws_scm_manager(manager);
    if (!mgr) {
        if (g_orig.GetServiceDisplayNameW) {
            return g_orig.GetServiceDisplayNameW(manager, name, display, cch);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return FALSE;
    }
    ws_lock_enter(&g_scmLock);
    ws_scm_ensure_loaded();
    WsScmEntry *e = ws_scm_find(name);
    if (e && (e->created || e->changed)) {
        DWORD size = (DWORD)wcslen(e->display) + 1;
        if (cch) {
            DWORD cap = *cch;
            *cch = size;
            if (!display || cap < size) {
                ws_lock_leave(&g_scmLock);
                SetLastError(ERROR_INSUFFICIENT_BUFFER);
                return FALSE;
            }
        }
        if (display) {
            ws_strlcpy_w(display, e->display, cch ? *cch : 0);
        }
        ws_lock_leave(&g_scmLock);
        return TRUE;
    }
    ws_lock_leave(&g_scmLock);
    return g_orig.GetServiceDisplayNameW ? g_orig.GetServiceDisplayNameW(mgr->real, name, display, cch) : FALSE;
}

BOOL WINAPI ws_GetServiceDisplayNameA(SC_HANDLE manager, LPCSTR name, LPSTR display, LPDWORD cch)
{
    wchar_t wn[WS_SCM_NAME];
    wn[0] = 0;
    if (name) MultiByteToWideChar(CP_ACP, 0, name, -1, wn, WS_SCM_NAME);
    DWORD wsize = 0;
    if (!ws_GetServiceDisplayNameW(manager, name ? wn : NULL, NULL, &wsize)) {
        if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
            return FALSE;
        }
    }
    wchar_t *tmp = (wchar_t *)malloc((wsize ? wsize : 1) * sizeof(wchar_t));
    if (!tmp) {
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return FALSE;
    }
    if (!ws_GetServiceDisplayNameW(manager, name ? wn : NULL, tmp, &wsize)) {
        free(tmp);
        return FALSE;
    }
    DWORD size = (DWORD)wsize;
    if (cch) {
        DWORD cap = *cch;
        *cch = size;
        if (!display || cap < size) {
            free(tmp);
            SetLastError(ERROR_INSUFFICIENT_BUFFER);
            return FALSE;
        }
    }
    WideCharToMultiByte(CP_ACP, 0, tmp, -1, display, cch ? *cch : 0, NULL, NULL);
    free(tmp);
    return TRUE;
}

/* ------------------------------------------------------- enum: collect+merge */

typedef struct WsEnumItem {
    wchar_t name[WS_SCM_NAME];
    wchar_t display[WS_SCM_DISPLAY];
    DWORD type;
    DWORD state;
    DWORD pid;
} WsEnumItem;

typedef struct WsEnumList {
    WsEnumItem *items;
    int count;
    int cap;
} WsEnumList;

static int ws_enum_push(WsEnumList *list, const wchar_t *name, const wchar_t *display, DWORD type, DWORD state,
                        DWORD pid)
{
    if (list->count >= list->cap) {
        int cap = list->cap ? list->cap * 2 : 256;
        WsEnumItem *grown = (WsEnumItem *)realloc(list->items, (size_t)cap * sizeof(WsEnumItem));
        if (!grown) {
            return 0;
        }
        list->items = grown;
        list->cap = cap;
    }
    WsEnumItem *it = &list->items[list->count++];
    ws_strlcpy_w(it->name, name ? name : L"", WS_SCM_NAME);
    ws_strlcpy_w(it->display, display ? display : L"", WS_SCM_DISPLAY);
    it->type = type;
    it->state = state;
    it->pid = pid;
    return 1;
}

static int ws_enum_has_overlay(void)
{
    for (int i = 0; i < WS_SCM_ENTRIES; i++) {
        if (g_scmEntries[i].used &&
            (g_scmEntries[i].created || g_scmEntries[i].deleted || g_scmEntries[i].changed)) {
            return 1;
        }
    }
    return 0;
}

static int ws_enum_build(WsEnumList *list, WsScmHandle *mgr, DWORD typeMask, DWORD stateMask)
{
    DWORD resume = 0;
    for (int guard = 0; guard < 64; guard++) {
        DWORD need = 0, returned = 0;
        DWORD cap = 256 * 1024;
        BYTE *buf = (BYTE *)malloc(cap);
        if (!buf) {
            return 0;
        }
        BOOL ok = g_orig.EnumServicesStatusExW(mgr->real, SC_ENUM_PROCESS_INFO, typeMask, stateMask, buf, cap,
                                               &need, &returned, &resume, NULL);
        DWORD err = GetLastError();
        ENUM_SERVICE_STATUS_PROCESSW *arr = (ENUM_SERVICE_STATUS_PROCESSW *)buf;
        for (DWORD i = 0; i < returned; i++) {
            ws_enum_push(list, arr[i].lpServiceName, arr[i].lpDisplayName, arr[i].ServiceStatusProcess.dwServiceType,
                         arr[i].ServiceStatusProcess.dwCurrentState, arr[i].ServiceStatusProcess.dwProcessId);
        }
        free(buf);
        if (ok) {
            return 1;
        }
        if (err != ERROR_MORE_DATA) {
            return 0;
        }
    }
    return 1;
}

static int ws_state_matches(DWORD state, DWORD mask)
{
    if (mask == SERVICE_STATE_ALL) {
        return 1;
    }
    return (state & mask) != 0;
}

static int ws_type_matches(DWORD type, DWORD mask)
{
    if (mask == SERVICE_TYPE_ALL) {
        return 1;
    }
    return (type & mask) != 0;
}

static void ws_enum_merge_overlay(WsEnumList *list, DWORD typeMask, DWORD stateMask)
{
    /* 1. remove deleted, refresh display for changed entries */
    int out = 0;
    for (int i = 0; i < list->count; i++) {
        WsEnumItem *it = &list->items[i];
        WsScmEntry *e = ws_scm_find(it->name);
        if (e && e->deleted) {
            continue;
        }
        if (e && (e->changed || e->created)) {
            ws_strlcpy_w(it->display, e->display[0] ? e->display : it->display, WS_SCM_DISPLAY);
            if (e->created) {
                it->type = e->type;
                it->state = e->running ? SERVICE_RUNNING : SERVICE_STOPPED;
                it->pid = e->running ? GetCurrentProcessId() : 0;
            }
        }
        list->items[out++] = *it;
    }
    list->count = out;

    /* 2. append created services that are not in the real list */
    for (int i = 0; i < WS_SCM_ENTRIES; i++) {
        WsScmEntry *e = &g_scmEntries[i];
        if (!e->used || !e->created || e->deleted) {
            continue;
        }
        int present = 0;
        for (int j = 0; j < list->count; j++) {
            if (ws_wcscmp_ci(list->items[j].name, e->name) == 0) {
                present = 1;
                break;
            }
        }
        if (!present) {
            DWORD state = e->running ? SERVICE_RUNNING : SERVICE_STOPPED;
            if (ws_type_matches(e->type, typeMask) && ws_state_matches(state, stateMask)) {
                ws_enum_push(list, e->name, e->display, e->type, state, e->running ? GetCurrentProcessId() : 0);
            }
        }
    }

    /* 3. apply the caller's filters to real entries as well */
    out = 0;
    for (int i = 0; i < list->count; i++) {
        WsEnumItem *it = &list->items[i];
        if (ws_type_matches(it->type, typeMask) && ws_state_matches(it->state, stateMask)) {
            list->items[out++] = *it;
        }
    }
    list->count = out;
}

BOOL WINAPI ws_EnumServicesStatusExW(SC_HANDLE manager, SC_ENUM_TYPE level, DWORD typeMask, DWORD stateMask,
                                     LPBYTE services, DWORD cb, LPDWORD needed, LPDWORD returned,
                                     LPDWORD resume, LPCWSTR group)
{
    WsScmHandle *mgr = ws_scm_manager(manager);
    if (!mgr) {
        if (g_orig.EnumServicesStatusExW) {
            return g_orig.EnumServicesStatusExW(manager, level, typeMask, stateMask, services, cb, needed,
                                                returned, resume, group);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return FALSE;
    }
    if (level != SC_ENUM_PROCESS_INFO) {
        return g_orig.EnumServicesStatusExW(mgr->real, level, typeMask, stateMask, services, cb, needed,
                                            returned, resume, group);
    }
    ws_lock_enter(&g_scmLock);
    ws_scm_ensure_loaded();
    if (!ws_enum_has_overlay()) {
        BOOL ok = g_orig.EnumServicesStatusExW(mgr->real, level, typeMask, stateMask, services, cb, needed,
                                               returned, resume, group);
        DWORD err = GetLastError();
        ws_lock_leave(&g_scmLock);
        SetLastError(err);
        return ok;
    }
    WsEnumList list = { 0 };
    int ok = ws_enum_build(&list, mgr, typeMask, stateMask);
    if (ok) {
        ws_enum_merge_overlay(&list, typeMask, stateMask);
    }
    if (!ok) {
        int err = (int)GetLastError();
        free(list.items);
        ws_lock_leave(&g_scmLock);
        SetLastError((DWORD)err);
        return FALSE;
    }
    if (group && group[0]) {
        /* Group filtering is rare; the real API already applied it to real entries.
         * Staged entries have no group in this implementation -> omitted. */
    }
    DWORD total = 0;
    for (int i = 0; i < list.count; i++) {
        total += sizeof(ENUM_SERVICE_STATUS_PROCESSW);
        total += (DWORD)(wcslen(list.items[i].name) + 1) * sizeof(wchar_t);
        total += (DWORD)(wcslen(list.items[i].display) + 1) * sizeof(wchar_t);
    }
    if (needed) {
        *needed = total;
    }
    if (returned) {
        *returned = 0;
    }
    if (resume) {
        *resume = 0;
    }
    if (!services || cb < total) {
        free(list.items);
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_MORE_DATA);
        return FALSE;
    }
    ENUM_SERVICE_STATUS_PROCESSW *arr = (ENUM_SERVICE_STATUS_PROCESSW *)services;
    wchar_t *str = (wchar_t *)(services + (size_t)list.count * sizeof(ENUM_SERVICE_STATUS_PROCESSW));
    for (int i = 0; i < list.count; i++) {
        arr[i].lpServiceName = str;
        ws_strlcpy_w(str, list.items[i].name, WS_SCM_NAME);
        str += wcslen(str) + 1;
        arr[i].lpDisplayName = str;
        ws_strlcpy_w(str, list.items[i].display, WS_SCM_DISPLAY);
        str += wcslen(str) + 1;
        memset(&arr[i].ServiceStatusProcess, 0, sizeof(SERVICE_STATUS_PROCESS));
        arr[i].ServiceStatusProcess.dwServiceType = list.items[i].type;
        arr[i].ServiceStatusProcess.dwCurrentState = list.items[i].state;
        arr[i].ServiceStatusProcess.dwProcessId = list.items[i].pid;
    }
    if (returned) {
        *returned = (DWORD)list.count;
    }
    free(list.items);
    ws_lock_leave(&g_scmLock);
    return TRUE;
}

BOOL WINAPI ws_EnumServicesStatusExA(SC_HANDLE manager, SC_ENUM_TYPE level, DWORD typeMask, DWORD stateMask,
                                     LPBYTE services, DWORD cb, LPDWORD needed, LPDWORD returned,
                                     LPDWORD resume, LPCSTR group)
{
    WsScmHandle *mgr = ws_scm_manager(manager);
    if (!mgr) {
        if (g_orig.EnumServicesStatusExA) {
            return g_orig.EnumServicesStatusExA(manager, level, typeMask, stateMask, services, cb, needed,
                                                returned, resume, group);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return FALSE;
    }
    DWORD wneed = 0;
    if (!ws_EnumServicesStatusExW(manager, level, typeMask, stateMask, NULL, 0, &wneed, returned, resume, NULL)) {
        if (GetLastError() != ERROR_MORE_DATA) {
            return FALSE;
        }
    }
    BYTE *buf = (BYTE *)malloc(wneed ? wneed : 1);
    if (!buf) {
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return FALSE;
    }
    DWORD wret = 0;
    if (!ws_EnumServicesStatusExW(manager, level, typeMask, stateMask, buf, wneed, &wneed, &wret, resume, NULL)) {
        free(buf);
        return FALSE;
    }
    ENUM_SERVICE_STATUS_PROCESSW *arr = (ENUM_SERVICE_STATUS_PROCESSW *)buf;
    DWORD total = 0;
    for (DWORD i = 0; i < wret; i++) {
        total += sizeof(ENUM_SERVICE_STATUS_PROCESSA);
        total += (DWORD)WideCharToMultiByte(CP_ACP, 0, arr[i].lpServiceName, -1, NULL, 0, NULL, NULL);
        total += (DWORD)WideCharToMultiByte(CP_ACP, 0, arr[i].lpDisplayName, -1, NULL, 0, NULL, NULL);
    }
    if (needed) *needed = total;
    if (!services || cb < total) {
        free(buf);
        SetLastError(ERROR_MORE_DATA);
        return FALSE;
    }
    ENUM_SERVICE_STATUS_PROCESSA *out = (ENUM_SERVICE_STATUS_PROCESSA *)services;
    char *p = (char *)services + (size_t)wret * sizeof(ENUM_SERVICE_STATUS_PROCESSA);
    for (DWORD i = 0; i < wret; i++) {
        out[i].lpServiceName = p;
        p += WideCharToMultiByte(CP_ACP, 0, arr[i].lpServiceName, -1, p, (int)((BYTE *)services + cb - (BYTE *)p),
                                 NULL, NULL);
        out[i].lpDisplayName = p;
        p += WideCharToMultiByte(CP_ACP, 0, arr[i].lpDisplayName, -1, p,
                                 (int)((BYTE *)services + cb - (BYTE *)p), NULL, NULL);
        out[i].ServiceStatusProcess = arr[i].ServiceStatusProcess;
    }
    if (returned) *returned = wret;
    free(buf);
    return TRUE;
}

BOOL WINAPI ws_EnumServicesStatusW(SC_HANDLE manager, DWORD typeMask, DWORD stateMask, LPENUM_SERVICE_STATUSW services,
                                   DWORD cb, LPDWORD needed, LPDWORD returned, LPDWORD resume)
{
    WsScmHandle *mgr = ws_scm_manager(manager);
    if (!mgr) {
        if (g_orig.EnumServicesStatusW) {
            return g_orig.EnumServicesStatusW(manager, typeMask, stateMask, services, cb, needed, returned, resume);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return FALSE;
    }
    ws_lock_enter(&g_scmLock);
    ws_scm_ensure_loaded();
    if (!ws_enum_has_overlay()) {
        BOOL ok = g_orig.EnumServicesStatusW(mgr->real, typeMask, stateMask, services, cb, needed, returned, resume);
        DWORD err = GetLastError();
        ws_lock_leave(&g_scmLock);
        SetLastError(err);
        return ok;
    }
    WsEnumList list = { 0 };
    int ok = ws_enum_build(&list, mgr, typeMask, stateMask);
    if (ok) ws_enum_merge_overlay(&list, typeMask, stateMask);
    if (!ok) {
        int err = (int)GetLastError();
        free(list.items);
        ws_lock_leave(&g_scmLock);
        SetLastError((DWORD)err);
        return FALSE;
    }
    DWORD total = 0;
    for (int i = 0; i < list.count; i++) {
        total += sizeof(ENUM_SERVICE_STATUSW);
        total += (DWORD)(wcslen(list.items[i].name) + 1) * sizeof(wchar_t);
        total += (DWORD)(wcslen(list.items[i].display) + 1) * sizeof(wchar_t);
    }
    if (needed) *needed = total;
    if (returned) *returned = 0;
    if (resume) *resume = 0;
    if (!services || cb < total) {
        free(list.items);
        ws_lock_leave(&g_scmLock);
        SetLastError(ERROR_MORE_DATA);
        return FALSE;
    }
    ENUM_SERVICE_STATUSW *arr = (ENUM_SERVICE_STATUSW *)services;
    wchar_t *str = (wchar_t *)((BYTE *)services + (size_t)list.count * sizeof(ENUM_SERVICE_STATUSW));
    for (int i = 0; i < list.count; i++) {
        arr[i].lpServiceName = str;
        ws_strlcpy_w(str, list.items[i].name, WS_SCM_NAME);
        str += wcslen(str) + 1;
        arr[i].lpDisplayName = str;
        ws_strlcpy_w(str, list.items[i].display, WS_SCM_DISPLAY);
        str += wcslen(str) + 1;
        memset(&arr[i].ServiceStatus, 0, sizeof(SERVICE_STATUS));
        arr[i].ServiceStatus.dwServiceType = list.items[i].type;
        arr[i].ServiceStatus.dwCurrentState = list.items[i].state;
    }
    if (returned) *returned = (DWORD)list.count;
    free(list.items);
    ws_lock_leave(&g_scmLock);
    return TRUE;
}

BOOL WINAPI ws_EnumServicesStatusA(SC_HANDLE manager, DWORD typeMask, DWORD stateMask, LPENUM_SERVICE_STATUSA services,
                                   DWORD cb, LPDWORD needed, LPDWORD returned, LPDWORD resume)
{
    WsScmHandle *mgr = ws_scm_manager(manager);
    if (!mgr) {
        if (g_orig.EnumServicesStatusA) {
            return g_orig.EnumServicesStatusA(manager, typeMask, stateMask, services, cb, needed, returned, resume);
        }
        SetLastError(ERROR_INVALID_HANDLE);
        return FALSE;
    }
    DWORD wneed = 0;
    if (!ws_EnumServicesStatusW(manager, typeMask, stateMask, NULL, 0, &wneed, returned, resume)) {
        if (GetLastError() != ERROR_MORE_DATA) {
            return FALSE;
        }
    }
    BYTE *buf = (BYTE *)malloc(wneed ? wneed : 1);
    if (!buf) {
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return FALSE;
    }
    DWORD wret = 0;
    if (!ws_EnumServicesStatusW(manager, typeMask, stateMask, (LPENUM_SERVICE_STATUSW)buf, wneed, &wneed, &wret,
                                resume)) {
        free(buf);
        return FALSE;
    }
    ENUM_SERVICE_STATUSW *arr = (ENUM_SERVICE_STATUSW *)buf;
    DWORD total = 0;
    for (DWORD i = 0; i < wret; i++) {
        total += sizeof(ENUM_SERVICE_STATUSA);
        total += (DWORD)WideCharToMultiByte(CP_ACP, 0, arr[i].lpServiceName, -1, NULL, 0, NULL, NULL);
        total += (DWORD)WideCharToMultiByte(CP_ACP, 0, arr[i].lpDisplayName, -1, NULL, 0, NULL, NULL);
    }
    if (needed) *needed = total;
    if (!services || cb < total) {
        free(buf);
        SetLastError(ERROR_MORE_DATA);
        return FALSE;
    }
    ENUM_SERVICE_STATUSA *out = (ENUM_SERVICE_STATUSA *)services;
    char *p = (char *)services + (size_t)wret * sizeof(ENUM_SERVICE_STATUSA);
    for (DWORD i = 0; i < wret; i++) {
        out[i].lpServiceName = p;
        p += WideCharToMultiByte(CP_ACP, 0, arr[i].lpServiceName, -1, p, (int)((BYTE *)services + cb - (BYTE *)p),
                                 NULL, NULL);
        out[i].lpDisplayName = p;
        p += WideCharToMultiByte(CP_ACP, 0, arr[i].lpDisplayName, -1, p,
                                 (int)((BYTE *)services + cb - (BYTE *)p), NULL, NULL);
        out[i].ServiceStatus = arr[i].ServiceStatus;
    }
    if (returned) *returned = wret;
    free(buf);
    return TRUE;
}

BOOL WINAPI ws_CloseServiceHandle(SC_HANDLE handle)
{
    WsScmHandle *h = ws_scm_handle_get(handle);
    if (!h) {
        return g_orig.CloseServiceHandle ? g_orig.CloseServiceHandle(handle) : CloseServiceHandle(handle);
    }
    ws_lock_enter(&g_scmLock);
    SC_HANDLE real = h->real;
    h->used = 0;
    h->real = NULL;
    ws_lock_leave(&g_scmLock);
    if (real) {
        g_orig.CloseServiceHandle(real);
    }
    return TRUE;
}

/* ----------------------------------------------------------- EventLog layer */

#define WS_EVT_CHANNELS 32
#define WS_EVT_CHANNEL_MAX 128
#define WS_EVT_HANDLES 16

typedef struct WsEvtChannel {
    wchar_t name[WS_EVT_CHANNEL_MAX];
} WsEvtChannel;

typedef struct WsEvtLegacy {
    HANDLE handle;
    wchar_t channel[WS_EVT_CHANNEL_MAX];
} WsEvtLegacy;

static WsEvtChannel g_evtCleared[WS_EVT_CHANNELS];
static int g_evtClearedCount;
static WsEvtLegacy g_evtLegacy[WS_EVT_HANDLES];
static DWORD g_evtLoadedSize = 0xFFFFFFFFu;
static int g_evtLoaded = 0;
static WsLock g_evtLock = { 0, 0, 0, "evt" };

#define WS_EVT_FAKE_HANDLE ((EVT_HANDLE)(WS_EVT_TAG | 1))

static int ws_evt_is_fake(EVT_HANDLE h)
{
    return ((((ULONG_PTR)h) & WS_FAKE_TAG_MASK) == WS_EVT_TAG);
}

static int ws_evt_channel_cleared(const wchar_t *channel)
{
    if (!channel || !channel[0]) {
        return 0;
    }
    for (int i = 0; i < g_evtClearedCount; i++) {
        if (ws_wcscmp_ci(g_evtCleared[i].name, channel) == 0) {
            return 1;
        }
    }
    return 0;
}

static void ws_evt_add_cleared(const wchar_t *channel)
{
    if (!channel || !channel[0] || ws_evt_channel_cleared(channel)) {
        return;
    }
    if (g_evtClearedCount >= WS_EVT_CHANNELS) {
        return;
    }
    ws_strlcpy_w(g_evtCleared[g_evtClearedCount].name, channel, WS_EVT_CHANNEL_MAX);
    g_evtClearedCount++;
}

static void ws_evt_reload(void)
{
    wchar_t path[WS_PATH_MAX];
    char *text = NULL;
    g_evtClearedCount = 0;
    g_evtLoaded = 1;
    g_evtLoadedSize = 0;
    if (!ws_scm_journal_path(L"eventlog.overlay.jsonl", path, WS_PATH_MAX)) {
        return;
    }
    if (!ws_read_text_file(path, &text, NULL) || !text) {
        return;
    }
    char *line = text;
    while (line && *line) {
        char *nl = strchr(line, '\n');
        if (nl) *nl = 0;
        if (*line == '{') {
            wchar_t ch[WS_EVT_CHANNEL_MAX];
            if (ws_json_get_hex(line, "channel", ch, WS_EVT_CHANNEL_MAX)) {
                ws_evt_add_cleared(ch);
            }
        }
        if (!nl) break;
        line = nl + 1;
    }
    HeapFree(GetProcessHeap(), 0, text);
}

static void ws_evt_ensure_loaded(void)
{
    wchar_t path[WS_PATH_MAX];
    if (!ws_scm_journal_path(L"eventlog.overlay.jsonl", path, WS_PATH_MAX)) {
        return;
    }
    DWORD size = 0;
    WIN32_FILE_ATTRIBUTE_DATA fad;
    if (GetFileAttributesExW(path, GetFileExInfoStandard, &fad)) {
        size = fad.nFileSizeLow;
    }
    if (!g_evtLoaded || size != g_evtLoadedSize) {
        ws_evt_reload();
        g_evtLoadedSize = size;
    }
}

static int ws_evt_journal_clear(const wchar_t *channel)
{
    wchar_t line[1024];
    size_t pos = 0;
    line[0] = 0;
    if (!ws_append_w(line, 1024, &pos, L"{\"op\":\"clear\",\"channel\":\"")) {
        return 0;
    }
    ws_hex_put_w(channel ? channel : L"", line, 1024, &pos);
    if (!ws_append_w(line, 1024, &pos, L"\"}\n")) {
        return 0;
    }
    return ws_journal_append(L"eventlog.overlay.jsonl", line);
}

BOOL WINAPI ws_EvtClearLog(EVT_HANDLE session, LPCWSTR channel, LPCWSTR target, DWORD flags)
{
    ws_evt_resolve();
    (void)session;
    (void)target; /* a backup path would be a real write; not performed */
    (void)flags;
    if (!ws_scm_staged()) {
        if (!g_orig.EvtClearLog) {
            SetLastError(ERROR_CALL_NOT_IMPLEMENTED);
            return FALSE;
        }
        return g_orig.EvtClearLog(session, channel, target, flags);
    }
    if (!channel || !channel[0]) {
        SetLastError(ERROR_INVALID_PARAMETER);
        return FALSE;
    }
    ws_lock_enter(&g_evtLock);
    ws_evt_ensure_loaded();
    if (!ws_evt_journal_clear(channel)) {
        ws_lock_leave(&g_evtLock);
        SetLastError(ERROR_WRITE_FAULT);
        return FALSE;
    }
    ws_evt_add_cleared(channel);
    ws_lock_leave(&g_evtLock);
    ws_log_w(L"EventLog clear staged", channel);
    return TRUE;
}

EVT_HANDLE WINAPI ws_EvtQuery(EVT_HANDLE session, LPCWSTR path, LPCWSTR query, DWORD flags)
{
    ws_evt_resolve();
    if (!ws_scm_staged()) {
        if (!g_orig.EvtQuery) {
            SetLastError(ERROR_CALL_NOT_IMPLEMENTED);
            return NULL;
        }
        return g_orig.EvtQuery(session, path, query, flags);
    }
    ws_lock_enter(&g_evtLock);
    ws_evt_ensure_loaded();
    int cleared = 1;
    if (path) {
        /* Path can be a single channel, `Channel1;Channel2`, or a log file. Only a
         * cleared single channel is virtualized; everything else reads through. */
        if (wcschr(path, L';') || wcschr(path, L'\\')) {
            cleared = 0;
        } else {
            cleared = ws_evt_channel_cleared(path);
        }
    } else {
        cleared = 0;
    }
    ws_lock_leave(&g_evtLock);
    if (cleared) {
        ws_log_w(L"EventLog query on cleared channel -> empty result", path);
        return WS_EVT_FAKE_HANDLE;
    }
    if (!g_orig.EvtQuery) {
        SetLastError(ERROR_CALL_NOT_IMPLEMENTED);
        return NULL;
    }
    return g_orig.EvtQuery(session, path, query, flags);
}

BOOL WINAPI ws_EvtNext(EVT_HANDLE result, DWORD count, EVT_HANDLE *events, DWORD timeout, DWORD flags,
                       LPDWORD returned)
{
    ws_evt_resolve();
    if (ws_evt_is_fake(result)) {
        if (returned) {
            *returned = 0;
        }
        SetLastError(ERROR_NO_MORE_ITEMS);
        return FALSE;
    }
    if (!g_orig.EvtNext) {
        SetLastError(ERROR_CALL_NOT_IMPLEMENTED);
        return FALSE;
    }
    return g_orig.EvtNext(result, count, events, timeout, flags, returned);
}

BOOL WINAPI ws_EvtClose(EVT_HANDLE object)
{
    ws_evt_resolve();
    if (ws_evt_is_fake(object)) {
        return TRUE;
    }
    if (!g_orig.EvtClose) {
        SetLastError(ERROR_CALL_NOT_IMPLEMENTED);
        return FALSE;
    }
    return g_orig.EvtClose(object);
}

/* --- legacy EventLog API (Clear-EventLog / Get-EventLog) ------------------ */

HANDLE WINAPI ws_OpenEventLogW(LPCWSTR server, LPCWSTR source)
{
    if (!ws_scm_staged() || !g_orig.OpenEventLogW) {
        return g_orig.OpenEventLogW ? g_orig.OpenEventLogW(server, source)
                                    : OpenEventLogW(server, source);
    }
    HANDLE h = g_orig.OpenEventLogW(server, source);
    if (h && source) {
        ws_lock_enter(&g_evtLock);
        for (int i = 0; i < WS_EVT_HANDLES; i++) {
            if (!g_evtLegacy[i].handle) {
                g_evtLegacy[i].handle = h;
                ws_strlcpy_w(g_evtLegacy[i].channel, source, WS_EVT_CHANNEL_MAX);
                break;
            }
        }
        ws_lock_leave(&g_evtLock);
    }
    return h;
}

HANDLE WINAPI ws_OpenEventLogA(LPCSTR server, LPCSTR source)
{
    wchar_t ws[256], wsrc[WS_EVT_CHANNEL_MAX];
    ws[0] = wsrc[0] = 0;
    if (server) MultiByteToWideChar(CP_ACP, 0, server, -1, ws, 256);
    if (source) MultiByteToWideChar(CP_ACP, 0, source, -1, wsrc, WS_EVT_CHANNEL_MAX);
    return ws_OpenEventLogW(server ? ws : NULL, source ? wsrc : NULL);
}

static wchar_t *ws_evt_channel_of(HANDLE h, wchar_t *out, DWORD cch)
{
    out[0] = 0;
    for (int i = 0; i < WS_EVT_HANDLES; i++) {
        if (g_evtLegacy[i].handle == h) {
            ws_strlcpy_w(out, g_evtLegacy[i].channel, cch);
            return out;
        }
    }
    return out;
}

BOOL WINAPI ws_ClearEventLogW(HANDLE log, LPCWSTR backup)
{
    (void)backup;
    if (!ws_scm_staged()) {
        return g_orig.ClearEventLogW ? g_orig.ClearEventLogW(log, backup)
                                     : ClearEventLogW(log, backup);
    }
    ws_lock_enter(&g_evtLock);
    ws_evt_ensure_loaded();
    wchar_t channel[WS_EVT_CHANNEL_MAX];
    ws_evt_channel_of(log, channel, WS_EVT_CHANNEL_MAX);
    int ok = ws_evt_journal_clear(channel);
    if (ok) {
        ws_evt_add_cleared(channel);
    }
    ws_lock_leave(&g_evtLock);
    if (!ok) {
        SetLastError(ERROR_WRITE_FAULT);
        return FALSE;
    }
    ws_log_w(L"EventLog (legacy) clear staged", channel);
    return TRUE;
}

BOOL WINAPI ws_ClearEventLogA(HANDLE log, LPCSTR backup)
{
    wchar_t wb[WS_PATH_MAX];
    wb[0] = 0;
    if (backup) MultiByteToWideChar(CP_ACP, 0, backup, -1, wb, WS_PATH_MAX);
    return ws_ClearEventLogW(log, backup ? wb : NULL);
}

BOOL WINAPI ws_ReadEventLogW(HANDLE log, DWORD flags, DWORD offset, LPVOID buffer, DWORD bytes,
                             LPDWORD read, LPDWORD needed)
{
    if (!ws_scm_staged()) {
        return g_orig.ReadEventLogW ? g_orig.ReadEventLogW(log, flags, offset, buffer, bytes, read, needed)
                                    : ReadEventLogW(log, flags, offset, buffer, bytes, read, needed);
    }
    ws_lock_enter(&g_evtLock);
    ws_evt_ensure_loaded();
    wchar_t channel[WS_EVT_CHANNEL_MAX];
    ws_evt_channel_of(log, channel, WS_EVT_CHANNEL_MAX);
    int cleared = ws_evt_channel_cleared(channel);
    ws_lock_leave(&g_evtLock);
    if (cleared) {
        if (read) *read = 0;
        SetLastError(ERROR_HANDLE_EOF);
        return FALSE;
    }
    return g_orig.ReadEventLogW ? g_orig.ReadEventLogW(log, flags, offset, buffer, bytes, read, needed)
                                : ReadEventLogW(log, flags, offset, buffer, bytes, read, needed);
}

BOOL WINAPI ws_ReadEventLogA(HANDLE log, DWORD flags, DWORD offset, LPVOID buffer, DWORD bytes, LPDWORD read,
                             LPDWORD needed)
{
    if (!ws_scm_staged()) {
        return g_orig.ReadEventLogA ? g_orig.ReadEventLogA(log, flags, offset, buffer, bytes, read, needed)
                                    : ReadEventLogA(log, flags, offset, buffer, bytes, read, needed);
    }
    /* Reuse the W state check, then forward the A call. */
    ws_lock_enter(&g_evtLock);
    ws_evt_ensure_loaded();
    wchar_t channel[WS_EVT_CHANNEL_MAX];
    ws_evt_channel_of(log, channel, WS_EVT_CHANNEL_MAX);
    int cleared = ws_evt_channel_cleared(channel);
    ws_lock_leave(&g_evtLock);
    if (cleared) {
        if (read) *read = 0;
        SetLastError(ERROR_HANDLE_EOF);
        return FALSE;
    }
    return g_orig.ReadEventLogA ? g_orig.ReadEventLogA(log, flags, offset, buffer, bytes, read, needed)
                                : ReadEventLogA(log, flags, offset, buffer, bytes, read, needed);
}

BOOL WINAPI ws_GetNumberOfEventLogRecords(HANDLE log, PDWORD count)
{
    if (!ws_scm_staged()) {
        return g_orig.GetNumberOfEventLogRecords ? g_orig.GetNumberOfEventLogRecords(log, count)
                                                 : GetNumberOfEventLogRecords(log, count);
    }
    ws_lock_enter(&g_evtLock);
    ws_evt_ensure_loaded();
    wchar_t channel[WS_EVT_CHANNEL_MAX];
    ws_evt_channel_of(log, channel, WS_EVT_CHANNEL_MAX);
    int cleared = ws_evt_channel_cleared(channel);
    ws_lock_leave(&g_evtLock);
    if (cleared) {
        if (count) *count = 0;
        return TRUE;
    }
    return g_orig.GetNumberOfEventLogRecords ? g_orig.GetNumberOfEventLogRecords(log, count)
                                             : GetNumberOfEventLogRecords(log, count);
}

BOOL WINAPI ws_CloseEventLog(HANDLE log)
{
    if (g_orig.CloseEventLog) {
        BOOL ok = g_orig.CloseEventLog(log);
        ws_lock_enter(&g_evtLock);
        for (int i = 0; i < WS_EVT_HANDLES; i++) {
            if (g_evtLegacy[i].handle == log) {
                g_evtLegacy[i].handle = NULL;
                g_evtLegacy[i].channel[0] = 0;
            }
        }
        ws_lock_leave(&g_evtLock);
        return ok;
    }
    return CloseEventLog(log);
}

/* ── helper bridge (exported) ─────────────────────────────────────────────────
 *
 * The CLI helper (`spawn.exe`) runs in its own process where the session store is
 * read-masked, so it cannot read the journals itself. These exports let it ask
 * the injected shim instead: the shim reads/writes the same files through the
 * **original** APIs (g_orig), which its own mask never sees. Without this, a
 * staged `wevtutil cl` looked cleared only inside the clearing process and
 * `schtasks` lost every staged task between commands.
 */
__declspec(dllexport) int __stdcall WinstageShimEventLogCleared(const wchar_t *channel)
{
    if (!ws_scm_staged() || !channel || !channel[0]) {
        return 0;
    }
    ws_lock_enter(&g_evtLock);
    ws_evt_ensure_loaded();
    int cleared = ws_evt_channel_cleared(channel);
    ws_lock_leave(&g_evtLock);
    return cleared;
}

__declspec(dllexport) int __stdcall WinstageShimJournalAppend(const wchar_t *leaf, const wchar_t *line)
{
    if (!leaf || !leaf[0] || !line) {
        return 0;
    }
    return ws_journal_append(leaf, line);
}

__declspec(dllexport) int __stdcall WinstageShimJournalRead(const wchar_t *leaf, char *buf, unsigned long cap)
{
    if (!leaf || !leaf[0] || !buf || cap == 0) {
        return -1;
    }
    wchar_t path[WS_PATH_MAX];
    if (!ws_scm_journal_path(leaf, path, WS_PATH_MAX)) {
        return -1;
    }
    char *text = NULL;
    DWORD len = 0;
    if (!ws_read_text_file(path, &text, &len) || !text) {
        return -1;
    }
    unsigned long n = (len < cap - 1) ? (unsigned long)len : (unsigned long)(cap - 1);
    memcpy(buf, text, n);
    buf[n] = 0;
    HeapFree(GetProcessHeap(), 0, text);
    return (int)n;
}
