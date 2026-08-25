// THE ROOM YOU ARE STANDING IN, DRAWN, ON A URL A GAME CLIENT CAN OPEN.
//
//   node tools/m59-roomserve.mjs                 serve on 8977
//   node tools/m59-roomserve.mjs --port 9100
//   node tools/m59-roomserve.mjs --fleet shadow  whose ledgers to draw on top
//
//   http://127.0.0.1:8977/108                    the room, by number
//   http://127.0.0.1:8977/                       an index of every room with a baked route
//   http://127.0.0.1:8977/here?agent=shadow01    wherever that character is right now
//
// WHY A SERVER AND NOT A FILE. `m59-roomview.mjs` writes an HTML file, which is the right
// shape for "go and look at Ukgoth" and the wrong one for "I am standing somewhere odd and
// want to see it NOW" -- by the time you have found the room number, run the tool and opened
// the file, the thing you were looking at has moved. The debug client's help button points
// here, so "what does the harness think of this room?" is one keypress from inside the game.
//
// GENERATED ON DEMAND AND CACHED ON THE LEDGERS' MTIME. Drawing a room is about a second of
// work and the ledgers move constantly, so a cache keyed on "has anything been written
// since" gives a fresh picture without redrawing on every refresh.
//
// LOOPBACK ONLY, and that is not decoration: these pages carry positions, refusals and death
// sites for a live fleet. `m59-roomview.mjs` redacts character names; it does not make the
// rest of it fit to publish. Bind to localhost and leave it there.

import http from 'node:http';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRoom, renderPage } from './m59-roomview.mjs';
import { fleetName } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const PORT = Number(flag('port', 8977));
const FLEET = flag('fleet', null) ?? fleetName();

if (argv.includes('--help')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

// The newest mtime across everything a page is drawn from. Cheap, and it changes exactly
// when the picture would change.
function ledgerStamp() {
  let newest = 0;
  for (const p of ['substrate/transits', 'substrate/tactics', 'substrate/m59-routes.json',
                   'substrate/m59-map.json', 'substrate/m59-safespots.json']) {
    const full = join(REPO, p);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        for (const f of readdirSync(full)) {
          const s2 = statSync(join(full, f));
          if (s2.mtimeMs > newest) newest = s2.mtimeMs;
        }
      } else if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch { /* a missing ledger is a thinner picture, not an error */ }
  }
  return newest;
}

const cache = new Map();

function pageFor(room) {
  const stamp = ledgerStamp();
  const hit = cache.get(room);
  if (hit && hit.at === stamp) return hit.html;
  const data = collectRoom(room, { fleets: FLEET ? [FLEET] : null });
  const html = renderPage(data);
  cache.set(room, { at: stamp, html });
  return html;
}

function roomsWithRoutes() {
  try {
    const t = JSON.parse(readFileSync(join(REPO, 'substrate', 'm59-routes.json'), 'utf8'));
    const m = JSON.parse(readFileSync(join(REPO, 'substrate', 'm59-map.json'), 'utf8'));
    return Object.keys(t.rooms ?? {})
      .map(Number).filter(Number.isFinite)
      .map(n => ({ num: n, name: m.rooms?.[String(n)]?.name ?? ('room ' + n),
                   routes: Object.keys(t.rooms[String(n)]?.routes ?? {}).length }))
      .sort((a, b) => a.num - b.num);
  } catch { return []; }
}

// Where a character is, so the client can ask for "here" without knowing a room number.
async function whereIs(agent, port) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                                params: { name: 'fleet', arguments: {} } });
  return await new Promise(done => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 8000 }, res => {
      let t = '';
      res.on('data', c => { t += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(JSON.parse(t).result.content[0].text);
          const row = (j.fleet ?? []).find(c => c.agent === agent || c.character === agent);
          done(row?.room_num ?? null);
        } catch { done(null); }
      });
    });
    req.on('error', () => done(null));
    req.on('timeout', () => { req.destroy(); done(null); });
    req.end(body);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const send = (code, type, body) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  try {
    if (url.pathname === '/here') {
      const agent = url.searchParams.get('agent');
      const brokerPort = Number(url.searchParams.get('broker') ?? 8971);
      const room = agent ? await whereIs(agent, brokerPort) : null;
      if (room == null) {
        return send(404, 'text/plain; charset=utf-8',
          'cannot tell where "' + (agent ?? '(no agent given)') + '" is - ask /<room> directly');
      }
      res.writeHead(302, { location: '/' + room });
      return res.end();
    }
    const m = url.pathname.match(/^\/(\d+)$/);
    if (m) return send(200, 'text/html; charset=utf-8', pageFor(Number(m[1])));
    if (url.pathname === '/') {
      const rows = roomsWithRoutes();
      const style = 'body{font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;background:#14161a;'
                  + 'color:#d8dee9;margin:2rem}a{color:#8fb7ff;text-decoration:none}'
                  + 'a:hover{text-decoration:underline}td{padding:.15rem .8rem .15rem 0}';
      return send(200, 'text/html; charset=utf-8',
        '<title>Rooms</title><meta name=viewport content="width=device-width,initial-scale=1">'
        + '<style>' + style + '</style>'
        + '<h2>rooms with a baked route - fleet "' + (FLEET ?? '(unnamed)') + '"</h2><table>'
        + rows.map(r => '<tr><td><a href="/' + r.num + '">' + r.num + '</a></td><td>'
                      + r.name + '</td><td>' + r.routes + ' route(s)</td></tr>').join('')
        + '</table>');
    }
    send(404, 'text/plain; charset=utf-8', 'try / or /<room number>, e.g. /108');
  } catch (e) {
    send(500, 'text/plain; charset=utf-8', 'could not draw that room: ' + e.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('room views on http://127.0.0.1:' + PORT + '/   (fleet "' + (FLEET ?? '(unnamed)') + '")');
  console.log('  /108  a room     /  the index     /here?agent=shadow01  wherever it is now');
});
