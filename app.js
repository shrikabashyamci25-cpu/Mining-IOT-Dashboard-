// =====================================================================
//  Mining Safety Monitor – reads live data from Blynk IoT (server BLR1)
// =====================================================================

// ---------------------------------------------------------------------
// 1) PASTE YOUR BLYNK AUTH TOKEN BETWEEN THE QUOTES BELOW, then save.
// ---------------------------------------------------------------------
const BLYNK_TOKEN = "osl-1hthYAE553II20Pn_2cFlCpT0E87";

const BLYNK_SERVER = "https://blr1.blynk.cloud/external/api";
const POLL_MS = 2000;            // ask Blynk for new values every 2 s
const WORKER = "W01";

// Datastream pins (must match the Blynk template)
const PIN = {
  status: "V0", hr: "V1", spo2: "V2", temp: "V3", hum: "V4",
  fall: "V5", sos: "V6", zone: "V9", help: "V10", lora: "V11",
};

const DEMO = !BLYNK_TOKEN || BLYNK_TOKEN.startsWith("PASTE_");

// ---------- small helpers ----------
const $ = (id) => document.getElementById(id);
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const clock = (d = new Date()) => d.toLocaleTimeString("en-GB", { hour12: false });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);

// Demo data is stored separately so it never mixes with real alerts
const STORE = DEMO ? "msm_demo_" : "msm_";
function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(STORE + key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* storage blocked – ignore */ }
}

// =====================================================================
// 2) Talking to Blynk
// =====================================================================
async function readBlynk() {
  const pins = Object.values(PIN).join("&");
  const res = await fetch(`${BLYNK_SERVER}/get?token=${encodeURIComponent(BLYNK_TOKEN)}&${pins}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Blynk replied ${res.status}`);
  return res.json();   // e.g. { "V0": "W01 (online)", "V1": 82, ... }
}

async function writeBlynk(values) {
  const query = Object.entries(values).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const res = await fetch(`${BLYNK_SERVER}/batch/update?token=${encodeURIComponent(BLYNK_TOKEN)}&${query}`);
  if (!res.ok) throw new Error(`Blynk replied ${res.status}`);
}

// =====================================================================
// 3) Demo data (used only while no token is set)
// =====================================================================
const demo = { t0: Date.now(), sos: 0, fall: 0, dispatched: false };
function demoData() {
  const s = (Date.now() - demo.t0) / 1000;
  if (!demo.dispatched && s > 15 && s < 17) { demo.sos = 1; demo.fall = 1; }   // fake alerts after 15 s
  const zone = ["Zone A (near base)", "Zone B (mid tunnel)", "Zone C (far / deep)"][Math.floor(s / 30) % 3];
  const rssi = { A: -62, B: -68, C: -95 }[zone[5]] + Math.round(Math.random() * 4 - 2);
  return {
    V0: demo.sos ? "W01 - ALERT!" : "W01 (online)",
    V1: Math.round(72 + 6 * Math.sin(s / 15) + Math.random() * 3 + (demo.sos ? 25 : 0)),
    V2: Math.round(97 + Math.random() * 2),
    V3: +(36.6 + 0.4 * Math.sin(s / 40) + Math.random() * 0.2).toFixed(1),
    V4: Math.round(42 + Math.random() * 4),
    V5: demo.fall, V6: demo.sos, V9: zone, V10: 0, V11: rssi,
  };
}

// =====================================================================
// 4) Updating the page
// =====================================================================
const ARC = 188.5; // length of the 270° gauge arc (r = 40)

// Colour rules for each vital: returns "ok" | "warn" | "danger"
const RULES = {
  hr:   { max: 200, level: (v) => (v >= 60 && v <= 100 ? "ok" : v >= 50 && v <= 120 ? "warn" : "danger"),
          text: (l, v) => ({ ok: "Normal", warn: "Check", danger: v < 50 ? "Too low" : "Too high" })[l] },
  spo2: { max: 100, level: (v) => (v >= 95 ? "ok" : v >= 90 ? "warn" : "danger"),
          text: (l) => ({ ok: "Normal", warn: "Low", danger: "Critical" })[l] },
  temp: { max: 60,  level: (v) => (v < 38 ? "ok" : v <= 40 ? "warn" : "danger"),
          text: (l) => ({ ok: "Normal", warn: "High", danger: "Danger" })[l] },
  hum:  { max: 100, level: (v) => (v >= 30 && v <= 70 ? "ok" : v <= 85 ? "warn" : "danger"),
          text: (l) => ({ ok: "Normal", warn: "Check", danger: "Very humid" })[l] },
};

function setGauge(key, value, decimals = 0) {
  const card = $(`card-${key}`);
  const rule = RULES[key];
  const fill = card.querySelector(".arc-fill");
  card.classList.remove("warn", "danger");

  if (value === null || value === 0) {           // 0 means "no reading" from the sensor
    $(`${key}Val`).textContent = "--";
    $(`${key}Pill`).textContent = value === 0 ? "No reading" : "Waiting";
    fill.style.strokeDasharray = `0 251.33`;
    updateVital(key, null, null, value === 0 ? "No reading" : "Waiting", decimals);
    return;
  }
  const level = rule.level(value);
  if (level !== "ok") card.classList.add(level);
  $(`${key}Val`).textContent = value.toFixed(decimals);
  $(`${key}Pill`).textContent = rule.text(level, value);
  fill.style.strokeDasharray = `${ARC * Math.min(value / rule.max, 1)} 251.33`;
  updateVital(key, value, level, rule.text(level, value), decimals);
}

// ---------- Vital Signs page: one big card per reading ----------
// bands = [from, to, level] – drawn as the coloured scale under the number
const VITALS = [
  { key: "hr",   name: "Heart Rate",  unit: "bpm", icon: "heart-pulse", normal: "60 – 100 bpm",
    bands: [[0, 50, "danger"], [50, 60, "warn"], [60, 100, "ok"], [100, 120, "warn"], [120, 200, "danger"]] },
  { key: "spo2", name: "SpO₂",        unit: "%",   icon: "wind",        normal: "≥ 95 %",
    bands: [[0, 90, "danger"], [90, 95, "warn"], [95, 100, "ok"]] },
  { key: "temp", name: "Temperature", unit: "°C",  icon: "thermometer", normal: "below 38 °C",
    bands: [[0, 38, "ok"], [38, 40, "warn"], [40, 60, "danger"]] },
  { key: "hum",  name: "Humidity",    unit: "%",   icon: "droplet",     normal: "30 – 70 %",
    bands: [[0, 30, "warn"], [30, 70, "ok"], [70, 85, "warn"], [85, 100, "danger"]] },
];
const BAND_COLOUR = { ok: "var(--green)", warn: "var(--amber)", danger: "var(--red)" };

function buildVitalsPage() {
  $("vitalsGrid").innerHTML = VITALS.map((v) => {
    const max = RULES[v.key].max;
    const stops = v.bands.map(([a, b, l]) =>
      `${BAND_COLOUR[l]} ${(a / max) * 100}% ${(b / max) * 100}%`).join(", ");
    return `<article class="glass vital" id="vital-${v.key}">
      <header><i data-lucide="${v.icon}"></i><span>${v.name}</span><span class="state-pill" id="v-${v.key}-pill">Waiting</span></header>
      <div class="vital-num"><strong id="v-${v.key}-val">--</strong><small>${v.unit}</small></div>
      <div class="scale" style="background: linear-gradient(90deg, ${stops})"><i class="marker" id="v-${v.key}-mark" hidden></i></div>
      <div class="scale-ends"><span>0</span><span>Normal: ${v.normal}</span><span>${max}</span></div>
      <dl class="vital-stats">
        <div><dt>Min (1 h)</dt><dd id="v-${v.key}-min">--</dd></div>
        <div><dt>Avg (1 h)</dt><dd id="v-${v.key}-avg">--</dd></div>
        <div><dt>Max (1 h)</dt><dd id="v-${v.key}-max">--</dd></div>
      </dl>
    </article>`;
  }).join("");
}

function updateVital(key, value, level, text, decimals) {
  const card = $(`vital-${key}`);
  if (!card) return;
  card.classList.remove("warn", "danger");
  if (level && level !== "ok") card.classList.add(level);
  $(`v-${key}-val`).textContent = value === null ? "--" : value.toFixed(decimals);
  $(`v-${key}-pill`).textContent = text;
  const mark = $(`v-${key}-mark`);
  mark.hidden = value === null;
  if (value !== null) mark.style.left = `${Math.min(value / RULES[key].max, 1) * 100}%`;

  // min / avg / max over the last hour (from the chart points)
  const vals = points.map((p) => p[key]).filter((n) => n !== null && n !== undefined);
  const fmt = (n) => (vals.length ? n.toFixed(decimals) : "--");
  $(`v-${key}-min`).textContent = fmt(Math.min(...vals));
  $(`v-${key}-avg`).textContent = fmt(vals.reduce((a, b) => a + b, 0) / vals.length);
  $(`v-${key}-max`).textContent = fmt(Math.max(...vals));
}

function zoneLetter(text) {
  const m = /zone\s*([abc])/i.exec(text || "");
  return m ? m[1].toUpperCase() : null;
}

function setStatusPill(kind, text) {
  $("statusPill").className = `pill-status ${kind}`;
  $("statusText").textContent = text;
}

// LoRa signal: 5 bars, colour class on the parent
function signalLevel(rssi) {
  if (rssi === null) return { bars: 0, cls: "poor" };
  const bars = rssi > -60 ? 5 : rssi > -70 ? 4 : rssi > -80 ? 3 : rssi > -90 ? 2 : 1;
  return { bars, cls: bars >= 3 ? "" : bars === 2 ? "weak" : "poor" };
}
function setSignal(rssi) {
  const { bars, cls } = signalLevel(rssi);
  document.querySelectorAll("[data-bars]").forEach((el) => {
    [...el.children].forEach((b, i) => b.classList.toggle("on", i < bars));
    const holder = el.parentElement;
    holder.classList.remove("weak", "poor");
    if (cls) holder.classList.add(cls);
  });
  const txt = rssi === null ? "--" : `${rssi} dBm`;
  $("loraValLoc").textContent = txt;
  $("qiSignal").textContent = txt;
  $("locRssi").textContent = rssi === null ? "--" : rssi;
  $("locQuality").textContent = rssi === null ? "No signal reading"
    : ["", "Poor – link may drop", "Weak", "Fair", "Good", "Excellent"][bars] + " signal";
}

let lastZoneName = "--";
let lastUpdate = 0;

function render(d) {
  const hr = num(d[PIN.hr]), spo2 = num(d[PIN.spo2]), temp = num(d[PIN.temp]), hum = num(d[PIN.hum]);
  const sos = num(d[PIN.sos]) === 1, fall = num(d[PIN.fall]) === 1;
  const rssi = num(d[PIN.lora]);
  const status = String(d[PIN.status] ?? "");
  const zone = zoneLetter(String(d[PIN.zone] ?? ""));
  const zoneName = zone ? `Zone ${zone}` : "Unknown zone";
  const alert = sos || fall;
  const noSignal = /no signal/i.test(status);

  // Header
  lastUpdate = Date.now();
  $("lastUpdated").textContent = clock();
  $("agoText").textContent = "(0s ago)";
  $("qiUpdated").textContent = clock();
  $("wifiIcon").className = "hicon ok";
  if (alert) setStatusPill("alert", sos ? "SOS Alert" : "Fall Alert");
  else if (noSignal) setStatusPill("nosignal", "No signal");
  else setStatusPill("online", DEMO ? "Online (demo)" : "Online");

  // Chart points first, so the 1-hour min/avg/max include this reading
  addPoint(hr, temp, spo2, hum);

  // Gauges
  setGauge("hr", hr);
  setGauge("spo2", spo2);
  setGauge("temp", temp, 1);
  setGauge("hum", hum);

  // Banners
  $("sosBanner").classList.toggle("active", sos);
  $("sosTitle").textContent = sos ? `SOS from ${WORKER} – ${zoneName}` : "No SOS";
  $("sosSub").textContent = sos ? "Emergency button pressed. Dispatch help now." : "All clear";
  $("fallBanner").classList.toggle("active", fall);
  $("fallTitle").textContent = fall ? `Fall detected – ${zoneName}` : "No fall detected";
  $("fallSub").textContent = fall ? `${WORKER} may be injured. Check immediately.` : "All clear";

  // Status tiles
  $("tileSos").classList.toggle("on", sos);
  $("sosPill").textContent = sos ? "ON" : "OFF";
  $("tileFall").classList.toggle("on", fall);
  $("fallPill").textContent = fall ? "ON" : "OFF";
  document.querySelectorAll(".js-help").forEach((b) => b.classList.toggle("urgent", alert));

  // Location strip (overview + location page), tunnel view, quick info
  document.querySelectorAll(".zone-sec, .zone-info > div, .zb").forEach((z) => z.classList.toggle("active", z.dataset.zone === zone));
  document.querySelector(".zone-bar").classList.toggle("alert", alert);
  $("ovZone").textContent = zone ? zoneName : "Unknown";
  $("ovZoneDesc").textContent = zone ? { A: "Near base", B: "Mid tunnel", C: "Deep – furthest from help" }[zone] : "Zone not reported";
  document.querySelectorAll(".tunnel-strip").forEach((s) => s.classList.toggle("alert", alert));
  document.querySelectorAll(".avatar").forEach((a) => {
    a.hidden = !zone;
    if (zone) a.style.left = { A: "16.66%", B: "50%", C: "83.33%" }[zone];
  });
  $("qiZone").textContent = zone ? zoneName : "--";
  $("qiStatus").textContent = status || "--";
  $("locZone").textContent = zone ? zoneName : "--";
  $("sideZone").textContent = zone ? zoneName : "Zone --";
  $("sideWorker").className = `side-worker ${alert ? "alert" : noSignal ? "nosignal" : "online"}`;
  $("navAlertDot").hidden = !alert;
  lastZoneName = zoneName;
  setSignal(rssi);
  trackZone(zone, rssi);
  renderPins(d);

  // Alert history
  trackAlerts(sos, fall, zoneName);
}

// ---------- Location page: log every zone change ----------
let zoneLog = load("zones", []);
function trackZone(zone, rssi) {
  if (!zone) return;
  const last = zoneLog[0];
  if (!last || last.to !== zone) {
    zoneLog.unshift({ time: Date.now(), from: last ? last.to : null, to: zone, rssi });
    zoneLog = zoneLog.slice(0, 100);
    save("zones", zoneLog);
    renderZoneLog();
  }
}
function renderZoneLog() {
  $("locSince").textContent = zoneLog.length ? clock(new Date(zoneLog[0].time)) : "--";
  $("zoneBody").innerHTML = zoneLog.length
    ? zoneLog.map((z) => `<tr>
        <td>${clock(new Date(z.time))}</td>
        <td>${z.from ? `Zone ${z.from}` : "—"}</td>
        <td><strong>Zone ${z.to}</strong></td>
        <td>${z.rssi ?? "--"} dBm</td>
      </tr>`).join("")
    : '<tr class="empty"><td colspan="4">No movement recorded yet</td></tr>';
}

// ---------- Device page: raw Blynk datastreams ----------
const PIN_INFO = {
  status: "Device message", hr: "Heart rate (bpm)", spo2: "SpO₂ (%)", temp: "Temperature (°C)",
  hum: "Humidity (%)", fall: "Fall detected (0/1)", sos: "SOS pressed (0/1)", zone: "Zone (from LoRa)",
  help: "Help dispatched (0/1)", lora: "LoRa RSSI (dBm)",
};
function renderPins(d) {
  $("pinBody").innerHTML = Object.entries(PIN).map(([k, pin]) =>
    `<tr><td><code>${pin}</code></td><td>${PIN_INFO[k]}</td><td>${esc(d[pin] ?? "--")}</td></tr>`).join("");
}

// "2s ago" counter in the header
setInterval(() => {
  if (lastUpdate) $("agoText").textContent = `(${Math.round((Date.now() - lastUpdate) / 1000)}s ago)`;
}, 1000);

// =====================================================================
// 5) Alert history (saved in this browser with localStorage)
// =====================================================================
let alertLog = load("history", []);
let prev = { sos: false, fall: false };
let alertFilter = "all";

function trackAlerts(sos, fall, zoneName) {
  for (const type of ["sos", "fall"]) {
    const now = type === "sos" ? sos : fall;
    const alreadyOpen = alertLog.some((h) => h.type === type && !h.resolved);
    if (now && !prev[type] && !alreadyOpen) {
      alertLog.unshift({ time: Date.now(), type, zone: zoneName, resolved: false });
      alertLog = alertLog.slice(0, 200);
      save("history", alertLog);
      renderHistory();
    }
    prev[type] = now;
  }
}

function resolveAlerts() {
  const t = Date.now();
  alertLog.forEach((h) => { if (!h.resolved) { h.resolved = true; h.resolvedAt = t; } });
  save("history", alertLog);
  renderHistory();
}

const typeCell = (h) => `<td class="t-${h.type}">${h.type === "sos" ? "SOS" : "Fall"}</td>`;
const resolvedCell = (h) => `<td class="${h.resolved ? "r-yes" : "r-no"}">${h.resolved ? "Yes" : "No"}</td>`;
const day = (t) => new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

function renderHistory() {
  // Overview card: latest 5
  const recent = alertLog.slice(0, 5);
  $("historyBody").innerHTML = recent.length
    ? recent.map((h) => `<tr><td>${clock(new Date(h.time))}</td>${typeCell(h)}<td>${esc(h.zone)}</td>${resolvedCell(h)}</tr>`).join("")
    : '<tr class="empty"><td colspan="4">No alerts yet</td></tr>';

  // Alert History page: everything, filtered
  const rows = alertLog.filter((h) =>
    alertFilter === "all" ? true : alertFilter === "open" ? !h.resolved : h.type === alertFilter);
  $("alertsBody").innerHTML = rows.length
    ? rows.map((h) => `<tr class="${h.resolved ? "" : "open"}">
        <td>${day(h.time)}</td><td>${clock(new Date(h.time))}</td>${typeCell(h)}<td>${esc(h.zone)}</td>${resolvedCell(h)}
        <td>${h.resolvedAt ? clock(new Date(h.resolvedAt)) : "—"}</td>
      </tr>`).join("")
    : `<tr class="empty"><td colspan="6">${alertLog.length ? "No alerts match this filter" : "No alerts yet"}</td></tr>`;

  // Counters + sidebar badge
  const open = alertLog.filter((h) => !h.resolved).length;
  $("stTotal").textContent = alertLog.length;
  $("stSos").textContent = alertLog.filter((h) => h.type === "sos").length;
  $("stFall").textContent = alertLog.filter((h) => h.type === "fall").length;
  $("stOpen").textContent = open;
  $("navBadge").textContent = open;
  $("navBadge").hidden = open === 0;
}

document.querySelectorAll("[data-filter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("active", b === btn));
    alertFilter = btn.dataset.filter;
    renderHistory();
  });
});

$("exportCsv").addEventListener("click", () => {
  const lines = [["Date", "Time", "Worker", "Type", "Zone", "Resolved", "Resolved at"]].concat(
    alertLog.map((h) => [day(h.time), clock(new Date(h.time)), WORKER, h.type === "sos" ? "SOS" : "Fall", h.zone,
      h.resolved ? "Yes" : "No", h.resolvedAt ? clock(new Date(h.resolvedAt)) : ""]));
  const csv = lines.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `alerts-${WORKER}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// =====================================================================
// 6) Live chart (heart rate + temperature, last 15 min or 1 hour)
// =====================================================================
let points = load("points", []).filter((p) => Date.now() - p.t < 3600e3);
let rangeMin = 15;
let lastSaved = 0;

// Draws the small coloured value tag at the end of each line
const lastValueTags = {
  id: "lastValueTags",
  afterDatasetsDraw(c) {
    const { ctx } = c;
    c.data.datasets.forEach((ds, i) => {
      let j = ds.data.length - 1;
      while (j >= 0 && ds.data[j].y === null) j--;
      if (j < 0) return;
      const pt = c.getDatasetMeta(i).data[j];
      const label = ds.data[j].y.toFixed(ds.decimals ?? (i === 1 ? 1 : 0));
      ctx.save();
      ctx.font = "700 11px Inter, sans-serif";
      const w = ctx.measureText(label).width + 10;
      const x = pt.x + 6, y = pt.y - 9;
      ctx.fillStyle = ds.borderColor;
      ctx.beginPath(); ctx.roundRect(x, y, w, 18, 4); ctx.fill();
      ctx.fillStyle = "#0b0f16";
      ctx.fillText(label, x + 5, y + 13);
      ctx.restore();
    });
  },
};

const chart = window.Chart ? new Chart($("vitalsChart"), {
  type: "line",
  plugins: [lastValueTags],
  data: { datasets: [
    { label: "Heart Rate (bpm)", yAxisID: "yHr", borderColor: "#22c55e", backgroundColor: "rgba(34,197,94,.08)", fill: true, data: [] },
    { label: "Temperature (°C)", yAxisID: "yTemp", borderColor: "#f5a524", backgroundColor: "transparent", data: [] },
  ]},
  options: {
    animation: false, maintainAspectRatio: false, parsing: false, spanGaps: true,
    layout: { padding: { right: 44 } },
    elements: { point: { radius: 0, hoverRadius: 4 }, line: { tension: 0.35, borderWidth: 2 } },
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false } },
    scales: {
      x: { type: "linear", ticks: { color: "#8d97a8", maxTicksLimit: 7,
            callback: (v) => new Date(v).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) },
           grid: { color: "rgba(255,255,255,.06)" } },
      yHr:   { position: "left",  min: 40, max: 160, ticks: { color: "#8d97a8", stepSize: 20 }, grid: { color: "rgba(255,255,255,.06)" } },
      yTemp: { position: "right", suggestedMin: 32, suggestedMax: 40, ticks: { color: "#8d97a8" }, grid: { display: false } },
    },
  },
}) : null;

// Shades the normal range behind a line (Live Charts page)
const normalBand = {
  id: "normalBand",
  beforeDatasetsDraw(c, _args, opts) {
    if (!opts || opts.from === undefined) return;
    const { ctx, chartArea: a, scales } = c;
    const y = scales.y;
    const top = y.getPixelForValue(opts.to), bottom = y.getPixelForValue(opts.from);
    ctx.save();
    ctx.fillStyle = opts.color;
    ctx.fillRect(a.left, Math.max(top, a.top), a.right - a.left, Math.min(bottom, a.bottom) - Math.max(top, a.top));
    ctx.restore();
  },
};

// Big single-reading charts on the Live Charts page
function singleChart(canvasId, label, colour, fillColour, y, band) {
  if (!window.Chart) return null;
  return new Chart($(canvasId), {
    type: "line",
    plugins: [lastValueTags, normalBand],
    data: { datasets: [{ label, borderColor: colour, backgroundColor: fillColour, fill: true, decimals: /Temp/.test(label) ? 1 : 0, data: [] }] },
    options: {
      animation: false, maintainAspectRatio: false, parsing: false, spanGaps: true,
      layout: { padding: { right: 44 } },
      elements: { point: { radius: 0, hoverRadius: 4 }, line: { tension: 0.35, borderWidth: 2 } },
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, normalBand: band },
      scales: {
        x: { type: "linear", ticks: { color: "#8d97a8", maxTicksLimit: 8,
              callback: (v) => new Date(v).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) },
             grid: { color: "rgba(255,255,255,.06)" } },
        y: { ...y, ticks: { color: "#8d97a8" }, grid: { color: "rgba(255,255,255,.06)" } },
      },
    },
  });
}
const hrChart = singleChart("hrChart", "Heart Rate (bpm)", "#22c55e", "rgba(34,197,94,.08)",
  { min: 40, max: 160 }, { from: 60, to: 100, color: "rgba(34,197,94,.10)" });
const tempChart = singleChart("tempChart", "Temperature (°C)", "#f5a524", "rgba(245,165,36,.08)",
  { suggestedMin: 30, suggestedMax: 42 }, { from: 0, to: 38, color: "rgba(34,197,94,.08)" });

function addPoint(hr, temp, spo2, hum) {
  const t = Date.now();
  points.push({ t, hr: hr || null, temp: temp || null, spo2: spo2 || null, hum: hum || null });
  points = points.filter((p) => t - p.t < 3600e3);
  if (t - lastSaved > 10000) { save("points", points); lastSaved = t; }  // save every 10 s
  drawChart();
}

function setSeries(c, from, series) {
  if (!c) return;
  series.forEach((data, i) => { c.data.datasets[i].data = data; });
  c.options.scales.x.min = from;
  c.options.scales.x.max = Date.now();
  c.update("none");
}

function chartStats(el, vals, decimals, unit) {
  const ok = vals.filter((v) => v !== null);
  const f = (n) => (ok.length ? `${n.toFixed(decimals)} ${unit}` : "--");
  el.innerHTML = [["Now", ok[ok.length - 1]], ["Min", Math.min(...ok)],
    ["Avg", ok.reduce((a, b) => a + b, 0) / ok.length], ["Max", Math.max(...ok)]]
    .map(([k, v]) => `<div><span>${k}</span><strong>${f(v)}</strong></div>`).join("");
}

function drawChart() {
  const from = Date.now() - rangeMin * 60e3;
  const visible = points.filter((p) => p.t >= from);
  const hrData = visible.map((p) => ({ x: p.t, y: p.hr }));
  const tempData = visible.map((p) => ({ x: p.t, y: p.temp }));
  setSeries(chart, from, [hrData, tempData]);
  if (currentPage === "charts") {           // only redraw the big charts while they're on screen
    setSeries(hrChart, from, [hrData]);
    setSeries(tempChart, from, [tempData]);
    chartStats($("hrStats"), visible.map((p) => p.hr), 0, "bpm");
    chartStats($("tempStats"), visible.map((p) => p.temp), 1, "°C");
  }
}

// 15 min / 1 hour toggles (overview + charts page stay in sync)
document.querySelectorAll("[data-range]").forEach((btn) => {
  btn.addEventListener("click", () => {
    rangeMin = Number(btn.dataset.range);
    document.querySelectorAll("[data-range]").forEach((b) => b.classList.toggle("active", Number(b.dataset.range) === rangeMin));
    $("chartRangeText").textContent = rangeMin === 15 ? "(Last 15 minutes)" : "(Last 1 hour)";
    drawChart();
  });
});

// =====================================================================
// 7) "Help dispatched" button
// =====================================================================
let toastTimer;
function showHelpToast(title, sub, isError = false) {
  const el = $("helpToast");
  $("helpToastText").textContent = title;
  el.querySelector("div span").textContent = sub;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 15000);
}
$("helpToastClose").addEventListener("click", () => { $("helpToast").hidden = true; });

async function dispatchHelp() {
  const btns = document.querySelectorAll(".js-help");
  btns.forEach((b) => { b.disabled = true; });
  try {
    if (DEMO) {
      demo.sos = 0; demo.fall = 0; demo.dispatched = true;
    } else {
      // V10=1 tells the base station; we also clear the alert pins so the page updates straight away
      await writeBlynk({ [PIN.help]: 1, [PIN.sos]: 0, [PIN.fall]: 0, [PIN.status]: `${WORKER} - help on the way` });
      setTimeout(() => writeBlynk({ [PIN.help]: 0 }).catch(() => {}), 3000);   // reset switch like a button
    }
    resolveAlerts();
    showHelpToast(`Help has been dispatched to ${WORKER} – ${lastZoneName}`, "Team is on the way.");
  } catch (err) {
    showHelpToast("Could not reach Blynk", err.message, true);
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}
document.querySelectorAll(".js-help").forEach((b) => b.addEventListener("click", dispatchHelp));

// =====================================================================
// 8) Pages + sidebar (hash links: #overview, #vitals, #location, ...)
// =====================================================================
const PAGES = ["overview", "vitals", "location", "charts", "alerts", "device"];
let currentPage = "overview";

function showPage() {
  const id = location.hash.slice(1);
  currentPage = PAGES.includes(id) ? id : "overview";
  document.querySelectorAll(".page").forEach((p) => { p.hidden = p.dataset.page !== currentPage; });
  document.querySelectorAll("[data-nav]").forEach((a) => {
    const on = a.dataset.nav === currentPage;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  const label = document.querySelector(`[data-nav="${currentPage}"] span`).textContent;
  document.title = currentPage === "overview" ? "Mining Safety Monitor" : `${label} · Mining Safety Monitor`;
  setMenu(false);
  drawChart();
  [chart, hrChart, tempChart].forEach((c) => c && c.resize());
}
window.addEventListener("hashchange", () => { showPage(); window.scrollTo(0, 0); });

// Emergency banners jump to the SOS/Fall tiles + Help button on the overview
document.querySelectorAll("[data-jump]").forEach((a) => a.addEventListener("click", (e) => {
  e.preventDefault();
  if (location.hash !== "#overview") { history.pushState(null, "", "#overview"); showPage(); }
  $(a.dataset.jump).scrollIntoView({ behavior: "smooth", block: "center" });
}));

// Phone / tablet: sidebar slides in from the left
function setMenu(open) {
  document.body.classList.toggle("menu-open", open);
  $("scrim").hidden = !open;
  $("menuBtn").setAttribute("aria-expanded", String(open));
}
$("menuBtn").addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open")));
$("scrim").addEventListener("click", () => setMenu(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });

// Device page: stored-data buttons
$("clearHistory").addEventListener("click", () => {
  if (!confirm("Delete the whole alert history saved in this browser?")) return;
  alertLog = []; save("history", alertLog); renderHistory();
});
$("clearChart").addEventListener("click", () => {
  if (!confirm("Delete the saved chart data and zone movements?")) return;
  points = []; zoneLog = []; save("points", points); save("zones", zoneLog);
  drawChart(); renderZoneLog();
});

// =====================================================================
// 9) Main loop – poll Blynk every 2 s
// =====================================================================
const stats = { ok: 0, fail: 0 };
async function poll() {
  try {
    const data = DEMO ? demoData() : await readBlynk();
    render(data);
    stats.ok++;
    $("devLast").textContent = clock();
  } catch (err) {
    console.warn("Blynk read failed:", err.message);
    stats.fail++;
    setStatusPill("offline", "Offline");
    $("wifiIcon").className = "hicon bad";
    $("sideWorker").className = "side-worker offline";
  }
  $("devOk").textContent = stats.ok;
  $("devFail").textContent = stats.fail;
  $("flow").classList.toggle("live", $("sideWorker").className !== "side-worker offline");
  setTimeout(poll, POLL_MS);
}

buildVitalsPage();
if (window.lucide) lucide.createIcons();
$("setupNote").hidden = !DEMO;
$("devMode").textContent = DEMO ? "Demo (made-up data)" : "Live – Blynk";
$("devToken").textContent = DEMO ? "not set" : `••••••${BLYNK_TOKEN.slice(-4)}`;
renderHistory();
renderZoneLog();
showPage();
poll();
