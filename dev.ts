// Local development server: `bun run dev`. Not part of the production build
// or deploy.
//
// Bun serves the React app with hot module replacement, and forwards /api/*
// and /radius/* (the Radius proxy)
// to `wrangler dev`, which runs the real Worker against the local D1 database.
// Open the app through this server (http://localhost:3000), not wrangler's
// port, so everything stays on one origin like in production.

import index from "./src/index.html";

const PORT = Number(process.env.PORT ?? 3000);
const WORKER_PORT = Number(process.env.WORKER_PORT ?? 8787);
const WORKER_ORIGIN = `http://localhost:${WORKER_PORT}`;

const APP_URL = `http://localhost:${PORT}`;

// wrangler would otherwise serve the production build from dist/, which has
// no HMR. Point it at a one-page folder that forwards the browser here
// instead, keeping the path. /api/* still runs the Worker.
const REDIRECT_ASSETS = ".wrangler/dev-redirect";
await Bun.write(
  `${REDIRECT_ASSETS}/index.html`,
  `<!doctype html><meta charset="utf-8"><title>Redirecting…</title>
<script>location.replace(${JSON.stringify(APP_URL)} + location.pathname + location.search + location.hash)</script>
<p>The dev app runs at <a href="${APP_URL}">${APP_URL}</a>.</p>
`,
);

const wrangler = Bun.spawn(
  [
    "bunx", "wrangler", "dev",
    "--port", String(WORKER_PORT),
    "--assets", REDIRECT_ASSETS,
    "--show-interactive-dev-session=false",
  ],
  { stdio: ["inherit", "inherit", "inherit"] },
);

function shutdown() {
  wrangler.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
wrangler.exited.then((code) => {
  console.error(`wrangler dev exited (code ${code}); stopping.`);
  process.exit(code ?? 1);
});

async function proxyToWorker(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.delete("host");
  try {
    const upstream = await fetch(WORKER_ORIGIN + url.pathname + url.search, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
    });
    // fetch already decompressed the body, so drop headers describing the
    // compressed bytes. Set-Cookie is passed through unchanged.
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return Response.json({ error: "Worker isn't ready yet (wrangler dev is starting)." }, { status: 502 });
  }
}

const server = Bun.serve({
  port: PORT,
  routes: {
    "/api/*": proxyToWorker,
    "/radius/*": proxyToWorker,
    "/sling/*": proxyToWorker,
    "/*": index,
  },
  development: {
    hmr: true,
    console: true,
  },
});

// wrangler prints a lot on startup, ending with its own URL. Print ours once
// it's ready so it's the last thing on screen.
async function announceWhenReady() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await fetch(`${WORKER_ORIGIN}/api/db/health`);
      break;
    } catch {
      await Bun.sleep(500);
    }
  }
  console.log(`\n  ➜  Open the app at ${server.url} (hot module replacement)\n     API requests go to wrangler at ${WORKER_ORIGIN}\n`);
}
announceWhenReady();
