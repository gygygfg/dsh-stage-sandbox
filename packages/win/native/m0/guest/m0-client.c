/*
 * dshnt M0 client: exercise the SimRep + ProjFS view through C:\m0\ws.
 *
 * Not a product test; it is the M0 spike probe. It intentionally uses:
 *   - Win32 CreateFileW / FindFirstFileW / DeleteFileW / MoveFileW
 *   - a directory handle + NtCreateFile relative open
 *   - a raw NtCreateFile absolute write
 *   - CreateProcessW child inheritance
 *
 * The host script compares C:\m0\lower before/after; this client also checks
 * that lower copies are still present for deleted/renamed logical paths.
 *
 * Build (VS x64 prompt):
 *   cl /nologo /W3 /EHsc /Fe:m0-client.exe m0-client.c ntdll.lib
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#pragma comment(lib, "ntdll.lib")

typedef NTSTATUS(NTAPI *PFN_NtCreateFile)(
    PHANDLE FileHandle,
    ACCESS_MASK DesiredAccess,
    POBJECT_ATTRIBUTES ObjectAttributes,
    PIO_STATUS_BLOCK IoStatusBlock,
    PLARGE_INTEGER AllocationSize,
    ULONG FileAttributes,
    ULONG ShareAccess,
    ULONG CreateDisposition,
    ULONG CreateOptions,
    PVOID EaBuffer,
    ULONG EaLength);

static int g_checks = 0;
static int g_failures = 0;
static PFN_NtCreateFile g_NtCreateFile = NULL;

static void check(const char *name, int ok, const char *detail) {
  g_checks++;
  if (!ok) g_failures++;
  printf("[%s] %s%s%s\n", ok ? "PASS" : "FAIL", name,
         detail != NULL && detail[0] != '\0' ? " -- " : "",
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
  if (h == INVALID_HANDLE_VALUE) return 0;
  DWORD written = 0;
  BOOL ok = WriteFile(h, data, (DWORD)strlen(data), &written, NULL);
  CloseHandle(h);
  return ok && written == strlen(data);
}

static int starts_with(const char *s, const char *prefix) {
  return strncmp(s, prefix, strlen(prefix)) == 0;
}

static int list_has(const wchar_t *dir, const wchar_t *name) {
  WIN32_FIND_DATAW fd;
  wchar_t pattern[MAX_PATH * 2];
  _snwprintf_s(pattern, _countof(pattern), _TRUNCATE, L"%s\\*", dir);
  HANDLE h = FindFirstFileW(pattern, &fd);
  if (h == INVALID_HANDLE_VALUE) return 0;
  int found = 0;
  do {
    if (_wcsicmp(fd.cFileName, name) == 0) { found = 1; break; }
  } while (FindNextFileW(h, &fd));
  FindClose(h);
  return found;
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
                               FILE_OPEN,
                               FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
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
                               FILE_OVERWRITE_IF,
                               FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
                               NULL, 0);
  if (st < 0 || h == NULL) return 0;
  DWORD written = 0;
  BOOL ok = WriteFile(h, data, (DWORD)strlen(data), &written, NULL);
  CloseHandle(h);
  return ok && written == strlen(data);
}

static void run_child(void) {
  wchar_t cmd[] = L"cmd.exe /c echo child > C:\\m0\\ws\\child.txt";
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
  int n = read_all(L"C:\\m0\\ws\\child.txt", buf, sizeof(buf));
  check("child_write_view", n > 0 && starts_with(buf, "child"), buf);
  check("child_lower_absent", GetFileAttributesW(L"C:\\m0\\lower\\child.txt") == INVALID_FILE_ATTRIBUTES, "");
  printf("[INFO] child_exit=%lu\n", (unsigned long)code);
}

int wmain(void) {
  g_NtCreateFile = (PFN_NtCreateFile)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile");
  check("ntcreatefile_available", g_NtCreateFile != NULL, "");

  char buf[4096];

  int n = read_all(L"C:\\m0\\ws\\a.txt", buf, sizeof(buf));
  check("read_a", n > 0 && starts_with(buf, "hello"), buf);

  check("write_b", write_all(L"C:\\m0\\ws\\b.txt", "v2"), "");
  ZeroMemory(buf, sizeof(buf));
  n = read_all(L"C:\\m0\\ws\\b.txt", buf, sizeof(buf));
  check("read_b_after_write", n > 0 && starts_with(buf, "v2"), buf);

  check("dir_has_a", list_has(L"C:\\m0\\ws", L"a.txt"), "");
  check("dir_has_b", list_has(L"C:\\m0\\ws", L"b.txt"), "");
  check("dir_has_dir", list_has(L"C:\\m0\\ws", L"dir"), "");

  if (!SetCurrentDirectoryW(L"C:\\m0\\ws")) {
    check("set_cwd", 0, "SetCurrentDirectoryW failed");
  } else {
    ZeroMemory(buf, sizeof(buf));
    n = read_all(L"dir\\c.txt", buf, sizeof(buf));
    check("relative_cwd_read_c", n > 0 && starts_with(buf, "c"), buf);
  }

  if (g_NtCreateFile != NULL) {
    ZeroMemory(buf, sizeof(buf));
    n = nt_relative_read(L"C:\\m0\\ws\\dir", L"c.txt", buf, sizeof(buf));
    check("handle_relative_read_c", n > 0 && starts_with(buf, "c"), buf);
  } else {
    check("handle_relative_read_c", 0, "NtCreateFile unavailable");
  }

  if (g_NtCreateFile != NULL) {
    check("raw_nt_write", nt_absolute_write(L"\\??\\C:\\m0\\ws\\raw.txt", "raw"), "");
    ZeroMemory(buf, sizeof(buf));
    n = read_all(L"C:\\m0\\ws\\raw.txt", buf, sizeof(buf));
    check("raw_nt_read_back", n > 0 && starts_with(buf, "raw"), buf);
  }

  check("delete_a", DeleteFileW(L"C:\\m0\\ws\\a.txt") != 0, "");
  check("deleted_a_gone_from_view", GetFileAttributesW(L"C:\\m0\\ws\\a.txt") == INVALID_FILE_ATTRIBUTES, "");
  check("deleted_a_lower_still_there", GetFileAttributesW(L"C:\\m0\\lower\\a.txt") != INVALID_FILE_ATTRIBUTES, "");

  check("delete_gone", DeleteFileW(L"C:\\m0\\ws\\gone.txt") != 0, "");
  check("deleted_gone_from_view", GetFileAttributesW(L"C:\\m0\\ws\\gone.txt") == INVALID_FILE_ATTRIBUTES, "");
  check("deleted_gone_lower_still_there", GetFileAttributesW(L"C:\\m0\\lower\\gone.txt") != INVALID_FILE_ATTRIBUTES, "");

  {
    BOOL moved = MoveFileExW(L"C:\\m0\\ws\\dir\\c.txt", L"C:\\m0\\ws\\dir\\d.txt", MOVEFILE_REPLACE_EXISTING);
    DWORD moveErr = moved ? 0 : GetLastError();
    char moveDetail[64];
    _snprintf_s(moveDetail, sizeof(moveDetail), _TRUNCATE, "err=%lu", (unsigned long)moveErr);
    check("rename_c", moved != 0, moveDetail);
  }
  ZeroMemory(buf, sizeof(buf));
  n = read_all(L"C:\\m0\\ws\\dir\\d.txt", buf, sizeof(buf));
  check("read_renamed_d", n > 0 && starts_with(buf, "c"), buf);
  check("renamed_lower_c_still_there", GetFileAttributesW(L"C:\\m0\\lower\\dir\\c.txt") != INVALID_FILE_ATTRIBUTES, "");
  check("renamed_lower_d_absent", GetFileAttributesW(L"C:\\m0\\lower\\dir\\d.txt") == INVALID_FILE_ATTRIBUTES, "");

  run_child();

  FILE *f = NULL;
  if (fopen_s(&f, "C:\\m0\\client-result.json", "wb") == 0 && f != NULL) {
    fprintf(f, "{\"checks\":%d,\"failures\":%d}\n", g_checks, g_failures);
    fclose(f);
  }

  printf("M0-CLIENT checks=%d failures=%d\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
