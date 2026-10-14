"""L-route and 3-bend jog around existing wires. Skip VBIAS (too many nodes)."""
from collections import defaultdict
from kilib import parse, find, findall, uid

path = r'..\StanzaBoardDevkit.kicad_sch'
orig = open(r'orig_sch\StanzaBoardDevkit.kicad_sch', encoding='utf-8').read()
sch = parse(orig)

SKIP = {'VBIAS'}  # dense, crosses the analog column

labels = defaultdict(list)
all_pts = []
for lab in sch:
    if isinstance(lab, list) and lab and lab[0] == 'label':
        at = find(lab, 'at')
        x, y = round(float(at[1]), 4), round(float(at[2]), 4)
        labels[str(lab[1])].append((x, y))
        all_pts.append((str(lab[1]), x, y))

obstacles = []
for w in sch:
    if not (isinstance(w, list) and w and w[0] == 'wire'):
        continue
    pts = findall(find(w, 'pts'), 'xy')
    if len(pts) >= 2:
        a = (round(float(pts[0][1]), 4), round(float(pts[0][2]), 4))
        b = (round(float(pts[1][1]), 4), round(float(pts[1][2]), 4))
        obstacles.append((a, b))

chunks = []
n_wires = 0
n_ok = 0
n_skip = 0
tol = 0.05
done = []

def wire(a, b):
    global n_wires
    if a == b:
        return
    n_wires += 1
    obstacles.append((a, b))
    chunks.append(
        '\t(wire\n\t\t(pts\n\t\t\t(xy %s %s)\n\t\t\t(xy %s %s)\n\t\t)\n'
        '\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type default)\n\t\t)\n'
        '\t\t(uuid "%s")\n\t)\n' % (a[0], a[1], b[0], b[1], uid())
    )

def junction(p):
    chunks.append(
        '\t(junction\n\t\t(at %s %s)\n\t\t(diameter 0)\n\t\t(color 0 0 0 0)\n'
        '\t\t(uuid "%s")\n\t)\n' % (p[0], p[1], uid())
    )

def overlap(a1, a2, b1, b2):
    ax1, ay1 = a1; ax2, ay2 = a2; bx1, by1 = b1; bx2, by2 = b2
    if abs(ay1 - ay2) < tol and abs(by1 - by2) < tol and abs(ay1 - by1) < tol:
        a0, a1x = sorted((ax1, ax2)); b0, b1x = sorted((bx1, bx2))
        return min(a1x, b1x) - max(a0, b0) > tol
    if abs(ax1 - ax2) < tol and abs(bx1 - bx2) < tol and abs(ax1 - bx1) < tol:
        a0, a1y = sorted((ay1, ay2)); b0, b1y = sorted((by1, by2))
        return min(a1y, b1y) - max(a0, b0) > tol
    return False

def blocked(a, b, net):
    for name, x, y in all_pts:
        if name == net:
            continue
        if abs(a[1] - b[1]) < tol and abs(y - a[1]) < tol and min(a[0], b[0]) + tol < x < max(a[0], b[0]) - tol:
            return True
        if abs(a[0] - b[0]) < tol and abs(x - a[0]) < tol and min(a[1], b[1]) + tol < y < max(a[1], b[1]) - tol:
            return True
    for s, t in obstacles:
        if overlap(a, b, s, t):
            return True
    return False

def try_path(pts, net):
    for a, b in zip(pts, pts[1:]):
        if blocked(a, b, net):
            return False
    for a, b in zip(pts, pts[1:]):
        wire(a, b)
    for p in pts[1:-1]:
        junction(p)
    return True

def route(a, b, net):
    if a == b:
        return True
    if abs(a[1] - b[1]) < tol or abs(a[0] - b[0]) < tol:
        return try_path([a, b], net)
    if try_path([a, (b[0], a[1]), b], net):
        return True
    if try_path([a, (a[0], b[1]), b], net):
        return True
    jogs = [2.54, -2.54, 5.08, -5.08, 7.62, -7.62, 10.16, -10.16, 12.7, -12.7, 15.24, -15.24]
    for j in jogs:
        if try_path([a, (a[0] + j, a[1]), (a[0] + j, b[1]), b], net):
            return True
        if try_path([a, (a[0], a[1] + j), (b[0], a[1] + j), b], net):
            return True
    return False

PRIO = ['IN_TIP','IN_AC','AMP_INP','AMP_FB','AMP_OUT','GAIN_LEG','SK_MID','SK_INP','AA_OUT','ADC_IN',
        'I2S_BCLK','I2S_WS','I2S_SD','STM_SAI_SCK','STM_SAI_FS','STM_SAI_SD',
        'ESP_DAC_BCK','ESP_DAC_LRCK','ESP_DAC_DIN','DAC_BCK','DAC_LRCK','DAC_DIN','DAC_OUTL','DAC_OUTR',
        'NUC_5V']
def k(item):
    name = item[0]
    return (0, PRIO.index(name)) if name in PRIO else (1, name)
for name, pts in sorted(labels.items(), key=k):
    if name in SKIP:
        continue
    uniq = []
    seen = set()
    for p in pts:
        if p not in seen:
            seen.add(p)
            uniq.append(p)
    if len(uniq) < 2:
        continue
    connected = {uniq[0]}
    rest = set(uniq[1:])
    ok = True
    while rest:
        best = None
        bestd = 1e9
        for a in connected:
            for b in rest:
                d = abs(a[0] - b[0]) + abs(a[1] - b[1])
                if d < bestd:
                    bestd = d
                    best = (a, b)
        a, b = best
        if not route(a, b, name):
            ok = False
            n_skip += 1
            rest.remove(b)
            continue
        junction(a)
        junction(b)
        connected.add(b)
        rest.remove(b)
    if ok:
        n_ok += 1
        done.append(name)

marker = '\t(sheet_instances'
open(path, 'w', encoding='utf-8', newline='\n').write(orig.replace(marker, ''.join(chunks) + marker, 1))
print('fully', n_ok, done)
print('skips', n_skip, 'segments', n_wires)
