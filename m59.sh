#!/usr/bin/env bash
# THE FLEET TERMINAL, FROM THE ROOT OF THIS REPOSITORY.
#
#     ./m59.sh                 the fleet terminal, on this checkout's default fleet
#     ./m59.sh --fleet prod    a named fleet
#     ./m59.sh status          is the broker up, and the field command page with it
#     ./m59.sh up              start the broker (and the page) for this fleet
#     ./m59.sh down            stop them again
#     ./m59.sh field           just open the field command page in a browser
#
# There is nothing here that `node tools/<something>.mjs` does not already do. What this
# adds is that you do not have to know WHICH something: everything in tools/ is named for
# what it does rather than for when you want it, which is right for forty tools and wrong
# for the one you run first. This is the one you run first.
#
# IT STARTS NO BROKER BY ITSELF, and that is deliberate rather than an omission. A broker
# holds one fleet and a second comes up healthy and EMPTY while the real one plays on, so
# bringing one up is `up`, said out loud, and never a side effect of opening a window.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

command -v node >/dev/null 2>&1 || { echo "node is not on PATH — this repository is all .mjs" >&2; exit 1; }

cmd="${1:-terminal}"
case "$cmd" in terminal|status|up|down|field|logs) shift || true ;; *) cmd=terminal ;; esac

case "$cmd" in
  status) exec node tools/m59-service.mjs status "$@" ;;
  up)     exec node tools/m59-service.mjs start  "$@" ;;
  down)   exec node tools/m59-service.mjs stop   "$@" ;;
  logs)   exec node tools/m59-service.mjs logs   "$@" ;;
  field)
    # Ensure-then-open, the same contract as the terminal's F key. Starting it is cheap
    # and idempotent; opening a browser at a port that is still compiling is not.
    node tools/m59-webui.mjs start "$@" || true
    exec node -e "import('./tools/m59-compendium.mjs').then(m=>m.openBrowser('http://127.0.0.1:'+(process.env.M59_STRATEGY_PORT||3000)))"
    ;;
  terminal)
    # WHICH FLEET, BEFORE ANYTHING ELSE. Read-only, and it exits non-zero when the broker
    # is holding a fleet other than the one this invocation would act on — the failure
    # that once took down a live 46-session broker while every step reported success.
    if ! node tools/m59-which.mjs "$@"; then
      echo
      echo "  refusing to open a terminal on a fleet the broker is not holding." >&2
      echo "  pass --fleet <name>, or start that fleet:  ./m59.sh up --fleet <name>" >&2
      exit 1
    fi
    echo
    exec node tools/m59-tui.mjs "$@"
    ;;
esac
