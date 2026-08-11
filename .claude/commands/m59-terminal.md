---
description: Open the interactive fleet terminal — arrow keys, per-character sheets, and a launch key that actually starts the game
argument-hint: [fleet]
---

Opening the fleet TUI in its own terminal window.

!`node tools/m59-which.mjs --fleet $ARGUMENTS 2>&1`

The window below opens on that fleet. The TUI resolves it the same way every other tool
does — `--fleet`, then `M59_FLEET`, then `substrate/fleet-default` — so if you want a
different one, pass its name to this command.

**Why a separate window and not this conversation.** A slash command runs a command and
puts its output here; it cannot hand you the keyboard. What you want — arrow keys, Enter
to open a character, a key that starts a program — needs a terminal that is yours to
drive. So this launches one. It talks to the same broker on 8901 that everything else
does, so it is the same fleet, live.

**The keys.** `↑↓` or `jk` to move, `⏎` for a character's full sheet, `r` to refresh,
`q` to quit — and four that do something outside the terminal:

- **`X`** is the **override**. By default the cursor steps straight over any character
  the fleet is already using for a multi-character operation — a loot run, a signet ring
  being walked back to its owner, a provisioning cast, a pairing — and greys the row.
  Those all have another end, and taking one half of one abandons the other half
  silently. `X` makes them reachable; `X` again, with the cursor on one, **takes it**:
  cancels the errand, drops the pairing, revives the keeper, and says which of those it
  did. The footer tells you which of the two the key is about to do.
- **`L`** launches the real game client logged in as the selected character, with the
  agent DLL injected, and claims it from the keeper so the broker stops driving it.
- **`B`** opens the **commander** — the Bos Wars build in `maps/m59-boswars`, an RTS
  board that draws the whole roster at once instead of one character per window. It is
  about the *fleet*, not the row under the cursor, and the fleet this terminal is showing
  is the one it opens on: opened by hand the commander offers every roster this machine
  holds and asks you to pick, and picking wrong gives you a board of characters nobody is
  watching, which looks exactly like a board that works. Its own window says `COMMAND` or
  `SPECTATE` before it connects, and nothing happens until you press Start Game there.
  That repository is a separate clone — without it beside the harness the key says so
  rather than failing.
- **`C`** opens the **compendium** in your browser with that character loaded into it.
  It starts a loopback-only server (`tools/m59-compendium.mjs`, port 8099) if one is
  not already up, reads the character's attributes, confirmed abilities and actual
  equipment out of the broker, and hands them over as a cookie — so the bestiary's
  171 rows are computed against the character you are looking at rather than a preset
  you would otherwise type in by hand. Skills it has not learned are counted as zero
  and the page says so, because the whole table is computed from them.

!`node -e "
const { spawn } = require('child_process');
const cwd = process.cwd();
// The fleet goes THROUGH to the TUI. Without it the new window resolves its own
// default, which is usually the same answer and is not guaranteed to be — and a TUI
// showing a roster the broker is not holding is the quietest kind of wrong.
const fleet = process.argv[1] || '';
const inner = 'node tools/m59-tui.mjs' + (fleet ? ' --fleet ' + fleet : '');
// Windows Terminal if it is installed — it handles the alt-screen and colours
// properly — otherwise a plain PowerShell window, which also works.
const tryWt = spawn('cmd', ['/c', 'where', 'wt'], { stdio: 'ignore' });
tryWt.on('close', code => {
  if (code === 0) {
    spawn('cmd', ['/c', 'start', '', 'wt', '-d', cwd, 'powershell', '-NoProfile', '-NoExit', '-Command', inner],
          { detached: true, stdio: 'ignore', cwd }).unref();
    console.log('opened in Windows Terminal');
  } else {
    spawn('cmd', ['/c', 'start', '', 'powershell', '-NoProfile', '-NoExit', '-Command', inner],
          { detached: true, stdio: 'ignore', cwd }).unref();
    console.log('opened in a PowerShell window');
  }
});
" "$ARGUMENTS" 2>&1`

## What you can do in it

| key | |
|---|---|
| `↑` `↓` or `j` `k` | move between the characters in that fleet, **skipping the ones on fleet work** |
| `Enter` | open that character's full sheet — vitals, pack, safe spot, readings, recent log |
| `X` | **override** — reach the greyed-out ones, and take one back off whatever is holding it |
| `L` | **launch the real client logged in as that character**, then inject the agent DLL |
| `B` | **open the commander on this fleet** — `maps/m59-boswars`, the whole roster on one board |
| `r` | force a refresh |
| `q` / `Esc` | back, then quit |

**Greyed rows are not broken characters.** A dimmed name with a `·` in the gutter is a
character the fleet is deliberately using: it is walking somewhere, casting for somebody,
or paired with someone who will not start a fight without it. The header says how many,
the row says which operation, and the character's sheet says what taking it would cost.
Every other column on those rows reads as a fault when it is not one — no kills, a
stalled-looking activity — which is why they are marked rather than left to be
misdiagnosed. Nothing is hidden: `X` reaches all of them.

`L` is the part a browser cannot do. It starts `Meridian.exe` with `/H /P /U /W /Q`
already filled in from the roster, waits for it to come up, and runs the injector — so
the character is playable by hand *and* drivable by the MCP, with no copying anything.

Two things it will not do for you: the client **must keep window focus** or it ignores
movement entirely (`HandleKeys` returns early unless `GetFocus()` is the client), and the
passwords come from **that fleet's own roster** — `substrate/fleets/<fleet>.json`, or
`substrate/fleet-state.json` for the unnamed one — which is read locally and never sent
over the network.

If the window says the broker is not answering, the broker is down — `/m59-restart`.
