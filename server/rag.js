const fs = require("fs");
const path = require("path");

/**
 * Same zero-dependency term-overlap retrieval as before — still no
 * embeddings API, still fully offline. The addition here is that the
 * knowledge base itself is no longer hardcoded: it's a swappable "pack"
 * (general / marine / urban-disaster / ...), loaded from disk and
 * re-indexed on demand, without restarting the server. A hiker doesn't
 * need urban shelter-in-place instructions; a sailor doesn't need
 * earthquake advice. The right offline brain for the right context.
 */

const MIN_SCORE = 2.0; // below this, treat the question as "not in the stored knowledge"
const PACKS_DIR = path.join(__dirname, "knowledge", "packs");

let activePackName = null;
let knowledgeBase = [];
let docTokens = [];
let docFrequency = {};
let N = 0;

// Generic words that appear in almost any question and say nothing about the topic.
const STOPWORDS = new Set(
  ("the and for are but not you your with this that have from they will what when where which who how why does did can could should would " +
    "about into out over under any some all more most than then them their there these those been being was were has had its our " +
    "explain tell write give show make made use using used need needs want help please simple simply works work working way ways get got " +
    "know like one two let just also very much many may might must now new " +
    "safety safe precautions precaution tips important best good steps needed survive").split(/\s+/)
);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function listPacks() {
  return fs
    .readdirSync(PACKS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

const PACK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Validates a parsed pack. Every entry must be a well-formed object — a
 * pack that fails here is rejected as a whole, before any module state changes.
 */
function validatePack(parsed) {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Pack must be a non-empty JSON array of entries");
  }
  parsed.forEach((d, i) => {
    const ok =
      d &&
      typeof d === "object" &&
      typeof d.id === "string" &&
      typeof d.title === "string" &&
      typeof d.content === "string" &&
      Array.isArray(d.tags) &&
      d.tags.every((t) => typeof t === "string");
    if (!ok) throw new Error(`Pack entry #${i} is malformed (needs string id/title/content and a tags[] of strings)`);
  });
  return parsed;
}

/**
 * Loads a pack by name and rebuilds the retrieval index in memory.
 * Security: the name must match a strict pattern AND be one of the files
 * actually present in the packs directory (allowlist), so it can never
 * escape that directory. Atomic: the new index is built in locals and only
 * swapped in after everything validated, so a bad pack can't corrupt the
 * currently active one.
 */
function loadPack(name) {
  const available = listPacks();
  if (typeof name !== "string" || !PACK_NAME_RE.test(name) || !available.includes(name)) {
    throw new Error(`Unknown knowledge pack. Available: ${available.join(", ")}`);
  }

  const file = path.join(PACKS_DIR, `${name}.json`);
  const parsed = validatePack(JSON.parse(fs.readFileSync(file, "utf-8")));

  const newTokens = parsed.map((doc) => new Set(tokenize(`${doc.title} ${doc.tags.join(" ")} ${doc.content}`)));
  const newFreq = {};
  newTokens.forEach((tokenSet) => {
    tokenSet.forEach((t) => {
      newFreq[t] = (newFreq[t] || 0) + 1;
    });
  });

  // Everything validated — swap state in one go.
  knowledgeBase = parsed;
  docTokens = newTokens;
  docFrequency = newFreq;
  N = parsed.length;
  activePackName = name;

  return { pack: name, entries: N };
}

function getActivePack() {
  return activePackName;
}

function scoreDoc(queryTokens, docIndex) {
  const tokens = docTokens[docIndex];
  let score = 0;
  queryTokens.forEach((qt) => {
    if (tokens.has(qt)) {
      const idf = Math.log((N + 1) / (docFrequency[qt] || 1));
      score += idf;
    }
  });
  const doc = knowledgeBase[docIndex];
  queryTokens.forEach((qt) => {
    if (doc.tags.some((tag) => tag.includes(qt) || qt.includes(tag))) {
      score += 1.5;
    }
  });
  return score;
}

function retrieve(query, k = 2) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const scored = knowledgeBase.map((doc, i) => ({
    doc,
    score: scoreDoc(queryTokens, i),
  }));

  scored.sort((a, b) => b.score - a.score);

  const top = scored[0] ? scored[0].score : 0;
  // Keep only hits that are reasonably close to the best match, so a stray
  // shared word ("water") doesn't drag in an unrelated entry.
  return scored
    .filter((s) => s.score >= MIN_SCORE && s.score >= top * 0.5)
    .slice(0, k)
    .map((s) => `${s.doc.title}: ${s.doc.content}`);
}

function keywordLookup(query) {
  const hits = retrieve(query, 3);
  return hits.length ? hits : null;
}

/** Metadata-only view for the frontend topic list — never leaks full content unnecessarily. */
function getKnowledgeMeta() {
  return knowledgeBase.map(({ id, title, tags }) => ({ id, title, tags }));
}

// Load a default pack at startup so the server is immediately useful.
loadPack(process.env.DEFAULT_KNOWLEDGE_PACK || "general");

module.exports = { retrieve, keywordLookup, getKnowledgeMeta, listPacks, loadPack, getActivePack, validatePack };
