// Wander a few cells when no mobs are around, one step at a time, stopping at the
// first wall, void, or ledge edge.
//
// This is a helper, NOT an atomic, so it lives outside tools/m59-act/ (the act-test
// sweep requires every file there to export a tagged atomic). The scavenge atomic calls
// it. Fire-and-forget: we send a moveToSquare and let the game's fine-grid collision do
// the real work.
//
// Height matters here: a wander step that drops off a ledge is a fall the character can't
// climb back from. We gate each step on walkability AND floor height, using the room
// geometry's heightStepOk (the game's 384-unit climb limit). Flat rooms have all-equal
// heights so this is a no-op there.
//
// Note: MOVE packets carry x=col, y=row in fine units; z/height is not sent, so we read
// it from the geometry. moveToSquare takes (col, row).
// heightStepOk is ours and lives in m59-navgeom.mjs, which installs it onto
// RoomGeometry. Imported here for the side effect rather than relying on whichever
// caller happened to load it first — this file takes its geometry from a caller and
// would otherwise fail only on the branch that reads a ledge.
import './m59-navgeom.mjs';

export function wanderAway(client, session) {
  try {
    const room = client?.room;
    const self = room?.objects instanceof Map
      ? [...room.objects.values()].find(o => o.is_self || o.id === client?.obj_id)
      : null;
    if (!self || !client.moveToSquare) return;
    const myCol = self.col, myRow = self.row;
    const geo = session?.s?.world?.geometry ?? null;
    const ok = (r, c) => {
      if (geo?.walkable?.(r, c) === false) return false;
      if (typeof geo?.heightStepOk === 'function')
        return geo.heightStepOk(myRow, myCol, r, c);
      return true;
    };
    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    const [dx, dz] = dirs[Math.floor(Math.random() * dirs.length)];
    const steps = 3 + Math.random() * 3 | 0;
    let c = myCol, r = myRow, moved = 0;
    while (moved < steps) {
      const nc = c + dx, nr = r + dz;
      if (!ok(nr, nc)) break;   // wall, void, or ledge edge: stop here
      c = nc; r = nr; moved++;
    }
    if (moved > 0) client.moveToSquare(c, r).catch(() => {});
  } catch {}
}
