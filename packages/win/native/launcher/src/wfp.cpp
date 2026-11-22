// dshnt-launch: WFP 网络闸门（按 AppContainer 包 SID）
//
// 规则：
//   · offline   → 在 ALE_AUTH_CONNECT/RECV_ACCEPT (v4/v6) 上 BLOCK 该包 SID 的全部流量；
//   · allowlist → 先按端点加 PERMIT（更高权重），再加同样的 BLOCK；
//   · observed  → 不安装（由调用方决定，控制面会显式标注“未强制”）。
//
// 不静默降级：任何 FwpmFilterAdd 失败都让安装失败，启动器拒绝执行。
//
// 生命周期：引擎会话是 **DYNAMIC** 的——关闭句柄即自动删除本会话添加的所有
// filter/sublayer。因此闸门必须持有句柄直到子进程退出（`WfpInstall` 返回句柄，
// `WfpClose` 关闭）。这也避免了跨进程枚举/清理的复杂度。
#include "wfp.h"

#include <initguid.h>
#include <fwpmu.h>
#include <ws2tcpip.h>
#include <objbase.h>
#include <sddl.h>
#include <cstdio>
#include <cstring>
#include <vector>

#pragma comment(lib, "fwpuclnt.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "ws2_32.lib")

namespace {

std::wstring HrText(HRESULT hr) {
    wchar_t buf[64];
    swprintf_s(buf, L"0x%08lX", (unsigned long)hr);
    return buf;
}

/*
 * 层 GUID。`FwpmLayerGetByName0` 在 Windows 10 19041 的 fwpuclnt.dll 里并不导出
 * （实测 GetProcAddress 为空），而且 SDK 的 FWPM_LAYER_* 符号受 NTDDI 保护。
 * 这些 GUID 是 WFP ABI 的稳定值（取自 fwpmu.h），直接内置。
 */
struct LayerDef {
    const wchar_t* name;
    GUID key;
};

static const LayerDef kLayers[] = {
    { L"ALE_AUTH_CONNECT_V4",
      { 0xc38d57d1, 0x05a7, 0x4c33, { 0x90, 0x4f, 0x7f, 0xbc, 0xee, 0xe6, 0x0e, 0x82 } } },
    { L"ALE_AUTH_CONNECT_V6",
      { 0x4a72393b, 0x319f, 0x44bc, { 0x84, 0xc3, 0xba, 0x54, 0xdc, 0xb3, 0xb6, 0xb4 } } },
    { L"ALE_AUTH_RECV_ACCEPT_V4",
      { 0xe1cd9fe7, 0xf4b5, 0x4273, { 0x96, 0xc0, 0x59, 0x2e, 0x48, 0x7b, 0x86, 0x50 } } },
    { L"ALE_AUTH_RECV_ACCEPT_V6",
      { 0xa3b42c97, 0x9f04, 0x4672, { 0xb8, 0x7e, 0xce, 0xe9, 0xc4, 0x83, 0x25, 0x7f } } },
};

bool LayerKey(HANDLE, const wchar_t* name, GUID* out, std::wstring* error) {
    for (const LayerDef& layer : kLayers) {
        if (wcscmp(layer.name, name) == 0) {
            *out = layer.key;
            return true;
        }
    }
    if (error) *error = std::wstring(L"unknown WFP layer: ") + name;
    return false;
}

/*
 * WFP 的 FWP_UINT32 地址条件要**主机字节序**（MS 文档 populating-filter-conditions：
 * “SOCKADDR 是网络序，但过滤引擎期望主机序”，示例用 ntohl）。IN_ADDR 里存的是网络序
 * 字节，这里按字节拼出主机序数值；写成 network order 会导致条件永远不匹配，
 * 表现就是“allowlist 里放行了端点却仍被阻断”。
 */
static UINT32 HostOrderV4(const IN_ADDR& v4) {
    const unsigned char* b = reinterpret_cast<const unsigned char*>(&v4.S_un.S_addr);
    return (static_cast<UINT32>(b[0]) << 24) | (static_cast<UINT32>(b[1]) << 16) |
           (static_cast<UINT32>(b[2]) << 8) | static_cast<UINT32>(b[3]);
}

bool AddFilter(HANDLE engine, const GUID& subLayer, const GUID& layer, PSID packageSid,
               bool permit, UINT64 weight, const wchar_t* name,
               const FWP_VALUE0* remoteValue, unsigned short remotePort, std::wstring* error) {
    FWPM_FILTER0 filter{};
    FWPM_FILTER_CONDITION0 conds[3];
    UINT condCount = 0;

    filter.layerKey = layer;
    filter.displayData.name = const_cast<wchar_t*>(name);
    filter.action.type = permit ? FWP_ACTION_PERMIT : FWP_ACTION_BLOCK;
    filter.subLayerKey = subLayer;
    filter.weight.type = FWP_UINT64;
    filter.weight.uint64 = const_cast<UINT64*>(&weight);

    /*
     * ALE_PACKAGE_ID 的 value 类型是 FWP_SID（实测 FWP_BYTE_BLOB_TYPE 会返回
     * FWP_E_TYPE_MISMATCH 0x80320027），直接给 SID 指针。
     */
    conds[condCount].fieldKey = FWPM_CONDITION_ALE_PACKAGE_ID;
    conds[condCount].matchType = FWP_MATCH_EQUAL;
    conds[condCount].conditionValue.type = FWP_SID;
    conds[condCount].conditionValue.sid = (SID*)packageSid;
    condCount++;

    if (remoteValue != nullptr) {
        conds[condCount].fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
        conds[condCount].matchType = FWP_MATCH_EQUAL;
        conds[condCount].conditionValue.type = remoteValue->type;
        if (remoteValue->type == FWP_UINT32) {
            conds[condCount].conditionValue.uint32 = remoteValue->uint32;
        } else if (remoteValue->type == FWP_BYTE_ARRAY16_TYPE) {
            conds[condCount].conditionValue.byteArray16 = remoteValue->byteArray16;
        }
        condCount++;

        conds[condCount].fieldKey = FWPM_CONDITION_IP_REMOTE_PORT;
        conds[condCount].matchType = FWP_MATCH_EQUAL;
        conds[condCount].conditionValue.type = FWP_UINT16;
        conds[condCount].conditionValue.uint16 = remotePort;
        condCount++;
    }

    filter.filterCondition = conds;
    filter.numFilterConditions = condCount;

    UINT64 id = 0;
    DWORD rc = FwpmFilterAdd0(engine, &filter, nullptr, &id);
    if (rc != ERROR_SUCCESS) {
        if (error) *error = std::wstring(L"FwpmFilterAdd0(") + name + L") " + HrText((HRESULT)rc);
        return false;
    }
    return true;
}

} // namespace

bool WfpInstall(const std::wstring& sid, bool allowlist, const std::vector<WfpEndpoint>& endpoints,
                void** outGate, std::wstring* error) {
    *outGate = nullptr;
    if (sid.empty()) {
        if (error) *error = L"offline/allowlist requires --token appcontainer (package SID)";
        return false;
    }

    FWPM_SESSION0 session{};
    session.flags = FWPM_SESSION_FLAG_DYNAMIC;
    HANDLE engine = nullptr;
    DWORD rc = FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, &session, &engine);
    if (rc != ERROR_SUCCESS) {
        if (error) *error = L"FwpmEngineOpen0 " + HrText((HRESULT)rc);
        return false;
    }

    GUID subLayerKey{};
    CoCreateGuid(&subLayerKey);
    {
        FWPM_SUBLAYER0 layer{};
        layer.displayData.name = const_cast<wchar_t*>(L"dshnt sandbox network gate");
        layer.displayData.description = const_cast<wchar_t*>(L"dshnt network gate (per package SID)");
        layer.weight = 0xFFFF;
        layer.subLayerKey = subLayerKey;
        rc = FwpmSubLayerAdd0(engine, &layer, nullptr);
        if (rc != ERROR_SUCCESS) {
            if (error) *error = L"FwpmSubLayerAdd0 " + HrText((HRESULT)rc);
            FwpmEngineClose0(engine);
            return false;
        }
    }

    PSID packageSid = nullptr;
    if (!ConvertStringSidToSidW(sid.c_str(), &packageSid)) {
        if (error) *error = L"invalid package SID: " + sid;
        FwpmEngineClose0(engine);
        return false;
    }

    // allowlist：端点 permit，权重高于 block。
    if (allowlist) {
        for (const WfpEndpoint& ep : endpoints) {
            IN_ADDR v4{};
            bool isV4 = InetPtonW(AF_INET, ep.host.c_str(), &v4) == 1;
            IN6_ADDR v6{};
            bool isV6 = !isV4 && InetPtonW(AF_INET6, ep.host.c_str(), &v6) == 1;
            if (!isV4 && !isV6) {
                if (error) *error = L"allowlist endpoint must be an IP literal: " + ep.host;
                LocalFree(packageSid);
                FwpmEngineClose0(engine);
                return false;
            }
            // V4 用 FWP_UINT32（**主机字节序**），V6 用 FWP_BYTE_ARRAY16_TYPE。
            FWP_VALUE0 addrValue{};
            FWP_BYTE_ARRAY16 addr16{};
            if (isV4) {
                addrValue.type = FWP_UINT32;
                addrValue.uint32 = HostOrderV4(v4);
            } else {
                memcpy(addr16.byteArray16, &v6, 16);
                addrValue.type = FWP_BYTE_ARRAY16_TYPE;
                addrValue.byteArray16 = &addr16;
            }

            const wchar_t* layers[] = {
                isV4 ? L"ALE_AUTH_CONNECT_V4" : L"ALE_AUTH_CONNECT_V6",
                isV4 ? L"ALE_AUTH_RECV_ACCEPT_V4" : L"ALE_AUTH_RECV_ACCEPT_V6",
            };
            for (const wchar_t* layerName : layers) {
                GUID layerKey{};
                if (!LayerKey(engine, layerName, &layerKey, error) ||
                    !AddFilter(engine, subLayerKey, layerKey, packageSid, true, 0x2000,
                               L"dshnt allow endpoint", &addrValue, ep.port, error)) {
                    LocalFree(packageSid);
                    FwpmEngineClose0(engine);
                    return false;
                }
            }
        }
    }

    {
        const wchar_t* layers[] = {
            L"ALE_AUTH_CONNECT_V4",
            L"ALE_AUTH_CONNECT_V6",
            L"ALE_AUTH_RECV_ACCEPT_V4",
            L"ALE_AUTH_RECV_ACCEPT_V6",
        };
        for (const wchar_t* layerName : layers) {
            GUID layerKey{};
            if (!LayerKey(engine, layerName, &layerKey, error) ||
                !AddFilter(engine, subLayerKey, layerKey, packageSid, false, 0x1000,
                           L"dshnt block package", nullptr, 0, error)) {
                LocalFree(packageSid);
                FwpmEngineClose0(engine);
                return false;
            }
        }
    }

    // 回读：至少能枚举到本 sublayer，才算“已安装”（不靠“函数没报错”推断）。
    {
        FWPM_SUBLAYER0* check = nullptr;
        if (FwpmSubLayerGetByKey0(engine, &subLayerKey, &check) != ERROR_SUCCESS || check == nullptr) {
            if (error) *error = L"network gate readback failed";
            LocalFree(packageSid);
            FwpmEngineClose0(engine);
            return false;
        }
        FwpmFreeMemory0((void**)&check);
    }

    LocalFree(packageSid);
    *outGate = engine;
    return true;
}

void WfpClose(void* gate) {
    if (gate != nullptr) {
        // DYNAMIC 会话：关闭即删除本会话的全部 filter/sublayer。
        FwpmEngineClose0(gate);
    }
}
