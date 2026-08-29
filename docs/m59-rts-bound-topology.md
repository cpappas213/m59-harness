# Bound RTS room topology

The bound RTS profile lets an owner-local viewer prove that one live Meridian
room observation, one rendered ROO scene, and one static topology room belong to
the same frozen map generation. It is additive: legacy `M59RTS/7`,
`M59ROOM/2`, their endpoints, and `M59SUB 1` retain their existing bytes.

This is a consistency boundary, not authentication or command authority. The
server supplies the current `BP_PLAYER` resource IDs and 32-bit room-security
checksum. The configured local map supplies the stable room number, filename,
dimensions, geometry, exits, and SHA-256 identities. The checksum is a stock
client compatibility value, not a cryptographic signature; the hashes identify
local bytes but do not authenticate the gateway or game server.

## One frozen startup generation

`AtlasMapGeneration` strictly reads `substrate/m59-map.json` once, verifies the
stored geometry manifest, and canonically compiles `M59ATLAS/1`. The generation
retains immutable room sources and these identities:

```text
geometry-manifest-sha256
topology-records-sha256
atlas-artifact-sha256
M59ATLAS/1:<geometry>:<topology>:<artifact>
```

Compilation is bounded, duplicate-key rejecting, deterministic across object
insertion order, and byte-wise UTF-8 canonical. `ROOM`, raw `EDGE`, and raw `GO`
records keep their source array order. The artifact endpoint serves only the
complete frozen bytes selected by the exact lowercase artifact hash; it never
recompiles, redirects, compresses, or negotiates another generation.

The checked-map hashes and counts are regression fixtures, not product
constants:

```text
rooms                     264
EDGE                      280
GO                        1063
bytes                     58168
geometry                  45c33b6979cf02ba5b7a742b26bc559b6f464d28eaead736475d4dd65aa95f9c
topology                  6e000561e772bef4f409e72b187b2e416df8ab088b6f26fda7bfacd4bc110077
artifact                  b07950b3d7859b75deb36c3d81a0edc4e9930e3f40ac3a5b753547d7d70480c3
```

## Live room tuple and snapshot v8

The parser already retains `roomRsc`, `roomNameRsc`, and `room.security` from
one `BP_PLAYER`. Bound resolution requires a unique frozen-map row matching both
resource IDs. This matters because the public map contains duplicate nonzero
`roomRsc` values; resource ID alone is not a unique join. Missing, zero,
out-of-range, or ambiguous tuples fail closed. Runtime room object ID, display
name, and the legacy first-match resolver are never used.

`World`, keeper `/state`, keeper `/room-view`, and the render projection carry
the exact closed value:

```json
{
  "resolved_room_num": 544,
  "room_resource_id": 12345,
  "room_security_u32": 2345678901
}
```

Keeper state and render clocks must agree before the aggregate publishes this
tuple. During a transition, the legacy view may remain available, but the bound
tuple and bound room resource are withheld with a diagnostic note.

`m59-rts/v2` / native `M59RTS/8` requires one tuple per requested `AGENT` and
inserts its `ROOM_WIRE` record immediately after that agent. Every requested
agent must survive projection, and agents merged into one room must agree on the
complete tuple. The frozen map may validate the tuple and supply local filename
and dimensions; it may not repair or invent a missing server value.

## Scene v3

`m59-rts-scene/v3` retains the v2 geometry records and adds exactly one binding
record immediately after its header:

```text
M59ROOM 3 ...
M59BIND 1 M59ATLAS/1 geometry topology artifact room_count \
  room_resource_id room_resource_symbol static_token_kind static_token \
  roo_security_u32
```

Native text is tab-delimited and byte-wise RFC 3986 percent encoded. The JSON
binding schema is `m59-rts-atlas-binding/v1`. The binding includes all three
hashes, room count, exact numeric/symbol resources, selected static token, and
full unsigned security value. Every bound scene first selects a strict local ROO
candidate in configured directory order and verifies its exact filename,
dimensions, and format. A `roo-security-u32` token requires the complete local
security value to match; it deliberately does not compare the frozen collision
digest, because that digest may include movement graph-entry and edge-direction
provenance. A `collision-sha256` token instead requires the exact local collision
digest and derives the mandatory full security value from that matched ROO. Only
after this verification may cached baked geometry be trusted; when baked surfaces
are absent, the matched strict local projection supplies them.

An unknown room is 404, malformed selection is 400, a known but conflicting
binding is 409, and unavailable validated geometry is 503. No failure returns a
v2 payload under the v3 path. The legacy v2 route deliberately retains its
historical `version=1` media label; v3 uses the correct versioned media type.

## Acceptance and transitions

A consumer attaches topology only after all of these agree exactly:

1. accepted v8 agent, room, and `ROOM_WIRE` room numbers;
2. wire, scene-binding, and atlas numeric room resources;
3. full wire and scene unsigned security values;
4. snapshot, scene, and atlas filename and dimensions;
5. atlas resource symbol and static token;
6. geometry, topology-record, complete-artifact hashes, and room count;
7. a completely parsed bounded scene and atlas artifact.

Snapshot `EXIT` rows are volatile observations and never modify static atlas
topology. A hash match does not reveal a room, mark fog as discovered, establish
player-legitimate visibility, or enable an order.

For persistent native transport, `M59SUB 2` owns the v8 profile while framing
remains `M59FRAME 1`. Profile-aware reconciliation builds v7 and v8 independently
from cached aggregate reads: a bound-profile failure is not a reason to suppress
the legacy generation, and a profile-2 channel never receives v7. Consumers must
retain the prior room as stale while a new tuple/scene is incomplete, reject
late bytes for the old tuple, and adopt a different map build only after the
complete new atlas artifact validates.

## Offline regression gates

The implementation is covered without a live broker, roster, or Meridian
socket by:

```powershell
node tools/m59-atlas-topology-test.mjs
node tools/m59-room-wire-test.mjs
node tools/m59-render-test.mjs
node tools/m59-world-perception-test.mjs
node tools/m59-rts-contract-v8-test.mjs
node tools/m59-rts-generation-test.mjs
node tools/m59-roo-bounded-test.mjs
node tools/m59-rts-scene-v3-test.mjs
node tools/m59-rts-atlas-endpoint-test.mjs
node tools/m59-rts-stream-v2-test.mjs
node tools/m59-rts-gateway-v3-test.mjs
```

These tests exercise canonical hashes, resource collisions, transition-clock
disagreement, native record order, content-addressed queries, media/status
behavior, no-downgrade rules, and v7/v2 compatibility. Installing the producer
changes still requires a separately scheduled broker/gateway restart; these
offline tests neither contact nor move a fleet.
