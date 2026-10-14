# Rebuild StanzaBoardDevkit schematic with drawn wires (not label-only nets).
import os, copy
from kilib import parse, dump, find, findall, Q, uid, rot_pt, get_symbol, pins

HERE = os.path.dirname(os.path.abspath(__file__))
OLD = os.path.join(HERE, '..', 'StanzaBoardDevkit.kicad_sch')
SCH = os.path.join(HERE, '..', 'StanzaBoardDevkit.kicad_sch')
ROOT = '6b1f3c2e-8d4a-4f7b-9e21-5a0c7d3e9b14'
G = 2.54

old = parse(open(OLD, encoding='utf-8').read())
LIB = find(old, 'lib_symbols')
PINMAP = {}
for s in findall(LIB, 'symbol'):
    lib_id = str(s[1])
    for unit in range(0, 8):
        for p in pins(s, unit or 1):
            PINMAP[(lib_id, unit or 1, p['number'])] = (p['x'], p['y'])

# Some symbols only store pins on unit 0 graphics; fall back.
def poff(lib_id, unit, number):
    number = str(number)
    for u in (unit, 1, 0):
        if (lib_id, u, number) in PINMAP:
            return PINMAP[(lib_id, u, number)]
    raise KeyError('pin %s %s %s' % (lib_id, unit, number))

FP = {
    'C0603': 'Capacitor_SMD:C_0603_1608Metric',
    'C0805': 'Capacitor_SMD:C_0805_2012Metric',
    'CP': 'Capacitor_SMD:CP_Elec_5x5.4',
    'R': 'Resistor_SMD:R_0603_1608Metric',
    'FB': 'Inductor_SMD:L_0603_1608Metric',
    'NT': 'NetTie:NetTie-2_SMD_Pad0.5mm',
    'JP': 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical',
    'JACK': 'Connector_Audio:Jack_6.35mm_Neutrik_NMJ4HCD2_Horizontal',
    'SOIC14': 'Package_SO:SOIC-14_3.9x8.7mm_P1.27mm',
    'SOT23': 'Package_TO_SOT_SMD:SOT-23',
    'TSSOP20': 'Package_SO:TSSOP-20_4.4x6.5mm_P0.65mm',
    'S15': 'Connector_PinSocket_2.54mm:PinSocket_1x15_P2.54mm_Vertical',
    'S20': 'Connector_PinSocket_2.54mm:PinSocket_1x20_P2.54mm_Vertical',
}

body = []
placed = {}  # ref,unit -> dict
wires = []
junctions = set()
ncs = []
texts = []
rects = []
labels = []  # optional on-wire names, not used as the only connection

def g(n):
    return round(n / G) * G

def add_j(x, y):
    junctions.add((round(x, 4), round(y, 4)))

def wire(*pts):
    pts = [(float(x), float(y)) for x, y in pts]
    for a, b in zip(pts, pts[1:]):
        if a == b:
            continue
        wires.append((a, b))

def pxy(ref, pin, unit=1):
    d = placed[(ref, unit)]
    ox, oy = poff(d['lib'], unit, pin)
    rx, ry = rot_pt(ox, oy, d['rot'])
    return d['x'] + rx, d['y'] + ry

def prop(name, value, x, y, rot=0, hide=False, justify=None):
    n = ['property', Q(name), Q(value), ['at', x, y, rot],
         ['effects', ['font', ['size', 1.27, 1.27]]]]
    if justify:
        n[4].append(['justify'] + justify)
    if hide:
        n[4].append(['hide', 'yes'])
    return n

def place(lib_id, ref, value, x, y, unit=1, rot=0, fp='', extra_pins=None):
    x, y = float(x), float(y)
    placed[(ref, unit)] = {'lib': lib_id, 'x': x, 'y': y, 'rot': rot, 'value': value, 'fp': fp}
    inst = ['symbol',
            ['lib_id', Q(lib_id)],
            ['at', x, y, rot],
            ['unit', unit],
            ['exclude_from_sim', 'no'],
            ['in_bom', 'yes' if not ref.startswith('#') else 'no'],
            ['on_board', 'yes'],
            ['dnp', 'no'],
            ['uuid', Q(uid())],
            prop('Reference', ref, x, y - 2.54),
            prop('Value', value, x, y + 2.54),
            prop('Footprint', fp, x, y, hide=True),
            prop('Datasheet', '~', x, y, hide=True),
            prop('Description', '', x, y, hide=True),
            ]
    # pin uuids
    nums = []
    for key, off in PINMAP.items():
        if key[0] == lib_id and key[1] == unit:
            nums.append(key[2])
    if not nums:
        nums = extra_pins or []
    for n in sorted(set(nums), key=lambda s: (len(s), s)):
        inst.append(['pin', Q(n), ['uuid', Q(uid())]])
    inst.append(['instances', ['project', Q('StanzaBoardDevkit'),
                               ['path', Q('/' + ROOT), ['reference', Q(ref)], ['unit', unit]]]])
    body.append(inst)
    return inst

def pwr(kind, x, y, net_name=None, rot=0):
    # kind: GND, GNDA, +5V, +5VA, +3V3, +3.3VA, PWR_FLAG
    lib = 'power:' + kind
    ref = '#PWR' + uid()[:6]
    val = net_name or kind
    place(lib, ref, val, x, y, rot=rot)
    return ref

def flag(x, y):
    place('power:PWR_FLAG', '#FLG' + uid()[:6], 'PWR_FLAG', x, y)

def nc_pin(ref, pin, unit=1):
    x, y = pxy(ref, pin, unit)
    ncs.append((x, y))

def text(s, x, y, size=1.27, bold=False):
    font = ['font', ['size', size, size]]
    if bold:
        font.append(['bold', 'yes'])
    texts.append(['text', Q(s), ['exclude_from_sim', 'no'], ['at', x, y, 0],
                  ['effects', font, ['justify', 'left', 'bottom']], ['uuid', Q(uid())]])

def rect(x0, y0, x1, y1):
    rects.append(['rectangle', ['start', x0, y0], ['end', x1, y1],
                  ['stroke', ['width', 0.254], ['type', 'dash']],
                  ['fill', ['type', 'none']], ['uuid', Q(uid())]])

def note_pin(txt, x, y):
    texts.append(['text', Q(txt), ['exclude_from_sim', 'no'], ['at', round(x, 2), round(y, 2), 0],
                  ['effects', ['font', ['size', 1.27, 1.27]], ['justify', 'left']],
                  ['uuid', Q(uid())]])

def stub_pwr(ref, pin, kind, dist=G, unit=1, net_name=None):
    x, y = pxy(ref, pin, unit)
    d = placed[(ref, unit)]
    ox, oy = poff(d['lib'], unit, pin)
    # pin orientation in symbol space: pin at outer end; body is towards origin-ish.
    # Drop power below for GND, above for rails.
    if kind in ('GND', 'GNDA'):
        yy = y + dist
        wire((x, y), (x, yy))
        pwr(kind, x, yy, net_name=net_name)
    else:
        yy = y - dist
        wire((x, y), (x, yy))
        pwr(kind, x, yy, net_name=net_name)

def h_res(ref, value, x, y, fp=None):
    place('Device:R', ref, value, x, y, rot=90, fp=fp or FP['R'])

def v_cap(ref, value, x, y, polarized=False, fp=None):
    lib = 'Device:C_Polarized' if polarized else 'Device:C'
    place(lib, ref, value, x, y, fp=fp or (FP['CP'] if polarized else FP['C0603']))

# ---- layout: A2 594 x 420 ----
# Top: power | ESP sockets | Nucleo sockets
# Bottom: analog wired chain | DAC wired around U7

# POWER
rect(12.7, 12.7, 96.52, 132.08)
text('POWER', 15.24, 16.51, 2.2, True)
text('5 V from Freenove 5V pin, ferrite to preamp, JP1 to Nucleo', 15.24, 20.32, 1.27)

place('Device:C', 'C1', '10uF', 25.4, 35.56, fp=FP['C0805'])
place('Device:C', 'C2', '100nF', 38.1, 35.56, fp=FP['C0603'])
place('Device:FerriteBead', 'FB1', '600R', 55.88, 30.48, rot=90, fp=FP['FB'])
place('Device:C', 'C5', '10uF', 71.12, 35.56, fp=FP['C0805'])
place('Device:C', 'C6', '100nF', 83.82, 35.56, fp=FP['C0603'])
place('Connector_Generic:Conn_01x02', 'JP1', 'NUCLEO 5V LINK', 30.48, 63.5, fp=FP['JP'])
place('Device:NetTie_2', 'NT1', 'NetTie', 63.5, 63.5, fp=FP['NT'])

# wire C1/C2 +5V together and to FB1 and JP1
c1p, c1g = pxy('C1', '1'), pxy('C1', '2')
c2p, c2g = pxy('C2', '1'), pxy('C2', '2')
fb_a, fb_b = pxy('FB1', '1'), pxy('FB1', '2')
c5p, c5g = pxy('C5', '1'), pxy('C5', '2')
c6p, c6g = pxy('C6', '1'), pxy('C6', '2')
jp1, jp2 = pxy('JP1', '1'), pxy('JP1', '2')
nt1, nt2 = pxy('NT1', '1'), pxy('NT1', '2')

# +5V bus at y=25.4
y5 = 25.4
wire(c1p, (c1p[0], y5), (fb_a[0], y5), fb_a)
wire((c2p[0], y5), c2p)
add_j(c1p[0], y5); add_j(c2p[0], y5); add_j(fb_a[0], y5)
wire((c1p[0], y5), (jp1[0], y5), jp1)
add_j(jp1[0], y5)
pwr('+5V', c1p[0], y5)
# GND under C1 C2
yg = 45.72
wire(c1g, (c1g[0], yg), (c2g[0], yg), c2g)
add_j(c1g[0], yg); add_j(c2g[0], yg)
pwr('GND', (c1g[0] + c2g[0]) / 2, yg)

# +5VA bus
y5a = 25.4
wire(fb_b, (fb_b[0], y5a), (c5p[0], y5a), c5p)
wire((c6p[0], y5a), c6p)
add_j(fb_b[0], y5a); add_j(c5p[0], y5a); add_j(c6p[0], y5a)
pwr('+5VA', c6p[0], y5a)
yga = 45.72
wire(c5g, (c5g[0], yga), (c6g[0], yga), c6g)
add_j(c5g[0], yga); add_j(c6g[0], yga)
pwr('GNDA', (c5g[0] + c6g[0]) / 2, yga)

# JP1 pin2 to later Nucleo: leave a labeled wire stub that will continue
# NT1 GND-GNDA
wire(nt1, (nt1[0], nt1[1] + G))
pwr('GND', nt1[0], nt1[1] + G)
wire(nt2, (nt2[0], nt2[1] - G))
pwr('GNDA', nt2[0], nt2[1] - G)

text('Fit JP1 only if Nucleo USB is unplugged', 17.78, 76.2, 1.0)

# PWR flags
fx = 20.32
for i, kind in enumerate(['GND', '+5V', '+5VA', 'GNDA', '+3V3', '+3.3VA']):
    x = fx + i * 12.7
    flag(x, 96.52)
    pwr(kind, x, 104.14)
    wire((x, 96.52), (x, 104.14))
flag(20.32, 114.3)
pwr('+3V3', 20.32, 121.92, net_name='+3V3_DAC')
wire((20.32, 114.3), (20.32, 121.92))
text('+3V3_DAC flag', 24.13, 121.92, 1.0)

# ESP SOCKETS
rect(109.22, 12.7, 248.92, 132.08)
text('FREENOVE ESP32-S3 WROOM SOCKETS', 111.76, 16.51, 2.2, True)
text('J7 left row, J8 right row. Flashed over the board USB-C (also powers this PCB).', 111.76, 20.32, 1.27)

ESP_L = ['3V3', 'EN', 'IO4', 'IO5', 'IO6', 'IO7', 'IO15', 'IO16', 'IO17', 'IO18',
         'IO8', 'IO3', 'IO46', 'IO9', 'IO10', 'IO11', 'IO12', 'IO13', 'IO14', '5V']
ESP_R = ['IO43/TX', 'IO44/RX', 'IO1', 'IO2', 'IO42', 'IO41', 'IO40', 'IO39', 'IO38', 'IO37',
         'IO36', 'IO35', 'IO0', 'IO45', 'IO48', 'IO47', 'IO21', 'IO20', 'IO19', 'GND']
place('Connector_Generic:Conn_01x20', 'J7', 'ESP32-S3 left row', 144.78, 71.12, fp=FP['S20'])
place('Connector_Generic:Conn_01x20', 'J8', 'ESP32-S3 right row', 213.36, 71.12, rot=180, fp=FP['S20'])
for i, name in enumerate(ESP_L, 1):
    x, y = pxy('J7', str(i))
    note_pin(name, x - 12.7, y)
for i, name in enumerate(ESP_R, 1):
    x, y = pxy('J8', str(i))
    note_pin(name, x + 1.27, y)

# local ESP 3V3 / 5V / GND
place('Device:C', 'C30', '10uF', 162.56, 119.38, fp=FP['C0805'])
place('Device:C', 'C31', '100nF', 172.72, 119.38, fp=FP['C0603'])
# J7 pin1 3V3, pin20 5V; J8 pin20 GND
j7_3v3 = pxy('J7', '1')
j7_5v = pxy('J7', '20')
j8_gnd = pxy('J8', '20')
c30p, c30g = pxy('C30', '1'), pxy('C30', '2')
c31p, c31g = pxy('C31', '1'), pxy('C31', '2')
wire(j7_3v3, (j7_3v3[0] - 5.08, j7_3v3[1]), (j7_3v3[0] - 5.08, c30p[1]), (c30p[0], c30p[1]), c30p)
wire((c31p[0], c30p[1]), c31p)
add_j(c30p[0], c30p[1]); add_j(c31p[0], c30p[1])
pwr('+3V3', c31p[0] + 5.08, c31p[1] - 5.08)
wire(c31p, (c31p[0] + 5.08, c31p[1]), (c31p[0] + 5.08, c31p[1] - 5.08))
yg = c30g[1] + 5.08
wire(c30g, (c30g[0], yg), (c31g[0], yg), c31g)
add_j(c30g[0], yg); add_j(c31g[0], yg)
pwr('GND', (c30g[0] + c31g[0]) / 2, yg)
# 5V from J7-20 up to a bus that also goes left toward power section conceptually
wire(j7_5v, (j7_5v[0] - 7.62, j7_5v[1]))
pwr('+5V', j7_5v[0] - 7.62, j7_5v[1])
wire(j8_gnd, (j8_gnd[0] + 7.62, j8_gnd[1]))
pwr('GND', j8_gnd[0] + 7.62, j8_gnd[1])

used_j7 = {1, 7, 8, 9, 15, 16, 17, 20}
used_j8 = {20}
for i in range(1, 21):
    if i not in used_j7:
        nc_pin('J7', str(i))
    if i not in used_j8:
        nc_pin('J8', str(i))

# NUCLEO SOCKETS
rect(261.62, 12.7, 421.64, 132.08)
text('NUCLEO-L432KC SOCKETS', 264.16, 16.51, 2.2, True)
text('J5 = CN3, J6 = CN4. Flashed over Nucleo USB. JP1 feeds CN4 +5V.', 264.16, 20.32, 1.27)
CN3 = ['D1/PA9', 'D0/PA10', 'NRST', 'GND', 'D2/PA12', 'D3/PB0', 'D4/PB7', 'D5/PB6',
       'D6/PB1', 'D7/PC14', 'D8/PC15', 'D9/PA8', 'D10/PA11', 'D11/PB5', 'D12/PB4']
CN4 = ['VIN', 'GND', 'NRST', '+5V', 'A7/PA2', 'A6/PA7', 'A5/PA6', 'A4/PA5',
       'A3/PA4', 'A2/PA3', 'A1/PA1', 'A0/PA0', 'AREF', '+3V3', 'D13/PB3']
place('Connector_Generic:Conn_01x15', 'J5', 'Nucleo CN3', 302.26, 63.5, fp=FP['S15'])
place('Connector_Generic:Conn_01x15', 'J6', 'Nucleo CN4', 368.3, 63.5, rot=180, fp=FP['S15'])
for i, name in enumerate(CN3, 1):
    x, y = pxy('J5', str(i))
    note_pin(name, x - 16.51, y)
for i, name in enumerate(CN4, 1):
    x, y = pxy('J6', str(i))
    note_pin(name, x + 1.27, y)

# Nucleo GND, 5V, 3V3 local
j5g = pxy('J5', '4')
j6g = pxy('J6', '2')
j6_5v = pxy('J6', '4')
j6_3v3 = pxy('J6', '14')
wire(j5g, (j5g[0] - 7.62, j5g[1]))
pwr('GND', j5g[0] - 7.62, j5g[1])
wire(j6g, (j6g[0] + 7.62, j6g[1]))
pwr('GND', j6g[0] + 7.62, j6g[1])
wire(j6_5v, (j6_5v[0] + 10.16, j6_5v[1]))
# NUC_5V continues from JP1: draw a wire along the top from JP1 pin2 to J6 pin4
jp2 = pxy('JP1', '2')
# route JP1-2 right then up/over to J6-4
ybus = 10.16
wire(jp2, (jp2[0], ybus), (j6_5v[0] + 10.16, ybus), (j6_5v[0] + 10.16, j6_5v[1]))
add_j(j6_5v[0] + 10.16, j6_5v[1])
text('NUC_5V', jp2[0] + 5.08, ybus + 1.0, 1.0)

place('Device:C', 'C23', '100nF', 386.08, 119.38, fp=FP['C0603'])
place('Device:C', 'C24', '1uF', 396.24, 119.38, fp=FP['C0603'])
c23p, c23g = pxy('C23', '1'), pxy('C23', '2')
c24p, c24g = pxy('C24', '1'), pxy('C24', '2')
wire(j6_3v3, (j6_3v3[0] + 7.62, j6_3v3[1]), (j6_3v3[0] + 7.62, c23p[1]), (c23p[0], c23p[1]), c23p)
wire((c24p[0], c23p[1]), c24p)
add_j(c23p[0], c23p[1]); add_j(c24p[0], c23p[1]); add_j(j6_3v3[0] + 7.62, c23p[1])
pwr('+3.3VA', c24p[0] + 5.08, c24p[1] - 5.08)
wire(c24p, (c24p[0] + 5.08, c24p[1]), (c24p[0] + 5.08, c24p[1] - 5.08))
yg = c23g[1] + 5.08
wire(c23g, (c23g[0], yg), (c24g[0], yg), c24g)
add_j(c23g[0], yg); add_j(c24g[0], yg)
pwr('GND', (c23g[0] + c24g[0]) / 2, yg)

used_j5 = {1, 2, 4, 12}
used_j6 = {2, 4, 12, 14}
for i in range(1, 16):
    if i not in used_j5:
        nc_pin('J5', str(i))
    if i not in used_j6:
        nc_pin('J6', str(i))

# I2S series resistors between Nucleo and ESP (wired both sides)
h_res('R21', '33R', 248.92, 45.72)
h_res('R22', '33R', 248.92, 53.34)
h_res('R23', '33R', 248.92, 60.96)
# J5.12 SCK -> R21.1 ; R21.2 -> J7.7
# J5.1 FS  -> R22.1 ; R22.2 -> J7.8
# J5.2 SD  -> R23.1 ; R23.2 -> J7.9
for r, jp, ep, lab in (
    ('R21', pxy('J5', '12'), pxy('J7', '7'), 'I2S_BCLK'),
    ('R22', pxy('J5', '1'), pxy('J7', '8'), 'I2S_WS'),
    ('R23', pxy('J5', '2'), pxy('J7', '9'), 'I2S_SD'),
):
    a, b = pxy(r, '1'), pxy(r, '2')
    # J5 pins are on left of J5 (west). Route left from J5 to a vertical then to resistor.
    # Actually J5 is Conn with pins on left, so pin x is left of body. ESP J7 pins also left.
    # Place resistors between the two boxes: J7 is left of J5. R is between them.
    wire(jp, (a[0], jp[1]), a)
    add_j(a[0], jp[1]) if jp[1] != a[1] else None
    wire(b, (b[0] - 2.54, b[1]), (b[0] - 2.54, ep[1]), ep)

# ANALOGUE FRONT END - left-to-right wired chain
rect(12.7, 144.78, 261.62, 368.3)
text('ANALOGUE FRONT END', 15.24, 148.59, 2.2, True)
text('6.35 mm input, TL974 preamp, Sallen-Key ~15.8 kHz, ADC clamp. All signal nets are wired.', 15.24, 152.4, 1.27)

Y = 215.9
place('Connector_Audio:AudioJack2', 'J2', 'Guitar In 6.35mm', 30.48, Y, fp=FP['JACK'])
# bias bleed
place('Device:R', 'R10', '2.2M', 45.72, 241.3, fp=FP['R'])
v_cap('C10', '10uF', 55.88, Y, polarized=True, fp=FP['CP'])
h_res('R12', '10k', 71.12, Y)
place('Device:R', 'R11', '2.2M', 71.12, 266.7, fp=FP['R'])  # IN_AC to VBIAS
v_cap('C11', '100pF', 86.36, 241.3)

# U3A
place('Amplifier_Operational:TL074', 'U3', 'TL974', 109.22, Y, unit=1, fp=FP['SOIC14'])
h_res('R13', '3k', 129.54, 200.66)
v_cap('C12', '1nF', 129.54, 215.9)
place('Device:R', 'R14', '220R', 137.16, 241.3, fp=FP['R'])
v_cap('C13', '47uF', 137.16, 266.7, polarized=True, fp=FP['CP'])

# Sallen-Key
h_res('R15', '6.8k', 152.4, Y)
h_res('R16', '6.8k', 172.72, Y)
v_cap('C14', '2.2nF', 162.56, 190.5)
place('Amplifier_Operational:TL074', 'U3', 'TL974', 200.66, Y, unit=3, fp=FP['SOIC14'])
v_cap('C15', '1nF', 200.66, 241.3)

h_res('R17', '1k', 223.52, Y)
place('Diode:BAT54S', 'D2', 'BAT54S', 241.3, 200.66, fp=FP['SOT23'])
v_cap('C16', '1nF', 241.3, 241.3)

# VBIAS divider + unused followers
h_res('R18', '10k', 55.88, 317.5)
place('Device:R', 'R19', '10k', 71.12, 330.2, fp=FP['R'])
v_cap('C17', '10uF', 83.82, 330.2, fp=FP['C0805'])
place('Amplifier_Operational:TL074', 'U3', 'TL974', 109.22, 317.5, unit=2, fp=FP['SOIC14'])
place('Amplifier_Operational:TL074', 'U3', 'TL974', 139.7, 317.5, unit=4, fp=FP['SOIC14'])
place('Amplifier_Operational:TL074', 'U3', 'TL974', 175.26, 317.5, unit=5, fp=FP['SOIC14'])
v_cap('C18', '100nF', 190.5, 330.2)

# --- analog wires ---
# Jack tip -> C10.2 and R10.1
jt, js = pxy('J2', 'T'), pxy('J2', 'S')
c10a, c10b = pxy('C10', '1'), pxy('C10', '2')  # 1=IN_AC, 2=IN_TIP
r10a, r10b = pxy('R10', '1'), pxy('R10', '2')
wire(jt, (c10b[0], jt[1]), c10b)
add_j(c10b[0], jt[1])
wire((c10b[0], jt[1]), (r10a[0], jt[1]), (r10a[0], r10a[1]), r10a)
wire(r10b, (r10b[0], r10b[1] + G))
pwr('GNDA', r10b[0], r10b[1] + G)
wire(js, (js[0], js[1] + 3 * G))
pwr('GNDA', js[0], js[1] + 3 * G)

# IN_AC node: C10.1 -- R12.1 and R11.1
r12a, r12b = pxy('R12', '1'), pxy('R12', '2')
r11a, r11b = pxy('R11', '1'), pxy('R11', '2')
wire(c10a, (r12a[0], c10a[1]), r12a)
add_j(r12a[0], c10a[1])
wire((r12a[0], c10a[1]), (r11a[0], c10a[1]), r11a)  # R11 vertical above

# AMP_INP: R12.2 to U3A+ and C11
u3p, u3n, u3o = pxy('U3', '3', 1), pxy('U3', '2', 1), pxy('U3', '1', 1)
c11a, c11b = pxy('C11', '1'), pxy('C11', '2')
wire(r12b, (u3p[0], r12b[1]), u3p)
add_j(u3p[0], r12b[1])
wire((u3p[0], r12b[1]), (c11a[0], r12b[1]), (c11a[0], c11a[1]), c11a)
wire(c11b, (c11b[0], c11b[1] + G))
pwr('GNDA', c11b[0], c11b[1] + G)

# feedback: U3A out to R13 and R15; FB node
r13a, r13b = pxy('R13', '1'), pxy('R13', '2')  # 1=AMP_FB, 2=AMP_OUT
c12a, c12b = pxy('C12', '1'), pxy('C12', '2')
r14a, r14b = pxy('R14', '1'), pxy('R14', '2')
c13a, c13b = pxy('C13', '1'), pxy('C13', '2')
r15a, r15b = pxy('R15', '1'), pxy('R15', '2')

# AMP_OUT spine
wire(u3o, (r13b[0], u3o[1]))
add_j(r13b[0], u3o[1])
wire((r13b[0], u3o[1]), r13b)
wire((r13b[0], u3o[1]), (r13b[0], c12b[1]), c12b)
add_j(r13b[0], c12b[1])
wire((r13b[0], u3o[1]), (r15a[0], u3o[1]), r15a)
add_j(r15a[0], u3o[1])

# AMP_FB spine
wire(u3n, (r13a[0], u3n[1]), r13a)
add_j(r13a[0], u3n[1])
wire((r13a[0], u3n[1]), (r13a[0], c12a[1]), c12a)
wire((r13a[0], u3n[1]), (r14a[0], u3n[1]), (r14a[0], r14a[1]), r14a)
add_j(r14a[0], u3n[1])
wire(r14b, (r14b[0], c13a[1]), c13a)
wire(c13b, (c13b[0], c13b[1] + G))
pwr('GNDA', c13b[0], c13b[1] + G)

# Sallen-Key
r16a, r16b = pxy('R16', '1'), pxy('R16', '2')
c14a, c14b = pxy('C14', '1'), pxy('C14', '2')
u3c_p, u3c_n, u3c_o = pxy('U3', '10', 3), pxy('U3', '9', 3), pxy('U3', '8', 3)
c15a, c15b = pxy('C15', '1'), pxy('C15', '2')
r17a, r17b = pxy('R17', '1'), pxy('R17', '2')

# SK_MID: R15.2, R16.1, C14.1
wire(r15b, r16a)
add_j(r16a[0] if r15b[1] == r16a[1] else r15b[0], r15b[1])
# both horizontal at Y: r15b should meet r16a
wire((r15b[0] + (r16a[0] - r15b[0]) / 2, r15b[1]), (c14a[0], r15b[1]), c14a)
add_j(c14a[0], r15b[1])

# SK_INP: R16.2, U3C+, C15
wire(r16b, (u3c_p[0], r16b[1]), u3c_p)
add_j(u3c_p[0], r16b[1])
wire((u3c_p[0], r16b[1]), (c15a[0], r16b[1]), (c15a[0], c15a[1]), c15a)
wire(c15b, (c15b[0], c15b[1] + G))
pwr('GNDA', c15b[0], c15b[1] + G)

# AA_OUT: U3C out, U3C-, C14.2, R17.1
wire(u3c_o, (r17a[0], u3c_o[1]), r17a)
add_j(r17a[0], u3c_o[1])
wire(u3c_n, (u3c_n[0] - G, u3c_n[1]), (u3c_n[0] - G, u3c_o[1] - 2 * G), (u3c_o[0] + G, u3c_o[1] - 2 * G), (u3c_o[0] + G, u3c_o[1]))
add_j(u3c_o[0] + G, u3c_o[1])
# C14.2 to AA_OUT
wire(c14b, (c14b[0], u3c_o[1] - 2 * G))
add_j(c14b[0], u3c_o[1] - 2 * G)

# ADC_IN: R17.2, D2 COM, C16, then up to J6.12
dcom, da, dk = pxy('D2', '3'), pxy('D2', '1'), pxy('D2', '2')
c16a, c16b = pxy('C16', '1'), pxy('C16', '2')
j6adc = pxy('J6', '12')
wire(r17b, (dcom[0], r17b[1]), (dcom[0], dcom[1]))
add_j(dcom[0], r17b[1])
wire((dcom[0], r17b[1]), (c16a[0], r17b[1]), (c16a[0], c16a[1]), c16a)
wire(c16b, (c16b[0], c16b[1] + G))
pwr('GNDA', c16b[0], c16b[1] + G)
wire(da, (da[0], da[1] + 2 * G) if da[1] >= dcom[1] else (da[0] - 2 * G, da[1]))
# BAT54S orientation may be messy; attach GNDA and 3.3VA locally
wire(da, (226.06, da[1]), (226.06, 254.0))
pwr('GNDA', 226.06, 254.0)
wire(dk, (dk[0], dk[1] - 2 * G))
pwr('+3.3VA', dk[0], dk[1] - 2 * G)
# ADC to Nucleo A0
x_adc = 254.0
wire((dcom[0], r17b[1]), (x_adc, r17b[1]), (x_adc, j6adc[1]), j6adc)
add_j(dcom[0], r17b[1])
text('ADC_IN  (Nucleo A0/PA0)', x_adc + 1.27, r17b[1] - 2.54, 1.0)

# VBIAS
r18a, r18b = pxy('R18', '1'), pxy('R18', '2')
r19a, r19b = pxy('R19', '1'), pxy('R19', '2')
c17a, c17b = pxy('C17', '1'), pxy('C17', '2')
u3b_p, u3b_n, u3b_o = pxy('U3', '5', 2), pxy('U3', '6', 2), pxy('U3', '7', 2)
u3d_p, u3d_n, u3d_o = pxy('U3', '12', 4), pxy('U3', '13', 4), pxy('U3', '14', 4)
u3v, u3vm = pxy('U3', '4', 5), pxy('U3', '11', 5)

wire(r18a, (r18a[0], r18a[1] - G))
pwr('+3.3VA', r18a[0], r18a[1] - G)
# VBIAS node at R18.2 / R19.1 / C17.1 / R11.2 / followers +
wire(r18b, (r19a[0], r18b[1]), r19a)
add_j(r19a[0], r18b[1])
wire((r19a[0], r18b[1]), (c17a[0], r18b[1]), c17a)
add_j(c17a[0], r18b[1])
wire(r19b, (r19b[0], r19b[1] + G))
pwr('GNDA', r19b[0], r19b[1] + G)
wire(c17b, (c17b[0], c17b[1] + G))
pwr('GNDA', c17b[0], c17b[1] + G)
# R11.2 down to VBIAS spine
yvb = r18b[1]
wire(r11b, (r11b[0], yvb))
add_j(r11b[0], yvb)
wire((r11b[0], yvb), (r19a[0], yvb))
# followers
wire((c17a[0], yvb), (u3b_p[0], yvb), u3b_p)
add_j(u3b_p[0], yvb)
wire((u3b_p[0], yvb), (u3d_p[0], yvb), u3d_p)
add_j(u3d_p[0], yvb)
# tie unused opamp out to inverting input
wire(u3b_o, (u3b_o[0] + G, u3b_o[1]), (u3b_o[0] + G, u3b_n[1]), u3b_n)
wire(u3d_o, (u3d_o[0] + G, u3d_o[1]), (u3d_o[0] + G, u3d_n[1]), u3d_n)

# U3 power
wire(u3v, (u3v[0], u3v[1] - G))
pwr('+5VA', u3v[0], u3v[1] - G)
wire(u3vm, (u3vm[0], u3vm[1] + G))
pwr('GNDA', u3vm[0], u3vm[1] + G)
c18p, c18g = pxy('C18', '1'), pxy('C18', '2')
wire((u3v[0], u3v[1] - G), (c18p[0], u3v[1] - G), (c18p[0], c18p[1]), c18p)
add_j(u3v[0], u3v[1] - G)
wire(c18g, (c18g[0], c18g[1] + G))
pwr('GNDA', c18g[0], c18g[1] + G)

# DAC SECTION
rect(274.32, 144.78, 520.7, 368.3)
text('PCM5102A DAC', 276.86, 148.59, 2.2, True)
text('I2S from ESP32 IO10/11/12 through 33 R. Wired to jack. FMT=DEMP=FLT=SCK=GND.', 276.86, 152.4, 1.27)

place('Audio:PCM5102A', 'U7', 'PCM5102A', 381.0, 241.3, fp=FP['TSSOP20'])
# series resistors from ESP
h_res('R34', '33R', 302.26, 215.9)
h_res('R35', '33R', 302.26, 228.6)
h_res('R36', '33R', 302.26, 241.3)
# XSMT pullup
h_res('R50', '10k', 421.64, 203.2)
# outputs
h_res('R51', '470R', 436.88, 228.6)
h_res('R52', '470R', 436.88, 248.92)
v_cap('C58', '2.2nF', 457.2, 241.3)
v_cap('C59', '2.2nF', 472.44, 266.7)
place('Connector_Audio:AudioJack3', 'J3', 'Line Out 6.35mm TRS', 495.3, 241.3, fp=FP['JACK'])

# DAC supplies
place('Device:FerriteBead', 'FB3', '600R', 320.04, 317.5, rot=90, fp=FP['FB'])
v_cap('C53', '10uF', 302.26, 330.2, fp=FP['C0805'])
v_cap('C54', '100nF', 312.42, 330.2)
v_cap('C50', '10uF', 337.82, 330.2, fp=FP['C0805'])
v_cap('C51', '100nF', 348.0, 330.2)
v_cap('C52', '100nF', 358.14, 330.2)
place('Device:C', 'C55', '2.2uF', 381.0, 292.1, rot=90, fp=FP['C0603'])

v_cap('C56', '2.2uF', 401.32, 330.2)
v_cap('C57', '1uF', 416.56, 330.2)

# DAC I2S wires from J7 pins 15/16/17
for r, jp, dacpin in (
    ('R34', pxy('J7', '15'), '13'),
    ('R35', pxy('J7', '16'), '15'),
    ('R36', pxy('J7', '17'), '14'),
):
    a, b = pxy(r, '1'), pxy(r, '2')
    dp = pxy('U7', dacpin)
    wire(jp, (jp[0] - 12.7, jp[1]), (jp[0] - 12.7, 140.0), (a[0], 140.0), (a[0], a[1]), a)
    add_j(a[0], 140.0)
    wire(b, (dp[0] - 5.08, b[1]), (dp[0] - 5.08, dp[1]), dp)

# XSMT
r50a, r50b = pxy('R50', '1'), pxy('R50', '2')
xs = pxy('U7', '17')
wire(r50b, (xs[0] + 7.62, r50b[1]), (xs[0] + 7.62, xs[1]), xs)
wire(r50a, (r50a[0], r50a[1] - G))
pwr('+3V3', r50a[0], r50a[1] - G)

# analog out
r51a, r51b = pxy('R51', '1'), pxy('R51', '2')
r52a, r52b = pxy('R52', '1'), pxy('R52', '2')
outl, outr = pxy('U7', '6'), pxy('U7', '7')
c58a, c58b = pxy('C58', '1'), pxy('C58', '2')
c59a, c59b = pxy('C59', '1'), pxy('C59', '2')
jt3, jr3, js3 = pxy('J3', 'T'), pxy('J3', 'R'), pxy('J3', 'S')
wire(outl, (r51a[0], outl[1]), r51a)
wire(outr, (r52a[0], outr[1]), r52a)
wire(r51b, (jt3[0], r51b[1]), (jt3[0], jt3[1]), jt3)
add_j(jt3[0], r51b[1])
wire((jt3[0], r51b[1]), (c58a[0], r51b[1]), (c58a[0], c58a[1]), c58a)
wire(c58b, (c58b[0], c58b[1] + G))
pwr('GND', c58b[0], c58b[1] + G)
wire(r52b, (jr3[0], r52b[1]), (jr3[0], jr3[1]), jr3)
add_j(jr3[0], r52b[1])
wire((jr3[0], r52b[1]), (c59a[0], r52b[1]), (c59a[0], c59a[1]), c59a)
wire(c59b, (c59b[0], c59b[1] + G))
pwr('GND', c59b[0], c59b[1] + G)
wire(js3, (js3[0], js3[1] + 3 * G))
pwr('GND', js3[0], js3[1] + 3 * G)

# config pins to GND: FMT 16, DEMP 10, FLT 11, SCK 12, DGND 19, CPGND 3, AGND 9
ygnd_dac = 274.32
for pn in ('16', '10', '11', '12', '19', '3', '9'):
    x, y = pxy('U7', pn)
    wire((x, y), (x, ygnd_dac))
    add_j(x, ygnd_dac)
wire((pxy('U7', '16')[0], ygnd_dac), (pxy('U7', '9')[0], ygnd_dac))
pwr('GND', pxy('U7', '9')[0], ygnd_dac + G)
wire((pxy('U7', '9')[0], ygnd_dac), (pxy('U7', '9')[0], ygnd_dac + G))

# CAPP-CAPM C55
c55_1, c55_2 = pxy('C55', '1'), pxy('C55', '2')
capp, capm = pxy('U7', '2'), pxy('U7', '4')
wire(capp, (c55_1[0], capp[1]), c55_1)
wire(capm, (c55_2[0], capm[1]), c55_2)

# VNEG C56, LDOO C57
c56p, c56g = pxy('C56', '1'), pxy('C56', '2')
c57p, c57g = pxy('C57', '1'), pxy('C57', '2')
vneg, ldoo = pxy('U7', '5'), pxy('U7', '18')
wire(vneg, (vneg[0], c56p[1]), (c56p[0], c56p[1]), c56p)
wire(c56g, (c56g[0], c56g[1] + G))
pwr('GND', c56g[0], c56g[1] + G)
wire(ldoo, (ldoo[0], c57p[1]), (c57p[0], c57p[1]), c57p)
wire(c57g, (c57g[0], c57g[1] + G))
pwr('GND', c57g[0], c57g[1] + G)

# DVDD U7.20 to +3V3 with C53/C54; CPVDD/AVDD via FB3
dvdd = pxy('U7', '20')
cpvdd, avdd = pxy('U7', '1'), pxy('U7', '8')
fb3a, fb3b = pxy('FB3', '1'), pxy('FB3', '2')
c53p, c53g = pxy('C53', '1'), pxy('C53', '2')
c54p, c54g = pxy('C54', '1'), pxy('C54', '2')
c50p, c50g = pxy('C50', '1'), pxy('C50', '2')
c51p, c51g = pxy('C51', '1'), pxy('C51', '2')
c52p, c52g = pxy('C52', '1'), pxy('C52', '2')

y3 = 307.34
wire(dvdd, (dvdd[0], y3), (fb3a[0], y3), fb3a)
add_j(dvdd[0], y3); add_j(fb3a[0], y3)
wire((c53p[0], y3), c53p)
wire((c54p[0], y3), c54p)
add_j(c53p[0], y3); add_j(c54p[0], y3)
pwr('+3V3', c53p[0] - 5.08, y3)
wire((c53p[0] - 5.08, y3), (c53p[0], y3))
# analog 3V3 after bead
y3a = 307.34
wire(fb3b, (c50p[0], fb3b[1]), (c50p[0], y3a) if False else c50p)
# redo:
# FB3 is horizontal rot 90, pin1 left +3V3, pin2 right +3V3_DAC
wire(fb3b, (c50p[0], fb3b[1]), (c50p[0], c50p[1]), c50p)  # may duplicate
wire((c51p[0], c50p[1]), c51p)
wire((c52p[0], c50p[1]), c52p)
add_j(c50p[0], c50p[1]); add_j(c51p[0], c50p[1]); add_j(c52p[0], c50p[1])
wire(cpvdd, (cpvdd[0], c50p[1]))
add_j(cpvdd[0], c50p[1])
wire(avdd, (avdd[0], c50p[1]))
add_j(avdd[0], c50p[1])
pwr('+3V3', c52p[0] + 7.62, c50p[1] - 7.62, net_name='+3V3_DAC')
wire((c52p[0], c50p[1]), (c52p[0] + 7.62, c50p[1]), (c52p[0] + 7.62, c50p[1] - 7.62))

yg = 345.44
for capg in (c53g, c54g, c50g, c51g, c52g):
    wire(capg, (capg[0], yg))
    add_j(capg[0], yg)
wire((c53g[0], yg), (c52g[0], yg))
pwr('GND', (c53g[0] + c52g[0]) / 2, yg + G)
wire(((c53g[0] + c52g[0]) / 2, yg), ((c53g[0] + c52g[0]) / 2, yg + G))
add_j((c53g[0] + c52g[0]) / 2, yg)

# Design notes
text('DESIGN NOTES', 15.24, 375.92, 1.8, True)
notes = [
    'Power symbols are still used for GND / rails (KiCad power ports). All audio and I2S nets are drawn as wires.',
    'JP1 is a series link from +5V to Nucleo CN4-4. Remove it while the Nucleo USB is plugged in.',
    'Freenove pin order is from the vendor docs; check silkscreen before ordering sockets.',
    'GNDA joins GND only at NT1. ADC_IN is wired to Nucleo A0/PA0 (J6 pin 12).',
]
for i, n in enumerate(notes):
    text(n, 15.24, 380.0 + i * 4.0, 1.27)

# emit wires/junctions/ncs
out_items = []
for a, b in wires:
    out_items.append(['wire', ['pts', ['xy', round(a[0], 4), round(a[1], 4)],
                                     ['xy', round(b[0], 4), round(b[1], 4)]],
                      ['stroke', ['width', 0], ['type', 'default']],
                      ['uuid', Q(uid())]])
for x, y in sorted(junctions):
    out_items.append(['junction', ['at', x, y], ['diameter', 0], ['color', 0, 0, 0, 0], ['uuid', Q(uid())]])
for x, y in ncs:
    out_items.append(['no_connect', ['at', round(x, 4), round(y, 4)], ['uuid', Q(uid())]])

sch = ['kicad_sch',
       ['version', 20250114],
       ['generator', Q('eeschema')],
       ['generator_version', Q('9.0')],
       ['uuid', Q(ROOT)],
       ['paper', Q('A2')],
       ['title_block',
        ['title', Q('Stanza Board (devboard version) - Freenove ESP32-S3 + NUCLEO-L432KC')],
        ['date', Q('2026-10-11')],
        ['rev', Q('B')],
        ['company', Q('Sonido')],
        ['comment', 1, Q('Fully wired schematic: signal nets drawn as wires, not label-only.')]],
       LIB]
sch.extend(body)
sch.extend(out_items)
sch.extend(texts)
sch.extend(rects)
sch.append(['sheet_instances', ['path', Q('/'), ['page', Q('1')]]])
sch.append(['embedded_fonts', 'no'])

open(SCH, 'w', encoding='utf-8', newline='\n').write(dump(sch) + '\n')
print('wrote', SCH, 'parts', sum(1 for k in placed if not k[0].startswith('#')), 'wires', len(wires))
