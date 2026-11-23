// Cloudflare Worker entry. Static assets (the built React app in dist/) are
// served by Workers Static Assets; only /api/*, /radius/* (the Radius
// proxy) and /sling/* (the Sling proxy) requests reach this handler (see run_worker_first in wrangler.jsonc).

import type { Env } from "./server/env";
import { handleAuth } from "./server/auth";
import { handleRadiusProxy } from "./server/radiusProxy";
import { handleSling } from "./server/sling";

export type { Env };
// Classes the runtime loads by name (see wrangler.jsonc).
export { AccountLock } from "./server/accountLock";
export { SlingSignIn } from "./server/slingSignIn";

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

    if (pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
};
