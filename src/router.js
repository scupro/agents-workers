// Model router: classify the task, pick the model role.
//
// Roles (env-configurable):
//   ROUTER_MODEL — @cf/cloudflare/clef-flash (decision model: routing & judgments)
//   AGENT_MODEL  — @cf/meta/llama-3.1-8b-instruct-fp8-fast (agent tasks / general chat)
//   CODE_MODEL   — @cf/mistral/mistral-small-3.1-24b-instruct (code writing/review)
//
// classifyTask() first tries clef-flash (structured decision API).
// Any failure (dev mode, no binding, quota) falls back to keyword heuristic,
// so the agent never breaks because routing is unavailable.
// Calls go through runAI() so routing neurons are counted too.

import { runAI } from "./usage.js";

export const TASKS = ["chat", "agent", "code"];

export function roleModels(env) {
  return {
    router: env.ROUTER_MODEL || "@cf/cloudflare/clef-flash",
    agent: env.AGENT_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
    agentFallback: env.AGENT_MODEL_FALLBACK || "@cf/meta/llama-3.1-8b-instruct-fp8",
    // pricing docs (Oct 2026) list @cf/mistralai/…; older posts used @cf/mistral/…
    code: env.CODE_MODEL || "@cf/mistralai/mistral-small-3.1-24b-instruct",
    codeFallback: env.CODE_MODEL_FALLBACK || "@cf/mistral/mistral-small-3.1-24b-instruct",
  };
}

export function modelForTask(env, task) {
  const m = roleModels(env);
  if (task === "code") return m.code;
  return m.agent; // chat & agent both use the agent model
}

// ---- clef-flash classification ----
export async function classifyTask(env, text, recentContext = "") {
  const state = recentContext
    ? "Recent conversation:\n" + recentContext.slice(-600) + "\n\nCurrent user message:\n" + text
    : text;

  try {
    const res = await env.AI.run(roleModels(env).router, {
      model: "clef-flash",
      state,
      questions: {
        task: {
          type: "choice",
          instructions:
            "Which kind of response does the current user message need?",
          criteria: {
            code: "Writing, explaining, reviewing, or debugging code; code snippets; tests; PRs",
            agent: "Multi-step task: use tools, save/read docs or memory, browse, orchestrate work",
            chat: "Simple question, translation, brainstorming, or conversational reply",
          },
        },
      },
    });
    const chosen = res?.answers?.task?.choice ?? res?.answers?.task?.selected;
    if (TASKS.includes(chosen)) return { task: chosen, source: "clef-flash" };
    // answers format may differ slightly; try probabilities map
    const probs = res?.answers?.task?.options || res?.answers?.task?.probabilities;
    if (probs && typeof probs === "object") {
      let best = null, bestP = -1;
      for (const [k, v] of Object.entries(probs)) {
        const p = typeof v === "object" ? (v.probability ?? 0) : Number(v) || 0;
        if (TASKS.includes(k) && p > bestP) { best = k; bestP = p; }
      }
      if (best) return { task: best, source: "clef-flash" };
    }
    throw new Error("unexpected clef response");
  } catch (e) {
    // Router model unavailable → heuristic. Never block the chat over routing.
    return { task: heuristicTask(text), source: "heuristic(" + (e.message || "err").slice(0, 40) + ")" };
  }
}

// ---- keyword heuristic fallback ----
const CODE_WORDS = /\b(code|function|bug|debug|compile|stack trace|error|api|regex|sql|python|javascript|typescript|json|html|css|git|commit|refactor|unit test|tdd|implement|review (this|my|the) (code|pr)|write.*(script|program)|snippet)\b|```/i;
const AGENT_WORDS = /\b(save|remember|store|document|notes?|file|folder|list (docs|memories)|research|search|compare|check|organize|plan|schedule|track|todo|report)\b|保存|記住的|文件|寫成|整理/i;

export function heuristicTask(text) {
  const t = String(text || "");
  if (CODE_WORDS.test(t)) return "code";
  if (AGENT_WORDS.test(t)) return "agent";
  return "chat";
}
