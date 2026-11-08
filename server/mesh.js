const dgram = require("dgram");
const crypto = require("crypto");
const os = require("os");
const net = require("net");
const { getEffectiveState } = require("./network");

/**
 * MESH RELAY — Layer 1.5 of the resilience ladder.
 *
 * "No internet" is a property of a DEVICE, not necessarily of the whole room.
 * If your laptop has no signal but the person next to you (same LAN / same
 * hotspot) still does, their GridLess instance can answer on your behalf.
 * Discovery is a UDP broadcast beacon on the local subnet; no central server.
 *
 * TRUST MODEL (v2):
 *  - If NETWORK_KEY is set, EVERY packet (beacon / SOS / ack) carries an
 *    HMAC-SHA256 signature over its canonical contents plus a timestamp and a
 *    random nonce. Receivers reject bad signatures, stale timestamps (±2 min)
 *    and replayed nonces. The key itself never goes on the wire, and an
 *    eavesdropper can't forge or replay packets.
 *  - If NETWORK_KEY is NOT set the mesh runs in OPEN mode: discovery and SOS
 *    work, but anyone on the LAN can spoof them, and peer relay of AI
 *    requests is disabled (see index.js). Fine for a demo, not for real use.
 *  - The signature authenticates; it does not encrypt. SOS text and GPS are
 *    visible to anyone sniffing the LAN. Use a network you trust.
 *  - Every incoming field is validated/sanitized before it is stored, and the
 *    UI renders it with textContent only.
 */

const MESH_PORT = parseInt(process.env.MESH_PORT || "41234", 10);
const BEACON_INTERVAL_MS = 4000;
const PEER_TIMEOUT_MS = 15000;
const MAX_PACKET_BYTES = 2048;
const CLOCK_SKEW_MS = 2 * 60 * 1000;
const NONCE_TTL_MS = CLOCK_SKEW_MS * 2;
const MAX_PEERS = 64;
const MAX_ALERTS = 100;
const SOS_ALERT_TTL_MS = 5 * 60 * 1000;
const SENT_SOS_TTL_MS = 15 * 60 * 1000;

const instanceId = crypto.randomUUID().slice(0, 8);
const peers = new Map(); // id -> { id, host, port, online, lastSeen, authenticated }
const sosAlerts = new Map(); // `${senderId}-${sosId}` -> alert record
const sentSOS = new Map(); // sosId -> { sosId, message, timestamp, acks: Map(deviceId -> {kind, at}) }
const seenNonces = new Map(); // nonce -> expiry

let socket = null;
let httpPort = 3000;
let meshEnabled = false;
const timers = [];

/* ---------- pure helpers (unit-tested) ---------- */

function getKey() {
  return process.env.NETWORK_KEY ? String(process.env.NETWORK_KEY) : null;
}

function isNetworkSecured() {
  return Boolean(getKey());
}

/** Deterministic serialization: sorted keys, so signer and verifier agree regardless of field order. */
function canonical(obj) {
  return JSON.stringify(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

function hmacHex(key, text) {
  return crypto.createHmac("sha256", key).update(text).digest("hex");
}

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/** Returns a copy of `fields` + {v, ts, nonce, sig?}. sig present only when a key is configured. */
function buildPacket(type, fields, key = getKey(), now = Date.now()) {
  const body = { v: 2, type, id: instanceId, ts: now, nonce: crypto.randomBytes(8).toString("hex"), ...fields };
  if (key) body.sig = hmacHex(key, canonical(body));
  return body;
}

/** Atomic check-and-record of a nonce. Returns false if it was already seen (replay). */
function consumeNonce(nonce, now = Date.now()) {
  if (typeof nonce !== "string" || !/^[a-f0-9]{16}$/.test(nonce)) return false;
  if (seenNonces.size > 5000) pruneNonces(now);
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, now + NONCE_TTL_MS);
  return true;
}

function pruneNonces(now = Date.now()) {
  for (const [n, exp] of seenNonces) if (exp < now) seenNonces.delete(n);
}

/**
 * Authenticates a decoded packet. Keyed mode: signature, timestamp window and
 * nonce freshness are all mandatory. Open mode: no signature required.
 * Returns { ok, authenticated, reason }.
 */
function verifyPacket(data, key = getKey(), now = Date.now()) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: "not an object" };
  if (!key) return { ok: true, authenticated: false };
  const { sig, ...rest } = data;
  if (typeof sig !== "string") return { ok: false, reason: "missing signature" };
  if (!safeEqualHex(sig, hmacHex(key, canonical(rest)))) return { ok: false, reason: "bad signature" };
  if (typeof data.ts !== "number" || Math.abs(now - data.ts) > CLOCK_SKEW_MS) return { ok: false, reason: "stale timestamp" };
  if (!consumeNonce(data.nonce, now)) return { ok: false, reason: "replayed nonce" };
  return { ok: true, authenticated: true };
}

/* Signing for peer-to-peer HTTP relay requests (used by index.js). */
function signRelay(rawBody, key = getKey(), now = Date.now()) {
  if (!key) return {};
  const nonce = crypto.randomBytes(8).toString("hex");
  const sig = hmacHex(key, `${now}.${nonce}.${rawBody}`);
  return { "x-gridless-ts": String(now), "x-gridless-nonce": nonce, "x-gridless-sig": sig };
}

function verifyRelay(headers, rawBody, key = getKey(), now = Date.now()) {
  if (!key) return { ok: false, reason: "no NETWORK_KEY configured" };
  const ts = Number(headers["x-gridless-ts"]);
  const nonce = headers["x-gridless-nonce"];
  const sig = headers["x-gridless-sig"];
  if (!Number.isFinite(ts) || Math.abs(now - ts) > CLOCK_SKEW_MS) return { ok: false, reason: "stale timestamp" };
  if (typeof nonce !== "string" || typeof sig !== "string") return { ok: false, reason: "missing auth headers" };
  if (!safeEqualHex(sig, hmacHex(key, `${ts}.${nonce}.${rawBody}`))) return { ok: false, reason: "bad signature" };
  if (!consumeNonce(nonce, now)) return { ok: false, reason: "replayed nonce" };
  return { ok: true };
}

function isPrivateIPv4(ip) {
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function ipToInt(ip) {
  return ip.split(".").reduce((acc, p) => ((acc << 8) | Number(p)) >>> 0, 0);
}

/** This device's non-loopback IPv4 networks, as [{address, netmask}]. */
function getLocalNets() {
  try {
    return Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && !i.internal && i.family === "IPv4")
      .map((i) => ({ address: i.address, netmask: i.netmask }));
  } catch {
    return [];
  }
}

/**
 * A packet is only believed if its source address is on a subnet this
 * device is itself attached to (or is loopback, for two instances on one
 * machine). Packets "from" anywhere else — routed in from the internet or
 * another network — are dropped before they are even parsed.
 */
function isLocalSource(ip, nets = getLocalNets()) {
  if (!net.isIPv4(ip)) return false;
  if (ip.startsWith("127.")) return true;
  const x = ipToInt(ip);
  return nets.some((n) => net.isIPv4(n.address) && net.isIPv4(n.netmask) && ((x & ipToInt(n.netmask)) >>> 0) === ((ipToInt(n.address) & ipToInt(n.netmask)) >>> 0));
}

function cleanText(s, max) {
  return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

const ID_RE = /^[a-f0-9]{8}$/;
const SOSID_RE = /^[a-f0-9]{16}$/;

function validBeacon(d) {
  if (!ID_RE.test(d.id)) return null;
  if (!Number.isInteger(d.httpPort) || d.httpPort < 1 || d.httpPort > 65535) return null;
  if (typeof d.online !== "boolean") return null;
  return { id: d.id, httpPort: d.httpPort, online: d.online };
}

function validSOS(d) {
  if (!ID_RE.test(d.id) || !SOSID_RE.test(d.sosId)) return null;
  const message = cleanText(d.message, 200);
  if (!message) return null;
  const okCoord = (v, lim) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= lim ? v : null);
  return { id: d.id, sosId: d.sosId, message, lat: okCoord(d.lat, 90), lon: okCoord(d.lon, 180), timestamp: d.ts };
}

function validAck(d) {
  if (!ID_RE.test(d.id) || !ID_RE.test(d.to) || !SOSID_RE.test(d.sosId)) return null;
  if (d.kind !== "received" && d.kind !== "responding") return null;
  return { id: d.id, to: d.to, sosId: d.sosId, kind: d.kind };
}

/** Pure — given an IP and netmask, the subnet-directed broadcast address. */
function computeSubnetBroadcast(ip, netmask) {
  const ipParts = ip.split(".").map(Number);
  const maskParts = netmask.split(".").map(Number);
  if (ipParts.length !== 4 || maskParts.length !== 4) return null;
  return ipParts.map((p, i) => (p | (~maskParts[i] & 255))).join(".");
}

function getBroadcastAddresses() {
  const addrs = new Set(["255.255.255.255"]);
  try {
    Object.values(os.networkInterfaces()).flat().forEach((iface) => {
      if (!iface || iface.internal || iface.family !== "IPv4") return;
      const bcast = computeSubnetBroadcast(iface.address, iface.netmask);
      if (bcast) addrs.add(bcast);
    });
  } catch {
    // universal broadcast only
  }
  return Array.from(addrs);
}

/* ---------- packet handling ---------- */

/** Handles one raw UDP datagram. Exported for tests; never throws. Returns true if it was accepted. */
function handlePacket(msg, rinfo, now = Date.now(), nets = getLocalNets()) {
  try {
    if (!msg || msg.length > MAX_PACKET_BYTES) return false;
    if (!rinfo || !isLocalSource(rinfo.address, nets)) return false;
    const data = JSON.parse(msg.toString("utf8"));
    const v = verifyPacket(data, getKey(), now);
    if (!v.ok) return false;
    if (data.id === instanceId) return false; // our own broadcast echoing back

    if (data.type === "gridless-beacon") {
      const b = validBeacon(data);
      if (!b) return false;
      if (!peers.has(b.id) && peers.size >= MAX_PEERS) return false;
      peers.set(b.id, { ...b, host: rinfo.address, port: b.httpPort, lastSeen: now, authenticated: v.authenticated });
      return true;
    }

    if (data.type === "gridless-sos") {
      const s = validSOS(data);
      if (!s) return false;
      const key = `${s.id}-${s.sosId}`;
      if (sosAlerts.has(key)) return true; // duplicate of the 3x resend — already shown
      if (sosAlerts.size >= MAX_ALERTS) {
        const oldest = sosAlerts.keys().next().value;
        sosAlerts.delete(oldest);
      }
      sosAlerts.set(key, { key, ...s, receivedAt: now, fromHost: rinfo.address, authenticated: v.authenticated, responded: false });
      sendAck(s.sosId, s.id, rinfo.address, "received"); // real delivery receipt back to the sender
      return true;
    }

    if (data.type === "gridless-ack") {
      const a = validAck(data);
      if (!a || a.to !== instanceId) return false;
      const sent = sentSOS.get(a.sosId);
      if (!sent) return false;
      const prev = sent.acks.get(a.id);
      if (!prev || a.kind === "responding") sent.acks.set(a.id, { kind: a.kind, at: now });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function sendRaw(payload, targets) {
  return Promise.all(
    targets.map(
      (addr) =>
        new Promise((resolve) => {
          try {
            socket.send(payload, MESH_PORT, addr, (err) => resolve(!err));
          } catch {
            resolve(false);
          }
        })
    )
  );
}

function sendAck(sosId, toId, toHost, kind) {
  if (!socket || !meshEnabled) return;
  const targets = Array.from(new Set([toHost, ...getBroadcastAddresses()]));
  // two rounds: UDP is lossy, acks are cheap
  [0, 300].forEach((delay) =>
    setTimeout(() => {
      const payload = Buffer.from(JSON.stringify(buildPacket("gridless-ack", { to: toId, sosId, kind })));
      sendRaw(payload, targets);
    }, delay)
  );
}

function startMesh(port) {
  httpPort = parseInt(port, 10) || 3000; // PORT arrives from the environment as a string
  socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  socket.on("error", (err) => {
    console.warn(`[mesh] socket error, mesh discovery disabled: ${err.message}`);
    meshEnabled = false;
  });
  socket.on("message", (msg, rinfo) => handlePacket(msg, rinfo));

  socket.bind(MESH_PORT, () => {
    try {
      socket.setBroadcast(true);
      meshEnabled = true;
      console.log(
        `[mesh] listening on UDP:${MESH_PORT} — instance ${instanceId} — ${isNetworkSecured() ? "SECURED (HMAC)" : "OPEN mode (no NETWORK_KEY)"}`
      );
    } catch (err) {
      console.warn(`[mesh] broadcast unavailable on this network: ${err.message}`);
    }
  });

  [
    setInterval(broadcastBeacon, BEACON_INTERVAL_MS),
    setInterval(pruneAll, BEACON_INTERVAL_MS),
  ].forEach((t) => {
    t.unref();
    timers.push(t);
  });
}

function broadcastBeacon() {
  if (!socket || !meshEnabled) return;
  const state = getEffectiveState();
  const payload = Buffer.from(JSON.stringify(buildPacket("gridless-beacon", { httpPort, online: Boolean(state.online) })));
  sendRaw(payload, getBroadcastAddresses());
}

function pruneAll(now = Date.now()) {
  for (const [id, p] of peers) if (now - p.lastSeen > PEER_TIMEOUT_MS) peers.delete(id);
  for (const [k, a] of sosAlerts) if (now - a.receivedAt > SOS_ALERT_TTL_MS) sosAlerts.delete(k);
  for (const [k, s] of sentSOS) if (now - s.timestamp > SENT_SOS_TTL_MS) sentSOS.delete(k);
  pruneNonces(now);
}

/**
 * Sends an SOS over the LAN — no AI involved. Fires 3 rounds (UDP is lossy).
 * HONEST RESULT: resolves after the first round with how many network
 * interfaces accepted the packet. That means "handed to the network", NOT
 * "someone received it" — receipts arrive later as acks (see listSentSOS).
 */
async function broadcastSOS(message, lat, lon) {
  if (!socket || !meshEnabled) {
    return { sent: false, reason: "mesh networking is not active on this device (no usable network interface)" };
  }
  const text = cleanText(message, 200);
  if (!text) return { sent: false, reason: "empty message" };
  const sosId = crypto.randomBytes(8).toString("hex");
  const now = Date.now();
  sentSOS.set(sosId, { sosId, message: text, timestamp: now, acks: new Map() });

  const fields = {
    sosId,
    message: text,
    lat: typeof lat === "number" && Number.isFinite(lat) && Math.abs(lat) <= 90 ? lat : null,
    lon: typeof lon === "number" && Number.isFinite(lon) && Math.abs(lon) <= 180 ? lon : null,
  };
  const addresses = getBroadcastAddresses();
  const send = () => sendRaw(Buffer.from(JSON.stringify(buildPacket("gridless-sos", fields))), addresses);

  const first = await send();
  setTimeout(send, 300).unref();
  setTimeout(send, 600).unref();
  const accepted = first.filter(Boolean).length;
  if (accepted === 0) {
    sentSOS.delete(sosId);
    return { sent: false, reason: "no network interface accepted the broadcast — are you connected to a network?" };
  }
  return { sent: true, sosId, interfaces: accepted, delivery: "unconfirmed", secured: isNetworkSecured() };
}

/** A responder taps "I can help": sends a signed 'responding' ack back to the sender. */
function respondToSOS(key) {
  const alert = sosAlerts.get(key);
  if (!alert) return false;
  alert.responded = true;
  sendAck(alert.sosId, alert.id, alert.fromHost, "responding");
  return true;
}

function listSOSAlerts() {
  return Array.from(sosAlerts.values()).sort((a, b) => b.receivedAt - a.receivedAt);
}

function listSentSOS() {
  return Array.from(sentSOS.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((s) => ({
      sosId: s.sosId,
      message: s.message,
      timestamp: s.timestamp,
      received: Array.from(s.acks.values()).length,
      responding: Array.from(s.acks.values()).filter((a) => a.kind === "responding").length,
    }));
}

/** Online peers, most recently seen first. In keyed mode only authenticated peers exist anyway. */
function getOnlinePeers() {
  return Array.from(peers.values())
    .filter((p) => p.online)
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

function listPeers() {
  return Array.from(peers.values()).map((p) => ({
    id: p.id,
    host: p.host,
    port: p.port,
    online: p.online,
    authenticated: p.authenticated,
    lastSeenMs: Date.now() - p.lastSeen,
  }));
}

/** Test hook: reset all in-memory state. */
function _reset() {
  peers.clear();
  sosAlerts.clear();
  sentSOS.clear();
  seenNonces.clear();
}

module.exports = {
  startMesh,
  getOnlinePeers,
  listPeers,
  instanceId,
  broadcastSOS,
  respondToSOS,
  listSOSAlerts,
  listSentSOS,
  isNetworkSecured,
  computeSubnetBroadcast,
  getBroadcastAddresses,
  signRelay,
  verifyRelay,
  isPrivateIPv4,
  isLocalSource,
  // exposed for tests
  buildPacket,
  verifyPacket,
  handlePacket,
  canonical,
  _reset,
};
