from verify import *
def band(S,lo,hi):
    ceil=min(100+S,150)
    tot=0.0; n=0
    for H in range(lo,hi):
        if H>=ceil: break
        tot+=E_kills(H,S,gain_for(H)); n+=1
    return tot,n
cols=[1,25,50,70]
claim={
 (20,30):[186,145,107,75],(30,40):[385,281,183,102],(40,50):[482,356,236,137],
 (50,60):[571,427,289,175],(60,70):[660,498,342,214],(70,80):[749,569,395,252],
 (80,90):[838,639,448,290],(90,100):[927,710,500,329],(100,110):[None,781,553,367],
 (110,120):[None,852,606,406],(120,130):[None,453,659,444],(130,140):[None,None,712,482],
 (140,150):[None,None,765,521]}
print(f"{'band':10s}" + "".join(f"{('S='+str(S)):>16s}" for S in cols))
bad=[]
for (lo,hi),cl in claim.items():
    out=f"{lo}->{hi:<6d}"
    for i,S in enumerate(cols):
        t,n=band(S,lo,hi)
        c=cl[i]
        if n==0:
            out+=f"{'--':>16s}"
            if c is not None: bad.append((lo,hi,S,"claimed value, over cap",c))
        else:
            s=f"{t:.0f}({n}hp)"
            if c is None: bad.append((lo,hi,S,"claimed --, actual",s))
            elif abs(t-c)>1.0: bad.append((lo,hi,S,f"claim {c}",f"actual {t:.1f} over {n} hp"))
            out+=f"{s:>16s}"
    print(out)
print()
for S in [0,1,25,50,70]:
    ceil=min(100+S,150)
    tot=sum(E_kills(H,S,gain_for(H)) for H in range(20,ceil))
    print(f" S={S:2d} ceiling {ceil}: total 20->{ceil} = {tot:.0f}")
print("\n first band S=0:", f"{band(0,20,30)[0]:.1f}", " S=1:", f"{band(1,20,30)[0]:.1f}")
print("\n=== cumulative milestones S=25 ===")
run=0.0
mil={30:166,40:459,50:821,60:1255,70:1759,80:2335,90:2982,100:3700,110:4488,120:5347,125:5711}
for H in range(20,125):
    run+=E_kills(H,25,gain_for(H))
    if H+1 in mil: print(f"  {H+1}hp @ {run:.0f}  (claim {mil[H+1]})", "" if abs(run-mil[H+1])<1.5 else "  <-- MISMATCH")
print("\n=== MISMATCHES ===")
for b in bad: print(b)
