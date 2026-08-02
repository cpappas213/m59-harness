import os, re

HERE = os.path.dirname(os.path.abspath(__file__))
M59 = os.environ.get("M59_ROOT", "C:/code/Meridian59").replace("\\", "/")

ROOT = M59 + "/kod"

# SID_/SKID_ -> level, from spell/skill class files
sid_level = {}
sid_name = {}
for sub, prop, numprop in (('spell', 'viSpell_level', 'viSpell_num'),
                           ('skill', 'viSkill_level', 'viSkill_num')):
    base = os.path.join(ROOT, 'object', 'passive', sub)
    for root, dirs, fs in os.walk(base):
        for f in fs:
            if not f.endswith('.kod'):
                continue
            t = open(os.path.join(root, f), errors='ignore').read()
            n = re.search(r'^\s*%s\s*=\s*(\w+)' % numprop, t, re.M)
            l = re.search(r'^\s*%s\s*=\s*(\d+)' % prop, t, re.M)
            cl = re.search(r'^([A-Za-z]\w*)\s+is\s+', t, re.M)
            if n:
                sid_level[n.group(1)] = int(l.group(1)) if l else 1
                sid_name[n.group(1)] = (cl.group(1) if cl else f, sub,
                                        os.path.join(root, f).replace('\\', '/'))


def price(level):
    j = 2
    for i in range(1, level):
        j *= 2
    return 250 * j


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
        # split top-level commas
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
        skills = re.findall(r'(SKID_\w+)', parts[1]) if len(parts) > 1 else []
        spells = re.findall(r'(SID_\w+)', parts[2]) if len(parts) > 2 else []
        mk = re.search(r'viMerchant_markup\s*=\s*(\w+)', t)
        mk = MARK.get(mk.group(1), 3) if mk else 3
        nm = re.search(r'^([A-Za-z]\w*)\s+is\s+', t, re.M)
        if skills or spells:
            rows.append((nm.group(1) if nm else f, mk, skills, spells, p.replace('\\', '/')))

for nm, mk, skills, spells, p in sorted(rows):
    out = []
    for s in skills + spells:
        lv = sid_level.get(s)
        if lv is None:
            out.append('%s(?)' % s)
        else:
            out.append('%s L%d=%d' % (sid_name[s][0], lv, price(lv)))
    print('%-26s markup=%d  %s' % (nm, mk, '; '.join(out)))
    print('     %s' % p)
