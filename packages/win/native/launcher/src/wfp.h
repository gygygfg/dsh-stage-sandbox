// dshnt-launch: WFP 网络闸门（按 AppContainer 包 SID）
//
// 规则：
//   · offline   → 在 ALE_AUTH_CONNECT/RECV_ACCEPT (v4/v6) 上 BLOCK 该包 SID 的全部流量；
//   · allowlist → 先按端点加 PERMIT（更高权重），再加同样的 BLOCK；
//   · observed  → 不安装（由调用方决定，控制面会显式标注“未强制”）。
//
// 不静默降级：任何 FwpmFilterAdd 失败都让安装失败，启动器拒绝执行。
// 清理：按 sublayer 名字找到本 SID 的规则并删除（跨进程可用）。
#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <vector>

struct WfpEndpoint {
    std::wstring host;   // IP 字面量（v1 不支持域名）
    unsigned short port;
};

// 返回的 gate 必须在子进程整个生命周期内保持打开；关闭即删除规则（DYNAMIC 会话）。
bool WfpInstall(const std::wstring& sid, bool allowlist,
                const std::vector<WfpEndpoint>& endpoints, void** outGate, std::wstring* error);
void WfpClose(void* gate);
