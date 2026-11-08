const axios = require("axios");

/**
 * GridLess's core insight: don't ask "did the API call fail?" (too late, too slow).
 * Instead, actively and cheaply probe real-world connectivity BEFORE deciding
 * which brain to use. This keeps response latency low in both modes and lets
 * the UI show a live "signal strength" indicator.
 */

const CHECK_URL = process.env.CONNECTIVITY_CHECK_URL || "https://www.google.com/generate_204";
const TIMEOUT_MS = 1500;

let lastKnownState = {
  online: false,
  latencyMs: null,
  checkedAt: null,
};

// Demo/testing override — lets a judge or presenter simulate a total
// signal loss with one click, instead of needing to physically unplug a
// network cable to prove the offline path works. Clearly surfaced in the
// UI as "simulated" — never silently misrepresented as real.
let forcedOffline = false;

function setForceOffline(enabled) {
  forcedOffline = !!enabled;
}

function isForceOffline() {
  return forcedOffline;
}

/** The state routing decisions actually use: real probe result, unless overridden for a demo. */
function getEffectiveState() {
  if (forcedOffline) {
    return { online: false, latencyMs: null, checkedAt: lastKnownState.checkedAt, forced: true, rawOnline: lastKnownState.online };
  }
  return { ...lastKnownState, forced: false, rawOnline: lastKnownState.online };
}

async function probeConnectivity() {
  const start = Date.now();
  try {
    await axios.get(CHECK_URL, { timeout: TIMEOUT_MS });
    const latencyMs = Date.now() - start;
    lastKnownState = { online: true, latencyMs, checkedAt: new Date().toISOString() };
  } catch (err) {
    lastKnownState = { online: false, latencyMs: null, checkedAt: new Date().toISOString() };
  }
  return lastKnownState;
}

/**
 * Signal quality isn't just binary. We bucket latency into a 0-4 "bars" scale
 * so the frontend can show something more honest than a green/red dot.
 */
function signalBars(latencyMs) {
  if (latencyMs === null) return 0;
  if (latencyMs < 150) return 4;
  if (latencyMs < 400) return 3;
  if (latencyMs < 900) return 2;
  return 1;
}

function getLastKnownState() {
  return lastKnownState;
}

module.exports = { probeConnectivity, getLastKnownState, signalBars, setForceOffline, isForceOffline, getEffectiveState };
