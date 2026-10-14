from kilib import parse, dump

orig_text = open('orig_sch/StanzaBoardDevkit.kicad_sch', encoding='utf-8').read()
new = parse(open(r'..\StanzaBoardDevkit.kicad_sch', encoding='utf-8').read())

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
    raise RuntimeError('unbalanced lib')

lib_raw = extract_lib(orig_text)
rest = []
seen = False
for ch in new:
    if isinstance(ch, list) and ch and ch[0] == 'lib_symbols':
        seen = True
        continue
    if seen:
        rest.append(ch)

def indent_block(s):
    return '\n'.join(('\t' + ln) if ln else ln for ln in s.splitlines())

rest_dump = '\n'.join(indent_block(dump(ch, 1)) for ch in rest)
header = (
    '(kicad_sch\n'
    '\t(version 20250114)\n'
    '\t(generator "eeschema")\n'
    '\t(generator_version "9.0")\n'
    '\t(uuid "6b1f3c2e-8d4a-4f7b-9e21-5a0c7d3e9b14")\n'
    '\t(paper "A2")\n'
    '\t(title_block\n'
    '\t\t(title "Stanza Board (devboard version) - Freenove ESP32-S3 + NUCLEO-L432KC")\n'
    '\t\t(date "2026-10-11")\n'
    '\t\t(rev "B")\n'
    '\t\t(company "Sonido")\n'
    '\t\t(comment 1 "Fully wired schematic: signal nets drawn as wires.")\n'
    '\t)\n'
)
out = header + '\t' + lib_raw.replace('\n', '\n\t') + '\n' + rest_dump + '\n)\n'
open(r'..\StanzaBoardDevkit.kicad_sch', 'w', encoding='utf-8', newline='\n').write(out)
open('tmp.kicad_sch', 'w', encoding='utf-8', newline='\n').write(out)
print('wrote', len(out), 'rest items', len(rest))
