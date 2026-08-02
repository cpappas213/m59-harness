#!/usr/bin/env node
// build.mjs -- the whole pipeline, in order.
//
//   node tools/build.mjs           parse kod, decode sprites, generate the site
//   node tools/build.mjs --fast    skip sprite decoding (it is slow and rarely changes)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const fast = process.argv.includes('--fast');

const steps = [
  ['kodparse.mjs', []],
  ...(fast ? [] : [['bgf.mjs', ['all']]]),
  ...fs.readdirSync(HERE).filter((f) => f.startsWith('extract-') && f.endsWith('.mjs')).map((f) => [f, []]),
  ['gen.mjs', []],
];

for (const [script, args] of steps) {
  const p = path.join(HERE, script);
  if (!fs.existsSync(p)) continue;
  process.stdout.write(`\n── ${script} ${args.join(' ')}\n`);
  try {
    process.stdout.write(execFileSync(process.execPath, [p, ...args], { encoding: 'utf8' }));
  } catch (e) {
    process.stdout.write((e.stdout || '') + (e.stderr || ''));
    process.exitCode = 1;
    console.error(`   ${script} failed`);
  }
}
