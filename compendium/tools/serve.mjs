#!/usr/bin/env node
// serve.mjs -- static file server for reading the compendium locally.
//
//   node tools/serve.mjs [port]     default 8099, then open http://localhost:8099/

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const PORT = Number(process.argv[2] || 8099);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + p); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
// Loopback only. This is a reading tool for the person running it, and binding every
// interface — which is what listen(port) alone does — publishes the whole tree to
// whatever network the machine happens to be on. Nothing here is secret, but "I ran a
// local viewer" should not mean "I started a web server for the coffee shop".
}).listen(PORT, '127.0.0.1', () => console.log(`compendium on http://127.0.0.1:${PORT}/  (loopback only)`));
