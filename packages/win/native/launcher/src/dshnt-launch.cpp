// dshnt-launch.exe — 受限启动器（token / Job / mitigation / 环境白名单 / 域注册 / WFP）
//
// 该进程是“沙箱域”的唯一入口：
//   1) 打开 \DshNtPort，核对 hello 的 ABI 与策略 generation（不匹配即失败）；
//   2) 构造 AppContainer 或受限令牌（含 Low 完整性），失败即失败，不降级；
//   3) 建 Job（内存/进程数/CPU/kill-on-close/UI 限制）并安装 WFP 规则（按 SID）；
//   4) 用“允许清单重建”的环境块 CreateProcessAsUser(CREATE_SUSPENDED)；
//   5) 把子进程 PID 注册到驱动（ROOT：子进程继承域），然后 ResumeThread；
//   6) 等待退出，注销 PID、撤销 grant、删除 WFP 规则、关闭 Job（KILL_ON_JOB_CLOSE）。
//
// 安全约束（与 src/nt/launcher-args.ts 对应）：
//   · 目标 argv 只来自 `--` 之后，不解释 shell 字符串；
//   · cwd 必须在视图根内；
//   · 环境变量只从 --env-allow 重建（默认拒绝凭据类键由控制面负责）；
//   · 网络 offline 只在 appcontainer 模式下可强制；不支持就拒绝执行。

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <userenv.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <string>
#include <vector>
#include <cstdio>
#include <cstring>

#include "dshnt_abi.h"
#include "port.h"
#include "wfp.h"

#pragma comment(lib, "fltlib.lib")
#pragma comment(lib, "fwpuclnt.lib")
#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ole32.lib")

namespace {

struct Options {
    std::wstring domain;
    std::wstring view;
    std::wstring workspace;
    std::wstring store;
    int policyGeneration = 0;
    std::wstring network = L"offline";
    std::wstring token = L"restricted";
    std::wstring integrity = L"low";
    std::wstring sid;
    std::wstring cwd;
    unsigned long long jobMemoryMb = 0;
    int jobActiveProcesses = 0;
    int jobCpuPercent = 0;
    bool jobKillOnClose = false;
    std::vector<WfpEndpoint> allow;
    std::vector<std::pair<std::wstring, std::wstring>> env;
    std::vector<std::wstring> argv;
};

int Fail(const char* code, const std::wstring& detail, int exitCode = 90) {
    std::fwprintf(stderr, L"dshnt-launch: FAIL %hs: %ls\n", code, detail.c_str());
    return exitCode;
}

/*
 * `--allow host:port`，IPv6 写作 `[::1]:443`。
 * 这里只做形状校验；地址是否为 IP 字面量由 WFP 安装时（InetPtonW）判定，
 * 失败即 fail-closed（不会退化成“放行全部”）。
 */
bool ParseEndpoint(const std::wstring& spec, WfpEndpoint& out, std::wstring& error) {
    std::wstring host;
    std::wstring portText;
    if (!spec.empty() && spec[0] == L'[') {
        size_t close = spec.find(L']');
        if (close == std::wstring::npos || close + 2 > spec.size() || spec[close + 1] != L':') {
            error = L"--allow needs [ipv6]:port: " + spec;
            return false;
        }
        host = spec.substr(1, close - 1);
        portText = spec.substr(close + 2);
    } else {
        size_t colon = spec.rfind(L':');
        if (colon == std::wstring::npos || colon == 0 || colon + 1 >= spec.size()) {
            error = L"--allow needs host:port: " + spec;
            return false;
        }
        host = spec.substr(0, colon);
        portText = spec.substr(colon + 1);
    }
    if (host.empty() || host.find_first_of(L" \t\r\n") != std::wstring::npos) {
        error = L"--allow host is empty or contains whitespace: " + spec;
        return false;
    }
    wchar_t* end = nullptr;
    unsigned long port = wcstoul(portText.c_str(), &end, 10);
    if (end == nullptr || *end != 0 || port == 0 || port > 65535) {
        error = L"--allow port must be 1..65535: " + spec;
        return false;
    }
    out.host = host;
    out.port = (unsigned short)port;
    return true;
}

bool ParseArgs(int argc, wchar_t** argv, Options& o, std::wstring& error) {
    bool afterDashDash = false;
    for (int i = 1; i < argc; i++) {
        std::wstring a = argv[i];
        if (afterDashDash) { o.argv.push_back(a); continue; }
        if (a == L"--") { afterDashDash = true; continue; }

        auto need = [&](const wchar_t* what) -> bool {
            if (i + 1 >= argc) { error = std::wstring(L"missing value for ") + what; return false; }
            i++;
            return true;
        };

        if (a == L"--domain") { if (!need(L"--domain")) return false; o.domain = argv[i]; }
        else if (a == L"--view") { if (!need(L"--view")) return false; o.view = argv[i]; }
        else if (a == L"--workspace") { if (!need(L"--workspace")) return false; o.workspace = argv[i]; }
        else if (a == L"--store") { if (!need(L"--store")) return false; o.store = argv[i]; }
        else if (a == L"--policy-generation") { if (!need(L"--policy-generation")) return false; o.policyGeneration = _wtoi(argv[i]); }
        else if (a == L"--network") { if (!need(L"--network")) return false; o.network = argv[i]; }
        else if (a == L"--token") { if (!need(L"--token")) return false; o.token = argv[i]; }
        else if (a == L"--integrity") { if (!need(L"--integrity")) return false; o.integrity = argv[i]; }
        else if (a == L"--sid") { if (!need(L"--sid")) return false; o.sid = argv[i]; }
        else if (a == L"--cwd") { if (!need(L"--cwd")) return false; o.cwd = argv[i]; }
        else if (a == L"--job-memory-mb") { if (!need(L"--job-memory-mb")) return false; o.jobMemoryMb = _wcstoui64(argv[i], nullptr, 10); }
        else if (a == L"--job-active-processes") { if (!need(L"--job-active-processes")) return false; o.jobActiveProcesses = _wtoi(argv[i]); }
        else if (a == L"--job-cpu-percent") { if (!need(L"--job-cpu-percent")) return false; o.jobCpuPercent = _wtoi(argv[i]); }
        else if (a == L"--job-kill-on-close") { if (!need(L"--job-kill-on-close")) return false; o.jobKillOnClose = std::wstring(argv[i]) == L"1"; }
        else if (a == L"--allow") {
            if (!need(L"--allow")) return false;
            WfpEndpoint endpoint;
            if (!ParseEndpoint(argv[i], endpoint, error)) return false;
            o.allow.push_back(endpoint);
        }
        else if (a == L"--env-allow") {
            if (!need(L"--env-allow")) return false;
            std::wstring kv = argv[i];
            size_t eq = kv.find(L'=');
            if (eq == std::wstring::npos || eq == 0) { error = L"--env-allow needs KEY=VALUE"; return false; }
            o.env.emplace_back(kv.substr(0, eq), kv.substr(eq + 1));
        }
        else { error = std::wstring(L"unknown argument: ") + a; return false; }
    }
    if (o.domain.empty()) { error = L"--domain is required"; return false; }
    if (o.view.empty()) { error = L"--view is required"; return false; }
    if (o.workspace.empty()) { error = L"--workspace is required"; return false; }
    if (o.policyGeneration <= 0) { error = L"--policy-generation must be positive"; return false; }
    if (o.argv.empty()) { error = L"target argv missing after --"; return false; }
    if (o.token != L"appcontainer" && o.token != L"restricted") { error = L"--token must be appcontainer|restricted"; return false; }
    if (o.integrity != L"low" && o.integrity != L"medium") { error = L"--integrity must be low|medium"; return false; }
    if (o.network == L"allowlist" && o.allow.empty()) {
        error = L"--network allowlist requires at least one --allow host:port";
        return false;
    }
    if (o.network != L"allowlist" && !o.allow.empty()) {
        error = L"--allow is only valid with --network allowlist";
        return false;
    }
    return true;
}

// 视图根内的 cwd 校验（大小写不敏感 + 目录边界）。
bool PathInside(const std::wstring& child, const std::wstring& parent) {
    if (child.size() < parent.size()) return false;
    if (_wcsnicmp(child.c_str(), parent.c_str(), parent.size()) != 0) return false;
    if (child.size() == parent.size()) return true;
    wchar_t c = child[parent.size()];
    return c == L'\\' || c == L'/';
}

bool EnablePrivilege(const wchar_t* name) {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &token)) return false;
    LUID luid;
    bool ok = false;
    if (LookupPrivilegeValueW(nullptr, name, &luid)) {
        TOKEN_PRIVILEGES tp{};
        tp.PrivilegeCount = 1;
        tp.Privileges[0].Luid = luid;
        tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
        ok = AdjustTokenPrivileges(token, FALSE, &tp, sizeof(tp), nullptr, nullptr) && GetLastError() == ERROR_SUCCESS;
    }
    CloseHandle(token);
    return ok;
}

bool SetLowIntegrity(HANDLE token, std::wstring* error) {
    SID_IDENTIFIER_AUTHORITY auth = SECURITY_MANDATORY_LABEL_AUTHORITY;
    PSID sid = nullptr;
    if (!AllocateAndInitializeSid(&auth, 1, SECURITY_MANDATORY_LOW_RID, 0, 0, 0, 0, 0, 0, 0, &sid)) {
        if (error) *error = L"AllocateAndInitializeSid(LOW) err=" + std::to_wstring(GetLastError());
        return false;
    }
    TOKEN_MANDATORY_LABEL label{};
    label.Label.Attributes = SE_GROUP_INTEGRITY;
    label.Label.Sid = sid;
    SetLastError(0);
    DWORD sidLen = GetLengthSid(sid);
    bool ok = SetTokenInformation(token, TokenIntegrityLevel, &label,
                                  sizeof(label) + sidLen - sizeof(DWORD)) != 0;
    DWORD err = GetLastError();
    if (!ok) {
        if (error) *error = L"SetTokenInformation(TokenIntegrityLevel) err=" + std::to_wstring(err) +
                            L" sidLen=" + std::to_wstring(sidLen);
    }
    FreeSid(sid);
    return ok;
}

// 把目录标为 Low 完整性：受限令牌（Low IL）要能在视图里创建/写文件。
// 这是**故意的降级**，只对视图根（沙箱自己的数据）做；真实工作区保持 Medium。
bool SetLowMandatoryLabel(const std::wstring& path, std::wstring* error) {
    SID_IDENTIFIER_AUTHORITY authority = SECURITY_MANDATORY_LABEL_AUTHORITY;
    PSID label = nullptr;
    if (!AllocateAndInitializeSid(&authority, 1, SECURITY_MANDATORY_LOW_RID, 0, 0, 0, 0, 0, 0, 0, &label)) {
        if (error) *error = L"AllocateAndInitializeSid(label) failed";
        return false;
    }
    DWORD sidLen = GetLengthSid(label);
    DWORD aceSize = sizeof(SYSTEM_MANDATORY_LABEL_ACE) + sidLen - sizeof(DWORD);
    PACL acl = (PACL)LocalAlloc(LPTR, sizeof(ACL) + aceSize);
    if (acl == nullptr || !InitializeAcl(acl, sizeof(ACL) + aceSize, ACL_REVISION)) {
        FreeSid(label);
        if (acl != nullptr) LocalFree(acl);
        if (error) *error = L"InitializeAcl failed";
        return false;
    }
    SYSTEM_MANDATORY_LABEL_ACE* ace = (SYSTEM_MANDATORY_LABEL_ACE*)((PBYTE)acl + sizeof(ACL));
    ace->Header.AceType = SYSTEM_MANDATORY_LABEL_ACE_TYPE;
    ace->Header.AceSize = (WORD)aceSize;
    ace->Mask = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE | SYSTEM_MANDATORY_LABEL_NO_WRITE_UP;
    memcpy(&ace->SidStart, label, sidLen);
    FreeSid(label);

    bool secPriv = EnablePrivilege(SE_SECURITY_NAME);
    std::fwprintf(stderr, L"dshnt-launch: SeSecurityPrivilege=%ls\n", secPriv ? L"ok" : L"missing");
    /*
     * 关键：强制完整性标签在 SACL 里，但必须用 LABEL_SECURITY_INFORMATION 设置；
     * 用 SACL_SECURITY_INFORMATION 只会创建空 SACL（实测 S:AI，标签丢失），
     * Low IL 子进程随后所有写操作都会被 MAC 拒绝。
     */
    DWORD rc = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
                                     LABEL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, acl);
    LocalFree(acl);
    std::fwprintf(stderr, L"dshnt-launch: SetNamedSecurityInfo(label) rc=%lu path=%ls\n", rc, path.c_str());
    if (rc != ERROR_SUCCESS) {
        if (error) *error = L"SetNamedSecurityInfo(label) failed rc=" + std::to_wstring(rc);
        return false;
    }
    {
        // 回读并打印 SDDL，确认 mandatory label ACE 真的写进去了。
        PSECURITY_DESCRIPTOR probe = nullptr;
        DWORD prc = GetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
                                          LABEL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, nullptr, &probe);
        std::fwprintf(stderr, L"dshnt-launch: GetNamedSecurityInfo(label) rc=%lu\n", prc);
        if (prc == ERROR_SUCCESS && probe != nullptr) {
            LPWSTR text = nullptr;
            if (ConvertSecurityDescriptorToStringSecurityDescriptorW(probe, SDDL_REVISION_1,
                                                                     LABEL_SECURITY_INFORMATION, &text, nullptr)) {
                std::fwprintf(stderr, L"dshnt-launch: label sddl=%ls\n", text);
                LocalFree(text);
            }
            LocalFree(probe);
        }
    }
    return true;
}

// CreateAppContainerToken 在不同 SDK/头文件版本里的声明位置不一致；按导出名动态解析，
// 解析不到就失败（绝不退化成非 AppContainer 令牌）。
typedef HRESULT(WINAPI* PFN_CreateAppContainerToken)(HANDLE baseToken, PSECURITY_CAPABILITIES capabilities, PHANDLE newToken);

bool CreateAppContainerTokenDyn(HANDLE baseToken, PSID sid, PSID_AND_ATTRIBUTES caps, unsigned long capCount,
                                PHANDLE out, std::wstring* error) {
    static PFN_CreateAppContainerToken fn = nullptr;
    static bool tried = false;
    if (!tried) {
        tried = true;
        // 导出位置随版本变化：KERNELBASE (6.3+) 优先，再退回 userenv / kernel32。
        const wchar_t* dlls[] = { L"kernelbase.dll", L"userenv.dll", L"kernel32.dll" };
        for (const wchar_t* name : dlls) {
            HMODULE module = GetModuleHandleW(name);
            if (module == nullptr) module = LoadLibraryW(name);
            if (module == nullptr) continue;
            fn = (PFN_CreateAppContainerToken)GetProcAddress(module, "CreateAppContainerToken");
            if (fn != nullptr) break;
        }
    }
    if (fn == nullptr) {
        if (error) *error = L"CreateAppContainerToken not found in kernelbase/userenv/kernel32";
        return false;
    }
    SECURITY_CAPABILITIES sec{};
    sec.AppContainerSid = sid;
    sec.Capabilities = caps;
    sec.CapabilityCount = capCount;
    sec.Reserved = 0;
    HRESULT hr = fn(baseToken, &sec, out);
    if (FAILED(hr) || *out == nullptr) {
        if (error) *error = L"CreateAppContainerToken failed";
        return false;
    }
    return true;
}

// 回读：确认 SACL 里确实有 mandatory label ACE（设置“成功”不代表真的写上）。
bool HasMandatoryLabel(const std::wstring& path) {
    PSECURITY_DESCRIPTOR sd = nullptr;
    PACL sacl = nullptr;
    DWORD rc = GetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
                                     LABEL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, &sacl, &sd);
    bool found = false;
    if (rc == ERROR_SUCCESS && sacl != nullptr) {
        for (WORD i = 0; i < sacl->AceCount; i++) {
            LPVOID ace = nullptr;
            if (GetAce(sacl, i, &ace) && ace != nullptr &&
                ((PACE_HEADER)ace)->AceType == SYSTEM_MANDATORY_LABEL_ACE_TYPE) {
                found = true;
                break;
            }
        }
    }
    if (sd != nullptr) LocalFree(sd);
    return found;
}

// AppContainer：没有显式 SID 时按 domain 派生/创建 profile。
// 返回的 SID 由调用方 LocalFree。
bool EnsureAppContainerSid(const std::wstring& domain, PSID* out, std::wstring* error) {
    std::wstring name = L"dshnt." + domain;
    PSID sid = nullptr;
    HRESULT hr = CreateAppContainerProfile(name.c_str(), name.c_str(), name.c_str(), nullptr, 0, &sid);
    if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
        hr = DeriveAppContainerSidFromAppContainerName(name.c_str(), &sid);
    }
    if (FAILED(hr) || sid == nullptr) {
        if (error) *error = L"cannot create/derive AppContainer profile";
        return false;
    }
    *out = sid;
    return true;
}

// 取令牌的 user SID（新建副本，调用方 LocalFree）。
PSID TokenUserSid(HANDLE token) {
    DWORD size = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || size == 0) return nullptr;
    std::vector<unsigned char> buffer(size);
    if (!GetTokenInformation(token, TokenUser, buffer.data(), size, &size)) return nullptr;
    TOKEN_USER* user = (TOKEN_USER*)buffer.data();
    DWORD sidLen = GetLengthSid(user->User.Sid);
    PSID copy = LocalAlloc(LPTR, sidLen);
    if (copy != nullptr && !CopySid(sidLen, copy, user->User.Sid)) {
        LocalFree(copy);
        copy = nullptr;
    }
    return copy;
}

// 给 AppContainer SID 授予目录的 (OI)(CI) 完全控制；失败即失败（不静默降级）。
bool GrantDirectoryToSid(const std::wstring& path, PSID sid, std::wstring* error) {
    EXPLICIT_ACCESSW access{};
    access.grfAccessPermissions = GENERIC_ALL;
    access.grfAccessMode = SET_ACCESS;
    access.grfInheritance = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    access.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
    access.Trustee.ptstrName = (LPWSTR)sid;

    PACL oldAcl = nullptr;
    PACL newAcl = nullptr;
    PSECURITY_DESCRIPTOR sd = nullptr;
    if (SetEntriesInAclW(1, &access, nullptr, &newAcl) != ERROR_SUCCESS) {
        if (error) *error = L"SetEntriesInAcl failed";
        return false;
    }
    DWORD rc = GetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
                                     DACL_SECURITY_INFORMATION, nullptr, nullptr, &oldAcl, nullptr, &sd);
    if (rc != ERROR_SUCCESS) {
        LocalFree(newAcl);
        if (error) *error = L"GetNamedSecurityInfo failed";
        return false;
    }
    rc = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
                               DACL_SECURITY_INFORMATION, nullptr, nullptr, newAcl, nullptr);
    LocalFree(newAcl);
    if (sd != nullptr) LocalFree(sd);
    if (rc != ERROR_SUCCESS) {
        if (error) *error = L"SetNamedSecurityInfo failed";
        return false;
    }
    return true;
}

// 从允许清单重建环境块（不继承父进程环境）。
std::vector<wchar_t> BuildEnvironment(const Options& o, const std::wstring& tempDir) {
    std::vector<std::pair<std::wstring, std::wstring>> vars = o.env;

    auto has = [&](const wchar_t* key) {
        for (auto& kv : vars) if (_wcsicmp(kv.first.c_str(), key) == 0) return true;
        return false;
    };
    auto add = [&](const wchar_t* key, const std::wstring& value) {
        if (!has(key)) vars.emplace_back(key, value);
    };

    wchar_t sysroot[MAX_PATH];
    UINT n = GetWindowsDirectoryW(sysroot, MAX_PATH);
    std::wstring windir = n > 0 ? sysroot : L"C:\\Windows";
    std::wstring system32 = windir + L"\\System32";

    add(L"SystemRoot", windir);
    add(L"windir", windir);
    add(L"TEMP", tempDir);
    add(L"TMP", tempDir);
    add(L"PATH", system32 + L";" + windir);
    add(L"COMSPEC", system32 + L"\\cmd.exe");
    add(L"PATHEXT", L".COM;.EXE;.BAT;.CMD");

    std::vector<wchar_t> block;
    for (auto& kv : vars) {
        std::wstring line = kv.first + L"=" + kv.second;
        block.insert(block.end(), line.begin(), line.end());
        block.push_back(0);
    }
    block.push_back(0);
    return block;
}

bool CreateJob(const Options& o, HANDLE* outJob, std::wstring& error) {
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (job == nullptr) { error = L"CreateJobObject failed"; return false; }

    JOBOBJECT_EXTENDED_LIMIT_INFORMATION ext{};
    ext.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
                                           JOB_OBJECT_LIMIT_PROCESS_MEMORY |
                                           JOB_OBJECT_LIMIT_JOB_MEMORY;
    if (o.jobKillOnClose) ext.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (o.jobMemoryMb > 0) {
        unsigned long long bytes = o.jobMemoryMb * 1024ull * 1024ull;
        ext.ProcessMemoryLimit = (SIZE_T)bytes;
        ext.JobMemoryLimit = (SIZE_T)bytes;
    }
    if (o.jobActiveProcesses > 0) {
        ext.BasicLimitInformation.ActiveProcessLimit = (DWORD)o.jobActiveProcesses;
    }
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &ext, sizeof(ext))) {
        error = L"SetInformationJobObject(extended) failed";
        CloseHandle(job);
        return false;
    }

    if (o.jobCpuPercent > 0 && o.jobCpuPercent < 100) {
        JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu{};
        cpu.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
        cpu.CpuRate = (DWORD)(o.jobCpuPercent * 100);
        if (!SetInformationJobObject(job, JobObjectCpuRateControlInformation, &cpu, sizeof(cpu))) {
            error = L"SetInformationJobObject(cpu) failed";
            CloseHandle(job);
            return false;
        }
    }

    JOBOBJECT_BASIC_UI_RESTRICTIONS ui{};
    ui.UIRestrictionsClass = JOB_OBJECT_UILIMIT_DESKTOP | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS |
                             JOB_OBJECT_UILIMIT_EXITWINDOWS | JOB_OBJECT_UILIMIT_GLOBALATOMS |
                             JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS | JOB_OBJECT_UILIMIT_WRITECLIPBOARD;
    (void)SetInformationJobObject(job, JobObjectBasicUIRestrictions, &ui, sizeof(ui));

    *outJob = job;
    return true;
}

std::wstring Quote(const std::wstring& s) {
    if (s.find_first_of(L" \t\"") == std::wstring::npos) return s;
    std::wstring out = L"\"";
    for (wchar_t c : s) { if (c == L'"') out += L'\\'; out += c; }
    out += L"\"";
    return out;
}

std::wstring JoinCommandLine(const std::vector<std::wstring>& argv) {
    std::wstring cmd;
    for (size_t i = 0; i < argv.size(); i++) {
        if (i) cmd += L' ';
        cmd += Quote(argv[i]);
    }
    return cmd;
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    Options o;
    std::wstring parseError;
    if (!ParseArgs(argc, argv, o, parseError)) {
        return Fail("NT_CAPABILITY_MISSING", parseError, 2);
    }

    if (!EnablePrivilege(SE_ASSIGNPRIMARYTOKEN_NAME) || !EnablePrivilege(SE_INCREASE_QUOTA_NAME)) {
        // 不是致命：受限令牌模式不需要；AppContainer 模式会在 CreateProcessAsUser 处失败。
    }

    // 1) 驱动端口：hello + generation。
    DshntPort port;
    std::wstring portError;
    if (!port.Connect(&portError)) {
        return Fail("NT_DRIVER_UNAVAILABLE", portError);
    }
    DshntHello hello{};
    if (!port.Hello(&hello, &portError)) {
        return Fail("NT_DRIVER_UNAVAILABLE", portError);
    }
    if (hello.abiVersion != DSHNT_ABI_VERSION) {
        return Fail("NT_DRIVER_VERSION_MISMATCH", L"driver ABI " + std::to_wstring(hello.abiVersion));
    }
    DshntStats st{};
    if (!port.QueryStats(&st, &portError)) {
        return Fail("NT_DRIVER_UNAVAILABLE", portError);
    }
    if ((int)st.policyGeneration != o.policyGeneration) {
        return Fail("NT_POLICY_GENERATION_MISMATCH",
                    L"driver=" + std::to_wstring(st.policyGeneration) +
                    L" argv=" + std::to_wstring(o.policyGeneration));
    }

    // 2) 令牌。
    HANDLE primary = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY, &primary)) {
        return Fail("NT_CAPABILITY_MISSING", L"OpenProcessToken failed");
    }

    HANDLE childToken = nullptr;
    PSID appContainerSid = nullptr;

    if (o.token == L"appcontainer") {
        std::wstring sidError;
        if (!o.sid.empty()) {
            if (!ConvertStringSidToSidW(o.sid.c_str(), &appContainerSid)) {
                CloseHandle(primary);
                return Fail("NT_CAPABILITY_MISSING", L"--sid must be a valid SID");
            }
        } else if (!EnsureAppContainerSid(o.domain, &appContainerSid, &sidError)) {
            CloseHandle(primary);
            return Fail("NT_CAPABILITY_MISSING", sidError);
        }

        // AppContainer 默认访问不了普通目录：把视图根（和 store）授权给该 SID。
        if (!GrantDirectoryToSid(o.view, appContainerSid, &sidError)) {
            LocalFree(appContainerSid);
            CloseHandle(primary);
            return Fail("NT_CAPABILITY_MISSING", L"view ACL: " + sidError);
        }
        if (!GrantDirectoryToSid(o.workspace, appContainerSid, &sidError)) {
            // 工作区只授权“列出/读取”，实际写入仍由驱动重定向到视图。
            LocalFree(appContainerSid);
            CloseHandle(primary);
            return Fail("NT_CAPABILITY_MISSING", L"workspace ACL: " + sidError);
        }

        // 首选：显式 AppContainer 令牌（文档路径）。失败时退回内核派生（见创建处）。
        std::wstring tokenError;
        PSID internetCap = nullptr;
        PSID privateCap = nullptr;
        ConvertStringSidToSidW(L"S-1-15-3-1", &internetCap);
        ConvertStringSidToSidW(L"S-1-15-3-3", &privateCap);
        SID_AND_ATTRIBUTES tokenCaps[2]{};
        UINT32 tokenCapCount = 0;
        if (internetCap != nullptr) { tokenCaps[tokenCapCount].Sid = internetCap; tokenCaps[tokenCapCount].Attributes = SE_GROUP_ENABLED; tokenCapCount++; }
        if (privateCap != nullptr) { tokenCaps[tokenCapCount].Sid = privateCap; tokenCaps[tokenCapCount].Attributes = SE_GROUP_ENABLED; tokenCapCount++; }
        if (!CreateAppContainerTokenDyn(primary, appContainerSid,
                                        tokenCapCount > 0 ? tokenCaps : nullptr, tokenCapCount,
                                        &childToken, &tokenError)) {
            std::fwprintf(stderr, L"dshnt-launch: %ls (falling back to CreateProcessW)\n", tokenError.c_str());
            childToken = nullptr;
        }
    } else {
        if (o.network == L"allowlist") {
            CloseHandle(primary);
            return Fail("NT_NETWORK_UNSUPPORTED", L"allowlist requires --token appcontainer");
        }
        if (!CreateRestrictedToken(primary, DISABLE_MAX_PRIVILEGE | LUA_TOKEN, 0, nullptr, 0, nullptr, 0, nullptr, &childToken)) {
            CloseHandle(primary);
            return Fail("NT_CAPABILITY_MISSING", L"CreateRestrictedToken failed");
        }
        /*
         * CreateRestrictedToken 返回的句柄不带 TOKEN_ADJUST_DEFAULT，直接
         * SetTokenInformation 会 ERROR_ACCESS_DENIED（实测 err=5）。用
         * DuplicateTokenEx(MAXIMUM_ALLOWED) 拿一个可调整的副本（创建者对新令牌
         * 有完全控制），再设置完整性级别。
         */
        HANDLE adjustable = nullptr;
        if (!DuplicateTokenEx(childToken, MAXIMUM_ALLOWED, nullptr, SecurityImpersonation,
                              TokenPrimary, &adjustable)) {
            std::wstring dupError = L"DuplicateTokenEx err=" + std::to_wstring(GetLastError());
            if (childToken != nullptr) CloseHandle(childToken);
            CloseHandle(primary);
            return Fail("NT_CAPABILITY_MISSING", dupError);
        }
        if (childToken != nullptr) CloseHandle(childToken);
        childToken = adjustable;

        if (o.integrity == L"low") {
            std::wstring ilError;
            if (!SetLowIntegrity(childToken, &ilError)) {
                if (childToken != nullptr) CloseHandle(childToken);
                CloseHandle(primary);
                return Fail("NT_CAPABILITY_MISSING", ilError);
            }
        } else {
            std::fwprintf(stderr, L"dshnt-launch: integrity=medium (explicitly disabled by --integrity medium)\n");
        }

        /*
         * 受限令牌仍以当前用户身份运行，但管理员组是 deny-only、视图目录默认只有
         * 用户读权限，ProjFS copy-up 需要写 ⇒ 显式把视图根授权给该用户。
         * （真实工作区不授权：域内进程只能经驱动重定向到视图读它。）
         */
        PSID userSid = TokenUserSid(childToken);
        if (userSid == nullptr) {
            if (childToken != nullptr) CloseHandle(childToken);
            CloseHandle(primary);
            return Fail("NT_CAPABILITY_MISSING", L"cannot read token user SID");
        }
        std::wstring aclError;
        bool aclOk = GrantDirectoryToSid(o.view, userSid, &aclError);
        LocalFree(userSid);
        if (!aclOk) {
            if (childToken != nullptr) CloseHandle(childToken);
            CloseHandle(primary);
            return Fail("NT_CAPABILITY_MISSING", L"view ACL: " + aclError);
        }

        if (o.integrity == L"low") {
            std::wstring labelError;
            if (!SetLowMandatoryLabel(o.view, &labelError) || !HasMandatoryLabel(o.view)) {
                if (childToken != nullptr) CloseHandle(childToken);
                CloseHandle(primary);
                return Fail("NT_CAPABILITY_MISSING", L"view label: " + labelError + L" (readback failed)");
            }
            std::fwprintf(stderr, L"dshnt-launch: integrity=low view-label=ok\n");
        }
        /* 真实工作区保持 Medium：域内进程不应有它的写权限（writes go through view）。 */
    }
    CloseHandle(primary);

    // 3) WFP（按 SID；不是 appcontainer 时无法按包 ID 过滤）。
    std::wstring sidText = o.sid;
    if (appContainerSid != nullptr && sidText.empty()) {
        LPWSTR text = nullptr;
        if (ConvertSidToStringSidW(appContainerSid, &text)) {
            sidText = text;
            LocalFree(text);
        }
    }
    void* wfpGate = nullptr;
    if (o.network != L"observed") {
        if (o.network != L"offline" && o.network != L"allowlist") {
            if (childToken != nullptr) CloseHandle(childToken);
            return Fail("NT_NETWORK_UNSUPPORTED", L"unknown --network mode");
        }
        std::wstring wfpError;
        if (!WfpInstall(sidText, o.network == L"allowlist", o.allow, &wfpGate, &wfpError)) {
            if (childToken != nullptr) CloseHandle(childToken);
            return Fail("NT_NETWORK_UNENFORCED", wfpError);
        }
    }

    // 4) Job。
    HANDLE job = nullptr;
    std::wstring jobError;
    if (!CreateJob(o, &job, jobError)) {
        WfpClose(wfpGate);
        if (childToken != nullptr) CloseHandle(childToken);
        return Fail("NT_CAPABILITY_MISSING", jobError);
    }

    // 5) 环境 + cwd。
    std::wstring cwd = o.cwd.empty() ? o.view : o.cwd;
    if (!PathInside(cwd, o.view)) {
        CloseHandle(job);
        WfpClose(wfpGate);
        if (childToken != nullptr) CloseHandle(childToken);
        return Fail("NT_PATH_ESCAPE", L"--cwd must be inside --view");
    }
    std::wstring tempDir = o.view + L"\\.dshnt-tmp";
    CreateDirectoryW(tempDir.c_str(), nullptr);
    std::vector<wchar_t> envBlock = BuildEnvironment(o, tempDir);

    /*
     * AppContainer 进程要求环境块来自该 profile（否则 CreateProcess 返回
     * ERROR_ENVVAR_NOT_FOUND 203，实测）。用 CreateEnvironmentBlock 从令牌
     * 构造（仍不是“继承父进程环境”：它由用户 profile/注册表推导）。
     */
    LPVOID profileEnv = nullptr;
    const wchar_t* envPtr = envBlock.data();
    if (appContainerSid != nullptr && childToken != nullptr) {
        if (CreateEnvironmentBlock(&profileEnv, childToken, FALSE)) {
            envPtr = (const wchar_t*)profileEnv;
        } else {
            std::fwprintf(stderr, L"dshnt-launch: CreateEnvironmentBlock failed err=%lu\n", GetLastError());
        }
    }

    // 6) 创建（挂起）+ AppContainer 属性 + mitigation。
    SIZE_T attrSize = 0;
    InitializeProcThreadAttributeList(nullptr, 2, 0, &attrSize);
    std::vector<unsigned char> attrBuffer(attrSize);
    LPPROC_THREAD_ATTRIBUTE_LIST attrs = (LPPROC_THREAD_ATTRIBUTE_LIST)attrBuffer.data();
    if (!InitializeProcThreadAttributeList(attrs, 2, 0, &attrSize)) {
        CloseHandle(job);
        WfpClose(wfpGate);
        if (childToken != nullptr) CloseHandle(childToken);
        return Fail("NT_CAPABILITY_MISSING", L"InitializeProcThreadAttributeList failed");
    }

    /*
     * mitigation 位序（winnt.h 的 PROCESS_CREATION_MITIGATION_POLICY_*）：
     *   0 DEP_ENABLE | 8 FORCE_RELOCATE_IMAGES | 16 BOTTOM_UP_ASLR |
     *   28 WIN32K_SYSTEM_CALL_DISABLE | 32 EXTENSION_POINT_DISABLE |
     *   36 PROHIBIT_DYNAMIC_CODE (ACG) | 40 CONTROL_FLOW_GUARD |
     *   44 BLOCK_NON_MICROSOFT_BINARIES
     *
     * ⚠ 之前这里把 28 当成 CFG、36 当成扩展点、40 当成签名策略 —— 三处都错位了一档，
     * 实际只设置了“Win32k 禁用=RERSERVED 值 2 / ACG / CFG”。`m1-mitigate.exe`
     * 用 GetProcessMitigationPolicy 回读后修正（见 M1-REPORT §4.5）。
     */
    DWORD64 mitigation = 0;
    mitigation |= (1ull << 0);   /* DEP */
    mitigation |= (1ull << 8);   /* Force relocate images (ASLR) */
    mitigation |= (1ull << 16);  /* Bottom-up ASLR */
    mitigation |= (1ull << 28);  /* Disable Win32k system calls */
    mitigation |= (1ull << 32);  /* Disable extension points */
    mitigation |= (1ull << 36);  /* Prohibit dynamic code (ACG) */
    mitigation |= (1ull << 40);  /* Control flow guard */
    mitigation |= (1ull << 44);  /* Block non-Microsoft binaries */
    UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY,
                              &mitigation, sizeof(mitigation), nullptr, nullptr);

    SECURITY_CAPABILITIES caps{};
    PSID internetSid = nullptr;
    PSID privateSid = nullptr;
    SID_AND_ATTRIBUTES appCaps[2]{};
    UINT32 appCapCount = 0;
    if (appContainerSid != nullptr) {
        /*
         * AppContainer 默认没有任何网络能力（connect 返回 WSAEACCES 10013），
         * 这会让“observed”对照组也连不上。授予 internetClient
         * (S-1-15-3-1)；offline/allowlist 仍由 WFP 按包 SID 拦截。
         */
        ConvertStringSidToSidW(L"S-1-15-3-1", &internetSid);   // internetClient
        ConvertStringSidToSidW(L"S-1-15-3-3", &privateSid);    // privateNetworkClientServer
        if (internetSid != nullptr) {
            appCaps[appCapCount].Sid = internetSid;
            appCaps[appCapCount].Attributes = SE_GROUP_ENABLED;
            appCapCount++;
        }
        if (privateSid != nullptr) {
            appCaps[appCapCount].Sid = privateSid;
            appCaps[appCapCount].Attributes = SE_GROUP_ENABLED;
            appCapCount++;
        }
        if (appCapCount > 0) {
            caps.Capabilities = appCaps;
            caps.CapabilityCount = appCapCount;
        }
        caps.AppContainerSid = appContainerSid;
        caps.Reserved = 0;
        UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                  &caps, sizeof(caps), nullptr, nullptr);
    }

    STARTUPINFOEXW si{};
    si.StartupInfo.cb = sizeof(si);
    si.lpAttributeList = attrs;
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);

    PROCESS_INFORMATION pi{};
    std::wstring cmdline = JoinCommandLine(o.argv);
    std::vector<wchar_t> cmd(cmdline.begin(), cmdline.end());
    cmd.push_back(0);

    DWORD flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT |
                  CREATE_BREAKAWAY_FROM_JOB;

    /*
     * AppContainer：用 CreateProcessW + PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES，
     * 由内核从当前令牌派生 LowBox 令牌（MS 的 AppContainer 样例路径）。
     * 实测 CreateProcessAsUser + CreateAppContainerToken 在 19041 上返回 err=203。
     * 受限令牌：仍走 CreateProcessAsUser。
     */
    BOOL created;
    DWORD firstError = 0;
    if (childToken != nullptr) {
        created = CreateProcessAsUserW(childToken, nullptr, cmd.data(), nullptr, nullptr, TRUE,
                                       flags, (LPVOID)envPtr, cwd.c_str(), &si.StartupInfo, &pi);
    } else {
        created = CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, TRUE,
                                 flags, (LPVOID)envPtr, cwd.c_str(), &si.StartupInfo, &pi);
    }
    if (!created) {
        firstError = GetLastError();
        if (appContainerSid != nullptr && childToken != nullptr) {
            /*
             * CreateProcessAsUser + AppContainer 令牌在 19041 上返回 203
             * (ERROR_ENVVAR_NOT_FOUND)。改用 CreateProcessW：内核按
             * SECURITY_CAPABILITIES 属性从当前令牌派生 LowBox 令牌。
             */
            CloseHandle(childToken);
            childToken = nullptr;
            created = CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, TRUE,
                                     flags, (LPVOID)envPtr, cwd.c_str(), &si.StartupInfo, &pi);
        } else if (firstError == ERROR_ACCESS_DENIED) {
            flags &= ~CREATE_BREAKAWAY_FROM_JOB;
            created = CreateProcessAsUserW(childToken, nullptr, cmd.data(), nullptr, nullptr, TRUE,
                                           flags, (LPVOID)envPtr, cwd.c_str(), &si.StartupInfo, &pi);
        }
    }
    std::fwprintf(stderr, L"dshnt-launch: create first=%lu final=%lu appcontainer=%d\n",
                  firstError, created ? 0 : GetLastError(), appContainerSid != nullptr ? 1 : 0);
    if (profileEnv != nullptr) DestroyEnvironmentBlock(profileEnv);
    DeleteProcThreadAttributeList(attrs);

    if (!created) {
        DWORD err = GetLastError();
        CloseHandle(job);
        WfpClose(wfpGate);
        if (childToken != nullptr) CloseHandle(childToken);
        return Fail("NT_ACCESS_DENIED", L"CreateProcess failed err=" + std::to_wstring(err));
    }

    // 7) 入 Job + 注册域（先注册再 resume：避免子进程在注册前执行）。
    if (!AssignProcessToJobObject(job, pi.hProcess)) {
        TerminateProcess(pi.hProcess, 91);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        CloseHandle(job);
        WfpClose(wfpGate);
        if (childToken != nullptr) CloseHandle(childToken);
        return Fail("NT_CAPABILITY_MISSING", L"AssignProcessToJobObject failed");
    }

    std::wstring regError;
    if (!port.RegisterProcess((unsigned long)pi.dwProcessId, DSHNT_PROC_ROOT, o.domain, &regError)) {
        TerminateProcess(pi.hProcess, 91);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        CloseHandle(job);
        WfpClose(wfpGate);
        if (childToken != nullptr) CloseHandle(childToken);
        return Fail("NT_DOMAIN_NOT_REGISTERED", regError);
    }

    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    if (childToken != nullptr) CloseHandle(childToken);
    if (appContainerSid != nullptr) LocalFree(appContainerSid);

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD exitCode = 91;
    GetExitCodeProcess(pi.hProcess, &exitCode);

    port.UnregisterProcess((unsigned long)pi.dwProcessId);
    CloseHandle(pi.hProcess);
    if (o.jobKillOnClose) {
        TerminateJobObject(job, exitCode);
    }
    CloseHandle(job);
    WfpClose(wfpGate);

    return (int)exitCode;
}
