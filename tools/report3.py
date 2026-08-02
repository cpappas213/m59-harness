import json, re, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
M59 = os.environ.get("M59_ROOT", "C:/code/Meridian59").replace("\\", "/")

out = json.load(open(os.path.join(HERE, "monsters2.json"), encoding="utf-8"))

def clean(v):
    if v is None: return ""
    return re.sub(r"\s+", " ", str(v)).strip()

def maxhp(lvl):
    try: l=int(lvl)
    except: return ""
    return l if l<40 else (120*l)//100

for x in out:
    lvl = x["viLevel"]
    hp = maxhp(lvl)
    try:
        l=int(lvl)
        dmg = f"{max(1,l//15)}-{max(1,l//10)}"
    except:
        dmg=""
    print("\t".join([
        clean(x["class"]), clean(x["name"]), clean(lvl), str(hp), clean(x["viDifficulty"]),
        clean(x["viKarma"]), clean(x["viTreasure_type"]), clean(x["viAttack_type"]),
        clean(x["viAttack_spell"]), dmg,
        clean(x["viSpeed"]), clean(x["viAttributes"]), clean(x["viDefault_behavior"]),
        clean(x["viOccupation"]), clean(x["file"]), clean(x["viLevel_cite"]),
        clean(x["viDifficulty_cite"]), clean(x["viKarma_cite"]), clean(x["viTreasure_type_cite"]),
    ]))
