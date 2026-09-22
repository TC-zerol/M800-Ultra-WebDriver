"""分析 hid_monitor 抓到的 RX 日志：找协议规律"""
import re, sys
from collections import defaultdict

lines = open(r'F:\mouse\capture\events.log', encoding='utf-8', errors='replace').read().splitlines()

packets = []  # (time, bytes)
pat = re.compile(r'^(\d\d:\d\d:\d\d\.\d+) RX \[ff1c:92\] ((?:[0-9a-f]{2} )+[0-9a-f]{2})')
for ln in lines:
    m = pat.match(ln)
    if m:
        packets.append((m.group(1), bytes(int(x, 16) for x in m.group(2).split())))

print(f'总包数: {len(packets)}  时间范围: {packets[0][0]} ~ {packets[-1][0]}')
print()

# 1. 按 (byte3 子命令) 分组统计
by_cmd = defaultdict(list)
for t, b in packets:
    by_cmd[b[3]].append((t, b))
print('=== 按子命令字节(byte[3])分组 ===')
for cmd, lst in sorted(by_cmd.items()):
    uniq = len({b for _, b in lst})
    print(f'  cmd=0x{cmd:02x}: {len(lst)} 包, {uniq} 种不同载荷, 首 {lst[0][0]} 末 {lst[-1][0]}')
print()

# 2. 每种载荷的出现次数（只显示非全零的）
print('=== 各子命令的不同载荷（去重，显示前40字节）===')
for cmd, lst in sorted(by_cmd.items()):
    seen = {}
    for t, b in lst:
        seen.setdefault(b, [0, t, t])
        seen[b][0] += 1
        seen[b][2] = t
    print(f'--- cmd=0x{cmd:02x} ({len(seen)} 种) ---')
    for b, (n, t0, t1) in sorted(seen.items(), key=lambda x: -x[1][0])[:20]:
        hexs = ' '.join(f'{x:02x}' for x in b[:40])
        print(f'  x{n:4d} [{t0}~{t1}] {hexs}')
    print()
