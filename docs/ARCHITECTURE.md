# Architecture

The app's current design and the decisions behind it. Read this before making a major change.

This file only covers what is built or decided. What's planned, and the proposals that are still
open (including the Cloudflare recommendations), are in `docs/PLAN.md`. When a proposal is decided
or built, record it here and update the plan to match.

## Decisions

| Decision | Why |
| --- | --- |
| **Fully serverless on Cloudflare**: a Worker serves the app and API, and D1 stores the data. | No server to maintain. |
| **Only the director uses the app.** Employees keep using Sling, and parents never use the app. | Employees already request time off in Sling and see their shifts there. One user keeps the app simple. |
| **One center.** Settings, roster and linked accounts aren't split by center. | The app is for this center only (decided 2026-11-24). |
| **Radius and Sling stay the sources of truth.** Appointments, the student-to-instructor ratio, attendance history and sessions left this month come from Radius. Time off and the published schedule come from Sling. The app stores only what neither one has. | No second copy of data to keep in sync, and the center keeps working the way it does today. |
| **Employee availability is entered in the app**, by the director (decided 2026-11-24). | Availability is a Sling Premium feature, and the center is on the free plan, so Sling has none to read. |
| **The app only changes Sling shifts it created itself.** | Shifts the director makes by hand in Sling are never overwritten. |
| **The app's shifts go into Sling unpublished**; the director publishes them there (decided 2026-11-24). | A last check in Sling before employees are notified. |
| **App accounts are Radius accounts** ("Login with Radius"). | Radius has no OAuth, so there's nothing to sign in with except a Radius username and password. Everyone who would use the app already has one, so there's no separate password to manage. |
| **The app stores Radius and Sling passwords, encrypted.** | Radius has no refresh tokens, and Sling's token expires. To keep working without asking the director to log in again, the Worker signs in again itself. |
| **CapMonster solves Sling's login captcha.** | Sling's login API requires a reCAPTCHA token. |
| **Radius and Sling are shown in the app through same-origin proxies.** | Both refuse to be shown in another site's iframe. Proxying also keeps their cookies and tokens on the server. |
| **React built with Vite and `@cloudflare/vite-plugin`**, no framework. Bun is the package manager and script runner. | The plugin runs the Worker in the real Workers runtime during `vite` dev, so one dev server gives hot reload and real bindings on one origin. |
| **One Durable Object per account (`AccountLock`) runs one sign-in at a time.** | Requests that find an expired login together share one sign-in, instead of each signing in again (for Sling, each paying for a captcha). |
| **Sling sign-in runs in a Workflow (`SlingSignIn`).** | It waits up to 2 minutes for the captcha. A Workflow step has no wall-clock limit and keeps going if the tab closes. |
| **Runs on the Workers Free plan until the scheduler needs more CPU.** | Durable Objects and Workflows are on the Free plan. Its 10 ms of CPU and 50 outgoing requests per invocation fit sign-ins and proxying. |

## Overview

```
Browser ──> Worker (worker/index.ts)
              ├─ /api/auth/*, /api/sling ──> D1 (accounts, sessions, stored logins)
              ├─ /api/setup/*, /api/roster/* ──> D1 (center setup, roster) + Sling reads
              ├─ /api/demand ──> Radius reads + Sling reads + D1
              ├─ /radius/*   ── signed-in proxy ──> radius.mathnasium.com
              ├─ /sling/*    ── proxy ───────────> app.getsling.com
              ├─ /sling/__api/* ── adds token ───> api.getsling.com
              └─ everything else ──> static assets (the React app)

Sign-ins go through the account's AccountLock (Durable Object, worker/accountLock.ts):
  Radius: signs in itself
  Sling:  starts the SlingSignIn Workflow (worker/slingSignIn.ts), which
          calls CapMonster (api.capmonster.cloud) to solve the captcha
```

Workers Static Assets serves the built app (`dist/client/`), with single-page-app fallback. Only
`/api/*`, `/radius/*`, `/sling/*` and `/signalr/*` run the Worker (`run_worker_first` in `wrangler.jsonc`).

### Routes

| Route | File | What it does |
| --- | --- | --- |
| `POST /api/auth/radius` | `worker/auth.ts` | Log in with Radius. Creates or updates the account and starts an app session. |
| `DELETE /api/auth/radius` | `worker/auth.ts` | Unlink Radius: deletes the account, its stored password and cookies, all its sessions and its Sling link. |
| `GET /api/auth/me` | `worker/auth.ts` | The signed-in account, or 401. |
| `POST /api/auth/logout` | `worker/auth.ts` | Ends this browser's session. Radius stays linked. |
| `GET`, `POST`, `DELETE /api/sling` | `worker/sling.ts` | Whether Sling is linked; start linking Sling (202 with the sign-in's ID); unlink Sling, stopping a sign-in that's still running. |
| `GET /api/sling/sign-in/:id` | `worker/sling.ts` | Whether a Sling sign-in is pending, done or failed. Only the account's own sign-ins. |
| `/radius/*` | `worker/radiusProxy.ts` | Radius pages and requests, made as the signed-in account. |
| `/sling/*` | `worker/sling.ts` | Sling's web app files. |
| `/sling/__api/*` | `worker/sling.ts` | Sling's API, with the stored token added. |
| `/radius/__proxy-sw.js`, `/sling/__proxy-sw.js` | the proxy files | Service workers for the embedded views (see below). |
| `GET /api/demand?start=&days=` | `worker/demandApi.ts` | Booked demand per 15-minute block for up to 14 days, with the people on Sling's schedule, time off and shifts. |
| `GET /api/setup` | `worker/setup.ts` | Center settings, opening hours and school programs. |
| `PUT /api/setup/center` | `worker/setup.ts` | Saves the settings and replaces the opening hours. |
| `GET /api/setup/sling-groups` | `worker/setup.ts` | Sling's locations and positions, for mapping. |
| `POST /api/setup/programs`, `PUT`, `DELETE /api/setup/programs/:id` | `worker/setup.ts` | School programs and their sessions. |
| `GET /api/roster` | `worker/roster.ts` | Everyone on the roster, with programs, availability and preferences. |
| `POST /api/roster/sync` | `worker/roster.ts` | Imports people from Sling. |
| `PUT /api/roster/:slingUserId` | `worker/roster.ts` | Saves a person's details and preferred programs. |
| `PUT /api/roster/:slingUserId/availability` | `worker/roster.ts` | Replaces one availability pattern (`effectiveFrom` and its windows). |
| `PUT /api/roster/:slingUserId/preferences` | `worker/roster.ts` | Replaces a person's prefer/avoid times. |
| `GET /api/roster/availability-suggestions?weeks=` | `worker/roster.ts` | Each person's usual times from their past Sling shifts. |
| `GET /api/db/health` | `worker/index.ts` | Checks D1. |

Any other `/api/*` path returns 404 as JSON.

## Accounts and sessions

**Login with Radius** (`worker/auth.ts`, `worker/radius.ts`):

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
Radius answers with a 401 or a redirect to its login page, it asks the account's `AccountLock` for
new cookies and retries once. It doesn't follow redirects, and the request body must be replayable
(not a stream), because it may be sent twice. All Radius access goes through it.

**Sign-in lock** (`worker/accountLock.ts`): one Durable Object per app account, named by the
account ID, runs its calls one at a time. A caller passes the time it sent the request that was
turned down. If a sign-in finished after that, the caller gets that result instead of starting
another. A Radius sign-in decrypts the password, signs in and saves the cookies in the object
itself. For Sling, see below.

## Sling link

`worker/sling.ts`:

1. The director enters their Sling email and password (`POST /api/sling`). The Worker encrypts the
   password and asks the account's `AccountLock` to start a sign-in with it. The lock stops any
   sign-in still running with older credentials and starts a `SlingSignIn` Workflow instance, named
   `sling-<account ID>-<time>`. The Worker answers 202 with the instance ID, and the page checks
   `GET /api/sling/sign-in/:id` every 3 seconds.
2. The Workflow's one step decrypts the password and asks CapMonster to solve Sling's reCAPTCHA v2
   (task type `RecaptchaV2Task`, with the site key from Sling's login page). It checks every 5
   seconds, for up to 2 minutes. A solve usually takes 10–60 seconds.
3. It posts the email, password and captcha answer to `api.getsling.com/v1/account/login`. Sling
   returns its token in the `Authorization` response header, along with the organization ID. A 401 or
   409 means wrong credentials, unless the message mentions the captcha. Wrong credentials fail the
   instance at once (a `NonRetryableError` named `SlingLoginError`). Anything else is retried once,
   since each attempt pays for a captcha.
4. It saves the token, organization ID and encrypted password in `sling_accounts`, one Sling link per
   app account. The step returns only the time it finished, so the Workflow's saved state holds no
   token and no plain password.

**Using the token**: requests to `/sling/__api/*` get the stored token added. If Sling answers 401,
the Worker asks the `AccountLock` to sign in again with the stored login. The lock reuses a running
`SlingSignIn` instance, or one that finished after the turned-down request, and otherwise starts one.
The request waits for it (up to 3 minutes) and retries once. If Sling sends back a refreshed token,
it is saved. The lock keeps its latest instance ID in its storage, so it still knows about a running
sign-in after a restart.

Sling sits behind Cloudflare's bot protection, which rejects requests without a browser-like
`User-Agent`, so the Worker sends one.

## Reading Radius and Sling

The scheduler's data comes from two modules, and nothing else calls Radius or Sling for data:

- **`worker/radiusData.ts`**: Radius' levels and ratios (parsed from the Center Settings page,
  where they're embedded as `radius.utilities.levels.push({...})` calls) and appointments (the
  Appointment Management grid's data request). Radius' POSTs need an anti-forgery token from any
  page, so the levels page load also provides the token. If a POST comes back as an error page (the
  session was renewed and the token went stale), it loads the page again and retries once. Dates
  and times are read from Radius' ready-made local strings, so no time zone conversion is needed.
- **`worker/slingData.ts`**: people and groups (`/v1/users/concise`), and the calendar of shifts and
  time off (`/v1/calendar/{org}/users/{user}`, which returns everyone's for an admin). Calls go
  through `slingGet()` in `worker/sling.ts`, which uses the stored token and signs in again when it
  expires, like the proxy.

Both check the shapes they get back and throw on anything unexpected, rather than guessing.

**Demand** (`worker/demand.ts`) is pure: it turns appointments and levels into students and
instructors needed per block. An appointment counts if it's scheduled, attended or a drop-in, in
every 15-minute block it overlaps, at its level's in-center or online ratio. Grades map to levels
through Radius' grade ranges (Pre K = -1, K = 0, College counts as 12). The Demand tab reads
Radius and Sling fresh on each load, two requests each, with nothing cached. That stays well within
Radius' rate limit for one director.

## Center setup and roster

Everything Radius and Sling don't hold is in D1 (migration `0003_center_setup.sql`):

- **Center setup**: one settings row, opening hours, and school programs with their weekly
  sessions. Settings cover the presence rules, shift and break rules, travel, cadence and which
  Sling locations are the center and remote work.
- **Roster**: one row per Sling user. `POST /api/roster/sync` adds active Sling users who aren't on
  the roster, guessing their role from their Sling positions, and refreshes everyone's name, email,
  positions and active flag. The director's details are never overwritten.
- **Availability**: weekly windows with a starting date. All windows with the same `effective_from`
  form one pattern; the pattern in force on a date is the latest one starting on or before it. The
  suggestions merge the shifts each person worked on each weekday over the last 8 weeks, at any
  location, read four weeks per Sling request.
- Supervisors are the owner and assistant center directors (`SUPERVISOR_ROLES`).

## Stored credentials

- Radius and Sling passwords are encrypted with AES-GCM using a 256-bit key, `RADIUS_CREDENTIAL_KEY`
  (base64). Despite the name, the same key covers Sling. `worker/crypto.ts` uses only WebCrypto.
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

**Radius** (`worker/radiusProxy.ts`, shown by `src/RadiusSchedule.tsx`):

- The Worker fetches each page with `radiusFetch()` and serves it under `/radius/`.
- HTML responses have `href`, `src` and form `action` attributes rewritten to stay under `/radius/`.
  They also get a small script that patches `XMLHttpRequest.open`, because synchronous requests skip
  service workers.
- A service worker scoped to `/radius/` catches every other same-origin request a page makes (fetch,
  images, CSS) and prefixes it with `/radius`.
- If a Radius page navigates to a root-relative URL from a script, the frame lands on the app
  itself. `src/main.tsx` notices that it's inside its own frame and sends it on to `/radius/`.
- Responses lose `Set-Cookie`, `X-Frame-Options`, content security policy and HSTS headers.
  Redirects are rewritten to stay under `/radius/`. Requests get Radius' own `Origin` and `Referer`,
  because some Radius endpoints check them.
- Radius' live updates (SignalR websockets) can't be proxied this way. They arrive at `/signalr/*`,
  where the Worker answers 404, so SignalR falls back to long polling through the proxy. (Left to the
  static assets, the upgrade reaches Vite's middleware in dev, which crashes Miniflare.)

**Sling** (`worker/sling.ts`, shown by `src/SlingPanel.tsx`):

- `/sling/*` serves Sling's web app from `app.getsling.com`. Its JavaScript is rewritten to call
  `/sling/__api/` instead of `api.getsling.com`.
- Its HTML gets `<base href="/sling/">`, a placeholder `authorization-token` cookie, the
  organization ID cookie, and the same `XMLHttpRequest` patch. A service worker scoped to `/sling/`
  does the same job as the Radius one.
- Sling's realtime socket isn't proxied, so changes made elsewhere only show after a reload.

**Frontend**: `src/App.tsx` renders `src/RadiusLogin.tsx`, which shows the login form, then tabs:
Demand (`src/DemandView.tsx`), Center (`src/CenterSetup.tsx`), Roster (`src/Roster.tsx`), the Radius
schedule and the Sling panel. A tab mounts the first time it's opened and then stays mounted. The
Sling panel links Sling, then shows Sling's app. `src/api.ts` has the API client and the response
shapes, which have to be kept in step with the Worker's.

## Database

D1 database `mathnasium-scheduling`. Schema changes are migrations in `migrations/`, applied with
`bun run db:migrate:local` and `bun run db:migrate`.

| Table | Holds |
| --- | --- |
| `radius_accounts` | One row per app account: Radius username, encrypted password and IV, current Radius cookies. |
| `sessions` | App sessions: SHA-256 hash of the session token, account, expiry. |
| `sling_accounts` | One Sling link per app account: email, encrypted password and IV, current token, organization ID. |
| `center_settings` | One row: Radius center ID, time zone, presence, shift and break rules, travel, cadence, Sling location mapping. |
| `operating_hours` | Opening hours per weekday; a weekday without rows is closed. |
| `school_programs`, `program_sessions` | Off-site programs: Sling location, instructors needed, drive time; their weekly sessions. |
| `employees` | The roster, keyed by Sling user ID: role, highest grade, qualifications, teaching limit, remote work, priority, hours, work-from-home days. |
| `employee_programs` | Programs a person is first choice for. |
| `availability` | Weekly availability windows, grouped into patterns by starting date. |
| `employee_preferences` | Times a person prefers or avoids. |

Deleting an account deletes its sessions and Sling link (foreign keys with `ON DELETE CASCADE`).

## Secrets and configuration

| Secret | Used for |
| --- | --- |
| `RADIUS_CREDENTIAL_KEY` | Encrypting the stored Radius and Sling passwords. Generate with `openssl rand -base64 32`. |
| `CAPMONSTER_API_KEY` | Solving Sling's login captcha. |

Set them with `wrangler secret put` (add `--env staging` for staging) in production, and in
`.dev.vars` for local development. They're listed under `secrets.required` in `wrangler.jsonc`, so a
deploy fails if one is missing.

**Generated types**: `bun run types` writes `worker-configuration.d.ts` from `wrangler.jsonc`
(`wrangler types`), including the Workers runtime types. It's checked in, and `bun run typecheck`
fails if it's out of date. `worker/env.ts` re-exports it as `Env`. TypeScript uses project
references: `tsconfig.app.json` (the React app in `src/`, DOM types), `tsconfig.worker.json`
(`worker/`, Workers types only) and `tsconfig.node.json` (`vite.config.ts`), so browser and Workers
globals never mix.

**Environments**: the top level of `wrangler.jsonc` is production. `env.staging` deploys a separate
Worker, `mathnasium-scheduling-staging`, with its own D1 database and its own Workflow name
(Workflow names are unique per Cloudflare account). Bindings aren't inherited, so staging repeats
them. With the Vite plugin the environment is chosen at build time with `CLOUDFLARE_ENV`, not with
`wrangler deploy --env`: `bun run deploy:staging` runs `CLOUDFLARE_ENV=staging vite build`, then
`wrangler deploy` deploys the config the build wrote.

## Build and development

- **Build** (`bun run build`): `tsc -b` type checks, then `vite build` writes the React app to
  `dist/client/` and the bundled Worker, with a generated `wrangler.json`, to
  `dist/mathnasium_scheduling/`. `wrangler deploy` reads that generated config (it's redirected there
  by `.wrangler/deploy/config.json`).
- **Dev server** (`bun run dev`, `vite`): `@cloudflare/vite-plugin` runs the Worker in workerd
  inside the Vite dev server, against the local D1 database in `.wrangler/`, alongside the React app
  with hot reload. `/api/*`, `/radius/*` and `/sling/*` go to the Worker, as in production
  (`run_worker_first`). Secrets come from `.dev.vars`.
- **Pinned versions**: see `package.json`; compatibility date 2026-11-23.

## Known limitations

- **A refreshed Sling token still makes one request wait.** The sign-in runs in the background, but
  the proxy request that found the token expired waits for it.
- **Leaving the page while linking Sling** doesn't stop the sign-in, but the page won't show the
  result until it's reloaded.
- **Unofficial endpoints.** Neither Radius nor Sling has a public API for this. The app uses the
  endpoints their own sites use, which can change without notice.
- **No live updates** in the embedded views (see above).
