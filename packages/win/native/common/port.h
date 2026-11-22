// dshnt-launch: \DshNtPort 客户端（同步请求/回复）。
#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <vector>
#include "dshnt_abi.h"

struct DshntHello {
    unsigned long abiVersion;
    unsigned long capabilities;
    wchar_t driverVersion[64];
    wchar_t altitude[32];
};

struct DshntStats {
    unsigned long domains;
    unsigned long rules;
    unsigned long long redirects;
    unsigned long long denies;
    unsigned long long masks;
    unsigned long policyGeneration;
    unsigned long lastError;
    unsigned long processCount;
};

class DshntPort {
public:
    ~DshntPort();
    bool Connect(std::wstring* error);
    void Close();

    bool Hello(DshntHello* out, std::wstring* error);
    /** 下发二进制策略（payload 由控制面 `encodePolicy` 生成）。 */
    bool SetPolicy(const std::vector<unsigned char>& payload, std::wstring* error);
    /** 注册域（驱动会与策略里的根核对）。 */
    bool RegisterDomain(const std::wstring& id, const std::wstring& workspace,
                        const std::wstring& view, const std::wstring& store, std::wstring* error);
    /** 注销域：移除域与它的 PID→域映射（驱动侧真实删除，不是 no-op）。 */
    bool UnregisterDomain(const std::wstring& id, std::wstring* error);
    bool QueryStats(DshntStats* out, std::wstring* error);
    bool RegisterProcess(unsigned long pid, unsigned long flags, const std::wstring& domain, std::wstring* error);
    bool UnregisterProcess(unsigned long pid);

private:
    bool Send(unsigned short type, const std::vector<unsigned char>& payload,
              std::vector<unsigned char>* reply, std::wstring* error);
    HANDLE port_ = INVALID_HANDLE_VALUE;
};
