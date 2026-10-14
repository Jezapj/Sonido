from kilib import parse, find, findall
sch = parse(open(r'..\StanzaBoardDevkit.kicad_sch', encoding='utf-8').read())
for w in findall(sch, 'wire'):
    pts = findall(find(w, 'pts'), 'xy')
    for xy in pts:
        x, y = float(xy[1]), float(xy[2])
        if abs(x - 177.8) < 0.1:
            print([(float(a[1]), float(a[2])) for a in pts])
            break
print('--- labels near ---')
for lab in findall(sch, 'label'):
    at = find(lab, 'at')
    x, y = float(at[1]), float(at[2])
    if abs(x-177.8)<8 and abs(y-175.26)<10:
        print(lab[1], x, y, at)
