#!/usr/bin/env node
// Max out a character on a local Meridian 59 server.
//
//   node tools/m59-godmode.mjs <playerObjectId> [ability] [hp] [mana] [shillings]
//   node tools/m59-godmode.mjs 4559 99 100 100 1000000
//
// Development convenience for a single-player instance you own. Everything here
// goes through the ordinary admin socket; nothing bypasses the game's own rules
// beyond passing bDM, which is the flag the game itself uses for DM grants.
//
// Spell and skill ids come from kod/include/*.khd (SID_* / SKID_*) rather than a
// hardcoded range, so gaps in the numbering are skipped instead of generating
// failures.

import net from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const HOST = process.env.M59_HOST || '127.0.0.1';
const PORT = Number(process.env.M59_PORT || 9998);
const M59  = process.env.M59_ROOT || 'C:/code/meridian59';

const [objArg, abArg, hpArg, mpArg, moneyArg] = process.argv.slice(2);
const OBJ     = Number(objArg);
const ABILITY = Number(abArg    ?? 99);
const HP      = Number(hpArg    ?? 100);
const MANA    = Number(mpArg    ?? 100);
const MONEY   = Number(moneyArg ?? 1_000_000);

if (!OBJ) {
  console.error('usage: m59-godmode.mjs <playerObjectId> [ability] [hp] [mana] [shillings]');
  process.exit(1);
}

// ------------------------------------------------------------- id discovery

function ids(prefix) {
  const dir = join(M59, 'kod', 'include');
  const found = new Set();
  for (const f of readdirSync(dir).filter(x => x.endsWith('.khd'))) {
    const txt = readFileSync(join(dir, f), 'utf8');
    for (const m of txt.matchAll(new RegExp(`${prefix}_[A-Z_0-9]+\\s*=\\s*(\\d+)`, 'g')))
      found.add(Number(m[1]));
  }
  return [...found].sort((a, b) => a - b);
}

const spells = ids('SID');
const skills = ids('SKID');

// ------------------------------------------------------------------ plumbing

// One long-lived connection. The maintenance session consumes a byte at a time
// and acts on newline, so commands are paced rather than dumped.
function runAll(cmds, gap = 70) {
  return new Promise((resolve, reject) => {
    const s = net.connect(PORT, HOST);
    let buf = '';
    s.on('connect', () => {
      let i = 0;
      const t = setInterval(() => {
        if (i < cmds.length) {
          if (i % 25 === 0) process.stderr.write(`  ${i}/${cmds.length}\r`);
          s.write(cmds[i++] + '\r\n');
        } else {
          clearInterval(t);
          setTimeout(() => s.end(), 2500);
        }
      }, gap);
    });
    s.on('data', d => buf += d);
    s.on('close', () => resolve(buf));
    s.on('error', reject);
  });
}

// ------------------------------------------------------------------ commands

const cmds = [];

// Health and mana. Max and base-max must move too, or the game refigures the
// current value straight back down.
for (const [prop, val] of [
  ['piHealth', HP], ['piMax_Health', HP], ['piBase_Max_Health', HP],
  ['piMana', MANA], ['piMax_Mana', MANA],
]) cmds.push(`set object ${OBJ} ${prop} INT ${val}`);

// Every spell and skill at the requested ability. bDM is the flag the game's own
// DM grants use, which skips the normal prerequisite checks.
for (const n of spells) cmds.push(`send object ${OBJ} AddSpell num INT ${n} iability INT ${ABILITY} bDM INT 1`);
for (const n of skills) cmds.push(`send object ${OBJ} AddSkill num INT ${n} iability INT ${ABILITY} bDM INT 1`);

console.error(`object ${OBJ}: hp/mana ${HP}/${MANA}, ` +
  `${spells.length} spells + ${skills.length} skills at ${ABILITY}, ${MONEY.toLocaleString()} shillings`);
console.error(`${cmds.length} commands...`);

const out = await runAll(cmds);

// Money is an item of class Money held in inventory, counted by piNumber, so it
// is found (or created) rather than set as a property on the player.
const moneyOut = await runAll([`send object ${OBJ} GetMoneyObject`], 200);
const mObj = (moneyOut.match(/OBJECT (\d+)\s*\n?\s*:\s*is CLASS Money/) ||
              moneyOut.match(/OBJECT (\d+)/) || [])[1];

let moneyReport;
if (mObj) {
  await runAll([`set object ${mObj} piNumber INT ${MONEY}`], 200);
  moneyReport = `money object ${mObj} set to ${MONEY.toLocaleString()}`;
} else {
  const created = await runAll([`create object Money number INT ${MONEY}`], 300);
  const newObj = (created.match(/OBJECT (\d+)/) || [])[1];
  if (newObj) {
    await runAll([`send object ${OBJ} NewHold what OBJECT ${newObj}`], 200);
    moneyReport = `created money object ${newObj} with ${MONEY.toLocaleString()}`;
  } else moneyReport = `could not create money:\n${created}`;
}

// Report only what went wrong; 200 success lines are noise.
const bad = out.split(/\r?\n/).filter(l =>
  /can't handle|not a valid|invalid|Cannot find|should be an int|no access/i.test(l));

console.log(`\n${moneyReport}`);
console.log(bad.length ? `\n${bad.length} rejected:\n${[...new Set(bad)].slice(0, 12).join('\n')}`
                       : '\nno rejections');
