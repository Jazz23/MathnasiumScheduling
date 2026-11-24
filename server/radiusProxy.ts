// /radius/* — a same-origin reverse proxy for Radius, so the app can show
// Radius pages (like the scheduling calendar) in an iframe.
//
// Radius sends X-Frame-Options: SAMEORIGIN, so it can't be iframed directly.
// Instead the server fetches each page as the signed-in user (radiusFetch,
// with the stored session cookies, signing in again when they expire) and
// serves it under /radius/. Radius' cookies never reach the browser.
//
// Radius pages use root-relative URLs ("/Scheduling/CalendarData") all over
// their HTML, scripts and stylesheets. Two things map those back under
// /radius/:
//   - HTML responses get href/src/action attributes rewritten here, so links
//     and forms navigate within /radius/.
//   - A service worker scoped to /radius/ (RADIUS_SW_PATH, registered by the
//     frontend) catches every other same-origin request a proxied page makes
//     (XHR, fetch, images, CSS url()) and prefixes /radius. Synchronous XHRs
//     bypass service workers, so pages also get XMLHttpRequest.open patched.
// WebSockets (SignalR) can't be intercepted that way: they arrive at
// /signalr/*, where the server turns them down (server/app.ts) and SignalR
// falls back to long polling through the proxy.

import type { Env } from "./env";
import { getSessionAccount } from "./auth";
import { RADIUS_ORIGIN, radiusFetch } from "./radius";
import { rewriteHtml } from "./html";

export const RADIUS_PREFIX = "/radius";
export const RADIUS_SW_PATH = `${RADIUS_PREFIX}/__proxy-sw.js`;

const SERVICE_WORKER = `
const PREFIX = ${JSON.stringify(RADIUS_PREFIX + "/")};
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Only requests from proxied Radius pages reach this worker, so any
  // same-origin URL outside /radius/ is a Radius root-relative URL.
  if (url.origin !== self.location.origin || url.pathname.startsWith(PREFIX)) return;
  if (request.mode === "navigate") return;
  url.pathname = PREFIX.slice(0, -1) + url.pathname;
  event.respondWith(
    (async () => {
      const init = {
        method: request.method,
        headers: request.headers,
        credentials: "same-origin",
        redirect: "follow",
      };
      if (request.method !== "GET" && request.method !== "HEAD") init.body = await request.arrayBuffer();
      return fetch(url, init);
    })(),
  );
});
`;

// Request headers that describe the browser's connection to this app, not
// a request Radius should see.
const DROP_REQUEST_HEADERS = ["cookie", "host", "origin", "referer", "connection", "content-length", "accept-encoding"];
// The last few are added by CloudFront and Lambda.
const DROP_REQUEST_PREFIXES = ["sec-", "cf-", "x-forwarded-", "x-real-ip", "x-amz", "via", "cloudfront-"];

// Response headers that would stop the page being framed or leak Radius'
// cookies, or that no longer describe the body after rewriting.
const DROP_RESPONSE_HEADERS = [
  "set-cookie",
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "content-length",
  "content-encoding",
];

/** Maps a Radius URL (absolute or root-relative) to its /radius/ path. */
function toProxyUrl(value: string): string {
  if (value.startsWith("//")) return value;
  if (value.startsWith("/")) return RADIUS_PREFIX + value;
  if (value.startsWith(RADIUS_ORIGIN + "/") || value === RADIUS_ORIGIN) {
    return RADIUS_PREFIX + (value.slice(RADIUS_ORIGIN.length) || "/");
  }
  return value;
}

// Synchronous XHRs (Radius uses a few, e.g. /Base/GetResources) skip
// service workers, so proxied pages also get XMLHttpRequest.open patched.
const XHR_PATCH = `<script>(() => {
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !url.startsWith(${JSON.stringify(RADIUS_PREFIX + "/")})) {
      url = ${JSON.stringify(RADIUS_PREFIX)} + url;
    }
    return open.call(this, method, url, ...rest);
  };
})();</script>`;

const REWRITE = {
  headPrepend: XHR_PATCH,
  attributes: [
    { tag: "*", attribute: "href", map: toProxyUrl },
    { tag: "*", attribute: "src", map: toProxyUrl },
    { tag: "form", attribute: "action", map: toProxyUrl },
  ],
};

function forwardHeaders(request: Request, radiusPath: string): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (DROP_REQUEST_HEADERS.includes(lower)) continue;
    if (DROP_REQUEST_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    headers.set(name, value);
  }
  // Some ASP.NET endpoints check these, so make them look same-site.
  if (request.headers.has("Origin")) headers.set("Origin", RADIUS_ORIGIN);
  const referer = request.headers.get("Referer");
  if (referer) {
    const path = new URL(referer).pathname;
    headers.set("Referer", RADIUS_ORIGIN + (path.startsWith(RADIUS_PREFIX + "/") ? path.slice(RADIUS_PREFIX.length) : radiusPath));
  }
  return headers;
}

/** Handles /radius/* requests, or returns null for any other path. */
export async function handleRadiusProxy(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === RADIUS_SW_PATH) {
    return new Response(SERVICE_WORKER, {
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }
  if (url.pathname !== RADIUS_PREFIX && !url.pathname.startsWith(RADIUS_PREFIX + "/")) return null;

  const account = await getSessionAccount(request, env);
  if (!account) {
    return new Response("Not signed in to the scheduling app.", {
      status: 401,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const radiusPath = (url.pathname.slice(RADIUS_PREFIX.length) || "/") + url.search;
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await radiusFetch(env, account.id, radiusPath, {
    method: request.method,
    headers: forwardHeaders(request, radiusPath),
    // An ArrayBuffer, since radiusFetch may send the request twice.
    body: hasBody ? await request.arrayBuffer() : undefined,
  });

  const headers = new Headers(upstream.headers);
  for (const name of DROP_RESPONSE_HEADERS) headers.delete(name);
  const location = upstream.headers.get("Location");
  if (location) headers.set("Location", toProxyUrl(location));

  const init = { status: upstream.status, statusText: upstream.statusText, headers };
  const contentType = headers.get("Content-Type") ?? "";
  if (contentType.startsWith("text/html")) return new Response(rewriteHtml(await upstream.text(), REWRITE), init);
  return new Response(upstream.body, init);
}
