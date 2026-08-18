# Speaking Meridian 59's protocol

`tools/m59-client.mjs` logs into the game port as a real player character. No
Windows client, no admin socket, no GUI. Verified end to end: `LOGINOK` →
`GETCHOICE` → `GAME`.

This matters because it is the difference between a puppet and a player. A body
driven over the admin socket has no session, bypasses the game's own rules, and
can only be driven from loopback. A protocol client holds a genuine session: the
the broker validates its movement like the official client, it perceives exactly what a player perceives, and
it can connect from anywhere.

```bash
node tools/m59-client.mjs agent1 agentpass1 [host] [port]
```

## Sources of truth

`doc/login.txt` and `doc/protocol.txt` are useful but **stale in two places that
both fail silently**. When they disagree with code, the code wins:

| | authority |
|---|---|
| framing sizes | `clientd3d/server.h` — `HEADER_SIZE = 2*LENBYTES + CRCBYTES + 1` = 7 |
| checksum | `blakserv/session.c` — `GetCRC16BufferList` |
| message field layouts | `clientd3d/protocol.c` — `login_msg_table` |
| opcodes | `include/proto.h` |
| password encoding | `clientd3d/login.c` + `util/md5.c` |
| version constants | `clientd3d/client.h` |

## Framing

```
<len:2> <crc16:2> <len:2> <seqno:1> <payload>
```

Little-endian. Length is repeated as a sanity check — a mismatch is how the server
detects a desynchronised stream. `seqno` is 0 for `AP_*` messages and the GC epoch
for `BP_*`.

**Checksum** is a standard CRC-32 (init `~0`, final XOR `~0`) truncated to the low
16 bits — `blakserv/session.c:911`, `return (unsigned short)(0xffff & crc32)`.
In Node that is exactly `zlib.crc32(buf) & 0xffff`. The 2-byte CRC field misleads;
there is no CRC-16 polynomial anywhere in this codebase.

**Strings** are `<len:2>` then the bytes, **not** null terminated.

## Do not send the sync strings on connect

This cost the most time. `clientd3d/statstrt.c` defines a three-way raw byte
exchange, and `doc/login.txt` presents it as the login handshake:

```
client -> 1 255 66 76 65 75 10 13 2
server -> 3 251 98 108 97 107 10 13 1
client -> 7 230 98 108 97 107 10 13 8
```

**A new connection must send none of it.** `blakserv/async.c:241` puts a fresh
session directly into `STATE_SYNCHED`, which expects framed messages immediately,
and the server opens the conversation itself with `AP_GETLOGIN`. Those strings are
for **re**-synchronising after a stream error (`blakserv/trysync.c`).

Send `client_string1` on a new connection and it gets parsed as a frame header —
`len` 65281 against `len2` 19265 — which fails the length check and earns an
immediate `AP_RESYNC`. The stream is poisoned before login is even attempted.

So: connect, send nothing, wait for `AP_GETLOGIN`.

## AP_LOGIN

`doc/login.txt` describes the fields loosely. `clientd3d/protocol.c` is exact:

```
BYTE BYTE          major rev, minor rev            (7, 37 — client.h)
INT x5             platform, os major, os minor, memory, chip
WORD x2            screen width, screen height
INT x3             colour depth, bandwidth, reserved
STRING             username
STRING             password  (see below)
```

36 bytes of sysinfo. The values barely matter — zeros work — but the **shape** must
be exact.

## The password is MD5'd, with a twist

`clientd3d/login.c:69` calls `MDString(config.password, buf)`. That is a raw
16-byte MD5 digest (`ENCRYPT_LEN`, `include/md5.h`), sent as a string.

Then `util/md5.c:311` does something you would never guess:

```c
// Set 0 bytes to 1 to avoid NULL-termination problems
for (i = 0; i < ENCRYPT_LEN; i++)
   if (digest[i] == 0)
      digest[i] = 1;
```

**Every zero byte in the digest becomes 1.** Omit this and logins fail
intermittently — only for passwords whose MD5 happens to contain a zero byte,
which is roughly 1 in 16. It would look like a flaky server.

```js
const d = crypto.createHash('md5').update(pw, 'latin1').digest();
for (let i = 0; i < d.length; i++) if (d[i] === 0) d[i] = 1;
```

## AP_REQ_GAME needs three fields, not one

`doc/login.txt` says `<AP_REQ_GAME> <time>`. `protocol.c` says
`INT, INT, STRING`. Sending only `<time>` produces **no error at all** — the
session sits in the main menu forever, having received `GETCHOICE`, looking as
though login half-worked.

```
INT     download_time      (0 is fine)
INT     encodednum
STRING  hostname
```

`encodednum` is a version handshake, `login.c:224`:

```
encodednum = ((MAJOR_REV * 100 + MINOR_REV) * P_CATCH) + P_CATCH
```

`P_CATCH = 3` (`client.h:68`), so for 7.37 it is `737 * 3 + 3` = **2214**. It must
be computed; a stub is rejected.

## Sequence that works

```
connect
                  <- AP_GETLOGIN   (21)
AP_LOGIN     ->
                  <- AP_LOGINOK    (23)
AP_REQ_GAME  ->
                  <- AP_GETCHOICE  (22)
                  <- AP_CREDITS    (30)
                  <- AP_GAME       (25)   in game
```

## Game mode: the security stream

**This is the hard gate, and it is invisible.** In game mode the header's "crc16"
field is not a checksum — it is an anti-spoof value derived from a per-session
pseudo-random stream (`blakserv/game.c:174`):

```c
security  = GameRandomStreamsStep(s);   // unsigned short — truncates to 16 bits
security ^= msg.len;
security ^= (msg.data[0] << 4);
security ^= GetCRC16(msg.data, msg.len);
if (msg.crc16 != security) { s->seeds_hacked = true; /* drop */ }
```

Get it wrong and the server logs `found invalid security account N`, sets
`seeds_hacked`, and closes the connection **without telling the client anything**.
The symptom is a session that reaches game mode and then dies on its first
request.

The direction matters: **server→client frames use a plain CRC; client→server
frames must use the security value.** That asymmetry is why a naive parser reads
inbound traffic perfectly and still cannot send.

**The seeds arrive in `AP_GETCHOICE`** (`blakserv/synched.c:SynchedSendMenuChoice`).
That message is not just "you are at the main menu" — it carries five 32-bit
seeds, and the observed 21-byte payload is exactly 1 opcode + 5×4.

```c
for (i = 0; i < SEED_COUNT; i++)            // SEED_COUNT = 5
   seeds[i] = (seeds[i] * 9301 + 49297) % 233280;
stream = seeds[SEED_COUNT - 1] % (SEED_COUNT - 1);
return seeds[stream];
```

Unsigned 32-bit wraparound happens **before** the modulus, and the initial seeds
are arbitrary 32-bit values, so the first step really does overflow. In JS,
`seed * 9301` stays under 2^45 and is exact in a double, so an explicit
`% 4294967296` reproduces C faithfully without BigInt.

Step exactly once per message sent, or the streams diverge permanently.

## The epoch must be echoed

`clientd3d/com.c:409` — *"Save latest epoch byte for us to send in our messages."*
The seqno byte at header offset 6 of the most recent **inbound** frame must be
copied into every outbound frame. It is the garbage-collection generation; the
server drops messages from a previous epoch so that stale object ids cannot
corrupt its state.

## AP_* and BP_* opcodes overlap

`BP_WAIT` is 21 and `AP_GETLOGIN` is 21. `BP_UNWAIT` is 22 and `AP_GETCHOICE` is
22. Dispatch on **connection state**, never on the opcode byte alone, or a
mid-game message will make the client re-send its password.

## Getting into the world

The server does not start streaming on its own. After `AP_GAME` it sends
`BP_LOAD_MODULE` and waits — the real client loads `module/char`, whose init calls
`RequestCharacters()`.

```
                  <- BP_LOAD_MODULE      (58)
BP_SEND_CHARACTERS ->                    (45)
                  <- BP_CHARACTERS       (139)  count, then {id, name, flags}
BP_USE_CHARACTER  ->                     (46)  the chosen object id
                  <- BP_PLAYER           (130)  first field is our object id
                  <- BP_ROOM_CONTENTS, BP_PLAYERS, BP_STAT, ...
```

Only respond to the **first** `BP_LOAD_MODULE`. The server swaps UI modules
throughout play, and answering each one re-enters character selection in a loop.

## Actions

`blakserv/sprocket.c client_def_table` is the authoritative table: every `BP_*`
request with the exact byte width of each field and the kod message it invokes.
Prefer it over `doc/protocol.txt`. Widths matter — a `{1, TAG_INT}` is one byte on
the wire even though kod sees an integer.

```
BP_SAY_TO       {1,INT} type, temp string        1 say, 2 yell, 3 broadcast, 6 emote
BP_REQ_MOVE     {2,INT} Y {2,INT} X {1,INT} speed {4,OBJECT} room   <- Y FIRST
BP_REQ_ATTACK   {1,INT} info {4,OBJECT} target
BP_REQ_LOOK     {4,OBJECT}
BP_REQ_BUY      {4,OBJECT}          shopkeeper
BP_REQ_CAST     {4,OBJECT} spell {2,LIST} targets
BP_REQ_INVENTORY / SEND_ROOM_CONTENTS / SEND_PLAYERS / REQ_GO   no parameters
```

Object ids are masked with `& 0x0fffffff` on the wire — the top nibble is a
client-side type tag (`clientd3d/object.h`).

Corrections to that table, found by reading it properly:

- **`BP_REQ_MOVE` takes Y before X**, and the room id must be the room the character
  is actually in — `UserCommand` compares it to `poOwner` and `return`s silently if
  they differ (`user.kod:902`).
- **`BP_REQ_DROP` takes a LIST** (`{2, LIST_OBJ_PARM}`), not a single id.
- **There is no `BP_REQ_GIVE` in the table** despite the opcode existing. Handing
  something over is a two-sided trade: `BP_REQ_OFFER` proposes and
  `BP_ACCEPT_OFFER` answers.
- **`BP_USERCOMMAND` is a second dispatch table** (`usercommand_def_table`): one
  byte of sub-opcode then that command's own parameters. Resting, standing, the
  safety toggle and banking all live there, not in the main table.
- **`BP_REQ_GO`** takes no parameters and means "use the exit under my feet". It is
  how a character leaves an interior room; walking off the grid edge is how it
  leaves an outdoor one.

## BP_SAID

`clientd3d/server.c HandleSaid`:

```
sender id (4) | sender NAME RESOURCE (4) | say type (1) | message RESOURCE (4) | inline text
```

Both the name and the message are resource ids. Static strings live in the `.rsc`
files; only dynamic text such as player speech is appended inline. Missing the two
resource fields yields a plausible-looking parse with the type wrong and leading
garbage on the text, which is exactly how it first presented.


## Server messages are format strings, not text

Nothing the server says arrives as prose. `BP_MESSAGE`, `BP_SYS_MESSAGE`, the
description behind `BP_LOOK`, and every non-speech form of `BP_SAID` are a
**resource id used as a printf format string**, followed by parameters whose count
and widths are decided *entirely by the format string's fields*
(`clientd3d/srvrstr.c:CheckServerMessage`):

```
%%      literal percent, consumes nothing
%d %i   4 bytes, an integer, printed as-is
%s      4 bytes, a RESOURCE ID, replaced by its string
%q      2-byte length + bytes, a literal string from the server
```

There is no length prefix on the parameter block. **Without the resource table you
cannot even find where a message ends** — which is why the table is a prerequisite
for parsing, not a convenience for display.

Two details the C implementation makes load-bearing:

- **It loops.** A `%s` substitution can introduce further format fields, so the
  scan repeats until a pass finds no `%s`. Parameters for those nested fields come
  after the outer ones.
- **`%q` strings are protected across passes** by being rewritten to a low control
  byte, because a player-typed string could itself contain `"%s"`. Skip that and a
  player can make the parser read parameters that were never sent.

Text also carries two-character display codes introduced by `~` or a backtick
(`~r` red, `~n` normal). They are markup, not content — strip them for an agent.

## Perception: `BP_ROOM_CONTENTS`

`tools/m59-parse.mjs`. The layout, corrected against both sides of the wire:

```
room id (4) | count (2) | count × {
    ExtractObject
      id (4)
      amount (4)                ONLY IF top nibble == CLIENT_TAG_NUMBER
      icon resource (4)
      name resource (4)
      flags (4)
      rarity (4)
      ExtractDLighting          flags (2), then intensity (1) + colour (2)
                                ONLY IF flags != LIGHT_FLAG_NONE
      ExtractPaletteTranslation OPTIONAL, self-identifying — see below
      ExtractAnimation          1 byte type, then 2 / 8 / 10 more
      ExtractOverlays           1 byte count, then that many variable-length
    ExtractCoordinates          Y FIRST, then X, in kod fine units
    angle (2)
    ExtractPaletteTranslation   again, for the object in motion
    ExtractAnimation            again
    ExtractOverlays             again
}
```

Three things in there are easy to get wrong, and all three fail silently:

1. **`ExtractDLighting` is present.** `ExtractObject`'s `includeLight` parameter
   defaults to `true` (`clientd3d/server.h:48`) and `ExtractNewRoomObject` calls it
   with two arguments, so the lighting block is in the stream. Confirmed on the
   sending side: `ToCliObject` calls `@SendLightingInformation`, whose `Object`
   default is `AddPacket(2,0)` (`kod/object.kod:510`). Omitting it desynchronises
   every object after the first.
2. **`ExtractPaletteTranslation` is optional and rewinds.** It reads one byte; if
   that byte is neither `ANIMATE_TRANSLATION` (9) nor `ANIMATE_EFFECT` (10) it puts
   the byte back, because it belongs to the animation that follows. Consume it
   unconditionally and everything after shifts by one.
3. **Coordinates are Y then X**, in kod fine units — `row * 64 + offset`, rows
   1-based. `clientd3d/protocol.h:74` sends them the same way round, so a
   coordinate read from perception goes back out unchanged in `BP_REQ_MOVE`.

### The invariant is the only real test

The list is a **packed stream with no per-item length**. A sub-parser that consumes
one byte too few produces *plausible* output — sensible-looking ids and
coordinates, entirely fabricated. So use the check the C client uses
(`HandleRoomContents`, `clientd3d/server.c:672`):

> after parsing `count` objects, exactly zero bytes must remain

Every parser in `m59-parse.mjs` reports `exact`, and `M59Client` records a failure
rather than using a suspect parse. `tools/m59-perception-test.mjs` walks a character
through every room on the server and asserts it: **167 rooms, 1640 objects, 145
distinct things named, zero failures.**

## The resource table

`tools/m59-rsc.mjs`. The format (`util/rscload.c`) is trivially simple:

```
"RSC\x01"       4-byte magic
version         4, must be 4
num_resources   4
num_resources × [ id (4) | NUL-terminated string ]
```

Strings are **latin1**, not UTF-8 — the files contain 0x92-style curly quotes that
UTF-8 decoding turns into U+FFFD. 1137 files yield 10,576 strings, ids 20001–30576
with no gaps and no collisions, cross-checked byte-for-byte against
`bin/rscprint.exe`.

**Dynamic resources are not in any file.** Ids at or above `MIN_DYNAMIC_RSC`
(1,000,000, `blakserv/blakserv.h:94`) are player and guild names, created at
runtime. Two ways a session learns them, and it needs both:

- `BP_CHANGE_RESOURCE` (30) — pushed to every live session when one is created or
  changed (`blakserv/blakres.c:DynamicResourceChangeNotify`)
- `BP_PLAYERS` (136) — carries each logged-on player's name **inline as a string**,
  because kod sends it with width `STRING_RESOURCE` which writes the resolved text
  rather than the id (`blakserv/commcli.c:92`). Feed these into the table and other
  players become nameable in room contents.

## Stats live in a module, not in clientd3d

`BP_STAT` and `BP_STAT_GROUP` have no handler in `clientd3d/` — stats are a UI
module, so the authority is `module/merintr/merintr.c:ExtractStatistic`. Two traps:

- a stat's `name_res` is **not** its name. It is a bitmap filename: kod declares
  `user_stat_health = heal.bgf`. Stats are identified only by their
  `(group, slot)` position, from `User.ToCliStats`. Group 1 is health/mana/vigor,
  group 2 the attributes, 3 and 4 the spell and skill ability levels.
- the integer form carries **four** numbers — `value, min, max, current_max` — and
  kod sends health as `(piHealth, 0, 100, piMax_health)`. `max` is a fixed display
  scale; the real ceiling is `current_max`. Read `max` and every character appears
  to have 100 hit points.

`BP_SEND_STATS` takes a group in 1..4. Group 0 logs "Invalid stat group number" and
sends nothing at all.

## Where this is up to

**All of the above is working and verified against a live server.** An agent logs
in, sees the room with names and coordinates, walks, turns, fights, shops, talks and
listens. `tools/m59-broker.mjs` exposes it over MCP.

What the protocol work does *not* answer is what the server will let a character
*do* — range, facing, the three silent rate limits, how a character gets stronger.
That is the kod's business, and it is in `docs/m59-agent-primer.md`.
