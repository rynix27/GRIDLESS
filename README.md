# GridLess

**An AI assistant that stays useful when the internet disappears.**

Most AI tools assume you're always connected. The moment you lose signal — on a trail,
in a basement, during an outage — they stop. GridLess treats connectivity as a
constantly-monitored variable and routes every message to the best layer that is
actually reachable *right now*.

```
 1  Cloud AI         (any OpenAI-compatible API — OpenAI, or free Groq)
 1.5 Mesh relay      a nearby GridLess device that has internet answers for you
 2  Local model      Ollama on your own hardware, grounded by an offline knowledge pack
 3  Offline guide    keyword lookup in a curated reference — no AI needed
```

Each reply is labelled with the layer that produced it. **Honest limits:** layer 3 only
answers questions that match its (small, curated) guide — otherwise GridLess says so
plainly (HTTP 503) instead of making something up. Layer 2 needs Ollama installed with a
model pulled. The mesh is same-network peer discovery, not Bluetooth or multi-hop routing.

## Quick start (Windows / Mac / Linux)

```bash
npm install
cp .env.example .env      # Windows cmd: copy .env.example .env
npm start
```
Open http://localhost:3000. With no API key and no Ollama you still get the offline guide.

- **Free cloud:** get a Groq key (console.groq.com/keys), put it in `.env` with the two
  `OPENAI_BASE_URL` / `OPENAI_MODEL` lines uncommented.
- **Free offline AI:** install [Ollama](https://ollama.com), then `ollama pull llama3.2:3b`.
- **Tests:** `npm test` (unit + HTTP, no network needed) and `npm run test:e2e`
  (spawns real instances, a mock cloud, and checks discovery / relay / SOS over real UDP).

## Offline AI behaviour (how Ollama is used)
- With no cloud and no peer, **every question goes to the local model (Ollama)** — whether or not
  anything in the stored knowledge matches. Stored reference text is only *supporting context*
  (added to the prompt when it genuinely matches); otherwise the model answers from its own knowledge.
- If Ollama can't answer, GridLess says **why** (not running / model not installed / still loading)
  and only then shows stored text, labelled **REFERENCE ONLY — not AI-generated**.
- The sidebar shows live **local AI status** (reachable + model installed) via `/api/ollama/health`.
- Test switches: **offline AI only** (skips cloud & mesh) and **use stored reference as context**
  (untick to test the model on its own pretrained knowledge).
- Every answer is labelled with its engine, e.g. `LOCAL AI — llama3.2:3b · no stored match — own knowledge`.
- Note: the model runs on the computer running GridLess, not on a phone browser that connects to it.
- `npm run test:e2e:ollama` proves the full cycle with a mock Ollama: unmatched question → AI answer,
  history, context on/off, model missing, Ollama stopped (reference-only), restarted (AI resumes).

## What's new in this version

**Two headline features**
1. **SOS with real delivery confirmation.** An SOS broadcast returns "sent, delivery unconfirmed";
   every receiving device automatically sends back a signed *received* receipt, and a responder
   can tap **I CAN HELP** to send a *responding* ack. The sender's screen shows
   "Received by N devices / N responding" — real evidence, never a fake ✓.
2. **Installable offline-first PWA.** Service-worker app shell (opens with no network), no
   external fonts, and the conversation is saved on-device and restored after reload/restart.

**Security & reliability hardening**
- Knowledge-pack **path traversal fixed** (strict name allowlist, atomic validated swap — a bad
  pack can no longer corrupt the running index).
- **XSS removed:** every mesh-supplied value is validated server-side and rendered with
  `textContent` only; strict Content-Security-Policy (no inline script).
- **Mesh authentication v2:** HMAC-SHA256 over each packet with timestamp window and replay
  (nonce) protection; the key never goes on the wire. Peer relay of AI requests uses signed HTTP
  requests, and is **off** unless `NETWORK_KEY` is set — nobody can spend your API credits.
- **Access control:** no CORS; Origin/Host checks; other devices need `ACCESS_TOKEN`; rate limits;
  chat accepts only `user`/`assistant` roles with size caps.
- **Routing bug fixed:** if the cloud is "online" but the call fails, mesh relay is now tried before
  the local model. Cloud/relay/local calls all have explicit timeouts.
- Safer failure handling: SOS/UI report real outcomes; overlapping chat requests are blocked; fatal
  exceptions now exit instead of limping on in an unknown state.
- **Knowledge corrections:** food safety (2 h / 1 h above 32 °C; 4 h applies to a closed fridge in
  an outage), heat stroke (sweating may continue), tourniquet, bleach dosing, carbon-monoxide warning.
  *These are general references, not medical advice — have a qualified professional review them
  before relying on them.*

## Mesh & SOS — how to demo on two devices

Put both devices on the same WiFi / hotspot. In each `.env`, set the **same** `NETWORK_KEY`.
Start GridLess on both. They appear in each other's "mesh network" panel within ~5 s. Send an
SOS from one: the other shows it with an **I CAN HELP** button; the sender sees the receipts.
To demo relay: give only one device a cloud key, tick *simulate total signal loss* on the other
and ask a question — the answer comes back labelled `MESH RELAY (via peer)`.

Using it from a phone: set `ACCESS_TOKEN` in `.env` and open
`http://<computer-ip>:3000/#token=<token>` once. Note browsers only allow GPS and service workers on
`localhost` or HTTPS, so on a plain-http LAN address those two features stay off (everything else works).

## Security model (read this)
- Signatures **authenticate** packets; they don't **encrypt** them. SOS text and GPS are readable
  by anyone sniffing the network. Use networks you trust.
- Open mode (no `NETWORK_KEY`) is for demos: SOS and discovery work, but can be spoofed, and relay is disabled.
- A single shared key means anyone who knows it can join. Per-device identities are future work.

## Architecture
| File | Role |
|---|---|
| `server/index.js` | Routing ladder, access guard, rate limits, API |
| `server/mesh.js` | UDP discovery, HMAC packets, SOS + acks, relay signing |
| `server/network.js` | Connectivity probe + latency-based signal reading |
| `server/rag.js` | Zero-dependency retrieval over swappable knowledge packs |
| `server/providers/` | OpenAI-compatible cloud + Ollama (pure, testable payload builders) |
| `server/knowledge/packs/` | `general`, `marine`, `urban-disaster` (21 entries) |
| `public/` | Vanilla-JS UI, service worker, manifest |
| `test/` | Unit/HTTP suite and multi-process end-to-end mesh test |

## Roadmap
Bluetooth / Wi-Fi Direct discovery · multi-hop forwarding · per-device keys · encrypted payloads ·
HTTPS on LAN · larger, professionally-reviewed knowledge packs · voice input.
