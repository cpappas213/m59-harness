import os, re

HERE = os.path.dirname(os.path.abspath(__file__))
M59 = os.environ.get("M59_ROOT", "C:/code/Meridian59").replace("\\", "/")

ROOT = M59 + "/kod"

vals, parent = {}, {}
for root, dirs, fs in os.walk(os.path.join(ROOT, 'object')):
    for f in fs:
        if not f.endswith('.kod'):
            continue
        t = open(os.path.join(root, f), errors='ignore').read()
        m = re.search(r'^([A-Za-z]\w*)\s+is\s+([A-Za-z]\w*)', t, re.M)
        if not m:
            continue
        parent[m.group(1)] = m.group(2)
        v = re.search(r'^\s*viValue_average\s*=\s*(-?\d+)', t, re.M)
        if v:
            vals[m.group(1)] = int(v.group(1))
CANON = {k.lower(): k for k in parent}


def val(c, d=0):
    if c is None or d > 15:
        return None
    c = CANON.get(c.lower(), c)
    if c in vals:
        return vals[c]
    return val(parent.get(c), d + 1)


MARK = {'MERCHANT_FLAT': 0, 'MERCHANT_BARGAIN': 1, 'MERCHANT_DISCOUNT': 2,
        'MERCHANT_NORMAL': 3, 'MERCHANT_EXPENSIVE': 4, 'MERCHANT_RIPOFF': 5}
mdir = os.path.join(ROOT, 'object', 'active', 'holder', 'nomoveon', 'battler', 'monster')
rows = []
for root, dirs, fs in os.walk(mdir):
    for f in fs:
        if not f.endswith('.kod'):
            continue
        p = os.path.join(root, f)
        t = open(p, errors='ignore').read()
        m = re.search(r'plFor_sale\s*=\s*\[(.*?)\];', t, re.S)
        if not m:
            continue
        body = m.group(1)
        depth = 0
        parts, cur = [], ''
        for ch in body:
            if ch == '[':
                depth += 1
            if ch == ']':
                depth -= 1
            if ch == ',' and depth == 0:
                parts.append(cur)
                cur = ''
            else:
                cur += ch
        parts.append(cur)
        items = re.findall(r'Create\(\s*&(\w+)', parts[0], re.I)
        mk = re.search(r'viMerchant_markup\s*=\s*(\w+)', t)
        mk = MARK.get(mk.group(1), 3) if mk else 3
        nm = re.search(r'^([A-Za-z]\w*)\s+is\s+', t, re.M)
        if items:
            rows.append((nm.group(1) if nm else f, mk, items, p.replace('\\', '/')))

print('markup: 1=BARGAIN 120%buy/90%sell, 2=DISCOUNT 140/80, 3=NORMAL 160/70, 4=EXPENSIVE 180/60, 5=RIPOFF 200/50')
for nm, mk, items, p in sorted(rows):
    mult = 100 + 20 * mk
    s = []
    for it in items:
        v = val(it)
        s.append('%s %s->%s' % (it, v, (v * mult) // 100 if v is not None else '?'))
    print('%-26s mk=%d  %s' % (nm, mk, '; '.join(s)))
