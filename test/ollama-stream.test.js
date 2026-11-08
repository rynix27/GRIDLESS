// Streaming + idle-timeout behaviour of the Ollama provider. Run: npm run test:stream
process.env.OLLAMA_URL = "http://127.0.0.1:3197";
process.env.OLLAMA_TIMEOUT_MS = "700"; // idle timeout
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const ollama = require("../server/providers/ollama");

let mode = "slow-steady";
const srv = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/api/tags") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ models: [{ name: "llama3.2:3b" }] })); }
    if (mode === "missing") { res.statusCode = 404; res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ error: "model 'llama3.2:3b' not found" })); }
    res.setHeader("Content-Type", "application/x-ndjson");
    const pieces = ["Hello", " from", " a", " slow", " model", "."];
    let i = 0;
    const tick = setInterval(() => {
      if (mode === "stall" && i === 2) { clearInterval(tick); return; } // goes silent mid-answer
      if (i < pieces.length) res.write(JSON.stringify({ message: { content: pieces[i++] }, done: false }) + (i % 2 ? "\n" : "\r\n"));
      else { res.end(JSON.stringify({ message: { content: "" }, done: true }) + "\n"); clearInterval(tick); }
    }, 250); // 6 pieces * 250ms = 1.5s total  >  700ms idle timeout
    res.on("close", () => clearInterval(tick));
  });
});
test.before(() => new Promise((r) => srv.listen(3197, "127.0.0.1", r)));
test.after(() => { srv.closeAllConnections && srv.closeAllConnections(); return new Promise((r) => srv.close(r)); });

test("slow but steady generation is NOT cut off (total time > idle timeout)", async () => {
  mode = "slow-steady";
  const t = Date.now();
  const r = await ollama.chat([{ role: "user", content: "hi" }]);
  assert.equal(r.reply, "Hello from a slow model.");
  assert.ok(Date.now() - t > 1000, "took longer than the idle timeout, yet succeeded");
});

test("a stalled model times out with a clear 'timeout' kind", async () => {
  mode = "stall";
  await assert.rejects(() => ollama.chat([{ role: "user", content: "hi" }]), (e) => e.kind === "timeout" && /did not answer in time/.test(e.message));
});

test("model-not-installed during streaming is reported specifically", async () => {
  mode = "missing";
  await assert.rejects(() => ollama.chat([{ role: "user", content: "hi" }]), (e) => e.kind === "model-missing" && /ollama pull/.test(e.message));
});

test("payload streams and caps tokens", () => {
  const p = ollama.buildOllamaPayload([{ role: "user", content: "x" }], {});
  assert.equal(p.stream, true);
  assert.equal(p.options.num_predict, 300);
  assert.equal(ollama.buildOllamaPayload([{ role: "user", content: "x" }], { lowPower: true }).options.num_predict, 80);
});
