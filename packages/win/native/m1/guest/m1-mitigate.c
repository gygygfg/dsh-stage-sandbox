/*
 * dshnt M1 mitigation / Job probe.
 *
 * 由 launcher 在域内启动；本进程只读地回读**内核视角**的 mitigation 与 Job 限制，
 * 全部符合才退出 0。这样“launcher 设置了 mitigation”不是自述，而是可复核的事实。
 *
 * 输出（stdout，一行一项）：
 *   MITIGATION dep=1 aslr=1 buaslr=1 win32k=1 ext=1 acg=1 cfg=1 msft=1
 *   JOB injob=1 active=16 memmb=1024 kill=1 cpu=5000
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>

static int g_failures = 0;

static int Bit(DWORD value, DWORD bit) {
    return (value & bit) ? 1 : 0;
}

static int Expect(const char* name, int actual, int expected) {
    if (actual != expected) {
        printf("MITIGATION-MISMATCH %s actual=%d expected=%d\n", name, actual, expected);
        g_failures++;
        return 0;
    }
    return actual;
}

int main(void) {
    PROCESS_MITIGATION_DEP_POLICY dep = {};
    PROCESS_MITIGATION_ASLR_POLICY aslr = {};
    PROCESS_MITIGATION_SYSTEM_CALL_DISABLE_POLICY syscall = {};
    PROCESS_MITIGATION_EXTENSION_POINT_DISABLE_POLICY ext = {};
    PROCESS_MITIGATION_DYNAMIC_CODE_POLICY acg = {};
    PROCESS_MITIGATION_CONTROL_FLOW_GUARD_POLICY cfg = {};
    PROCESS_MITIGATION_BINARY_SIGNATURE_POLICY sig = {};

    if (!GetProcessMitigationPolicy(GetCurrentProcess(), ProcessDEPPolicy, &dep, sizeof(dep)) ||
        !GetProcessMitigationPolicy(GetCurrentProcess(), ProcessASLRPolicy, &aslr, sizeof(aslr)) ||
        !GetProcessMitigationPolicy(GetCurrentProcess(), ProcessSystemCallDisablePolicy, &syscall, sizeof(syscall)) ||
        !GetProcessMitigationPolicy(GetCurrentProcess(), ProcessExtensionPointDisablePolicy, &ext, sizeof(ext)) ||
        !GetProcessMitigationPolicy(GetCurrentProcess(), ProcessDynamicCodePolicy, &acg, sizeof(acg)) ||
        !GetProcessMitigationPolicy(GetCurrentProcess(), ProcessControlFlowGuardPolicy, &cfg, sizeof(cfg)) ||
        !GetProcessMitigationPolicy(GetCurrentProcess(), ProcessSignaturePolicy, &sig, sizeof(sig))) {
        printf("MITIGATION-QUERY-FAILED err=%lu\n", GetLastError());
        return 2;
    }

    int depOn = Expect("dep", Bit(dep.Flags, 1u << 0), 1);
    int forceRelocate = Expect("aslr", Bit(aslr.Flags, 1u << 1), 1);
    int bottomUp = Expect("buaslr", Bit(aslr.Flags, 1u << 0), 1);
    int win32k = Expect("win32k", Bit(syscall.Flags, 1u << 0), 1);
    int extOff = Expect("ext", Bit(ext.Flags, 1u << 0), 1);
    int acgOn = Expect("acg", Bit(acg.Flags, 1u << 0), 1);
    int cfgOn = Expect("cfg", Bit(cfg.Flags, 1u << 0), 1);
    int msft = Expect("msft", Bit(sig.Flags, 1u << 0), 1);

    printf("MITIGATION dep=%d aslr=%d buaslr=%d win32k=%d ext=%d acg=%d cfg=%d msft=%d\n",
           depOn, forceRelocate, bottomUp, win32k, extOff, acgOn, cfgOn, msft);

    BOOL inJob = FALSE;
    if (!IsProcessInJob(GetCurrentProcess(), NULL, &inJob)) {
        printf("JOB-QUERY-FAILED err=%lu\n", GetLastError());
        return 2;
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION extLimit = {};
    if (!QueryInformationJobObject(NULL, JobObjectExtendedLimitInformation, &extLimit, sizeof(extLimit), NULL)) {
        printf("JOB-QUERY-FAILED err=%lu\n", GetLastError());
        return 2;
    }
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu = {};
    DWORD cpuReturned = 0;
    BOOL cpuOk = QueryInformationJobObject(NULL, JobObjectCpuRateControlInformation, &cpu, sizeof(cpu), &cpuReturned);

    int activeLimited = Bit(extLimit.BasicLimitInformation.LimitFlags, JOB_OBJECT_LIMIT_ACTIVE_PROCESS);
    int memLimited = Bit(extLimit.BasicLimitInformation.LimitFlags, JOB_OBJECT_LIMIT_PROCESS_MEMORY);
    int killOnClose = Bit(extLimit.BasicLimitInformation.LimitFlags, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
    int cpuEnabled = cpuOk && Bit(cpu.ControlFlags, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE);

    printf("JOB injob=%d active=%lu memmb=%llu kill=%d cpu=%lu\n",
           inJob ? 1 : 0,
           activeLimited ? (unsigned long)extLimit.BasicLimitInformation.ActiveProcessLimit : 0UL,
           memLimited ? (unsigned long long)(extLimit.ProcessMemoryLimit / (1024ull * 1024ull)) : 0ull,
           killOnClose, cpuEnabled ? (unsigned long)cpu.CpuRate : 0UL);

    Expect("injob", inJob ? 1 : 0, 1);
    Expect("active_limit", activeLimited ? (int)extLimit.BasicLimitInformation.ActiveProcessLimit : 0, 16);
    Expect("memory_limit_mb", memLimited ? (int)(extLimit.ProcessMemoryLimit / (1024ull * 1024ull)) : 0, 1024);
    Expect("kill_on_close", killOnClose, 1);
    Expect("cpu_rate", cpuEnabled ? (int)cpu.CpuRate : 0, 5000);

    if (g_failures != 0) {
        printf("MITIGATE-JOB-FAIL failures=%d\n", g_failures);
        return 1;
    }
    printf("MITIGATE-JOB-OK\n");
    return 0;
}
