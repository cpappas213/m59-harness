# Coordinates: one place, several legacy spellings

Meridian 59 has one square identity but several historical ways to spell it.
They are all valid at their existing boundaries.  The safe rule for humans and
agents is to name the axes or use **row/column notation**: `r30c61` means
`row=30, col=61`.

Do not write a new unlabeled pair such as `30,61` in prose, diagnostics, or a
new data structure.  An unlabeled pair cannot say whether its first value is a
row, a column, X, or Y.  `rNcM` is documentation and diagnostic notation only;
it is not a new argument syntax for existing commands.

## Coordinate spaces

| Space | Unambiguous example | Units and axes |
|---|---|---|
| Game square | `r30c61` or `{ "row": 30, "col": 61 }` | 1-based square indices.  `col` increases with X; `row` increases with Y. |
| KOD/protocol fine point | `{ "x": 3936, "y": 1952 }` | 64 fine units per square.  X selects `col`; Y selects `row`. |
| Stock client/BSP point | `{ "x": ..., "y": ... }` | 1024 client units per square.  Convert at the client boundary; do not mix these values with 64-unit KOD/protocol points. |

For a KOD/protocol point, the containing square is
`col=floor(x/64), row=floor(y/64)`.  The center of `r30c61` is therefore
`x=61*64+32=3936, y=30*64+32=1952`.  Named JSON object properties have no
positional order; `{ "col": 61, "row": 30 }` identifies the same square as
`{ "row": 30, "col": 61 }`.

The same square's center in stock-client/BSP space is
`x=(61-1)*1024+512, y=(30-1)*1024+512`. Conversion between the two fine
spaces changes scale and origin, not axis order.

## Existing boundaries

| Boundary | Existing convention | Keep in mind |
|---|---|---|
| MCP `look` / `walk_to` | named `col` and `row` fields | Copy fields by name; JSON property order has no tuple meaning. |
| Positional movement helpers | `(col, row)` | Movement follows X then Y: column first, row second. |
| Fine positions | named `{x, y}` | X maps to column and Y maps to row. |
| `RoomGeometry` and KOD room-grid logic | `(row, col)` | Grid arrays are `[rows][cols]` and flattened data is row-major.  Geometry positional methods such as `walkable(row, col)` are row first. |
| Movement coordinate bytes on the wire | Y, then X | The protocol payload order is not the in-memory object order.  Decode to named `{x, y, col, row}` before reasoning about it. |

The different conventions are historical interface boundaries, not different
physical locations.  Convert once at a named boundary and use named fields
inside new code.  Do not “fix” a call by swapping values until the producer's
and consumer's contracts are both known.

## Stable serialized exceptions

The following formats already exist on disk or in generated artifacts.  Their
positional encodings are compatibility contracts and must not be silently
reinterpreted:

- `m59-routes/1` route and reach keys use
  `fromRow,fromCol>toRow,toCol`; pivot tuples are `[row, col]`.
- Baked-map `edgeApproaches` tuples begin with KOD/protocol fine
  `[insideX, insideY, outsideX, outsideY]`; their stage tuples are `[col, row]`.
- Travel-ledger `refusals[].square` strings are `"row,col"`.
- Wrong-exit avoidance keys are `"row,col"`; locked-door square strings and
  safe-spot book keys are `"col,row"`.
- Trail and track points persist named KOD/protocol `{x,y}` values. The legacy
  `m59-trails.squareOf()` adapter and track-shelter derivation nevertheless add
  one after dividing by 64; their derived coarse squares are a known off-by-one
  compatibility anomaly, not the canonical conversion above. Do not copy that
  adapter into new code; correcting persisted track fields requires a migration.
- `m59-falljumps.json` square records use named `{row,col}` and optional
  `from_fine`/`to_fine` points use 1024-unit client/BSP `{x,y}`.
- The versioned RTS/native line contract serializes its square columns before
  rows. Its reader restores named fields.

Changing one of these requires a versioned migration and readers for the old
form.  Merely changing comments, labels, or a tuple destructuring order is not
a migration.

Existing command-line tools also retain their documented grammars.  For
example, `m59-roo path`, `m59-ping`, patrol, and record-jam inputs use
`col,row`, while relocation, safe-walk, traversal, testbed, and gutter-analysis
inputs use `row,col`.  Consult the command's help or example before supplying a
positional pair.  Do not pass `rNcM` unless a command explicitly gains and
documents that syntax.

## Issue #44: why asymmetric examples matter

Room 563 is 34 rows by 76 columns, so swapping its axes produces a location
that looks plausible but means something else:

- Fine `{x:3936, y:1952}` decodes to `col=61, row=30`, or `r30c61`.
  That square genuinely has no floor.
- The exit diagnostic `[exit] injected 34,65` and the ledger square `"34,65"`
  are legacy `row,col` strings.  They identify `r34c65`, the valid south exit
  anchor, not `r30c61`.
- The center of `r34c65` is `{x:4192, y:2208}` in 64-unit KOD/protocol space.
  The east anchor `r27c76` is `{x:4896, y:1760}`.

Labeling both locations exposes the distinction immediately; comparing the
unlabeled strings made the floorless `r30c61` look like evidence against the
valid `r34c65` anchor.

## Rules for maintainers

- Use `rNcM` or `row=..., col=...` in human-facing prose and diagnostics.
- Prefer named `{row, col}` or `{x, y}` objects in new internal interfaces.
- State the units whenever a value is fine-grained rather than a square.
- Name both conventions at every conversion boundary, including the Y-then-X
  wire adapter.
- Do not introduce a new comma string or two-element coordinate tuple.
- Do not rewrite an existing schema, artifact, command grammar, or parser just
  to make all positional orderings look alike.  Version and migrate it if a
  future change genuinely needs a new contract.
