const axios = require("axios");

const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";

/**
 * Talks to a local Ollama instance. This never touches the internet —
 * it's a plain HTTP call to localhost, so it works on a plane, in a
 * basement server room, or in the middle of a blackout.
 */
/**
 * Pure function, no network call — testable in isolation. Talks to a local
 * Ollama instance over plain HTTP to localhost, so it works on a plane, in
 * a basement server room, or during a blackout.
 */
function buildOllamaPayload(messages, { system, contextSnippets = [], lowPower } = {}) {
  const contextBlock = contextSnippets.length
    ? `\n\nRelevant offline reference material (use it if it helps; it is trusted, but answer the user's actual question using your own knowledge too):\n${contextSnippets.map((s) => `- ${s}`).join("\n")}`
    : "\n\nNo stored reference material matched this question. Answer it fully from your own general knowledge.";

  const brevityInstruction = lowPower
    ? " Device is in low-power mode — answer in one or two short sentences, no more."
    : "";

  const systemPrompt = `${system || "You are GridLess, a helpful offline assistant."}${contextBlock}\n\nYou are currently running fully offline on local hardware with no internet access. Be concise and practical.${brevityInstruction}`;

  return {
    model: OLLAMA_MODEL,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    stream: true,
    keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m", // keep the model in memory between questions
    // Cap answer length: on a slow CPU every extra token is seconds of waiting.
    options: { num_predict: lowPower ? 80 : parseInt(process.env.OLLAMA_MAX_TOKENS || "300", 10) },
  };
}

/**
 * Turns a low-level axios error into a specific, user-actionable problem.
 * Pure function (unit-tested). `kind` is one of:
 * not-running | model-missing | timeout | bad-response | error
 */
function classifyOllamaError(err, { url = OLLAMA_URL, model = OLLAMA_MODEL } = {}) {
  const code = err && err.code;
  const status = err && err.response && err.response.status;
  const apiMsg = err && err.response && err.response.data && (err.response.data.error || "");
  if (status === 404 || /not found/i.test(String(apiMsg))) {
    return { kind: "model-missing", message: `Model "${model}" is not installed. Run: ollama pull ${model}` };
  }
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "ECONNRESET") {
    return { kind: "not-running", message: `Ollama is not reachable at ${url} (${code}). Start it with: ollama serve` };
  }
  if (code === "ECONNABORTED" || code === "ETIMEDOUT" || /timeout/i.test(String(err && err.message))) {
    return { kind: "timeout", message: `Ollama did not answer in time — the model may still be loading (first request is slow). Try again in a minute.` };
  }
  if (err && err.kind === "bad-response") return { kind: "bad-response", message: "Ollama returned an empty or malformed reply." };
  return { kind: "error", message: `Ollama error: ${(apiMsg || (err && err.message) || "unknown").toString().slice(0, 200)}` };
}

/** Checks that Ollama is reachable AND the configured model is installed. Never throws. */
async function health() {
  try {
    const res = await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: 2500 });
    const names = ((res.data && res.data.models) || []).map((m) => m.name || m.model).filter(Boolean);
    const want = OLLAMA_MODEL.includes(":") ? OLLAMA_MODEL : `${OLLAMA_MODEL}:latest`;
    const installed = names.includes(want) || names.includes(OLLAMA_MODEL);
    return {
      reachable: true,
      modelInstalled: installed,
      model: OLLAMA_MODEL,
      installedModels: names.slice(0, 20),
      ready: installed,
      message: installed ? `Local AI ready (${OLLAMA_MODEL})` : `Ollama is running but "${OLLAMA_MODEL}" is not installed. Run: ollama pull ${OLLAMA_MODEL}`,
    };
  } catch (err) {
    const c = classifyOllamaError(err);
    return { reachable: false, modelInstalled: false, model: OLLAMA_MODEL, ready: false, kind: c.kind, message: c.message };
  }
}

/**
 * Reads Ollama's streamed (NDJSON) reply and joins it into one answer.
 * The timeout is an IDLE timeout: it only fires if Ollama goes silent for
 * OLLAMA_TIMEOUT_MS (default 5 min — covers a slow model load). A slow but
 * steadily-generating model is never cut off just for taking a long time.
 */
async function streamChat(payload) {
  const idleMs = parseInt(process.env.OLLAMA_TIMEOUT_MS || "300000", 10);
  const controller = new AbortController();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), idleMs);
  };
  arm();
  try {
    const res = await axios.post(`${OLLAMA_URL}/api/chat`, payload, {
      responseType: "stream",
      signal: controller.signal,
      timeout: 0,
      validateStatus: () => true,
    });
    if (res.status >= 400) {
      let body = "";
      for await (const chunk of res.data) body += chunk;
      let msg = body;
      try { msg = JSON.parse(body).error || body; } catch {}
      const e = new Error(String(msg).slice(0, 200));
      e.response = { status: res.status, data: { error: String(msg) } };
      throw e;
    }
    let buf = "";
    let text = "";
    const take = (line) => {
      if (!line.trim()) return;
      const j = JSON.parse(line);
      if (j.error) {
        const e = new Error(String(j.error));
        e.response = { status: 500, data: { error: String(j.error) } };
        throw e;
      }
      if (j.message && typeof j.message.content === "string") text += j.message.content;
    };
    for await (const chunk of res.data) {
      arm();
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        take(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    take(buf);
    return text;
  } catch (err) {
    if (controller.signal.aborted) {
      const e = new Error("idle timeout");
      e.code = "ETIMEDOUT";
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function chat(messages, opts = {}) {
  const payload = buildOllamaPayload(messages, opts);

  try {
    const reply = await streamChat(payload);
    if (typeof reply !== "string" || !reply.trim()) {
      const e = new Error("empty reply");
      e.kind = "bad-response";
      throw e;
    }

    return {
      reply,
      provider: "ollama",
      model: OLLAMA_MODEL,
      lowPower: Boolean(opts.lowPower),
    };
  } catch (err) {
    const c = classifyOllamaError(err);
    // Log the REAL reason (connection error, missing model, timeout...) — never hide it.
    console.warn(`[ollama] ${c.kind}: ${c.message} | raw: ${err.code || ""} ${err.message}`);
    const out = new Error(c.message);
    out.kind = c.kind;
    throw out;
  }
}

/**
 * Loads the model into memory at startup so the FIRST real question isn't
 * the one that pays the (slow) load cost. Fire-and-forget; never throws.
 */
async function warmUp() {
  const h = await health();
  if (!h.ready) {
    console.log(`[ollama] ${h.message}`);
    return;
  }
  console.log(`[ollama] loading ${OLLAMA_MODEL} into memory (can take a minute on CPU)...`);
  const t = Date.now();
  try {
    await axios.post(
      `${OLLAMA_URL}/api/chat`,
      { model: OLLAMA_MODEL, messages: [{ role: "user", content: "hi" }], stream: false, keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m", options: { num_predict: 1 } },
      { timeout: 600000 }
    );
    console.log(`[ollama] model ready (${((Date.now() - t) / 1000).toFixed(1)}s) — offline AI will answer quickly now`);
  } catch (err) {
    console.warn(`[ollama] warm-up failed: ${classifyOllamaError(err).message}`);
  }
}

module.exports = { chat, health, warmUp, classifyOllamaError, buildOllamaPayload };
