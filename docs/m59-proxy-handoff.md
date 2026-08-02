# Driving a Meridian client

The goal: watch a character in a real client, in first person, while it is played for
you — and be able to take the controls back at any moment.

**This works now, and not the way the earlier version of this document said.** That
version described driving the character by writing packets at a proxy. Three
separate designs were tried; the one that survives is the one where the *client*
does the moving and we only tell it what a keypress would have told it.

```
node tools/m59-fleet.mjs spec s4                  launch a client as a bot's character
powershell -File tools/m59-inject.ps1             put the agent in every running client
node tools/m59-pilot.mjs list                     who is running, and where
node tools/m59-pilot.mjs --port 8913 travel 568   drive one
```

---

## The architecture

`tools/m59-agent/m59agent.c` is a DLL injected into each client. The client exports
the three functions that matter, so the agent does not have to reconstruct anything:

| export | what it gives |
|---|---|
| `PerformAction` | what `HandleKeys` calls once it has decided what a key *means* |
| `ToServer` | the client's own protocol send, on its own connection and security stream |
| `GetPlayerInfo` | `&player`, so position is a read rather than a search |

`ToServer` is the important one. It means anything a player can do — `stand`, `rest`,
`say`, `yell`, a move — goes down the client's own socket with the client's own
security, so there is no proxy, no seed arithmetic and no second idea of the
character's state to drift out of sync.

**Thread safety is the design, not a detail.** `PerformAction` and `ToServer` touch
game state, a shared send buffer and the socket, and both expect to be on the thread
that owns the window — that is where the client calls them from. The agent's socket
thread never calls them. It hands the request to the window with
`SendMessageTimeout`, so the work happens inside the client's own message pump, on
its own thread, at a moment the client chose. Reading position is the exception:
`GetPlayerInfo` just returns `&player` and reading a few ints is harmless anywhere.

**One agent per client.** Each DLL binds the first free port in 8913–8928 and reports
its own port and pid. `bind()` *is* the arbitration — no registry, nothing to keep in
sync — and sweeping the range is how `m59-pilot.mjs list` discovers who is running.
Two clients walking different characters in different rooms at the same time is
verified.

### The pieces

| file | what it does |
|---|---|
| `tools/m59-agent/m59agent.c` | the injected DLL. `pos` / `act N` / `hold N MS` / `usercmd N` / `say` / `yell` / `move R C` / `refresh` |
| `tools/m59-inject.ps1` | injects into every running client; re-execs itself 32-bit |
| `tools/m59-pilot.mjs` | the controller: `list`, `pos`, `goto`, `travel`, `stand`, `rest`, `say`, `unstick` |
| `tools/m59-fleet.mjs` | the roster, and `spec <agent>` to launch a client straight into a character |

Build the DLL (32-bit, to match the client):

```
cl /LD /O2 /MT m59agent.c /link /OUT:m59agent.dll ws2_32.lib user32.lib
```

---

## Three designs that failed, and why

Worth keeping, because each failed for a reason that is not obvious until it does.

### 1. Forging packets at a proxy

The proxy owns both directions, so it can inject `BP_REQ_MOVE` to the server *and*
forge the matching `BP_MOVE` back to the client — and the client obeys it, because
`moveobj.c:86` has an explicit "Player moves specially" branch. It works, and it
crashes the client.

A forged position is a coordinate **we** chose being handed to `GetFloorBase(x, y)`,
which indexes the current room's floor grid. Anything the room cannot contain reads
off the end of it. Three dumps, all `ACCESS_VIOLATION` reading the same fixed
`0x994000` from different call sites. The worst case is a room transition, where the
new room's arrival square gets forged to a client still rendering the old room — the
Yonder Inn is 10×14 and it was handed row 42.

There is a second, quieter problem: **the screen is not evidence**. We generate the
picture, so a move the server rejected still looks like a move. Confirming a driven
walk by looking at it is circular.

### 2. Synthetic keystrokes

Two independent blockers, and patching one does not help.

- `HandleKeys` returns early unless `GetFocus() == hMain` (`key.c:184`).
- It reads `GetKeyboardState`, which Windows only maintains for the thread attached to
  the **foreground** input queue, and `SendInput` delivers to the foreground.

So keys cannot reach a background client at all, and taking focus takes the user's
keyboard with it. `PostMessage(WM_KEYDOWN)` does nothing for movement, because
movement is polled rather than message-driven.

### 3. Splitting the transport

Movement locally, everything else through the proxy. It works and it is still wrong:
one character's control lives in two places with two ideas of its state, and the
proxy's copy is the one that goes stale. `ToServer` removes the reason to do it.

---

## Facts, measured rather than assumed

- **`FINENESS` is 1024** client units per square (`drawdefs.h:42`); kod's own space is
  64 (`KOD_FINENESS`). Server rows/cols are 1-based, so the centre of (row, col) is
  `((col-1)*1024 + 512, (row-1)*1024 + 512)`, and `col = (x >> 10) + 1`.
- **Wire coordinates** are kod fine units plus `KOD_FINENESS`, which for the centre of
  a 1-based row comes out at exactly `row * 64 + 32`.
- **`NUMDEGREES` is 4096**, the same as the server's `MAX_ANGLE`, so no conversion is
  needed. Angle 0 lies along +x and increases toward +y; `dx = d·cos θ, dy = d·sin θ`.
- **Bearing checks out.** Where the character moved freely, travel direction matched
  `player.angle` to 1–6°. Where it did not, the actual direction was *exactly* 180.0°
  or 270.0° — axis-aligned, i.e. sliding along a wall. If the facing looks wrong,
  suspect the waypoint, not the arithmetic.
- **`player_info`** (`game.h:31-54`) is `id, name_res, icon_res, room_id, room_res,
  room_name_res, room_security, x, y, angle, ...` — all 4-byte, so `id` at +0,
  `room_id` at +12, `x` at +28, `y` at +32, `angle` at +36.
- **Action codes**, counted off `intrface.h:60-93`: `A_GO` 15, `A_FORWARD` 31,
  `A_BACKWARD` 32, `A_SLIDELEFT` 33, `A_SLIDERIGHT` 34, `A_TURNLEFT` 47,
  `A_TURNRIGHT` 48.
- **Turn rate is not a constant.** Measured between 0.48 and 0.72 angle units per ms
  across sessions on the same character, so the pilot measures it at startup with one
  small turn and derives the direction of increase at the same time.
- **Key bindings live in `config.ini`**, not `meridian.ini`, under `[keys]`:
  `forward=w`, `left`/`right` to turn, `slideleft=a`. `classickeybindings=true`
  discards the whole section for the old table. Nothing should assume WASD.

---

## Traps

Ordered by how much time each cost.

1. **Resting blocks movement, and looks exactly like being wedged.** Turning works,
   walking does not, in every direction. There is no client-side flag to read for it;
   the signature *is* the diagnosis. `usercmd 6` (`UC_STAND`) fixes it.

2. **A server-side move can strand a character.** The server does not check walls —
   `ReqSomethingMoved` is only called for monsters and dropped items, and its own
   comment says user moves "have already been checked by client (HAHA!)". So an admin
   teleport, or any of the earlier tooling here, can put a character somewhere the
   *client* will not let it walk out of. It is not stuck against a wall, it is on the
   wrong side of one, and no amount of steering fixes it.

   The way out is a pair, and `m59-pilot.mjs unstick` is exactly this: move
   server-side to an open square, then request room contents. The room load carries
   our own object and `SetRoomInfo` re-reads position from it
   (`game.c:372-382`), so the client stops believing the old spot.

3. **Walls are segments, not squares.** Both grids are one byte per square and a wall
   cuts across squares at an arbitrary angle. Routing on squares aims the character at
   places it cannot reach in a straight line, and the client *slides* along the wall
   rather than stopping — which from outside looks like a bot walking into a wall.
   `room.roo.walls` holds the real segments as `[x0, y0, x1, y1, flags]` in client
   FINENESS units, the same space as `player.x/y`, with bit 0 of flags meaning
   passable. Test steps against those.

4. **The `.roo` move grid is unreliable in both directions.** Treat it as binding and
   A\* refuses routes that plainly work — at (6,9) in the Yonder Inn its mask offers no
   way south, and the square west of it no way west, so a square seven steps across an
   open room came back "no route". Ignore it and A\* plots through the bar counter in
   the Limping Toad. It is a *preference*: legal steps cost 1, forbidden steps cost 12.

5. **Room objects are not in the geometry at all.** A bar counter is an object with
   `MOVEON_NO`, so neither grid records it and the pathfinder cannot know. The pilot
   learns them by walking into them: a square that stops it goes into a per-run
   blocked set and the next plan routes around. Note the goal square itself can be the
   blocked one — blaming it deletes the destination, so stopping beside an occupied
   square counts as arriving.

6. **Injected queries have UI side effects on a spectated client.** The proxy is a
   passthrough server→client, so the *answer* to anything it asks is delivered to the
   human's client too — which never asked for it. An unsolicited room-contents reply
   gets routed to whichever loaded module will take it, and a buy panel and a
   "Newsgroup: `<Unknown>`" window open by themselves. Confirmation must be built from
   things the server was going to send anyway.

7. **Opcode 134 is ambiguous once modules load.** It is `BP_ROOM_CONTENTS` at login
   and parses cleanly; later, one arrived carrying a player name
   (`86 | 24 1c 00 00 | 61 42 0f 00 | 05 00 | "Osric"`). `merintr` and `mailnews`
   share the opcode space. A room change does **not** push a `BP_ROOM_CONTENTS` at
   all — the burst after `BP_REQ_GO` carries op 191, still undecoded. None of this
   matters now: `player.room_id` from `pos` is the arrival confirmation.

8. **Object ids are renumbered by `save game`.** A character was 7225 and then 7221
   in the same session. Nothing may cache one, including the room objIds in
   `substrate/m59-map.json` — rebuild it with `m59-map.mjs build` if `roomOf` starts
   failing.

9. **The client resolves `resource\` relative to the working directory.** Launching
   `Meridian.exe` from anywhere else means it cannot load the module DLLs it is told
   to load, and it takes an access violation shortly after `BP_LOAD_MODULE` — which
   reads as a stall, because the last thing on the wire is a healthy ping exchange.
   Launch it with `cwd` set to its own folder.

10. **The injector must be 32-bit.** `LoadLibraryA` is the remote thread's entry point
    and its address has to be valid *in the target*; kernel32 sits at a different base
    for 64-bit processes. `m59-inject.ps1` re-execs itself under SysWOW64 PowerShell.

11. **The DLL cannot be rebuilt while it is loaded.** The linker cannot open it. Stop
    the clients first; there is no reload short of restarting them anyway.

12. **PowerShell 5.1 reads `.ps1` as ANSI without a BOM.** An em dash in a comment
    corrupts a later string literal and the script fails to parse somewhere unrelated.
    Write these files UTF-8 **with** BOM.

13. **`/Q` (quickstart) auto-picks a character only when the account has exactly one**
    and its flags are not 1 (`module/char/charpick.c:78`), and every login error path
    clears the flag. It is not a general "log me straight in".

---

## What the proxy is still for

`tools/m59-proxy.mjs` is no longer on the driving path, but it is the only way to see
the wire, and its hard-won parts are still correct:

- **The "crc16" is not a CRC-16.** It is `zlib.crc32(buf) & 0xffff` — confirmed in the
  source, where `GetCRC16` is literally `GetCRC32(buf, length) & 0xffff`
  (`util.c:651`). A hand-rolled CCITT CRC-16 produces a plausible wrong number that
  looks exactly like a stream-position error. The tell: a wrong position still lines
  up occasionally, a wrong hash never does.
- **`seeds_hacked` is a one-shot latch** — one bad value hangs the session up, so
  there is exactly one attempt per connection. Never calibrate by sending. The proxy
  solves for the stream from packets the client is already sending, which costs
  nothing and re-verifies continuously.
- **The opcode byte in the checksum is sign-extended** (`msg.data` is `char`), so any
  opcode ≥ 128 — `BP_USERCOMMAND` (155) is the one that matters — differs by exactly
  `0xF000` if computed from an unsigned byte, and the server hangs up.

Use it with `--observe` to watch a session without any risk of injection.

---

## Next

- Wire the pilot into the broker so `travel`/`fight` pick the local transport when the
  character is running in a client here, and the ordinary protocol client otherwise.
- Teach the pilot about room objects properly. It currently learns them by collision;
  the client already knows where they are and could report them.
- Decode op 191, the room data a transition actually pushes. Not needed for driving
  any more, but it is the last thing in the burst that is still a mystery.
