import json, re, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
M59 = os.environ.get("M59_ROOT", "C:/code/Meridian59").replace("\\", "/")

MROOT = M59 + "/kod/object/active/holder/nomoveon/battler/monster"
recs = json.load(open(os.path.join(HERE, "monsters.json"), encoding="utf-8"))
byclass = {}
for r in recs:
    if r.get("class"): byclass[r["class"]] = r

# monster.kod defaults (base class)
BASE = {
 "viLevel": ("25", "monster.kod:231"),
 "viDifficulty": ("0", "monster.kod:230"),
 "viKarma": ("0", "monster.kod:227"),
 "viTreasure_type": ("TID_NONE", "monster.kod:214"),
 "viAttack_type": ("ATCK_WEAP_HIT", "monster.kod:205"),
 "viAttack_spell": ("0", "monster.kod:206"),
 "viAttributes": ("0", "monster.kod:224"),
 "viDefault_behavior": ("0", "monster.kod:234"),
 "viBrain_type": ("BRAIN_ORIGINAL", "monster.kod:233"),
 "viSpeed": ("0", "monster.kod:211"),
 "viOccupation": ("0", "monster.kod:222"),
 "viWimpy": ("0", "monster.kod:236"),
 "viMerchant_markup": ("MERCHANT_NORMAL", "monster.kod:207"),
 "piMinDamage": ("$", "monster.kod:333"),
 "piMaxDamage": ("$", "monster.kod:334"),
 "piOffense": ("$", "monster.kod:331"),
 "piDefense": ("$", "monster.kod:332"),
}

def short(path):
    return os.path.relpath(path, MROOT).replace("\\","/")

def get(cls, key):
    """return (value, citation, definedin)"""
    seen=set()
    c = cls
    while c and c in byclass and c not in seen:
        seen.add(c)
        r = byclass[c]
        if key in r:
            return (r[key].rstrip(";").strip(), f'{short(r["file"])}:{r[key+"_line"]}', c)
        c = r.get("parent")
    if key in BASE:
        return (BASE[key][0], BASE[key][1], "Monster")
    return (None, "", None)

def nm(cls):
    seen=set(); c=cls
    while c and c in byclass and c not in seen:
        seen.add(c); r=byclass[c]
        if "vrName" in r:
            v=r["vrName"].rstrip(";").strip()
            if v in r["_res"]:
                return r["_res"][v][0], f'{short(r["file"])}:{r["_res"][v][1]}'
            return v, ""
        c=r.get("parent")
    return "", ""

KEYS=["viLevel","viDifficulty","viKarma","viTreasure_type","viAttack_type","viAttack_spell",
      "piMinDamage","piMaxDamage","piOffense","piDefense","viSpeed","viBrain_type",
      "viAttributes","viDefault_behavior","viOccupation"]

out=[]
for r in recs:
    cls=r.get("class")
    if not cls: continue
    d={"class":cls,"parent":r.get("parent"),"file":short(r["file"])}
    d["name"],d["name_cite"]=nm(cls)
    for k in KEYS:
        v,cite,src=get(cls,k)
        d[k]=v; d[k+"_cite"]=cite; d[k+"_src"]=src
    d["msgs"]=r["_msgs"]
    out.append(d)

def lv(x):
    try: return int(x["viLevel"])
    except: return 9999
out.sort(key=lv)
json.dump(out, open(os.path.join(HERE, "monsters2.json"),"w",encoding="utf-8"), indent=1)

for x in out:
    print("|".join([x["class"], x["name"], str(x["viLevel"]), str(x["viDifficulty"]),
      str(x["viKarma"]), str(x["viTreasure_type"]), str(x["viAttack_type"]), str(x["viAttack_spell"]),
      str(x["piMinDamage"]), str(x["piMaxDamage"]), str(x["piOffense"]), str(x["piDefense"]),
      str(x["viSpeed"]), str(x["viBrain_type"]), str(x["viAttributes"]),
      str(x["viDefault_behavior"]), str(x["viOccupation"]),
      x["file"], x["viLevel_cite"]]))
