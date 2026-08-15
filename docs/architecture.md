# M59-Harness Architecture

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        MERIDIAN 59 SERVER                           │
│                        <host>:5959  (set M59_HOST)                  │
└────────────────────────────┬────────────────────────────────────────┘
                             │  TCP — M59 binary protocol
                             │  AP_* login frames / BP_* game frames
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                         M59Client                                   │
│                    tools/m59-client.mjs                             │
│                                                                     │
│  • Maintains TCP socket, parses every incoming packet               │
│  • Keeps live state: room.objects, inventory, vitals, abilities     │
│  • Emits events upward: room-contents, stat, said, equipped, ...    │
│  • Event ring: 500 entries (combat) + 300 entries (chat, separate   │
│    so speech survives a busy fight)                                 │
│  • Sends commands: REQ_MOVE, REQ_ATTACK, REQ_CAST, BP_WITHDRAW …   │
└────────────────────────────┬────────────────────────────────────────┘
                             │  one M59Client per character
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                          Session                                    │
│                    tools/m59-broker.mjs                             │
│                                                                     │
│  • Wraps one M59Client; mediates all read/write access              │
│  • Pacer: rate-limits actions to ~5/second                          │
│    (queues: 'read', 'use', 'move', 'cast', 'drop')                  │
│  • Records every health drop → substrate/hits/<char>.json           │
│  • Records room transit times → substrate/transit/<char>.json       │
│  • Writes raw event stream → substrate/recordings/<char>/           │
│  • Tracks credentials; can rejoin() after a drop                    │
└────────────────────────────┬────────────────────────────────────────┘
                             │  one Session per character
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                         Broker                                      │
│                    tools/m59-broker.mjs                             │
│                                                                     │
│  Fleet state ──────────────────────────────────────────────────┐   │
│  • sessions Map (agent → Session)                              │   │
│  • fleetState.json: credentials + autopilot policy per char    │   │
│  • leftOnPurpose / piloted sets                                │   │
│  • Rejoin sweep every 45s: re-logs dropped characters          │   │
│  • resumeFleet on startup: reads prior client cmd lines,       │   │
│    skips chars a human is already playing                      │   │
│                                                                │   │
│  Ledger ───────────────────────────────────────────────────────┘   │
│  • 5-minute samples: health, activity, kills, purse, pack          │
│  • killed events attributed to specific kills (not diff)           │
│  • tougher events: max-health gains with kill attribution          │
│  • substrate/ledger/<fleet>.jsonl                                   │
│                                                                     │
│  HTTP server :8901  ◄── JSON-RPC MCP ──► Claude / other agents     │
│  Dashboard   :8902  ◄── browser (read-only fleet page)             │
│                                                                     │
│  83 MCP tools exposed:                                             │
│    fleet, snapshot, autopilot, travel, fight, join, leave,         │
│    go_through, leave_raza, signets, guild, loadout, …              │
└────────────────────────────┬────────────────────────────────────────┘
                             │  one Autopilot per character
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                        Autopilot (Keeper)                           │
│                    tools/m59-autopilot.mjs                          │
│                                                                     │
│  Runs pass() every ~1s (decideMs policy):                          │
│                                                                     │
│   1. Post position & interests to team coordination board           │
│   2. Resync every 8s: roomContents() + stats() to correct drift    │
│   3. observe(): is the current safe spot still working?             │
│   4. recordFrame(): health/doing/room snapshot for post-mortems     │
│   5. Decision ladder (priority order):                              │
│        panicking?      → logoff                                     │
│        in Underworld?  → escape via portals                         │
│        health < flee?  → run                                        │
│        health < rest?  → find safe wall, rest to full               │
│        farm mode?      → hunt prey (fight loop)                     │
│        town needed?    → travel to town, bank/buy/sell              │
│        errand active?  → execute multi-hop task                     │
│        idle            → roam or wait                               │
│                                                                     │
│  Watchdog (independent 500ms timer):                               │
│   • Reads health live (server pushes it)                           │
│   • If health crosses flee line while pass is blocked > 3s         │
│     → calls cancelMovement() to interrupt the await               │
│   • Writes health-change frames even when pass is blind            │
│                                                                     │
│  Policy (settable via MCP autopilot tool):                         │
│   hunt, fightRounds, restBelow, fleeBelow, assignedRoom,           │
│   bankAbove, buyFood, roam, partner, threatCeiling, …              │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                          Skills                                     │
│                    tools/m59-skills.mjs                             │
│                                                                     │
│  fight(session, opts)                                              │
│   • findCreature() — scans room.objects, filters OF_PLAYER         │
│   • claimQuarry() — coordinates with fleetmates, no pile-ons       │
│   • equipBest() / wearBest() — equip weapon + armour               │
│   • approach to within 2-3 squares (melee range disc)              │
│   • swing loop: rounds × swings, loot on kill                      │
│   • disengageAt threshold: break off below flee health             │
│   • preferId: locks onto specific creature id across rounds        │
│                                                                     │
│  travel(session, roomId)                                           │
│   • A* path via m59-map world graph                                │
│   • Per-hop: approachSquare() with fine-coord fallback             │
│   • Bracketed: "setting off" + "arrived" frames either side        │
│   • Cancellation token: watchdog can interrupt mid-hop             │
│                                                                     │
│  eat(), rest(), healUp(), bank(), buy(), sell(), cast()            │
└─────────────────────────────────────────────────────────────────────┘


## Claude / MCP integration

┌──────────────────┐     stdio MCP      ┌──────────────────────────┐
│   Claude Code    │ ◄────────────────► │   m59-mcp-attach.mjs     │
│  (this session)  │                    │   forwards to :8901      │
└──────────────────┘                    └────────────┬─────────────┘
                                                     │ HTTP JSON-RPC
                                                     ▼
                                          Broker :8901 tool handlers


## What Claude can do via MCP

READ                          WRITE / ACT
────────────────────────────  ────────────────────────────────────
fleet()       — all chars     autopilot(set/start/stop)
snapshot(t1)  — one char      travel(agent, room)
ledger()      — history       fight(agent, target)
deaths()      — post-mortems  go_through(agent, exit)
tougher()     — level gains   leave_raza(agent)
skills()      — ability lvls  signets(action)
economy()     — purse/bank    loadout(agent, ...)
                              guild(action)


## State that persists to disk (substrate/)

substrate/
  fleet-state.json          ← credentials + autopilot policy (THE roster)
  fleet-state.json.prev     ← safety backup written before every save
  hits/<char>.json          ← every health drop with room + killer
  abilities/<char>.json     ← spell/skill levels (pushed by server)
  banks/<char>.json         ← bank balance (caught when banker speaks)
  sheets/<char>.json        ← character stats snapshot
  loadouts/<char>.json      ← per-character gear/reagent targets
  recordings/<char>/        ← raw event stream to disk
  ledger/<fleet>.jsonl      ← 5-minute samples + kill/tougher events
  broker-<fleet>.log        ← broker stdout/stderr


## Service wrapper

start-broker.sh
  └── m59-service.mjs start
        └── spawns m59-broker.mjs detached
              pid → substrate/broker-<fleet>.pid
              log → substrate/broker-<fleet>.log
              survives terminal; does NOT survive reboot
```
