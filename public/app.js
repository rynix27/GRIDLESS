const transcript = document.getElementById("transcript");
const txForm = document.getElementById("txForm");
const txInput = document.getElementById("tx");
const signalMeter = document.getElementById("signalMeter");
const signalReadout = document.getElementById("signalReadout");
const signalSub = document.getElementById("signalSub");
const modeDot = document.getElementById("modeDot");
const modeText = document.getElementById("modeText");
const refList = document.getElementById("refList");
const meshStatus = document.getElementById("meshStatus");
const meshPeersEl = document.getElementById("meshPeers");
const gpsReadout = document.getElementById("gpsReadout");
const demoToggle = document.getElementById("demoToggle");
const packSelect = document.getElementById("packSelect");
const lowPowerToggle = document.getElementById("lowPowerToggle");
const powerHint = document.getElementById("powerHint");
const sosMessage = document.getElementById("sosMessage");
const sosSendBtn = document.getElementById("sosSendBtn");
const sosAlertsEl = document.getElementById("sosAlerts");
const sosStatus = document.getElementById("sosStatus");
const aiStatus = document.getElementById("aiStatus");
const offlineOnlyToggle = document.getElementById("offlineOnlyToggle");
const useKnowledgeToggle = document.getElementById("useKnowledgeToggle");
const txSend = document.querySelector(".tx-send");

/**
 * Remote devices on the LAN need ACCESS_TOKEN: open the app once with
 * http://<ip>:3000/#token=YOUR_TOKEN and it's remembered for the tab.
 * On the host machine itself no token is needed.
 */
let TOKEN = "";
try {
  const m = /[#&]token=([^&]+)/.exec(location.hash);
  if (m) {
    TOKEN = decodeURIComponent(m[1]);
    sessionStorage.setItem("gridless-token", TOKEN);
    history.replaceState(null, "", location.pathname);
  } else {
    TOKEN = sessionStorage.getItem("gridless-token") || "";
  }
} catch {
  // storage blocked — token just won't persist
}

function api(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (TOKEN) headers["x-gridless-token"] = TOKEN;
  return fetch(url, { ...opts, headers });
}

const STORE_KEY = "gridless-log-v1";
function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved && Array.isArray(saved.log) && Array.isArray(saved.history)) return saved;
  } catch {
    // corrupt or unavailable — start fresh
  }
  return { log: [], history: [] };
}
function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ log: savedLog.slice(-100), history: chatHistory.slice(-40) }));
  } catch {
    // storage full/blocked — the live session still works
  }
}

let lastCoords = null; // { lat, lon } from the most recent successful GPS read, if any

const saved = loadSaved();
let savedLog = saved.log.filter((e) => e && typeof e.text === "string");
let chatHistory = saved.history.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string");
let busy = false;
let currentTopics = [];
let suggestedTags = [];

function timestamp() {
  return new Date().toTimeString().slice(0, 8);
}

const LAYER_LABELS = {
  cloud: "CLOUD",
  "mesh-relay": "MESH RELAY (via peer)",
  "local-model": "LOCAL AI",
  "reference-only": "REFERENCE ONLY — not AI-generated",
};

function addEntry(role, text, layer, opts = {}) {
  const time = opts.time || timestamp();
  const entry = document.createElement("div");
  entry.className = `log-entry ${layer || role}`;
  const label = opts.label || LAYER_LABELS[layer] || (role === "user" ? "YOU" : "SYSTEM");
  const meta = document.createElement("div");
  meta.className = "log-meta";
  meta.textContent = `${label} · ${time}`;
  const body = document.createElement("div");
  body.className = "log-body";
  body.textContent = text;
  entry.append(meta, body);
  transcript.appendChild(entry);
  transcript.scrollTop = transcript.scrollHeight;
  if (!opts.restore) {
    savedLog.push({ role, text, layer: layer || null, time, label: opts.label || null });
    persist();
  }
  return entry;
}

function restoreLog() {
  savedLog.forEach((e) => addEntry(e.role, e.text, e.layer || undefined, { restore: true, time: e.time, label: e.label || undefined }));
  if (savedLog.length) {
    const note = document.createElement("div");
    note.className = "log-entry system";
    const body = document.createElement("div");
    body.className = "log-body";
    body.textContent = "— earlier conversation restored from this device —  ";
    const clear = document.createElement("button");
    clear.className = "ref-item";
    clear.textContent = "clear";
    clear.addEventListener("click", () => {
      savedLog = [];
      chatHistory = [];
      persist();
      location.reload();
    });
    body.appendChild(clear);
    note.appendChild(body);
    transcript.appendChild(note);
  }
}

async function refreshStatus() {
  try {
    const res = await api("/api/status");
    const s = await res.json();
    const bars = signalMeter.querySelectorAll(".bar");
    bars.forEach((b, i) => b.classList.toggle("lit", i < s.bars));
    signalMeter.classList.toggle("online", s.online);
    signalMeter.classList.toggle("offline", !s.online);

    if (s.online) {
      signalReadout.textContent = "ONLINE";
      signalSub.textContent = `${s.latencyMs}ms · cloud reasoning available`;
      modeDot.className = "dot online";
      modeText.textContent = "routing to cloud";
    } else if (s.forced) {
      signalReadout.textContent = "OFFGRID (simulated)";
      signalSub.textContent = "demo mode · real connection ignored on purpose";
      modeDot.className = "dot offline";
      modeText.textContent = "routing to local / mesh / reference";
    } else {
      signalReadout.textContent = "OFFGRID";
      signalSub.textContent = "no connection · local fallback active";
      modeDot.className = "dot offline";
      modeText.textContent = "routing to local / mesh / reference";
    }
  } catch {
    signalReadout.textContent = "UNKNOWN";
  }
}

async function refreshAiHealth() {
  try {
    const res = await api("/api/ollama/health");
    if (!res.ok) throw new Error("denied");
    const h = await res.json();
    aiStatus.textContent = h.ready ? `● ${h.message}` : `○ ${h.message}`;
    aiStatus.className = "ai-status " + (h.ready ? "ready" : "problem");
  } catch {
    aiStatus.textContent = "○ status unavailable";
    aiStatus.className = "ai-status";
  }
}

async function loadTopics() {
  try {
    const res = await api("/api/knowledge");
    currentTopics = await res.json();
    renderTopics();
  } catch {
    refList.textContent = "unavailable";
  }
}

function renderTopics() {
  refList.innerHTML = "";
  currentTopics.forEach((t) => {
    const btn = document.createElement("button");
    const isSuggested = suggestedTags.some((tag) => t.tags.includes(tag));
    btn.className = "ref-item" + (isSuggested ? " suggested" : "");
    btn.textContent = t.title;
    btn.onclick = () => {
      txInput.value = t.title;
      txForm.requestSubmit();
    };
    refList.appendChild(btn);
  });
}

/**
 * GPS works via the device's GPS chip / assisted positioning — it does NOT
 * require an active internet connection on most devices, which makes it a
 * legitimately "offgrid-safe" sensor. We use nothing but raw latitude here
 * (no reverse-geocoding API call, since that would need the network) to
 * bucket a rough climate zone and pre-surface the most relevant offline
 * reference topic before the user even asks.
 */
function classifyClimateZone(latitude) {
  const abs = Math.abs(latitude);
  if (abs > 60) return { zone: "polar / high-latitude", tags: ["cold", "hypothermia"] };
  if (abs < 23.5) return { zone: "tropical", tags: ["heat", "tropical"] };
  return { zone: "temperate", tags: [] };
}

function requestGpsContext() {
  if (!("geolocation" in navigator)) {
    gpsReadout.textContent = "GPS unavailable on this device";
    return;
  }
  if (!window.isSecureContext) {
    gpsReadout.textContent = "GPS needs localhost or HTTPS — off on plain http:// LAN addresses";
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      lastCoords = { lat: latitude, lon: longitude };
      const { zone, tags } = classifyClimateZone(latitude);
      suggestedTags = tags;
      gpsReadout.textContent = `${latitude.toFixed(2)}°, ${longitude.toFixed(2)}° · ${zone} zone`;
      if (tags.length) gpsReadout.textContent += " — relevant topic marked below";
      renderTopics();
    },
    () => {
      gpsReadout.textContent = "location permission denied — GPS suggestions off";
    },
    { timeout: 6000, maximumAge: 300000 }
  );
}

async function setDemoForceOffline(enabled) {
  try {
    await api("/api/demo/force-offline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    refreshStatus();
  } catch {
    // non-fatal — status poll will just reflect real state next tick
  }
}

demoToggle.addEventListener("change", () => setDemoForceOffline(demoToggle.checked));

/**
 * SOS Beacon — deliberately bypasses the entire AI pipeline. This works
 * even if cloud, mesh relay, and the local model are ALL down, since it's
 * a raw UDP broadcast, same mechanism as peer discovery. Every GridLess
 * device on the local network sees it within a couple seconds.
 */
async function sendSOS() {
  const message = sosMessage.value.trim();
  if (!message || sosSendBtn.disabled) return;
  sosSendBtn.disabled = true;
  sosSendBtn.textContent = "SENDING…";
  try {
    const res = await api("/api/sos/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        lat: lastCoords ? lastCoords.lat : undefined,
        lon: lastCoords ? lastCoords.lon : undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.sent) {
      sosMessage.value = "";
      // Honest wording: this only means the packet left this device.
      sosSendBtn.textContent = "BROADCAST SENT";
      sosStatus.textContent = data.secured
        ? "Sent. Delivery NOT confirmed yet — watch for receipts below."
        : "Sent on an OPEN network. Delivery NOT confirmed yet — watch for receipts below.";
      refreshSOSAlerts();
    } else {
      sosSendBtn.textContent = "NOT SENT";
      sosStatus.textContent = data.reason || data.error || "The broadcast could not be sent.";
    }
  } catch {
    sosSendBtn.textContent = "NOT SENT";
    sosStatus.textContent = "Could not reach the GridLess server on this device.";
  } finally {
    setTimeout(() => {
      sosSendBtn.textContent = "SEND SOS";
      sosSendBtn.disabled = false;
    }, 2500);
  }
}
sosSendBtn.addEventListener("click", sendSOS);
sosMessage.addEventListener("keydown", (e) => { if (e.key === "Enter") sendSOS(); });

function timeAgo(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  return m < 1 ? "just now" : `${m}m ago`;
}

let lastSosSig = "";

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * All mesh-supplied strings (ids, messages, hosts) are untrusted: they are
 * only ever placed with textContent, never parsed as HTML.
 */
async function respondToAlert(key, btn) {
  btn.disabled = true;
  btn.textContent = "SENDING…";
  try {
    const res = await api("/api/sos/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    btn.textContent = res.ok ? "SENT — THEY'LL SEE YOU'RE COMING" : "ALERT EXPIRED";
  } catch {
    btn.textContent = "FAILED — RETRY";
    btn.disabled = false;
  }
}

async function refreshSOSAlerts() {
  try {
    const res = await api("/api/sos/alerts");
    if (!res.ok) return;
    const { alerts, sent } = await res.json();
    const sig = JSON.stringify([alerts.map((a) => [a.key, a.responded, timeAgo(a.receivedAt)]), sent.map((s) => [s.sosId, s.received, s.responding])]);
    if (sig === lastSosSig) return;
    lastSosSig = sig;

    sosAlertsEl.textContent = "";

    sent.forEach((s) => {
      const div = el("div", "sos-alert sos-sent");
      div.appendChild(el("div", "sos-alert-meta", `YOUR SOS · ${timeAgo(s.timestamp)}`));
      div.appendChild(el("div", "", s.message));
      const receipt =
        s.responding > 0
          ? `${s.responding} device${s.responding > 1 ? "s" : ""} responding · ${s.received} received`
          : s.received > 0
          ? `Received by ${s.received} device${s.received > 1 ? "s" : ""}`
          : "No receipt yet — nobody has confirmed. Try again, or move closer / join the same WiFi.";
      div.appendChild(el("div", s.received > 0 ? "sos-receipt ok" : "sos-receipt none", receipt));
      sosAlertsEl.appendChild(div);
    });

    alerts.forEach((a) => {
      const div = el("div", "sos-alert");
      const loc = a.lat !== null && a.lon !== null ? ` · ${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}` : "";
      const trust = a.authenticated ? "" : " · unverified sender";
      div.appendChild(el("div", "sos-alert-meta", `SOS from ${a.id} · ${timeAgo(a.receivedAt)}${loc}${trust}`));
      div.appendChild(el("div", "", a.message));
      const btn = el("button", "sos-respond", a.responded ? "SENT — THEY'LL SEE YOU'RE COMING" : "I CAN HELP");
      btn.disabled = a.responded;
      btn.addEventListener("click", () => respondToAlert(a.key, btn));
      div.appendChild(btn);
      sosAlertsEl.appendChild(div);
    });
  } catch {
    // non-fatal — next poll will retry
  }
}

/**
 * Knowledge packs — swap the entire offline reference dataset live,
 * no server restart. The dropdown always reflects the server's actual
 * active pack, fetched fresh, never assumed.
 */
async function loadPacks() {
  try {
    const res = await api("/api/knowledge/packs");
    const { active, available } = await res.json();
    packSelect.innerHTML = "";
    available.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (name === active) opt.selected = true;
      packSelect.appendChild(opt);
    });
  } catch {
    packSelect.textContent = "";
    const o = document.createElement("option");
    o.textContent = "unavailable";
    packSelect.appendChild(o);
  }
}

packSelect.addEventListener("change", async () => {
  try {
    await api("/api/knowledge/pack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pack: packSelect.value }),
    });
    suggestedTags = []; // last pack's GPS suggestion may not apply to the new pack
    await loadTopics();
  } catch {
    // if the switch fails server-side, the dropdown will just re-sync on next loadPacks()
  }
});

/**
 * Battery API is best-effort and unsupported in several modern browsers —
 * this is why low-power mode ALSO has a manual toggle above. When it IS
 * available, a low battery pre-checks the toggle rather than forcing it,
 * so the person stays in control.
 */
function watchBattery() {
  if (!("getBattery" in navigator)) return;
  navigator
    .getBattery()
    .then((battery) => {
      const applyLevel = () => {
        if (battery.level < 0.2 && !battery.charging) {
          lowPowerToggle.checked = true;
          powerHint.textContent = `battery at ${Math.round(battery.level * 100)}% — auto-enabled, uncheck to override`;
        }
      };
      applyLevel();
      battery.addEventListener("levelchange", applyLevel);
    })
    .catch(() => {
      // Battery API present but blocked/unsupported for this context — silently no-op
    });
}

async function sendMessage(text) {
  if (busy) return; // one request at a time keeps history ordered
  busy = true;
  txInput.disabled = true;
  txSend.disabled = true;

  addEntry("user", text);
  chatHistory.push({ role: "user", content: text });

  const thinking = el("div", "log-entry system");
  thinking.appendChild(el("div", "log-meta", `SYSTEM · ${timestamp()}`));
  thinking.appendChild(el("div", "log-body", "thinking… (offline AI can take a minute, especially the first answer)"));
  transcript.appendChild(thinking);
  transcript.scrollTop = transcript.scrollHeight;

  try {
    const res = await api("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: chatHistory,
        lowPower: lowPowerToggle.checked,
        offlineOnly: offlineOnlyToggle.checked,
        useKnowledge: useKnowledgeToggle.checked,
      }),
    });
    const data = await res.json().catch(() => ({}));
    thinking.remove();

    if (!res.ok || typeof data.reply !== "string") {
      chatHistory.pop(); // failed turn shouldn't poison the next request
      addEntry("system", data.error || "Something went wrong.", "reference-only", { label: "NO ANSWER" });
      return;
    }

    let label;
    if (data.layer === "local-model") {
      const grounding = data.groundedIn > 0 ? `used ${data.groundedIn} stored reference${data.groundedIn > 1 ? "s" : ""}` : data.knowledgeUsed === false ? "pretrained knowledge only" : "no stored match — own knowledge";
      label = `LOCAL AI — ${data.model} · ${grounding}`;
    } else if (data.layer === "cloud") {
      label = `CLOUD AI — ${data.model || data.provider}`;
    } else if (data.layer === "mesh-relay") {
      label = `MESH RELAY — ${data.model || "AI"} via ${data.relayedVia}`;
    }
    addEntry("assistant", data.reply, data.layer, { label });
    chatHistory.push({ role: "assistant", content: data.reply });
  } catch {
    thinking.remove();
    chatHistory.pop();
    addEntry("system", "Could not reach the GridLess server itself. Is it running?", "reference-only", { label: "SERVER UNREACHABLE" });
  } finally {
    persist();
    busy = false;
    txInput.disabled = false;
    txSend.disabled = false;
    txInput.focus();
  }
}

txForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = txInput.value.trim();
  if (!text || busy) return;
  txInput.value = "";
  sendMessage(text);
});

async function refreshMesh() {
  try {
    const res = await api("/api/mesh/peers");
    const data = await res.json();
    const peers = data.peers || [];
    const onlinePeers = peers.filter((p) => p.online);
    const securityNote = data.secured ? "🔒 signed (HMAC) network" : "⚠ open network — SOS can be spoofed; peer relay off (set NETWORK_KEY)";

    if (peers.length === 0) {
      meshStatus.textContent = `no peers found · ${securityNote}`;
      meshStatus.classList.remove("has-peers");
    } else {
      meshStatus.textContent = `${peers.length} peer${peers.length > 1 ? "s" : ""} found · ${onlinePeers.length} online · ${securityNote}`;
      meshStatus.classList.toggle("has-peers", onlinePeers.length > 0);
    }

    meshPeersEl.textContent = "";
    peers.forEach((p) => {
      const row = el("div", "mesh-peer");
      row.appendChild(el("span", "", `${p.host}:${p.port}`));
      row.appendChild(el("span", "peer-state" + (p.online ? "" : " offline"), p.online ? "online" : "offline"));
      meshPeersEl.appendChild(row);
    });
  } catch {
    meshStatus.textContent = "mesh unavailable";
  }
}

restoreLog();
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // offline shell is a bonus — the app works without it
  });
}
refreshAiHealth();
setInterval(refreshAiHealth, 10000);
refreshStatus();
loadTopics();
loadPacks();
refreshMesh();
requestGpsContext();
watchBattery();
refreshSOSAlerts();
setInterval(refreshStatus, 8000);
setInterval(refreshMesh, 5000);
setInterval(refreshSOSAlerts, 3000);
