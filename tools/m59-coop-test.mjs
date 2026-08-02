#!/usr/bin/env node
// Two agents, one broker, one room: can they see the space, walk it, talk, hand each
// other things, and agree on a split? Every step goes through the MCP tool surface,
// exactly as an agent would drive it — nothing here reaches past the broker except
// one admin teleport to put the two of them in the same room to begin with.
//
//   node tools/m59-broker.mjs --http 8899 &
//   node tools/m59-coop-test.mjs
//
// The item being traded shuttles back and forth, so this can be run repeatedly:
// whoever is holding it gives it to the other.
const URL = process.env.M59_BROKER || 'http://127.0.0.1:8899/';
import net from 'node:net';
let id = 0;
const call = async (name, args) => {
  const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
  const j = await r.json();
  const text = j.result.content[0].text;
  if (j.result.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
};
const admin = cmd => new Promise((res, rej) => {
  const s = net.connect(9998, '127.0.0.1'); let b = '', t;
  const fin = () => { clearTimeout(t); s.destroy(); res(b); };
  s.on('connect', () => { s.write(cmd + '\r\n'); t = setTimeout(fin, 800); });
  s.on('data', d => { b += d; clearTimeout(t); t = setTimeout(fin, 800); });
  s.on('error', rej);
});
const ok = (label, cond, detail = '') => console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);

const A = await call('join', { agent: 'alpha', account: 'agent1', password: 'agentpass1' });
const B = await call('join', { agent: 'beta',  account: 'agent2', password: 'agentpass2' });
console.log(`alpha in ${A.room.name}, beta in ${B.room.name}`);

// Put both in one room, as two players meeting would be.
const look0 = await call('look', { agent: 'alpha' });
const roomNum = look0.room.num;
const bId = (await call('status', { agent: 'beta' })).object_id;
const roomObj = look0.room.object_id;
console.log(`\nbringing beta (obj ${bId}) to ${look0.room.name} (room ${roomNum})`);
await admin(`send object ${roomObj ?? 0} NewHold what OBJECT ${bId} new_row INT ${Math.max(2, look0.you.row)} new_col INT ${Math.max(2, look0.you.col)}`);
await new Promise(r => setTimeout(r, 2000));

console.log('\n--- perception ---');
const va = await call('look', { agent: 'alpha' });
ok('alpha identifies the room in the world graph', va.room.num != null, `${va.room.name} (${va.room.num})`);
ok('alpha has a minimap', !!va.minimap?.text, `${va.minimap?.size?.rows}x${va.minimap?.size?.cols}, ${va.minimap?.size?.walkable} walkable`);
ok('alpha has the wall map the client draws', !!va.minimap?.walls, JSON.stringify(va.minimap?.wall_summary));
ok('alpha sees exits with squares to stand on', va.exits.length > 0,
   va.exits.filter(e => e.kind !== 'locked_door').map(e => `${e.kind}->${e.to_name}`).slice(0, 3).join(', '));
const beta = va.objects.find(o => o.id === bId);
ok('alpha sees beta as a player', !!beta && beta.is_player,
   beta ? `${beta.name} at (${beta.col},${beta.row}) ${beta.distance} away, relation=${beta.relation}` : 'not visible');
if (beta) ok('alpha knows whether beta is reachable', beta.reachable != null,
             `reachable=${beta.reachable} steps=${beta.steps_to_reach}`);

console.log('\nMINIMAP as alpha sees it:');
console.log(va.minimap.text);
for (const [ch, what] of Object.entries(va.minimap.legend).slice(0, 12)) console.log(`  ${ch}  ${what}`);

console.log('\n--- movement through geometry ---');
if (beta && beta.stand_on) {
  const w = await call('walk_to', { agent: 'alpha', col: beta.stand_on.col, row: beta.stand_on.row });
  ok('alpha walked to beta through the room geometry', w.arrived, `${w.steps} steps${w.replans ? `, ${w.replans} replans` : ''}`);
}

console.log('\n--- trading ---');
const invA = await call('inventory', { agent: 'alpha' });
const invB = await call('inventory', { agent: 'beta' });
console.log(`  alpha carries: ${invA.items.map(i => i.name).join(', ') || '(nothing)'}`);
console.log(`  beta  carries: ${invB.items.map(i => i.name).join(', ') || '(nothing)'}`);
// Whoever is holding something gives it to the other, so the test works in either
// direction and can be run repeatedly — the item just shuttles back and forth.
const giver = invA.items.length ? 'alpha' : 'beta';
const taker = giver === 'alpha' ? 'beta' : 'alpha';
const takerId = giver === 'alpha' ? bId : (await call('status', { agent: 'alpha' })).object_id;
const stock = giver === 'alpha' ? invA : invB;
if (!stock.items.length) {
  console.log('  (neither has anything to give — skipping)');
} else {
  const give = stock.items[0];
  console.log(`  ${giver} gives "${give.name}" to ${taker}`);
  const off = await call('trade', { agent: giver, action: 'offer', to: takerId, items: [give.id] });
  ok(`${giver} offered an item`, off.offered, off.on_the_table.map(i => i.name).join(', ') || off.note);

  const heard = await call('wait_for_event', { agent: taker, kinds: ['offered-to-us'], timeout_ms: 5000 });
  const ev = heard.events.find(e => e.kind === 'offered-to-us');
  ok(`${taker} was told about the offer`, !!ev,
     ev ? `${ev.withName} offers ${ev.theirs.map(i => i.name).join(', ')}` : 'nothing arrived');

  const cnt = await call('trade', { agent: taker, action: 'counter', items: [] });
  ok(`${taker} countered with nothing (that is how a gift is accepted)`, cnt.countered, cnt.note);

  const st = await call('trade', { agent: giver, action: 'status' });
  ok(`${giver} may now accept`, !!st.trade?.mayAccept, `mayAccept=${st.trade?.mayAccept}`);

  const acc = await call('trade', { agent: giver, action: 'accept' });
  ok(`${giver} accepted`, acc.accepted, `carried ${acc.carried_before} -> ${acc.carried_after}`);

  await new Promise(r => setTimeout(r, 1200));
  const after = await call('inventory', { agent: taker });
  const got = after.items.find(i => i.name === give.name);
  ok(`${taker} actually received the item`, !!got, after.items.map(i => i.name).join(', ') || '(nothing)');
}

console.log('\n--- splitting loot ---');
const plan = await call('split', { agent: 'alpha', between: ['alpha', 'beta'], items: [
  { id: 111, name: 'coins', amount: 100, value: 1 },
  { id: 222, name: 'long sword', value: 40 },
  { id: 333, name: 'shield', value: 25 },
]});
ok('a 50/50 split was computed', plan.allocation.length === 2,
   plan.allocation.map(x => `${x.who}: ${x.got_share} (${x.items.map(i => i.name + (i.amount ? ' x' + i.amount : '')).join(', ')})`).join(' | '));

console.log('\n--- navigation ---');
const nav = await call('map', { agent: 'alpha', to: 'Yonder Inn of Jasper' }).catch(e => ({ error: String(e.message).slice(0, 120) }));
if (nav.route) ok('a route to a distant room was found', nav.route.found,
                  nav.route.found ? `${nav.route.hops.length} hops to ${nav.destination.name}` : nav.route.reason);
else console.log('  route lookup:', nav.error || JSON.stringify(nav).slice(0, 120));

await call('leave', { agent: 'alpha' });
await call('leave', { agent: 'beta' });
console.log('\ndone');
