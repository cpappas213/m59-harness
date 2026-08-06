#!/usr/bin/env node
// TWO CHARACTERS, ONE MONSTER, ONE WALL. Offline, no server, safe any time:
//
//   node tools/m59-party-test.mjs
//
// The party is a convention two keepers hold in one process — there is no party system
// in the game — so everything that makes it work is in the register and the rules
// around it, and all of it is testable without a server.
//
// The cases here are the ones that were wrong or nearly wrong while building it:
//
//   * a square holds a SET of occupants, not one name. With one name the second
//     partner to claim erased the first, and releasing the second then freed a square
//     somebody was still standing on.
//   * partners may share a wall; NOBODY else may. The one-wall-each default exists
//     because uncoordinated keepers pile onto the same corner.
//   * pairing is exclusive — a character in two parties is in none, because both
//     partners wait for it and neither gets a second swinger.
//   * leather outranks plate, which is not what the price says.
import './m59-test-ledger.mjs';        // FIRST — importing the keeper records to a ledger
import { claimSpot, releaseSpot, spotTakenByAnother, claimedSpotList } from './m59-autopilot.mjs';
import * as party from './m59-party.mjs';
import { armourKind, armourScore, armourOf, ARMOUR_SLOTS } from './m59-skills.mjs';
import { pairUp, assignRooms } from './m59-supervise.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// ---------------------------------------------------------------- pairing

party.resetParties();
{
  party.pair('a', 'b');
  ok('pairing is symmetric', party.partnerOf('a') === 'b' && party.partnerOf('b') === 'a');
  ok('and arePartners agrees both ways', party.arePartners('a', 'b') && party.arePartners('b', 'a'));

  // A character in two parties is in none.
  party.pair('b', 'c');
  ok('re-pairing releases the old partner', party.partnerOf('a') === null,
     'a still thinks it is with ' + party.partnerOf('a'));
  ok('and establishes the new one', party.partnerOf('b') === 'c');
  ok('a is not partnered with anyone', !party.arePartners('a', 'b') && !party.arePartners('a', 'c'));

  party.unpair('b');
  ok('unpair clears both sides', party.partnerOf('b') === null && party.partnerOf('c') === null);
  ok('pairing a character with itself is refused', party.pair('z', 'z') === null);
}

// ---------------------------------------------------------------- the shared wall

party.resetParties();
{
  claimSpot('solo', 544, 10, 10);
  ok('a stranger is refused a claimed square', spotTakenByAnother('other', 544, 10, 10) === 'solo');
  ok('the claimant is not blocked by itself', spotTakenByAnother('solo', 544, 10, 10) === null);

  party.pair('solo', 'mate');
  ok('a partner may join the same square', spotTakenByAnother('mate', 544, 10, 10) === null);
  ok('but a stranger still may not', spotTakenByAnother('other', 544, 10, 10) === 'solo');

  // THE BUG THIS FILE EXISTS FOR. Both partners standing there must both be recorded;
  // with one name per square the second claim erased the first.
  claimSpot('mate', 544, 10, 10);
  const here = claimedSpotList().filter(x => x.at === '544:10,10').map(x => x.agent).sort();
  ok('both occupants are recorded', here.join(',') === 'mate,solo', 'got ' + here.join(','));

  releaseSpot('mate');
  ok('one partner leaving does not free a square the other is on',
     spotTakenByAnother('other', 544, 10, 10) === 'solo');
  releaseSpot('solo');
  ok('the last one leaving frees it', spotTakenByAnother('other', 544, 10, 10) === null);
}

// One square each still holds for everyone unpaired.
party.resetParties();
{
  claimSpot('x', 586, 25, 23);
  claimSpot('x', 586, 30, 30);         // moving gives up the old one
  ok('claiming a new square releases the old', spotTakenByAnother('y', 586, 25, 23) === null);
  ok('and holds the new one', spotTakenByAnother('y', 586, 30, 30) === 'x');
  releaseSpot('x');
}

// ---------------------------------------------------------------- converging

party.resetParties();
{
  party.pair('p1', 'p2');
  party.report('p2', { health: 0.9, room: 544 });
  party.declareTarget('p2', 777, 'fungus beast');
  const t = party.agreedTarget('p1');
  ok('a partner\'s target is offered to us', t?.id === 777 && t.name === 'fungus beast');
  ok('and it says who it came from', t.from === 'p2');

  // A target nobody has refreshed is not a target. Two characters converging on where
  // a creature was a minute ago is worse than each choosing for itself.
  ok('a stale target is withheld', party.agreedTarget('p1', { staleMs: -1 }) === null);

  party.declareTarget('p2', null);
  ok('clearing the target withdraws it', party.agreedTarget('p1') === null);

  // No partner means no opinion — a solo keeper must be left to choose for itself.
  party.resetParties();
  ok('an unpartnered character is offered nothing', party.agreedTarget('p1') === null);
}

// ---------------------------------------------------------------- who backs off

party.resetParties();
{
  party.pair('h1', 'h2');
  party.report('h2', { health: 0.95, room: 544 });
  ok('the healthy one fights', party.roleFor('h1', { health: 0.8, floor: 0.5 }) === 'fight');
  ok('the hurt one heals', party.roleFor('h1', { health: 0.3, floor: 0.5 }) === 'heal');
  ok('exactly at the floor is still fighting', party.roleFor('h1', { health: 0.5, floor: 0.5 }) === 'fight');

  // Both hurt means both heal — the creature will still be there.
  party.report('h2', { health: 0.2, room: 544 });
  ok('both hurt means both back off', party.roleFor('h1', { health: 0.2, floor: 0.5 }) === 'heal');

  // A solo character is never told to stand about.
  party.resetParties();
  ok('a solo character always fights', party.roleFor('h1', { health: 0.1, floor: 0.5 }) === 'fight');
  ok('unknown health does not produce a decision', party.roleFor('h1', { health: null }) === 'fight');
}

// ---------------------------------------------------------------- rendezvous

party.resetParties();
{
  party.pair('r1', 'r2');
  party.report('r2', { health: 1, room: 544 });
  ok('together when in the same room', party.together('r1', 544));
  ok('not together when apart', !party.together('r1', 563));
  ok('not together when the room is unknown', !party.together('r1', null));
  party.report('r2', { needs: ['food', 'weapon'] });
  ok('a partner\'s shortages are readable', party.mateNeeds('r1').join(',') === 'food,weapon');
}

// ---------------------------------------------------------------- armour

{
  ok('leather is recognised', armourKind('leather armor')?.slot === 'armour');
  // Again the server's name, not the class file's — metlshld.kod is "small round shield".
  ok('a shield is recognised', armourKind('small round shield')?.slot === 'shield');
  ok('and so is every other real shield in the game',
     ['gold round shield', 'herald shield', "knight's shield", 'orc shield', "soldier's shield"]
       .every(n => armourKind(n)?.slot === 'shield'));
  ok('a weapon is not armour', armourKind('a rusty dagger') === null);

  // "simple helm" must not be read as the plain "helm", which is a better item.
  ok('the longer name wins', armourScore(armourKind('simple helm')) === 20 + 1 * 10,
     'got ' + armourScore(armourKind('simple helm')));

  // THE ONE THAT IS NOT WHAT THE PRICE SAYS. Plate costs 2000 and leather 400, and
  // leather is the better armour for these characters: +50 defence against -200, on a
  // scale where a monster's whole attack rating is about 210.
  ok('leather outranks plate', armourScore(armourKind('leather armor')) >
                               armourScore(armourKind('plate armor')));
  ok('and plate scores negative', armourScore(armourKind('plate armor')) < 0);

  const c = {
    inventory: [{ id: 1, nameRsc: 1 }, { id: 2, nameRsc: 2 }, { id: 3, nameRsc: 3 }, { id: 4, nameRsc: 4 }],
    // THE NAME THE SERVER SENDS, NOT THE NAME OF THE CLASS FILE. This said "metal
    // shield", which is metlshld.kod — the class. Its shield_name_rsc is "small round
    // shield", and that is the only string an agent ever sees, because every name arrives
    // through c.rsc.get(nameRsc). So the test was asserting against a string the server
    // cannot produce, and had been failing on `have.shield[0]` being undefined.
    //
    // The ARMOUR table itself was right and covers all six real shields — gold round,
    // herald, knight's, small round, orc and soldier's — which is why this was a broken
    // test rather than a fleet walking around without shields.
    rsc: { get: r => ({ 1: 'plate armor', 2: 'leather armor', 3: 'small round shield', 4: 'a mace' }[r]) },
    using: new Set(),
  };
  const have = armourOf(c);
  ok('the pack ranks leather first', have.armour[0].name === 'leather armor');
  ok('the shield is filed as a shield', have.shield[0].name === 'small round shield');
  ok('the mace is not filed as armour',
     ARMOUR_SLOTS.every(s => !have[s].some(x => /mace/.test(x.name))));
}

// ---------------------------------------------------------------- deployment

{
  const rows = [
    { agent: 't1', character: 'A', level: 30 }, { agent: 't2', character: 'B', level: 30 },
    { agent: 't3', character: 'C', level: 31 }, { agent: 't4', character: 'D', level: 29 },
  ];
  const { pairs, odd } = pairUp(rows);
  ok('four characters make two pairs', pairs.length === 2 && odd === null);
  ok('pairs are formed by level, closest together',
     pairs[0].map(x => x.character).sort().join('') === 'AC',
     'got ' + pairs[0].map(x => x.character).join(''));

  // An odd fleet must leave someone out ON PURPOSE and say so — a character that
  // thinks it has a partner and has not is worse off than a solo one.
  const five = pairUp([...rows, { agent: 't5', character: 'E', level: 28 }]);
  ok('an odd fleet leaves exactly one over', five.pairs.length === 2 && five.odd?.character === 'E');

  // Pairs spread across rooms rather than stacking: each room caps its generator.
  const plan = assignRooms(pairs);
  ok('pairs go to different rooms', plan[0].room !== plan[1].room,
     'both went to ' + plan[0].room);
  ok('the first pair goes to the valley', plan[0].room === 544);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
