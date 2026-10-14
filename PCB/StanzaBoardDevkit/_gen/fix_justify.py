p = 'gen.py'
t = open(p, encoding='utf-8').read()
old = """def note_pin(txt, x, y):
    texts.append(['text', Q(txt), ['exclude_from_sim', 'no'], ['at', x, y, 0],
                  ['effects', ['font', ['size', 1.0, 1.0]], ['justify', 'left', 'center']],
                  ['uuid', Q(uid())]])"""
new = """def note_pin(txt, x, y):
    texts.append(['text', Q(txt), ['exclude_from_sim', 'no'], ['at', round(x, 2), round(y, 2), 0],
                  ['effects', ['font', ['size', 1.27, 1.27]], ['justify', 'left']],
                  ['uuid', Q(uid())]])"""
if old not in t:
    raise SystemExit('not found')
open(p, 'w', encoding='utf-8', newline='\n').write(t.replace(old, new))
print('fixed')
