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
    int policyGeneration = 0;
    std::wstring network = L"offline";
    std::wstring token = L"restricted";
    std::wstring sid;
    std::wstring cwd;
    unsigned long long jobMemoryMb = 0;
    int jobActiveProcesses = 0;
    int jobCpuPercent = 0;
    bool jobKillOnClose = false;
    std::vector<std::pair<std::wstring, std::wstring>> env;
    std::vector<std::wstring> argv;
};

int Fail(const char* code, const std::wstring& detail, int exitCode = 90) {
    std::fwprintf(stderr, L"dshnt-launch: FAIL %hs: %ls\n", code, detail.c_str());
    return exitCode;
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
        else if (a == L"--policy-generation") { if (!need(L"--policy-generation")) return false; o.policyGeneration = _wtoi(argv[i]); }
        else if (a == L"--network") { if (!need(L"--network")) return false; o.network = argv[i]; }
        else if (a == L"--token") { if (!need(L"--token")) return false; o.token = argv[i]; }
        else if (a == L"--sid") { if (!need(L"--sid")) return false; o.sid = argv[i]; }
        else if (a == L"--cwd") { if (!need(L"--cwd")) return false; o.cwd = argv[i]; }
        else if (a == L"--job-memory-mb") { if (!need(L"--job-memory-mb")) return false; o.jobMemoryMb = _wcstoui64(argv[i], nullptr, 10); }
        else if (a == L"--job-active-processes") { if (!need(L"--job-active-processes")) return false; o.jobActiveProcesses = _wtoi(argv[i]); }
        else if (a == L"--job-cpu-percent") { if (!need(L"--job-cpu-percent")) return false; o.jobCpuPercent = _wtoi(argv[i]); }
        else if (a == L"--job-kill-on-close") { if (!need(L"--job-kill-on-close")) return false; o.jobKillOnClose = std::wstring(argv[i]) == L"1"; }
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

bool SetLowIntegrity(HANDLE token) {
    SID_IDENTIFIER_AUTHORITY auth = SECURITY_MANDATORY_LABEL_AUTHORITY;
    PSID sid = nullptr;
    if (!AllocateAndInitializeSid(&auth, 1, SECURITY_MANDATORY_LOW_RID, 0, 0, 0, 0, 0, 0, 0, &sid)) return false;
    TOKEN_MANDATORY_LABEL label{};
    label.Label.Attributes = SE_GROUP_INTEGRITY;
    label.Label.Sid = sid;
    bool ok = SetTokenInformation(token, TokenIntegrityLevel, &label, sizeof(label) + GetLengthSid(sid)) != 0;
    FreeSid(sid);
    return ok;
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
        if (o.sid.empty() || !ConvertStringSidToSidW(o.sid.c_str(), &appContainerSid)) {
            CloseHandle(primary);
            return Fail("NT_CAPABILITY_MISSING", L"--sid must be a valid SID for appcontainer mode");
        }
        HRESULT hr = CreateAppContainerToken(primary, appContainerSid, &childToken);
        if (FAILED(hr) || childToken == nullptr) {
            LocalFree(appContainerSid);
            CloseHandle(primary);
            return Fail("NT_CAPABILITY_MISSING", L"CreateAppContainerToken failed");
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
        if (!SetLowIntegrity(childToken)) {
            CloseHandle(childToken);
            CloseHandle(primary);
            return Fail("NT_CAPABILITY_MISSING", L"SetLowIntegrity failed");
        }
    }
    CloseHandle(primary);

    // 3) WFP（按 SID；不是 appcontainer 时无法按包 ID 过滤）。
    bool wfpInstalled = false;
    if (o.network != L"observed") {
        if (o.network != L"offline" && o.network != L"allowlist") {
            CloseHandle(childToken);
            return Fail("NT_NETWORK_UNSUPPORTED", L"unknown --network mode");
        }
        std::wstring wfpError;
        if (!WfpInstall(o.sid, o.network == L"allowlist", {}, &wfpError)) {
            CloseHandle(childToken);
            return Fail("NT_NETWORK_UNENFORCED", wfpError);
        }
        wfpInstalled = true;
    }

    // 4) Job。
    HANDLE job = nullptr;
    std::wstring jobError;
    if (!CreateJob(o, &job, jobError)) {
        if (wfpInstalled) WfpRemove(o.sid);
        CloseHandle(childToken);
        return Fail("NT_CAPABILITY_MISSING", jobError);
    }

    // 5) 环境 + cwd。
    std::wstring cwd = o.cwd.empty() ? o.view : o.cwd;
    if (!PathInside(cwd, o.view)) {
        CloseHandle(job);
        if (wfpInstalled) WfpRemove(o.sid);
        CloseHandle(childToken);
        return Fail("NT_PATH_ESCAPE", L"--cwd must be inside --view");
    }
    std::wstring tempDir = o.view + L"\\.dshnt-tmp";
    CreateDirectoryW(tempDir.c_str(), nullptr);
    std::vector<wchar_t> envBlock = BuildEnvironment(o, tempDir);

    // 6) 创建（挂起）+ AppContainer 属性 + mitigation。
    SIZE_T attrSize = 0;
    InitializeProcThreadAttributeList(nullptr, 2, 0, &attrSize);
    std::vector<unsigned char> attrBuffer(attrSize);
    LPPROC_THREAD_ATTRIBUTE_LIST attrs = (LPPROC_THREAD_ATTRIBUTE_LIST)attrBuffer.data();
    if (!InitializeProcThreadAttributeList(attrs, 2, 0, &attrSize)) {
        CloseHandle(job);
        if (wfpInstalled) WfpRemove(o.sid);
        CloseHandle(childToken);
        return Fail("NT_CAPABILITY_MISSING", L"InitializeProcThreadAttributeList failed");
    }

    DWORD64 mitigation = 0;
    mitigation |= PROCESS_CREATION_MITIGATION_POLICY_DEP_ENABLE;
    mitigation |= (1ull << 8);   /* DEP_ALWAYS_ON */
    mitigation |= (1ull << 16);  /* ASLR force relocate images: ALWAYS_ON */
    mitigation |= (2ull << 28);  /* Control flow guard: ALWAYS_ON */
    mitigation |= (1ull << 36);  /* Disable extension points */
    mitigation |= (1ull << 40);  /* Block non-Microsoft binaries */
    UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY,
                              &mitigation, sizeof(mitigation), nullptr, nullptr);

    SECURITY_CAPABILITIES caps{};
    if (appContainerSid != nullptr) {
        caps.AppContainerSid = appContainerSid;
        caps.Capabilities = nullptr;
        caps.CapabilityCount = 0;
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

    BOOL created = CreateProcessAsUserW(childToken, nullptr, cmd.data(), nullptr, nullptr, TRUE,
                                        flags, envBlock.data(), cwd.c_str(),
                                        &si.StartupInfo, &pi);
    if (!created) {
        DWORD err = GetLastError();
        if (err == ERROR_ACCESS_DENIED) {
            flags &= ~CREATE_BREAKAWAY_FROM_JOB;
            created = CreateProcessAsUserW(childToken, nullptr, cmd.data(), nullptr, nullptr, TRUE,
                                           flags, envBlock.data(), cwd.c_str(),
                                           &si.StartupInfo, &pi);
        }
    }
    DeleteProcThreadAttributeList(attrs);

    if (!created) {
        DWORD err = GetLastError();
        CloseHandle(job);
        if (wfpInstalled) WfpRemove(o.sid);
        CloseHandle(childToken);
        return Fail("NT_ACCESS_DENIED", L"CreateProcessAsUser failed err=" + std::to_wstring(err));
    }

    // 7) 入 Job + 注册域（先注册再 resume：避免子进程在注册前执行）。
    if (!AssignProcessToJobObject(job, pi.hProcess)) {
        TerminateProcess(pi.hProcess, 91);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        CloseHandle(job);
        if (wfpInstalled) WfpRemove(o.sid);
        CloseHandle(childToken);
        return Fail("NT_CAPABILITY_MISSING", L"AssignProcessToJobObject failed");
    }

    std::wstring regError;
    if (!port.RegisterProcess((unsigned long)pi.dwProcessId, DSHNT_PROC_ROOT, o.domain, &regError)) {
        TerminateProcess(pi.hProcess, 91);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        CloseHandle(job);
        if (wfpInstalled) WfpRemove(o.sid);
        CloseHandle(childToken);
        return Fail("NT_DOMAIN_NOT_REGISTERED", regError);
    }

    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    CloseHandle(childToken);
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
    if (wfpInstalled) WfpRemove(o.sid);

    return (int)exitCode;
}
