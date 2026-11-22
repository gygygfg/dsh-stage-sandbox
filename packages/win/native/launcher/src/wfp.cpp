// dshnt-launch: WFP 实现（按 ALE_PACKAGE_ID = AppContainer SID 过滤）。
#include "wfp.h"

#include <fwpmu.h>
#include <fwpts.h>
#include <ws2tcpip.h>
#include <sddl.h>
#include <cstdio>
#include <cstring>
#include <vector>

#pragma comment(lib, "fwpuclnt.lib")
#pragma comment(lib, "ws2_32.lib")

namespace {

std::wstring SubLayerName(const std::wstring& sid) { return L"dshnt-net-" + sid; }

std::wstring HrText(HRESULT hr) {
    wchar_t buf[64];
    swprintf_s(buf, L"0x%08lX", (unsigned long)hr);
    return buf;
}

struct Session {
    HANDLE engine = nullptr;
    GUID subLayerKey{};
    ~Session() {
        if (engine != nullptr) FwpmEngineClose0(engine);
    }
};

bool OpenSession(Session& s, std::wstring* error) {
    FWPM_SESSION0 session{};
    session.flags = FWPM_SESSION_FLAG_DYNAMIC;
    DWORD rc = FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, &session, &s.engine);
    if (rc != ERROR_SUCCESS) {
        if (error) *error = L"FwpmEngineOpen0 " + HrText(rc);
        return false;
    }
    return true;
}

bool EnsureSubLayer(Session& s, const std::wstring& sid, std::wstring* error) {
    std::wstring name = SubLayerName(sid);
    FWPM_SUBLAYER0 existing{};
    DWORD rc = FwpmSubLayerGetByName0(s.engine, name.c_str(), &existing);
    if (rc == ERROR_SUCCESS) {
        s.subLayerKey = existing.subLayerKey;
        return true;
    }

    FWPM_SUBLAYER0 layer{};
    layer.displayData.name = const_cast<wchar_t*>(name.c_str());
    layer.displayData.description = const_cast<wchar_t*>(L"dshnt sandbox network gate");
    layer.weight = 0xFFFF;
    CoCreateGuid(&layer.subLayerKey);
    rc = FwpmSubLayerAdd0(s.engine, &layer, nullptr);
    if (rc != ERROR_SUCCESS) {
        if (error) *error = L"FwpmSubLayerAdd0 " + HrText(rc);
        return false;
    }
    s.subLayerKey = layer.subLayerKey;
    return true;
}

// 包 SID 的 FWP_BYTE_BLOB（= SID 字节）。
bool BuildSidBlob(const std::wstring& sid, std::vector<unsigned char>& storage, FWP_BYTE_BLOB* blob,
                  std::wstring* error) {
    PSID psid = nullptr;
    if (!ConvertStringSidToSidW(sid.c_str(), &psid)) {
        if (error) *error = L"invalid SID";
        return false;
    }
    DWORD len = GetLengthSid(psid);
    storage.resize(len);
    if (!CopySid(len, storage.data(), psid)) {
        LocalFree(psid);
        if (error) *error = L"CopySid failed";
        return false;
    }
    LocalFree(psid);
    blob->size = len;
    blob->data = storage.data();
    return true;
}

struct FilterSpec {
    const GUID* layerKey;
    bool permit;
    unsigned long long weight;
    const wchar_t* name;
    // 可选：远端地址/端口（allowlist permit）
    bool hasRemote;
    FWP_BYTE_BLOB* remoteAddr;   // 16 字节（v4 用前 4 字节，v4mapped 亦可）
    unsigned short remotePort;
};

bool AddFilter(Session& s, const FWP_BYTE_BLOB& packageId, const FilterSpec& spec, std::wstring* error) {
    FWPM_FILTER0 filter{};
    FWPM_FILTER_CONDITION0 conds[3];
    UINT condCount = 0;

    filter.layerKey = *spec.layerKey;
    filter.displayData.name = const_cast<wchar_t*>(spec.name);
    filter.action.type = spec.permit ? FWP_ACTION_PERMIT : FWP_ACTION_BLOCK;
    filter.subLayerKey = s.subLayerKey;
    filter.weight.type = FWP_UINT64;
    filter.weight.uint64 = const_cast<UINT64*>(&spec.weight);

    conds[condCount].fieldKey = FWPM_CONDITION_ALE_PACKAGE_ID;
    conds[condCount].matchType = FWP_MATCH_EQUAL;
    conds[condCount].conditionValue.type = FWP_BYTE_BLOB_TYPE;
    conds[condCount].conditionValue.byteBlob = const_cast<FWP_BYTE_BLOB*>(&packageId);
    condCount++;

    if (spec.hasRemote && spec.remoteAddr != nullptr) {
        conds[condCount].fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
        conds[condCount].matchType = FWP_MATCH_EQUAL;
        conds[condCount].conditionValue.type = FWP_BYTE_BLOB_TYPE;
        conds[condCount].conditionValue.byteBlob = spec.remoteAddr;
        condCount++;

        conds[condCount].fieldKey = FWPM_CONDITION_IP_REMOTE_PORT;
        conds[condCount].matchType = FWP_MATCH_EQUAL;
        conds[condCount].conditionValue.type = FWP_UINT16;
        conds[condCount].conditionValue.uint16 = spec.remotePort;
        condCount++;
    }

    filter.filterCondition = conds;
    filter.numFilterConditions = condCount;

    UINT64 id = 0;
    DWORD rc = FwpmFilterAdd0(s.engine, &filter, nullptr, &id);
    if (rc != ERROR_SUCCESS) {
        if (error) *error = std::wstring(L"FwpmFilterAdd0(") + spec.name + L") " + HrText(rc);
        return false;
    }
    return true;
}

} // namespace

bool WfpInstall(const std::wstring& sid, bool allowlist,
                const std::vector<WfpEndpoint>& endpoints, std::wstring* error) {
    if (sid.empty()) {
        if (error) *error = L"offline/allowlist requires --token appcontainer (package SID)";
        return false;
    }

    Session s;
    if (!OpenSession(s, error)) return false;
    if (!EnsureSubLayer(s, sid, error)) return false;

    std::vector<unsigned char> sidStorage;
    FWP_BYTE_BLOB packageId{};
    if (!BuildSidBlob(sid, sidStorage, &packageId, error)) return false;

    // allowlist：端点 permit，权重高于 block。
    if (allowlist) {
        for (const WfpEndpoint& ep : endpoints) {
            IN_ADDR v4{};
            bool isV4 = InetPtonW(AF_INET, ep.host.c_str(), &v4) == 1;
            IN6_ADDR v6{};
            bool isV6 = !isV4 && InetPtonW(AF_INET6, ep.host.c_str(), &v6) == 1;
            if (!isV4 && !isV6) {
                if (error) *error = L"allowlist endpoint must be an IP literal: " + ep.host;
                return false;
            }
            FWP_BYTE_BLOB addr{};
            addr.size = isV4 ? 4 : 16;
            addr.data = isV4 ? (unsigned char*)&v4 : (unsigned char*)&v6;

            FilterSpec spec{};
            spec.permit = true;
            spec.weight = 0x2000;
            spec.name = L"dshnt allow endpoint";
            spec.hasRemote = true;
            spec.remoteAddr = &addr;
            spec.remotePort = ep.port;

            const GUID* layers4[] = { &FWPM_LAYER_ALE_AUTH_CONNECT_V4, &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4 };
            const GUID* layers6[] = { &FWPM_LAYER_ALE_AUTH_CONNECT_V6, &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6 };
            const GUID** layers = isV4 ? layers4 : layers6;
            for (int i = 0; i < 2; i++) {
                spec.layerKey = layers[i];
                if (!AddFilter(s, packageId, spec, error)) return false;
            }
        }
    }

    // 默认拒绝（权重低于 permit）。
    {
        FilterSpec spec{};
        spec.permit = false;
        spec.weight = 0x1000;
        spec.name = L"dshnt block package";
        const GUID* layers[] = {
            &FWPM_LAYER_ALE_AUTH_CONNECT_V4,
            &FWPM_LAYER_ALE_AUTH_CONNECT_V6,
            &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
            &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
        };
        for (const GUID* l : layers) {
            spec.layerKey = l;
            if (!AddFilter(s, packageId, spec, error)) return false;
        }
    }

    return true;
}

void WfpRemove(const std::wstring& sid) {
    if (sid.empty()) return;

    Session s;
    std::wstring ignored;
    if (!OpenSession(s, &ignored)) return;

    std::wstring name = SubLayerName(sid);
    FWPM_SUBLAYER0 sub{};
    if (FwpmSubLayerGetByName0(s.engine, name.c_str(), &sub) != ERROR_SUCCESS) {
        return;
    }

    // 枚举本 sublayer 的所有 filter 并删除。
    HANDLE enumHandle = nullptr;
    FWPM_FILTER_ENUM_TEMPLATE0 tmpl{};
    tmpl.subLayerKey = sub.subLayerKey;
    if (FwpmFilterEnumCreateEnumHandle0(s.engine, &tmpl, &enumHandle) == ERROR_SUCCESS) {
        FWPM_FILTER0** entries = nullptr;
        UINT32 count = 0;
        while (FwpmFilterEnumNext0(s.engine, enumHandle, 64, &entries, &count) == ERROR_SUCCESS && count > 0) {
            for (UINT32 i = 0; i < count; i++) {
                FwpmFilterDeleteById0(s.engine, entries[i]->filterId);
            }
            FwpmFreeMemory0((void**)&entries);
            entries = nullptr;
            count = 0;
        }
        FwpmFilterEnumDestroyEnumHandle0(s.engine, enumHandle);
    }

    FwpmSubLayerDeleteByKey0(s.engine, &sub.subLayerKey);
}
