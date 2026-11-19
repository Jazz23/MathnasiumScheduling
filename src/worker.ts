// Cloudflare Worker entry. Static assets (the built React app in dist/) are
// served by Workers Static Assets; only /api/* requests reach this handler
// (see run_worker_first in wrangler.jsonc).

// Import Workers types as a module (not ambient) so they don't clash with
// bun-types' global Request/Response.
import type { D1Database } from "@cloudflare/workers-types/index.ts";

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/hello") {
      if (request.method === "GET" || request.method === "PUT") {
        return Response.json({ message: "Hello, world!", method: request.method });
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    const match = pathname.match(/^\/api\/hello\/([^/]+)$/);
    if (match) {
      return Response.json({ message: `Hello, ${decodeURIComponent(match[1]!)}!` });
    }

    if (pathname === "/api/db/health") {
      const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      return Response.json({ ok: row?.ok === 1 });
    }

    if (pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
};
