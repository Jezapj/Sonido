p = 'gen.py'
d = open(p, 'rb').read()
if b'\x00' in d[:40]:
    d = d.decode('utf-16-le').encode('utf-8')
    open(p, 'wb').write(d)
t = open(p, encoding='utf-8').read()
repls = [
    ("place('Connector:AudioJack2', 'J2', 'Guitar In 6.35mm', 30.48, Y, fp=FP['JACK'])",
     "place('Connector_Audio:AudioJack2', 'J2', 'Guitar In 6.35mm', 30.48, Y, fp=FP['JACK'])"),
    ("place('Device:R', 'R11', '2.2M', 71.12, 190.5, fp=FP['R'])  # to VBIAS",
     "place('Device:R', 'R11', '2.2M', 71.12, 266.7, fp=FP['R'])  # IN_AC to VBIAS"),
    ("place('Diode:BAT54S', 'D2', 'BAT54S', 241.3, 200.66, rot=90, fp=FP['SOT23'])",
     "place('Diode:BAT54S', 'D2', 'BAT54S', 241.3, 200.66, fp=FP['SOT23'])"),
    ("place('Connector:AudioJack3', 'J3', 'Line Out 6.35mm TRS', 495.3, 241.3, fp=FP['JACK'])",
     "place('Connector_Audio:AudioJack3', 'J3', 'Line Out 6.35mm TRS', 495.3, 241.3, fp=FP['JACK'])"),
]
for a, b in repls:
    if a not in t:
        print('MISSING', a[:60])
    t = t.replace(a, b)
open(p, 'w', encoding='utf-8', newline='\n').write(t)
print('ok')
