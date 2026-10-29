// =====================================================================
//  Smart Health Monitor – reads live data from Blynk IoT (server BLR1)
// =====================================================================

// ---------------------------------------------------------------------
// 1) Blynk Auth Token – set it in config.js, not here.
// ---------------------------------------------------------------------
// Your token lives in config.js (kept out of git). See config.example.js.
const BLYNK_TOKEN = window.BLYNK_TOKEN || "PASTE_YOUR_TOKEN_HERE";

const BLYNK_SERVER = "https://blr1.blynk.cloud/external/api";
const POLL_MS = 2000;            // ask Blynk for new values every 2 s
let WORKER = "W01";   // the wearable the prototype is acting as (set on the Wearables page)

// Datastream pins (must match the Blynk template)
const PIN = {
  status: "V0", hr: "V1", spo2: "V2", temp: "V3", hum: "V4",
  fall: "V5", sos: "V6", help: "V10",
  lat: "V11", lng: "V12", sats: "V13",   // Neo-6M GPS
  beat: "V9",                            // counter the wearable bumps every 2 s
};
// Blynk can take a minute to notice a device is gone, so the dashboard also treats the
// wearable as offline as soon as its heartbeat counter stops changing for this long
const STALE_MS = 6000;

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

// Is the wearable itself connected to Blynk right now? (Blynk keeps the last values even when it isn't)
async function deviceOnline() {
  const res = await fetch(`${BLYNK_SERVER}/isHardwareConnected?token=${encodeURIComponent(BLYNK_TOKEN)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Blynk replied ${res.status}`);
  return (await res.text()).trim() === "true";
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
  // walk slowly round a small loop near RVCE, Bengaluru
  const a = s / 120;
  const lat = 12.92370 + 0.0009 * Math.sin(a), lng = 77.49870 + 0.0012 * Math.cos(a);
  return {
    V0: demo.sos ? "W01 - ALERT!" : "W01 (online)",
    V1: Math.round(72 + 6 * Math.sin(s / 15) + Math.random() * 3 + (demo.sos ? 25 : 0)),
    V2: Math.round(97 + Math.random() * 2),
    V3: +(36.6 + 0.4 * Math.sin(s / 40) + Math.random() * 0.2).toFixed(1),
    V4: Math.round(42 + Math.random() * 4),
    V5: demo.fall, V6: demo.sos, V10: 0,
    V11: lat.toFixed(6), V12: lng.toFixed(6), V13: 7 + Math.round(Math.random() * 3),
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

  if (!deviceIsOnline) {
    $(`${key}Val`).textContent = (0).toFixed(decimals);
    $(`${key}Pill`).textContent = "Offline";
    fill.style.strokeDasharray = `0 251.33`;
    updateVital(key, null, null, "Offline", decimals);
    return;
  }
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
  $(`v-${key}-val`).textContent = value !== null ? value.toFixed(decimals) : deviceIsOnline ? "--" : (0).toFixed(decimals);
  $(`v-${key}-pill`).textContent = text;
  const mark = $(`v-${key}-mark`);
  mark.hidden = value === null;
  if (value !== null) mark.style.left = `${Math.min(value / RULES[key].max, 1) * 100}%`;

  // min / avg / max over the last hour (from the chart points)
  const vals = points.map((p) => p[key]).filter((n) => n !== null && n !== undefined);
  const fmt = (n) => (!deviceIsOnline ? (0).toFixed(decimals) : vals.length ? n.toFixed(decimals) : "--");
  $(`v-${key}-min`).textContent = fmt(Math.min(...vals));
  $(`v-${key}-avg`).textContent = fmt(vals.reduce((a, b) => a + b, 0) / vals.length);
  $(`v-${key}-max`).textContent = fmt(Math.max(...vals));
}

// GPS position, or null when the Neo-6M has no fix (it sends 0,0 or nothing)
function gpsFix(d) {
  // The wearable sends "lat,lng" together on V12 (a String datastream), because V11 is a whole-number
  // datastream in the Blynk template and drops the decimals. A plain number on V12 is the old format.
  const both = String(d[PIN.lng] ?? "").split(",");
  const lat = num(both.length === 2 ? both[0] : d[PIN.lat]), lng = num(both.length === 2 ? both[1] : d[PIN.lng]);
  if (lat === null || lng === null || lat === 0 || lng === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}
const coordText = (p) => (p ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : "No GPS fix");

// Distance in metres between two positions (haversine)
function metres(a, b) {
  const R = 6371e3, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function setStatusPill(kind, text) {
  $("statusPill").className = `pill-status ${kind}`;
  $("statusText").textContent = text;
}

// GPS quality from satellites in view: 5 bars, colour class on the parent
function gpsLevel(sats, fix) {
  if (!fix) return { bars: 0, cls: "poor", text: "No GPS fix – needs a clear view of the sky" };
  if (sats === null) return { bars: 3, cls: "", text: "GPS fix (satellite count not sent)" };
  const bars = sats >= 10 ? 5 : sats >= 8 ? 4 : sats >= 6 ? 3 : sats >= 4 ? 2 : 1;
  return { bars, cls: bars >= 3 ? "" : bars === 2 ? "weak" : "poor",
           text: ["", "Weak fix – position may jump", "Fair fix", "Good fix", "Very good fix", "Excellent fix"][bars] };
}
function setGps(sats, fix) {
  const { bars, cls, text } = gpsLevel(sats, fix);
  document.querySelectorAll("[data-bars]").forEach((el) => {
    [...el.children].forEach((b, i) => b.classList.toggle("on", i < bars));
    const holder = el.parentElement;
    holder.classList.remove("weak", "poor");
    if (cls) holder.classList.add(cls);
  });
  const satTxt = sats === null ? "--" : String(sats);
  $("satValLoc").textContent = satTxt;
  $("qiSats").textContent = satTxt;
  $("locSats").textContent = satTxt;
  $("locQuality").textContent = text;

  $("ovFix").textContent = fix ? "GPS locked" : "No GPS fix";
  $("ovCoords").textContent = fix ? coordText(fix) : "Waiting for satellites…";
  $("qiLoc").textContent = fix ? coordText(fix) : "--";
  $("sideLoc").textContent = fix ? coordText(fix) : "No GPS fix";
  $("locLat").textContent = fix ? `${fix.lat.toFixed(6)}°` : "--";
  $("locLng").textContent = fix ? `${fix.lng.toFixed(6)}°` : "--";
  if (fix) $("locFixTime").textContent = clock();
  $("mapEmpty").hidden = !!fix;
  const gm = $("gmapsLink");
  gm.hidden = !fix;
  if (fix) gm.href = `https://www.google.com/maps?q=${fix.lat},${fix.lng}`;
}

// ---------- Maps (Leaflet + OpenStreetMap tiles, darkened in style.css) ----------
const maps = {};
function makeMap(id, opts) {
  if (!window.L) return null;
  const m = L.map(id, { zoomControl: opts.zoom, scrollWheelZoom: false }).setView([12.9237, 77.4987], 16);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(m);
  const trail = opts.trail ? L.polyline([], { color: "#08a9ff", weight: 3, opacity: .7 }).addTo(m) : null;
  const marker = L.circleMarker([0, 0], { radius: 9, color: "#fff", weight: 2, fillColor: "#ffba16", fillOpacity: 1 });
  return { m, marker, trail, centred: false };
}
function initMaps() {
  maps.ov = makeMap("ovMap", { zoom: false });
  maps.loc = makeMap("locMap", { zoom: true, trail: true });
}
function updateMaps(fix, alert) {
  Object.values(maps).forEach((mp) => {
    if (!mp) return;
    if (mp.trail) mp.trail.setLatLngs(posLog.slice().reverse().map((p) => [p.lat, p.lng]));
    if (!fix) { mp.marker.remove(); return; }
    mp.marker.setLatLng([fix.lat, fix.lng]).setStyle({ fillColor: alert ? "#ff1744" : "#ffba16" }).addTo(mp.m);
    // the small map always follows W01; the big one centres once, then lets the user pan around
    if (!mp.centred || !mp.trail) { mp.m.setView([fix.lat, fix.lng], mp.centred ? mp.m.getZoom() : 17); mp.centred = true; }
  });
}

let lastLocText = "location unknown";
let lastUpdate = 0;
let deviceIsOnline = true;   // false while Blynk says the wearable isn't connected

function render(d, online = true) {
  deviceIsOnline = online;
  const hr = num(d[PIN.hr]), spo2 = num(d[PIN.spo2]), temp = num(d[PIN.temp]), hum = num(d[PIN.hum]);
  const sos = num(d[PIN.sos]) === 1, fall = num(d[PIN.fall]) === 1;
  const fix = gpsFix(d), sats = num(d[PIN.sats]);
  const status = String(d[PIN.status] ?? "");
  const locText = fix ? coordText(fix) : "location unknown";
  const alert = sos || fall;
  const noSignal = /no signal/i.test(status);

  // Header
  lastUpdate = Date.now();
  $("lastUpdated").textContent = clock();
  $("agoText").textContent = "(0s ago)";
  $("qiUpdated").textContent = clock();
  $("wifiIcon").className = "hicon ok";
  if (!online) setStatusPill("offline", "Device offline");
  else if (alert) setStatusPill("alert", sos ? "SOS Alert" : "Fall Alert");
  else if (noSignal) setStatusPill("nosignal", "No signal");
  else setStatusPill("online", DEMO ? "Online (demo)" : "Online");

  // Chart points first, so the 1-hour min/avg/max include this reading.
  // Nothing is recorded while the device is offline (Blynk only has old values then).
  if (online) addPoint(hr, temp, spo2, hum); else drawChart();

  // Gauges
  setGauge("hr", hr);
  setGauge("spo2", spo2);
  setGauge("temp", temp, 1);
  setGauge("hum", hum);

  // Banners
  $("sosBanner").classList.toggle("active", sos);
  $("sosTitle").textContent = sos ? `SOS from ${WORKER} – ${locText}` : "No SOS";
  $("sosSub").textContent = sos ? "Emergency button pressed. Dispatch help now." : "All clear";
  $("fallBanner").classList.toggle("active", fall);
  $("fallTitle").textContent = fall ? `Fall detected – ${locText}` : "No fall detected";
  $("fallSub").textContent = fall ? `${WORKER} may be injured. Check immediately.` : "All clear";

  // Status tiles
  $("tileSos").classList.toggle("on", sos);
  $("sosPill").textContent = sos ? "ON" : "OFF";
  $("tileFall").classList.toggle("on", fall);
  $("fallPill").textContent = fall ? "ON" : "OFF";
  document.querySelectorAll(".js-help").forEach((b) => b.classList.toggle("urgent", alert));

  // GPS location (overview card, location page, quick info, maps)
  $("qiStatus").textContent = status || "--";
  $("sideWorker").className = `side-worker ${!online ? "offline" : alert ? "alert" : noSignal ? "nosignal" : "online"}`;
  $("navAlertDot").hidden = !alert;
  lastLocText = locText;
  setGps(sats, fix);
  trackPosition(fix);
  updateMaps(fix, alert);
  renderPins(d);

  // Alert history
  trackAlerts(sos, fall, locText);
}

// ---------- Location page: log a position each time W01 moves 10 m or more ----------
const MOVE_M = 10;
let posLog = load("positions", []);
function trackPosition(fix) {
  if (!fix) return;
  const last = posLog[0];
  const moved = last ? metres(last, fix) : null;
  if (last && moved < MOVE_M) return;
  posLog.unshift({ time: Date.now(), lat: fix.lat, lng: fix.lng, moved });
  posLog = posLog.slice(0, 200);
  save("positions", posLog);
  renderPosLog();
}
const distText = (m) => (m === null ? "—" : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);
function renderPosLog() {
  $("posBody").innerHTML = posLog.length
    ? posLog.slice(0, 50).map((p) => `<tr>
        <td>${clock(new Date(p.time))}</td>
        <td>${p.lat.toFixed(6)}</td>
        <td>${p.lng.toFixed(6)}</td>
        <td>${distText(p.moved)}</td>
      </tr>`).join("")
    : '<tr class="empty"><td colspan="4">No positions recorded yet</td></tr>';
}

// ---------- Device page: raw Blynk datastreams ----------
const PIN_INFO = {
  status: "Device message", hr: "Heart rate (bpm)", spo2: "SpO₂ (%)", temp: "Temperature (°C)",
  hum: "Humidity (%)", fall: "Fall detected (0/1)", sos: "SOS pressed (0/1)",
  help: "Help dispatched (0/1)", lat: "GPS latitude (°)", lng: "GPS position (lat,lng)", sats: "GPS satellites in view",
  beat: "Heartbeat counter",
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

function trackAlerts(sos, fall, locText) {
  for (const type of ["sos", "fall"]) {
    const now = type === "sos" ? sos : fall;
    const alreadyOpen = alertLog.some((h) => h.type === type && !h.resolved);
    if (now && !prev[type] && !alreadyOpen) {
      alertLog.unshift({ time: Date.now(), wid: WORKER, type, loc: locText, resolved: false });
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
const placeOf = (h) => h.loc ?? h.zone ?? "--";   // older entries saved a zone instead
const day = (t) => new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

function renderHistory() {
  // Overview card: latest 5
  const recent = alertLog.slice(0, 5);
  $("historyBody").innerHTML = recent.length
    ? recent.map((h) => `<tr><td>${clock(new Date(h.time))}</td>${typeCell(h)}<td>${esc(placeOf(h))}</td>${resolvedCell(h)}</tr>`).join("")
    : '<tr class="empty"><td colspan="4">No alerts yet</td></tr>';

  // Alert History page: everything, filtered
  const rows = alertLog.filter((h) =>
    alertFilter === "all" ? true : alertFilter === "open" ? !h.resolved : h.type === alertFilter);
  $("alertsBody").innerHTML = rows.length
    ? rows.map((h) => `<tr class="${h.resolved ? "" : "open"}">
        <td>${day(h.time)}</td><td>${clock(new Date(h.time))}</td><td>${esc(h.wid ?? "W01")}</td>${typeCell(h)}<td>${esc(placeOf(h))}</td>${resolvedCell(h)}
        <td>${h.resolvedAt ? clock(new Date(h.resolvedAt)) : "—"}</td>
      </tr>`).join("")
    : `<tr class="empty"><td colspan="7">${alertLog.length ? "No alerts match this filter" : "No alerts yet"}</td></tr>`;

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

function downloadFile(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const toCsv = (rows) => rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
const today = () => new Date().toISOString().slice(0, 10);

$("exportCsv").addEventListener("click", () => {
  const lines = [["Date", "Time", "User", "Type", "Location", "Resolved", "Resolved at"]].concat(
    alertLog.map((h) => [day(h.time), clock(new Date(h.time)), h.wid ?? "W01", h.type === "sos" ? "SOS" : "Fall", placeOf(h),
      h.resolved ? "Yes" : "No", h.resolvedAt ? clock(new Date(h.resolvedAt)) : ""]));
  downloadFile(`alerts-${today()}.csv`, toCsv(lines), "text/csv");
});

// =====================================================================
// 6) Live chart (heart rate + temperature, last 15 min or 1 hour)
// =====================================================================
// "vitals" replaced the old "points" key, which held stale values recorded while the device was offline
try { localStorage.removeItem(STORE + "points"); } catch { /* storage blocked – ignore */ }
let points = load("vitals", []).filter((p) => Date.now() - p.t < 3600e3);
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
  if (t - lastSaved > 10000) { save("vitals", points); lastSaved = t; }  // save every 10 s
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
  const f = (n) => (!deviceIsOnline ? `${(0).toFixed(decimals)} ${unit}` : ok.length ? `${n.toFixed(decimals)} ${unit}` : "--");
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
    showHelpToast(`Help has been dispatched to ${WORKER} – ${lastLocText}`, "Team is on the way.");
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
const PAGES = ["overview", "vitals", "wearables", "location", "charts", "alerts", "device"];
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
  document.title = currentPage === "overview" ? "Smart Health Monitor" : `${label} · Smart Health Monitor`;
  setMenu(false);
  drawChart();
  [chart, hrChart, tempChart].forEach((c) => c && c.resize());
  Object.values(maps).forEach((mp) => mp && mp.m.invalidateSize());   // Leaflet needs this after being hidden
}
window.addEventListener("hashchange", () => { showPage(); window.scrollTo(0, 0); });

// Emergency banners jump to the SOS/Fall tiles + Help button on the overview
document.querySelectorAll("[data-jump]").forEach((a) => a.addEventListener("click", (e) => {
  e.preventDefault();
  if (location.hash !== "#overview") { history.pushState(null, "", "#overview"); showPage(); }
  $(a.dataset.jump).scrollIntoView({ behavior: "smooth", block: "center" });
}));

// Profile button in the header opens a small menu with the user's current info
const profileBtn = $("profileBtn"), profileMenu = $("profileMenu");
function setProfile(open) {
  profileMenu.hidden = !open;
  profileBtn.setAttribute("aria-expanded", open);
  if (!open) return;
  $("pmStatus").textContent = $("statusText").textContent;
  $("pmLoc").textContent = $("qiLoc").textContent;
  $("pmUpdated").textContent = $("lastUpdated").textContent;
}
profileBtn.addEventListener("click", (e) => { e.stopPropagation(); setProfile(profileMenu.hidden); });
profileMenu.addEventListener("click", (e) => { if (e.target.closest("a")) setProfile(false); });
document.addEventListener("click", (e) => { if (!profileMenu.hidden && !profileMenu.contains(e.target)) setProfile(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !profileMenu.hidden) { setProfile(false); profileBtn.focus(); } });

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
  if (!confirm("Delete the saved chart data and position log?")) return;
  points = []; posLog = []; save("vitals", points); save("positions", posLog);
  drawChart(); renderPosLog(); updateMaps(null, false);
});

// =====================================================================
// 9) Wearables – the whole fleet. Each wearable has an ID and the person
//    wearing it. There is one physical prototype for now: it "acts as" the
//    chosen wearable, and its live readings are saved to that wearable.
// =====================================================================
const MAX_READINGS = 3000;   // per wearable: ~100 min at one reading every 2 s
const LIVE_MS = 10000;       // a wearable counts as live while its last reading is this recent
let wearables = load("wearables", [{ id: "W01", name: "", age: null }]);   // [{ id, name, age }]
let readings = load("readings", {});                                        // { W01: [{ t, hr, spo2, temp }] }
let active = load("active", wearables[0].id);                              // the wearable the prototype is acting as
let detailId = active;
let protoBeat;   // heartbeat of the last reading saved, so one reading is never counted twice
let protoNow = { hr: null, spo2: null, online: false };

const wearableById = (id) => wearables.find((w) => w.id === id);
const wearerName = (w) => (w && w.name ? w.name : "Unassigned");
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const levelClass = (key, v) => `c-${RULES[key].level(v)}`;
const lastOf = (id) => { const r = readings[id]; return r && r.length ? r[r.length - 1] : null; };
const isLive = (id) => { const l = lastOf(id); return id === active && protoNow.online && !!l && Date.now() - l.t < LIVE_MS; };
const when = (t) => (new Date(t).toDateString() === new Date().toDateString()
  ? clock(new Date(t)).slice(0, 5) : `${day(t)}, ${clock(new Date(t)).slice(0, 5)}`);

// The rest of the dashboard (header, sidebar, alerts) follows the wearable the prototype is acting as
function setWearerLabels() {
  const w = wearableById(active);
  WORKER = active;
  document.querySelectorAll(".js-wid").forEach((el) => { el.textContent = active; });
  document.querySelectorAll(".js-wearer").forEach((el) => { el.textContent = w && w.name ? `${w.name} · ${active}` : `User ${active}`; });
}

function recordReading(d, online) {
  const hr = num(d[PIN.hr]), spo2 = num(d[PIN.spo2]), temp = num(d[PIN.temp]), beat = d[PIN.beat];
  const fresh = beat === undefined || beat !== protoBeat;
  protoBeat = beat;
  protoNow = { hr: online ? hr : null, spo2: online ? spo2 : null, online };
  if (online && fresh && hr > 0 && spo2 > 0) {
    const list = (readings[active] ||= []);
    list.push({ t: Date.now(), hr, spo2, temp: temp || null });
    if (list.length > MAX_READINGS) list.splice(0, list.length - MAX_READINGS);
    save("readings", readings);
  }
  renderWearables();
}

function renderProto() {
  const { hr, spo2, online } = protoNow, w = wearableById(active), last = lastOf(active);
  const finger = hr > 0 && spo2 > 0;
  const state = !online ? "offline" : finger ? "live" : "nofinger";
  $("protoCard").className = `span-8 glass card proto-card ${state}`;
  $("protoPill").textContent = { offline: "Offline", live: "Live – recording", nofinger: "Connected – no finger" }[state];
  $("protoHr").textContent = finger ? hr : "--";
  $("protoSpo2").textContent = finger ? spo2 : "--";
  $("protoCount").textContent = (readings[active] || []).length;
  $("protoLast").textContent = last ? clock(new Date(last.t)).slice(0, 5) : "--";
  $("protoLastDay").textContent = last ? day(last.t) : " ";
  $("protoHint").textContent = !online
    ? "The prototype is offline. Plug it in and it will carry on recording for the wearable chosen above."
    : !finger ? `Ask ${w && w.name ? w.name : "the wearer"} to rest a fingertip gently and still on the sensor. Readings start after 5–10 s.`
    : `Saving ${wearerName(w)}'s readings to ${active}. To measure someone else, choose their wearable above.`;
}

function renderWearables() {
  // dropdowns
  const opts = wearables.map((w) => `<option value="${esc(w.id)}">${esc(w.id)} · ${esc(wearerName(w))}</option>`).join("");
  if ($("protoAs").dataset.opts !== opts) {
    $("protoAs").innerHTML = opts; $("wdPick").innerHTML = opts; $("protoAs").dataset.opts = opts;
  }
  $("protoAs").value = active;
  if (!wearableById(detailId)) detailId = active;
  $("wdPick").value = detailId;

  // counters
  let live = 0, ok = 0, check = 0;
  wearables.forEach((w) => {
    const l = lastOf(w.id);
    if (isLive(w.id)) live++;
    if (l) { if (RULES.hr.level(l.hr) === "ok" && RULES.spo2.level(l.spo2) === "ok") ok++; else check++; }
  });
  $("wbTotal").textContent = wearables.length;
  $("wbLive").textContent = live;
  $("wbOk").textContent = ok;
  $("wbCheck").textContent = check;
  $("navLive").textContent = live;
  $("navLive").hidden = live === 0;

  // one card per wearable
  const cards = wearables.map((w) => {
    const l = lastOf(w.id), live = isLive(w.id), acting = w.id === active;
    const status = live ? "Live" : l ? `Last seen ${when(l.t)}` : "No data yet";
    return `<article class="glass person${live ? " wearing" : ""}${w.id === detailId ? " picked" : ""}" data-pick="${esc(w.id)}" tabindex="0">
      <div class="person-head">
        <span class="person-avatar">${esc(w.id)}</span>
        <div><strong>${esc(wearerName(w))}</strong><span>${w.age ? `Age ${w.age} · ` : ""}${acting ? "Prototype attached" : `${(readings[w.id] || []).length} readings`}</span></div>
        <button class="x" data-del="${esc(w.id)}" aria-label="Remove ${esc(w.id)}" title="Remove"><i data-lucide="trash-2"></i></button>
      </div>
      <div class="person-vitals">
        <div><span>Heart rate</span><strong class="${l ? levelClass("hr", l.hr) : ""}">${l ? l.hr : "--"}</strong><small>bpm</small></div>
        <div><span>SpO₂</span><strong class="${l ? levelClass("spo2", l.spo2) : ""}">${l ? l.spo2 : "--"}</strong><small>%</small></div>
      </div>
      <div class="person-foot"><span class="w-status ${live ? "live" : l ? "seen" : ""}"><i></i>${status}</span>
        ${acting ? "" : `<button class="link" data-act="${esc(w.id)}">Attach prototype</button>`}</div>
    </article>`;
  }).join("");
  if ($("wearGrid").dataset.html !== cards) {   // rebuild only when something changed (keeps focus and icons steady)
    $("wearGrid").dataset.html = cards;
    $("wearGrid").innerHTML = cards;
    if (window.lucide) lucide.createIcons();
  }

  renderProto();
  if (currentPage === "wearables") drawWearChart();
}

// ---------- readings chart for one wearable ----------
const wdChart = window.Chart ? new Chart($("wdChart"), {
  type: "line",
  plugins: [lastValueTags],
  data: { datasets: [
    { label: "Heart rate (bpm)", yAxisID: "yHr", borderColor: "#22c55e", backgroundColor: "rgba(34,197,94,.08)", fill: true, decimals: 0, data: [] },
    { label: "SpO₂ (%)", yAxisID: "ySpo2", borderColor: "#08a9ff", backgroundColor: "transparent", decimals: 0, data: [] },
  ]},
  options: {
    animation: false, maintainAspectRatio: false, parsing: false, spanGaps: false,
    layout: { padding: { right: 44 } },
    elements: { point: { radius: 0, hoverRadius: 4 }, line: { tension: 0.3, borderWidth: 2 } },
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false } },
    scales: {
      x: { type: "linear", ticks: { color: "#8d97a8", maxTicksLimit: 7,
            callback: (v) => new Date(v).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) },
           grid: { color: "rgba(255,255,255,.06)" } },
      yHr:   { position: "left",  min: 40, max: 160, ticks: { color: "#8d97a8", stepSize: 20 }, grid: { color: "rgba(255,255,255,.06)" } },
      ySpo2: { position: "right", min: 80, max: 100, ticks: { color: "#8d97a8" }, grid: { display: false } },
    },
  },
}) : null;

function drawWearChart() {
  const w = wearableById(detailId), list = readings[detailId] || [];
  $("wdTitle").textContent = `${detailId} · ${wearerName(w)}`;
  $("wdEmpty").hidden = list.length > 0;
  // a gap of more than a minute (prototype moved to another wearable) breaks the line
  const hr = [], spo2 = [];
  list.forEach((r, i) => {
    if (i && r.t - list[i - 1].t > 60e3) { hr.push({ x: r.t - 1, y: null }); spo2.push({ x: r.t - 1, y: null }); }
    hr.push({ x: r.t, y: r.hr }); spo2.push({ x: r.t, y: r.spo2 });
  });
  if (wdChart) {
    wdChart.data.datasets[0].data = hr;
    wdChart.data.datasets[1].data = spo2;
    wdChart.options.scales.x.min = list.length ? list[0].t : undefined;
    wdChart.options.scales.x.max = list.length ? list[list.length - 1].t : undefined;
    wdChart.update("none");
  }
  const h = list.map((r) => r.hr), s = list.map((r) => r.spo2);
  const cell = (k, text) => `<div><span>${k}</span><strong>${list.length ? text : "--"}</strong></div>`;
  $("wdStats").innerHTML = cell("Heart rate avg", `${Math.round(avg(h))} bpm`)
    + cell("Heart rate range", `${Math.min(...h)} – ${Math.max(...h)} bpm`)
    + cell("SpO₂ avg", `${Math.round(avg(s))} %`) + cell("Readings", list.length);
}

// ---------- actions ----------
function attach(id) {
  if (!wearableById(id) || id === active) return;
  active = id;
  protoBeat = undefined;
  save("active", active);
  setWearerLabels();
  renderWearables();
  showHelpToast(`Prototype is now ${id}`, `Readings are saved for ${wearerName(wearableById(id))} from now on.`);
}
$("protoAs").addEventListener("change", () => attach($("protoAs").value));
$("wdPick").addEventListener("change", () => { detailId = $("wdPick").value; renderWearables(); });

$("wearGrid").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]"), act = e.target.closest("[data-act]"), card = e.target.closest("[data-pick]");
  if (del) return removeWearable(del.dataset.del);
  if (act) return attach(act.dataset.act);
  if (card) { detailId = card.dataset.pick; renderWearables(); }
});
$("wearGrid").addEventListener("keydown", (e) => {
  const card = e.target.closest("[data-pick]");
  if (card && e.target === card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); detailId = card.dataset.pick; renderWearables(); }
});

function nextId() {
  const n = wearables.map((w) => parseInt(w.id.replace(/\D/g, ""), 10) || 0);
  return `W${String(Math.max(0, ...n) + 1).padStart(2, "0")}`;
}
$("wbForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("wbId").value.trim().toUpperCase(), name = $("wbName").value.trim(), age = parseInt($("wbAge").value, 10);
  if (!id || !name) return;
  const existing = wearableById(id);
  if (existing && existing.name && !confirm(`${id} is already worn by ${existing.name}. Give it to ${name} instead?`)) return;
  if (existing) Object.assign(existing, { name, age: age > 0 ? age : null });
  else wearables.push({ id, name, age: age > 0 ? age : null });
  save("wearables", wearables);
  $("wbForm").reset();
  $("wbId").value = nextId();
  detailId = id;
  setWearerLabels();
  renderWearables();
});

function removeWearable(id) {
  if (id === active) { alert(`The prototype is attached to ${id}. Attach it to another wearable first.`); return; }
  const n = (readings[id] || []).length;
  if (!confirm(`Remove ${id} (${wearerName(wearableById(id))})${n ? ` and its ${n} readings` : ""}?`)) return;
  wearables = wearables.filter((w) => w.id !== id);
  delete readings[id];
  save("wearables", wearables); save("readings", readings);
  $("wbId").value = nextId();
  renderWearables();
}

$("wbExport").addEventListener("click", () => {
  const lines = [["Wearable", "Worn by", "Age", "Date", "Time", "Heart rate (bpm)", "SpO2 (%)", "Temperature (C)"]];
  wearables.forEach((w) => (readings[w.id] || []).forEach((r) =>
    lines.push([w.id, w.name, w.age ?? "", day(r.t), clock(new Date(r.t)), r.hr, r.spo2, r.temp ?? ""])));
  downloadFile(`wearables-readings-${today()}.csv`, toCsv(lines), "text/csv");
});

// Backup / restore, to move the fleet's data to another browser or combine two browsers
$("wbBackup").addEventListener("click", () => {
  downloadFile(`wearables-backup-${today()}.json`, JSON.stringify({ wearables, readings }), "application/json");
});
$("wbRestore").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.wearables) || !data.readings || typeof data.readings !== "object") throw new Error("not a Wearables backup file");
    let added = 0, merged = 0;
    data.wearables.forEach((w) => {
      if (!w || !w.id) return;
      const mine = wearableById(w.id);
      if (!mine) { wearables.push({ id: String(w.id), name: String(w.name || ""), age: w.age || null }); added++; }
      else if (!mine.name && w.name) mine.name = String(w.name);
      const have = new Set((readings[w.id] || []).map((r) => r.t));
      const extra = (data.readings[w.id] || []).filter((r) => r && r.t && r.hr > 0 && r.spo2 > 0 && !have.has(r.t));
      merged += extra.length;
      readings[w.id] = (readings[w.id] || []).concat(extra).sort((a, b) => a.t - b.t).slice(-MAX_READINGS);
    });
    save("wearables", wearables); save("readings", readings);
    setWearerLabels(); renderWearables();
    showHelpToast("Backup restored", `Added ${added} wearables and ${merged} readings.`);
  } catch (err) {
    showHelpToast("Could not restore that file", err.message, true);
  }
});

// =====================================================================
// 10) Main loop – poll Blynk every 2 s
// =====================================================================
const stats = { ok: 0, fail: 0 };
let lastBeat, beatChangedAt = 0;
// Online only while Blynk says so AND the heartbeat counter is still moving
function stillBeating(beat) {
  if (beat === undefined || beat === null) return true;   // firmware without a heartbeat: trust Blynk
  if (beat !== lastBeat) { lastBeat = beat; beatChangedAt = Date.now(); }   // first reading counts as fresh
  return Date.now() - beatChangedAt < STALE_MS;
}

async function poll() {
  try {
    const [raw, blynkOnline] = DEMO ? [demoData(), true] : await Promise.all([readBlynk(), deviceOnline()]);
    const beating = DEMO || stillBeating(raw[PIN.beat]);
    const online = blynkOnline && beating;
    let data = raw;
    // device offline: Blynk's stored values are old, so show only the status message, no readings
    if (!online) data = { [PIN.status]: data[PIN.status] };
    render(data, online);
    recordReading(raw, online);
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
renderPosLog();
setWearerLabels();
$("wbId").value = nextId();
renderWearables();
initMaps();
showPage();
poll();
