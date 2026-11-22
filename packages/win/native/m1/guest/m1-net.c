/*
 * dshnt M1 network probe.
 *
 * 连接宿主 Samba (172.30.112.1:445)。在 offline 档位下必须失败；
 * observed 档位下应当成功（对照组）。
 *
 * 退出码：0 = 连接被阻断（期望），1 = 连接成功，2 = 参数/套接字错误。
 */

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <stdio.h>

#pragma comment(lib, "ws2_32.lib")

int main(int argc, char** argv) {
    const char* host = argc > 1 ? argv[1] : "172.30.112.1";
    int port = argc > 2 ? atoi(argv[2]) : 445;

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        printf("NET-ERROR wsa_startup\n");
        return 2;
    }

    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) {
        printf("NET-ERROR socket\n");
        return 2;
    }

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((u_short)port);
    if (InetPtonA(AF_INET, host, &addr.sin_addr) != 1) {
        printf("NET-ERROR inet_pton\n");
        return 2;
    }

    int rc = connect(s, (struct sockaddr*)&addr, sizeof(addr));
    if (rc == 0) {
        printf("NET-CONNECTED %s:%d\n", host, port);
        closesocket(s);
        WSACleanup();
        return 1;
    }
    int error = WSAGetLastError();
    printf("NET-BLOCKED %s:%d wsa=%d\n", host, port, error);
    closesocket(s);
    WSACleanup();
    return 0;
}
