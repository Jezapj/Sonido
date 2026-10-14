from kilib import parse, dump
from pathlib import Path

orig = Path('orig_sch/StanzaBoardDevkit.kicad_sch').read_text(encoding='utf-8')
# confirm original loads via writing as-is copy
Path('probe_orig.kicad_sch').write_text(orig, encoding='utf-8', newline='\n')

new = parse(Path(r'..\StanzaBoardDevkit.kicad_sch').read_text(encoding='utf-8'))
syms = [ch for ch in new if isinstance(ch, list) and ch and ch[0] == 'symbol']
print('symbols', len(syms), 'first ref', [p[2] for p in syms[0] if isinstance(p, list) and p[0]=='property' and p[1]=='Reference'][:1])

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
header = orig[:orig.index('(lib_symbols')]

def wrap(items):
    body = '\n'.join('\n'.join(('\t'+ln) if ln else ln for ln in dump(ch, 1).splitlines()) for ch in items)
    return header + lib_raw + '\n' + body + '\n\t(sheet_instances\n\t\t(path "/"\n\t\t\t(page "1")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n'

# probe 1: no extra symbols
Path('probe0.kicad_sch').write_text(header + lib_raw + '\n\t(sheet_instances\n\t\t(path "/"\n\t\t\t(page "1")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n', encoding='utf-8', newline='\n')
# probe 2: first 1 symbol
Path('probe1.kicad_sch').write_text(wrap(syms[:1]), encoding='utf-8', newline='\n')
# probe 3: first 5
Path('probe5.kicad_sch').write_text(wrap(syms[:5]), encoding='utf-8', newline='\n')
print('wrote probes')
