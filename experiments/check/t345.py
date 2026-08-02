from verify import *
print("=== TABLE 3 (H=100, g=3, L=H+1) ===")
for S,c in [(0,97.7),(25,75.3),(50,53.2),(70,35.4)]:
    print(f" S={S}: actual {E_kills(100,S,3):.2f}  claim {c}")

print("\n=== TABLE 4 (S=50, L=H+1) ===")
claim={20:(9.0,10.9,'+21%'),30:(16.2,21.4,'+32%'),50:(26.8,35.3,'+32%'),
       75:(39.5,51.9,'+31%'),100:(53.2,69.9,'+31%'),125:(65.9,86.6,'+31%'),150:(79.6,104.6,'+31%')}
for H,(c3,c2,cp) in claim.items():
    g3 = gain_for(H,3); g2 = gain_for(H,2)
    e3=E_kills(H,50,g3); e2=E_kills(H,50,g2)
    pen=(e2/e3-1)*100
    flag = "" if (abs(e3-c3)<0.06 and abs(e2-c2)<0.06) else "  <-- MISMATCH"
    print(f" H={H:3d} g={g3}: {e3:7.2f} (claim {c3})   g={g2}: {e2:7.2f} (claim {c2})   penalty {pen:+.1f}% (claim {cp}){flag}")

print("\n=== TABLE 5 (H=100,S=50,highmark", highmark(100,50), ") ===")
base=E_kills(100,50,3,b=0)
for lbl,L in [("H+1",101),("H+5",105),("H+10",110),("H+20",120),("H+30",130),("H+50",150),("H+100",200)]:
    b=max(0,min(10,tdiv(L-100,5)))
    e=E_kills(100,50,3,b=b)
    print(f" L={lbl:5s} b={b:2d}  E={e:.2f}   improvement {(1-e/base)*100:.2f}%")
