import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
M59 = os.environ.get("M59_ROOT", "C:/code/Meridian59").replace("\\", "/")

rooms = json.load(open(os.path.join(HERE, "rooms.json"), encoding="utf-8"))
mons  = json.load(open(os.path.join(HERE, "monsters2.json"), encoding="utf-8"))
lvl = {m["class"].lower(): (m["viLevel"], m["name"], m["viKarma"], m["viDifficulty"], m["viTreasure_type"]) for m in mons}
RROOT = M59 + "/kod/object/active/holder/room"

out=[]
for r in rooms:
    if not r["plMonsters"]: continue
    rn = r.get("room_name") or r.get("class","?")
    comp=[]
    for blk in r["plMonsters"]:
        for c,w in blk["pairs"]:
            info = lvl.get(c.lower())
            if info: comp.append((c, info[0], w, info[1]))
    if not comp: continue
    levels=[int(c[1]) for c in comp if str(c[1]).isdigit()]
    out.append({
      "room": rn, "rid": r.get("rid",""),
      "file": os.path.relpath(r["file"], RROOT).replace("\\","/"),
      "line": r["plMonsters"][0]["line"],
      "minlvl": min(levels) if levels else 0, "maxlvl": max(levels) if levels else 0,
      "comp": comp,
      "gen": r.get("pigen_time",""), "pct": r.get("pigen_percent",""),
      "imin": r.get("piinit_count_min",""), "imax": r.get("piinit_count_max",""),
      "cap": r.get("pimonster_count_max",""), "ngen": r.get("ngen",""),
    })
out.sort(key=lambda x:(x["maxlvl"], x["minlvl"]))
for x in out:
    c = ", ".join(f'{a}({b}) {w}%' for a,b,w,_ in x["comp"])
    print(f'{x["maxlvl"]:>3} | {x["room"][:42]:42s} | {x["rid"]:24s} | gen={x["gen"] or "20000":>6s}ms/{x["pct"] or "100":>3s}% init={x["imin"] or "1"}-{x["imax"] or "5"} cap={x["cap"] or "10":>2s} pts={x["ngen"] or "?"} | {c} | {x["file"]}:{x["line"]}')
