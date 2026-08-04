#!/usr/bin/env node
// THE COMPENDIUM, SERVED LOCALLY, WITH A REAL CHARACTER IN IT.
//
//   node tools/m59-compendium.mjs                     serve, print the URL
//   node tools/m59-compendium.mjs --open              ...and open a browser
//   node tools/m59-compendium.mjs --open --agent t1   ...as that character
//   node tools/m59-compendium.mjs --status            is it already up?
//
// The compendium is static HTML and its bestiary already recalculates every row
// against a reference character — but the reference character is a preset you type in
// by hand, and the fleet is right there. So this serves the tree and adds one endpoint
// that hands the page a live character.
//
// LOOPBACK ONLY, and that is not a default to be talked out of. The pages are
// harmless, but this process reads the broker on behalf of whoever asks, so anything
// that can reach it can enumerate the fleet's characters, their equipment and their
// levels. `compendium/tools/serve.mjs` binds every interface, which is fine for a
// static tree and would not be fine here.
//
// WHY A COOKIE. The alternative is a query string, and a query string is in every
// link the reader clicks afterwards, in their history, and in the address bar of a
// screenshot. A cookie is set once by /_import and then applies to every page of the
// compendium as they browse it — which is the actual requirement, because "your
// character" should still be selected three creatures later. It is scoped to this
// origin, is not HttpOnly on purpose (the page's own JavaScript is what reads it), and
// carries only what the bestiary needs to do the arithmetic.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// The server's own names for the weapon proficiencies. Imported rather than duplicated:
// seven of the eight were invented until recently, and a second copy is how that comes
// back.
import { proficiencyFor as profFor } from './m59-skills.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const ROOT = path.join(REPO, 'compendium');

export const COMPENDIUM_PORT = Number(process.env.M59_COMPENDIUM_PORT || 8099);
const BROKER_PORT = process.env.M59_BROKER_PORT || '8901';
const BROKER = `http://127.0.0.1:${BROKER_PORT}/`;
export const COOKIE = 'm59char';

// Identifies THIS server rather than whatever else is on the port. The broker learned
// the same lesson: a port answering is not the same as the thing you wanted answering,
// and starting a second copy of something is how a fleet gets held by a process nobody
// is talking to.
const IDENT = 'm59-compendium';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

// ------------------------------------------------------------------- the broker

async function broker(name, args = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(BROKER, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name, arguments: args } }),
    });
    const j = await r.json();
    if (j.result?.isError) throw new Error(j.result.content[0].text);
    return JSON.parse(j.result.content[0].text);
  } finally { clearTimeout(t); }
}

// ------------------------------------------------- a character, as the page wants it
//
// The bestiary's "build" is a fixed shape — six attributes, five combat skills, a
// weapon class and one armour class per slot — and every field of it exists on a live
// character. This is the translation, and the interesting part is that most of it can
// go wrong quietly, so each field records where it came from.

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The compendium names gear by its kod CLASS and shows a display name; the wire gives
// us only the display name. Match on that, normalised, because "chain armor" on the
// wire and "chain armor" in the table differ by whatever punctuation either side felt
// like. An unmatched item is reported rather than dropped — the reader can see that
// their plate mail was not modelled, which a silently empty slot would hide.
// DISPLAY NAME FIRST, class second, and in two full passes rather than one combined
// test. The two vocabularies overlap: `Helm` is the CLASS of "magic spirit helmet",
// while the item actually called "helm" has the class `SimpleHelm`. A single pass that
// accepted either would match a plain helm to the magic one — the first entry whose
// class happened to spell the same word — and quietly compute the whole table against
// the wrong defence bonus.
//
// The wire only ever gives us display names, so that is the authoritative side; the
// class match is a convenience for anything that passes one deliberately.
function matchGear(data, name) {
  const want = norm(name);
  if (!want) return null;
  const passes = [(x) => norm(x.name) === want, (x) => norm(x.cls) === want];
  for (const hit of passes) {
    for (const w of data.weapons || [])
      if (hit(w)) return { kind: 'weapon', cls: w.cls, name: w.name };
    for (const slot of Object.keys(data.armour || {}))
      for (const a of data.armour[slot] || [])
        if (hit(a)) return { kind: 'armour', slot, cls: a.cls, name: a.name };
  }
  return null;
}

// WHICH STROKE THE CHARACTER WOULD ACTUALLY SWING. The build carries one number and
// the character has up to four, so this picks the one that applies to what is in its
// hand: `fire` for a bow, the better of slash and thrust for anything else, and
// Unarmed Combat for an empty hand. Reported, because "we used your thrust" is a
// claim about the numbers on the page.
function pickStroke(abilityByName, weaponName) {
  const get = (n) => abilityByName[norm(n)] ?? null;
  const ranged = /bow|crossbow|sling/i.test(weaponName || '');
  if (!weaponName) {
    const u = get('Unarmed Combat');
    return { key: 'Unarmed Combat', value: u ?? 0, known: u !== null };
  }
  if (ranged) { const f = get('fire'); return { key: 'fire', value: f ?? 0, known: f !== null }; }
  const slash = get('slash'), thrust = get('thrust');
  if (slash === null && thrust === null) return { key: 'slash', value: 0, known: false };
  return (thrust ?? -1) > (slash ?? -1)
    ? { key: 'thrust', value: thrust, known: true }
    : { key: 'slash', value: slash ?? 0, known: slash !== null };
}

export function buildFromCharacter({ status, equipment, abilities, data }) {
  // Abilities by normalised name, from the broker's cached record — the numbers it
  // keeps current from the server's own pushes rather than re-reading here.
  const abilityByName = {};
  for (const row of [...(abilities?.skills || []), ...(abilities?.spells || [])])
    if (row?.name) abilityByName[norm(row.name)] = row.ability;
  const get = (n) => abilityByName[norm(n)] ?? null;

  // Attributes. `status` reports them under their own names; they are fixed at
  // creation and never move, so there is nothing to keep current.
  const attr = status?.attributes ?? status?.stats ?? {};
  const statOf = (k) => {
    const v = attr[k] ?? attr[k?.toLowerCase()];
    return Number.isFinite(v) ? v : (Number.isFinite(v?.value) ? v.value : 0);
  };

  const equipped = (equipment?.equipped || []).map(e => e.name).filter(Boolean);
  const matched = equipped.map(n => ({ name: n, hit: matchGear(data, n) }));
  const weapon = matched.find(m => m.hit?.kind === 'weapon')?.hit ?? null;
  const gear = {};
  const worn = [];
  for (const m of matched) {
    if (m.hit?.kind !== 'armour') continue;
    // One item per slot, first wins. Two things in one slot is possible in kod
    // (CanBeWornInSameSlotWith) and the bestiary has no way to express it, so say so
    // rather than pick silently.
    if (gear[m.hit.slot]) { worn.push({ ...m.hit, ignored: 'the bestiary models one item per slot' }); continue; }
    gear[m.hit.slot] = m.hit.cls;
    worn.push(m.hit);
  }
  const unmatched = matched.filter(m => !m.hit).map(m => m.name);

  const stroke = pickStroke(abilityByName, weapon?.name ?? null);
  // The proficiency for what is actually held. profFor is the server's own names now;
  // it used to invent them, and every lookup missed.
  const profName = weapon ? profFor(weapon.name) : null;
  const prof = profName ? get(profName) : get('brawling');

  const health = status?.health ?? status?.vitals?.health ?? null;
  const maxHealth = health?.max ?? health?.currentMax ?? status?.max_health ?? 1;

  const missing = [];
  if (!stroke.known) missing.push(`stroke (${stroke.key})`);
  if (prof === null) missing.push(profName ? `proficiency (${profName})` : 'brawling');
  for (const k of ['parry', 'block', 'dodge']) if (get(k) === null) missing.push(k);

  return {
    id: 'live',
    name: `${status?.character ?? 'character'} (live)`,
    live: true,
    mode: 'detailed',
    maxHealth,
    stats: {
      might: statOf('might'), agility: statOf('agility'), stamina: statOf('stamina'),
      intellect: statOf('intellect'), mysticism: statOf('mysticism'), aim: statOf('aim'),
    },
    skills: {
      stroke: stroke.value ?? 0,
      proficiency: prof ?? 0,
      parry: get('parry') ?? 0,
      block: get('block') ?? 0,
      dodge: get('dodge') ?? 0,
      // calc.mjs falls back to these when the hand is empty, and having them means an
      // unarmed character is modelled as unarmed rather than as a swordsman with no sword.
      brawling: get('brawling') ?? 0,
      punch: get('Unarmed Combat') ?? 0,
    },
    weapon: weapon?.cls ?? '',
    gear,
    // WHAT WE USED AND WHAT WE COULD NOT. The page shows this, because a table of
    // numbers computed from a guess must not look like one computed from a reading.
    from: {
      character: status?.character ?? null,
      agent: status?.agent ?? null,
      at: Date.now(),
      equipped,
      weapon: weapon?.name ?? null,
      worn: worn.map(w => w.name),
      stroke: stroke.key,
      proficiency: profName,
      unmatched_gear: unmatched,
      missing_skills: missing,
      abilities_age_ms: abilities?.freshness?.age_ms ?? null,
    },
  };
}

// ------------------------------------------------------------------- the server

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  // Path traversal: normalise FIRST, then check, or "/../../substrate/fleets/prod.json"
  // walks straight out of the tree and hands over the account passwords.
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('outside the compendium'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + p); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function characterBuild(agent) {
  const [status, equipment, ability] = await Promise.all([
    broker('status', { agent, brief: true }),
    broker('equipment', { agent }),
    broker('abilities', { agent, known_only: false }),
  ]);
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'creatures.json'), 'utf8'));
  return buildFromCharacter({
    status: { ...status, agent, character: status?.character ?? status?.name ?? agent },
    equipment,
    abilities: { skills: ability?.skills, spells: ability?.spells, freshness: ability?.freshness },
    data,
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/_health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ident: IDENT, pid: process.pid, root: ROOT }));
    }

    // THE HANDOVER. Fetch the character, set the cookie, and send the reader on to the
    // page they actually wanted. A redirect rather than a rendered page so that the
    // address bar ends up on /creatures/ — the reader can then reload, bookmark and
    // navigate normally, and the cookie follows them.
    if (url.pathname === '/_import') {
      const agent = url.searchParams.get('agent');
      const to = url.searchParams.get('to') || '/creatures/';
      // Only ever a path within this origin. An open redirect on a loopback server is
      // still an open redirect, and this one would carry the cookie.
      const dest = to.startsWith('/') && !to.startsWith('//') ? to : '/creatures/';
      if (!agent) { res.writeHead(400).end('need ?agent='); return; }
      try {
        const build = await characterBuild(agent);
        const value = encodeURIComponent(JSON.stringify(build));
        res.writeHead(302, {
          location: dest,
          // Session cookie, this origin, path-wide. SameSite=Lax is enough: nothing
          // here is a state change, and Strict would drop it on the redirect itself in
          // some browsers.
          'set-cookie': `${COOKIE}=${value}; Path=/; SameSite=Lax; Max-Age=86400`,
          'cache-control': 'no-store',
        });
        return res.end();
      } catch (e) {
        res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<h1>could not read ${agent}</h1><p>${e.message}</p>` +
                       `<p>The compendium itself is fine — <a href="${dest}">carry on without a character</a>. ` +
                       `This needs the broker on ${BROKER_PORT} with that agent in game.</p>`);
      }
    }

    // Same data, without the cookie, for anything that would rather fetch it.
    if (url.pathname === '/_character') {
      const agent = url.searchParams.get('agent');
      if (!agent) { res.writeHead(400).end('need ?agent='); return; }
      try {
        const build = await characterBuild(agent);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(build, null, 1));
      } catch (e) {
        res.writeHead(502, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    if (url.pathname === '/_forget') {
      res.writeHead(302, { location: url.searchParams.get('to') || '/creatures/',
                           'set-cookie': `${COOKIE}=; Path=/; Max-Age=0` });
      return res.end();
    }

    serveStatic(req, res, url.pathname);
  });
}

// Is one already up, and is it OURS? A port that answers is not the same as the thing
// you wanted answering.
export async function probe(port = COMPENDIUM_PORT, ms = 1200) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/_health`, { signal: ctl.signal });
    const j = await r.json();
    return j?.ident === IDENT ? j : { foreign: true };
  } catch { return null; }
  finally { clearTimeout(t); }
}

// Start one if there is not one already. Returns how it went, so a caller can say
// "started it" or "it was already up" rather than guessing.
export async function ensureServing(port = COMPENDIUM_PORT) {
  const up = await probe(port);
  if (up && !up.foreign) return { already: true, pid: up.pid, port };
  if (up?.foreign)
    throw new Error(`something else is already listening on ${port} — set M59_COMPENDIUM_PORT`);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--port', String(port)],
                      { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  // Wait for it rather than assuming: a browser opened against a socket that is not
  // listening yet shows an error page, and the reader reads that as the key not working.
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 150));
    const ok = await probe(port, 400);
    if (ok && !ok.foreign) return { started: true, pid: ok.pid, port };
  }
  throw new Error(`started a compendium server on ${port} but it never answered /_health`);
}

// The default browser, on whichever platform this is.
export function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32'
    // `start` is a cmd builtin, and the empty string is the window TITLE — without it
    // cmd treats a quoted URL as the title and opens nothing at all.
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return `${cmd} ${args.join(' ')}`;
}

export const importUrl = (agent, to = '/creatures/', port = COMPENDIUM_PORT) =>
  `http://127.0.0.1:${port}/_import?agent=${encodeURIComponent(agent)}&to=${encodeURIComponent(to)}`;

// ---------------------------------------------------------------------- cli
if (process.argv[1] && path.basename(process.argv[1]) === 'm59-compendium.mjs') {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const port = Number(arg('--port', COMPENDIUM_PORT));
  const agent = arg('--agent', null);
  const to = arg('--to', '/creatures/');

  if (argv.includes('--status')) {
    const up = await probe(port);
    console.log(up ? (up.foreign ? `port ${port}: something else is listening`
                                 : `up — pid ${up.pid} on http://127.0.0.1:${port}/`)
                   : `not running on ${port}`);
    process.exit(up && !up.foreign ? 0 : 1);
  }

  if (argv.includes('--open') && !argv.includes('--serve')) {
    const how = await ensureServing(port);
    const url = agent ? importUrl(agent, to, port) : `http://127.0.0.1:${port}${to}`;
    openBrowser(url);
    console.log(`${how.already ? 'already serving' : 'started'} on ${port} (pid ${how.pid}); opened ${url}`);
    process.exit(0);
  }

  createServer().listen(port, '127.0.0.1', () => {
    console.log(`compendium on http://127.0.0.1:${port}/  (loopback only)`);
    if (agent) {
      const url = importUrl(agent, to, port);
      if (argv.includes('--open')) openBrowser(url);
      console.log(`character import: ${url}`);
    }
  });
}
