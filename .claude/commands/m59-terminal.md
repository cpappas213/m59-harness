---
description: Open the interactive fleet terminal — arrow keys, per-character sheets, and a launch key that actually starts the game
---

Opening the fleet TUI in its own terminal window.

**Why a separate window and not this conversation.** A slash command runs a command and
puts its output here; it cannot hand you the keyboard. What you want — arrow keys, Enter
to open a character, a key that starts a program — needs a terminal that is yours to
drive. So this launches one. It talks to the same broker on 8901 that everything else
does, so it is the same fleet, live.

!`node -e "
const { spawn } = require('child_process');
const cwd = process.cwd();
const inner = 'node tools/m59-tui.mjs';
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
" 2>&1`

## What you can do in it

| key | |
|---|---|
| `↑` `↓` or `j` `k` | move between the 25 characters |
| `Enter` | open that character's full sheet — vitals, pack, safe spot, readings, recent log |
| `L` | **launch the real client logged in as that character**, then inject the agent DLL |
| `r` | force a refresh |
| `q` / `Esc` | back, then quit |

`L` is the part a browser cannot do. It starts `Meridian.exe` with `/H /P /U /W /Q`
already filled in from the roster, waits for it to come up, and runs the injector — so
the character is playable by hand *and* drivable by the MCP, with no copying anything.

Two things it will not do for you: the client **must keep window focus** or it ignores
movement entirely (`HandleKeys` returns early unless `GetFocus()` is the client), and the
passwords come from `substrate/fleet-state.json`, which is read locally and never sent
over the network.

If the window says the broker is not answering, the broker is down — `/m59-restart`.
