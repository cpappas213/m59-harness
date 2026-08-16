#!/usr/bin/env node
// WHOSE RECORDS ARE THESE — the scoping rule, against scratch directories and a fixture
// broker. Offline, safe any time:
//
//   node tools/m59-fleetscope-test.mjs
//
// The failure this guards against is not a crash. `substrate/postmortems/`,
// `substrate/abilities/` and `substrate/hits/` are keyed by CHARACTER NAME and nothing
// else, so every fleet this machine has ever run writes into the same directories. The
// boards summed two populations and said nothing about it — 10 of 31 ability books
// belonged to a local test server that no longer exists, including `User327460430`.
//
// Both directions are dangerous and both are pinned here:
//
//   * TOO WIDE is the bug being fixed — another fleet's characters counted as yours.
//   * TOO NARROW is worse and quieter. A scope that resolves to an empty set filters
//     EVERYTHING out, and a board reading "0 deaths" looks exactly like a fleet having a
//     good week. So "cannot tell" must be `null` (do not filter, say so) and never an
//     empty Set.
//
// And identity is the ROSTER PATH, not the fleet label: two checkouts can each hold a
// fleet called `prod` and they are not the same 21 characters.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const S = await import('./m59-fleetscope.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const root = mkdtempSync(join(tmpdir(), 'm59-scope-test-'));
const rosterPath = join(root, 'prod.json');
writeFileSync(rosterPath, JSON.stringify({
  t1: { credentials: { account: 't1', password: 'REDACTED-IN-TEST', character: 'Kermit' } },
  t2: { credentials: { account: 't2', password: 'REDACTED-IN-TEST', character: 'Piggy' } },
}));
// The older shape, where the name sat at the top of the slot rather than under
// credentials. Both are read, because a scope that comes back empty filters everything.
const oldShape = join(root, 'old.json');
writeFileSync(oldShape, JSON.stringify({ t1: { character: 'Aldric' }, t2: { character: 'Elspeth' } }));

console.log('reading a roster');
{
  const names = S.charactersInRoster(rosterPath);
  ok('the character names come out', names?.size === 2 && names.has('Kermit') && names.has('Piggy'));
  ok('AND NOTHING ELSE DOES — a roster is the credential store, and this returns a Set of ' +
     'names, so there is no shape in which an account or a password can leak through it',
     [...names].every(n => typeof n === 'string') &&
     !JSON.stringify([...names]).includes('REDACTED-IN-TEST'));
  ok('the older slot shape is read too', S.charactersInRoster(oldShape)?.has('Aldric'));
  ok('a missing roster is null, not an empty set — the difference between "not filtered" ' +
     'and "nobody"', S.charactersInRoster(join(root, 'nope.json')) === null);
  ok('so is an unreadable one',
     (writeFileSync(join(root, 'bad.json'), '{ not json'),
      S.charactersInRoster(join(root, 'bad.json')) === null));
  ok('and so is a roster with no names in it yet — a fleet that has never logged in',
     (writeFileSync(join(root, 'empty.json'), JSON.stringify({ t1: { credentials: { account: 't1' } } })),
      S.charactersInRoster(join(root, 'empty.json')) === null));
}

console.log('\nsplitting records');
{
  const scope = { characters: new Set(['Kermit', 'Piggy']), filtered: true, fleet: 'prod', from: 'a test' };
  const rows = [{ character: 'Kermit' }, { character: 'Bramwell' }, { character: 'Piggy' },
                { character: 'User327460430' }, { character: 'Bramwell' }];
  const p = S.partition(rows, scope);
  ok('mine are kept', p.kept.length === 2, `got ${p.kept.length}`);
  ok('another fleet\'s are set aside, not dropped silently — two Bramwells and one ' +
     'User327460430 is three ROWS, even though it is two names',
     p.setAside.length === 3, `got ${p.setAside.length}`);
  ok('and named once each, so the report can say who', p.others.join(',') === 'Bramwell,User327460430');

  const unfiltered = S.partition(rows, { characters: null, filtered: false });
  ok('AN UNRESOLVED SCOPE KEEPS EVERYTHING. Filtering on "cannot tell" would empty every ' +
     'board, which reads as a quiet week rather than as a broken filter',
     unfiltered.kept.length === 5 && unfiltered.setAside.length === 0);
  ok('a null scope does the same', S.partition(rows, null).kept.length === 5);
  ok('a custom key works, for rows that are not shaped {character}',
     S.partition(['Kermit', 'Bramwell'], scope, r => r).kept.length === 1);
}

console.log('\nsaying which population the numbers describe');
{
  const scope = { characters: new Set(['Kermit']), filtered: true, fleet: 'prod', from: 'the broker on 8901' };
  const line = S.scopeLine(scope, [{ character: 'Bramwell' }]);
  ok('it names the fleet and where the answer came from',
     /prod/.test(line) && /broker on 8901/.test(line));
  ok('and says what it set aside', /Bramwell/.test(line) && /set aside/.test(line));
  ok('an unfiltered scope says so plainly rather than implying a filter ran',
     /every character/.test(S.scopeLine({ characters: null, filtered: false, from: 'no roster' })));
}

console.log('\nwhere it is willing to look');
{
  // AN EXPLICIT PORT IS THE WHOLE LIST, asserted here directly rather than only through
  // its consequences, because the consequence is what was broken and the cause is what
  // has to stay fixed.
  //
  // It used to APPEND the default and the pid-file ports after the one you named, so
  // naming a dead port meant "look here first, then look everywhere" — and fleetScope
  // duly found the live broker on 8901 and returned it. Three assertions below depend on
  // `port: 1` genuinely meaning nothing-is-there, and they failed on any machine with a
  // fleet up, which is every machine anyone would run this on.
  const named = S.candidateBrokerPorts({ port: 1 });
  ok('naming a port asks that port and no other', named.length === 1 && named[0] === 1);
  ok('and it does not quietly add the default alongside it', !named.includes(8901));
  const discovered = S.candidateBrokerPorts();
  ok('naming none still discovers the default', discovered.includes(8901));
  ok('a nonsense port is ignored rather than probed',
     !S.candidateBrokerPorts({ port: 0 }).includes(0) &&
     !S.candidateBrokerPorts({ port: 99999 }).includes(99999));
  ok('and falls back to discovery, rather than to an empty list nothing can answer',
     S.candidateBrokerPorts({ port: 0 }).includes(8901));
}

console.log('\nchoosing a broker');
{
  // A fixture broker that answers /health exactly as the real one does, naming the roster
  // PATH it holds. Identity is that path: a fleet LABEL is not identity, because two
  // checkouts can each hold a fleet called `prod`.
  const serve = (state, fleet = 'prod') => new Promise((done) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: 4242, fleet, state, sessions: ['t1', 't2'] }));
    });
    srv.listen(0, '127.0.0.1', () => done({ srv, port: srv.address().port }));
  });

  const mine = await serve(rosterPath, 'prod');
  const theirs = await serve(join(root, 'other-checkout-prod.json'), 'prod');
  writeFileSync(join(root, 'other-checkout-prod.json'),
                JSON.stringify({ t1: { credentials: { character: 'Bramwell' } } }));

  const s1 = await S.fleetScope({ argv: [], env: { M59_STATE_FILE: rosterPath }, port: mine.port });
  ok('an explicit port is believed, and its roster is what scopes the records',
     s1.filtered && s1.characters.has('Kermit') && s1.characters.size === 2);
  ok('and it says where the answer came from, including the pid',
     /broker on \d+/.test(s1.from) && /4242/.test(s1.from));

  // THE CASE THE LABEL WOULD GET WRONG: both brokers call themselves `prod`, and only one
  // is holding the roster this checkout means.
  const s2 = await S.fleetScope({ argv: [], env: { M59_STATE_FILE: rosterPath },
                                  port: theirs.port });
  ok('A DIFFERENT CHECKOUT\'S "prod" IS A DIFFERENT FLEET — matched on the roster path it ' +
     'reports, never on the label, so this scopes to Bramwell and not to Kermit',
     s2.filtered && s2.characters.has('Bramwell') && !s2.characters.has('Kermit'));

  mine.srv.close(); theirs.srv.close();
}

console.log('\nwith no broker answering');
{
  // Port 1 is not a broker. The records outlive the broker, so a report of a fleet that is
  // currently down is a perfectly good thing to want — it falls back to the roster on disk
  // and says which of the two it used.
  const s = await S.fleetScope({ argv: [], env: { M59_STATE_FILE: rosterPath }, port: 1 });
  ok('it falls back to the roster on disk', s.filtered && s.characters.has('Kermit'));
  ok('and says so, rather than implying a live reading',
     /no broker answering/.test(s.from) && !/broker on/.test(s.from.replace('no broker answering', '')));
}

console.log('\nwhen it genuinely cannot tell');
{
  const s = await S.fleetScope({ argv: [], env: { M59_STATE_FILE: join(root, 'nope.json') }, port: 1 });
  ok('characters is NULL, so nothing is filtered', s.characters === null && s.filtered === false);
  ok('and it says why', /no readable roster/.test(s.from));
  const all = await S.fleetScope({ argv: [], allFleets: true });
  ok('--all-fleets is the same shape, asked for on purpose',
     all.characters === null && all.filtered === false && /--all-fleets/.test(all.from));
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
