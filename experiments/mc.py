import os, sys, random; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hp_advance import *
random.seed(7)
def sim(H,S,L,trials=60000):
    M=highmark(H,S); g,_=gain_per_kill(H,S,L,True,True); b=max(0,min(10,tdiv(L-H,5)))
    tot=0
    for _ in range(trials):
        G=G0_after_gain(H,S); k=0
        while True:
            k+=1; G+=g
            if random.randint(1,M) < G+b: break
        tot+=k
    return tot/trials
for H,S,L in [(20,50,21),(50,25,51),(100,50,101),(100,0,101),(150,50,151)]:
    a=sim(H,S,L); e,_,_=expected_kills(H,S,L)
    print(f"H={H} S={S} L={L}: MC={a:.2f}  analytic={e:.2f}  diff={abs(a-e)/e*100:.2f}%")
