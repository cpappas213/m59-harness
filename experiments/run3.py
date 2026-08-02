import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hp_advance import *

print("### F. KILLS TO NEXT HP (dmg taken + killing blow, L = H+1, HPGainMult=1)")
stams=[1,10,20,25,30,40,50,60,70]
print("  H  |" + "".join(f" S={s:<3}" for s in stams))
for H in list(range(20,31,2))+list(range(30,151,5)):
    cells=[]
    for s in stams:
        if H>cap(s): cells.append("  --  "); continue
        E,_,_=expected_kills(H,s,H+1)
        cells.append(f"{E:6.1f}")
    print(f" {H:>3} |" + "".join(cells))

print()
print("### G. expected HP per kill = 1/E  (S=25 typical creation stamina)")
for H in (20,25,30,50,75,100,125):
    if H>cap(25): continue
    for lab,kb,td in [("dmg+blow",True,True),("blow only",True,False),("dmg only",False,True)]:
        E,g,r=expected_kills(H,25,H+1,kb,td)
        print(f"  H={H:>3} {lab:9} gain={g} hp/kill={1/E if E!=float('inf') else 0:.5f}  E={E:.1f}")

print()
print("### H. TIME: hours to go 20 -> cap, vs seconds-per-kill")
for S in (1,25,50,70):
    rows=progression(S,1)
    tot=rows[-1][3]
    line=f"  S={S:<3} cap={cap(S):<4} kills={tot:>8,.0f} | "
    line+=" ".join(f"{spk}s/kill={tot*spk/3600:7.1f}h" for spk in (5,10,15,20,30,45,60))
    print(line)

print()
print("### I. max HP/hour at a given H (S=25 and S=50), by seconds-per-kill")
for S in (25,50):
    print(f"  -- stamina {S} --")
    for H in (20,50,100,cap(S)-1):
        E,_,_=expected_kills(H,S,H+1)
        print(f"   H={H:>3} E={E:6.1f} kills/hp | " + " ".join(f"{spk}s:{3600/(E*spk):5.2f}hp/h" for spk in (5,10,20,30,60)))

print()
print("### J. cumulative kills to each milestone (S=25, L=H+1, dmg+blow)")
rows=progression(25,1)
cum={H:t for H,E,g,t in rows}
for H in (30,40,50,60,70,80,90,100,110,120,125):
    if H in cum: print(f"   reach {H:>3} hp: {cum[H]:>8,.0f} cumulative kills")
    elif H-1 in cum: print(f"   reach {H:>3} hp: {cum[H-1]:>8,.0f} cumulative kills")
print(f"   reach {cap(25):>3} hp: {rows[-1][3]:>8,.0f} cumulative kills")

print()
print("### K. sensitivity: same-level farming to bank piGain_chance (gain=1, no roll)")
# H=100 S=50: bank k kills at gain 1 (L in (H-5,H]) then one above-level kill
H,S=100,50; M=highmark(H,S); G0=G0_after_gain(H,S)
print(f"   H={H} S={S} M={M} G0={G0}")
print("   banking N near-level kills (gain 1 each), then P(gain) on next above-level kill (gain 3, b=1):")
for N in (0,10,20,30,50,75,100,150):
    iN = G0 + N*1 + 3 + 1
    p=max(0,min(1,(iN-1)/M))
    print(f"     N={N:<4} iNumber={iN:<5} P={p*100:6.2f}%   total kills spent = {N+1}")
