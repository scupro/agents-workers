// Workers AI usage accounting — free tier is 10,000 NEURONS per DAY
// (resets daily 00:00 UTC), so we track estimated neurons, not call counts.
//
// Estimation (no extra API permissions needed):
//   1. If the model response carries `usage` tokens → exact token counts
//   2. Otherwise → chars / 4 heuristic (±20%)
//   3. neurons = in_tokens/1e6 × model's in-rate + out_tokens/1e6 × out-rate
//      (rates from https://developers.cloudflare.com/workers-ai/platform/pricing/, Oct 2026)
//
// Accuracy caveats (documented in README):
//   - KV get+put is NOT atomic → concurrent requests may undercount
//   - the 10k/day budget is ACCOUNT-wide; other Workers share it
//   - dashboard is authoritative; switch errors trigger markExhausted() anyway
//   - NEURON_SAFE_LIMIT default 8000 keeps a 20% buffer for all of the above
//
// KV keys (UTC date → auto-resets daily, TTLs expire the stale keys):
//   ai:neurons:YYYY-MM-DD     cumulative estimated neurons today
//   ai:exhausted:YYYY-MM-DD   "1" once quota error seen today
//   ai:provider-override      manual lock (persistent, not date-scoped)

const DAY = 60 * 60 * 24;

export function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// neurons per 1M tokens — [input, output]
export const NEURON_RATES = {
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast": [4119, 34868],
  "@cf/meta/llama-3.1-8b-instruct-fp8": [13778, 26128],
  "@cf/mistralai/mistral-small-3.1-24b-instruct": [31876, 50488],
  "@cf/mistral/mistral-small-3.1-24b-instruct": [31876, 50488], // legacy slug
  "@cf/cloudflare/clef-flash": [8182, 0], // decision model: input tokens only
};
// conservative default for unlisted models (plain llama-3.1-8b-instruct rates)
const DEFAULT_RATE = [25608, 75147];

export function rateFor(model) {
  if (!model) return DEFAULT_RATE;
  if (NEURON_RATES[model]) return NEURON_RATES[model];
  const hit = Object.keys(NEURON_RATES).find((k) => model.includes(k) || k.includes(model));
  return hit ? NEURON_RATES[hit] : DEFAULT_RATE;
}

export function estimateTokensFromText(text) {
  // ~4 chars/token heuristic (works across EN/ZH reasonably)
  return Math.ceil(String(text || "").length / 4);
}

// tokens from a model response's usage field, whatever shape it is
export function tokensFromUsage(usage, inputFallback, outputFallback) {
  if (!usage || typeof usage !== "object") return null;
  const inp = usage.prompt_tokens ?? usage.input_tokens ?? usage.usage?.input;
  const out = usage.completion_tokens ?? usage.output_tokens ?? usage.usage?.output;
  if (typeof inp === "number" || typeof out === "number") {
    return {
      input: typeof inp === "number" ? inp : estimateTokensFromText(inputFallback),
      output: typeof out === "number" ? out : estimateTokensFromText(outputFallback),
    };
  }
  return null;
}

export function estimateNeurons(model, inputText, outputText, usage) {
  const [rIn, rOut] = rateFor(model);
  const t = tokensFromUsage(
    usage,
    inputText,
    outputText
  ) || {
    input: estimateTokensFromText(inputText),
    output: estimateTokensFromText(outputText),
  };
  return (t.input / 1e6) * rIn + (t.output / 1e6) * rOut;
}

// ---- daily counter ----
export async function addNeurons(env, n) {
  const key = "ai:neurons:" + todayKey();
  const cur = parseFloat(await env.DOCS.get(key)) || 0;
  const next = Math.round((cur + n) * 100) / 100;
  await env.DOCS.put(key, String(next), { expirationTtl: DAY * 3 });
  return next;
}

export async function getTodayNeurons(env) {
  return parseFloat(await env.DOCS.get("ai:neurons:" + todayKey())) || 0;
}

export function neuronThreshold(env) {
  const free = parseInt(env.NEURON_FREE_LIMIT) || 10000;
  const safe = parseInt(env.NEURON_SAFE_LIMIT) || 8000;
  return { free, safe };
}

// ---- exhausted flag (per-day; auto-resets next UTC day) ----
export async function isExhausted(env) {
  const flag = await env.DOCS.get("ai:exhausted:" + todayKey());
  if (flag === "1") return true;
  const { safe } = neuronThreshold(env);
  const used = await getTodayNeurons(env);
  return used >= safe;
}

export async function markExhausted(env) {
  await env.DOCS.put("ai:exhausted:" + todayKey(), "1", { expirationTtl: DAY * 2 });
}

// ---- account-level AI.run wrapper with neuron accounting ----
// ALL Workers AI calls should go through this so routing (clef-flash)
// is counted too. Returns the raw model response.
export async function runAI(env, model, args) {
  const inputText = JSON.stringify(args);
  const res = await env.AI.run(model, args);
  let outText = "";
  let usage = null;
  if (typeof res === "string") outText = res;
  else if (res && typeof res === "object") {
    usage = res.usage || null;
    outText = res.response ?? res.text ?? JSON.stringify(res);
  }
  const est = estimateNeurons(model, inputText, outText, usage);
  await addNeurons(env, est).catch(() => {}); // never let accounting break the call
  return res;
}

// ---- quota error detection (CF rejects beyond plan) ----
export function isQuotaError(e) {
  const s = (e && (e.message || String(e))) || "";
  return /quota|limit|exceed|plan|usage|429|Too Many Requests|insufficient|capacity/i.test(s);
}

// ---- manual provider override (persistent) ----
export async function setProviderOverride(env, provider) {
  if (!provider || provider === "auto") {
    await env.DOCS.delete("ai:provider-override");
    return null;
  }
  await env.DOCS.put("ai:provider-override", provider);
  return provider;
}

export async function getProviderOverride(env) {
  return (await env.DOCS.get("ai:provider-override")) || null;
}
