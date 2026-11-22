/*
 * dshnt M1 client: 域内功能探针（同路径透明 + 暂存 + 拒绝面）。
 *
 * 布局（真实形态，不是 M0 的三目录演示）：
 *   workspace (lower) = C:\m1\ws      ← 真实工作区，也是 ProjFS 的 lower
 *   view               = C:\m1\view   ← ProjFS 视图根
 *   store              = C:\m1\store  ← 控制面 store（必须拒绝）
 *
 * 由 launcher 在域内启动；结果写 C:\m1\view\client-result.json（视图可写）。
 *
 * Build:
 *   cl /nologo /W3 /Fe:m1-client.exe m1-client.c ntdll.lib
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#pragma comment(lib, "ntdll.lib")

#define WS L"C:\\m1\\ws"
#define VIEW L"C:\\m1\\view"
#define STORE L"C:\\m1\\store"
#define RESULT L"C:\\m1\\view\\client-result.json"

typedef NTSTATUS(NTAPI *PFN_NtCreateFile)(
    PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER,
    ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);

static int g_checks = 0;
static int g_failures = 0;
static PFN_NtCreateFile g_NtCreateFile = NULL;

static void check(const char *name, int ok, const char *detail) {
    g_checks++;
    if (!ok) g_failures++;
    printf("[%s] %s%s%s\n", ok ? "PASS" : "FAIL", name,
           (detail != NULL && detail[0] != '\0') ? " -- " : "",
           detail != NULL ? detail : "");
    fflush(stdout);
}

static int read_all(const wchar_t *path, char *buf, size_t cap) {
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return -1;
    DWORD got = 0;
    BOOL ok = ReadFile(h, buf, (DWORD)(cap - 1), &got, NULL);
    CloseHandle(h);
    if (!ok) return -1;
    buf[got] = '\0';
    return (int)got;
}

static int write_all(const wchar_t *path, const char *data) {
    HANDLE h = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        printf("[INFO] write_all open err=%lu\n", GetLastError());
        fflush(stdout);
        return 0;
    }
    DWORD written = 0;
    BOOL ok = WriteFile(h, data, (DWORD)strlen(data), &written, NULL);
    CloseHandle(h);
    return ok && written == (DWORD)strlen(data);
}

static int starts_with(const char *s, const char *prefix) {
    return strncmp(s, prefix, strlen(prefix)) == 0;
}

static int list_has(const wchar_t *dir, const wchar_t *name) {
    wchar_t pattern[MAX_PATH * 2];
    WIN32_FIND_DATAW fd;
    _snwprintf_s(pattern, (sizeof(pattern) / sizeof(pattern[0])), _TRUNCATE, L"%s\\*", dir);
    HANDLE h = FindFirstFileW(pattern, &fd);
    if (h == INVALID_HANDLE_VALUE) return 0;
    int found = 0;
    do {
        if (_wcsicmp(fd.cFileName, name) == 0) { found = 1; break; }
    } while (FindNextFileW(h, &fd));
    FindClose(h);
    return found;
}

/* 打开一个路径并返回 Win32 错误码（0 = 成功）。 */
static DWORD open_error(const wchar_t *path, DWORD access, DWORD disposition) {
    HANDLE h = CreateFileW(path, access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           NULL, disposition, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return GetLastError();
    CloseHandle(h);
    return 0;
}

/* 目录句柄（FILE_LIST_DIRECTORY 需要 FILE_FLAG_BACKUP_SEMANTICS，不能走 open_error）。 */
static DWORD dir_list_error(const wchar_t *path) {
    HANDLE h = CreateFileW(path, FILE_LIST_DIRECTORY,
                           FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
    if (h == INVALID_HANDLE_VALUE) return GetLastError();
    CloseHandle(h);
    return 0;
}

static int nt_relative_read(const wchar_t *dir, const wchar_t *leaf, char *buf, size_t cap) {
    HANDLE hDir = CreateFileW(dir, FILE_LIST_DIRECTORY | SYNCHRONIZE,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
    if (hDir == INVALID_HANDLE_VALUE) return -1;
    UNICODE_STRING name;
    OBJECT_ATTRIBUTES oa;
    IO_STATUS_BLOCK iosb;
    HANDLE h = NULL;
    RtlInitUnicodeString(&name, leaf);
    InitializeObjectAttributes(&oa, &name, OBJ_CASE_INSENSITIVE, hDir, NULL);
    NTSTATUS st = g_NtCreateFile(&h, GENERIC_READ | SYNCHRONIZE, &oa, &iosb, NULL,
                                 FILE_ATTRIBUTE_NORMAL,
                                 FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                 FILE_OPEN, FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
                                 NULL, 0);
    CloseHandle(hDir);
    if (st < 0 || h == NULL) return -1;
    DWORD got = 0;
    BOOL ok = ReadFile(h, buf, (DWORD)(cap - 1), &got, NULL);
    CloseHandle(h);
    if (!ok) return -1;
    buf[got] = '\0';
    return (int)got;
}

static int nt_absolute_write(const wchar_t *path, const char *data) {
    UNICODE_STRING name;
    OBJECT_ATTRIBUTES oa;
    IO_STATUS_BLOCK iosb;
    HANDLE h = NULL;
    RtlInitUnicodeString(&name, path);
    InitializeObjectAttributes(&oa, &name, OBJ_CASE_INSENSITIVE, NULL, NULL);
    NTSTATUS st = g_NtCreateFile(&h, GENERIC_WRITE | SYNCHRONIZE, &oa, &iosb, NULL,
                                 FILE_ATTRIBUTE_NORMAL,
                                 FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                 FILE_OVERWRITE_IF, FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
                                 NULL, 0);
    if (st < 0 || h == NULL) return 0;
    DWORD written = 0;
    BOOL ok = WriteFile(h, data, (DWORD)strlen(data), &written, NULL);
    CloseHandle(h);
    return ok && written == (DWORD)strlen(data);
}

static void run_child(void) {
    wchar_t cmd[] = L"cmd.exe /c echo child > C:\\m1\\ws\\child.txt";
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(NULL, cmd, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
        check("child_spawn", 0, "CreateProcessW failed");
        return;
    }
    WaitForSingleObject(pi.hProcess, 30000);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    char buf[256] = {0};
    int n = read_all(WS L"\\child.txt", buf, sizeof(buf));
    check("child_write_via_redirect", n > 0 && starts_with(buf, "child"), buf);
    printf("[INFO] child_exit=%lu\n", (unsigned long)code);
}

int wmain(void) {
    g_NtCreateFile = (PFN_NtCreateFile)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile");
    check("ntcreatefile_available", g_NtCreateFile != NULL, "");

    char buf[4096];

    /* 1. 同路径读（经重定向到视图） */
    ZeroMemory(buf, sizeof(buf));
    int n = read_all(WS L"\\a.txt", buf, sizeof(buf));
    check("read_workspace_a", n > 0 && starts_with(buf, "hello"), buf);

    /* 2. 暂存写：写逻辑路径 → 进视图 */
    check("write_workspace_b", write_all(WS L"\\b.txt", "v2"), "");
    ZeroMemory(buf, sizeof(buf));
    n = read_all(WS L"\\b.txt", buf, sizeof(buf));
    check("read_b_after_write", n > 0 && starts_with(buf, "v2"), buf);

    /* 3. 枚举（合并 lower + 暂存） */
    check("enum_has_a", list_has(WS, L"a.txt"), "");
    check("enum_has_b", list_has(WS, L"b.txt"), "");
    check("enum_has_dir", list_has(WS, L"dir"), "");

    /* 4. 相对打开（cwd） */
    if (SetCurrentDirectoryW(WS)) {
        ZeroMemory(buf, sizeof(buf));
        n = read_all(L"dir\\c.txt", buf, sizeof(buf));
        check("relative_cwd_read", n > 0 && starts_with(buf, "c"), buf);
    } else {
        check("set_cwd", 0, "SetCurrentDirectoryW failed");
    }

    /* 5. 目录句柄 + NtCreateFile 相对打开 */
    if (g_NtCreateFile != NULL) {
        ZeroMemory(buf, sizeof(buf));
        n = nt_relative_read(WS L"\\dir", L"c.txt", buf, sizeof(buf));
        check("handle_relative_read", n > 0 && starts_with(buf, "c"), buf);
    }

    /* 6. raw NtCreateFile 绝对写（绕过 Win32） */
    if (g_NtCreateFile != NULL) {
        check("raw_nt_write", nt_absolute_write(L"\\??\\C:\\m1\\ws\\raw.txt", "raw"), "");
        ZeroMemory(buf, sizeof(buf));
        n = read_all(WS L"\\raw.txt", buf, sizeof(buf));
        check("raw_nt_read_back", n > 0 && starts_with(buf, "raw"), buf);
    }

    /* 7. 删除（视图 tombstone） */
    {
        BOOL del = DeleteFileW(WS L"\\a.txt");
        char detail[64];
        _snprintf_s(detail, sizeof(detail), _TRUNCATE, "err=%lu", del ? 0UL : GetLastError());
        check("delete_a", del != 0, detail);
    }
    check("deleted_a_gone", GetFileAttributesW(WS L"\\a.txt") == INVALID_FILE_ATTRIBUTES, "");

    /* 8. 改名（目标也是逻辑路径） */
    {
        BOOL moved = MoveFileExW(WS L"\\dir\\c.txt", WS L"\\dir\\d.txt", MOVEFILE_REPLACE_EXISTING);
        char detail[64];
        _snprintf_s(detail, sizeof(detail), _TRUNCATE, "err=%lu", moved ? 0UL : GetLastError());
        check("rename_c_to_d", moved != 0, detail);
    }
    ZeroMemory(buf, sizeof(buf));
    n = read_all(WS L"\\dir\\d.txt", buf, sizeof(buf));
    check("read_renamed_d", n > 0 && starts_with(buf, "c"), buf);

    /* 9. 子进程继承域 */
    run_child();

    /* 10. 拒绝面：视图/store 直接访问 */
    /*
     * 直接访问视图 = 按逻辑路径判定后放行（与 ws 同权限；这是有意设计：
     * 重定向续开与显式打开无法区分，且视图内容本来就等价于工作区内容）。
     * 用 b.txt（仍在视图里）与目录句柄验证。
     */
    check("view_read_mapped_to_logical", open_error(VIEW L"\\b.txt", GENERIC_READ, OPEN_EXISTING) == 0, "");
    check("view_list_mapped_to_logical", dir_list_error(VIEW) == 0, "");
    check("deny_store_read", open_error(STORE L"\\secret.txt", GENERIC_READ, OPEN_EXISTING) == ERROR_ACCESS_DENIED, "");

    /* 11. 规则：ws\secret 读拒绝；globalMask：ws\masked.txt 拒绝 */
    check("deny_rule_read", open_error(WS L"\\secret\\k.txt", GENERIC_READ, OPEN_EXISTING) == ERROR_ACCESS_DENIED, "");
    check("deny_global_mask", open_error(WS L"\\masked.txt", GENERIC_READ, OPEN_EXISTING) == ERROR_ACCESS_DENIED, "");
    check("allow_ws_normal_read", open_error(WS L"\\b.txt", GENERIC_READ, OPEN_EXISTING) == 0, "");

    /* 12. 新建文件（暂存） */
    {
        DWORD err = open_error(WS L"\\new.txt", GENERIC_WRITE, CREATE_ALWAYS);
        char detail[64];
        _snprintf_s(detail, sizeof(detail), _TRUNCATE, "err=%lu", err);
        check("create_new_file", err == 0, detail);
    }
    check("enum_has_new", list_has(WS, L"new.txt"), "");

    /* 结果写进视图（沙箱可写），宿主脚本负责取回。 */
    FILE *f = NULL;
    if (fopen_s(&f, "C:\\m1\\view\\client-result.json", "wb") == 0 && f != NULL) {
        fprintf(f, "{\"checks\":%d,\"failures\":%d}\n", g_checks, g_failures);
        fclose(f);
    }

    printf("M1-CLIENT checks=%d failures=%d\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
