// Point the ledger at a scratch directory, for tests that touch keeper code.
//
//   import './m59-test-ledger.mjs';          // FIRST, before anything else
//   import { Autopilot } from './m59-autopilot.mjs';
//
// IT HAS TO BE AN IMPORT, AND IT HAS TO BE FIRST. The ledger resolves its directory
// once, at module load, and ESM evaluates the whole import graph before a single line
// of the importing file's body runs — so setting M59_LEDGER_DIR in the test body is
// too late, and looks like it worked. Sibling imports are evaluated in source order,
// which is what makes this reliable.
//
// The keeper records every cast and purchase to the ledger, so any test that
// constructs an Autopilot writes to one. Without this, that is the LIVE fleet's
// permanent history: a fixture called `Tester` becomes a character in the audit, in a
// file that is appended and never rotated. m59-ledger.mjs refuses such writes and says
// so on stderr; this is how a test stops needing to be refused.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.M59_LEDGER_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'm59-test-ledger-'));
  process.env.M59_LEDGER_DIR = dir;
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
}

// THE UPTIME LEDGER NEEDS THE SAME PROTECTION, and for a sharper reason: it is the file
// that says which deaths happened with nobody driving, so anything false in it corrupts
// the one measurement that separates "the strategy killed this character" from "we
// restarted the broker". A test that constructs an Autopilot calls start() and stop(),
// and both write — twenty-four rows of a fixture called `test`, with a room number of
// 999, landed in the live fleet's ledger the first time this was wired up.
if (!process.env.M59_UPTIME_FILE) {
  const dir = mkdtempSync(join(tmpdir(), 'm59-test-uptime-'));
  process.env.M59_UPTIME_FILE = join(dir, 'keeper-uptime.jsonl');
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
}
