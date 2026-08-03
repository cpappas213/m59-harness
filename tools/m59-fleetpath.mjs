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

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// A fleet name becomes a filename, so it is validated rather than trusted. Refusing
// is better than sanitising: silently rewriting `../../etc` to `etc` would put the
// roster somewhere the caller did not ask for and would not think to look.
export function fleetName(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf('--fleet');
  const name = (i >= 0 ? argv[i + 1] : '') || env.M59_FLEET || '';
  if (name && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(`bad fleet name ${JSON.stringify(name)} — letters, digits, dash and underscore only`);
  }
  return name;
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

// The set, resolved together, for the common case.
export function resolveFleet(argv = process.argv.slice(2), env = process.env) {
  const name = fleetName(argv, env);
  return {
    fleet: name,
    label: name || 'default',
    stateFile: stateFileFor(name, env),
    ledgerDir: ledgerDirFor(name, env),
  };
}
