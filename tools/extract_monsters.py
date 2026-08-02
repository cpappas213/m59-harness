import os, re, json, sys

HERE = os.path.dirname(os.path.abspath(__file__))
M59 = os.environ.get("M59_ROOT", "C:/code/Meridian59").replace("\\", "/")

ROOT = M59 + "/kod/object/active/holder/nomoveon/battler/monster"
OUT = os.path.join(HERE, "monsters.json")

CLASSVAR_KEYS = [
    "viLevel","viDifficulty","viKarma","viTreasure_type","viAttack_type",
    "viAttributes","viDefault_behavior","viBrain_type","viSpeed",
    "viAttack_spell","viMerchant_markup","viOccupation","viWimpy",
    "viGender","viFaction","vrName","vrKocName",
]
PROP_KEYS = ["piMinDamage","piMaxDamage","piOffense","piDefense"]

def parse(path):
    with open(path, "r", encoding="latin-1") as f:
        lines = f.read().split("\n")
    rec = {"file": path.replace("\\","/"), "nlines": len(lines)}
    # class decl
    for i,l in enumerate(lines):
        m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s+is\s+([A-Za-z_][A-Za-z0-9_]*)\s*$", l)
        if m and not l.strip().startswith("%"):
            rec["class"] = m.group(1); rec["parent"] = m.group(2); rec["class_line"] = i+1
            break
    # resources: name strings
    res = {}
    for i,l in enumerate(lines):
        m = re.match(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"(.*)"\s*$', l)
        if m:
            res[m.group(1)] = (m.group(2), i+1)
    rec["_res"] = res
    # classvars / properties assignments (handle continuation with \)
    joined = []
    buf = ""
    for i,l in enumerate(lines):
        s = l.rstrip()
        if s.endswith("\\"):
            if not buf: startln = i+1
            buf += s[:-1]
            continue
        if buf:
            joined.append((startln, buf + s)); buf = ""
        else:
            joined.append((i+1, s))
    for ln, s in joined:
        sc = s.split("%")[0]
        m = re.match(r"^\s*(vi[A-Za-z_]*|vr[A-Za-z_]*|pi[A-Za-z_]*|pl[A-Za-z_]*)\s*=\s*(.+?)\s*$", sc)
        if not m: continue
        k, v = m.group(1), m.group(2).rstrip()
        if k in CLASSVAR_KEYS or k in PROP_KEYS:
            if k not in rec:  # first assignment wins (classvars block)
                rec[k] = v
                rec[k+"_line"] = ln
    # find messages of interest
    msgs = {}
    for i,l in enumerate(lines):
        m = re.match(r"^\s{3}([A-Za-z_][A-Za-z0-9_]*)\s*\(", l)
        if m:
            msgs.setdefault(m.group(1), i+1)
    rec["_msgs"] = msgs
    return rec

recs = []
for dirpath, dirnames, filenames in os.walk(ROOT):
    for fn in filenames:
        if fn.lower().endswith(".kod"):
            recs.append(parse(os.path.join(dirpath, fn)))

with open(OUT,"w",encoding="utf-8") as f:
    json.dump(recs, f, indent=1)
print(len(recs), "files")
