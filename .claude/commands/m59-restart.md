---
description: Restart the broker on the current code, keeping the roster and every character's orders
---

Restart the fleet onto whatever is on disk now.

**What this does, and the one thing it must not do.** Stopping keepers and killing the
broker is safe: `resumeFleet` logs everyone back in from `substrate/fleet-state.json`
and restarts their keepers with the policy they had. What is NOT safe is `leave` — that
drops characters from the roster, and the roster is the only record of how to log them
back in. So this stops keepers and kills the process, and never calls `leave`.

!`node -e "
const A=['o1','o2','o3','o4','o5','c1','c2','c3','c4','c5','f1','f2','f3','f4','f5','q1','q2','q3','q4','q5','s1','s2','s3','s4','s5'];
const P=process.env.M59_BROKER_PORT||'8901';
let id=0,ok=0;
for(const a of A){try{await fetch('http://127.0.0.1:'+P+'/',{method:'POST',headers:{'content-type':'application/json'},
 body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name:'autopilot',arguments:{agent:a,action:'stop'}}})});ok++}catch(e){}}
console.log('asked '+ok+' keepers to stop');
" 2>&1`

!`node -e "const fs=require('fs');const s=fs.readFileSync('substrate/fleet-state.json','utf8');console.log('roster before restart: '+Object.keys(JSON.parse(s)).length+' characters, '+s.length+' bytes')" 2>&1`

Now do the rest yourself:

1. Kill every running broker:
   `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*m59-broker*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
2. Confirm `substrate/fleet-state.json` still has 25 characters. If it shrank, there is
   a backup at `substrate/fleet-state.json.prev` — say so before doing anything else.
3. Start one broker, in the background, with the client path set so the hero pages can
   build launch scripts:
   `$env:M59_CLIENT_EXE = "C:\Program Files (x86)\Steam\steamapps\common\Meridian 59\Meridian.exe"` then
   `Start-Process node -ArgumentList "tools/m59-broker.mjs","--http","8901","--dashboard","8902" -WindowStyle Hidden` with stdout/stderr redirected to the scratchpad.
4. Wait for 25 `[state] resumed` lines in the log before reporting.
5. Report how many resumed, how many failed, and anything that did not come back.

Run `node tools/m59-safespot-test.mjs` first and do not restart if it fails.
