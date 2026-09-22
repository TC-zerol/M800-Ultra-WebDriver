/* 多彩 M800 Ultra 网页驱动 —— 阶段三：功能版
 * 设备：DELUX Receiver, VID 0x320F / PID 0x225B
 * 通道：MI_01 上 vendor-defined 集合 (usagePage 0xFF1C, usage 0x92)，64 字节报告
 *
 * 协议（已通过抓包+实机读写验证）：
 *   报告: [0]=0x04  [1..2]=CRC16-MODBUS(bytes[3..31]) 小端
 *         [3]=命令  [4]=长度  [5]=偏移  [6..7]=0  [8..31]=24字节载荷
 *   命令: 0x1A=电量(载荷[0]=百分比)  0x05=读配置块  0x06=写配置块
 *         0x03=版本信息  0x07=按键映射  0x01/0x02=灯光  0xAA=ACK
 *   配置块（偏移 0x00/0x18/0x30/0x48 各 24 字节）：
 *     0x00: [2]=有线回报率 [3]=休眠档 [5]=深度休眠开关 [6]=按键防抖
 *           [11]=无线回报率(0=125..6=8000, 已验证 2=500/3=1000)
 *           [16..17]=档位1 DPI_X [18..19]=档位1 DPI_Y
 *     0x18: [1..2]=档2X [3..4]=档2Y [10..11]=档3X [12..13]=档3Y [18..19]=档4X [20..21]=档4Y
 *     0x30: [4..5]=档5X [6..7]=档5Y [12..13]=档6X [14..15]=档6Y
 *           [20]=休眠秒数 [22..23]=深度休眠秒数(LE)
 *     0x48: 灯光颜色区，[23]=回报率镜像（官方驱动会同步写）
 */
"use strict";

const VENDOR_ID = 0x320f;
const PRODUCT_ID = 0x225b;
const REPORT_ID = 0x04;
const USAGE_PAGE = 0xff1c;
const USAGE = 0x92;

let device = null;
const logLines = [];

/* ---------- 工具 ---------- */
const $ = (id) => document.getElementById(id);
const hex = (n, w = 2) => n.toString(16).padStart(w, "0");
const buf2hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => hex(b)).join(" ");

function timestamp() {
  const d = new Date();
  return `${hex(d.getHours())}:${hex(d.getMinutes())}:${hex(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function appendLog(kind, text) {
  const el = $("report-log");
  if (!el) return;
  const line = document.createElement("div");
  line.innerHTML = `<span class="t">${timestamp()}</span> <span class="${kind}">${text}</span>`;
  el.appendChild(line);
  logLines.push(`${timestamp()} ${kind.toUpperCase()} ${line.textContent.replace(/^[\d:.]+\s*/, "")}`);
  if ($("chk-autoscroll")?.checked) el.scrollTop = el.scrollHeight;
}

/* ---------- CRC16-MODBUS（与抓包逐字节验证一致） ---------- */
function crc16modbus(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc;
}

/* 构造 64 字节报告（含 reportId），返回 Uint8Array(64) */
function buildReport(cmd, len = 0, off = 0, payload = new Uint8Array(0)) {
  const body = new Uint8Array(29);          // bytes[3..31]
  body[0] = cmd; body[1] = len; body[2] = off;
  body.set(payload.subarray(0, 24), 5);
  const crc = crc16modbus(body);
  const full = new Uint8Array(64);
  full[0] = REPORT_ID; full[1] = crc & 0xff; full[2] = crc >> 8;
  full.set(body, 3);
  return full;
}


/* ---------- 协议层：发送命令并等待匹配响应 ---------- */
const pendingWaiters = [];

function onInputReport(e) {
  if (e.reportId !== REPORT_ID) return;
  const d = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
  // d = report[1..63]；d[0..1]=CRC d[2]=cmd d[3]=len d[4]=off d[7..30]=payload
  const cmd = d[2], len = d[3], off = d[4];
  const payload = d.slice(7, 31);
  logRx(cmd, len, off, payload, d);
  for (let i = pendingWaiters.length - 1; i >= 0; i--) {
    const w = pendingWaiters[i];
    if (w.match(cmd, off)) {
      pendingWaiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve({ cmd, len, off, payload, raw: d });
    }
  }
  // 设备/官方驱动改动配置的同步包：更新本地缓存并刷新界面（不打断正在编辑的输入框）
  if (cmd === 0x06 && CHUNK_OFFS.includes(off) && payload.length >= 24) {
    chunks[off] = payload.slice(0, 24);
    refreshStatusUI();
    updateDpiRowsFromConfig();
  }
  // 设备周期性电量广播（充电时约每 2 秒一次）：实时刷新 UI 与图表
  if (cmd === 0x1a) {
    const { pct, charging } = parseBattery(d);
    updateBatteryUI(pct, charging);
  }
}

function logRx(cmd, len, off, payload, raw) {
  const names = { 0xaa: "ACK", 0x1a: "电量", 0x05: "配置读", 0x06: "配置写/同步", 0x03: "版本", 0x07: "按键映射", 0x01: "灯光1", 0x02: "灯光2" };
  let desc = names[cmd] || `cmd=0x${hex(cmd)}`;
  if (cmd === 0x1a) {
    const b = parseBattery(raw);
    desc += ` ${b.pct}%${b.charging ? "⚡" : ""}`;
  }
  if (cmd === 0x05 || cmd === 0x06) desc += ` 块@0x${hex(off)}`;
  const showRaw = $("chk-showraw")?.checked;
  appendLog("rx", `RX ${desc}${showRaw ? " [" + buf2hex(raw.buffer) + "]" : ""}`);
}

function query(cmd, len = 0, off = 0, payload = new Uint8Array(0), timeout = 1500) {
  return new Promise(async (resolve, reject) => {
    const w = {
      match: (c, o) => c === cmd && (cmd !== 0x05 || o === off),
      resolve, reject,
      timer: setTimeout(() => {
        const i = pendingWaiters.indexOf(w);
        if (i >= 0) pendingWaiters.splice(i, 1);
        if (cmd === 0x06) resolve(null);        // 写命令允许无回包
        else reject(new Error(`等待响应超时 (cmd=0x${hex(cmd)})`));
      }, timeout),
    };
    pendingWaiters.push(w);
    const rep = buildReport(cmd, len, off, payload);
    try {
      await device.sendReport(REPORT_ID, rep.slice(1));
      appendLog("tx", `TX cmd=0x${hex(cmd)} len=${len} off=0x${hex(off)}${payload.length ? " data=[" + Array.from(payload).map((x) => hex(x)).join(" ") + "]" : ""}`);
    } catch (err) {
      clearTimeout(w.timer);
      const i = pendingWaiters.indexOf(w);
      if (i >= 0) pendingWaiters.splice(i, 1);
      reject(err);
    }
  });
}

/* ---------- 配置状态 ---------- */
const chunks = {};   // off -> Uint8Array(24)
const CHUNK_OFFS = [0x00, 0x18, 0x30, 0x48];

async function readChunk(off) {
  const r = await query(0x05, 0x18, off);
  chunks[off] = r.payload.slice(0, 24);
  return chunks[off];
}

async function writeChunk(off) {
  await query(0x06, 0x18, off, chunks[off]);
}

async function readAllConfig() {
  for (const off of CHUNK_OFFS) await readChunk(off);
}

/* DPI 档位 → [chunk偏移, X字节位置, Y字节位置]（载荷内偏移）
   记录为跨块连续的 9 字节结构：[启用, 00, X_L, X_H, Y_L, Y_H, R, G, B] */
const DPI_MAP = [
  [0x00, 16, 18],  // 档位1
  [0x18, 1, 3],    // 档位2
  [0x18, 10, 12],  // 档位3
  [0x18, 19, 21],  // 档位4（注意：X 在 19 不是 18！）
  [0x30, 4, 6],    // 档位5
  [0x30, 13, 15],  // 档位6
];
/* 各档位"启用"字节 → [chunk偏移, 字节位置]（1=启用 0=禁用，已实机对比验证） */
const STAGE_EN = [
  [0x00, 14],  // 档位1
  [0x00, 23],  // 档位2
  [0x18, 8],   // 档位3
  [0x18, 17],  // 档位4
  [0x30, 2],   // 档位5
  [0x30, 11],  // 档位6
];
const STAGE_COLORS = ["#ff0000", "#00ff00", "#0000ff", "#ff00ff", "#ffff00", "#ffffff"];
const RATE_HZ = [125, 250, 500, 1000, 2000, 4000, 8000];

function getDpi(stage) {
  const [off, xi, yi] = DPI_MAP[stage];
  const c = chunks[off];
  return { x: c[xi] | (c[xi + 1] << 8), y: c[yi] | (c[yi + 1] << 8) };
}
function setDpi(stage, x, y) {
  const [off, xi, yi] = DPI_MAP[stage];
  const c = chunks[off];
  c[xi] = x & 0xff; c[xi + 1] = (x >> 8) & 0xff;
  c[yi] = y & 0xff; c[yi + 1] = (y >> 8) & 0xff;
}
function getStageEnabled(stage) {
  const [off, i] = STAGE_EN[stage];
  return chunks[off][i] === 1;
}
function setStageEnabled(stage, en) {
  const [off, i] = STAGE_EN[stage];
  chunks[off][i] = en ? 1 : 0;
}

/* ---------- 环境检查 ---------- */
(function checkEnv() {
  const box = $("env-warnings");
  if (!window.isSecureContext) {
    box.innerHTML += `<div class="warn">⚠️ 当前不是安全上下文（WebHID 要求 HTTPS 或 localhost）。本地用请通过 <b>http://localhost</b> 或 <b>http://127.0.0.1</b> 访问；群晖/NAS 部署后在 Chrome 打开 <b>chrome://flags/#unsafely-treat-insecure-origin-as-secure</b>，填入 <code>${location.origin}</code> 并启用、重启浏览器即可。</div>`;
  }
  if (!("hid" in navigator)) {
    box.innerHTML += `<div class="warn">⚠️ 当前浏览器不支持 WebHID，请使用桌面版 <b>Chrome</b> / <b>Edge</b>。</div>`;
    $("btn-connect").disabled = true;
  }
})();

/* ---------- 连接 ---------- */
async function openDevice(d) {
  device = d;
  await device.open();
  device.addEventListener("inputreport", onInputReport);
  navigator.hid.addEventListener("disconnect", (e) => {
    if (e.device === device) handleDisconnect();
  });
  await onConnected();
}

async function connect() {
  try {
    const devices = await navigator.hid.requestDevice({
      filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID, usagePage: USAGE_PAGE, usage: USAGE }],
    });
    if (!devices.length) return;
    await openDevice(devices[0]);
  } catch (err) {
    $("device-status").textContent = "连接失败：" + err.message;
  }
}

/* 自动重连：浏览器记住授权过的设备，下次打开页面免点"连接"直接进设置 */
async function tryAutoReconnect() {
  if (!("hid" in navigator)) return;
  try {
    const devices = await navigator.hid.getDevices();
    const d = devices.find((x) => x.vendorId === VENDOR_ID && x.productId === PRODUCT_ID);
    if (!d) return;
    $("device-status").textContent = "检测到已授权设备，正在自动连接…";
    await openDevice(d);
  } catch (err) {
    device = null;
    $("device-status").textContent = "自动连接失败，请手动点连接：" + err.message;
  }
}
window.addEventListener("load", tryAutoReconnect);

$("btn-connect").onclick = connect;

$("btn-disconnect").onclick = async () => {
  if (device) await device.close();
  handleDisconnect();
};

async function onConnected() {
  $("btn-disconnect").disabled = false;
  $("conn-badge").textContent = "已连接";
  $("conn-badge").className = "badge green";
  $("device-status").textContent =
    `已连接 ✅  ${device.productName}  (VID 0x${hex(device.vendorId, 4)} / PID 0x${hex(device.productId, 4)})`;
  ["card-status", "card-dpi", "card-settings", "card-adv", "card-monitor", "card-console", "card-info"].forEach(
    (id) => ($(id).hidden = false)
  );
  renderCollections();
  appendLog("note", `已打开 "${device.productName}"，正在读取设备状态…`);
  try {
    await refreshBattery();
    await readAllConfig();
    refreshStatusUI();
    buildDpiRows();
    drawBatteryChart();
    appendLog("note", "配置读取完成 ✅");
  } catch (err) {
    appendLog("err", "初始读取失败：" + err.message);
  }
}

function handleDisconnect() {
  device = null;
  $("btn-disconnect").disabled = true;
  $("conn-badge").textContent = "未连接";
  $("conn-badge").className = "badge";
  $("device-status").textContent = "已断开";
  appendLog("err", "设备已断开");
}

/* ---------- 电量 ---------- */
/* 电量包布局（充/放电双状态实机确认）：
   充电 04 00 00 1a 00 00 00 ff 5b 01  → 91% 充电中
   放电 04 00 00 1a 00 00 00 ff 55 00  → 85% 放电
   raw[6]=FF 固定标记，raw[7]=百分比，raw[8]=01充电/00放电 */
function parseBattery(raw) {
  const pct = raw[7];
  const charging = raw[8] === 0x01;
  return { pct: pct <= 100 ? pct : 0, charging };
}

function updateBatteryUI(pct, charging) {
  $("st-battery").textContent = `${pct}%${charging ? " ⚡充电中" : ""}`;
  const badge = $("battery-badge");
  badge.hidden = false;
  badge.textContent = `电量 ${pct}%${charging ? " ⚡" : ""}`;
  badge.className = "badge " + (charging ? "blue" : pct <= 20 ? "red" : "green");
  saveBatSample(pct, charging);
}

async function refreshBattery() {
  const r = await query(0x1a);
  const { pct, charging } = parseBattery(r.raw);
  updateBatteryUI(pct, charging);
}
$("btn-refresh-bat").onclick = () => refreshBattery().catch((e) => appendLog("err", e.message));
setInterval(() => {
  if (device && $("chk-auto-bat")?.checked) refreshBattery().catch(() => {});
}, 3000);

/* ---------- 电量历史图表（仿 iPhone 电池页面，localStorage 持久化） ---------- */
const BAT_KEY = "m800-battery-history-v1";

function loadBatHistory() {
  try { return JSON.parse(localStorage.getItem(BAT_KEY)) || []; } catch { return []; }
}

function saveBatSample(pct, charging) {
  const h = loadBatHistory();
  const now = Date.now();
  const last = h[h.length - 1];
  if (last && now - last.t < 60000 && last.pct === pct && !!last.c === !!charging) return; // 1分钟内无变化不重复记
  h.push({ t: now, pct, c: charging ? 1 : 0 });
  while (h.length && now - h[0].t > 7 * 864e5) h.shift();   // 只保留 7 天
  try { localStorage.setItem(BAT_KEY, JSON.stringify(h)); } catch {}
  drawBatteryChart();
}

function drawBatteryChart() {
  const cv = $("battery-chart");
  if (!cv || !cv.clientWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = 160;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const padL = 34, padR = 12, padT = 12, padB = 20;
  const plotH = h - padT - padB, plotW = w - padL - padR;
  ctx.font = "10px 'Cascadia Code', Consolas, monospace";
  // 网格线 + Y 轴刻度
  for (const p of [0, 25, 50, 75, 100]) {
    const y = padT + plotH * (1 - p / 100);
    ctx.strokeStyle = "rgba(255,255,255,.08)";
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = "#5a6376"; ctx.textAlign = "right";
    ctx.fillText(p + "%", padL - 6, y + 3);
  }
  const hist = loadBatHistory();
  if (hist.length < 2) {
    ctx.fillStyle = "#5a6376"; ctx.textAlign = "center";
    ctx.fillText("历史数据积累中 — 页面打开期间自动记录", w / 2, h / 2);
    $("bat-chart-note").textContent = `已记录 ${hist.length} 个采样点`;
    return;
  }
  const t0 = hist[0].t, t1 = hist[hist.length - 1].t;
  const span = Math.max(t1 - t0, 60000);
  const X = (t) => padL + plotW * ((t - t0) / span);
  const Y = (p) => padT + plotH * (1 - p / 100);
  // 分段渐变填充 + 折线（充电段蓝色 / 放电段绿色）
  ctx.lineWidth = 2; ctx.lineJoin = "round";
  for (let i = 1; i < hist.length; i++) {
    const a = hist[i - 1], b = hist[i];
    const x0 = X(a.t), y0 = Y(a.pct), x1 = X(b.t), y1 = Y(b.pct);
    const col = b.c ? "79,140,255" : "62,207,142";      // 充电蓝 / 放电绿
    const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
    grad.addColorStop(0, `rgba(${col},.30)`);
    grad.addColorStop(1, `rgba(${col},0)`);
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    ctx.lineTo(x1, h - padB); ctx.lineTo(x0, h - padB);
    ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    ctx.strokeStyle = b.c ? "#4f8cff" : "#3ecf8e";
    ctx.stroke();
  }
  // 最新点
  const lp = hist[hist.length - 1];
  ctx.beginPath(); ctx.arc(X(lp.t), Y(lp.pct), 3.5, 0, 7);
  ctx.fillStyle = lp.c ? "#4f8cff" : "#3ecf8e"; ctx.fill();
  // 时间轴标签
  const fmt = (t) => {
    const d = new Date(t);
    const today = new Date();
    const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === today.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };
  ctx.fillStyle = "#5a6376"; ctx.textAlign = "left";
  ctx.fillText(fmt(t0), padL, h - 6);
  ctx.textAlign = "right"; ctx.fillText(fmt(t1), w - padR, h - 6);
  $("bat-chart-note").textContent =
    `${hist.length} 个采样点 · 最低 ${Math.min(...hist.map((p) => p.pct))}% · 绿=放电 蓝=充电`;
}

window.addEventListener("resize", drawBatteryChart);
setInterval(drawBatteryChart, 60000);
drawBatteryChart();

/* ---------- 固件信息 ---------- */
$("btn-fw").onclick = async () => {
  try {
    const r = await query(0x03, 0x18, 0x00);
    const p = r.payload;
    const ascii = Array.from(p).map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    $("st-fw").textContent = `[${Array.from(p.slice(0, 20)).map((x) => hex(x)).join(" ")}] ASCII:"${ascii}"`;
  } catch (e) {
    appendLog("err", "读取固件信息失败：" + e.message);
  }
};

/* ---------- 状态显示 ---------- */
function refreshStatusUI() {
  const d0 = chunks[0x00];
  if (d0) {
    const ri = d0[11];
    $("st-rate").textContent = ri < RATE_HZ.length ? `${RATE_HZ[ri]} Hz` : `未知(${ri})`;
    highlightRateButtons(ri);
  }
  if (chunks[0x00] && chunks[0x18] && chunks[0x30]) {
    const parts = [];
    let enCount = 0;
    for (let s = 0; s < 6; s++) {
      const en = getStageEnabled(s);
      if (en) enCount++;
      parts.push(`${en ? "" : "<s>"}档${s + 1}=${getDpi(s).x}${en ? "" : "</s>"}`);
    }
    $("st-dpi").innerHTML = `${parts.join(" · ")}（启用 ${enCount}/6）`;
  }
  const c30 = chunks[0x30];
  if (c30) {
    $("inp-sleep").value = c30[20];
  }
  refreshSettingsUI();
}


/* ---------- DPI 滑块行（仿官方界面） ---------- */
function buildDpiRows() {
  const box = $("dpi-rows");
  box.innerHTML = "";
  for (let s = 0; s < 6; s++) {
    const { x } = getDpi(s);
    const en = getStageEnabled(s);
    const row = document.createElement("div");
    row.className = "dpi-row" + (en ? "" : " off");
    row.id = `dpi-row-${s}`;
    row.innerHTML =
      `<input type="checkbox" class="dpi-en" id="dpi-en-${s}" ${en ? "checked" : ""} title="启用/禁用该档位">` +
      `<span class="dpi-label">${s + 1}</span>` +
      `<input type="range" id="dpi-r-${s}" min="100" max="26000" step="100" value="${x}">` +
      `<input type="number" id="dpi-v-${s}" min="100" max="26000" step="50" value="${x}">` +
      `<span class="swatch" style="background:${STAGE_COLORS[s]}" title="档位指示灯颜色"></span>`;
    box.appendChild(row);
    const r = $(`dpi-r-${s}`), v = $(`dpi-v-${s}`), c = $(`dpi-en-${s}`);
    r.oninput = () => { v.value = r.value; scheduleDpiSave(); };
    v.onchange = () => {
      const n = parseInt(v.value, 10);
      if (!isNaN(n)) { r.value = Math.min(26000, Math.max(100, n)); scheduleDpiSave(); }
    };
    c.onchange = () => { row.classList.toggle("off", !c.checked); scheduleDpiSave(); };
  }
}

/* 外部改动（官方驱动/设备同步包）时，把最新配置回填到行（不打断正在输入的框） */
function updateDpiRowsFromConfig() {
  const box = $("dpi-rows");
  if (!box || !box.children.length) return;
  for (let s = 0; s < 6; s++) {
    const { x } = getDpi(s);
    const en = getStageEnabled(s);
    const r = $(`dpi-r-${s}`), v = $(`dpi-v-${s}`), c = $(`dpi-en-${s}`), row = $(`dpi-row-${s}`);
    if (!r) continue;
    if (document.activeElement !== v) { v.value = x; r.value = x; }
    c.checked = en;
    row.classList.toggle("off", !en);
  }
}

/* ---------- 无感知自动保存（防抖） ---------- */
let dpiSaveTimer = null;
function scheduleDpiSave() {
  $("dpi-msg").textContent = "待保存…";
  clearTimeout(dpiSaveTimer);
  dpiSaveTimer = setTimeout(autoSaveDpi, 700);
}

async function autoSaveDpi() {
  if (!device) return;
  const msg = $("dpi-msg");
  msg.textContent = "保存中…";
  try {
    await readAllConfig();   // 先取最新，避免覆盖其他字段
    const wanted = [];
    const wantedEn = [];
    for (let s = 0; s < 6; s++) {
      let v = parseInt($(`dpi-v-${s}`).value, 10);
      if (isNaN(v)) throw new Error(`档位 ${s + 1} 数值无效`);
      v = Math.min(26000, Math.max(100, v));
      wanted.push(v);
      wantedEn.push($(`dpi-en-${s}`).checked);
      setDpi(s, v, v);            // 官方 StageXY=0：X/Y 同步写入同一值
      setStageEnabled(s, wantedEn[s]);
    }
    for (const off of [0x00, 0x18, 0x30]) await writeChunk(off);
    await readAllConfig();        // 读回验证
    let ok = true;
    for (let s = 0; s < 6; s++) {
      if (getDpi(s).x !== wanted[s] || getStageEnabled(s) !== wantedEn[s]) ok = false;
    }
    msg.textContent = ok
      ? `已自动保存 ✅ ${new Date().toLocaleTimeString("zh-CN")}`
      : "已写入，但读回值不一致 ⚠️";
    appendLog("note", "DPI/档位启用设置已自动写入");
    refreshStatusUI();
  } catch (e) {
    msg.textContent = "自动保存失败：" + e.message;
    appendLog("err", "DPI 自动保存失败：" + e.message);
  }
}

/* ---------- 回报率（按钮组，点击即写） ---------- */
function buildRateButtons() {
  const box = $("rate-btns");
  box.innerHTML = "";
  RATE_HZ.slice(0, 4).forEach((hz, i) => {
    const b = document.createElement("button");
    b.className = "rate-btn";
    b.textContent = `${hz} Hz`;
    b.onclick = () => writeRate(i);
    box.appendChild(b);
  });
}

function highlightRateButtons(ri) {
  const box = $("rate-btns");
  if (!box) return;
  [...box.children].forEach((b, i) => b.classList.toggle("active", i === ri));
}

async function writeRate(ri) {
  const msg = $("rate-msg");
  try {
    await readAllConfig();
    chunks[0x00][11] = ri;          // 无线回报率
    chunks[0x48][23] = ri;          // 官方驱动会同步镜像到灯光块尾部
    await writeChunk(0x00);
    await writeChunk(0x48);
    await readAllConfig();
    const ok = chunks[0x00][11] === ri;
    msg.textContent = ok ? ` 已设置为 ${RATE_HZ[ri]} Hz ✅` : " 写入后读回不一致 ⚠️";
    appendLog("note", `回报率已写入: ${RATE_HZ[ri]} Hz`);
    refreshStatusUI();
  } catch (e) {
    msg.textContent = " 写入失败：" + e.message;
  }
}

buildRateButtons();

/* ---------- 其他设置（全部字段实机对比逆向确认） ----------
   静默高度 = 0x00[13]（0=1MM, 1=2MM）   直线校准 = 0x00[10]（1=ON）
   移动同步 = 0x48[2]（1=ON）            深度休眠 = 0x48[21]（1=ON）
   休眠设置 = 0x30[22..23]（秒, LE）     按键延时 = 0x48[0]（毫秒数-1） */
const SET_GROUPS = ["lod-btns", "linear-btns", "sync-btns", "dsleep-btns"];

function getGroupValue(boxId) {
  const b = $(boxId).querySelector("button.active");
  return b ? parseInt(b.dataset.v, 10) : 0;
}
function setGroupValue(boxId, v) {
  [...$(boxId).querySelectorAll("button")].forEach((b) =>
    b.classList.toggle("active", parseInt(b.dataset.v, 10) === v)
  );
}
/* 选中下拉值；设备里是列表外的自定义值时动态加一项显示 */
function setSelectValue(sel, value, customLabel) {
  [...sel.options].filter((o) => o.dataset.custom).forEach((o) => o.remove());
  if (![...sel.options].some((o) => o.value === String(value))) {
    const opt = new Option(customLabel, String(value));
    opt.dataset.custom = "1";
    sel.add(opt);
  }
  sel.value = String(value);
}

function refreshSettingsUI() {
  const c00 = chunks[0x00], c30 = chunks[0x30], c48 = chunks[0x48];
  if (!c00 || !c30 || !c48) return;
  setGroupValue("lod-btns", c00[13] === 1 ? 1 : 0);
  setGroupValue("linear-btns", c00[10] === 1 ? 1 : 0);
  setGroupValue("sync-btns", c48[2] === 1 ? 1 : 0);
  setGroupValue("dsleep-btns", c48[21] === 1 ? 1 : 0);
  const sec = c30[22] | (c30[23] << 8);
  setSelectValue($("sel-sleep"), sec, `${sec}秒(自定义)`);
  const ms = c48[0] + 1;
  setSelectValue($("sel-keydelay"), ms, `${ms}ms(自定义)`);
}

let setSaveTimer = null;
function scheduleSettingsSave() {
  $("set-msg").textContent = "待保存…";
  clearTimeout(setSaveTimer);
  setSaveTimer = setTimeout(autoSaveSettings, 700);
}

async function autoSaveSettings() {
  if (!device) return;
  const msg = $("set-msg");
  const w = {
    lod: getGroupValue("lod-btns"),
    linear: getGroupValue("linear-btns"),
    sync: getGroupValue("sync-btns"),
    dsleep: getGroupValue("dsleep-btns"),
    sleepSec: Math.max(0, parseInt($("sel-sleep").value, 10) || 0),
    keydelay: Math.max(1, parseInt($("sel-keydelay").value, 10) || 2),
  };
  msg.textContent = "保存中…";
  try {
    await readAllConfig();   // 先取最新，避免覆盖 DPI 等其他字段
    chunks[0x00][13] = w.lod;
    chunks[0x00][10] = w.linear;
    chunks[0x48][2] = w.sync;
    chunks[0x48][21] = w.dsleep;
    chunks[0x30][22] = w.sleepSec & 0xff;
    chunks[0x30][23] = (w.sleepSec >> 8) & 0xff;
    chunks[0x48][0] = (w.keydelay - 1) & 0xff;
    for (const off of [0x00, 0x30, 0x48]) await writeChunk(off);
    await readAllConfig();   // 读回验证
    const ok =
      chunks[0x00][13] === w.lod &&
      chunks[0x00][10] === w.linear &&
      chunks[0x48][2] === w.sync &&
      chunks[0x48][21] === w.dsleep &&
      (chunks[0x30][22] | (chunks[0x30][23] << 8)) === w.sleepSec &&
      chunks[0x48][0] === ((w.keydelay - 1) & 0xff);
    msg.textContent = ok
      ? `已自动保存 ✅ ${new Date().toLocaleTimeString("zh-CN")}`
      : "已写入，但读回值不一致 ⚠️";
    appendLog("note", "其他设置已自动写入");
    refreshStatusUI();
  } catch (e) {
    msg.textContent = "自动保存失败：" + e.message;
    appendLog("err", "其他设置自动保存失败：" + e.message);
  }
}

SET_GROUPS.forEach((id) => {
  [...$(id).querySelectorAll("button")].forEach((b) => {
    b.onclick = () => {
      setGroupValue(id, parseInt(b.dataset.v, 10));
      scheduleSettingsSave();
    };
  });
});
$("sel-sleep").onchange = scheduleSettingsSave;
$("sel-keydelay").onchange = scheduleSettingsSave;

/* ---------- 休眠 ---------- */
$("btn-write-sleep").onclick = async () => {
  const msg = $("sleep-msg");
  try {
    const s = Math.max(0, Math.min(3600, parseInt($("inp-sleep").value, 10) || 0));
    await readAllConfig();
    chunks[0x30][20] = s;
    await writeChunk(0x30);
    await readAllConfig();
    msg.textContent = chunks[0x30][20] === s ? "写入成功 ✅" : "读回不一致 ⚠️";
  } catch (e) {
    msg.textContent = "写入失败：" + e.message;
  }
};


/* ---------- 协议命令台 ---------- */
function parseHexInput(s) {
  const clean = s.replace(/0x/gi, " ").replace(/[,;]/g, " ").trim();
  if (!clean) return new Uint8Array(0);
  return new Uint8Array(clean.split(/\s+/).map((t) => parseInt(t, 16)));
}

$("btn-send-cmd").onclick = async () => {
  if (!device) return;
  const b = parseHexInput($("tx-cmd").value);
  if (!b.length) return;
  try {
    const r = await query(b[0], b[1] || 0, b[2] || 0, b.slice(3));
    if (r) appendLog("note", `响应: cmd=0x${hex(r.cmd)} payload=[${Array.from(r.payload).map((x) => hex(x)).join(" ")}]`);
    else appendLog("note", "已发送（写命令，无回包）");
  } catch (e) {
    appendLog("err", "命令失败/无响应：" + e.message);
  }
};

$("btn-send-output").onclick = async () => {
  if (!device) return;
  const id = parseInt($("tx-id").value) || 0;
  const bytes = parseHexInput($("tx-data").value);
  try {
    await device.sendReport(id, bytes);
    appendLog("tx", `TX raw id=0x${hex(id)} [${Array.from(bytes).map((x) => hex(x)).join(" ")}]`);
  } catch (err) {
    appendLog("err", `TX 失败: ${err.message}`);
  }
};

/* ---------- 集合信息 ---------- */
function renderCollections() {
  const box = $("collections");
  box.innerHTML = "";
  device.collections.forEach((c, i) => {
    const div = document.createElement("div");
    div.className = "coll";
    div.innerHTML =
      `<b>集合 #${i}</b> usagePage=0x${hex(c.usagePage, 4)} usage=0x${hex(c.usage)} ` +
      `${c.usagePage === USAGE_PAGE ? '<span class="badge green">配置通道</span>' : ""}<br>` +
      `&nbsp;输入报告: ${c.inputReports.map((r) => "id=0x" + hex(r.reportId)).join(", ") || "无"} ` +
      `输出报告: ${c.outputReports.map((r) => "id=0x" + hex(r.reportId)).join(", ") || "无"}`;
    box.appendChild(div);
  });
}

/* ---------- 日志管理 ---------- */
$("btn-clear-log").onclick = () => {
  $("report-log").innerHTML = "";
  logLines.length = 0;
};

$("btn-export-log").onclick = () => {
  const blob = new Blob([logLines.join("\n")], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `m800ultra-hidlog-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
};

