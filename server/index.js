require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const path = require("path");
const axios = require("axios");

const { probeConnectivity, getEffectiveState, signalBars, setForceOffline, isForceOffline } = require("./network");
const openaiProvider = require("./providers/openai");
const ollamaProvider = require("./providers/ollama");
const rag = require("./rag");
const mesh = require("./mesh");

const app = express();
app.disable("x-powered-by");

// No CORS: the UI is served from this same origin, so no other website
// has any business calling this API from a browser.
// Basic hardening headers. The UI uses no inline scripts, so a strict CSP is possible.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
  next();
});

app.use(
  express.json({
    limit: "100kb",
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8"); // needed to verify peer-relay HMACs
    },
  })
);
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    setHeaders: (res, file) => {
      if (file.endsWith("sw.js")) res.setHeader("Cache-Control", "no-cache");
    },
  })
);

/**
 * A crash can leave a process half-initialised, so after an uncaught
 * exception we log and EXIT rather than limp on (restart with npm start /
 * a supervisor). Unhandled promise rejections are logged; per-request
 * failures are already handled inside each route.
 */
process.on("uncaughtException", (err) => {
  console.error("FATAL uncaught exception, exiting:", err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

const SYSTEM_PROMPT =
  "You are GridLess, a calm, competent assistant designed to keep working when everything else stops. " +
  "Be concise, practical, and honest about your confidence level. " +
  "For medical or life-safety questions, give general first-aid information only, say you are not a substitute for professional help, " +
  "and tell the person to contact emergency services whenever they can.";

const MAX_MESSAGES = 40;
const MAX_CONTENT_CHARS = 4000;
const HISTORY_SENT = 12;

/**
 * Validates client-supplied chat history. Only user/assistant roles are
 * accepted — a client can't smuggle in its own "system" message.
 */
function isValidMessageArray(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return false;
  return messages.every(
    (m) =>
      m &&
      typeof m === "object" &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" &&
      m.content.length <= MAX_CONTENT_CHARS
  );
}

/* ---------- access control ---------- */

const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";

function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function tokenOk(supplied) {
  if (!ACCESS_TOKEN || typeof supplied !== "string") return false;
  const a = crypto.createHash("sha256").update(supplied).digest();
  const b = crypto.createHash("sha256").update(ACCESS_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Guards every UI-facing endpoint. Requests from this machine are allowed
 * (with an Origin/Host sanity check against CSRF and DNS rebinding); requests
 * from other devices on the LAN need the ACCESS_TOKEN from .env. Peer relay
 * and the minimal /status ping have their own rules.
 */
function accessGuard(req, res, next) {
  if (req.path === "/relay-chat" || req.path === "/status") return next();

  const local = isLoopback(req.socket.remoteAddress);
  if (!local && !tokenOk(req.get("x-gridless-token"))) {
    return res.status(403).json({
      error: ACCESS_TOKEN
        ? "Access token required (open the app with #token=YOUR_TOKEN in the address)."
        : "Remote access is disabled. Set ACCESS_TOKEN in .env to use GridLess from another device.",
    });
  }

  const origin = req.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.get("host")) throw new Error("cross-origin");
    } catch {
      return res.status(403).json({ error: "Cross-origin request blocked" });
    }
  }
  if (local) {
    const hostname = String(req.get("host") || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    const ok = hostname === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname === "::1";
    if (!ok) return res.status(403).json({ error: "Unexpected Host header" });
  }
  next();
}

/** Tiny in-memory fixed-window rate limiter, keyed by remote address. */
function rateLimit(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 1000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    const key = req.socket.remoteAddress || "unknown";
    let rec = hits.get(key);
    if (!rec || rec.reset < now) {
      rec = { count: 0, reset: now + windowMs };
      hits.set(key, rec);
    }
    if (++rec.count > max) {
      res.setHeader("Retry-After", Math.ceil((rec.reset - now) / 1000));
      return res.status(429).json({ error: "Too many requests — slow down." });
    }
    next();
  };
}

app.use("/api", accessGuard);

// Kick off a connectivity probe immediately and refresh it periodically.
probeConnectivity();
setInterval(probeConnectivity, 8000).unref();

app.get("/api/status", (req, res) => {
  const state = getEffectiveState();
  res.json({
    ...state,
    bars: state.online ? signalBars(state.latencyMs) : 0,
  });
});

app.post("/api/demo/force-offline", (req, res) => {
  const { enabled } = req.body || {};
  setForceOffline(Boolean(enabled));
  res.json({ forced: isForceOffline() });
});

function relayPossible() {
  return mesh.isNetworkSecured() || process.env.ALLOW_OPEN_RELAY === "1";
}

/**
 * The resilience ladder (each rung only catches what the one above couldn't reach):
 *  1. Cloud — if this device is online.
 *  2. Mesh relay — a nearby GridLess peer that has internet answers for us.
 *     Tried whenever the cloud is unavailable OR failed (not only when "offline").
 *  3. Local model (Ollama) with offline RAG grounding.
 *  4. Offline reference guide — keyword lookup. This only helps if the
 *     question matches the guide; otherwise the API returns an honest 503.
 */
app.post("/api/chat", rateLimit(40, 60 * 1000), async (req, res) => {
  const body = req.body || {};
  if (!isValidMessageArray(body.messages)) {
    return res.status(400).json({
      error: `messages[] required: 1-${MAX_MESSAGES} entries, role "user" or "assistant", string content up to ${MAX_CONTENT_CHARS} chars`,
    });
  }
  const messages = body.messages.slice(-HISTORY_SENT);
  const lowPower = Boolean(body.lowPower);
  const offlineOnly = Boolean(body.offlineOnly); // testing: skip cloud + mesh, go straight to local AI
  const useKnowledge = body.useKnowledge !== false; // false = pure local-model generation, no retrieval
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const state = getEffectiveState();

  // Layer 1: cloud
  if (state.online && !offlineOnly) {
    try {
      const result = await openaiProvider.chat(messages, { system: SYSTEM_PROMPT, lowPower });
      return res.json({ ...result, layer: "cloud" });
    } catch (err) {
      console.warn("Cloud call failed, falling through:", err.message);
    }
  }

  // Layer 1.5: mesh relay — cloud unavailable or failed
  if (relayPossible() && !offlineOnly) {
    const relayBody = JSON.stringify({ messages, lowPower });
    for (const peer of mesh.getOnlinePeers().slice(0, 2)) {
      try {
        const relayRes = await axios.post(`http://${peer.host}:${peer.port}/api/relay-chat`, relayBody, {
          timeout: 20000,
          headers: { "Content-Type": "application/json", ...mesh.signRelay(relayBody) },
          maxRedirects: 0,
        });
        if (relayRes.data && typeof relayRes.data.reply === "string") {
          return res.json({
            reply: relayRes.data.reply,
            provider: relayRes.data.provider,
            model: relayRes.data.model,
            lowPower,
            layer: "mesh-relay",
            relayedVia: `${peer.host}:${peer.port}`,
          });
        }
      } catch (err) {
        console.warn(`Mesh relay via ${peer.host}:${peer.port} failed:`, err.message);
      }
    }
  }

  // Layer 2: local model. EVERY question that reaches here goes to Ollama — stored
  // knowledge is only supporting context, never a substitute for the model.
  const contextSnippets = useKnowledge ? rag.retrieve(lastUserMessage, 2) : [];
  let localProblem;
  try {
    const result = await ollamaProvider.chat(messages, { system: SYSTEM_PROMPT, contextSnippets, lowPower });
    return res.json({
      ...result,
      layer: "local-model",
      groundedIn: contextSnippets.length,
      knowledgeUsed: useKnowledge,
    });
  } catch (err) {
    localProblem = { kind: err.kind || "error", message: err.message };
  }

  // Layer 3: reference-only. Clearly NOT an AI answer, and says why the AI isn't available.
  const hits = rag.keywordLookup(lastUserMessage);
  if (hits) {
    return res.json({
      reply:
        `REFERENCE-ONLY MODE — local AI is unavailable (${localProblem.message})\n\n` +
        "This is stored reference text, not an AI-generated answer:\n\n" +
        hits.join("\n\n"),
      provider: "keyword-fallback",
      layer: "reference-only",
      localAi: localProblem,
    });
  }

  return res.status(503).json({
    error: `No answer available. Local AI is unavailable (${localProblem.message}) and nothing in the offline guide matches your question.`,
    localAi: localProblem,
  });
});

/** Is local AI ready? Reachable + configured model installed. */
app.get("/api/ollama/health", async (req, res) => {
  res.json(await ollamaProvider.health());
});

app.get("/api/knowledge", (req, res) => {
  res.json(rag.getKnowledgeMeta());
});

app.get("/api/knowledge/packs", (req, res) => {
  res.json({ active: rag.getActivePack(), available: rag.listPacks() });
});

app.post("/api/knowledge/pack", (req, res) => {
  const { pack } = req.body || {};
  if (typeof pack !== "string" || !pack) return res.status(400).json({ error: "pack is required" });
  try {
    res.json(rag.loadPack(pack));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Called only BY other GridLess instances. Requires a valid HMAC signature
 * made with the shared NETWORK_KEY (timestamped, nonce-protected against
 * replay). Without NETWORK_KEY relay is off, so nobody can spend your API
 * credits. ALLOW_OPEN_RELAY=1 is an explicit, demo-only escape hatch.
 */
app.post("/api/relay-chat", rateLimit(20, 60 * 1000), async (req, res) => {
  if (mesh.isNetworkSecured()) {
    const v = mesh.verifyRelay(req.headers, req.rawBody || "");
    if (!v.ok) return res.status(401).json({ error: `Relay auth failed: ${v.reason}` });
  } else if (process.env.ALLOW_OPEN_RELAY !== "1") {
    return res.status(403).json({ error: "Relay disabled: set the same NETWORK_KEY on both devices." });
  }

  const body = req.body || {};
  if (!isValidMessageArray(body.messages)) {
    return res.status(400).json({ error: "messages[] is required and must be well-formed" });
  }
  if (!getEffectiveState().online) {
    return res.status(503).json({ error: "This peer is not online either — cannot relay." });
  }
  try {
    const result = await openaiProvider.chat(body.messages.slice(-HISTORY_SENT), {
      system: SYSTEM_PROMPT,
      lowPower: Boolean(body.lowPower),
    });
    res.json(result);
  } catch (err) {
    console.warn("Relay failed:", err.message);
    res.status(502).json({ error: "Relay failed on the peer" });
  }
});

app.get("/api/mesh/peers", (req, res) => {
  res.json({ id: mesh.instanceId, peers: mesh.listPeers(), secured: mesh.isNetworkSecured(), relay: relayPossible() });
});

/**
 * SOS is separate from the AI pipeline — it works even if every AI layer is
 * down. The response is honest: `sent` only means the packet was handed to
 * the network. Real delivery shows up later as acknowledgements from other
 * devices (GET /api/sos/alerts → `sent[]`).
 */
app.post("/api/sos/broadcast", rateLimit(6, 60 * 1000), async (req, res) => {
  const { message, lat, lon } = req.body || {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }
  const result = await mesh.broadcastSOS(message.trim(), lat, lon);
  res.status(result.sent ? 200 : 503).json(result);
});

app.post("/api/sos/respond", rateLimit(20, 60 * 1000), (req, res) => {
  const { key } = req.body || {};
  if (typeof key !== "string" || !mesh.respondToSOS(key)) {
    return res.status(404).json({ error: "That alert is no longer active" });
  }
  res.json({ ok: true });
});

app.get("/api/sos/alerts", (req, res) => {
  res.json({ alerts: mesh.listSOSAlerts(), sent: mesh.listSentSOS() });
});

// Clean JSON 404 for unrecognized API routes.
app.use("/api", (req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` });
});

// Global error handler — must be last.
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ error: "Invalid JSON in request body" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request too large" });
  }
  console.error("Unhandled server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`GridLess running at http://localhost:${PORT}`);
    console.log("Resilience ladder: cloud -> mesh relay -> local model (Ollama) -> offline reference guide");
    if (!mesh.isNetworkSecured()) console.log("Note: NETWORK_KEY not set — mesh runs OPEN and peer relay is disabled.");
    mesh.startMesh(PORT);
    ollamaProvider.warmUp();
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use — GridLess may already be running. Close the old window (Ctrl+C) or set PORT in .env.`);
    } else {
      console.error("Server error:", err);
    }
    process.exit(1);
  });
}

module.exports = { app, isValidMessageArray };
