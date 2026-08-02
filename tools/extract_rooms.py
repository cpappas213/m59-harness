import os, re, json

HERE = os.path.dirname(os.path.abspath(__file__))
M59 = os.environ.get("M59_ROOT", "C:/code/Meridian59").replace("\\", "/")

ROOM = M59 + "/kod/object/active/holder/room"
ALLKOD = M59 + "/kod"

def readfile(p):
    with open(p, "r", encoding="latin-1") as f:
        return f.read()

rooms = []
for dirpath, dn, fn in os.walk(ROOM):
    for f in fn:
        if f.lower().endswith(".kod"):
            rooms.append(os.path.join(dirpath, f))
# room.kod itself
rooms.append(os.path.join(os.path.dirname(ROOM), "room.kod"))

recs = []
for p in rooms:
    txt = readfile(p)
    lines = txt.split("\n")
    rec = {"file": p.replace("\\","/")}
    for i,l in enumerate(lines):
        m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s+is\s+([A-Za-z_][A-Za-z0-9_]*)\s*$", l)
        if m:
            rec["class"]=m.group(1); rec["parent"]=m.group(2); break
    # room name resource
    res = {}
    for i,l in enumerate(lines):
        m = re.match(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"(.*)"\s*$', l)
        if m: res[m.group(1)] = (m.group(2), i+1)
    m = re.search(r"^\s*vrName\s*=\s*([A-Za-z_][A-Za-z0-9_]*)", txt, re.M)
    if m and m.group(1) in res:
        rec["room_name"] = res[m.group(1)][0]
    elif m:
        rec["room_name"] = m.group(1)
    m = re.search(r"^\s*piRoom_num\s*=\s*(\S+)", txt, re.M)
    if m: rec["rid"] = m.group(1).rstrip(";")
    # numeric room props
    for k in ["piGen_time","piGen_Time","piGen_percent","piInit_count_min",
              "piInit_count_max","piMonster_count_max","piReload_Wait_Time",
              "pbLoad_first_monster_only","piBaseLight"]:
        mm = re.search(r"^\s*"+k+r"\s*=\s*([^%\n;]+)", txt, re.M|re.I)
        if mm: rec[k.lower()] = mm.group(1).strip().rstrip(";")
    # plMonsters assignment: capture until closing ];
    mons = []
    for m in re.finditer(r"plMonsters\s*=\s*(.*?);", txt, re.S):
        body = m.group(1)
        ln = txt[:m.start()].count("\n")+1
        pairs = re.findall(r"\[\s*&([A-Za-z_][A-Za-z0-9_]*)\s*,\s*(-?\d+)\s*\]", body)
        if pairs:
            mons.append({"line": ln, "pairs": pairs})
        else:
            single = re.findall(r"&([A-Za-z_][A-Za-z0-9_]*)", body)
            if single: mons.append({"line": ln, "pairs": [(s,"?") for s in single]})
    rec["plMonsters"] = mons
    # explicit Create(&Monster...) calls
    creates = []
    for m in re.finditer(r"Create\s*\(\s*&([A-Za-z_][A-Za-z0-9_]*)", txt):
        ln = txt[:m.start()].count("\n")+1
        creates.append((m.group(1), ln))
    rec["creates"] = creates
    ngen = re.search(r"plGenerators\s*=\s*(.*?);", txt, re.S)
    if ngen:
        rec["ngen"] = len(re.findall(r"\[\s*\d+\s*,\s*\d+\s*\]", ngen.group(1)))
    recs.append(rec)

json.dump(recs, open(os.path.join(HERE, "rooms.json"),"w",encoding="utf-8"), indent=1)
print(len(recs),"room files")
