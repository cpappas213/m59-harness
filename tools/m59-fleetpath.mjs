// WHICH ROSTER FILE IS "THE FLEET" RIGHT NOW.
//
// One resolver, imported by everything that reads or writes a roster, because the
// broker and the tools that inspect it disagreeing about which file is the fleet is
// not a visible failure — it is a TUI that shows an empty roster while the broker
// plays on, or a shutdown that checkpoints the wrong one.
//
// A roster is per-server. Characters on one server share nothing with characters on
// another, so a file holding both describes a fleet that does not exist. Each fleet
// gets its own file and the filename is the identity:
//
//   --fleet prod   /  M59_FLEET=prod      substrate/fleets/prod.json
//   (nothing)                             substrate/fleet-state.json
//
// Naming nothing keeps the original path, so a checkout that has never heard of
// fleets behaves exactly as it did. M59_STATE_FILE still overrides everything, which
// is what the tests use.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// WHICH FLEET, WHEN THE CALLER DID NOT SAY.
//
// Naming nothing used to mean substrate/fleet-state.json, and on a machine that has
// moved on to a named fleet that default is a trap rather than a convenience: every
// tool run without --fleet quietly addresses a roster for a server that may not even
// be up, reports itself perfectly healthy, and answers questions about a fleet nobody
// is playing. A restart did exactly that — it stopped a live 46-session broker and
// would have brought back a 37-character roster pointed at a dead local server.
//
// So a checkout may record which fleet it actually cares about, in one line:
//
//   substrate/fleet-default        prod
//
// It is deliberately a FILE and not a constant in this repository. `prod` is one
// machine's fleet, its roster is gitignored because it holds passwords, and a clone
// that has never heard of it must keep behaving exactly as it did — so the file is
// gitignored too, and a checkout without one falls back to the unnamed fleet.
//
// Order, most explicit first:
//
//   --fleet <name>          what this invocation said
//   M59_FLEET=<name>        what this shell said
//   substrate/fleet-default what this checkout cares about
//   (nothing)               substrate/fleet-state.json, as it always was
//
// `--fleet -` asks for the unnamed fleet on purpose, which is the only way to get it
// back once a default is recorded. It cannot collide with a real name because a name
// must start with a letter or digit.
export const DEFAULT_FLEET_FILE = join(REPO, 'substrate', 'fleet-default');

const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// A fleet name becomes a filename, so it is validated rather than trusted. Refusing
// is better than sanitising: silently rewriting `../../etc` to `etc` would put the
// roster somewhere the caller did not ask for and would not think to look.
function checked(name, source) {
  if (name && !NAME_OK.test(name)) {
    throw new Error(`bad fleet name ${JSON.stringify(name)} from ${source} — ` +
                    `letters, digits, dash and underscore only`);
  }
  return { name, source };
}

function recordedDefault(env) {
  const path = env.M59_FLEET_DEFAULT_FILE || DEFAULT_FLEET_FILE;
  if (!existsSync(path)) return '';
  try {
    // One name, on the first line that is not blank and not a comment — so the file
    // can carry a note about why without that note becoming a fleet name.
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) return t;
    }
  } catch { /* unreadable is the same as absent — never fail a tool over it */ }
  return '';
}

// The name AND where it came from. Every tool that acts on a fleet should say which
// one out loud, and "because this checkout says so" is a different thing for a reader
// to check than "because you typed it".
export function resolveFleetName(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf('--fleet');
  const flag = i >= 0 ? String(argv[i + 1] ?? '') : '';
  if (flag === '-') return { name: '', source: '--fleet - (the unnamed fleet, asked for)' };
  if (flag) return checked(flag, '--fleet');
  if (env.M59_FLEET) return checked(env.M59_FLEET, 'M59_FLEET');
  const local = recordedDefault(env);
  if (local) return checked(local, 'substrate/fleet-default');
  return { name: '', source: 'no fleet named' };
}

export function fleetName(argv = process.argv.slice(2), env = process.env) {
  return resolveFleetName(argv, env).name;
}

export function stateFileFor(name, env = process.env) {
  if (env.M59_STATE_FILE) return env.M59_STATE_FILE;
  return name ? join(REPO, 'substrate', 'fleets', `${name}.json`)
              : join(REPO, 'substrate', 'fleet-state.json');
}

// The ledger is per-fleet for the same reason the roster is, and with sharper
// consequences: it is keyed by CHARACTER NAME, and character names are only unique
// within a server. Two fleets writing one directory silently merge two different
// characters that happen to share a name into one row, and the dashboard then reports
// a levels-per-hour figure for a character that does not exist. Worse, it is not
// obviously wrong — it just reads as a fleet doing better than it is.
export function ledgerDirFor(name, env = process.env) {
  if (env.M59_LEDGER_DIR) return env.M59_LEDGER_DIR;
  return name ? join(REPO, 'substrate', 'history', name)
              : join(REPO, 'substrate', 'history');
}

// The lock is named after the roster it guards, so a named fleet and the unnamed one
// can be held at once without either believing it owns the other. Anything cleaning up
// a lock must derive it the same way, or it deletes the wrong checkout's claim.
export function lockFileFor(name, env = process.env) {
  return stateFileFor(name, env) + '.lock';
}

// The set, resolved together, for the common case. `source` is carried through so a
// tool can print where the name came from without resolving it twice.
export function resolveFleet(argv = process.argv.slice(2), env = process.env) {
  const { name, source } = resolveFleetName(argv, env);
  return {
    fleet: name,
    label: name || 'default',
    source,
    stateFile: stateFileFor(name, env),
    lockFile: lockFileFor(name, env),
    ledgerDir: ledgerDirFor(name, env),
  };
}
