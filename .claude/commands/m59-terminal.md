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
| `↑` `↓` or `j` `k` | move between the characters in that fleet |
| `Enter` | open that character's full sheet — vitals, pack, safe spot, readings, recent log |
| `L` | **launch the real client logged in as that character**, then inject the agent DLL |
| `r` | force a refresh |
| `q` / `Esc` | back, then quit |

`L` is the part a browser cannot do. It starts `Meridian.exe` with `/H /P /U /W /Q`
already filled in from the roster, waits for it to come up, and runs the injector — so
the character is playable by hand *and* drivable by the MCP, with no copying anything.

Two things it will not do for you: the client **must keep window focus** or it ignores
movement entirely (`HandleKeys` returns early unless `GetFocus()` is the client), and the
passwords come from **that fleet's own roster** — `substrate/fleets/<fleet>.json`, or
`substrate/fleet-state.json` for the unnamed one — which is read locally and never sent
over the network.

If the window says the broker is not answering, the broker is down — `/m59-restart`.
