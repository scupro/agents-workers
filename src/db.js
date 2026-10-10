// D1 database layer: sessions + messages
export async function createSession(env, id, title, owner) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at, owner) VALUES (?, ?, ?, ?, ?)")
      .bind(id, title, now, now, owner || null),
    env.DB.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").bind(now, id),
  ]);
}

export async function listSessions(env) {
  const res = await env.DB.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 50").all();
  return res.results || [];
}

export async function getSession(env, id) {
  const res = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
  return res;
}

export async function deleteSession(env, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE session_id = ?").bind(id),
    env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id),
  ]);
}

export async function appendMessage(env, sessionId, role, content, toolName = null, toolCallId = null, toolResult = null) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO messages (session_id, role, content, tool_name, tool_call_id, tool_result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(sessionId, role, content, toolName, toolCallId, toolResult, now),
    env.DB.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").bind(now, sessionId),
  ]);
}

export async function getMessages(env, sessionId, limit = 50) {
  const res = await env.DB.prepare(
    "SELECT role, content, tool_name, tool_call_id, tool_result, created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?"
  ).bind(sessionId, limit).all();
  return (res.results || []).reverse();
}
