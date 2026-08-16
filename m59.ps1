# THE FLEET TERMINAL, FROM THE ROOT OF THIS REPOSITORY — the Windows half of m59.sh.
#
#     .\m59.ps1                 the fleet terminal, on this checkout's default fleet
#     .\m59.ps1 --fleet prod    a named fleet
#     .\m59.ps1 status          is the broker up, and the field command page with it
#     .\m59.ps1 up              start the broker (and the page) for this fleet
#     .\m59.ps1 down            stop them again
#     .\m59.ps1 field           just open the field command page in a browser
#
# Kept beside m59.sh rather than folded into it: the two are a few lines each and the
# alternative is a shim that shells out to bash on a machine that may not have one. Both
# are thin — every behaviour lives in tools/, so prefer changing the tool.
#
# IT STARTS NO BROKER BY ITSELF. One broker holds one fleet; a second comes up healthy and
# EMPTY while the real one plays on. Bringing one up is `up`, said out loud.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'node is not on PATH — this repository is all .mjs'; exit 1
}

$cmd = 'terminal'
$rest = @($args)
if ($rest.Count -gt 0 -and @('terminal','status','up','down','field','logs') -contains $rest[0]) {
  $cmd = $rest[0]
  $rest = @($rest | Select-Object -Skip 1)
}

switch ($cmd) {
  'status' { node tools/m59-service.mjs status @rest; exit $LASTEXITCODE }
  'up'     { node tools/m59-service.mjs start  @rest; exit $LASTEXITCODE }
  'down'   { node tools/m59-service.mjs stop   @rest; exit $LASTEXITCODE }
  'logs'   { node tools/m59-service.mjs logs   @rest; exit $LASTEXITCODE }
  'field'  {
    node tools/m59-webui.mjs start @rest | Out-Host
    $port = if ($env:M59_STRATEGY_PORT) { $env:M59_STRATEGY_PORT } else { '3000' }
    Start-Process "http://127.0.0.1:$port"
    exit 0
  }
  default  {
    # WHICH FLEET, BEFORE ANYTHING ELSE. Read-only, non-zero on a mismatch between the
    # fleet this invocation means and the one the broker is actually holding.
    node tools/m59-which.mjs @rest
    if ($LASTEXITCODE -ne 0) {
      Write-Host ''
      Write-Error "refusing to open a terminal on a fleet the broker is not holding. Pass --fleet <name>, or: .\m59.ps1 up --fleet <name>"
      exit 1
    }
    Write-Host ''
    node tools/m59-tui.mjs @rest
    exit $LASTEXITCODE
  }
}
