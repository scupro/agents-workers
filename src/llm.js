// LLM adapter: multi-model Workers AI + external OpenAI-compatible API,
// with automatic task routing and free-tier → external fallback.
//
// Decision flow for chat(env, messages, opts):
//   opts.provider explicit:  "custom" | "workers_ai"  → honor it
//   manual KV override       → honor it (set via /api/provider or frontend)
//   auto:                    quota exhausted? → custom API (if configured) else Workers AI anyway
//   Workers AI call errors with quota semantics → mark exhausted → retry external
//   Workers AI agent model missing (-fast removed) → retry fallback model

import { classifyTask, roleModels, heuristicTask } from "./router.js";
import {
  runAI, isExhausted, markExhausted, isQuotaError,
  getProviderOverride, getTodayNeurons, neuronThreshold,
} from "./usage.js";

export function listProviders(env) {
  const m = roleModels(env);
  const extLabel = (env.LLM_BASE_URL || "https://api.openai.com/v1").split("/")[2] || "external";
  return [
    { id: "auto", label: "Auto-route (clef-flash → " + m.agent + " / " + m.code + ")" },
    { id: "workers_ai", label: "Workers AI only (free tier)" },
    ...(env.LLM_API_KEY
      ? [{ id: "custom", label: "Custom API — " + extLabel + " (" + (env.LLM_MODEL || "model") + ")" }]
      : []),
  ];
}

// ---- Workers AI (all calls go through runAI → neuron accounting) ----
async function callWorkersAI(env, messages, model) {
  const res = await runAI(env, model, {
    messages,
    stream: false,
  });
  const text = typeof res === "string" ? res : (res?.response ?? res?.text ?? JSON.stringify(res));
  return { text, provider: "workers_ai", model };
}

// Call Workers AI with quota bookkeeping + model fallbacks.
async function callWorkersAISmart(env, messages, task) {
  const m = roleModels(env);
  const chain = task === "code"
    ? [m.code, m.codeFallback]
    : [m.agent, m.agentFallback]; // chat & agent share the Llama chain

  let lastErr;
  for (const model of chain) {
    try {
      return await callWorkersAI(env, messages, model);
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (/not found|does not exist|invalid model|deprecated/i.test(msg)) {
        continue; // try next model in chain
      }
      break; // quota or other error → handled by caller
    }
  }
  throw lastErr;
}

// ---- Custom LLM endpoint (any OpenAI-compatible format: OpenAI, OpenRouter,
// DeepSeek, Moonshot, Groq, Ollama, vLLM, local/free relays, ...) ----
async function callCustom(env, messages, task) {
  if (!env.LLM_API_KEY || !env.LLM_BASE_URL) {
    throw new Error("custom API not configured: set LLM_API_KEY + LLM_BASE_URL (env vars / GitHub Secrets)");
  }
  const base = env.LLM_BASE_URL.replace(/\/+$/, "");
  const model = (task === "code" && env.LLM_CODE_MODEL) || env.LLM_MODEL;
  if (!model) throw new Error("custom API selected but LLM_MODEL is not set");
  const res = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.LLM_AUTH_HEADER ? { [env.LLM_AUTH_HEADER]: env.LLM_API_KEY } : { Authorization: "Bearer " + env.LLM_API_KEY }),
    },
    body: JSON.stringify({ model, messages, temperature: 0.4 }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("custom API " + res.status + ": " + t.slice(0, 300));
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  return {
    text: msg?.content ?? "",
    tool_calls: msg?.tool_calls,
    provider: "custom",
    model,
  };
}

export function customApiConfigured(env) {
  return !!(env.LLM_API_KEY && env.LLM_BASE_URL && env.LLM_MODEL);
}

// ---- Unified entry ----
// opts: { provider?: "auto"|"workers_ai"|"custom", task?: "chat"|"agent"|"code" }
export async function chat(env, messages, opts = {}) {
  let provider = opts.provider || "auto";

  // Manual override wins over "auto"
  if (provider === "auto") {
    const ov = await getProviderOverride(env).catch(() => null);
    if (ov) provider = ov;
  }

  // Fast path: auto + free-tier exhausted + custom API available →
  // skip Workers AI entirely (don't burn quota on clef-flash routing either).
  // Task pick for custom uses the zero-cost keyword heuristic.
  if (provider === "auto") {
    const exhausted = await isExhausted(env).catch(() => false);
    if (exhausted && customApiConfigured(env)) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const task = opts.task || heuristicTask(lastUser?.content || "");
      return callCustom(env, messages, task);
    }
  }

  // Determine task (for model selection)
  let task = opts.task || null;
  if (!task && provider !== "custom") {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const prior = messages.filter((m) => m.role === "user").slice(0, -1).map((m) => m.content).join("\n");
    task = (await classifyTask(env, lastUser?.content || "", prior)).task;
  }
  task = task || "chat";

  if (provider === "custom") {
    return callCustom(env, messages, task);
  }

  if (provider === "workers_ai") {
    // Forced free tier: call even if exhausted (user explicitly asked)
    return callWorkersAISmart(env, messages, task);
  }

  // provider === "auto" (not exhausted — handled by fast path above)
  try {
    return await callWorkersAISmart(env, messages, task);
  } catch (e) {
    if (customApiConfigured(env) && isQuotaError(e)) {
      await markExhausted(env).catch(() => {});
      return callCustom(env, messages, task);
    }
    throw e;
  }
}

// Status for /api/status + frontend display
export async function providerStatus(env) {
  const m = roleModels(env);
  const { free, safe } = neuronThreshold(env);
  return {
    models: m,
    neuronsToday: await getTodayNeurons(env).catch(() => 0), // estimate, see usage.js
    freeNeuronsPerDay: free,
    safeThreshold: safe,
    exhausted: await isExhausted(env).catch(() => false),
    override: await getProviderOverride(env).catch(() => null),
    customConfigured: customApiConfigured(env),
    providers: listProviders(env),
  };
}

// Tool-use protocol (works on any model, including those without native function calling)
export const TOOL_PROTOCOL = `
You have a tool-calling protocol. If you decide to use a tool, you MUST respond with ONLY a JSON object of the form:
{"tool": "<tool_name>", "args": {...}}
where <tool_name> is one of the available tools and args matches its schema.
Do not write anything other than that single JSON object when calling a tool.
If no tool is needed, answer normally in prose.
`;

export const TOOLS_SCHEMA = `
Available tools:
- exec_code: evaluate a pure JS expression. args: { command: string }
- doc_read: read a stored document. args: { key: string }
- doc_write: create/overwrite a document. args: { key: string, content: string, meta?: object }
- list_docs: list stored document keys. args: {}
- memory_set: persist a fact. args: { key: string, value: string, tag?: string }
- memory_get: read a persisted fact. args: { key: string }
- list_memory: list persisted fact keys. args: {}
- read_skill: load full text of a skill guide. args: { id: string }
`;
