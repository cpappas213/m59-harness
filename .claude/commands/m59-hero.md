---
description: Everything about one character — vitals, pack, safe spot, and its recent log
argument-hint: <character name> [fleet]
---

Full detail on **$1**, pulled live from the broker.

**Which fleet it is in.** Character names are only unique within a server, so the same
name can exist in two fleets and mean two different characters. This is the one the
broker is holding:

!`node tools/m59-which.mjs --fleet $2 2>&1`

!`node -e "
const who=process.argv[1]||'';
const P=process.env.M59_BROKER_PORT||'8901';
const call=async(n,a={},ms=8000)=>{const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);
 try{const r=await fetch('http://127.0.0.1:'+P+'/',{method:'POST',headers:{'content-type':'application/json'},signal:c.signal,
 body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:n,arguments:a}})});
 const j=await r.json();if(j.result?.isError)return null;return JSON.parse(j.result.content[0].text);}catch(e){return null}finally{clearTimeout(t)}};
const l=await call('autopilot',{agent:'any',action:'list'});
if(!l){console.log('broker not answering');process.exit(0)}
const f=await call('fleet',{},15000);
const row=(f?.fleet||[]).find(r=>String(r.character||'').toLowerCase()===who.toLowerCase());
if(!row){console.log('No character called '+JSON.stringify(who)+'. Fleet: '+(f?.fleet||[]).map(r=>r.character).join(', '));process.exit(0)}
const ap=l.autopilots.find(a=>a.name===row.agent);
console.log(row.character+'  ('+row.agent+')  '+(ap?.policy?.strategy??'')+'  in '+row.room+' [room '+row.room_num+']');
console.log('  doing    : '+(ap?.activity??'?'));
console.log('  health   : '+row.health+'    mana '+row.mana+'    vigor '+row.vigor_of);
console.log('  weapon   : '+(row.has_weapon?'yes':'NO')+'      food: '+(row.has_food?'yes':'NO')+'      carrying '+row.carrying);
console.log('  safe spot: '+(ap?.safe_spot?JSON.stringify(ap.safe_spot.at)+' '+(ap.safe_spot.works?'HOLDS':'untested')+' — '+ap.safe_spot.evidence:'none'));
console.log('  survival : '+(ap?.did?.deaths??0)+' deaths, '+(ap?.did?.deaths_in_safe_spot??0)+' of them in a safe spot, '+(ap?.did?.mulligans??0)+' mulligans, '+(ap?.did?.logoffs??0)+' logoffs');
if(ap?.stalled)console.log('  STALLED  : '+ap.stalled.why+' ('+ap.stalled.since_seconds+'s)');
const inv=await call('inventory',{agent:row.agent});
console.log('\ncarrying: '+((inv?.items||[]).map(i=>i.name+(i.amount?' x'+i.amount:'')).join(', ')||'nothing'));
console.log('\nrecent readings (safe spot experiment):');
for(const t of (ap?.trials||[]).slice(-8))console.log('  '+(t.counted?'COUNTED ':'skipped ')+t.verdict);
console.log('\nrecent log:');
for(const e of (ap?.recent||[]).slice(-12))console.log('  '+e.what+' — '+JSON.stringify(e).slice(0,120));
" "$1" 2>&1`

Hero page with the full sheet, inventory and compendium links:
**http://127.0.0.1:8902/hero/$1**

Summarise what stands out, naming the fleet it is about. Do not change anything unless
I ask.
