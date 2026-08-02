# Independent re-implementation from the quoted KOD, not from the analysis' scripts.
def tdiv(a,b):
    # C truncation toward zero
    q = abs(a)//abs(b)
    return q if (a<0)==(b<0) else -q

def highmark(H,S):
    index = tdiv(H*(100-S),100)
    return (index+1)*index

def G0(H,S):
    g = -tdiv(H,2)
    if H > 30:
        g = g - tdiv(50-S,2)
    return g

def gain_for(H, base=3):
    return base + (1 if H < 30 else 0)

def E_kills(H,S,g,b=0,g0=None):
    M = highmark(H,S)
    if g0 is None: g0 = G0(H,S)
    E = 0.0
    surv = 1.0
    k = 0
    while surv > 1e-15 and k < 10_000_000:
        k += 1
        E += surv
        iN = g0 + k*g + b
        p = (iN-1)/M
        p = 0.0 if p < 0 else (1.0 if p > 1 else p)
        surv *= (1-p)
    return E

def pcts(H,S,g,b=0,g0=None,levels=(0.10,0.50,0.90,0.99,0.999)):
    M = highmark(H,S); 
    if g0 is None: g0 = G0(H,S)
    surv = 1.0; k=0; out={}; first=None
    res=[]
    cdf=0.0
    want=list(levels); wi=0
    while wi < len(want) and k < 10_000_000:
        k += 1
        iN = g0 + k*g + b
        p = (iN-1)/M
        p = 0.0 if p<0 else (1.0 if p>1 else p)
        if first is None and p>0: first = k
        cdf += surv*p
        surv *= (1-p)
        while wi < len(want) and cdf >= want[wi]:
            res.append(k); wi+=1
    return first, res
