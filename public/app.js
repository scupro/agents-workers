// Frontend logic: chat UI, sessions, model/skill selection, local fallback store.
//
// STORAGE STRATEGY:
//   - Primary: backend D1 (sessions/messages) + KV (docs/memory) via /api/*
//   - Fallback: if /api/health fails (e.g. local dev without CF bindings),
//     session list is kept in localStorage.

const API = "";
let currentSession = null;
let sending = false;

// ---- DOM ----
const $messages = document.getElementById("messages");
const $input = document.getElementById("input");
const $send = document.getElementById("send");
const $newChat = document.getElementById("new-chat");
const $sessionList = document.getElementById("session-list");
const $chatTitle = document.getElementById("chat-title");
const $modelSelect = document.getElementById("model-select");
const $skillsSelect = document.getElementById("skills-select");
const $healthDot = document.getElementById("health-dot");

// ---- localStorage session cache (for the list UI; the backend is source of truth) ----
function localSessions() {
  try { return JSON.parse(localStorage.getItem("offcode.sessions") || "[]"); }
  catch { return []; }
}
function saveLocalSessions(list) {
  localStorage.setItem("offcode.sessions", JSON.stringify(list));
}

async function fetchSessions() {
  try {
    const r = await fetch(API + "/api/sessions");
    if (!r.ok) throw new Error();
    const data = await r.json();
    saveLocalSessions(data.map((s) => ({ id: s.id, title: s.title })));
    return data;
  } catch {
    return localSessions();
  }
}

function renderSessions() {
  $sessionList.innerHTML = "";
  fetchSessions().then((sessions) => {
    for (const s of sessions) {
      const div = document.createElement("div");
      div.className = "session-item" + (s.id === currentSession ? " active" : "");
      div.innerHTML = `<span>${escHtml(s.title)}</span><button class="del" title="Delete">×</button>`;
      div.addEventListener("click", (e) => {
        if (e.target.classList.contains("del")) {
          if (confirm("Delete this session?")) {
            fetch(API + "/api/sessions?id=" + s.id, { method: "DELETE" });
            currentSession = null;
            $chatTitle.textContent = "New chat";
            $messages.innerHTML = "";
            renderSessions();
          }
          return;
        }
        openSession(s.id, s.title);
      });
      $sessionList.appendChild(div);
    }
  });
}

function openSession(id, title) {
  currentSession = id;
  $chatTitle.textContent = title || "Session";
  $messages.innerHTML = "";
  renderSessions();
  loadMessages(id);
}

async function loadMessages(sessionId) {
  try {
    const r = await fetch(API + "/api/messages?sessionId=" + encodeURIComponent(sessionId));
    if (!r.ok) return;
    const msgs = await r.json();
    for (const m of msgs) addMsgNode(m.role, m.content, m.tool_name, m.tool_result);
  } catch { /* offline fallback: nothing */ }
}

// ---- Message rendering ----
function addMsgNode(role, content, toolName, toolResultJson) {
  const div = document.createElement("div");
  div.className = "msg " + (role === "user" ? "user" : "agent");

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = role === "user" ? "You" : "OffCode";
  div.appendChild(meta);

  const body = document.createElement("div");
  body.textContent = content || "";
  div.appendChild(body);

  if (toolName) {
    const block = document.createElement("div");
    block.className = "tool-block";
    const result = toolResultJson ? safeJson(toolResultJson) : "";
    block.textContent = "🔧 " + toolName + "\n" + String(result).slice(0, 800);
    if (/error|not found/i.test(result)) block.classList.add("error");
    div.appendChild(block);
  }

  $messages.appendChild(div);
  $messages.scrollTop = $messages.scrollHeight;
  return div;
}

// ---- Chat ----
async function send() {
  const text = $input.value.trim();
  if (!text || sending) return;

  const model = $modelSelect.value;
  const skills = [...$skillsSelect.selectedOptions].map((o) => o.value);

  sending = true;
  $send.disabled = true;
  $input.value = "";

  addMsgNode("user", text);

  const userNode = addMsgNode("agent", "…"); // placeholder

  try {
    const r = await fetch(API + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: currentSession,
        message: text,
        model,
        skills,
        owner: "browser",
      }),
    });
    const data = await r.json();

    if (!r.ok) {
      userNode.querySelector(".meta").textContent = "OffCode (error)";
      userNode.lastElementChild.textContent = "⚠ " + (data.error || "request failed");
      userNode.lastElementChild.parentElement.style.color = "#ef5350";
    } else {
      userNode.querySelector(".meta").textContent =
        "OffCode · " + (data.modelUsed || "model") +
        (data.task ? " · " + ({ code: "💻 代碼", agent: "🤖 Agent", chat: "💬 對話" }[data.task] || data.task) : "") +
        (data.routedBy ? " · via " + data.routedBy : "");
      userNode.lastElementChild.textContent = data.content || "";
      if (data.sessionId && !currentSession) {
        currentSession = data.sessionId;
      }
      // show tool calls
      const tools = (data.toolCalls || []).filter((t) => t.result);
      for (const t of tools) {
        const block = document.createElement("div");
        block.className = "tool-block" + (t.result.ok === false ? " error" : "");
        block.textContent = "🔧 " + t.tool + " → " + JSON.stringify(t.result, null, 2).slice(0, 600);
        userNode.appendChild(block);
      }
      // first-time session: refresh list
      if (data.sessionId) {
        $chatTitle.textContent = text.slice(0, 40);
        renderSessions();
      }
    }
  } catch (e) {
    userNode.querySelector(".meta").textContent = "OffCode (offline)";
    userNode.lastElementChild.textContent =
      "⚠ Cannot reach backend: " + e.message + "\n(Backend D1/KV not configured, or server down.)";
  } finally {
    sending = false;
    $send.disabled = false;
    $messages.scrollTop = $messages.scrollHeight;
    checkHealth(); // refresh usage counter / auto-switch state
  }
}

// ---- Health / routing status ----
async function checkHealth() {
  try {
    const r = await fetch(API + "/api/status");
    const d = await r.json();
    // dot: green = auto+free tier OK; warn = custom configured/exhausted only; empty = unreachable
    $healthDot.className = d.customConfigured ? (d.exhausted ? "warn" : "ok") : "";
    $healthDot.title =
      (d.override ? "Override: " + d.override + " · " : "") +
      "今日 Neurons (估算): " + d.neuronsToday + " / " + d.freeNeuronsPerDay +
      (d.exhausted ? (d.customConfigured ? " (已用完 → 自動切自訂)" : " (已用完!無自訂金鑰)") : "") +
      (d.customConfigured ? "\n自訂 API: 已配置" : "\n自訂 API: 未配置");

    // usage line + restore override selection
    const $usage = document.getElementById("usage-line");
    if ($usage) {
      $usage.textContent =
        "Neurons 今日: " + (d.neuronsToday ?? 0) +
        " / 安全線 " + (d.safeThreshold ?? "?") +
        " / 免費 " + (d.freeNeuronsPerDay ?? 10000) + "/日" +
        (d.exhausted ? (d.customConfigured ? " · 已自動切自訂" : " · 額度已用完!") : "") +
        (d.override ? " · 手動: " + d.override : "");
    }
    if (d.override) $modelSelect.value = d.override;
  } catch {
    $healthDot.className = "warn";
    $healthDot.title = "Backend unreachable";
  }
}

// manual provider switch (persisted server-side)
$modelSelect.addEventListener("change", async () => {
  try {
    const r = await fetch(API + "/api/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: $modelSelect.value }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      console.warn("provider switch failed:", d.error);
    }
  } catch { /* offline */ }
  checkHealth();
});

// ---- Utils ----
function escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
function safeJson(s) {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

// ---- Events ----
$send.addEventListener("click", send);
$input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
$newChat.addEventListener("click", () => {
  currentSession = null;
  $chatTitle.textContent = "New chat";
  $messages.innerHTML = "";
  renderSessions();
});

// init
checkHealth();
renderSessions();
