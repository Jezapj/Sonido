from collections import defaultdict
from kilib import parse, find
sch = parse(open(r'orig_sch\StanzaBoardDevkit.kicad_sch', encoding='utf-8').read())
labs = defaultdict(list)
for lab in sch:
    if isinstance(lab, list) and lab and lab[0] == 'label':
        at = find(lab, 'at')
        labs[str(lab[1])].append((float(at[1]), float(at[2])))
for n, pts in sorted(labs.items()):
    if len(pts) >= 2:
        print(n, pts)
