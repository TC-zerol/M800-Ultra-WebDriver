"""爆破 byte[1..2] 的 CRC16 算法"""
import re

lines = open(r'F:\mouse\capture\events.log', encoding='utf-8', errors='replace').read().splitlines()
pat = re.compile(r'RX \[ff1c:92\] ((?:[0-9a-f]{2} )+[0-9a-f]{2})')
pkts = []
for ln in lines:
    m = pat.search(ln)
    if m:
        b = bytes(int(x, 16) for x in m.group(1).split())
        if b[3] in (0x03, 0x05, 0x06, 0x07):  # 带校验的命令
            pkts.append(b)
uniq = sorted(set(pkts))
print(f'带校验的唯一包: {len(uniq)}')

def crc16(data, poly, init, refin, refout, xorout):
    def reflect(x, bits):
        r = 0
        for i in range(bits):
            if x & (1 << i): r |= 1 << (bits - 1 - i)
        return r
    crc = init
    for byte in data:
        if refin: byte = reflect(byte, 8)
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ poly) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    if refout: crc = reflect(crc, 16)
    return crc ^ xorout

variants = {
    'MODBUS':   (0x8005, 0xFFFF, True,  True,  0x0000),
    'IBM/ARC':  (0x8005, 0x0000, True,  True,  0x0000),
    'USB':      (0x8005, 0xFFFF, True,  True,  0xFFFF),
    'CCITT-FALSE':(0x1021, 0xFFFF, False, False, 0x0000),
    'XMODEM':   (0x1021, 0x0000, False, False, 0x0000),
    'X25':      (0x1021, 0xFFFF, True,  True,  0xFFFF),
    'AUG-CCITT':(0x1021, 0x1D0F, False, False, 0x0000),
    'DNP':      (0x3D65, 0x0000, True,  True,  0xFFFF),
}

# 候选数据区间: bytes[3:] 的不同长度
slices = {}
for name, sl in [('3:64', slice(3, 64)), ('3:32', slice(3, 32)), ('3:8+d', None),
                 ('4:64', slice(4, 64)), ('4:32', slice(4, 32)), ('0+3:64', None)]:
    slices[name] = sl

for vname, params in variants.items():
    for sname, sl in slices.items():
        ok = True
        for b in uniq[:8]:
            if sname == '3:8+d':
                data = b[3:8] + b[8:8+24]
            elif sname == '0+3:64':
                data = bytes([b[0]]) + b[3:64]
            else:
                data = b[sl]
            got = crc16(data, *params)
            want = b[1] | (b[2] << 8)
            if got != want:
                ok = False
                break
        if ok:
            print(f'*** 命中! {vname} 区间={sname}')

# 如果没命中，打印几个样本的 CRC 供人工分析
print('\n样本 (crc_lo crc_hi | cmd len off | data前24字节):')
for b in uniq[:10]:
    print(f'  {b[1]:02x} {b[2]:02x} | {b[3]:02x} {b[4]:02x} {b[5]:02x} | ' + ' '.join(f'{x:02x}' for x in b[8:32]))
