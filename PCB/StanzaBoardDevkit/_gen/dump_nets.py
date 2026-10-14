import re, collections
p = r'C:\Users\jezap\Desktop\Personal\Sonido\PCB\StanzaBoardDevkit\_gen\net.net'
t = open(p, encoding='utf-8').read()
nets = collections.defaultdict(list)
for m in re.finditer(r'\(net \(code "?-?\d+"?\) \(name "([^"]+)"\)(.*?)(?=\n\t\t\(net |\n\t\)\n)', t, re.S):
    name = m.group(1)
    body = m.group(2)
    nodes = re.findall(r'\(ref "([^"]+)"\) \(pin "([^"]+)"\)', body)
    nets[name] = nodes
out = []
for name, nodes in sorted(nets.items(), key=lambda kv: (-len(kv[1]), kv[0])):
    if name.startswith('unconnected'):
        continue
    out.append('%s : %s' % (name, ', '.join('%s.%s' % n for n in nodes)))
open('nets.txt', 'w', encoding='utf-8').write('\n'.join(out))
print('wrote', len(out), 'nets')
