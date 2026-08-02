import json, re, os

HERE = os.path.dirname(os.path.abspath(__file__))
M59 = os.environ.get("M59_ROOT", "C:/code/Meridian59").replace("\\", "/")

recs = json.load(open(os.path.join(HERE, "monsters.json"), encoding="utf-8"))

def resolve_name(r):
    v = r.get("vrName")
    if not v: return ("", "")
    v = v.rstrip(";").strip()
    res = r["_res"]
    if v in res:
        return res[v][0], f'{os.path.basename(r["file"])}:{res[v][1]}'
    return v, ""

def num(r, k):
    v = r.get(k)
    if v is None: return None
    return v.rstrip(";").strip()

rows = []
for r in recs:
    nm, nmcite = resolve_name(r)
    rows.append({
        "class": r.get("class",""),
        "parent": r.get("parent",""),
        "name": nm,
        "file": r["file"],
        "lvl": num(r,"viLevel"),
        "lvl_line": r.get("viLevel_line"),
        "diff": num(r,"viDifficulty"),
        "karma": num(r,"viKarma"),
        "treas": num(r,"viTreasure_type"),
        "atk": num(r,"viAttack_type"),
        "spell": num(r,"viAttack_spell"),
        "attrs": num(r,"viAttributes"),
        "behav": num(r,"viDefault_behavior"),
        "brain": num(r,"viBrain_type"),
        "speed": num(r,"viSpeed"),
        "mind": num(r,"piMinDamage"),
        "maxd": num(r,"piMaxDamage"),
        "off": num(r,"piOffense"),
        "def": num(r,"piDefense"),
        "occ": num(r,"viOccupation"),
        "msgs": sorted(r["_msgs"].keys()),
    })

def key(x):
    try: return (0, int(x["lvl"]))
    except: return (1, 0)
rows.sort(key=key)

for x in rows:
    print("|".join([
        str(x["class"]), str(x["name"]), str(x["lvl"]), str(x["diff"]), str(x["karma"]),
        str(x["treas"]), str(x["atk"]), str(x["spell"]), str(x["mind"]), str(x["maxd"]),
        str(x["off"]), str(x["def"]), str(x["speed"]), str(x["brain"]),
        str(x["attrs"]), str(x["behav"]), str(x["occ"]),
        os.path.relpath(x["file"], M59 + "/kod/object/active/holder/nomoveon/battler/monster").replace("\\","/"),
        str(x["lvl_line"]),
    ]))
