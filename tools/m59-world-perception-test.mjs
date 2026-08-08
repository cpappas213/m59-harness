#!/usr/bin/env node
import assert from 'node:assert/strict';
import { World } from './m59-world.mjs';

const client = {
  selfId: 501,
  roomNameRsc: 700,
  roomRsc: 701,
  room: { id: 800, objects: new Map([
    [501, { id: 501, nameRsc: 900, col: 10, row: 11, x: 672, y: 736,
      angle: 1024, degrees: 90, appearanceRevision: 12, flags: 0, rarity: 4,
      light: { flags: 1, intensity: 24, color: 65535 },
      iconRsc: 950, translation: 2, effect: 0, animate: { animation: 1, group: 3 },
      overlays: [{ iconRsc: 952, hotspot: 3, translation: 7, effect: 0,
        animate: { animation: 1, group: 1 } }],
      motion: { translation: 4, effect: 0,
        animate: { animation: 2, period: 500, groupLow: 2, groupHigh: 6 },
        overlays: [{ iconRsc: 953, hotspot: -2, translation: 0, effect: 1,
          animate: { animation: 2, period: 100, groupLow: 2, groupHigh: 6 } }] } }],
    [600, { id: 600, nameRsc: 901, col: 12, row: 11, x: 800, y: 736,
      angle: 2048, degrees: 180, appearanceRevision: 21, flags: 0, rarity: 0,
      light: { flags: 0, intensity: 0, color: 0 },
      iconRsc: 951, translation: 0, effect: 0,
      animate: { animation: 2, period: 1200, groupLow: 1, groupHigh: 6 },
      overlays: [{ iconRsc: 999, hotspot: 0, translation: 0, effect: 0,
        animate: { animation: 3, period: 200, groupLow: 4, groupHigh: 6, groupFinal: 1 } }],
      motion: { translation: 0, effect: 0, animate: { animation: 1, group: 2 },
        overlays: [] } }],
  ]) },
  inventory: [],
  rsc: {
    has: id => [700, 900, 901, 950, 951, 952, 953].includes(id),
    get: id => ({ 700: 'Marion', 900: 'Kermit', 901: 'rat',
      950: 'bta.bgf', 951: 'rat.bgf', 952: 'helm.bgf', 953: 'swordov.bgf' })[id] || `<rsc ${id}>`,
  },
  vitals: () => ({ health: { value: 30, max: 30 } }),
};
Object.defineProperty(client, 'self', { get() { return this.room.objects.get(this.selfId); } });
const map = { rooms: {
  200: { num: 200, name: 'Marion', nameRsc: 700, roomRsc: 701,
    rows: 88, cols: 93, rooFile: 'marion.roo', roo: null },
} };

const before = JSON.stringify(client.room.objects.get(600));
const view = new World(client, map).perception();
assert.equal(view.projection, 'render');
assert.equal(view.room.num, 200);
assert.equal(view.you.col, 10);
assert.equal(view.you.x, 672);
assert.equal(view.you.y, 736);
assert.equal(view.you.angle, 1024);
assert.equal(view.you.appearance_revision, 12);
assert.equal(view.you.appearance.icon_resource, 'bta.bgf');
assert.equal(view.you.appearance.flags, 0);
assert.equal(view.you.appearance.rarity, 4);
assert.deepEqual(view.you.appearance.light, { flags: 1, intensity: 24, color: 65535 });
assert.equal(view.you.appearance.animation.group, 3);
assert.equal(view.you.appearance.overlays[0].icon_resource, 'helm.bgf');
assert.equal(view.you.appearance.motion.animation.period, 500);
assert.equal(view.you.appearance.motion.overlays[0].hotspot, -2);
assert.equal(view.you.appearance.motion.overlays[0].icon_resource, 'swordov.bgf');
assert.equal(view.objects.length, 1);
assert.equal(view.objects[0].id, 600);
assert.equal(view.objects[0].distance, 2);
assert.equal(view.objects[0].x, 800);
assert.equal(view.objects[0].facing_degrees, 180);
assert.equal(view.objects[0].appearance.icon_rsc, 951);
assert.equal(view.objects[0].appearance.icon_resource, 'rat.bgf');
assert.equal(view.objects[0].appearance.animation.group_low, 1);
assert.equal(view.objects[0].appearance.overlays[0].icon_resource, null,
  'unknown resource ids remain empty rather than becoming invented filenames');
assert.equal(view.objects[0].appearance.overlays[0].animation.group_final, 1);
assert.equal(new World(client, map).objects()[0].appearance, undefined,
  'tactical looks should not pay for render-only appearance data');
assert.deepEqual(view.exits, []);
assert.equal(JSON.stringify(client.room.objects.get(600)), before, 'render projection must not mutate protocol state');
console.log('m59 world render perception: 29 assertions passed, exact appearance and no pathfinding');
