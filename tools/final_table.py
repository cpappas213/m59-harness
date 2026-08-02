import json, os, re, collections

HERE = os.path.dirname(os.path.abspath(__file__))
M59 = os.environ.get("M59_ROOT", "C:/code/Meridian59").replace("\\", "/")

mons = json.load(open(os.path.join(HERE, "monsters2.json"), encoding="utf-8"))
xref = json.load(open(os.path.join(HERE, "xref2.json"), encoding="utf-8"))
rooms = json.load(open(os.path.join(HERE, "rooms.json"), encoding="utf-8"))

# weight sums per room
print("=== ROOMS WHOSE plMonsters WEIGHTS DO NOT SUM TO 100 (roll can fall through = no spawn) ===")
for r in rooms:
    for blk in r["plMonsters"]:
        tot = sum(int(w) for c,w in blk["pairs"] if w.lstrip('-').isdigit())
        if tot != 100:
            print(f'  {tot:>4}%  {r.get("room_name") or r.get("class")}  ({os.path.basename(r["file"])}:{blk["line"]})')

def hp(l):
    l=int(l); return l if l<40 else (120*l)//100
def dmg(l):
    l=int(l)
    lo=l//15; hi=l//10
    def fz(n):
        if n<1: return (1,1)
        return (n-n//4, n-n//4 + (2*n)//4)
    a=fz(lo); b=fz(hi)
    return max(1,min(a[0],b[0])), max(1,max(a[1],b[1]))
def atktime(d,s):
    d=int(d); s=int(s)
    base = 3500 - 70*(3*d+s)
    return (750+base, 1250+base)

SPEED={"SPEED_NONE":0,"SPEED_VERY_SLOW":4,"SPEED_SLOW":8,"SPEED_AVERAGE":12,"SPEED_FAST":16,"SPEED_VERY_FAST":20}
print()
print("=== FULL MONSTER TABLE ===")
hdr=["class","display name","lvl","maxHP","diff","karma","offense=defense","dmg/hit","atk interval ms","atk type","spell","aggro","treasure","rooms"]
print("\t".join(hdr))
for m in sorted(mons, key=lambda x:(int(x["viLevel"]), x["class"])):
    L=m["viLevel"]; D=m["viDifficulty"]
    sp = m["viSpeed"]
    spn = SPEED.get(sp, sp if str(sp).isdigit() else 0)
    off = 3*int(L)+60*int(D)
    dlo,dhi = dmg(L)
    a1,a2 = atktime(D, spn)
    beh = re.sub(r"\s+"," ",m["viDefault_behavior"] or "")
    att = re.sub(r"\s+"," ",m["viAttributes"] or "")
    aggro=[]
    if "AI_FIGHT_HYPERAGGRESSIVE" in beh: aggro.append("HYPER")
    if "AI_FIGHT_AGGRESSIVE" in beh: aggro.append("aggr")
    if "AI_FIGHT_KARMA_AGGRESSIVE" in beh: aggro.append("karma-aggr")
    if "AI_FIGHT_MURDERERS" in beh: aggro.append("murderers-only")
    if "AI_FIGHT_NEWBIESAFE" in beh: aggro.append("newbiesafe")
    if "AI_NOFIGHT" in beh or "MOB_NOFIGHT" in att: aggro.append("NOFIGHT")
    if "AI_NPC" in beh: aggro.append("NPC-unattackable")
    if not aggro: aggro.append("passive")
    rl = xref.get(m["class"], [])
    seen=set(); rr=[]
    for e in rl:
        k=(e["room"], e["w"])
        if k in seen: continue
        seen.add(k); rr.append(f'{e["room"]}({e["w"]})')
    print("\t".join([m["class"], m["name"], L, str(hp(L)), D, m["viKarma"], str(off),
                     f"{dlo}-{dhi}", f"{a1}-{a2}", re.sub(r'\s+',' ',m['viAttack_type'] or ''),
                     re.sub(r'\s+',' ',m['viAttack_spell'] or ''),
                     "|".join(aggro), m["viTreasure_type"], "; ".join(rr[:8]) or "NO SPAWN IN KOD"]))
