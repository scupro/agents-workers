// Minimal SSE reader shared by Workers AI streams and external OpenAI-compatible
// streams. Calls onData(payloadString) for every `data:` event (except [DONE]).
// Cheap on purpose: Workers Free has a 10 ms CPU budget, so no JSON parsing here.
export async function readSSE(stream, onData) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue; // comments / event: / blank
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") await onData(payload);
      }
    }
    const tail = buf.trim();
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== "[DONE]") await onData(payload);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

// Pull the text delta + usage out of one parsed stream chunk, whichever shape
// it has: Workers AI {response, usage} or OpenAI {choices:[{delta:{content}}], usage}.
export function chunkText(obj) {
  if (!obj || typeof obj !== "object") return "";
  if (typeof obj.response === "string") return obj.response;
  const c = obj.choices?.[0];
  const t = c?.delta?.content ?? c?.text ?? c?.message?.content;
  return typeof t === "string" ? t : "";
}
