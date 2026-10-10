// Memory: persistent key-value facts (KV under "mem:" prefix)
import { getDoc, putDoc, deleteDoc, listDocs } from "./kv.js";

const MEM_PREFIX = "mem/";
function memKey(key) { return MEM_PREFIX + key; }

export async function setMemory(env, key, value, tag) {
  await putDoc(env, memKey(key), typeof value === "string" ? value : JSON.stringify(value),
    { tag: tag || null, updatedAt: new Date().toISOString() });
}

export async function getMemory(env, key) {
  const doc = await getDoc(env, memKey(key));
  return doc ? doc.content : null;
}

export async function listMemory(env) {
  const docs = await listDocs(env);
  return docs.filter((k) => k.startsWith(MEM_PREFIX)).map((k) => k.slice(MEM_PREFIX.length));
}

export async function deleteMemory(env, key) {
  await deleteDoc(env, memKey(key));
}

// Convenience: get all memory as a block for system prompt
export async function getMemoryBlock(env, maxKeys = 20) {
  const keys = await listMemory(env);
  const lines = [];
  for (const k of keys.slice(0, maxKeys)) {
    const v = await getMemory(env, k);
    if (v !== null) lines.push(`- ${k}: ${v}`);
  }
  return lines.length ? lines.join("\n") : "(no stored memories yet)";
}
