#!/usr/bin/env node
// Can a simple agent just say "fight a spider" and have it work?
//
//   node tools/m59-broker.mjs --http 8899 &
//   node tools/m59-skills-test.mjs
//
// Exercises the composite skills end to end: escaping the Underworld if the character
// died last run, travelling to somewhere with monsters, one fight() call doing the
// whole engagement, and rest_up afterwards.
const URL = 'http://127.0.0.1:8899/';
let id = 0;
const call = async (name, args) => {
  const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
  const j = await r.json();
  const t = j.result.content[0].text;
  if (j.result.isError) throw new Error(`${name}: ${t}`);
  try { return JSON.parse(t); } catch { return t; }
};
const ok = (l, c, d = '') => console.log(`  ${c ? 'yes ' : 'NO  '} ${l}${d ? ' — ' + d : ''}`);

await call('join', { agent: 'f', account: 'agent1', password: 'agentpass1' });
let st = await call('status', { agent: 'f' });
console.log(`in ${st.where?.name ?? st.room.name}, health ${st.vitals.health?.value}/${st.vitals.health?.max}`);

// If we are in the Underworld we died last run — get out first, which is itself a test.
if (/underworld/i.test(st.room.name)) {
  console.log('\n--- we are dead; escaping the Underworld ---');
  const e = await call('escape_underworld', { agent: 'f' });
  ok('escaped', e.left, e.left ? `via ${e.via} -> ${e.arrived_in}` : e.reason);
  if (e.tried?.length) for (const t of e.tried) console.log(`     tried ${t.name}: ${t.why}`);
}

const v = await call('look', { agent: 'f' });
const targets = v.objects.filter(o => o.can.includes('attack'));
console.log(`\nin ${v.room.name}; attackable here: ${[...new Set(targets.map(t => t.name))].join(', ') || 'nothing'}`);

if (!targets.length) {
  console.log('nothing to fight here — travelling somewhere with monsters');
  const t = await call('travel', { agent: 'f', to: 'Valley of Ileria' });
  console.log(`  travel arrived=${t.arrived} ${t.reason || ''}`);
}

const v2 = await call('look', { agent: 'f' });
const names = [...new Set(v2.objects.filter(o => o.can.includes('attack')).map(o => o.name))];
console.log(`\nnow in ${v2.room.name}; can fight: ${names.join(', ') || 'nothing'}`);

if (names.length) {
  // The whole point: one call, a creature name, everything else handled.
  const word = names[0].split(' ').pop();
  console.log(`\n--- fight("${word}") ---`);
  const t0 = Date.now();
  const f = await call('fight', { agent: 'f', target: word });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  ok('engaged', f.fought, f.fought ? `${f.target}, ${f.rounds} rounds in ${secs}s` : f.reason);
  if (f.log) for (const l of f.log) console.log(`     ${l.stage}: ${JSON.stringify(l).slice(0, 120)}`);
  if (f.combat) { console.log('   combat:'); for (const m of f.combat.slice(-5)) console.log(`     ${m}`); }
  console.log(`   health ${f.health?.before?.value} -> ${f.health?.after?.value}`);
  ok('killed it', !!f.killed, f.killed ? '' : (f.note || '').slice(0, 90));
  if (f.killed) ok('looted the drops', (f.looted || []).length > 0,
                   (f.looted || []).map(x => x.name + (x.amount ? ` x${x.amount}` : '')).join(', ') || 'nothing dropped');
  if (f.died) console.log('   (we were killed)');

  console.log('\n--- rest_up ---');
  const r = await call('rest_up', { agent: 'f', max_seconds: 30 });
  ok('rested', r.rested !== undefined, `${JSON.stringify(r.vitals?.health)} after ${r.seconds ?? 0}s${r.note ? ' — ' + r.note : ''}`);
}

await call('leave', { agent: 'f' });
console.log('\ndone');
