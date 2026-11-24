// The server's request handler: the API and the Radius and Sling proxies.
// CloudFront sends /api/*, /radius*, /sling* and /signalr/* here (through the
// API Lambda, server/lambda.ts) and serves the React app from S3. In dev, the
// Vite dev server sends the same paths here (vite.config.ts).

import type { Env } from "./env";
import { handleAuth } from "./auth";
import { getItem, keys } from "./db";
import { handleRadiusProxy } from "./radiusProxy";
import { handleSling } from "./sling";
import { handleDemand } from "./demandApi";
import { handleRoster } from "./roster";
import { handleSetup } from "./setup";

export type { Env };

/** The paths this handler serves; everything else is the React app. */
export const SERVER_PATHS = ["/api/", "/radius", "/sling", "/signalr/"];

export async function handleRequest(request: Request, env: Env): Promise<Response> {
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

  const api = (await handleDemand(request, env, url)) ?? (await handleSetup(request, env, pathname)) ?? (await handleRoster(request, env, pathname));
  if (api) return api;

  if (pathname === "/api/db/health") {
    await getItem(keys.settings());
    return Response.json({ ok: true });
  }

  // A proxied Radius page opens its SignalR WebSocket at the root, since a
  // service worker can't redirect WebSockets. Turn it down here: SignalR
  // falls back to long polling, which goes through /radius/. (Lambda can't
  // take WebSockets anyway, and in dev the upgrade would reach Vite.)
  if (pathname.startsWith("/signalr/")) {
    return new Response("Radius WebSockets aren't proxied.", { status: 404 });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
