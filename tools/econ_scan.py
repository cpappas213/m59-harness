import os, re, json, sys

HERE = os.path.dirname(os.path.abspath(__file__))
M59 = os.environ.get("M59_ROOT", "C:/code/Meridian59").replace("\\", "/")

ROOT = M59 + "/kod"

vals = {}
parent = {}
files = {}
hitsmax = {}
hitsmin = {}

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
        v = re.search(r'^\s*viValue_average\s*=\s*(-?\d+)', t, re.M)
        if v:
            vals[cls] = int(v.group(1))
        v = re.search(r'^\s*viHits_init_max\s*=\s*(-?\d+)', t, re.M)
        if v:
            hitsmax[cls] = int(v.group(1))
        v = re.search(r'^\s*viHits_init_min\s*=\s*(-?\d+)', t, re.M)
        if v:
            hitsmin[cls] = int(v.group(1))


CANON = {}
for k in parent:
    CANON[k.lower()] = k


def inherit(d, c, depth=0):
    if depth > 15 or c is None:
        return None
    c = CANON.get(c.lower(), c)
    if c in d:
        return d[c]
    if c in parent:
        return inherit(d, parent[c], depth + 1)
    return None


def val(c):
    return inherit(vals, c)


# parse treasure tables
tres = {}
tdir = os.path.join(ROOT, 'object', 'passive', 'trestype')
for f in sorted(os.listdir(tdir)):
    if not f.endswith('.kod'):
        continue
    t = open(os.path.join(tdir, f), errors='ignore').read()
    tid = re.search(r'piTreasure_num\s*=\s*(\w+)', t)
    diff = re.search(r'piDiff_seed\s*=\s*(\d+)', t, re.I)
    att = re.search(r'piItem_att_chance\s*=\s*(\d+)', t, re.I)
    entries = re.findall(r'\[\s*&(\w+)\s*,\s*(\d+)\s*\]', t)
    tres[f] = dict(tid=tid.group(1) if tid else '?',
                   diff=int(diff.group(1)) if diff else 0,
                   att=int(att.group(1)) if att else 0,
                   entries=[(c, int(w)) for c, w in entries])

mode = sys.argv[1] if len(sys.argv) > 1 else 'tres'

if mode == 'tres':
    print('%-14s %-22s %5s %5s  %6s  %6s  %s' % ('file', 'TID', 'diff', 'att', 'wsum', 'E[val]', 'unknown'))
    for f, d in tres.items():
        wsum = sum(w for _, w in d['entries'])
        ev = 0.0
        unk = []
        money_w = 0
        for c, w in d['entries']:
            v = val(c)
            if v is None:
                unk.append(c)
                continue
            if c == 'Money':
                money_w = w
                continue
            ev += v * w / 100.0
        print('%-14s %-22s %5d %5d  %6d  %6.1f  money_w=%-3d %s' % (f, d['tid'], d['diff'], d['att'], wsum, ev, money_w, ','.join(unk)))

if mode == 'items':
    for c in sys.argv[2:]:
        print('%-22s %-8s %-40s' % (c, val(c), files.get(c, inherit(files, c))))

if mode == 'reagents':
    # every reagent used by any spell, with per-unit value
    sdir = os.path.join(ROOT, 'object', 'passive', 'spell')
    use = {}
    for root, dirs, fs in os.walk(sdir):
        for f in fs:
            if not f.endswith('.kod'):
                continue
            t = open(os.path.join(root, f), errors='ignore').read()
            lvl = re.search(r'viSpell_level\s*=\s*(\d+)', t)
            rg = re.findall(r'plReagents\s*=\s*Cons\(\s*\[\s*&(\w+)\s*,\s*(\d+)\s*\]', t, re.I)
            name = os.path.join(root, f).replace('\\', '/').split('/spell/')[-1]
            if rg:
                use[name] = (int(lvl.group(1)) if lvl else 1, rg)
    for n, (lvl, rg) in sorted(use.items(), key=lambda x: x[1][0]):
        cost = sum(int(q) * (val(c) or 0) for c, q in rg)
        print('%-38s lvl%-3d %-46s face=%-5d buy@160%%=%d' % (n, lvl, ' + '.join('%sx%s(%s)' % (q, c, val(c)) for c, q in rg), cost, cost * 160 // 100))
