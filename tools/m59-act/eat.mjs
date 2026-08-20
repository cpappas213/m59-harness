#!/usr/bin/env node
// m59-act/eat.mjs -- EAT ONE THING. The last link in the fleet's supply chain:
//
//   has_reagents + has_mana -> cast create food -> has_food -> EAT -> vigor_ok
//
// WHY EATING EXISTS AT ALL, since it looks optional. Resting stops awarding vigor
// at REST_VIGOR_CAP, 80 of 200, so EVERYTHING ABOVE 80 HAS TO BE EATEN. A fleet
// holding out for a vigor no amount of sitting can deliver looks on the board
// exactly like a fleet that is working -- twenty-one healthy characters, all
// parked. And vigor is not cosmetic: it sets the rate health returns at, which is
// why deaths per thousand observations ran 75.7 below 85 vigor against 12.4 above
// 160, a six-fold difference.
//
// THE CONSTRAINT IS THE STOMACH, NOT THE FOOD. `ReqEatSomething` refuses when
// piStomach + filling > 100 (player.kod:5703), and NOTHING ON THE WIRE REPORTS THE
// STOMACH -- it is server-side and silent. It is fully determined though:
//
//   EatSomething:  piStomach += filling                    (player.kod:5744)
//   UpdateStomach: piStomach -= elapsed * 12 / 100         (player.kod:1347)
//
// so it drains 0.12 a second and a full one clears in 13.9 minutes. skills.Stomach
// models exactly that, and the model is self-correcting because a refusal is itself
// a measurement. THE MODEL IS PER-CHARACTER STATE, so this atomic does not own one:
// the caller passes it in. An atomic that kept state between calls would be a
// keeper with a smaller name.
//
// AND THE KOD SAYS THE PART THAT MATTERS MOST OUT LOUD: "Need empty stomach to get
// vigor boost from food." Cramming is not merely wasteful, it is how you end up
// full and still tired.

import { FOOD_RE } from '../m59-worldstate.mjs';

/**
 * eat(client, session, { itemId, filling, stomach, waitMs })
 *
 * `stomach` is an optional skills.Stomach the CALLER owns. When given, a mouthful
 * that would not fit is refused before the packet -- the server would only decline
 * out loud to the room anyway, and a refusal we predicted is one we can plan around.
 *
 * Returns { sent, reason, vigor_before, vigor_after, gained }.
 *
 * `gained` is read from vitals rather than assumed. Vigor is PUSHED, so this is a
 * cache read a moment later, not a request -- but it can lag, so a zero gain is
 * reported as zero rather than dressed up as failure.
 */
export async function eat(client, session, { itemId, filling = null, stomach = null,
                                             waitMs = 900 } = {}) {
  if (!client || !session) return { sent: false, reason: 'no client or session' };
  if (itemId == null)      return { sent: false, reason: 'no item' };

  // The pack is the only evidence we have that the thing exists. Eating an item id
  // we do not hold is a packet the server drops in silence.
  const held = (client.inventory ?? []).some(o => o.id === itemId);
  if (!held) return { sent: false, reason: 'not in the pack' };

  if (stomach && filling != null && typeof stomach.roomFor === 'function'
      && !stomach.roomFor(filling)) {
    const wait = typeof stomach.secondsUntilRoomFor === 'function'
      ? stomach.secondsUntilRoomFor(filling) : null;
    return { sent: false, reason: 'stomach is too full', seconds_until_room: wait };
  }

  const vigorOf = () => client.vitals?.()?.vigor?.value ?? null;
  const before = vigorOf();
  const since = client.evSeq ?? 0;

  // Eating is APPLY: use the food on ourselves. BP_REQ_APPLY {4,OBJECT}{4,OBJECT}.
  await session.pacer.submit('act', () => client.apply(itemId, client.selfId), waitMs)
                     .catch(() => {});
  await client.waitFor({ since, kinds: ['stat', 'message', 'inventory'], timeoutMs: waitMs })
              .catch(() => {});

  const after = vigorOf();
  // THE REFUSAL IS ITSELF A MEASUREMENT, and this is where the model earns its keep.
  // Nothing on the wire reports the stomach, so the only readings available are "it
  // went in" and "it did not". Charging optimistically would let the model drift
  // permanently high; charging only on evidence, and calling refused() otherwise,
  // pins it from below — refused(filling) sets the level to the lowest value
  // consistent with having been declined.
  const moved = before != null && after != null && after > before;
  if (stomach && filling != null) {
    if (moved && typeof stomach.ate === 'function') stomach.ate(filling);
    else if (!moved && typeof stomach.refused === 'function') stomach.refused(filling);
  }

  return {
    sent: true,
    // `changed` IS THE ANSWER THE CALLER ACTS ON, and it was missing. This measured
    // `moved` for the stomach model and then returned a bare `sent: true`, so didAct()
    // scored a mouthful that did nothing as a success -- and the goal-skip that
    // abandons an unreachable goal after five failures never counted one.
    //
    // Watched live 2026-08-20: Sasquatch at vigor 80 with `vigor_comfortable` (180) as
    // its goal, holding three purple mushrooms, planned `eat` 121 times in seven
    // minutes. The mushroom count never dropped and the vigor never moved. The atomic
    // knew both facts and reported neither.
    //
    // UNKNOWN IS NOT FALSE. If either reading is missing we cannot say the meal failed,
    // and reporting `changed: false` on an unread bar would abandon eating on a slow
    // stat packet. Only a bar we READ and saw not move is a refusal.
    changed: before != null && after != null ? moved : null,
    vigor_before: before,
    vigor_after: after,
    gained: before != null && after != null ? after - before : null,
    reason: (before != null && after != null && !moved)
      ? 'ate it and the vigor bar did not move' : null,
  };
}

eat.pre     = ['has_food'];
eat.effects = ['vigor_ok', 'vigor_comfortable', '!has_food'];
eat.atomic  = 'eat';

// ---------------------------------------------------------------------------
// BINDING -- which item, resolved AT EXECUTION TIME. See m59-act/equip.mjs.
// ---------------------------------------------------------------------------
//
// THIS IS THE ONE THAT PROVES THE RULE. The canonical plan is
// `cast create food -> eat`, and the food does not exist when the plan is made. Bind
// at plan time and there is no eat action to sequence, so the fleet's whole supply
// chain becomes unplannable. `eat.pre = ['has_food']` is what keeps it honest.
//
// FOOD_RE has ONE home, in m59-worldstate.mjs, where `has_food` is produced from it.
// A second regex here would let the planner believe it has food by one definition and
// find none by another.
export function pickFood(client) {
  const inv = client?.inventory;
  if (!Array.isArray(inv) || !inv.length) return null;
  const nameOf = (o) => String(o?.name ?? client?.rsc?.get?.(o?.nameRsc) ?? '');
  return inv.find(o => o?.id != null && FOOD_RE.test(nameOf(o))) ?? null;
}

export const eatSomething = (client, session, args = {}) => {
  const item = pickFood(client);
  if (!item) return { sent: false, reason: 'nothing edible in the pack' };
  return eat(client, session, { ...args, itemId: item.id });
};
eatSomething.pre     = eat.pre;
eatSomething.effects = eat.effects;
eatSomething.atomic  = 'eat';
