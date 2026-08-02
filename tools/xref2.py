import json, os, re, collections

HERE = os.path.dirname(os.path.abspath(__file__))
M59 = os.environ.get("M59_ROOT", "C:/code/Meridian59").replace("\\", "/")

KOD = M59 + "/kod"
mons  = json.load(open(os.path.join(HERE, "monsters2.json"), encoding="utf-8"))
lower2class = {m["class"].lower(): m["class"] for m in mons}

files=[]
for dp,dn,fn in os.walk(KOD):
    for f in fn:
        if f.lower().endswith(".kod"):
            files.append(os.path.join(dp,f))

# cache room names per file
def roomname(txt):
    res={}
    for l in txt.split("\n"):
        m=re.match(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"(.*)"\s*$',l)
        if m: res[m.group(1)]=m.group(2)
    m=re.search(r"^\s*vrName\s*=\s*([A-Za-z_][A-Za-z0-9_]*)",txt,re.M)
    if m: return res.get(m.group(1), m.group(1))
    return None

xref = collections.defaultdict(list)
for p in files:
    txt=open(p,"r",encoding="latin-1").read()
    rn = roomname(txt)
    rel = os.path.relpath(p, KOD).replace("\\","/")
    isroom = "/room" in rel or rel.startswith("object/active/holder/room")
    # plMonsters blocks
    for m in re.finditer(r"plMonsters\s*=\s*(.*?);", txt, re.S):
        body=m.group(1); ln=txt[:m.start()].count("\n")+1
        for cls,w in re.findall(r"\[\s*&([A-Za-z_][A-Za-z0-9_]*)\s*,\s*(-?\d+)\s*\]", body):
            if cls.lower() in lower2class:
                xref[lower2class[cls.lower()]].append({"room":rn or "?","cite":f"{rel}:{ln}","w":w,"src":"plMonsters"})
    # Create(&X) anywhere
    for m in re.finditer(r"Create\s*\(\s*&([A-Za-z_][A-Za-z0-9_]*)", txt):
        cls=m.group(1)
        if cls.lower() in lower2class:
            ln=txt[:m.start()].count("\n")+1
            xref[lower2class[cls.lower()]].append({"room":rn or "?","cite":f"{rel}:{ln}","w":"fixed","src":"Create"})
json.dump(xref, open(os.path.join(HERE, "xref2.json"),"w",encoding="utf-8"), indent=1)

for m in mons:
    c=m["class"]
    if c in xref:
        # dedupe by (room,src,w)
        seen=set(); lines=[]
        for e in xref[c]:
            k=(e["room"],e["w"],e["cite"].rsplit(":",1)[0])
            if k in seen: continue
            seen.add(k); lines.append(e)
        print(f'== {c} L{m["viLevel"]} "{m["name"]}"  [{len(xref[c])} refs]')
        for e in lines:
            print(f'    {e["room"][:44]:44s} w={e["w"]:>5s} {e["src"]:9s} {e["cite"]}')
    else:
        print(f'== {c} L{m["viLevel"]} "{m["name"]}"  NO REFS')
