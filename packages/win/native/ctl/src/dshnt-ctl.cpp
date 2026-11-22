// dshnt-ctl.exe — 控制面/诊断 CLI（安装、策略、域、统计、事件）。
//
//   dshnt-ctl hello
//   dshnt-ctl policy <policy.bin>
//   dshnt-ctl register-domain <id> <workspace> <view> <store>
//   dshnt-ctl stats
//   dshnt-ctl events
//
// 策略 payload 由控制面的 `src/nt/policy-binary.ts::encodePolicy` 生成；
// 本工具**不**解析/构造策略，避免出现第二份 ABI 实现。
//
// 退出码：0 成功，2 用法错误，3 驱动/端口错误。

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

#include "dshnt_abi.h"
#include "port.h"

namespace {

int Usage() {
    std::fwprintf(stderr,
        L"usage:\n"
        L"  dshnt-ctl hello\n"
        L"  dshnt-ctl policy <policy.bin>\n"
        L"  dshnt-ctl register-domain <id> <workspace> <view> <store>\n"
        L"  dshnt-ctl stats\n"
        L"  dshnt-ctl events\n");
    return 2;
}

bool ReadAll(const std::wstring& path, std::vector<unsigned char>& out) {
    std::ifstream file(path, std::ios::binary);
    if (!file) return false;
    out.assign(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
    return true;
}

int Fail(const std::wstring& message) {
    std::fwprintf(stderr, L"dshnt-ctl: %ls\n", message.c_str());
    return 3;
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    if (argc < 2) return Usage();

    std::wstring command = argv[1];
    DshntPort port;
    std::wstring error;

    if (!port.Connect(&error)) return Fail(L"connect: " + error + L" (is dshnt.sys loaded?)");

    if (command == L"hello") {
        DshntHello hello{};
        if (!port.Hello(&hello, &error)) return Fail(L"hello: " + error);
        std::wprintf(L"abi=%lu capabilities=0x%08lX version=%ls altitude=%ls\n",
                     hello.abiVersion, hello.capabilities, hello.driverVersion, hello.altitude);
        return 0;
    }

    if (command == L"policy") {
        if (argc < 3) return Usage();
        std::vector<unsigned char> payload;
        if (!ReadAll(argv[2], payload)) return Fail(L"cannot read " + std::wstring(argv[2]));
        if (payload.size() < sizeof(DSHNT_POLICY_HEADER)) return Fail(L"policy file too small");
        if (!port.SetPolicy(payload, &error)) {
            DshntStats failStats{};
            std::wstring statsError;
            if (port.QueryStats(&failStats, &statsError)) {
                std::wprintf(L"set-policy failed: bytes=%zu lastError=0x%08lX\n",
                             payload.size(), failStats.lastError);
            }
            return Fail(L"set-policy: " + error);
        }
        DshntStats stats{};
        if (port.QueryStats(&stats, &error)) {
            std::wprintf(L"policy applied: generation=%lu domains=%lu rules=%lu\n",
                         stats.policyGeneration, stats.domains, stats.rules);
        }
        return 0;
    }

    if (command == L"register-domain") {
        if (argc < 6) return Usage();
        if (!port.RegisterDomain(argv[2], argv[3], argv[4], argv[5], &error)) {
            return Fail(L"register-domain: " + error);
        }
        std::wprintf(L"domain %ls registered\n", argv[2]);
        return 0;
    }

    if (command == L"stats") {
        DshntStats stats{};
        if (!port.QueryStats(&stats, &error)) return Fail(L"stats: " + error);
        std::wprintf(L"generation=%lu domains=%lu rules=%lu processes=%lu redirects=%llu denies=%llu masks=%llu lastError=0x%08lX\n",
                     stats.policyGeneration, stats.domains, stats.rules, stats.processCount,
                     stats.redirects, stats.denies, stats.masks, stats.lastError);
        return 0;
    }

    if (command == L"events") {
        // 事件轮询在 ABI v2；这里只打印计数，完整解码在 TS 控制面。
        DshntStats stats{};
        if (!port.QueryStats(&stats, &error)) return Fail(L"stats: " + error);
        std::wprintf(L"events pending (see ts client): denies=%llu masks=%llu\n", stats.denies, stats.masks);
        return 0;
    }

    return Usage();
}
