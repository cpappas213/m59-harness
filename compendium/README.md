# The Meridian 59 Compendium

A static reference site for the game: every spell, skill, item and creature, plus
guides to the systems that connect them. Nothing here is remembered or estimated —
every page is compiled from the server's own Blakod source and the client's own
sprite files, and every quantitative claim carries a `file:line` citation into
`C:\code\Meridian59`.

## Read it

```bash
node tools/serve.mjs          # http://localhost:8099/
```

1,003 pages: 186 spells, 323 items, 267 zones, 171 creatures and NPCs, 22 skills,
23 guides, and nine catalogue indexes. 5,355 sprites decoded from the client's
`.bgf` files and 254 room maps decoded from its `.roo` files.
`node tools/lint.mjs` reports zero broken links, zero malformed fragments, and
zero citations pointing at a line that does not exist.

Two pages do real work rather than listing things:

- **`creatures/index.html`** is a combat calculator. Describe a character —
  five presets from a mace-wielding newbie to a maxed scimitar build, all
  editable and saveable — and every creature's hit chances, damage, swings to
  kill and swings to die recompute against it. Two ways to describe one:
  **detailed** (attributes, skills, equipment) or **simple** (offence, defence,
  damage and health typed straight in). The panel pops out to ride along as you
  scroll, and collapses to a one-line summary. Columns can be shown, hidden and
  reordered. The arithmetic is `tools/calc.mjs`, which the generator and the
  browser both use, so the page cannot disagree with itself.
  It opens filtered to **monsters that actually spawn somewhere**.
- **`zones/world-map.html`** lays the outdoor rooms out geographically by
  walking the compass exits declared in the source, and reports the seams where
  the world does not tile flat.
- **Zone pages carry a "Set piece" section** for the 53 rooms that run
  machinery of their own — timers with their periods, and the trigger
  rectangles the room tests, drawn on its map. Those rectangles are invisible in
  play and are the thing players guess at; `tools/setpiece.mjs` recovers them by
  parsing the room's own predicates, so a half-open clause clipped to the room's
  bounds is included rather than missed.

## Build it

```bash
node tools/build.mjs          # parse kod, decode sprites, generate every page
node tools/build.mjs --fast   # skip sprite decoding (slow, rarely changes)
```

The pipeline is four stages, each of which can be run alone:

| stage | script | produces |
|---|---|---|
| parse | `tools/kodparse.mjs` | `data/koddb.json` — 1,232 classes with their variables, resources and message bodies |
| sprites | `tools/bgf.mjs all` | `assets/img/*.png` + `data/images.json` — the first frame of every group of every `.bgf` |
| extract | `tools/extract-*.mjs` | `data/spawns.json`, `data/treasure.json`, `data/zones.json` — cross-references too expensive to redo per page |
| maps | `tools/roo.mjs` | wall geometry out of `resource/rooms/*.roo`, drawn as SVG (used by the zones module) |
| set pieces | `tools/setpiece.mjs` | room timers and trigger rectangles, parsed out of the room's own conditions |
| generate | `tools/gen.mjs` | the site |

`tools/gen.mjs` wraps two kinds of source into the same shell:

- `content/*.html` — hand-written guide fragments, one per system, become `guides/*.html`.
- `tools/derive/*.mjs` — one module per catalogue. Each turns `koddb.json` into an
  index page and one page per entity. See [`tools/derive/README.md`](tools/derive/README.md)
  for the contract; `tools/derive/spells.mjs` is the worked reference.

## Why it is built this way

The interesting facts about a Meridian 59 spell — its mana cost, its reagents, its
karma requirement — are never sent over the wire. `BP_SPELLS` gives a name, a target
count and a school; everything else is declared in kod and enforced server-side. The
same is true of armour resistances, monster difficulty and treasure tables. So a
reference that is *correct* cannot be assembled by playing; it has to be compiled
from the source, which is what this is.

The consequence worth knowing: when the game changes, re-running `tools/build.mjs`
re-derives the whole site. Nothing here is hand-maintained except the prose in
`content/`, and that carries citations so it can be checked the same way.
