import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hp_advance import *

print("### A. gain per kill by (took_damage, killing_blow, L vs H) -- H>=30 (no newbie bonus)")
for tb in [(True,True),(True,False),(False,True),(False,False)]:
    for lab,L in [("L>H",100),("L in (H-5,H]",95),("L<=H-5",80)]:
        g,roll=gain_per_kill(95,50,L,tb[1],tb[0])
        print(f"  H=95 took_dmg={tb[0]!s:5} kill_blow={tb[1]!s:5} {lab:13} -> gain={g} roll={roll}")
print()
print("### B. expected kills per +1 hp: gain=3 vs gain=2 (stamina 50, L=H+1)")
print(f"{'H':>4} {'g=3 (dmg+blow)':>16} {'g=2 (one of them)':>18} {'ratio':>7}")
for H in (20,25,30,40,50,60,75,100,125,150):
    if H>cap(50): continue
    e3,_,_=expected_kills(H,50,H+1,True,True)
    e2,_,_=expected_kills(H,50,H+1,True,False)
    print(f"{H:>4} {e3:16.1f} {e2:18.1f} {e2/e3:7.2f}")
print()
print("### C. cumulative kills 20 -> cap, per 10-hp band, L=H+1, gain=3")
for S in (0,25,50,70):
    bt=band_totals(S,1)
    tot=sum(x[2] for x in bt)
    print(f"\n stamina {S}  cap={cap(S)}  TOTAL kills 20->{cap(S)} = {tot:,.0f}")
    for a,b,s in bt:
        print(f"   {a:>3}->{b:<4} {s:9.0f} kills   ({s/max(1,b-a):6.1f}/hp)")
print()
print("### D. total kills 20->cap under different scenarios (stamina 50)")
for lab,kw in [("dmg+blow, L=H+1",dict(dlevel=1)),
               ("dmg+blow, L=H+50",dict(dlevel=50)),
               ("blow only (no dmg taken), L=H+1",dict(dlevel=1,took_damage=False)),
               ("dmg only (no blow), L=H+1",dict(dlevel=1,killing_blow=False)),
               ("dmg+blow, HPGainMultiplier=2",dict(dlevel=1,mult=2)),
               ("dmg+blow, HPGainMultiplier=5",dict(dlevel=1,mult=5))]:
    rows=progression(50,**kw)
    print(f"  {lab:35} {rows[-1][3]:>10,.0f} kills")
print()
print("### E. how much does going higher up the food chain buy you? (H=100,S=50,g=3)")
M=highmark(100,50)
for d in range(0,60,5):
    L=100+d
    b=max(0,min(10,tdiv(L-100,5)))
    E,g,roll=expected_kills(100,50,L) if d>0 else (float('inf'),0,False)
    print(f"  L=H+{d:<3} b={b:<3} E={E if E!=float('inf') else 0:8.2f} kills  (M={M})")
