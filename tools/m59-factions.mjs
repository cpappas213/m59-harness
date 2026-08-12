// FACTION JOINING, AS DATA RATHER THAN PROSE.
//
// The three join quests are built in questengine.kod. Keeping the exact leaders,
// destinations, and possible assignments here lets the broker expose one narrow
// mechanical operation without giving an unattended caller general speech or NPC-offer
// authority.

export const FACTION_JOIN = Object.freeze({
  duke: Object.freeze({
    id: 'duke', title: 'The Duke', leader: 'Duke Akardius', room: 952,
    assignments: Object.freeze([
      { item: 'sapphire', target: 'Duke Akardius', room: 952 },
      { item: 'ruby', target: 'Duke Akardius', room: 952 },
      { item: 'emerald', target: 'Duke Akardius', room: 952 },
      { item: 'diamond', target: 'Duke Akardius', room: 952 },
    ]),
  }),
  princess: Object.freeze({
    id: 'princess', title: 'The Princess', leader: 'Princess Kateriina', room: 852,
    assignments: Object.freeze([
      { item: 'letter', target: 'Priestess Xiana', aliases: ['Xiana'], room: 48 },
      { item: 'letter', target: 'Lady Aftyn', room: 205 },
      { item: 'letter', target: 'Herbutte', room: 109 },
    ]),
  }),
  rebel: Object.freeze({
    id: 'rebel', title: 'The Rebels', leader: "Jonas D'Accor", room: 371,
    assignments: Object.freeze([
      { item: 'plate armor', target: "Jonas D'Accor", room: 371 },
      { item: 'simple helm', target: "Jonas D'Accor", room: 371 },
      { item: "knight's shield", target: "Jonas D'Accor", room: 371 },
      { item: 'gauntlets', target: "Jonas D'Accor", room: 371 },
      { item: 'mystic sword', target: "Jonas D'Accor", room: 371 },
      { item: 'scimitar', target: "Jonas D'Accor", room: 371 },
    ]),
  }),
});

// Soldier promotion is a two-kill quest, with a fresh three-hour clock on each
// target. Troops are generated around faction flags; these are the three default
// flag rooms for each opposing army in the stock server data.
export const FACTION_SOLDIER = Object.freeze({
  duke: Object.freeze({ shield: "shield of the Duke's army",
    stages: Object.freeze([
      Object.freeze({ target: 'rebel soldier', rooms: Object.freeze([568, 557, 547]) }),
      Object.freeze({ target: "soldier of the Princess' army", rooms: Object.freeze([593, 583, 603]) }),
    ]) }),
  princess: Object.freeze({ shield: "shield of the Princess' army",
    stages: Object.freeze([
      Object.freeze({ target: "soldier of the Duke's army", rooms: Object.freeze([586, 596, 585]) }),
      Object.freeze({ target: 'rebel soldier', rooms: Object.freeze([568, 557, 547]) }),
    ]) }),
  rebel: Object.freeze({ shield: 'shield of the rebel militia',
    stages: Object.freeze([
      Object.freeze({ target: "soldier of the Princess' army", rooms: Object.freeze([593, 583, 603]) }),
      Object.freeze({ target: "soldier of the Duke's army", rooms: Object.freeze([586, 596, 585]) }),
    ]) }),
});

export const COUNCIL_TOKENS = Object.freeze([
  'runed coffer token', 'jeweled egg token', 'jade cat token',
  'demon skull token', 'crystal sphere token',
]);

export const COUNCIL_TOKEN_DESTINATIONS = Object.freeze({
  'runed coffer token': Object.freeze({ councilor: 'Alzahakar', room: 37 }),
  'jeweled egg token': Object.freeze({ councilor: 'Bei Naq', room: 576 }),
  'jade cat token': Object.freeze({ councilor: 'Cylill', room: 563 }),
  'demon skull token': Object.freeze({ councilor: 'Drechx', room: 2 }),
  'crystal sphere token': Object.freeze({ councilor: 'Esseldi', room: 526 }),
});

const TOKEN_SET = new Set(COUNCIL_TOKENS.map(value => value.toLowerCase()));

export function factionFromProfile(extra) {
  const text = String(extra ?? '');
  if (!text.trim()) return 'unknown';
  if (/Duke Akardius/i.test(text)) return 'duke';
  if (/Princess Kateriina/i.test(text)) return 'princess';
  if (/freedom fighter|supporting Jonas/i.test(text)) return 'rebel';
  // Player.ShowExtraInfo emits no explicit neutral sentence: it appends origin and
  // guild, then appends a faction line only when GetFaction() is non-neutral.
  return 'neutral';
}

export function visibleTokenFromProfile(extra) {
  const text = String(extra ?? '').toLowerCase();
  return COUNCIL_TOKENS.find(token => text.includes(token)) ?? null;
}

export const isCouncilToken = value => TOKEN_SET.has(String(value ?? '').trim().toLowerCase());

export function soldierFromInventory(faction, items = []) {
  const spec = FACTION_SOLDIER[faction];
  if (!spec) return false;
  return items.some(item => String(item?.name ?? item ?? '').trim().toLowerCase() ===
    spec.shield.toLowerCase());
}

export function soldierAssignment(faction, messages = []) {
  const spec = FACTION_SOLDIER[faction];
  if (!spec) return null;
  const text = textOf(messages);
  const stageIndex = spec.stages.findIndex(stage => mentions(text, stage.target));
  return stageIndex < 0 ? null : { ...spec.stages[stageIndex], stage_index: stageIndex };
}

export function soldierPromotionConfirmed(faction, messages = [], items = []) {
  return soldierFromInventory(faction, items) ||
    /accepted into .*army|accepted into .*militia|proved yourself worthy|honor of serving/i
      .test(textOf(messages));
}

const ALIASES = Object.freeze({
  duke: 'duke', akardius: 'duke',
  princess: 'princess', kateriina: 'princess',
  rebel: 'rebel', rebels: 'rebel', jonas: 'rebel',
});

export function factionJoinSpec(value) {
  const id = ALIASES[String(value ?? '').trim().toLowerCase()];
  return id ? FACTION_JOIN[id] : null;
}

const textOf = messages => (Array.isArray(messages) ? messages : [])
  .map(message => typeof message === 'string' ? message : message?.text)
  .filter(Boolean).join('\n');

const mentions = (text, value) => text.toLowerCase().includes(value.toLowerCase());

/** Turn the liege's quest sentence into the exact item and recipient DUM must pursue. */
export function factionAssignment(faction, messages = []) {
  const spec = factionJoinSpec(faction);
  if (!spec) return null;
  const text = textOf(messages);
  if (!text) return null;
  for (const assignment of spec.assignments) {
    const names = [assignment.target, ...(assignment.aliases ?? [])];
    if (spec.id === 'princess') {
      if (names.some(name => mentions(text, name))) return { ...assignment };
    } else if (mentions(text, assignment.item)) return { ...assignment };
  }
  return null;
}

export function factionJoinConfirmed(messages = []) {
  const text = textOf(messages);
  return /entered on the roll of membership|one of the freedom fighters/i.test(text);
}

export function factionOfferAllowed(faction, { item, target } = {}) {
  const spec = factionJoinSpec(faction);
  if (!spec) return null;
  const itemText = String(item ?? '').trim().toLowerCase();
  const targetText = String(target ?? '').trim().toLowerCase();
  return spec.assignments.find(assignment => {
    const targets = [assignment.target, ...(assignment.aliases ?? [])]
      .map(name => name.toLowerCase());
    return assignment.item.toLowerCase() === itemText && targets.includes(targetText);
  }) ?? null;
}
