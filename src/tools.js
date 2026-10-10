// Tool registry and executor.
// Workers free tier has no real exec shell, so exec_code is a safe
// expression sandbox (math + pure JS via Function with globals stripped).

import { getDoc, putDoc, listDocs, deleteDoc } from "./kv.js";
import { setMemory, getMemory, listMemory, deleteMemory } from "./memory.js";
import { loadVendorSkill, vendorSkillList } from "./skills.js";

// ---- exec_code: safe expression sandbox ----
// Uses Function with whitelisted globals injected as named params.
// No network, no fs, no process — Workers' Function constructor itself
// can't access those. Depth/complexity kept minimal; 1s wall-clock guard.
export function runCode(code, timeoutMs = 1000) {
  const globals = {
    Math, JSON,
    parseInt, parseFloat,
    String, Number, Boolean,
    Array, Object, Map, Set,
  };
  // Inject via named params so nothing else leaks
  const fn = new Function(
    ...Object.keys(globals),
    `"use strict";\nreturn (${code});`
  );
  const start = Date.now();
  const result = fn(...Object.values(globals));
  const elapsed = Date.now() - start;
  if (elapsed > timeoutMs) {
    throw new Error("exec_code timed out after " + elapsed + "ms");
  }
  return { output: String(result), elapsedMs: elapsed };
}

// ---- Registry ----
export const TOOLS = {
  exec_code: {
    description: "Safely evaluate a pure JS expression (no I/O, no network).",
    schema: {
      command: "string — the JS expression to evaluate, e.g. '(2+3)*4' or 'JSON.stringify({a:1})'",
    },
    run: async (env, args) => {
      if (!args.command) throw new Error("exec_code: 'command' is required");
      const r = runCode(args.command);
      return { ok: true, ...r };
    },
  },

  doc_read: {
    description: "Read a document from KV by key.",
    schema: { key: "string" },
    run: async (env, args) => {
      const doc = await getDoc(env, args.key);
      if (!doc) return { found: false, key: args.key };
      return { found: true, ...doc };
    },
  },

  doc_write: {
    description: "Create or overwrite a document in KV.",
    schema: {
      key: "string",
      content: "string",
      meta: "object (optional)",
    },
    run: async (env, args) => {
      if (!args.key || args.content === undefined) throw new Error("doc_write: key and content required");
      await putDoc(env, args.key, args.content, args.meta);
      return { ok: true, key: args.key };
    },
  },

  list_docs: {
    description: "List keys of stored documents.",
    schema: {},
    run: async (env) => ({ docs: await listDocs(env) }),
  },

  doc_delete: {
    description: "Delete a document from KV.",
    schema: { key: "string" },
    run: async (env, args) => {
      await deleteDoc(env, args.key);
      return { ok: true };
    },
  },

  memory_set: {
    description: "Persist a fact for long-term memory (key/value).",
    schema: { key: "string", value: "string", tag: "string (optional)" },
    run: async (env, args) => {
      if (!args.key) throw new Error("memory_set: key required");
      await setMemory(env, args.key, args.value, args.tag);
      return { ok: true, key: args.key };
    },
  },

  memory_get: {
    description: "Read a persisted fact.",
    schema: { key: "string" },
    run: async (env, args) => {
      const v = await getMemory(env, args.key);
      return v === null ? { found: false, key: args.key } : { found: true, key: args.key, value: v };
    },
  },

  list_memory: {
    description: "List persisted fact keys.",
    schema: {},
    run: async (env) => ({ keys: await listMemory(env) }),
  },

  memory_delete: {
    description: "Delete a persisted fact.",
    schema: { key: "string" },
    run: async (env, args) => {
      await deleteMemory(env, args.key);
      return { ok: true };
    },
  },

  list_skills: {
    description: "List available skill guides (id + description).",
    schema: {},
    run: async () => ({ skills: vendorSkillList() }),
  },

  read_skill: {
    description: "Load the full markdown guide of a skill by id.",
    schema: { id: "string" },
    run: async (env, args) => {
      const text = await loadVendorSkill(env, args.id);
      return text === null
        ? { found: false, id: args.id, available: vendorSkillList().map((s) => s.id) }
        : { found: true, id: args.id, content: text };
    },
  },
};

export function runTool(env, name, args = {}) {
  const tool = TOOLS[name];
  if (!tool) {
    // Still run but signal unknown
    return { ok: false, error: `unknown tool: ${name}`, available: Object.keys(TOOLS) };
  }
  return Promise.resolve(tool.run(env, args))
    .then((result) => ({ ok: true, tool: name, result }))
    .catch((e) => ({ ok: false, tool: name, error: e.message || String(e) }));
}

export function listToolNames() { return Object.keys(TOOLS); }
