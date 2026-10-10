// API route handlers
import { runAgent } from "./agent.js";
import { providerStatus, customApiConfigured } from "./llm.js";
import { setProviderOverride } from "./usage.js";
import { vendorSkillList } from "./skills.js";
import {
  createSession, listSessions, getSession, deleteSession,
  appendMessage, getMessages,
} from "./db.js";
import { putDoc, getDoc, listDocs, deleteDoc } from "./kv.js";
import { setMemory, getMemory, listMemory, deleteMemory } from "./memory.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

async function readBody(request) {
  try { return await request.json(); }
  catch { return {}; }
}

// normalize provider name sent from frontend
function normalizeProvider(p) {
  if (p === "openai") return "custom"; // frontend MAY still send "openai"; normalize
  return ["auto", "workers_ai", "custom"].includes(p) ? p : null;
}

// POST /api/chat  { sessionId?, message, model? (provider) }
export async function handleChat(request, env, ctx) {
  const body = await readBody(request);
  const message = String(body.message ?? "");
  if (!message.trim()) return jsonResponse({ error: "message is required" }, 400);

  let sessionId = body.sessionId;
  if (sessionId) {
    const s = await getSession(env, sessionId);
    if (!s) return jsonResponse({ error: "session not found" }, 404);
  } else {
    sessionId = crypto.randomUUID();
    await createSession(env, sessionId, message.slice(0, 60), body.owner);
  }

  await appendMessage(env, sessionId, "user", message);

  try {
    const result = await runAgent({
      env,
      sessionId,
      userMessage: message,
      model: normalizeProvider(body.model), // "auto" | "workers_ai" | "custom" | null
      systemPrompt: body.systemPrompt,
      skills: body.skills,
    });

    await appendMessage(env, sessionId, "assistant", result.content,
      result.toolCalls?.length ? result.toolCalls[0].tool : null,
      null,
      result.toolCalls?.length ? JSON.stringify(result.toolCalls) : null);

    return jsonResponse({
      sessionId,
      content: result.content,
      toolCalls: result.toolCalls,
      modelUsed: result.modelUsed,
      providerUsed: result.providerUsed,
      task: result.task,
      routedBy: result.routedBy,
    });
  } catch (e) {
    console.error("chat error:", e);
    return jsonResponse({ error: e.message || String(e), sessionId }, 500);
  }
}

// /api/sessions  GET all, POST create, DELETE ?id=
export async function handleSessions(request, env, ctx) {
  switch (request.method) {
    case "GET":
      return jsonResponse(await listSessions(env));
    case "POST": {
      const body = await readBody(request);
      const id = crypto.randomUUID();
      await createSession(env, id, body.title || "New chat", body.owner);
      return jsonResponse({ id, title: body.title || "New chat" });
    }
    case "DELETE": {
      const id = new URL(request.url).searchParams.get("id");
      if (!id) return jsonResponse({ error: "id required" }, 400);
      await deleteSession(env, id);
      return jsonResponse({ ok: true });
    }
    default:
      return jsonResponse({ error: "method not allowed" }, 405);
  }
}

// GET /api/messages?sessionId=
export async function handleMessages(request, env, ctx) {
  const id = new URL(request.url).searchParams.get("sessionId");
  if (!id) return jsonResponse({ error: "sessionId required" }, 400);
  return jsonResponse(await getMessages(env, id));
}

// /api/docs
export async function handleDocs(request, env, ctx) {
  switch (request.method) {
    case "GET": {
      const key = new URL(request.url).searchParams.get("key");
      if (key) {
        const doc = await getDoc(env, key);
        return doc ? jsonResponse(doc) : jsonResponse({ error: "not found" }, 404);
      }
      return jsonResponse({ docs: await listDocs(env) });
    }
    case "POST": {
      const body = await readBody(request);
      if (!body.key || body.content === undefined)
        return jsonResponse({ error: "key and content required" }, 400);
      await putDoc(env, body.key, body.content, body.meta);
      return jsonResponse({ ok: true, key: body.key });
    }
    case "DELETE": {
      const key = new URL(request.url).searchParams.get("key");
      if (!key) return jsonResponse({ error: "key required" }, 400);
      await deleteDoc(env, key);
      return jsonResponse({ ok: true });
    }
    default:
      return jsonResponse({ error: "method not allowed" }, 405);
  }
}

// /api/memory
export async function handleMemory(request, env, ctx) {
  switch (request.method) {
    case "GET": {
      const key = new URL(request.url).searchParams.get("key");
      if (key) {
        const v = await getMemory(env, key);
        return v !== null ? jsonResponse({ key, value: v }) : jsonResponse({ error: "not found" }, 404);
      }
      return jsonResponse({ keys: await listMemory(env) });
    }
    case "POST": {
      const body = await readBody(request);
      if (!body.key) return jsonResponse({ error: "key required" }, 400);
      await setMemory(env, body.key, body.value, body.tag);
      return jsonResponse({ ok: true });
    }
    case "DELETE": {
      const key = new URL(request.url).searchParams.get("key");
      if (!key) return jsonResponse({ error: "key required" }, 400);
      await deleteMemory(env, key);
      return jsonResponse({ ok: true });
    }
    default:
      return jsonResponse({ error: "method not allowed" }, 405);
  }
}

export function handleHealth(env) {
  return jsonResponse({
    ok: true,
    models: {
      workers_ai: env.AGENT_MODEL || "@cf/large-fast-1",
      custom: env.LLM_MODEL || "",
    },
    customConfigured: customApiConfigured(env),
  });
}

// /api/status — richer routing status
export async function handleStatus(env) {
  return jsonResponse(await providerStatus(env));
}

// POST /api/provider  { provider: "auto"|"workers_ai"|"custom" } — manual lock
export async function handleProvider(request, env, ctx) {
  if (request.method === "GET") {
    return jsonResponse(await providerStatus(env));
  }
  const body = await readBody(request);
  const p = normalizeProvider(body.provider) || "auto";
  if (p === "custom" && !customApiConfigured(env)) {
    return jsonResponse({
      error: "custom API not configured: set LLM_API_KEY, LLM_BASE_URL, and LLM_MODEL (env secrets)",
    }, 400);
  }
  const saved = await setProviderOverride(env, p);
  return jsonResponse({ ok: true, override: saved });
}

// GET /api/skills
export function handleSkills(env) {
  return jsonResponse({ skills: vendorSkillList() });
}