# Meridian 59 RTS gateway

`tools/m59-rts-gateway.mjs` is a loopback-only adapter for native strategy
clients. It is read-only by default. Its separately gated commander-control mode
attaches to the one broker already holding the explicitly named fleet; the gateway
never logs in a character, opens the roster, reads a password, or starts another
broker. `prod` is not name-blocked: production control is available through this
same loopback boundary when the operator explicitly enables writes and the exact
fleet, broker pid, game server, roster characters, bearer credential, and
short-lived commander lease all agree. PvE-only targeting remains unchanged.

```text
native client -> RTS gateway -> one broker aggregate GET -> cached M59 session state
                            \-> legacy HTTP MCP fallback (ungated read-only mode only)
```

The aggregate path is `GET /rts/v1/read` on the broker's own loopback socket. It
collects fleet metadata, cached render perception, cached server-observed
equipment, cached spells, and a bounded cached inventory in one pass through the
broker process. It does not submit anything to a session pacer and therefore
sends no Meridian packet. The endpoint accepts at most 40 simple agent names and
refuses responses over 8 MiB.

The broker endpoint remains loopback-only even if somebody deliberately exposed
the broader MCP socket with `M59_BIND`. Set `M59_RTS_READ_TOKEN` in both broker
and gateway environments to require a bearer token as a second local gate. A
configured read token makes the aggregate contract mandatory: every fetch
failure, non-success status, missing endpoint, and invalid response fails closed.
The gateway never responds to a token-gated read failure by downgrading to the
broader MCP surface. Legacy fallback remains available only for an ungated,
read-only gateway.

Run a one-shot read without starting a service:

```powershell
node tools/m59-rts-gateway.mjs --once --agents t1,t2
node tools/m59-rts-gateway.mjs --once --native --agents t1,t2
```

Or serve it on its default loopback port:

```powershell
node tools/m59-rts-gateway.mjs --port 8910 --fleet prod
```

For the competitive native client, request a 50ms reconciliation deadline:

```powershell
node tools/m59-rts-gateway.mjs --port 8910 --fleet prod --reconcile-ms 50
```

That request becomes effective only after the gateway has positively negotiated
`broker-aggregate-v1` and every current subscriber has latest-generation
backpressure (the native TCP stream does). An old broker, an SSE subscriber, or
a mixed native/SSE population keeps the former 100ms minimum. Values below 50
are clamped to 50; the default remains 250ms.

Measure the five-character read path without sending any game action:

```powershell
node tools/m59-rts-stream-benchmark.mjs --agents t1,t2,t3,t4,t5 --frames 25
```

The broker seam also has a reproducible offline transport benchmark. Its default
fixture carries five agents and 36 objects per agent through real loopback HTTP,
but opens no Meridian session:

```powershell
node tools/m59-rts-fastpath-benchmark.mjs --iterations 100
node tools/m59-rts-reconcile-benchmark.mjs --frames 30 --snapshot-ms 2
```

The second command measures the adaptive timer in three cases: aggregate/native
at 50ms, aggregate/ordinary-output at the 100ms safety floor, and legacy/native
at the 100ms safety floor. A fourth slow-legacy case deliberately overruns that
floor and verifies the post-read cooling interval. It also reports the maximum
simultaneous snapshot reads, which must remain one.

After a deliberately scheduled broker upgrade, measure the same read-only path
against the real broker with:

```powershell
node tools/m59-rts-fastpath-benchmark.mjs --broker http://127.0.0.1:8901 --fleet prod --agents t1,t2,t3,t4,t5
```

The offline result measures transport and serialization overhead; it does not by
itself prove the competitive production gate. The native stream benchmark is the
end-to-end p50/p95 gate.

The existing competitive-read gate for five characters remains a steady-state
frame interval of p50 <= 125ms and p95 <= 200ms, with no unbounded queue growth.
At a requested 50ms, benchmark only when `/health` reports an effective 50ms;
otherwise the safety downgrade is doing its job and the result is a 100ms-path
measurement. Event-driven combat/stat generations may arrive sooner than the
reconciliation deadline.

Reconciliation is single-flight. Timer deadlines advance from the preceding
deadline so Windows timer quantization does not accumulate as drift, but a slow
read is never overlapped by another read. Timer pressure is dropped, multiple
event requests collapse to one follow-up generation, and a blocked native socket
keeps only one newest pending frame. If a legacy or ordinary-output read overruns
its deadline, it receives a full effective interval before the next read; a slow
old broker is never driven continuously by a requested 50ms cadence.

`GET /health` reports `broker_read_path.mode` plus `reconciliation.requested_ms`,
`effective_ms`, `minimum_ms`, and `fast_eligible`. `broker-aggregate-v1` means
the single-read endpoint is active. `legacy-fallback` means the running broker
is older or the aggregate endpoint was transiently unavailable; compatibility
is retained at a minimum 100ms cadence.

Installing the broker half requires a broker process restart. Merely restarting
the RTS gateway cannot add an endpoint to the already-running broker. Treat that
as a scheduled fleet operation via `m59-service.mjs`; this implementation and its
offline tests do not restart or touch the production broker.

Routes:

- `GET /health` verifies the attached broker, expected fleet, and (when
  configured) whether commander control is presently armed. Write readiness requires
  a successful aggregate control-state read, not merely broker `/health`.
- `GET /v1/contract` describes current capabilities and the closed typed action
  catalogue. It also names destructive/economic families deliberately withheld
  until a prepare/commit confirmation protocol exists.
- `GET /v1/snapshot?agent=t1&agent=t2` returns `m59-rts/v1` JSON.
- `GET /v1/snapshot.tsv?agent=t1&agent=t2` returns the dependency-free native
  line format (currently native version 7).
- `GET /v1/scene.tsv?room=200` returns the static ROO walkability planes and
  drawable wall segments for a room. Clients fetch this only on room change.
- `GET /v1/events?agent=t1&agent=t2` opens a server-sent event stream. It sends
  one full snapshot first, then immediate broker events from an independent
  long poll per character plus cached room reconciliation at the configured safe
  cadence.
- TCP `127.0.0.1:8911` is the persistent native stream. Send
  `M59SUB<TAB>1<TAB>t1,t2<LF>` and receive length-framed
  `M59FRAME<TAB>1<TAB>bytes<LF>` snapshots.
- `POST /v1/orders` accepts lease-bound attack, room move, typed context, and
  protective cancel batches.
- `POST /v1/commander/{acquire,heartbeat,release,status}` manages the short
  commander lease. Acquire returns its opaque lease token only in the direct
  response; heartbeat exact retries return the same capability.
- `POST /v1/commerce/{status,catalog,prepare,commit}` exposes cached commerce,
  an exact on-demand merchant catalogue, and two-phase buy/sell/player-trade
  commands. Prepare returns a short-lived, single-use quote token; commit returns
  the background action's cancel token.

Every POST route above shares the same fail-closed boundary: loopback caller,
no browser `Origin`, exact `application/json`, `Authorization: Bearer
<M59_RTS_CONTROL_TOKEN>`, closed keys/types, and `order_id` exact-payload
deduplication. Commander/status/catalog/prepare responses use HTTP 200; ordinary
orders and commerce commit use HTTP 202. Validation errors use 400, missing or
wrong bearer 401, browser-origin refusal 403, stale/binding conflicts 409, wrong
media type 415, and unavailable authority 503.

The native stream is UTF-8, tab-separated, percent-escaped, and ends with
`END`. Its record types are `M59RTS`, `COMMANDER`, `AGENT`, `CONTROL`,
`COMMERCE`, `COMMERCE_TARGET`, `CATALOG`, `CATALOG_ITEM`, `TRADE`,
`TRADE_ITEM`, `SPELL`, `ITEM`, `ACTION`, `ROOM`, `ENTITY`, `APPEARANCE`,
`OVERLAY`, `EXIT`, and `ERROR`. Object ids are
valid only for the snapshot that contains them. A client must replace its entire
object-id generation whenever it accepts a new snapshot.

Native v2 appends cached, server-observed equipment telemetry to each `AGENT`:
whether the use-list is known, its freshness, and equipped item names. The
gateway asks the broker with `refresh:false`, caches each answer for five
seconds, and therefore adds no Meridian inventory requests to the render loop.
An unknown use-list is distinct from an empty equipped set.

Native v3 adds exact BGF appearances and overlays. Native v4 appends
`attackable_by` to `ENTITY`. Unlike `seen_by`, this list is actor-specific:
merging two characters' fog-of-war must never transfer one observer's attack
permission to another.

Native v5 adds the RTS-safe subset of each character's cached known spells as
`SPELL` records directly after its `AGENT` record: agent, runtime spell object
id, exact server name, target count, and school. The broker reads the spell list
already held by the protocol client and sends no Meridian request while producing
a renderer snapshot. Exposure is fail-closed through one shared policy: this
slice admits only `create food`, `create weapon`, and `blink`, each with its
audited zero-target arity. `earthquake` is deliberately absent even though its
wire target count is also zero, because it damages players; all target spells and
unclassified names remain absent until separately audited.

Native v6 follows each agent's `SPELL` records with up to 512 cached `ITEM`
records and, when a completed job report exists on the fleet row, one `ACTION`
record. Neither source performs a Meridian refresh. The JSON snapshot also
places the same inventory rows under each `agent.inventory`.

`ITEM` has eight tab-separated fields: record type, agent, runtime item id,
exact server name, amount, equipped, role, and safe actions. `equipped` is `1`,
`0`, or empty when the server use-list has not arrived. `role` is one of
`weapon`, `armor`, `shield`, `helmet`, `food`, or `other`. The final field is a
comma-separated subset of `use`, `unuse`, and `eat`: known-equipped gear may be
`unuse`d, known-unequipped non-broken/non-cursed gear may be `use`d, and known food may be
`eat`en. Unknown equipment state and unclassified items expose no action. These
are UI affordances, not authorization; a future mutation path must still
revalidate against current broker state.

`ACTION` has seven fields: record type, agent, `last_action`, elapsed seconds,
`ok`, `cancelled`, and `failed`. The last four retain their existing fleet-row
types (numbers, booleans, and failure text) and empty fields mean that telemetry
was absent. The existing `AGENT.busy` field continues to describe an in-flight
job; `ACTION` is only the most recent completed outcome already cached by the
broker.

Native v7 adds token-free commander and commerce telemetry:

- `COMMANDER enabled authority heartbeat_ms` reports effective gateway
  availability. Broker support alone is not permission: `enabled` is false on a
  read-only or no-longer-armed gateway.
- `CONTROL agent state lease_id owner expires_at_ms expires_in_ms faculties_csv
  keeper_state blocked_reason` reports one actor's lease/keeper state.
- `COMMERCE agent purse currency` and `COMMERCE_TARGET agent room id name buy
  sell offer` describe cached money and exact nearby affordances.
- `CATALOG agent merchant_id merchant_name observed_at_ms` owns zero or more
  `CATALOG_ITEM agent merchant_id id name available max unit_price currency`
  rows.
- `TRADE agent revision role counterparty_id counterparty_name may_accept
  updated_at_ms` owns exact `TRADE_ITEM agent ours|theirs id name quantity`
  rows for both sides. Empty sides are meaningful.

The snapshot normalizer selects these fields rather than copying broker objects.
`lease_token`, `quote_token`, `control_token`, internal trade fingerprints,
passwords, and command arguments can never enter JSON, SSE, TSV, or native TCP
snapshots. Lease and quote capabilities appear only in the authenticated direct
command response which needs them for the next step.

Versions 6 and 7 add records only: the field counts and meanings of every v1-v6
record are unchanged. Consumers retain their earlier decoders, add
`ITEM`/`ACTION` handling for v6, and add the commander/commerce records when the
`M59RTS` header advertises 7.

Native stream frames are complete generations, not mutations. Event cursor
activity causes an immediate cached generation in addition to periodic
reconciliation. If a renderer falls behind, the gateway retains only the newest
waiting generation; the UI never has to replay stale positions merely to preserve
intermediate frames. This bounded behavior is why native TCP may use 50ms while
ordinary SSE remains at 100ms or slower.

All POST control is off by default. Commander control has independent gates:

```powershell
$env:M59_RTS_CONTROL_TOKEN = '<random value of at least 16 characters>'
node tools/m59-rts-gateway.mjs --port 8910 --fleet <exact-fleet> `
  --agents t1,t2,t3,t4,t5 --enable-orders --control-server <exact-host>:5959
```

- `--fleet` must be explicit. Any named fleet, including `prod`, is admissible;
  there is no quiet default and no fleet-name shortcut around the other gates.
- `--agents` must be an explicit, non-empty list in control mode. The bearer can
  write only through those named sessions, even when the broker holds a larger
  broker fleet; an unrendered sixth character is not implicitly authorized.
- `--control-server` is required and accepts an exact game
  endpoint. Before listening, the updated broker must successfully serve the
  aggregate command-state path and report that endpoint for the fleet and every
  active session. The broker HTTP URL and `/health` alone are not evidence: the
  production broker is also reached through loopback. `/health` and
  `/v1/contract` repeat this aggregate probe; any failure clears write readiness
  and suppresses advertised write capabilities while read-only modes remain
  usable. Every intent carries the endpoint and the broker rechecks the session
  match, exact roster character, and active lease at the final pre-packet boundary.
- `M59_RTS_CONTROL_TOKEN` is required in the environment. Every order POST must
  carry it as `Authorization: Bearer ...`, use `application/json`, and omit a
  browser `Origin` header. Tokens never appear in command lines or health data.
- Player targets and, for now, every target-taking spell are refused both by the
  gateway and again by the broker. There is no RTS PvP flag. `GET /v1/contract`
  reports the current exact safe-spell names and `target_spells:false`.
- Ordinary orders never seize a keeper. The UI must first acquire a commander
  lease for exact `{agent,character}` rows. Acquisition atomically asks the
  keeper to yield work/movement/economy/social; partial grants are explicit.
  Heartbeat every `heartbeat_after_ms` (bounded 5-30 second TTL). Expiry or
  release restores the keeper. Survival, recovery, mortality, and identity
  remain keeper-owned throughout.

Attack, move, and typed context batches require a unique `order_id` plus a
snapshot generation less than two seconds old. Every actor must still occupy
the stated room.
Attack validation reads each actor's own raw perception and exact object id;
move validation checks the room bounds and walkable ROO plane. Independent
session jobs dispatch concurrently and return per-agent settled outcomes, so a
late broker rejection is visible rather than disguised as one all-batch 503.
Retries of the same `order_id` return the cached promise/result and never send a
second action; reusing an id with different JSON is refused.

Order JSON is a closed typed contract. Each batch and each action-specific order
accepts only its documented keys; unknown or cross-action fields are rejected.
Identifiers and spell names must be JSON strings, while rooms, object/item ids,
coordinates, swing counts, and step limits must be JSON numbers containing safe
integers. Booleans and numeric strings are never coerced.

The broker returns an owned `control_token` for every accepted attack, move, or
context action. Treat it as opaque: the gateway creates it from a cryptographic
random nonce unique to that gateway process plus a monotonically unique command
allocation. It must never be synthesized from `order_id` or agent name. An exact
deduplicated retry returns the originally stored result and token instead of
allocating another one.
A `cancel` batch must present that exact token; it cannot stop an unrelated
travel or another controller's action. Movement uses the broker's normal
geometry-aware, paced `walkTo` path and stops after its current step. Attack
stops after its current paced swing; multi-swing RTS attacks also stop before
the next swing at or below 35% health. Context actions recheck the owned
cancellation token from inside the pacer immediately before every mutating
stand, rest, turn, equipment, food, safety, or cast packet. A packet already
submitted cannot be recalled. Cancelling an active recovery still sends its
final stand as cleanup so the character is not left unable to move or fight.

Order shapes:

```json
{"type":"attack","generation":"<timestamp>-<broker-pid>","order_id":"attack-0001","orders":[{"agent":"t1","room":200,"target_id":900,"swings":20,"lease_token":"<commander lease>"}]}
{"type":"move","generation":"<timestamp>-<broker-pid>","order_id":"move-0001","orders":[{"agent":"t1","room":200,"col":12,"row":9,"max_steps":120,"lease_token":"<commander lease>"}]}
{"type":"context","action":"rest_here","generation":"<timestamp>-<broker-pid>","order_id":"rest-0001","orders":[{"agent":"t1","room":200,"col":12,"row":9,"lease_token":"<commander lease>"}]}
{"type":"context","action":"grab_nearby","generation":"<timestamp>-<broker-pid>","order_id":"grab-0001","orders":[{"agent":"t1","room":200,"lease_token":"<commander lease>"},{"agent":"t2","room":200,"lease_token":"<commander lease>"}]}
{"type":"context","action":"cast","generation":"<timestamp>-<broker-pid>","order_id":"cast-0001","orders":[{"agent":"t1","room":200,"spell":"create weapon","lease_token":"<commander lease>"}]}
{"type":"cancel","order_id":"cancel-0001","orders":[{"agent":"t1","control_token":"<accepted action control token>","lease_token":"<commander lease>"}]}
```

Every attack, move, context, and cancel row requires the lease capability.
Cancel is a protective stop: the broker pins both tokens to the recorded job and
permits it after lease expiry. The legacy cross-room `travel` broker tool is not
exposed here because not every door/edge/fine-movement branch performs a final
lease check; commander travel remains unavailable until an audited
`travel_intent` exists.

Commander request bodies are exact:

```json
{"order_id":"lease-acquire-0001","generation":"<timestamp>-<broker-pid>","fleet":"prod","broker_pid":1234,"server_host":"76.214.42.186","server_port":5959,"agents":[{"agent":"t1","character":"Kermit"}],"owner":"boswars-native","lease_ms":20000}
{"order_id":"lease-heartbeat-01","fleet":"prod","broker_pid":1234,"server_host":"76.214.42.186","server_port":5959,"agents":[{"agent":"t1","character":"Kermit"}],"lease_token":"<acquire result token>","lease_ms":20000}
{"order_id":"lease-release-0001","fleet":"prod","broker_pid":1234,"server_host":"76.214.42.186","server_port":5959,"agents":[{"agent":"t1","character":"Kermit"}],"lease_token":"<acquire result token>"}
{"order_id":"lease-status-00001","fleet":"prod","broker_pid":1234,"server_host":"76.214.42.186","server_port":5959,"lease_token":"<optional exact lease token>"}
```

Acquire alone requires a fresh generation and may grant a subset; heartbeat and
release must echo the exact granted roster. The 200 response is
`{"schema":"m59-rts/v1","accepted":true,"order_id":"...","operation":"commander.acquire","result":{...}}`.
The direct acquire/heartbeat result contains `lease_token`; status/release and
all read transports do not.

Commerce bodies share `order_id`, exact `agent`, `character`, `room`, `fleet`,
`broker_pid`, `server_host`, `server_port`, and `lease_token`. Catalog, prepare,
and commit additionally require a fresh `generation`:

```json
{"order_id":"commerce-status-01","agent":"t1","character":"Kermit","room":200,"fleet":"prod","broker_pid":1234,"server_host":"76.214.42.186","server_port":5959,"lease_token":"<lease>"}
{"order_id":"commerce-catalog1","generation":"<timestamp>-<broker-pid>","agent":"t1","character":"Kermit","room":200,"fleet":"prod","broker_pid":1234,"server_host":"76.214.42.186","server_port":5959,"lease_token":"<lease>","merchant":{"id":910,"name":"Rook"}}
{"order_id":"commerce-prepare1","generation":"<timestamp>-<broker-pid>","agent":"t1","character":"Kermit","room":200,"fleet":"prod","broker_pid":1234,"server_host":"76.214.42.186","server_port":5959,"lease_token":"<lease>","kind":"buy","merchant":{"id":910,"name":"Rook"},"item":{"id":920,"name":"bread"},"quantity":2}
{"order_id":"commerce-commit01","generation":"<timestamp>-<broker-pid>","agent":"t1","character":"Kermit","room":200,"fleet":"prod","broker_pid":1234,"server_host":"76.214.42.186","server_port":5959,"lease_token":"<lease>","quote_token":"<prepare result token>"}
```

Prepare kinds are: `buy` (`merchant`, `item`, `quantity`), `sell`
(`merchant`, non-empty exact `items`), `offer` (`counterparty`, non-empty exact
`items`), and `trade_counter_empty`/`trade_accept`/`trade_cancel`
(`counterparty`, `expected_trade_revision`, exact `expected_ours`, exact
`expected_theirs`, and boolean `expected_may_accept`). Every item is
`{"id":<positive integer>,"name":"<exact server name>","quantity":<1-9999>}`.
Prepared quotes are short-lived and single-use. Commerce responses use the
settled envelope
`{"schema":"m59-rts/v1","accepted":true,"accepted_count":1,"rejected_count":0,"order_id":"...","operation":"commerce.prepare","outcomes":[{"agent":"t1","accepted":true,"result":{...}}]}`.
Prepare retains only the quote capability needed for commit. Commit retains the
owned background `control_token` needed for cancel, but removes the redundant
lease echo and internal trade fingerprint.

Meridian replaces every accepted offered inventory object with a transient
trade-table clone carrying a different runtime id. The broker binds that clone
to the original held id internally, revalidates both identities plus the exact
trade revision/sides before acceptance, and reconciles completion against the
original inventory. Two source stacks with the same exact name are refused
before a packet because the server echo has no stable field that could prove
which clone came from which stack. Neither the hidden binding nor the transient
id widens the authenticated request contract.

The context action name is a fixed allowlist, never a broker tool name. `stand`
stands immediately. `rest_here` validates the ROO floor, walks there, and rests
only after confirmed arrival; `recover_here` instead watches health and vigor to
90 percent and stands afterward. `approach` and `face` accept only an exact,
currently perceived object id. `equip_best`, `wear_best`, and `eat_best` use the
broker's existing ranked skills. `prepare` turns safety on, equips the best
weapon, and wears the best beneficial armor while reusing one explicit inventory
refresh. `item_use`, `item_unuse`, and `item_eat` require a current cached item
affordance; the broker rechecks the exact id, name, role, carried state, and
equipment state. `safety_on` exposes only the protective direction. Safety-off
is not part of the RTS action catalogue. `take` rechecks one selected gettable id and may
approach it. `grab_nearby` derives ids from each actor's own current perception,
keeps the actor in place, preserves the broker's cursed/broken-item screening,
and assigns each item to only one selected actor within the seven-square pickup
range. `cast` accepts an exact cached server spell name only when the shared
fail-closed policy also admits that exact wire arity. The current audited set is
`create food`, `create weapon`, and `blink`, all without a target. In particular,
zero-target `earthquake` is omitted and refused at both process boundaries; an
unknown or target-taking spell is refused rather than inferred safe.

Production is not permanently view-only and is not fleet-name gated. Operators
should still prefer the best-proven client UX before acquiring a production
lease, but the authority boundary is now the same for every named fleet:
loopback gateway, bearer-authenticated command, exact fleet/broker/server/roster
binding, short lease with heartbeat, final-packet lease rechecks, and automatic
keeper restoration on release/expiry. Removing any one of those checks is not a
supported production mode.

The reconciliation interval does not send Meridian packets. `look` is called
with `cached:true, projection:"render"`, so it reads raw protocol client state
without the tactical `look` call's per-object/per-exit A*. This is required for
competitive rendering because
the broker intentionally keeps high-frequency monster movement out of its
bounded event ring; appearances, removals, player movement, stats, equipment,
messages, and combat results still arrive immediately through event cursors.
