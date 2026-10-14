from kilib import parse, find, findall, rot_pt, pins, get_symbol

sch = parse(open(r'..\StanzaBoardDevkit.kicad_sch', encoding='utf-8').read())
LIB = find(sch, 'lib_symbols')
PINMAP = {}
for s in findall(LIB, 'symbol'):
    lib_id = str(s[1])
    for u in range(1, 8):
        for p in pins(s, u):
            PINMAP[(lib_id, u, p['number'])] = (p['x'], p['y'])

ends = set()
for w in findall(sch, 'wire'):
    pts = find(w, 'pts')
    for xy in findall(pts, 'xy'):
        ends.add((round(float(xy[1]), 3), round(float(xy[2]), 3)))
for nc in findall(sch, 'no_connect'):
    at = find(nc, 'at')
    ends.add((round(float(at[1]), 3), round(float(at[2]), 3)))

miss = 0
for inst in findall(sch, 'symbol'):
    if inst[0] != 'symbol' or not find(inst, 'lib_id'):
        continue
    lib = str(find(inst, 'lib_id')[1])
    at = find(inst, 'at')
    sx, sy, rot = float(at[1]), float(at[2]), float(at[3])
    unit = int(find(inst, 'unit')[1]) if find(inst, 'unit') else 1
    ref = None
    for p in findall(inst, 'property'):
        if p[1] == 'Reference' or str(p[1]) == 'Reference':
            ref = str(p[2])
            break
    for key, off in PINMAP.items():
        if key[0] == lib and key[1] == unit:
            rx, ry = rot_pt(off[0], off[1], rot)
            x, y = round(sx + rx, 3), round(sy + ry, 3)
            if (x, y) not in ends and not (ref or '').startswith('#'):
                print('MISS', ref, 'u'+str(unit), 'pin', key[2], x, y)
                miss += 1
print('miss', miss, 'ends', len(ends))
