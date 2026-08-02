# derive/ — one module per catalogue

`tools/gen.mjs` imports every `*.mjs` in this directory and asks it for a category.
A module that does not export both `meta` and `build` is skipped with a warning.

```js
export const meta = {
  id: 'spells',       // nav id, must be unique
  title: 'Spells',    // nav label and <h1> of the index
  dir: 'spells',      // output directory, one level below the site root
  order: 1,           // nav ordering
  nav: true,          // false hides it from the top bar
  blurb: 'One line for the home page card.',
};

export function build({ db, images, lib }) {
  return {
    indexHtml,        // body HTML for <dir>/index.html
    pages: [          // one entry per entity page
      {
        slug,         // <dir>/<slug>.html — always lib.slugify(className)
        title,        // <h1> and search result label
        html,         // body HTML
        desc,         // ≤160 chars, used for <meta description> and search
        icon,         // 'assets/img/foo_g1.png' — root-relative, NO leading '../'
        kind,         // search facet label; defaults to meta.id
      },
    ],
  };
}
```

`build` runs once. It may not touch the filesystem outside `data/`; the driver
writes every page.

## The rules that keep the site coherent

- **URLs are global.** Every page lives exactly one directory below the root, so
  `../assets/…` and `../<dir>/<slug>.html` always resolve. Never emit a link with
  a different depth.
- **Slugs are `lib.slugify(className)`.** That is how one module links to a page
  another module owns without coordinating.
- **Class variables inherit.** Read them with `lib.ivar` / `lib.rvar`, never from
  `c.classvars` directly — most classes inherit most of their values.
- **Kod is case-insensitive.** Match identifiers with `/…/i`. A case-sensitive
  scan drops real data and looks like an absence.
- **Cite everything.** A quantitative claim without a `file:line` is a bug.
- **End every entity page with `lib.kodSource(db, c)`** so a doubtful reader can
  check the derivation without leaving the page.

## Helpers in `../lib.mjs`

| helper | what it gives you |
|---|---|
| `cls(db, name)` | a class record, case-insensitively |
| `descendants(db, 'Item')` | every class whose chain contains `Item` |
| `ivar(db, c, 'viWeight')` | inherited numeric class variable, or `null` |
| `rvar(db, c, 'vrName')` | inherited resource-valued class variable |
| `nameOf` / `descOf` | the in-game name and description strings |
| `findMessage(db, c, 'GetDamage')` | the handler, walking up the chain |
| `ownMessage(c, 'GetDamage')` | only this class's override |
| `constNames(db, 'SID_', 42)` | which constants equal that value |
| `flagNames(db, 'ATCK_', mask)` | decompose a bitmask into named bits |
| `parsePairList` / `parseConsPairs` | kod list literals out of a message body |
| `iconFor` / `spriteGroups` | sprites, already path-relative to a page |
| `dataTable(cols, rows, opts)` | the site's one table style, sortable |
| `factGrid([[label, html], …])` | the stat tiles under a page title |
| `tagList([{text, cls, href}])` | pill tags |
| `kodSource(db, c)` | the "In the source" section |

`derive/spells.mjs` is the worked reference. Read it before writing a new module.
