import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hp_advance import *
def dist(H,S,L,killing_blow=True,took_damage=True):
    g,roll=gain_per_kill(H,S,L,killing_blow,took_damage)
    M=highmark(H,S); b=max(0,min(10,tdiv(L-H,5))); G0=G0_after_gain(H,S)
    cdf=[]; surv=1.0; k=0
    while surv>1e-12 and k<500000:
        k+=1
        p=max(0.0,min(1.0,(G0+k*g+b-1)/M))
        surv*= (1-p); cdf.append(1-surv)
    return cdf
def q(cdf,x):
    for i,v in enumerate(cdf):
        if v>=x: return i+1
    return len(cdf)
print("### P. distribution of kills-until-next-hp (dmg+blow, L=H+1). 'P99' = if you exceed this, something is wrong.")
print(f"{'S':>3} {'H':>4} {'mean':>6} {'P10':>5} {'P50':>5} {'P90':>5} {'P99':>5} {'P99.9':>6} {'min>0':>6}")
for S in (1,25,50):
    for H in (20,30,50,75,100,125,150):
        if H>cap(S): continue
        c=dist(H,S,H+1); E,_,_=expected_kills(H,S,H+1)
        # first k with nonzero chance
        M=highmark(H,S); b=max(0,min(10,tdiv(H+1-H,5))); G0=G0_after_gain(H,S); g,_=gain_per_kill(H,S,H+1,True,True)
        k0=next(k for k in range(1,10**6) if (G0+k*g+b-1)>0)
        print(f"{S:>3} {H:>4} {E:6.1f} {q(c,.10):5} {q(c,.50):5} {q(c,.90):5} {q(c,.99):5} {q(c,.999):6} {k0:6}")
