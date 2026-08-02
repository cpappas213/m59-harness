#!/usr/bin/env node
// Hand a character to the keeper and walk away. Does it stay alive and get work done
// with nobody driving it?
//
//   node tools/m59-broker.mjs --http 8899 &
//   node tools/m59-autopilot-test.mjs
//
// Starts farm mode, then deliberately does NOTHING for three minutes — the point is
// what happens without a model in the loop — and reports the keeper's own journal.
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

await call('join', { agent: 'p', account: 'agent1', password: 'agentpass1' });
let v = await call('look', { agent: 'p' });
console.log(`in ${v.room.name}, health ${v.vitals.health?.value}/${v.vitals.health?.max}`);

// Make sure there is something to hunt where we are standing.
let names = [...new Set(v.objects.filter(o => o.can.includes('attack')).map(o => o.name))];
if (!names.length) {
  console.log('no monsters here — travelling to Valley of Ileria');
  await call('travel', { agent: 'p', to: 'Valley of Ileria' });
  v = await call('look', { agent: 'p' });
  names = [...new Set(v.objects.filter(o => o.can.includes('attack')).map(o => o.name))];
}
console.log(`can hunt: ${names.join(', ') || 'nothing'}`);
if (!names.length) { console.log('nowhere to test'); process.exit(0); }

const quarry = names[0].split(' ').pop();
const before = await call('inventory', { agent: 'p' });
console.log(`\nhanding over: farm "${quarry}". carrying ${before.items.length} items.`);

const started = await call('autopilot', { agent: 'p', action: 'start', mode: 'farm', hunt: quarry, max_carry: 20, roam: true, roam_limit: 5 });
ok('keeper started', started.running, `mode=${started.mode} hunting "${started.policy.hunt}" roam=${started.policy.roam}`);

// Now do nothing at all for a while, as an absent model would.
console.log('\n--- not touching it for 3 minutes ---');
for (let i = 0; i < 6; i++) {
  await sleep(30000);
  const st = await call('autopilot', { agent: 'p', action: 'status' });
  const last = st.recent.at(-1);
  console.log(`  +${(i + 1) * 30}s  pass ${st.passes}: ${last?.what ?? '-'} ${JSON.stringify(last ?? {}).slice(0, 110)}`);
}

const st = await call('autopilot', { agent: 'p', action: 'status', full_journal: true });
const after = await call('inventory', { agent: 'p' });
const kills = st.recent.filter(e => e.what === 'killed').length;
console.log('\n--- what it did unattended ---');
console.log('  summary:', JSON.stringify(st.did));
for (const e of (st.journal||st.recent)) console.log(`  ${e.what}: ${JSON.stringify(e).slice(0,120)}`);
ok('made passes without being driven', st.passes > 1, `${st.passes} passes`);
ok('never crashed', !st.last_error, st.last_error || '');
ok('picked things up', after.items.length >= before.items.length,
   `carrying ${before.items.length} -> ${after.items.length}: ${after.items.map(i => i.name + (i.amount ? ` x${i.amount}` : '')).join(', ')}`);

await call('autopilot', { agent: 'p', action: 'stop' });
await call('leave', { agent: 'p' });
console.log('\ndone');
