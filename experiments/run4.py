import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hp_advance import *
print("### L. FIRST hp of a brand-new char (piGain_chance starts at 0, player.kod:751)")
for S in (1,25,50):
    E,g,r=expected_kills(20,S,21,G0=0)
    Es,_,_=expected_kills(20,S,21)
    print(f"  S={S:<3} first hp: {E:.1f} kills (G0=0)   vs steady-state {Es:.1f} (G0={G0_after_gain(20,S)})")
print()
print("### M. ALTERED-FORM / BIG-BUFF PENALTY (player.kod:7811-7816)")
H,S=100,50
for pimax in (100,150,200,201,250,300):
    g,roll=gain_per_kill(H,S,H+1,True,True,pimax=pimax)
    E,_,_=expected_kills(H,S,H+1,pimax=pimax)
    print(f"  H={H} piMax_health={pimax:<4} -> gain={g} roll={roll}  E={'INF (never gains)' if E==float('inf') else f'{E:.1f}'}")
print()
print("### N. theoretical ceiling from the 1-attack/sec throttle (player.kod:5305)")
for S in (1,25,50):
    rows=progression(S,1); tot=rows[-1][3]
    print(f"  S={S:<3} cap={cap(S)}  {tot:,.0f} kills; at the absolute floor of 1 kill/sec = {tot/3600:.2f} h of continuous combat")
    for H in (20,50,100,cap(S)-1):
        E,_,_=expected_kills(H,S,H+1)
        print(f"      H={H:>3}: 1 kill/s -> {3600/E:6.1f} hp/h ceiling; 4 s/kill -> {3600/(E*4):5.2f} hp/h; 10 s/kill -> {3600/(E*10):5.2f} hp/h")
print()
print("### O. min swings to kill L=H+1 (monster hp = L if L<40 else 1.2L; monster.kod:4084-4089)")
for H in (20,30,50,75,100,125,150):
    L=H+1; mhp = L if L<40 else (120*L)//100
    print(f"  H={H:>3} L={L:>3} monster_hp={mhp:>4} | dmg/hit 10->{-(-mhp//10)} swings, 25->{-(-mhp//25)}, 50->{-(-mhp//50)}, 100->{-(-mhp//100)}")
