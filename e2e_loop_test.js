// E2E loop: mocked AI script → agent loop runs tool calls incl. read_skill
// against the REAL vendored skill files served via ASSETS mock.
import { runAgent } from "./src/agent.js";
import fs from "node:fs";

const kv = new Map();
const month = new Date().toISOString().slice(0, 7);

// Scripted LLM: clef router call → task; then rounds of assistant replies
let aiRound = 0;
const script = [
  JSON.stringify({ tool: "read_skill", args: { id: "pr" } }),          // round 0
  "I have loaded the PR skill. Here is your PR body:\n## Summary\n…",   // round 1 → final
];

const env = {
  DOCS: {
    put: async (k, v) => { kv.set(k, v); },
    get: async (k) => (kv.has(k) ? kv.get(k) : null),
    delete: async (k) => { kv.delete(k); },
    list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
  },
  DB: {
    batch: async (qs) => qs.map(() => ({})),
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
      all: async () => ({ results: [] }),
    }),
  },
  AI: {
    run: async (model, args) => {
      if (model.includes("clef")) {
        return { answers: { task: { choice: "agent" } } };
      }
      const reply = script[aiRound++];
      if (reply === undefined) return "done.";
      return { response: reply };
    },
  },
  ASSETS: {
    fetch: async (req) => {
      const p = new URL(req.url).pathname; // /skills/pr.md
      const file = "./public" + p;         // assets dir root = public/
      if (fs.existsSync(file)) {
        return new Response(fs.readFileSync(file), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  },
};

const res = await runAgent({
  env,
  sessionId: "s1",
  userMessage: "help me write a PR description for my changes",
  model: "auto",
});

console.log("task:", res.task, "| routedBy:", res.routedBy);
console.log("modelUsed:", res.modelUsed);
console.log("toolCalls:", res.toolCalls.map((t) => t.tool + ":" + (t.result.result.found ? "ok" : "miss")));
console.log("content:", res.content.slice(0, 80));

const skillOk =
  res.task === "agent" &&
  res.routedBy === "clef-flash" &&
  res.toolCalls.length === 1 &&
  res.toolCalls[0].tool === "read_skill" &&
  res.toolCalls[0].result.result.found === true &&
  res.toolCalls[0].result.result.content.includes("## Summary") &&
  res.modelUsed === "@cf/meta/llama-3.1-8b-instruct-fp8-fast";

// verify code task routing picks mistral
const res2 = await runAgent({
  env: { ...env, AI: { run: async (model) => model.includes("clef")
    ? { answers: { task: { choice: "code" } } }
    : "```js\nconst x=1;\n```" } },
  sessionId: "s2",
  userMessage: "write code",
  model: "auto",
});
const codeOk = res2.task === "code" && res2.modelUsed === "@cf/mistralai/mistral-small-3.1-24b-instruct";

console.log(skillOk && codeOk ? "\nLOOP E2E PASSED" : "\nLOOP E2E FAILED");
process.exit(skillOk && codeOk ? 0 : 1);
