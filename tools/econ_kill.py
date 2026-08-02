import os, re, json, sys

HERE = os.path.dirname(os.path.abspath(__file__))
M59 = os.environ.get("M59_ROOT", "C:/code/Meridian59").replace("\\", "/")

ROOT = M59 + "/kod"

vals, parent, files, hmax, hmin = {}, {}, {}, {}, {}
for root, dirs, fs in os.walk(os.path.join(ROOT, 'object')):
    for f in fs:
        if not f.endswith('.kod'):
            continue
        p = os.path.join(root, f)
        t = open(p, errors='ignore').read()
        m = re.search(r'^([A-Za-z]\w*)\s+is\s+([A-Za-z]\w*)', t, re.M)
        if not m:
            continue
        cls, par = m.group(1), m.group(2)
        parent[cls] = par
        files[cls] = p.replace('\\', '/')
        for prop, d in (('viValue_average', vals), ('viHits_init_max', hmax), ('viHits_init_min', hmin)):
            v = re.search(r'^\s*%s\s*=\s*(-?\d+)' % prop, t, re.M)
            if v:
                d[cls] = int(v.group(1))

CANON = {k.lower(): k for k in parent}


def inh(d, c, depth=0):
    if c is None or depth > 15:
        return None
    c = CANON.get(c.lower(), c)
    if c in d:
        return d[c]
    return inh(d, parent.get(c), depth + 1)


def isa(c, target, depth=0):
    if c is None or depth > 20:
        return False
    c = CANON.get(c.lower(), c)
    if c.lower() == target.lower():
        return True
    return isa(parent.get(c), target, depth + 1)


def sellvalue(c):
    """Expected value a merchant computes via GetValue for a freshly generated item."""
    v = inh(vals, c)
    if v is None:
        return None
    if isa(c, 'NumberItem'):
        return float(v)  # numbitem GetValue = piNumber * initval, piNumber=1
    mx = inh(hmax, c)
    mn = inh(hmin, c)
    if not mx:
        return float(v)
    mn = mn if mn else 1
    # E[ (100*h*h)/(mx*mx) ] over h uniform in [mn,mx], then /100*v, floor at 10
    n = mx - mn + 1
    s = sum((100 * h * h) // (mx * mx) for h in range(mn, mx + 1)) / n
    return max(10.0, min(float(v), v * s / 100.0))


# treasure tables
tres = {}
tdir = os.path.join(ROOT, 'object', 'passive', 'trestype')
for f in sorted(os.listdir(tdir)):
    if not f.endswith('.kod'):
        continue
    t = open(os.path.join(tdir, f), errors='ignore').read()
    tid = re.search(r'piTreasure_num\s*=\s*(\w+)', t)
    entries = [(c, int(w)) for c, w in re.findall(r'\[\s*&(\w+)\s*,\s*(\d+)\s*\]', t)]
    if tid:
        tres[tid.group(1)] = entries

# monsters
mons = []
mdir = os.path.join(ROOT, 'object', 'active', 'holder', 'nomoveon', 'battler', 'monster')
for root, dirs, fs in os.walk(mdir):
    for f in fs:
        if not f.endswith('.kod'):
            continue
        t = open(os.path.join(root, f), errors='ignore').read()
        nm = re.search(r'^([A-Za-z]\w*)\s+is\s+([A-Za-z]\w*)', t, re.M)
        lvl = re.search(r'^\s*viLevel\s*=\s*(\d+)', t, re.M)
        tt = re.search(r'^\s*viTreasure_type\s*=\s*(\w+)', t, re.M)
        df = re.search(r'^\s*viDifficulty\s*=\s*(\d+)', t, re.M)
        if not (nm and lvl and tt):
            continue
        mons.append((nm.group(1), int(lvl.group(1)), tt.group(1),
                     int(df.group(1)) if df else 0,
                     os.path.join(root, f).replace('\\', '/')))

MONEYFACTOR = 100
ITEMFACTOR = 100


def kill_ev(level, diff, tid):
    entries = tres.get(tid, [])
    if not entries:
        return None
    # expected number of items
    base = 1 + level // 55
    d3 = diff // 3
    ns = [min(6, base + r) for r in range(0, d3 + 1)]
    ns = [max(1, (ITEMFACTOR * n) // 100) for n in ns]
    en = sum(ns) / len(ns)
    # expected face value of one drawn item
    tot_w = sum(w for _, w in entries)
    ev = 0.0
    ev_liquid = 0.0   # reagents + gems + money: sellable at an apothecary
    unknown = []
    for c, w in entries:
        p = w / 100.0
        if c.lower() == 'money':
            # 1 + (MONEYFACTOR*2*R)/100, R uniform in [level//2, 3*level//2]
            lo, hi = level // 2, 3 * level // 2
            er = sum((MONEYFACTOR * 2 * max(1, r)) // 100 for r in range(lo, hi + 1)) / (hi - lo + 1)
            amt = 1 + er
            ev += p * amt
            ev_liquid += p * amt
            continue
        v = sellvalue(c)
        if v is None:
            unknown.append(c)
            continue
        ev += p * v
        if isa(c, 'NumberItem') and not isa(c, 'Food'):
            ev_liquid += p * v
        elif c.lower() in ('emerald', 'ruby', 'sapphire', 'diamond'):
            ev_liquid += p * v
    return en, ev, ev_liquid, unknown


mons.sort(key=lambda m: m[1])
print('%-18s %4s %4s %-20s %5s %8s %8s %9s %9s' % (
    'monster', 'lvl', 'diff', 'treasure', 'E[n]', 'face/it', 'face/kill', 'sh@90%', 'liquid@90%'))
for nm, lvl, tid, df, p in mons:
    r = kill_ev(lvl, df, tid)
    if r is None:
        continue
    en, ev, evl, unk = r
    print('%-18s %4d %4d %-20s %5.2f %8.1f %8.1f %9.1f %9.1f %s' % (
        nm, lvl, df, tid, en, ev, en * ev, en * ev * 0.9, en * evl * 0.9, ','.join(unk)))
