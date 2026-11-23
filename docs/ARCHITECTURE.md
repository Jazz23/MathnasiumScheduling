# Architecture

The app's current design and the decisions behind it. Read this before making a major change.

This file only covers what is built or decided. What's planned, and the proposals that are still
open (including the Cloudflare recommendations), are in `docs/PLAN.md`. When a proposal is decided
or built, record it here and update the plan to match.

## Decisions

| Decision | Why |
| --- | --- |
| **Fully serverless on Cloudflare**: a Worker serves the app and API, and D1 stores the data. | No server to maintain. |
| **Only the director uses the app.** Employees keep using Sling, and parents never use the app. | Employees already enter availability in Sling and see their shifts there. One user keeps the app simple. |
| **Radius and Sling stay the sources of truth.** Appointments, the student-to-instructor ratio, attendance history and sessions left this month come from Radius. Availability, time off and the published schedule come from Sling. The app stores only what neither one has. | No second copy of data to keep in sync, and the center keeps working the way it does today. |
| **The app only changes Sling shifts it created itself.** | Shifts the director makes by hand in Sling are never overwritten. |
| **App accounts are Radius accounts** ("Login with Radius"). | Radius has no OAuth, so there's nothing to sign in with except a Radius username and password. Everyone who would use the app already has one, so there's no separate password to manage. |
| **The app stores Radius and Sling passwords, encrypted.** | Radius has no refresh tokens, and Sling's token expires. To keep working without asking the director to log in again, the Worker signs in again itself. |
| **CapMonster solves Sling's login captcha.** | Sling's login API requires a reCAPTCHA token. |
| **Radius and Sling are shown in the app through same-origin proxies.** | Both refuse to be shown in another site's iframe. Proxying also keeps their cookies and tokens on the server. |
| **React built with Bun's own tooling**, no framework or separate bundler. | Fewer tools to maintain. |

## Overview

```
Browser ──> Worker (src/worker.ts)
              ├─ /api/auth/*, /api/sling ──> D1 (accounts, sessions, stored logins)
              ├─ /radius/*   ── signed-in proxy ──> radius.mathnasium.com
              ├─ /sling/*    ── proxy ───────────> app.getsling.com
              ├─ /sling/__api/* ── adds token ───> api.getsling.com
              └─ everything else ──> static assets (dist/, the React app)

Sling sign-in also calls CapMonster (api.capmonster.cloud) to solve the captcha.
```

Workers Static Assets serves the built app from `dist/`, with single-page-app fallback. Only
`/api/*`, `/radius/*` and `/sling/*` run the Worker (`run_worker_first` in `wrangler.jsonc`).

### Routes

| Route | File | What it does |
| --- | --- | --- |
| `POST /api/auth/radius` | `src/server/auth.ts` | Log in with Radius. Creates or updates the account and starts an app session. |
| `DELETE /api/auth/radius` | `src/server/auth.ts` | Unlink Radius: deletes the account, its stored password and cookies, all its sessions and its Sling link. |
| `GET /api/auth/me` | `src/server/auth.ts` | The signed-in account, or 401. |
| `POST /api/auth/logout` | `src/server/auth.ts` | Ends this browser's session. Radius stays linked. |
| `GET`, `POST`, `DELETE /api/sling` | `src/server/sling.ts` | Whether Sling is linked; link Sling; unlink Sling. |
| `/radius/*` | `src/server/radiusProxy.ts` | Radius pages and requests, made as the signed-in account. |
| `/sling/*` | `src/server/sling.ts` | Sling's web app files. |
| `/sling/__api/*` | `src/server/sling.ts` | Sling's API, with the stored token added. |
| `/radius/__proxy-sw.js`, `/sling/__proxy-sw.js` | the proxy files | Service workers for the embedded views (see below). |
| `GET /api/db/health` | `src/worker.ts` | Checks D1. The dev server uses it to know the Worker is up. |

Any other `/api/*` path returns 404 as JSON.

## Accounts and sessions

**Login with Radius** (`src/server/auth.ts`, `src/server/radius.ts`):

1. The app's own login form sends the Radius username and password to `POST /api/auth/radius`.
2. The Worker loads Radius' login page (`/Account/Login`) for its anti-forgery token and cookie, then
   posts the credentials. Radius redirects away from the login page on success and shows the form
   again on failure.
3. The Worker saves the Radius session cookies and the encrypted password in `radius_accounts`. The
   username is unique and case-insensitive, so logging in again updates the same account.
4. It starts an app session: a random 32-byte token in an `HttpOnly`, `Secure`, `SameSite=Lax`
   cookie named `session`, valid for 30 days. Only a SHA-256 hash of the token is stored. Expired
   sessions are deleted at each login.

**Acting as the account in Radius**: `radiusFetch()` sends a request with the stored cookies. If
Radius answers with a 401 or a redirect to its login page, it decrypts the password, signs in again,
retries once and saves the new cookies. It doesn't follow redirects, and the request body must be
replayable (not a stream), because it may be sent twice. All Radius access goes through it.

## Sling link

`src/server/sling.ts`:

1. The director enters their Sling email and password (`POST /api/sling`).
2. The Worker asks CapMonster to solve Sling's reCAPTCHA v2 (task type `RecaptchaV2Task`, with the
   site key from Sling's login page). It checks every 3 seconds, for up to 2 minutes. A solve usually
   takes 10–60 seconds.
3. It posts the email, password and captcha answer to `api.getsling.com/v1/account/login`. Sling
   returns its token in the `Authorization` response header, along with the organization ID. A 401 or
   409 means wrong credentials, unless the message mentions the captcha.
4. It saves the token, organization ID and encrypted password in `sling_accounts`, one Sling link per
   app account.

**Using the token**: requests to `/sling/__api/*` get the stored token added. If Sling answers 401,
the Worker signs in again (a new captcha) and retries once. If Sling sends back a refreshed token, it
is saved.

Sling sits behind Cloudflare's bot protection, which rejects requests without a browser-like
`User-Agent`, so the Worker sends one.

## Stored credentials

- Radius and Sling passwords are encrypted with AES-GCM using a 256-bit key, `RADIUS_CREDENTIAL_KEY`
  (base64). Despite the name, the same key covers Sling. `src/server/crypto.ts` uses only WebCrypto.
- Each password gets a random 12-byte IV. The ciphertext is tied to its account (the lowercased
  Radius username, or `sling:<email>`), so it can't be copied onto another row and still decrypt.
- If the key is lost or changed, stored passwords can't be decrypted, and the director has to log in
  and link Sling again.
- Anyone with both the key and the database can read the passwords.
- Credentials never reach the browser. The Radius proxy strips Radius' cookies from responses. The
  Sling page only gets a placeholder token, and the API proxy swaps in the real one.

## Embedded views

Radius and Sling both send `X-Frame-Options: SAMEORIGIN`, so the app shows them through proxies on
its own origin.

**Radius** (`src/server/radiusProxy.ts`, shown by `src/RadiusSchedule.tsx`):

- The Worker fetches each page with `radiusFetch()` and serves it under `/radius/`.
- HTML responses have `href`, `src` and form `action` attributes rewritten to stay under `/radius/`.
  They also get a small script that patches `XMLHttpRequest.open`, because synchronous requests skip
  service workers.
- A service worker scoped to `/radius/` catches every other same-origin request a page makes (fetch,
  images, CSS) and prefixes it with `/radius`.
- If a Radius page navigates to a root-relative URL from a script, the frame lands on the app
  itself. `src/frontend.tsx` notices that it's inside its own frame and sends it on to `/radius/`.
- Responses lose `Set-Cookie`, `X-Frame-Options`, content security policy and HSTS headers.
  Redirects are rewritten to stay under `/radius/`. Requests get Radius' own `Origin` and `Referer`,
  because some Radius endpoints check them.
- Radius' live updates (SignalR websockets) can't be proxied this way and don't connect.

**Sling** (`src/server/sling.ts`, shown by `src/SlingPanel.tsx`):

- `/sling/*` serves Sling's web app from `app.getsling.com`. Its JavaScript is rewritten to call
  `/sling/__api/` instead of `api.getsling.com`.
- Its HTML gets `<base href="/sling/">`, a placeholder `authorization-token` cookie, the
  organization ID cookie, and the same `XMLHttpRequest` patch. A service worker scoped to `/sling/`
  does the same job as the Radius one.
- Sling's realtime socket isn't proxied, so changes made elsewhere only show after a reload.

**Frontend**: `src/App.tsx` renders `src/RadiusLogin.tsx`, which shows the login form, then tabs for
the Radius schedule and the Sling panel. The Sling panel links Sling, then shows Sling's app.

## Database

D1 database `mathnasium-scheduling`. Schema changes are migrations in `migrations/`, applied with
`bun run db:migrate:local` and `bun run db:migrate`.

| Table | Holds |
| --- | --- |
| `radius_accounts` | One row per app account: Radius username, encrypted password and IV, current Radius cookies. |
| `sessions` | App sessions: SHA-256 hash of the session token, account, expiry. |
| `sling_accounts` | One Sling link per app account: email, encrypted password and IV, current token, organization ID. |

Deleting an account deletes its sessions and Sling link (foreign keys with `ON DELETE CASCADE`).

## Secrets and configuration

| Secret | Used for |
| --- | --- |
| `RADIUS_CREDENTIAL_KEY` | Encrypting the stored Radius and Sling passwords. Generate with `openssl rand -base64 32`. |
| `CAPMONSTER_API_KEY` | Solving Sling's login captcha. |

Set them with `wrangler secret put` in production, and in `.dev.vars` for local development.

The `Env` type is written by hand in `src/server/env.ts`. It imports the Workers types as a module,
not as globals, so they don't clash with Bun's `Request` and `Response` types.

## Build and development

- **Build**: `bun build ./src/index.html` bundles the React app into `dist/`. Wrangler runs it before
  each deploy, and again on file changes during `wrangler dev`.
- **Dev server** (`dev.ts`, `bun run dev`): Bun serves the app with hot reload on port 3000 and starts
  `wrangler dev` on port 8787, which runs the real Worker against a local D1 database. Bun forwards
  `/api/*`, `/radius/*` and `/sling/*` to it, so everything stays on one origin as in production.
  Wrangler's own page only redirects to port 3000.
- **Pinned versions**: Wrangler 4.165.0, `@cloudflare/workers-types` 5.20261119.1, compatibility
  date 2026-11-19.

## Known limitations

- **Sling sign-in runs inside the web request.** It takes up to a minute or two, and fails if the tab
  closes.
- **No sign-in lock.** Two requests that find an expired login at the same time both sign in again.
  For Sling, that's two paid captcha solves.
- **Unofficial endpoints.** Neither Radius nor Sling has a public API for this. The app uses the
  endpoints their own sites use, which can change without notice.
- **No live updates** in the embedded views (see above).
