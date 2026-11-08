const OpenAI = require("openai");

let client = null;
/**
 * Points at OpenAI by default, but works with ANY OpenAI-compatible
 * endpoint — including genuinely free providers like Groq — by setting
 * OPENAI_BASE_URL in .env. The client itself doesn't care who's on the
 * other end; only the base URL and API key change.
 */
function getClient() {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set — add it to your .env file");
    }
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
      // Fail fast so the ladder can fall through to the next layer instead of hanging.
      timeout: parseInt(process.env.CLOUD_TIMEOUT_MS || "15000", 10),
      maxRetries: 0,
    });
  }
  return client;
}

/**
 * Pure function, no network call — deliberately separated out so it can be
 * unit tested without hitting any API. Low-power mode trades depth for
 * brevity: a dying phone shouldn't spend its last battery on a 500-token
 * essay when a two-sentence answer solves the same problem.
 */
function buildCompletionParams(messages, { system, lowPower } = {}) {
  const fullMessages = system ? [{ role: "system", content: system }, ...messages] : messages;
  return {
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: fullMessages,
    temperature: lowPower ? 0.3 : 0.6,
    max_tokens: lowPower ? 120 : 500,
  };
}

async function chat(messages, opts = {}) {
  const openai = getClient();
  const params = buildCompletionParams(messages, opts);
  const completion = await openai.chat.completions.create(params);

  const reply = completion?.choices?.[0]?.message?.content;
  if (typeof reply !== "string" || !reply.trim()) throw new Error("Cloud provider returned an empty response");

  return {
    reply,
    provider: process.env.OPENAI_BASE_URL ? "openai-compatible" : "openai",
    model: params.model,
    lowPower: Boolean(opts.lowPower),
  };
}

module.exports = { chat, buildCompletionParams, getClient };
