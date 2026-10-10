// KV layer: document store (also used for memory under "mem:" prefix)
const PREFIX = "doc:";
const LIST_MARKER = PREFIX + "index/";

function enc(v) { return typeof v === "string" ? v : JSON.stringify(v); }
function dec(v) {
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

export async function putDoc(env, key, content, meta) {
  const full = PREFIX + key;
  await env.DOCS.put(full, enc(content), { expirationTtl: null });
  if (meta) {
    await env.DOCS.put(PREFIX + key + ".meta", enc(meta));
  }
  // keep a lightweight index for listing
  await env.DOCS.put(LIST_MARKER + key, new Date().toISOString());
}

export async function getDoc(env, key) {
  const raw = await env.DOCS.get(PREFIX + key);
  if (raw === null) return null;
  const metaRaw = await env.DOCS.get(PREFIX + key + ".meta");
  return { key, content: dec(raw), meta: metaRaw ? dec(metaRaw) : null };
}

export async function listDocs(env) {
  const res = await env.DOCS.list({ prefix: LIST_MARKER, limit: 200 });
  const keys = res.keys.map((k) => k.name.slice(LIST_MARKER.length));
  return keys;
}

export async function deleteDoc(env, key) {
  const full = PREFIX + key;
  await env.DOCS.delete(full);
  await env.DOCS.delete(full + ".meta");
  await env.DOCS.delete(LIST_MARKER + key);
}
