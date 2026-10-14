from kilib import parse, dump
from pathlib import Path

orig = Path('orig_sch/StanzaBoardDevkit.kicad_sch').read_text(encoding='utf-8')
new = parse(Path(r'..\StanzaBoardDevkit.kicad_sch').read_text(encoding='utf-8'))
header = orig[:orig.index('(lib_symbols')]

def extract_lib(text):
    i = text.index('(lib_symbols')
    d = 0
    for j, c in enumerate(text[i:]):
        if c == '(':
            d += 1
        elif c == ')':
            d -= 1
            if d == 0:
                return text[i:i + j + 1]

lib_raw = extract_lib(orig)
kinds = {}
for ch in new:
    if isinstance(ch, list) and ch:
        kinds.setdefault(str(ch[0]), []).append(ch)
print({k: len(v) for k, v in kinds.items()})

def wrap(items, name):
    body = '\n'.join('\n'.join(('\t'+ln) if ln else ln for ln in dump(ch, 1).splitlines()) for ch in items)
    txt = header + lib_raw + '\n' + body + '\n\t(sheet_instances\n\t\t(path "/"\n\t\t\t(page "1")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n'
    Path(name).write_text(txt, encoding='utf-8', newline='\n')

wrap(kinds.get('wire', [])[:20], 'probe_w20.kicad_sch')
wrap(kinds.get('wire', []), 'probe_wall.kicad_sch')
wrap(kinds.get('junction', []), 'probe_j.kicad_sch')
wrap(kinds.get('no_connect', []), 'probe_nc.kicad_sch')
wrap(kinds.get('text', []), 'probe_t.kicad_sch')
wrap(kinds.get('rectangle', []), 'probe_r.kicad_sch')
wrap(kinds.get('symbol', []), 'probe_sall.kicad_sch')
print('ok')
