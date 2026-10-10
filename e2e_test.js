// Unit tests for router.js + usage-aware llm.js (all with mocks, no network)
import { classifyTask, heuristicTask, modelForTask, roleModels } from "./src/router.js";
import { chat, providerStatus } from "./src/llm.js";
import { estimateNeurons, todayKey, NEURON_RATES } from "./src/usage.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  PASS", name); }
  else { fail++; console.log("  FAIL", name); }
}

function mockEnv({ aiHandler, kv = new Map(), vars = {}, fetchImpl } = {}) {
  const env = {
    DOCS: {
      get: async (k) => (kv.has(k) ? kv.get(k) : null),
      put: async (k, v) => { kv.set(k, v); },
      delete: async (k) => { kv.delete(k); },
    },
    AI: { run: async (model, args) => aiHandler ? aiHandler(model, args) : (() => { throw new Error("no mock AI"); })() },
    ...vars,
  };
  if (fetchImpl) globalThis.fetch = fetchImpl;
  return env;
}

// ---------- 1. heuristic routing ----------
console.log("heuristic classification:");
ok("code keywords → code", heuristicTask("please write a python function to sort") === "code");
ok("``` fence → code", heuristicTask("fix this:\n```\nlet x=1\n```") === "code");
ok("save/document → agent", heuristicTask("save this as a document and remember it") === "agent");
ok("整理/寫成 → agent", heuristicTask("幫我把重點整理寫成筆記") === "agent");
ok("plain hello → chat", heuristicTask("hello, how are you?") === "chat");

// ---------- 2. clef-flash success path ----------
console.log("clef-flash router:");
{
  const env = mockEnv({
    aiHandler: async (model, args) => {
      if (model !== "@cf/cloudflare/clef-flash") throw new Error("wrong router model " + model);
      if (!args.questions?.task) throw new Error("missing task question");
      return { answers: { task: { choice: "code" } } };
    },
  });
  const r = await classifyTask(env, "some message");
  ok("clef choice → code", r.task === "code" && r.source === "clef-flash");
}
{
  const env = mockEnv({
    aiHandler: async () => ({ answers: { task: { options: { chat: { probability: 0.7 }, code: { probability: 0.2 }, agent: { probability: 0.1 } } } } }),
  });
  const r = await classifyTask(env, "hi");
  ok("clef probabilities → chat", r.task === "chat" && r.source === "clef-flash");
}
{
  const env = mockEnv({ aiHandler: async () => { throw new Error("AI binding not available"); } });
  const r = await classifyTask(env, "write me a regex for email validation");
  ok("clef failure → heuristic fallback", r.task === "code" && r.source.startsWith("heuristic"));
}

// ---------- 3. model role mapping ----------
{
  const env = mockEnv({});
  const m = roleModels(env);
  ok("code → mistralai", modelForTask(env, "code") === "@cf/mistralai/mistral-small-3.1-24b-instruct");
  ok("agent → llama fast", modelForTask(env, "agent") === "@cf/meta/llama-3.1-8b-instruct-fp8-fast");
  ok("chat → llama fast", modelForTask(env, "chat") === "@cf/meta/llama-3.1-8b-instruct-fp8-fast");
  ok("fallback is plain fp8", m.agentFallback === "@cf/meta/llama-3.1-8b-instruct-fp8");
}

// ---------- 3b. neuron estimation ----------
console.log("neuron estimation:");
{
  // exact usage tokens: 1000 in / 500 out on llama fast
  const n = estimateNeurons(
    "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
    "x".repeat(4000), "y".repeat(2000),
    { prompt_tokens: 1000, completion_tokens: 500 }
  );
  const expect = (1000 / 1e6) * 4119 + (500 / 1e6) * 34868; // 4.119 + 17.434 = 21.55
  ok("uses usage tokens when present", Math.abs(n - expect) < 0.01);
}
{
  // no usage → chars/4 heuristic
  const n = estimateNeurons("@cf/meta/llama-3.1-8b-instruct-fp8-fast", "x".repeat(4000), "y".repeat(4000));
  const expect = (1000 / 1e6) * 4119 + (1000 / 1e6) * 34868;
  ok("heuristic fallback chars/4", Math.abs(n - expect) < 0.01);
}
{
  const n = estimateNeurons("@cf/cloudflare/clef-flash", "x".repeat(4000), "answer");
  ok("clef input-only rate", Math.abs(n - (1000 / 1e6) * 8182) < 0.01);
}
{
  const n = estimateNeurons("@cf/unknown/model-x", "x".repeat(4000), "y".repeat(4000));
  ok("unknown model → conservative default", n > 0 && Math.abs(n - ((1000/1e6)*25608 + (1000/1e6)*75147)) < 0.01);
}

// ---------- 4. chat() provider decision ----------
console.log("provider decision:");
{
  // normal: workers AI used, neurons recorded today
  const kv = new Map();
  const calls = [];
  const env = mockEnv({
    kv,
    aiHandler: async (model, args) => { calls.push(model); return { response: "llama answer", usage: { prompt_tokens: 800, completion_tokens: 120 } }; },
    vars: { LLM_API_KEY: "sk-test", LLM_BASE_URL: "https://api.openai.com/v1" },
  });
  const out = await chat(env, [{ role: "user", content: "hi there" }], { provider: "auto" });
  ok("auto → workers_ai used", out.provider === "workers_ai");
  ok("router model called", calls[0] === "@cf/cloudflare/clef-flash");
  const neurons = parseFloat(kv.get("ai:neurons:" + todayKey()));
  // llama: 800 in → 3.3 + 120 out → 4.18 ≈ 7.5 neurons
  ok("neurons recorded (>0)", neurons > 0);
  ok("neurons sane magnitude (<50)", neurons < 50);
}
{
  // exhausted today → auto external, zero Workers AI calls
  const kv = new Map([["ai:exhausted:" + todayKey(), "1"]]);
  let aiCalled = false;
  const env = mockEnv({
    kv,
    aiHandler: async () => { aiCalled = true; return "should not happen"; },
    vars: { LLM_API_KEY: "sk-test", LLM_BASE_URL: "https://test.local/v1", LLM_MODEL: "test-model" },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "external answer" } }] }), { status: 200 }),
  });
  const out = await chat(env, [{ role: "user", content: "hi" }], { provider: "auto" });
  ok("exhausted → external", out.provider === "custom" && out.text === "external answer" && !aiCalled);
}
{
  // runtime quota error → mark exhausted + fall to external
  const kv = new Map();
  const env = mockEnv({
    kv,
    aiHandler: async (model) => {
      if (model.includes("clef")) return { answers: { task: { choice: "chat" } } };
      throw new Error("AI inference failed: quota exceeded, please try later");
    },
    vars: { LLM_API_KEY: "sk-test", LLM_BASE_URL: "https://test.local/v1", LLM_MODEL: "test-model" },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "rescued by external" } }] }), { status: 200 }),
  });
  const out = await chat(env, [{ role: "user", content: "hi" }], { provider: "auto" });
  ok("quota error → external rescue", out.provider === "custom" && out.text === "rescued by external");
  ok("exhausted flag persisted (today)", kv.get("ai:exhausted:" + todayKey()) === "1");
}
{
  // manual override openai wins over auto
  const kv = new Map([["ai:provider-override", "custom"]]);
  const env = mockEnv({
    kv,
    vars: { LLM_API_KEY: "sk-test", LLM_BASE_URL: "https://test.local/v1", LLM_MODEL: "test-model" },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "forced external" } }] }), { status: 200 }),
  });
  const out = await chat(env, [{ role: "user", content: "hi" }], { provider: "auto" });
  ok("override → custom", out.provider === "custom" && out.text === "forced external");
}
{
  // neurons over safe threshold → auto external (no error needed)
  const kv = new Map([["ai:neurons:" + todayKey(), "8500"]]); // > default safe 8000
  let aiCalled = false;
  const env = mockEnv({
    kv,
    aiHandler: async () => { aiCalled = true; return "nope"; },
    vars: { LLM_API_KEY: "sk-test", LLM_BASE_URL: "https://test.local/v1", LLM_MODEL: "test-model" },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "past threshold → external" } }] }), { status: 200 }),
  });
  const out = await chat(env, [{ role: "user", content: "hi" }], { provider: "auto" });
  ok("neurons ≥ safe → external", out.provider === "custom" && !aiCalled);
}
{
  // new UTC day resets the counter automatically (date-scoped keys)
  const yesterday = "2000-01-01";
  const kv = new Map([["ai:exhausted:" + yesterday, "1"], ["ai:neurons:" + yesterday, "99999"]]);
  const env = mockEnv({
    kv,
    aiHandler: async () => "fresh day free tier",
  });
  const out = await chat(env, [{ role: "user", content: "hi" }], { provider: "auto" });
  ok("yesterday's exhaustion doesn't leak today", out.provider === "workers_ai");
}
{
  // -fast model missing → fallback chain to plain fp8
  const tried = [];
  const kv = new Map();
  const env = mockEnv({
    kv,
    aiHandler: async (model) => {
      tried.push(model);
      if (model.includes("clef")) return { answers: { task: { choice: "agent" } } };
      if (model.endsWith("-fast")) throw new Error("model not found: " + model);
      return "fp8 fallback answer";
    },
  });
  const out = await chat(env, [{ role: "user", content: "list my docs" }], { provider: "auto" });
  ok("fallback chain works", out.model === "@cf/meta/llama-3.1-8b-instruct-fp8" && out.text === "fp8 fallback answer");
  ok("tried fast first", tried.includes("@cf/meta/llama-3.1-8b-instruct-fp8-fast"));
}
{
  // forced workers_ai with no key: never touches external even when exhausted
  const kv = new Map([["ai:exhausted:" + todayKey(), "1"]]);
  const env = mockEnv({
    kv,
    aiHandler: async () => "forced free answer",
  });
  const out = await chat(env, [{ role: "user", content: "hi" }], { provider: "workers_ai" });
  ok("forced workers_ai respects choice", out.provider === "workers_ai" && out.text === "forced free answer");
}

// ---------- 5. providerStatus shape ----------
{
  const env = mockEnv({ vars: { LLM_API_KEY: "sk-x", LLM_BASE_URL: "https://test.local/v1", LLM_MODEL: "test-model" } });
  const st = await providerStatus(env);
  ok("status has neuron fields", typeof st.neuronsToday === "number" && st.freeNeuronsPerDay === 10000 && st.safeThreshold === 8000);
  ok("status has models", st.models.code.includes("mistral-small-3.1-24b"));
  ok("status providers list", st.providers.some((p) => p.id === "custom"));
  ok("rate table covers all role models", [st.models.agent, st.models.agentFallback, st.models.code, st.models.router]
    .every((m) => NEURON_RATES[m]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
