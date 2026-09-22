# -*- coding: utf-8 -*-
"""
M800 Ultra (DELUX Receiver 320F:225B) HID 监听器 —— 零安装，纯 ctypes。
枚举接收器的所有 HID 顶层集合，打开并监听输入报告（心跳/事件/ACK）。
可选：用 HidD_SetOutputReport 发送探测命令（需 --send 参数显式指定）。

用法：
  python hid_monitor.py            # 监听 30 秒
  python hid_monitor.py -t 0       # 一直监听，Ctrl+C 停止
  python hid_monitor.py --send "04 38 01 ..." --id 4   # 发送一条 output report 后继续监听
"""
import argparse, ctypes, sys, time
from ctypes import wintypes

hid = ctypes.WinDLL("hid")
setupapi = ctypes.WinDLL("setupapi")
kernel32 = ctypes.WinDLL("kernel32")

# 64 位下必须显式声明返回 HANDLE，否则 ctypes 默认 int 会截断指针
setupapi.SetupDiGetClassDevsW.restype = wintypes.HANDLE
setupapi.SetupDiGetClassDevsW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR, wintypes.HANDLE, wintypes.DWORD]
setupapi.SetupDiEnumDeviceInterfaces.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
setupapi.SetupDiGetDeviceInterfaceDetailW.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p]
setupapi.SetupDiDestroyDeviceInfoList.argtypes = [wintypes.HANDLE]
kernel32.CreateFileW.restype = wintypes.HANDLE
kernel32.CreateEventW.restype = wintypes.HANDLE
kernel32.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
kernel32.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p]
kernel32.GetOverlappedResult.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, wintypes.BOOL]
kernel32.WaitForMultipleObjects.argtypes = [wintypes.DWORD, ctypes.c_void_p, wintypes.BOOL, wintypes.DWORD]
kernel32.CancelIoEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.ResetEvent.argtypes = [wintypes.HANDLE]
hid.HidD_GetPreparsedData.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
hid.HidD_FreePreparsedData.argtypes = [ctypes.c_void_p]
hid.HidP_GetCaps.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
hid.HidD_SetOutputReport.argtypes = [wintypes.HANDLE, ctypes.c_char_p, wintypes.ULONG]

DIGCF_PRESENT = 0x02
DIGCF_DEVICEINTERFACE = 0x10
GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
FILE_SHARE_READ = 0x01
FILE_SHARE_WRITE = 0x02
OPEN_EXISTING = 3
FILE_FLAG_OVERLAPPED = 0x40000000
INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value
WAIT_TIMEOUT = 0x102


class GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_ulong), ("Data2", ctypes.c_ushort),
                ("Data3", ctypes.c_ushort), ("Data4", ctypes.c_ubyte * 8)]


class SP_DEVICE_INTERFACE_DATA(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("InterfaceClassGuid", GUID),
                ("Flags", wintypes.DWORD), ("Reserved", ctypes.POINTER(ctypes.c_ulong))]


class SP_DEVICE_INTERFACE_DETAIL_DATA_W(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("DevicePath", wintypes.WCHAR * 1)]


class OVERLAPPED(ctypes.Structure):
    _fields_ = [("Internal", ctypes.c_void_p), ("InternalHigh", ctypes.c_void_p),
                ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD),
                ("hEvent", wintypes.HANDLE)]


class HIDP_CAPS(ctypes.Structure):
    _fields_ = [("Usage", wintypes.USHORT), ("UsagePage", wintypes.USHORT),
                ("InputReportByteLength", wintypes.USHORT),
                ("OutputReportByteLength", wintypes.USHORT),
                ("FeatureReportByteLength", wintypes.USHORT),
                ("Reserved", wintypes.USHORT * 17),
                ("NumberLinkCollectionNodes", wintypes.USHORT),
                ("NumberInputButtonCaps", wintypes.USHORT), ("NumberInputValueCaps", wintypes.USHORT),
                ("NumberInputDataIndices", wintypes.USHORT), ("NumberOutputButtonCaps", wintypes.USHORT),
                ("NumberOutputValueCaps", wintypes.USHORT), ("NumberOutputDataIndices", wintypes.USHORT),
                ("NumberFeatureButtonCaps", wintypes.USHORT), ("NumberFeatureValueCaps", wintypes.USHORT),
                ("NumberFeatureDataIndices", wintypes.USHORT)]


def enum_hid_paths(vid_pid: str):
    """枚举所有 HID 设备接口路径，返回匹配 vid_pid（如 'vid_320f&pid_225b'）的路径列表。"""
    g = GUID()
    hid.HidD_GetHidGuid(ctypes.byref(g))
    hset = setupapi.SetupDiGetClassDevsW(ctypes.byref(g), None, None,
                                         DIGCF_PRESENT | DIGCF_DEVICEINTERFACE)
    paths = []
    i = 0
    while True:
        did = SP_DEVICE_INTERFACE_DATA()
        did.cbSize = ctypes.sizeof(SP_DEVICE_INTERFACE_DATA)
        if not setupapi.SetupDiEnumDeviceInterfaces(hset, None, ctypes.byref(g), i, ctypes.byref(did)):
            break
        i += 1
        need = wintypes.DWORD(0)
        setupapi.SetupDiGetDeviceInterfaceDetailW(hset, ctypes.byref(did), None, 0, ctypes.byref(need), None)
        buf = ctypes.create_unicode_buffer(need.value)
        detail = ctypes.cast(buf, ctypes.POINTER(SP_DEVICE_INTERFACE_DETAIL_DATA_W))
        detail.contents.cbSize = 6 if ctypes.sizeof(ctypes.c_void_p) == 4 else 8
        if setupapi.SetupDiGetDeviceInterfaceDetailW(hset, ctypes.byref(did), detail, need.value, None, None):
            path = ctypes.wstring_at(ctypes.addressof(buf) + 4)  # 跳过 DWORD cbSize
            if vid_pid.lower() in path.lower():
                paths.append(path)
    setupapi.SetupDiDestroyDeviceInfoList(hset)
    return paths


def open_hid(path):
    h = kernel32.CreateFileW(path, GENERIC_READ | GENERIC_WRITE,
                             FILE_SHARE_READ | FILE_SHARE_WRITE, None,
                             OPEN_EXISTING, FILE_FLAG_OVERLAPPED, None)
    if h == INVALID_HANDLE_VALUE:
        h = kernel32.CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                 None, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, None)
    if h == INVALID_HANDLE_VALUE:
        return None, None
    caps = HIDP_CAPS()
    preparsed = ctypes.c_void_p()
    if hid.HidD_GetPreparsedData(h, ctypes.byref(preparsed)):
        hid.HidP_GetCaps(preparsed, ctypes.byref(caps))
        hid.HidD_FreePreparsedData(preparsed)
    return h, caps



class Listener:
    def __init__(self, path, handle, caps):
        self.path = path
        self.handle = handle
        self.caps = caps
        self.buf = ctypes.create_string_buffer(4096)
        self.ov = OVERLAPPED()
        self.ov.hEvent = kernel32.CreateEventW(None, True, False, None)
        self.pending = False

    def arm(self):
        kernel32.ResetEvent(self.ov.hEvent)
        ok = kernel32.ReadFile(self.handle, self.buf, 4096, None, ctypes.byref(self.ov))
        if ok:  # 同步完成（罕见）
            n = self.caps.InputReportByteLength if self.caps else 1
            return self.buf.raw[:max(1, n)]
        if kernel32.GetLastError() == 997:  # ERROR_IO_PENDING
            self.pending = True
        return None

    def result(self):
        n = wintypes.DWORD(0)
        if kernel32.GetOverlappedResult(self.handle, ctypes.byref(self.ov), ctypes.byref(n), False):
            return self.buf.raw[:n.value]
        return None

    def close(self):
        if self.pending:
            kernel32.CancelIoEx(self.handle, ctypes.byref(self.ov))
        kernel32.CloseHandle(self.ov.hEvent)
        kernel32.CloseHandle(self.handle)


def hx(b):
    return " ".join(f"{x:02x}" for x in b)


def crc16_modbus(data):
    """CRC16-MODBUS (poly 0x8005, init 0xFFFF, refin/refout) —— 已从抓包验证"""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def build_report(cmd, length=0, offset=0, payload=b""):
    """构造 64 字节报告: [0]=04 [1..2]=CRC16(bytes[3..31]) [3]=cmd [4]=len [5]=off [6..7]=0 [8..31]=payload"""
    body = bytes([cmd, length, offset, 0, 0]) + payload
    body = body.ljust(29, b"\x00")
    crc = crc16_modbus(body)
    return (bytes([0x04, crc & 0xFF, crc >> 8]) + body).ljust(64, b"\x00")



def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-t", type=float, default=30, help="监听秒数，0=无限")
    ap.add_argument("--vp", default="vid_320f&pid_225b", help="VID/PID 过滤串")
    ap.add_argument("--send", default=None, help='十六进制 payload，如 "05 01 02"')
    ap.add_argument("--id", type=lambda s: int(s, 0), default=0, help="发送时的 reportId")
    ap.add_argument("--cmd", default=None, action="append",
                    help='协议命令（自动加 reportId 0x04 和 CRC16），如 "1a" 或 "05 18 00"，可多次指定')
    args = ap.parse_args()

    paths = enum_hid_paths(args.vp)
    if not paths:
        print(f"未找到匹配 {args.vp} 的 HID 设备接口")
        sys.exit(1)
    print(f"找到 {len(paths)} 个顶层集合：")
    listeners = []
    for p in paths:
        h, caps = open_hid(p)
        tag = p.split("#")[1] if "#" in p else p
        if h is None:
            print(f"  [打不开] {tag}")
            continue
        listeners.append(Listener(p, h, caps))
        print(f"  [OK] {tag}  usagePage=0x{caps.UsagePage:04x} usage=0x{caps.Usage:02x}"
              f"  in={caps.InputReportByteLength}B out={caps.OutputReportByteLength}B"
              f" feat={caps.FeatureReportByteLength}B")

    if not listeners:
        print("没有可打开的设备接口")
        sys.exit(1)

    # 发送协议命令（自动 CRC，发到厂商自定义集合）
    if args.cmd:
        target = next((l for l in listeners if l.caps.UsagePage == 0xFF1C), None)
        if target is None:
            print("未找到厂商自定义集合 (usagePage 0xFF1C)")
            sys.exit(1)
        outlen = target.caps.OutputReportByteLength
        target.arm()  # 先挂上读，避免漏掉快速响应
        for c in args.cmd:
            parts = [int(x, 16) for x in c.replace(",", " ").split()]
            rep = build_report(parts[0], parts[1] if len(parts) > 1 else 0,
                               parts[2] if len(parts) > 2 else 0, bytes(parts[3:]))
            ok = hid.HidD_SetOutputReport(target.handle, rep[:outlen], outlen)
            print(f"-> 协议命令 [{hx(rep[:outlen])}] ... {'OK' if ok else '失败'}")
            time.sleep(0.3)

    # 发送探测命令（如指定）
    if args.send:
        payload = bytes(int(x, 16) for x in args.send.replace(",", " ").split())
        target = None
        for l in listeners:
            if l.caps.OutputReportByteLength > len(payload):
                target = l
                break
        target = target or listeners[-1]
        outlen = target.caps.OutputReportByteLength or (len(payload) + 1)
        rep = bytes([args.id]) + payload
        rep = rep.ljust(outlen, b"\x00")
        ok = hid.HidD_SetOutputReport(target.handle, rep, outlen)
        print(f"-> SetOutputReport id=0x{args.id:02x} [{hx(payload)}] "
              f"到 usagePage=0x{target.caps.UsagePage:04x} ... {'OK' if ok else '失败'}")

    print("\n开始监听输入报告（Ctrl+C 停止）...")
    start = time.time()
    try:
        for l in listeners:
            l.arm()
        while True:
            if args.t and time.time() - start > args.t:
                break
            events = [l.ov.hEvent for l in listeners]
            arr = (wintypes.HANDLE * len(events))(*events)
            r = kernel32.WaitForMultipleObjects(len(events), arr, False, 500)
            if r == WAIT_TIMEOUT:
                continue
            idx = r
            if 0 <= idx < len(listeners):
                l = listeners[idx]
                data = l.result()
                l.pending = False
                if data:
                    ts = time.strftime("%H:%M:%S") + f".{int(time.time()*1000)%1000:03d}"
                    print(f"{ts} RX [{l.caps.UsagePage:04x}:{l.caps.Usage:02x}] {hx(data)}")
                l.arm()
    except KeyboardInterrupt:
        pass
    finally:
        for l in listeners:
            l.close()
    print("结束。")


if __name__ == "__main__":
    main()

