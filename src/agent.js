// Core agent loop: LLM + tool-call protocol (JSON-in-message), bounded.
//
// Model selection is delegated to llm.chat() which auto-routes:
//   chat/agent tasks → AGENT_MODEL (Llama fp8-fast), code → CODE_MODEL (Mistral)
//   via clef-flash classification; free-tier exhaustion auto-switches to external API.
import { chat, TOOL_PROTOCOL, TOOLS_SCHEMA } from "./llm.js";
import { classifyTask } from "./router.js";
import { buildSystemPrompt, SKILLS } from "./skills.js";
import { runTool, listToolNames } from "./tools.js";
import { getMessages } from "./db.js";
import { getMemoryBlock } from "./memory.js";

const MAX_TOOL_ROUNDS = 4;   // safety: prevent infinite loops
const MAX_HISTORY = 30;      // messages fed back in

// Tools always available regardless of skill selection
const CORE_TOOLS = ["list_skills", "read_skill"];

export async function runAgent({ env, sessionId, userMessage, model, systemPrompt, skills }) {
  const provider = model || "auto";

  // 1. Classify task once (reused for every round → consistent routing, cheap)
  const history = await getMessages(env, sessionId, MAX_HISTORY);
  const { task, source } = await classifyTask(env, userMessage);

  const memoryBlock = await getMemoryBlock(env, 20);

  const sys = systemPrompt || buildSystemPrompt({
    enabledSkills: skills,
    memoryBlock,
  });

  // Resolve which tools are available (from enabled skills; default = all)
  let enabledToolNames;
  if (skills && skills.length) {
    enabledToolNames = new Set(CORE_TOOLS);
    for (const s of skills) {
      const sk = SKILLS[s];
      if (sk?.tools) sk.tools.forEach((t) => enabledToolNames.add(t));
    }
    enabledToolNames = [...enabledToolNames];
  } else {
    enabledToolNames = listToolNames();
  }

  const fullSystem = [
    sys,
    TOOLS_SCHEMA,
    TOOL_PROTOCOL,
    "\nOnly these tools are enabled: " + enabledToolNames.join(", "),
  ].join("\n\n");

  const messages = [
    { role: "system", content: fullSystem },
    ...history,
    { role: "user", content: userMessage },
  ];

  const toolCalls = [];
  let finalText = "";
  let lastModelInfo = null;

  // 2. Agent loop — chat() handles provider/routing/fallback per round
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const out = await chat(env, messages, { provider, task });
    lastModelInfo = out;

    const replyText = out.text ?? "";
    const parsed = tryParseToolCall(replyText);

    if (parsed && enabledToolNames.includes(parsed.tool)) {
      const result = await runTool(env, parsed.tool, parsed.args || {});
      toolCalls.push({ tool: parsed.tool, args: parsed.args, result });

      messages.push({ role: "assistant", content: replyText.trim() });
      messages.push({
        role: "user",
        content: "Tool result for " + parsed.tool + ":\n" + JSON.stringify(result, null, 2),
      });
      continue; // next round — let the model continue
    }

    finalText = replyText;
    break;
  }

  return {
    content: finalText,
    toolCalls,
    task,                       // "chat" | "agent" | "code"
    routedBy: source,           // "clef-flash" | "heuristic(...)"
    modelUsed: lastModelInfo?.model || provider,
    providerUsed: lastModelInfo?.provider || provider,
  };
}

function tryParseToolCall(text) {
  if (!text) return null;
  const t = text.trim();
  const idx = t.indexOf('{"tool"');
  if (idx === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = idx; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(t.slice(idx, i + 1));
          if (obj && typeof obj.tool === "string") return obj;
        } catch { /* not valid JSON */ }
        return null;
      }
    }
  }
  return null;
}
