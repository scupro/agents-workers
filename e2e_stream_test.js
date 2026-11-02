import { handleChat } from "./src/routes.js";

const kv = new Map();
const rows = [];
const mkEnv = (extra = {}) => ({
  DOCS: { put: async (k, v) => kv.set(k, v), get: async (k) => kv.get(k) ?? null, delete: async (k) => kv.delete(k),
          list: async () => ({ keys: [] }) },
  DB: {
    batch: async (qs) => { for (const q of qs) if (q.sql?.startsWith("INSERT INTO messages")) rows.push(q.args); return []; },
    prepare: (sql) => ({ sql, bind: (...args) => ({ sql, args,
      first: async () => ({ id: "s" }),
      all: async () => ({ results: [] }) }) }),
  },
  ...extra,
});
const sse = (chunks) => new ReadableStream({ start(c) { const e = new TextEncoder();
  for (const x of chunks) c.enqueue(e.encode(x)); c.close(); } });

async function call(env, body = {}) {
  const waits = [];
  const res = await handleChat(new Request("http://x/api/chat", { method: "POST", body: JSON.stringify({ message: "hello there", model: "workers_ai", ...body }) }), env, { waitUntil: (p) => waits.push(p) });
  const text = await res.text(); await Promise.all(waits);
  const events = text.split("\n\n").map((b) => b.split("\n").find((l) => l.startsWith("data:"))).filter(Boolean).map((l) => JSON.parse(l.slice(5)));
  return { res, events, text };
}
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

// 1. Workers AI streaming (clef router fails → heuristic; stream:true used)
let aiArgs;
const env1 = mkEnv({ AI: { run: async (model, args) => {
  if (!args.messages) throw new Error("router down");
  aiArgs = args;
  return sse(['data: {"response":"Hel"}\n\n','data: {"response":"lo!"}\n\n','data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n','data: [DONE]\n\n']);
} } });
let r = await call(env1);
ok(/event-stream/.test(r.res.headers.get("content-type")), "content-type is SSE");
ok(aiArgs?.stream === true, "Workers AI called with stream:true");
ok(r.events.filter((e) => e.type === "delta").map((e) => e.text).join("") === "Hello!", "deltas assemble to 'Hello!'");
ok(r.events.at(-1).type === "done" && r.events.at(-1).content === "Hello!", "done event carries full content");
ok(rows.some((a) => a.includes("assistant") && a.includes("Hello!")), "assistant message persisted to D1");
ok(parseFloat(kv.get([...kv.keys()].find((k) => k.startsWith("ai:neurons:")))) > 0, "neurons counted for stream");

// 2. Custom API SSE streaming
let sentBody;
globalThis.fetch = async (u, init) => { sentBody = JSON.parse(init.body);
  return new Response(sse(['data: {"choices":[{"delta":{"content":"Hi "}}]}\r\n\r\n','data: {"choices":[{"delta":{"content":"there"}}]}\n\n','data: [DONE]\n\n']), { headers: { "content-type": "text/event-stream" } }); };
const env2 = mkEnv({ LLM_API_KEY: "k", LLM_BASE_URL: "https://relay/v1", LLM_MODEL: "m" });
r = await call(env2, { model: "custom" });
ok(sentBody.stream === true, "custom API request has stream:true");
ok(r.events.at(-1).content === "Hi there", "custom SSE assembled: " + r.events.at(-1).content);
ok(!JSON.stringify(sentBody.messages).includes("null"), "no null in messages");

// 3. Custom relay ignores stream → plain JSON still works
globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "plain json" } }] }), { headers: { "content-type": "application/json" } });
r = await call(env2, { model: "custom" });
ok(r.events.at(-1).content === "plain json" && r.events.some((e) => e.type === "delta"), "non-stream relay falls back to single delta");

// 4. Tool call is buffered (never shown as text), then final answer streams
let n = 0; const e = new TextEncoder();
globalThis.fetch = async () => { n++;
  const parts = n === 1 ? ['{"tool":"list_docs",', '"args":{}}'] : ["Done ", "listing."];
  return new Response(sse(parts.map((p) => "data: " + JSON.stringify({ choices: [{ delta: { content: p } }] }) + "\n\n")), { headers: { "content-type": "text/event-stream" } }); };
r = await call(env2, { model: "custom", message: "please list docs" });
const deltaText = r.events.filter((x) => x.type === "delta").map((x) => x.text).join("");
ok(!deltaText.includes('"tool"'), "tool-call JSON not leaked as delta");
ok(deltaText === "Done listing.", "final answer streamed: " + deltaText);
ok(r.events.some((x) => x.type === "tool" && x.tool === "list_docs"), "tool event emitted");

// 5. Error → error event, stream closes
globalThis.fetch = async () => new Response("boom", { status: 524 });
r = await call(env2, { model: "custom" });
ok(r.events.at(-1).type === "error" && /524/.test(r.events.at(-1).error), "upstream 524 surfaced as error event");

// 6. Heartbeat keeps bytes flowing during a slow model (patch interval to 50ms)
const realSI = globalThis.setInterval; globalThis.setInterval = (f) => realSI(f, 50);
globalThis.fetch = async () => { await new Promise((r) => setTimeout(r, 400));
  return new Response(sse(['data: {"choices":[{"delta":{"content":"late"}}]}\n\n']), { headers: { "content-type": "text/event-stream" } }); };
r = await call(env2, { model: "custom" });
globalThis.setInterval = realSI;
ok((r.text.match(/: ping/g) || []).length >= 3, "heartbeat pings during slow model: " + (r.text.match(/: ping/g) || []).length);
ok(r.events.at(-1).content === "late", "slow reply still delivered");

// 7. stream:false legacy JSON
globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "legacy" } }] }), { headers: { "content-type": "application/json" } });
const res7 = await handleChat(new Request("http://x/api/chat", { method: "POST", body: JSON.stringify({ message: "hi there", model: "custom", stream: false }) }), env2, { waitUntil() {} });
ok((await res7.json()).content === "legacy", "stream:false returns JSON");

console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0);
