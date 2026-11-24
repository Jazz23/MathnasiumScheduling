// Cloudflare Worker entry. Static assets (the React app, built by Vite) are
// served by Workers Static Assets; only /api/*, /radius/* (the Radius
// proxy), /sling/* (the Sling proxy) and /signalr/* (Radius' WebSocket, turned
// down) requests reach this handler (see run_worker_first in wrangler.jsonc).

import type { Env } from "./env";
import { handleAuth } from "./auth";
import { handleRadiusProxy } from "./radiusProxy";
import { handleSling } from "./sling";

export type { Env };
// Classes the runtime loads by name (see wrangler.jsonc).
export { AccountLock } from "./accountLock";
export { SlingSignIn } from "./slingSignIn";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    const proxied = await handleRadiusProxy(request, env, url);
    if (proxied) return proxied;

    const sling = await handleSling(request, env, url);
    if (sling) return sling;

    if (pathname.startsWith("/api/auth/")) {
      const response = await handleAuth(request, env, pathname);
      if (response) return response;
    }

    if (pathname === "/api/db/health") {
      const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      return Response.json({ ok: row?.ok === 1 });
    }

    // A proxied Radius page opens its SignalR WebSocket at the root, since a
    // service worker can't redirect WebSockets. Turn it down here: SignalR
    // falls back to long polling, which goes through /radius/. Left to the
    // static assets, the upgrade reaches Vite in dev and kills the dev server.
    if (pathname.startsWith("/signalr/")) {
      return new Response("Radius WebSockets aren't proxied.", { status: 404 });
    }

    if (pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
};
