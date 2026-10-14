t = open('overlay.py', encoding='utf-8').read()
old = "for name, pts in sorted(labels.items()):"
new = """PRIO = ['IN_TIP','IN_AC','AMP_INP','AMP_FB','AMP_OUT','GAIN_LEG','SK_MID','SK_INP','AA_OUT','ADC_IN',
        'I2S_BCLK','I2S_WS','I2S_SD','STM_SAI_SCK','STM_SAI_FS','STM_SAI_SD',
        'ESP_DAC_BCK','ESP_DAC_LRCK','ESP_DAC_DIN','DAC_BCK','DAC_LRCK','DAC_DIN','DAC_OUTL','DAC_OUTR',
        'NUC_5V']
def k(item):
    name = item[0]
    return (0, PRIO.index(name)) if name in PRIO else (1, name)
for name, pts in sorted(labels.items(), key=k):"""
if old not in t:
    raise SystemExit('missing loop')
open('overlay.py', 'w', encoding='utf-8', newline='\n').write(t.replace(old, new, 1))
print('ok')
