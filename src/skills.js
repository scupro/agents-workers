// Skill definitions = built-in behavioral skills + vendored skill guides.
//
// Built-ins (general/code/docs/memory) shape the system prompt directly.
// Vendored skills (from github.com/mattpocock/skills, curated subset) are
// markdown guides served from static assets (/skills/*.md). The agent gets
// their name+description in the prompt and pulls full content on demand via
// the read_skill tool — keeps system prompts small (progressive disclosure).

export const SKILLS = {
  code: {
    name: "Code & Computation",
    description:
      "Write, explain, and compute code. Use exec_code to evaluate expressions. " +
      "Supports JS-style arithmetic, JSON, and safe pure functions.",
    prompt: [
      "You are a coding assistant.",
      "When the user asks for code or a calculation, you may use the exec_code tool.",
      "Keep executed snippets short and safe: no I/O, no network, no filesystem.",
      "Return results clearly, with explanations where helpful.",
    ].join("\n"),
    tools: ["exec_code"],
  },

  docs: {
    name: "Document Management",
    description:
      "Create, read, and list documents stored in KV. Use doc_write / doc_read / list_docs.",
    prompt: [
      "You manage a document store (KV-backed).",
      "Use doc_write to save content under a key (e.g. 'notes/2025-09-01.md').",
      "Use doc_read to retrieve a doc, and list_docs to browse keys.",
      "Suggest sensible key names when the user doesn't specify one.",
    ].join("\n"),
    tools: ["doc_read", "doc_write", "list_docs"],
  },

  memory: {
    name: "Long-term Memory",
    description: "Persist facts across sessions via memory_set / memory_get / list_memory.",
    prompt: [
      "You have long-term memory backed by key-value storage.",
      "When the user shares a preference, fact, or decision that should persist, save it with memory_set.",
      "When asked something you might have stored, check memory_get / list_memory before answering.",
      "Keep memory entries short and factual.",
    ].join("\n"),
    tools: ["memory_set", "memory_get", "list_memory"],
  },

  general: {
    name: "General Assistant",
    description: "Default persona: helpful, concise, bilingual (English + 中文).",
    prompt: [
      "You are OffCode, a helpful general-purpose AI assistant deployed on Cloudflare Workers.",
      "Be concise. Match the user's language (default to their language).",
      "If you use a tool, respond with ONLY the tool JSON.",
    ].join("\n"),
    tools: [],
  },
};

// ---- Vendored skills (mattpocock/skills — curated common set) ----
// Source: https://github.com/mattpocock/skills  (MIT)
// Files: public/skills/<id>.md, manifest public/skills/index.json
export const VENDOR_SKILLS = [
  { id: "tdd", name: "Test-Driven Development",
    description: "Red→green loop discipline: tests at agreed seams, anti-patterns, mocking rules.",
    when: "user builds features or fixes bugs test-first" },
  { id: "code-review", name: "Two-axis Code Review",
    description: "Review a diff on Standards + Spec axes and report side by side.",
    when: "user asks to review changes / a branch / a PR" },
  { id: "implement", name: "Implement from Spec",
    description: "Implement work from a spec or tickets; use TDD, then code-review, then commit.",
    when: "user asks to implement a spec / ticket / plan" },
  { id: "pr", name: "PR Writing",
    description: "PR body template: Summary, Evidence (before/after), Merge Danger, Blast Radius.",
    when: "user asks to write/draft a pull-request description" },
  { id: "research", name: "Primary-source Research",
    description: "Investigate against primary sources; capture findings as Markdown with citations.",
    when: "user wants a topic researched / docs gathered" },
];

export function vendorSkillList() {
  return VENDOR_SKILLS.map((s) => ({ id: s.id, name: s.name, description: s.description }));
}

export async function loadVendorSkill(env, id) {
  const known = VENDOR_SKILLS.find((s) => s.id === id);
  if (!known) return null;
  if (env.ASSETS) {
    const res = await env.ASSETS.fetch(new Request("https://assets/skills/" + id + ".md"));
    if (res.ok) return res.text();
  }
  return null;
}

// ---- System prompt assembly ----
export function buildSystemPrompt({ enabledSkills, memoryBlock, agentName = "OffCode" }) {
  const parts = [];
  parts.push(
    "You are " + agentName + ", an AI agent running on Cloudflare Workers (free tier). " +
    "You use multi-model routing internally (chat/agent → Llama, code → Mistral)."
  );

  const skills = enabledSkills?.length
    ? enabledSkills.map((s) => SKILLS[s]).filter(Boolean)
    : Object.values(SKILLS);

  for (const s of skills) {
    parts.push("## Skill: " + s.name + "\n" + s.description + "\n" + s.prompt);
  }

  // Vendored skills: advertise, load on demand
  parts.push(
    "## Skill guides available (load with read_skill when relevant)\n" +
    VENDOR_SKILLS.map((s) => `- ${s.id}: ${s.description} [use when: ${s.when}]`).join("\n") +
    "\nCall {\"tool\":\"read_skill\",\"args\":{\"id\":\"<id>\"}} to fetch the full guide, then follow it."
  );

  if (memoryBlock && memoryBlock !== "(no stored memories yet)") {
    parts.push("## Long-term memory (stored)\n" + memoryBlock);
  }

  return parts.join("\n\n");
}
