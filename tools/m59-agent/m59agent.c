/*
 * m59agent.dll - injected into a Meridian client to drive it from outside, without
 * focus, without touching the real keyboard, and without a proxy in the path.
 *
 * WHY THIS EXISTS
 *
 * Three earlier approaches failed, each for a structural reason worth recording.
 *
 * 1. Forging BP_MOVE at a proxy. The client obeys it, but a forged position is a
 *    coordinate WE chose being handed to GetFloorBase(x,y), which indexes the current
 *    room's floor grid. Anything that room cannot contain reads off the end of it:
 *    three crash dumps, all ACCESS_VIOLATION at a fixed 0x994000.
 *
 * 2. Synthetic keystrokes. HandleKeys polls GetKeyboardState and returns early unless
 *    GetFocus() == hMain (clientd3d/key.c:184). Two independent blockers, not one:
 *    even with the focus check patched, GetKeyboardState only reflects input for the
 *    thread attached to the foreground queue, and SendInput goes to the foreground.
 *    Keys cannot reach a background client at all, and taking focus takes the user's
 *    keyboard with it.
 *
 * 3. Injecting protocol at a proxy for everything that was not movement. It works,
 *    but it splits one character's control across two transports with two different
 *    ideas of its state, and the proxy's copy is the one that goes stale.
 *
 * All three were reconstructing, badly, decisions the client already makes. It
 * exports the functions that make them:
 *
 *     PerformAction   what HandleKeys calls once it knows what a key MEANS
 *     ToServer        the client's own protocol send, on its own connection and
 *                     its own security stream - so no proxy, no seeds, no rewriting
 *     GetPlayerInfo   &player, so position needs no memory scanning
 *
 * THREAD SAFETY, WHICH IS THE WHOLE DESIGN
 *
 * PerformAction and ToServer touch game state, a shared send buffer and the socket,
 * and both expect to be on the thread that owns the window - that is where the client
 * calls them from. Our socket thread never calls them. It hands the request to the
 * window via SendMessageTimeout, so the work happens inside the client's own message
 * pump, on its own thread, at a moment the client chose. Sending rather than posting
 * also means the argument struct stays alive for exactly as long as it is needed.
 *
 * Reading position is different: GetPlayerInfo just returns &player, and reading a
 * few ints out of it is harmless from any thread, so that answers directly.
 *
 * ONE AGENT PER CLIENT
 *
 * Meridian runs several copies at once quite happily, so the agent must too. Each
 * instance takes the first free port in a small range and reports which one it got;
 * a controller finds them by sweeping the range and asking each one who it is. There
 * is deliberately no shared state between instances.
 *
 * Build (32-bit, to match the client):
 *   cl /LD /O2 /MT m59agent.c /link /OUT:m59agent.dll ws2_32.lib user32.lib
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winsock2.h>
#include <stdio.h>

#define PORT_BASE  8913
#define PORT_COUNT 16

/* From include/proto.h. */
#define BP_SEND_ROOM_CONTENTS 42
#define BP_REQ_MOVE      100
#define BP_SAY_TO        110
#define BP_USERCOMMAND   155
#define SAY_NORMAL         1
#define SAY_YELL           2

/* Wire coordinates are kod fine units plus KOD_FINENESS, which for the centre of a
 * 1-based row or column comes out at exactly n*64 + 32 (clientd3d/protocol.h:74). */
#define WIRE_CENTRE(n)   ((n) * 64 + 32)

/* player_info, clientd3d/game.h:31-54. Only the head is needed; the ABI fixes it. */
typedef struct {
    int id, name_res, icon_res, room_id, room_res, room_name_res, room_security;
    int x, y, angle;
} player_head;

typedef void  (__cdecl *PerformAction_t)(int action, const void *data);
typedef void  (__cdecl *ToServer_t)(BYTE type, void *table, ...);
typedef void *(__cdecl *GetPlayerInfo_t)(void);

static PerformAction_t pPerformAction;
static ToServer_t      pToServer;
static GetPlayerInfo_t pGetPlayerInfo;
static HWND     gMain;
static WNDPROC  gOldProc;
static UINT     gMsg;
static int      gPort;

enum { K_ACTION = 1, K_USERCMD, K_SAY, K_YELL, K_MOVE, K_REFRESH };
typedef struct { int kind; int arg; int arg2; const char *text; } Req;

/* Runs on the CLIENT's thread, out of its own message pump. */
static LRESULT CALLBACK AgentProc(HWND h, UINT m, WPARAM w, LPARAM l)
{
    if (m == gMsg) {
        Req *r = (Req *)l;
        switch (r->kind) {
        case K_ACTION:  if (pPerformAction) pPerformAction(r->arg, NULL); break;
        /* ToServer pulls the BP_USERCOMMAND sub-opcode straight out of the varargs
         * (protocol.c:176-183), so rest/stand/safety go through here. */
        case K_USERCMD: if (pToServer) pToServer(BP_USERCOMMAND, NULL, r->arg); break;
        case K_SAY:     if (pToServer) pToServer(BP_SAY_TO, NULL, SAY_NORMAL, r->text); break;
        case K_YELL:    if (pToServer) pToServer(BP_SAY_TO, NULL, SAY_YELL,   r->text); break;

        /* UNSTICKING, and nothing else.
         *
         * Telling the server where we are is normally the client's job and doing it
         * ourselves is what created the mess this design replaced. It is kept for one
         * case: a character standing somewhere it cannot legally walk out of, because
         * something moved it server-side past the client's collision check. An admin
         * teleport does that, and so did every earlier version of this tooling.
         *
         * On its own a move here would only desync further - the server would agree
         * and the client would not. K_REFRESH is the other half: BP_SEND_ROOM_CONTENTS
         * comes back as a room load, and SetRoomInfo re-reads the player's own
         * position out of it (clientd3d/game.c:372-382). Move, then refresh, and both
         * sides agree again. */
        case K_MOVE:
            if (pToServer && pGetPlayerInfo) {
                player_head *p = (player_head *)pGetPlayerInfo();
                if (p) pToServer(BP_REQ_MOVE, NULL, WIRE_CENTRE(r->arg),
                                 WIRE_CENTRE(r->arg2), 18, p->room_id);
            }
            break;
        case K_REFRESH: if (pToServer) pToServer(BP_SEND_ROOM_CONTENTS, NULL); break;
        }
        return 0;
    }
    return CallWindowProc(gOldProc, h, m, w, l);
}

/* Blocking, with a timeout, so a wedged client cannot hang the controller. */
static BOOL Dispatch2(int kind, int arg, int arg2, const char *text)
{
    Req r; DWORD_PTR unused;
    r.kind = kind; r.arg = arg; r.arg2 = arg2; r.text = text;
    return SendMessageTimeout(gMain, gMsg, 0, (LPARAM)&r,
                              SMTO_ABORTIFHUNG, 4000, &unused) != 0;
}
static BOOL Dispatch(int kind, int arg, const char *text)
{
    return Dispatch2(kind, arg, 0, text);
}

static BOOL CALLBACK FindMain(HWND h, LPARAM param)
{
    DWORD pid = 0;
    char cls[64];
    GetWindowThreadProcessId(h, &pid);
    if (pid != GetCurrentProcessId() || !IsWindowVisible(h)) return TRUE;
    GetClassNameA(h, cls, sizeof cls);
    if (strstr(cls, "Meridian") == NULL) return TRUE;   /* else a tooltip or dialog */
    *(HWND *)param = h;
    return FALSE;
}

static int Position(char *buf, int len)
{
    player_head *p;
    if (!pGetPlayerInfo) return _snprintf(buf, len, "{\"error\":\"no GetPlayerInfo\"}\n");
    p = (player_head *)pGetPlayerInfo();
    if (!p) return _snprintf(buf, len, "{\"error\":\"null player\"}\n");
    /* Client FINENESS is 1024 per square; server rows/cols are 1-based. */
    return _snprintf(buf, len,
        "{\"port\":%d,\"pid\":%lu,\"id\":%d,\"room\":%d,\"x\":%d,\"y\":%d,"
        "\"angle\":%d,\"col\":%d,\"row\":%d}\n",
        gPort, GetCurrentProcessId(), p->id, p->room_id, p->x, p->y, p->angle,
        (p->x >> 10) + 1, (p->y >> 10) + 1);
}

/* A held key produces one action per frame, so a hold is a repeat, not a duration. */
static void Hold(int action, int ms)
{
    DWORD end = GetTickCount() + (DWORD)ms;
    do { Dispatch(K_ACTION, action, NULL); Sleep(25); } while (GetTickCount() < end);
}

static void Serve(SOCKET c)
{
    char in[512], out[640], text[256];
    int n, a, ms;
    while ((n = recv(c, in, sizeof(in) - 1, 0)) > 0) {
        in[n] = 0;
        while (n > 0 && (in[n-1] == '\n' || in[n-1] == '\r')) in[--n] = 0;

        if (!strncmp(in, "pos", 3)) {
            n = Position(out, sizeof out);
            send(c, out, n, 0);
        } else if (sscanf(in, "hold %d %d", &a, &ms) == 2) {
            Hold(a, ms);
            send(c, "{\"ok\":true}\n", 12, 0);
        } else if (sscanf(in, "act %d", &a) == 1) {
            Dispatch(K_ACTION, a, NULL);
            send(c, "{\"ok\":true}\n", 12, 0);
        } else if (sscanf(in, "usercmd %d", &a) == 1) {
            Dispatch(K_USERCMD, a, NULL);
            send(c, "{\"ok\":true}\n", 12, 0);
        } else if (!strncmp(in, "say ", 4)) {
            lstrcpynA(text, in + 4, sizeof text);
            Dispatch(K_SAY, 0, text);
            send(c, "{\"ok\":true}\n", 12, 0);
        } else if (!strncmp(in, "yell ", 5)) {
            lstrcpynA(text, in + 5, sizeof text);
            Dispatch(K_YELL, 0, text);
            send(c, "{\"ok\":true}\n", 12, 0);
        } else if (sscanf(in, "move %d %d", &a, &ms) == 2) {
            Dispatch2(K_MOVE, a, ms, NULL);        /* a = row, ms = col */
            send(c, "{\"ok\":true}\n", 12, 0);
        } else if (!strncmp(in, "refresh", 7)) {
            Dispatch(K_REFRESH, 0, NULL);
            send(c, "{\"ok\":true}\n", 12, 0);
        } else if (!strncmp(in, "ping", 4)) {
            send(c, "{\"ok\":true}\n", 12, 0);
        } else {
            send(c, "{\"error\":\"pos|act N|hold N MS|usercmd N|say T|yell T|move R C|refresh|ping\"}\n", 76, 0);
        }
    }
    closesocket(c);
}

static DWORD WINAPI Worker(LPVOID unused)
{
    WSADATA wsa;
    SOCKET s, c;
    struct sockaddr_in a;
    HMODULE exe;
    int i;

    exe = GetModuleHandle(NULL);
    pPerformAction = (PerformAction_t)GetProcAddress(exe, "PerformAction");
    pToServer      = (ToServer_t)     GetProcAddress(exe, "ToServer");
    pGetPlayerInfo = (GetPlayerInfo_t)GetProcAddress(exe, "GetPlayerInfo");
    if (!pPerformAction || !pGetPlayerInfo) return 1;

    /* The window may not exist yet if we were injected during startup. */
    for (i = 0; i < 100 && !gMain; i++) {
        EnumWindows(FindMain, (LPARAM)&gMain);
        if (!gMain) Sleep(100);
    }
    if (!gMain) return 2;

    /* RegisterWindowMessage returns the same value in every process that asks for
     * this name, which is what we want: several clients, one message id, no clash. */
    gMsg = RegisterWindowMessageA("M59AgentRequest");
    gOldProc = (WNDPROC)SetWindowLongPtr(gMain, GWLP_WNDPROC, (LONG_PTR)AgentProc);

    if (WSAStartup(MAKEWORD(2, 2), &wsa)) return 3;
    s = socket(AF_INET, SOCK_STREAM, 0);
    if (s == INVALID_SOCKET) return 4;
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);   /* loopback only: this drives a character */

    /* First free port in the range. No coordination between instances is needed -
     * bind() is the arbitration, and whoever loses simply tries the next one. */
    for (i = 0; i < PORT_COUNT; i++) {
        a.sin_port = htons((u_short)(PORT_BASE + i));
        if (bind(s, (struct sockaddr *)&a, sizeof a) == 0) { gPort = PORT_BASE + i; break; }
    }
    if (!gPort) return 5;

    listen(s, 4);
    for (;;) {
        c = accept(s, NULL, NULL);
        if (c == INVALID_SOCKET) break;
        Serve(c);
    }
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID reserved)
{
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(h);
        CreateThread(NULL, 0, Worker, NULL, 0, NULL);
    }
    return TRUE;
}
