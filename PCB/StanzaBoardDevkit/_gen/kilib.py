import uuid as uuidlib

class Q(str):
    pass

def parse(src):
    i, n = 0, len(src)
    def skip():
        nonlocal i
        while i < n and src[i] in ' \t\r\n':
            i += 1
    def read():
        nonlocal i
        skip()
        if i >= n:
            return None
        if src[i] == '(':
            i += 1
            items = []
            while True:
                skip()
                if i >= n:
                    break
                if src[i] == ')':
                    i += 1
                    break
                items.append(read())
            return items
        if src[i] == '"':
            i += 1
            out = []
            while i < n and src[i] != '"':
                if src[i] == '\\':
                    i += 1
                    if i < n:
                        out.append(src[i]); i += 1
                else:
                    out.append(src[i]); i += 1
            i += 1
            return Q(''.join(out))
        j = i
        while i < n and src[i] not in ' \t\r\n()':
            i += 1
        return src[j:i]
    return read()

def fmt_atom(a):
    if isinstance(a, Q) or (isinstance(a, str) and any(c in a for c in ' ()\t\n"')):
        return '"' + str(a).replace('\\', '\\\\').replace('"', '\\"') + '"'
    return str(a)

def dump(node, indent=0):
    if not isinstance(node, list):
        return fmt_atom(node)
    if not node:
        return '()'
    head = fmt_atom(node[0]) if not isinstance(node[0], list) else dump(node[0], indent)
    atoms = [x for x in node[1:] if not isinstance(x, list)]
    lists = [x for x in node[1:] if isinstance(x, list)]
    if not lists:
        return '(' + ' '.join([head] + [fmt_atom(x) for x in atoms]) + ')'
    pad = '\t' * (indent + 1)
    lines = ['(' + ' '.join([head] + [fmt_atom(x) for x in atoms])]
    for ch in lists:
        lines.append(pad + dump(ch, indent + 1))
    lines.append('\t' * indent + ')')
    return '\n'.join(lines)

def find(node, key):
    if not isinstance(node, list):
        return None
    if node and node[0] == key:
        return node
    for ch in node:
        if isinstance(ch, list) and ch and ch[0] == key:
            return ch
    return None

def findall(node, key):
    out = []
    if not isinstance(node, list):
        return out
    for ch in node:
        if isinstance(ch, list) and ch and ch[0] == key:
            out.append(ch)
    return out

def uid():
    return str(uuidlib.uuid4())

def rot_pt(x, y, ang):
    a = int(ang) % 360
    if a == 0:
        return x, y
    if a == 90:
        return -y, x
    if a == 180:
        return -x, -y
    if a == 270:
        return y, -x
    return x, y

def get_symbol(lib_syms, lib_id):
    for s in findall(lib_syms, 'symbol'):
        if s[1] == lib_id or s[1] == Q(lib_id):
            return s
    return None

def pins(sym, unit=1):
    out = []
    for ch in sym:
        if not isinstance(ch, list) or ch[0] != 'symbol':
            continue
        name = str(ch[1])
        # unit suffix _<unit>_<body>
        parts = name.rsplit('_', 2)
        if len(parts) >= 3:
            try:
                u = int(parts[-2])
            except ValueError:
                u = 0
        else:
            u = 0
        if u not in (0, unit):
            continue
        for pin in findall(ch, 'pin'):
            at = find(pin, 'at')
            nm = find(pin, 'name')
            length = find(pin, 'length')
            numn = find(pin, 'number')
            out.append({
                'number': str(numn[1]),
                'name': str(nm[1]) if nm else '',
                'x': float(at[1]),
                'y': float(at[2]),
                'ang': float(at[3]) if len(at) > 3 else 0,
                'length': float(length[1]) if length else 2.54,
                'type': pin[1] if len(pin) > 1 else '',
            })
    return out
