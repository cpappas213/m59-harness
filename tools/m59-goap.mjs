#!/usr/bin/env node
// m59-goap.mjs — GOAP supervisor for the Meridian 59 fleet
// Evaluates per-character goals against live world state and applies actions.
//
// NOTHING IN THIS REPOSITORY IMPORTS THIS, AND THAT IS ON PURPOSE RATHER THAN AN OVERSIGHT.
//
// It is the goal interface for the two bot repositories — `meridian59-dum-bot` and
// `meridian59-llm-bot` — which is to say it belongs to the WORK/MOVEMENT/ECONOMY/SOCIAL
// row of the split in CLAUDE.md: things with no single right answer that can be re-decided
// in five minutes. It drives the fleet the way any other bot does, over the broker's MCP
// surface, from outside. That is why it is a standalone script with a `--dry-run` habit
// and not a module the keeper calls: a goal evaluated inside the keeper would be a
// directional decision taken on the keeper's one-second clock, which is the boundary the
// whole repository is arranged around.
//
// Being unreferenced is therefore the expected state, not a sign it was forgotten. If you
// are removing dead code, this is not it.
//
// WHAT IT READS IS THIS MACHINE'S OPINION, NOT THIS REPOSITORY'S. `substrate/goap-goals.json`
// names actual characters on an actual roster, so it is gitignored for the same reason
// `substrate/policy.local.json` is: committed, it would ship one operator's fleet plan to
// everybody who clones this. `substrate/goap-goals.example.json` is the shape, with names
// that belong to nobody.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { intelStateFor } from './m59-intel.mjs';

// The operator's file if there is one, and the committed example if there is not — so a
// fresh clone runs against names that belong to nobody rather than failing to start.
const GOALS_LOCAL   = new URL('../substrate/goap-goals.json', import.meta.url);
const GOALS_EXAMPLE = new URL('../substrate/goap-goals.example.json', import.meta.url);
const GOALS_PATH = existsSync(GOALS_LOCAL) ? GOALS_LOCAL : GOALS_EXAMPLE;
const BROKER_URL = 'http://127.0.0.1:8901/';
const INTERVAL_MS = 60_000;
const RESUPPLY_COOLDOWN_MS = 10 * 60_000;  // don't redistribute more than once per 10 min

let lastResupplyAt = 0;

// ---------- broker ----------

let _id = 0;
async function call(name, args = {}) {
  const r = await fetch(BROKER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++_id, method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const text = j.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

// ---------- goals file ----------

function loadGoals() {
  const path = new URL(GOALS_PATH).pathname;
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify({}, null, 2), 'utf8');
    console.log('[goap] created empty goals file at', path);
    return {};
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------- condition evaluator ----------

function evalCondition(condition, state) {
  try {
    const fn = new Function(
      'level', 'room', 'hunt', 'karma', 'mode', 'reagents', 'purse',
      'players_nearby', 'threat_nearby',
      'return (' + condition + ')');
    return Boolean(fn(
      state.level, state.room, state.hunt, state.karma, state.mode,
      state.reagents, state.purse,
      state.players_nearby, state.threat_nearby,
    ));
  } catch {
    return false;
  }
}

// ---------- actions ----------

async function setHunt(agent, hunt, room, mode, dryRun) {
  if (dryRun) return;
  await call('autopilot', { agent, action: 'set', hunt, room_num: room, mode });
  await call('autopilot', { agent, action: 'start' });
}

async function setRoom(agent, room, dryRun) {
  if (dryRun) return;
  await call('autopilot', { agent, action: 'set', room_num: room });
}

async function restartKeeper(agent, dryRun) {
  if (dryRun) return;
  await call('autopilot', { agent, action: 'stop' });
  await call('autopilot', { agent, action: 'start' });
}

async function redistributeReagents(dryRun) {
  const now = Date.now();
  if (now - lastResupplyAt < RESUPPLY_COOLDOWN_MS) return;  // already dispatched this window
  lastResupplyAt = now;
  console.log('[goap] dispatching provision resupply');
  if (dryRun) return;
  await call('provision', { action: 'resupply' });
}

// ---------- planner ----------

// Returns true if the `then` block differs from current state enough to act on.
function needsChange(then, state) {
  if (then.hunt !== undefined && then.hunt !== state.hunt) return true;
  if (then.room !== undefined && then.room !== state.room) return true;
  if (then.mode !== undefined && then.mode !== state.mode) return true;
  if (then.resupply) return true;  // always fires when condition is met
  return false;
}

async function applyThen(agent, then, state, dryRun) {
  const wantHunt = then.hunt ?? state.hunt;
  const wantRoom = then.room ?? state.room;
  const wantMode = then.mode ?? state.mode;

  const huntChanged = then.hunt !== undefined && then.hunt !== state.hunt;
  const roomChanged = then.room !== undefined && then.room !== state.room;
  const modeChanged = then.mode !== undefined && then.mode !== state.mode;

  if (huntChanged || modeChanged) {
    if (!dryRun) await setHunt(agent, wantHunt, wantRoom, wantMode, false);
  } else if (roomChanged) {
    if (!dryRun) await setRoom(agent, wantRoom, false);
  }

  if (then.resupply) {
    await redistributeReagents(dryRun);
  }

  if (!state.keeper_running && !then.note && !then.resupply) {
    if (!dryRun) await restartKeeper(agent, false);
  }
}

// ---------- one pass ----------

async function runPass(goals, dryRun) {
  let fleetData;
  try {
    fleetData = await call('fleet', {});
  } catch (err) {
    console.error('[goap] cannot reach broker:', err.message);
    return;
  }

  const rows = fleetData?.fleet ?? [];
  if (rows.length === 0) {
    console.log('[goap] fleet returned no rows');
    return;
  }

  for (const row of rows) {
    const character = row.character;
    const charGoals = goals[character];
    if (!charGoals || charGoals.length === 0) continue;

    const roomNum = row.room_num ?? null;
    const intel   = intelStateFor(character, roomNum, null);
    const state = {
      level:          row.level ?? row.max_health ?? null,
      room:           roomNum,
      hunt:           row.policy?.hunt ?? null,
      mode:           row.mode ?? null,
      karma:          row.karma ?? null,
      keeper_running: row.keeper_running ?? false,
      stalled:        row.stalled ?? false,
      reagents:       row.reagents ?? {},
      purse:          row.purse ?? null,
      players_nearby: intel.players_nearby,
      threat_nearby:  intel.threat_nearby,
    };

    for (const goal of charGoals) {
      if (!goal.condition || !goal.then) continue;

      const met = evalCondition(goal.condition, state);
      if (!met) continue;

      const then = goal.then;

      // note-only goals: just log
      if (then.note && !needsChange(then, state)) {
        console.log(`[goap] ${character} condition="${goal.condition}" → note: ${then.note}`);
        break;
      }

      if (!needsChange(then, state)) continue; // already there

      // Describe what we are doing
      const parts = [];
      if (then.hunt && then.hunt !== state.hunt) parts.push(`hunt=${then.hunt}`);
      if (then.room && then.room !== state.room) parts.push(`room=${then.room}`);
      if (then.mode && then.mode !== state.mode) parts.push(`mode=${then.mode}`);
      if (then.note) parts.push(`note: ${then.note}`);

      const label = parts.join(', ');
      const prefix = dryRun ? '[goap][dry-run]' : '[goap]';
      console.log(`${prefix} ${character} level=${state.level} condition="${goal.condition}" → ${label}`);

      try {
        await applyThen(row.agent, then, state, dryRun);
      } catch (err) {
        console.error(`[goap] error applying to ${character}:`, err.message);
      }

      break; // first matching goal wins
    }
  }
}

// ---------- CLI ----------

const args = process.argv.slice(2);
const dryRun  = args.includes('--dry-run');
const once    = args.includes('--once');
const goalsCmd = args.includes('--goals');

if (goalsCmd) {
  const goals = loadGoals();
  console.log(JSON.stringify(goals, null, 2));
  process.exit(0);
}

const goals = loadGoals();

if (once || dryRun && !args.includes('--loop')) {
  await runPass(goals, dryRun);
} else {
  console.log(`[goap] starting loop every ${INTERVAL_MS / 1000}s${dryRun ? ' (dry-run)' : ''}`);
  await runPass(goals, dryRun);
  setInterval(() => runPass(goals, dryRun), INTERVAL_MS);
}
