#!/usr/bin/env node
import assert from 'node:assert/strict';
import { interest } from './m59-skills.mjs';

interest.byAgent.clear();
interest.declare('courier', { room: 38, character: 'Courier', farming: true,
  wants: ['herb'], needs: { herb: 20 }, spare: {} });
interest.declare('farmer-a', { room: 39, character: 'Kermit', farming: true,
  wants: ['herb', 'elderberry'], needs: { herb: 42, elderberry: 7 }, spare: {} });
interest.declare('farmer-b', { room: 39, character: 'Gonzo', farming: true,
  wants: ['herb'], needs: new Map([['herb', 12]]), spare: new Map() });
interest.declare('visitor', { room: 39, character: 'Visitor', farming: false,
  wants: ['herb'], needs: { herb: 99 }, spare: {} });

const room = interest.demandsForRoom(39, { except: 'courier' });
assert.deepEqual(room.map(row => row.agent), ['farmer-a', 'farmer-b']);
assert.deepEqual(room[0].needs, { herb: 42, elderberry: 7 });
assert.equal(room.some(row => row.character === 'Visitor'), false);
assert.deepEqual(interest.demandsForRoom(38, { except: 'courier' }), []);
assert.deepEqual(interest.board().find(row => row.agent === 'farmer-b').needs, { herb: 12 });

interest.byAgent.clear();
console.log('farm coordination: 5 assertions passed');
