from verify import *
print("claimed S=1 column vs actual S=0 and S=1:")
cl=[186,385,482,571,660,749,838,927]
for i,(lo,hi) in enumerate([(20,30),(30,40),(40,50),(50,60),(60,70),(70,80),(80,90),(90,100)]):
    s0=sum(E_kills(H,0,gain_for(H)) for H in range(lo,hi))
    s1=sum(E_kills(H,1,gain_for(H)) for H in range(lo,hi))
    print(f" {lo}->{hi}: claim {cl[i]:4d}   S=0 {s0:7.1f}   S=1 {s1:7.1f}   (claim matches S={'0' if abs(s0-cl[i])<1 else ('1' if abs(s1-cl[i])<1 else '?')})")
print("\nhighmark S=0 vs S=1 divergence:")
for H in [20,25,30,50,100]:
    a,b=highmark(H,0),highmark(H,1)
    print(f"  H={H}: hm(S=0)={a} hm(S=1)={b}  diff {100*(a-b)/a:.1f}%")
print("\nmilestone off-by-one test (S=25):")
run=0.0
for H in range(20,125):
    run+=E_kills(H,25,gain_for(H))
    if H in (30,40,50,60,70,80,90,100,110,120,124):
        print(f"  kills to reach {H+1} hp = {run:.1f}   (analysis labels this '{H}hp')")
