// Entry point: routes + static file serving
import {
  handleChat, handleSessions, handleMessages,
  handleDocs, handleMemory, handleHealth,
  handleStatus, handleProvider, handleSkills,
} from "./routes.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // API routes
    if (path.startsWith("/api/chat") && request.method === "POST") {
      return handleChat(request, env, ctx);
    }
    if (path.startsWith("/api/sessions")) {
      return handleSessions(request, env, ctx);
    }
    if (path.startsWith("/api/messages")) {
      return handleMessages(request, env, ctx);
    }
    if (path.startsWith("/api/docs")) {
      return handleDocs(request, env, ctx);
    }
    if (path.startsWith("/api/memory")) {
      return handleMemory(request, env, ctx);
    }
    if (path.startsWith("/api/provider")) {
      return handleProvider(request, env, ctx);
    }
    if (path.startsWith("/api/skills")) {
      return handleSkills(env);
    }
    if (path === "/api/status") {
      return handleStatus(env);
    }
    if (path === "/api/health") {
      return handleHealth(env);
    }

    // Static files
    if (env.ASSETS) {
      const asset = await env.ASSETS.fetch(new Request(request.url, { method: "GET" }));
      if (asset.status !== 404) return asset;
    }

    // SPA fallback
    if (env.INDEX_HTML) {
      return new Response(env.INDEX_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
