// dshnt-launch: \DshNtPort 客户端实现。
#include "port.h"

#include <cstring>

// 手工声明两个 fltlib 导出：避免 fltuser.h 的头部前置条件（SDK 版本差异）。
extern "C" {
__declspec(dllimport) long __stdcall FilterConnectCommunicationPort(
    const wchar_t* lpPortName, unsigned long dwOptions, const void* lpContext,
    unsigned short wSizeOfContext, void* lpSecurityAttributes, void** lpPort);
__declspec(dllimport) long __stdcall FilterSendMessage(
    void* hPort, void* lpInBuffer, unsigned long dwInBufferSize,
    void* lpOutBuffer, unsigned long dwOutBufferSize, unsigned long* lpBytesReturned);
}

#pragma comment(lib, "fltlib.lib")

namespace {

void PutRef(std::vector<unsigned char>& blob, const std::wstring& s, DSHNT_STRING_REF* ref) {
    ref->Offset = (unsigned long)blob.size();
    ref->Bytes = (unsigned long)(s.size() * sizeof(wchar_t));
    size_t at = blob.size();
    blob.resize(at + ref->Bytes);
    if (ref->Bytes) std::memcpy(blob.data() + at, s.c_str(), ref->Bytes);
}

std::wstring StatusText(unsigned long status) {
    wchar_t buf[64];
    swprintf_s(buf, L"0x%08lX", status);
    return buf;
}

} // namespace

DshntPort::~DshntPort() { Close(); }

bool DshntPort::Connect(std::wstring* error) {
    long hr = FilterConnectCommunicationPort(DSHNT_PORT_NAME, 0, nullptr, 0, nullptr, &port_);
    if (FAILED(hr)) {
        if (error) *error = L"FilterConnectCommunicationPort " + StatusText((unsigned long)hr);
        port_ = INVALID_HANDLE_VALUE;
        return false;
    }
    return true;
}

void DshntPort::Close() {
    if (port_ != INVALID_HANDLE_VALUE) {
        CloseHandle(port_);
        port_ = INVALID_HANDLE_VALUE;
    }
}

bool DshntPort::Send(unsigned short type, const std::vector<unsigned char>& payload,
                     std::vector<unsigned char>* reply, std::wstring* error) {
    if (port_ == INVALID_HANDLE_VALUE) {
        if (error) *error = L"port is not connected";
        return false;
    }

    std::vector<unsigned char> in(sizeof(DSHNT_MSG_HEADER) + payload.size(), 0);
    DSHNT_MSG_HEADER* hdr = (DSHNT_MSG_HEADER*)in.data();
    hdr->Size = (unsigned long)in.size();
    hdr->Version = (unsigned short)DSHNT_ABI_VERSION;
    hdr->Type = type;
    hdr->Status = 0;
    hdr->Reserved = 0;
    if (!payload.empty()) {
        std::memcpy(in.data() + sizeof(DSHNT_MSG_HEADER), payload.data(), payload.size());
    }

    std::vector<unsigned char> out(64 * 1024);
    DWORD returned = 0;
    long hr = FilterSendMessage(port_, in.data(), (DWORD)in.size(), out.data(), (DWORD)out.size(), &returned);
    if (FAILED(hr)) {
        if (error) *error = L"FilterSendMessage " + StatusText((unsigned long)hr);
        return false;
    }
    if (returned < sizeof(DSHNT_MSG_HEADER)) {
        if (error) *error = L"short reply";
        return false;
    }
    const DSHNT_MSG_HEADER* rh = (const DSHNT_MSG_HEADER*)out.data();
    if (rh->Status != 0) {
        if (error) *error = L"driver status " + StatusText(rh->Status);
        return false;
    }
    if (reply != nullptr) {
        reply->assign(out.begin(), out.begin() + returned);
    }
    return true;
}

bool DshntPort::Hello(DshntHello* out, std::wstring* error) {
    std::vector<unsigned char> reply;
    if (!Send(DshntMsgHello, {}, &reply, error)) return false;
    if (reply.size() < sizeof(DSHNT_MSG_HEADER) + sizeof(DSHNT_HELLO_REPLY)) {
        if (error) *error = L"hello reply too small";
        return false;
    }
    const DSHNT_HELLO_REPLY* r = (const DSHNT_HELLO_REPLY*)(reply.data() + sizeof(DSHNT_MSG_HEADER));
    out->abiVersion = r->AbiVersion;
    out->capabilities = r->Capabilities;
    wcscpy_s(out->driverVersion, r->DriverVersion);
    wcscpy_s(out->altitude, r->Altitude);
    return true;
}

bool DshntPort::SetPolicy(const std::vector<unsigned char>& payload, std::wstring* error) {
    return Send(DshntMsgSetPolicy, payload, nullptr, error);
}

bool DshntPort::RegisterDomain(const std::wstring& id, const std::wstring& workspace,
                               const std::wstring& view, const std::wstring& store, std::wstring* error) {
    DSHNT_REGISTER_DOMAIN req{};
    std::vector<unsigned char> strings;
    PutRef(strings, id, &req.Id);
    PutRef(strings, workspace, &req.WorkspaceRoot);
    PutRef(strings, view, &req.ViewRoot);
    PutRef(strings, store, &req.StoreRoot);

    std::vector<unsigned char> payload(sizeof(req) + strings.size());
    std::memcpy(payload.data(), &req, sizeof(req));
    if (!strings.empty()) std::memcpy(payload.data() + sizeof(req), strings.data(), strings.size());
    return Send(DshntMsgRegisterDomain, payload, nullptr, error);
}

bool DshntPort::QueryStats(DshntStats* out, std::wstring* error) {
    std::vector<unsigned char> reply;
    if (!Send(DshntMsgQueryStats, {}, &reply, error)) return false;
    if (reply.size() < sizeof(DSHNT_MSG_HEADER) + sizeof(DSHNT_STATS)) {
        if (error) *error = L"stats reply too small";
        return false;
    }
    const DSHNT_STATS* r = (const DSHNT_STATS*)(reply.data() + sizeof(DSHNT_MSG_HEADER));
    out->domains = r->Domains;
    out->rules = r->Rules;
    out->redirects = r->Redirects;
    out->denies = r->Denies;
    out->masks = r->Masks;
    out->policyGeneration = r->PolicyGeneration;
    out->lastError = r->LastError;
    out->processCount = r->ProcessCount;
    return true;
}

bool DshntPort::RegisterProcess(unsigned long pid, unsigned long flags,
                                const std::wstring& domain, std::wstring* error) {
    DSHNT_REGISTER_PROCESS req{};
    std::vector<unsigned char> strings;
    req.Pid = pid;
    req.Flags = flags;
    PutRef(strings, domain, &req.DomainId);

    std::vector<unsigned char> payload(sizeof(req) + strings.size());
    std::memcpy(payload.data(), &req, sizeof(req));
    if (!strings.empty()) std::memcpy(payload.data() + sizeof(req), strings.data(), strings.size());

    return Send(DshntMsgRegisterProcess, payload, nullptr, error);
}

bool DshntPort::UnregisterProcess(unsigned long pid) {
    DSHNT_UNREGISTER_PROCESS req{};
    req.Pid = pid;
    std::vector<unsigned char> payload(sizeof(req));
    std::memcpy(payload.data(), &req, sizeof(req));
    std::wstring ignored;
    return Send(DshntMsgUnregisterProcess, payload, nullptr, &ignored);
}
