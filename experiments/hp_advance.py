import math

def tdiv(a,b):
    # C truncation toward zero, as blakserv sendmsg.c:850 does
    q = abs(a)//abs(b)
    return q if (a<0)==(b<0) else -q

def highmark(H,S):
    index = tdiv(H*(100-S),100)
    return (index+1)*index

def G0_after_gain(H,S):
    g = -tdiv(H,2)
    if H > 30:
        g = g - tdiv(50-S,2)
    return g

def gain_per_kill(H,S,L,killing_blow,took_damage,is_monster=True,pimax=None,mult=1):
    if pimax is None: pimax=H
    gain=0; roll=False
    if L > H:
        if killing_blow and took_damage: gain=3; roll=True
        else: gain=2; roll=True
    else:
        if (L+5)>H and is_monster and killing_blow and took_damage: gain=1
    if H < 30: gain+=1            # PKILL_ENABLE_HP newbie bonus
    if pimax > H*2 and L < pimax:
        gain = tdiv(gain,2); roll=False
    gain = gain*max(1,min(100,mult))
    return gain, roll

def expected_kills(H,S,L,killing_blow=True,took_damage=True,pimax=None,mult=1,G0=None,cap_iter=2000000):
    g,roll = gain_per_kill(H,S,L,killing_blow,took_damage,pimax=pimax,mult=mult)
    if not roll or g<=0: return float('inf'), g, roll
    M = highmark(H,S)
    if M<=0: return 1.0, g, roll
    b = max(0,min(10,tdiv(L-H,5)))
    if G0 is None: G0 = G0_after_gain(H,S)
    E=0.0; surv=1.0; k=0
    while surv>1e-14 and k<cap_iter:
        k+=1
        iNumber = G0 + k*g + b
        p = (iNumber-1)/M
        p = 0.0 if p<0 else (1.0 if p>1 else p)
        E += surv           # E[K] = sum_{k>=1} P(K>=k) = sum surv_before
        surv *= (1-p)
    return E, g, roll

def cap(S): return min(100+S,150)

if __name__=="__main__":
    print("=== expected kills per +1 HP, took dmg + killing blow (gain 3), b from L-H ===")
    for S in (0,10,25,40,50,60,70):
        print(f"\n-- stamina {S} (highmark idx factor {100-S}%), hp cap {cap(S)} --")
        print(f"{'H':>4} {'M=highmark':>11} {'G0':>5} " + " ".join(f"L=H+{d:<3}".rjust(9) for d in (1,5,10,25,50,100)))
        for H in (20,30,40,50,60,75,100,125,150):
            if H>cap(S): continue
            row=[]
            for d in (1,5,10,25,50,100):
                L=H+d
                E,_,_ = expected_kills(H,S,L)
                row.append(f"{E:9.1f}")
            print(f"{H:>4} {highmark(H,S):>11} {G0_after_gain(H,S):>5} " + " ".join(row))

def progression(S, dlevel=1, killing_blow=True, took_damage=True, mult=1, start=20):
    """cumulative expected kills from start to cap(S)"""
    tot=0.0; rows=[]
    for H in range(start, cap(S)):
        E,g,roll = expected_kills(H,S,H+dlevel,killing_blow,took_damage,mult=mult)
        tot+=E
        rows.append((H,E,g,tot))
    return rows

def band_totals(S, dlevel=1, bands=None, **kw):
    rows = progression(S,dlevel,**kw)
    d = {H:(E,g) for H,E,g,_ in rows}
    out=[]
    if bands is None:
        edges=[20,30,40,50,60,70,80,90,100,110,120,130,140,cap(S)]
        edges=[e for e in edges if e<=cap(S)]
        if edges[-1]!=cap(S): edges.append(cap(S))
        bands=list(zip(edges[:-1],edges[1:]))
    for a,b in bands:
        s=sum(d[H][0] for H in range(a,b) if H in d)
        out.append((a,b,s))
    return out
