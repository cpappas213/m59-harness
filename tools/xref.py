import json, os, re, collections

HERE = os.path.dirname(os.path.abspath(__file__))
M59 = os.environ.get("M59_ROOT", "C:/code/Meridian59").replace("\\", "/")

rooms = json.load(open(os.path.join(HERE, "rooms.json"), encoding="utf-8"))
mons  = json.load(open(os.path.join(HERE, "monsters2.json"), encoding="utf-8"))
monclasses = {m["class"] for m in mons}

RROOT = M59 + "/kod/object/active/holder/room"
def rel(p):
    try: return os.path.relpath(p, RROOT).replace("\\","/")
    except: return p

xref = collections.defaultdict(list)   # monster class -> list of (roomname, file:line, weight, roomprops)
for r in rooms:
    rn = r.get("room_name") or r.get("class","?")
    for blk in r["plMonsters"]:
        for cls, w in blk["pairs"]:
            xref[cls].append({
                "room": rn, "rid": r.get("rid",""), "cite": f'{rel(r["file"])}:{blk["line"]}',
                "weight": w,
                "gen_time": r.get("pigen_time",""), "gen_pct": r.get("pigen_percent",""),
                "init_min": r.get("piinit_count_min",""), "init_max": r.get("piinit_count_max",""),
                "cap": r.get("pimonster_count_max",""), "ngen": r.get("ngen",""),
                "src":"plMonsters"})
    for cls, ln in r["creates"]:
        if cls in monclasses:
            xref[cls].append({"room": rn, "rid": r.get("rid",""),
                "cite": f'{rel(r["file"])}:{ln}', "weight":"fixed",
                "gen_time":"", "gen_pct":"", "init_min":"","init_max":"","cap":"","ngen":"",
                "src":"Create()"})

json.dump({k:v for k,v in xref.items()}, open(os.path.join(HERE, "xref.json"),"w",encoding="utf-8"), indent=1)

for m in mons:
    c = m["class"]
    if c in xref:
        print(f'== {c} (L{m["viLevel"]}) {m["name"]}')
        for e in xref[c]:
            print(f'    {e["room"]:38s} w={e["weight"]:>5s} gen={e["gen_time"]:>7s}ms pct={e["gen_pct"]:>3s} init={e["init_min"]}-{e["init_max"]} cap={e["cap"]} pts={e["ngen"]} [{e["src"]}] {e["cite"]}')

print("\n### monsters with NO room reference:")
for m in mons:
    if m["class"] not in xref:
        print(f'   {m["class"]:24s} L{m["viLevel"]:>4s} {m["name"]}')
