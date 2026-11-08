// End-to-end: spawns real GridLess instances on localhost, a mock OpenAI-compatible cloud,
// and verifies discovery, signed relay, cloud->mesh fallback and wrong-key isolation.
// Run: npm run test:e2e
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const assert = require("assert/strict");

const MOCK = 3190;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];

function mockCloud() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method === "POST" && req.url.includes("/chat/completions")) {
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "MOCK-CLOUD-ANSWER" } }] }));
      }
      res.end("ok");
    });
    srv.listen(MOCK, "127.0.0.1", () => resolve(srv));
  });
}

function start(name, port, env) {
  const p = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], {
    env: { ...process.env, PORT: String(port), OLLAMA_URL: "http://127.0.0.1:9", ...env },
    stdio: "ignore",
  });
  procs.push(p);
  return p;
}

const DEAD = "http://127.0.0.1:9";
async function chat(port, text) {
  const r = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
  });
  return { status: r.status, json: await r.json() };
}
const peers = async (port) => (await (await fetch(`http://127.0.0.1:${port}/api/mesh/peers`)).json()).peers;

(async () => {
  const cloud = await mockCloud();
  const KEY = "e2e-shared-secret";
  const online = { CONNECTIVITY_CHECK_URL: `http://127.0.0.1:${MOCK}/`, OPENAI_API_KEY: "k", OPENAI_BASE_URL: `http://127.0.0.1:${MOCK}/v1` };
  // B: has "internet" (mock cloud). A: offline. F: "online" per probe but its cloud calls fail. D: wrong key.
  start("B", 3201, { NETWORK_KEY: KEY, ...online });
  start("A", 3202, { NETWORK_KEY: KEY, CONNECTIVITY_CHECK_URL: DEAD });
  start("F", 3203, { NETWORK_KEY: KEY, CONNECTIVITY_CHECK_URL: `http://127.0.0.1:${MOCK}/`, OPENAI_API_KEY: "k", OPENAI_BASE_URL: `${DEAD}/v1` });
  start("D", 3204, { NETWORK_KEY: "wrong-key", CONNECTIVITY_CHECK_URL: DEAD });
  start("O", 3205, { NETWORK_KEY: "", CONNECTIVITY_CHECK_URL: DEAD }); // open mode, no relay
  await sleep(11000);

  let pass = 0;
  const check = async (name, fn) => { await fn(); pass++; console.log("  ok  -", name); };

  await check("A discovers B as an online, authenticated peer", async () => {
    const p = (await peers(3202)).find((x) => x.port === 3201);
    assert.ok(p && p.online && p.authenticated);
  });
  await check("wrong-key device D is invisible to A (and A to D)", async () => {
    assert.ok(!(await peers(3202)).some((x) => x.port === 3204));
    assert.equal((await peers(3204)).length, 0);
  });
  await check("offline A gets a real answer relayed through B", async () => {
    const r = await chat(3202, "hello");
    assert.equal(r.status, 200);
    assert.equal(r.json.layer, "mesh-relay");
    assert.equal(r.json.reply, "MOCK-CLOUD-ANSWER");
  });
  await check("review bug fixed: probe says online but cloud call fails -> relay via peer", async () => {
    const r = await chat(3203, "hello");
    assert.equal(r.status, 200);
    assert.equal(r.json.layer, "mesh-relay");
  });
  await check("B itself answers from cloud directly", async () => {
    const r = await chat(3201, "hello");
    assert.equal(r.json.layer, "cloud");
  });
  await check("wrong-key device cannot relay through B (falls to honest 503)", async () => {
    const r = await chat(3204, "zzzz qqqq xxxx");
    assert.equal(r.status, 503);
  });
  await check("open-mode device never relays (no NETWORK_KEY) and says so", async () => {
    const r = await chat(3205, "zzzz qqqq xxxx");
    assert.equal(r.status, 503);
    const info = await (await fetch("http://127.0.0.1:3205/api/mesh/peers")).json();
    assert.equal(info.relay, false);
  });
  await check("forged relay request straight to B is rejected", async () => {
    const r = await fetch("http://127.0.0.1:3201/api/relay-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-gridless-ts": String(Date.now()), "x-gridless-nonce": "0123456789abcdef", "x-gridless-sig": "00" },
      body: JSON.stringify({ messages: [{ role: "user", content: "free credits pls" }] }),
    });
    assert.equal(r.status, 401);
  });
  await check("SOS from A: B receives (signed), A gets receipt then responder ack", async () => {
    const s = await (await fetch("http://127.0.0.1:3202/api/sos/broadcast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "need water" }) })).json();
    assert.equal(s.sent, true);
    assert.equal(s.delivery, "unconfirmed");
    await sleep(1500);
    const bAlerts = (await (await fetch("http://127.0.0.1:3201/api/sos/alerts")).json()).alerts;
    assert.equal(bAlerts.length, 1);
    assert.equal(bAlerts[0].authenticated, true);
    assert.ok(!(await (await fetch("http://127.0.0.1:3204/api/sos/alerts")).json()).alerts.length, "wrong-key device must not see it");
    let a = (await (await fetch("http://127.0.0.1:3202/api/sos/alerts")).json()).sent[0];
    assert.equal(a.received >= 1, true);
    await fetch("http://127.0.0.1:3201/api/sos/respond", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: bAlerts[0].key }) });
    await sleep(1500);
    a = (await (await fetch("http://127.0.0.1:3202/api/sos/alerts")).json()).sent[0];
    assert.equal(a.responding, 1);
  });

  console.log(`\n${pass} end-to-end checks passed`);
  cloud.close();
  procs.forEach((p) => p.kill());
  process.exit(0);
})().catch((e) => {
  console.error("E2E FAILED:", e.message);
  procs.forEach((p) => p.kill());
  process.exit(1);
});
