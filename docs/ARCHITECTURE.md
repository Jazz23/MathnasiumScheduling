# Architecture

The app's current design and the decisions behind it. Read this before making a major change.

This file only covers what is built or decided. What's planned, and the proposals that are still
open (including the AWS recommendations), are in `docs/PLAN.md`. When a proposal is decided
or built, record it here and update the plan to match.

## Decisions

| Decision | Why |
| --- | --- |
| **Fully serverless on AWS** (moved from Cloudflare on 2026-11-24): CloudFront serves the app from S3 and sends the API and proxies to a Lambda; DynamoDB stores the data. Deployed with the AWS CDK in TypeScript, to us-east-2 (the only region the AWS account allows). | No server to maintain. Lambda has no CPU limit like Workers' (the scheduler needs seconds of CPU, see `spikes/highs/`), and runs up to 15 minutes. |
| **Only the director uses the app.** Employees keep using Sling, and parents never use the app. | Employees already request time off in Sling and see their shifts there. One user keeps the app simple. |
| **One center.** Settings, roster and linked accounts aren't split by center. | The app is for this center only (decided 2026-11-24). |
| **Radius and Sling stay the sources of truth.** Appointments, the student-to-instructor ratio, attendance history and sessions left this month come from Radius. Time off and the published schedule come from Sling. The app stores only what neither one has. | No second copy of data to keep in sync, and the center keeps working the way it does today. |
| **Employee availability is entered in the app**, by the director (decided 2026-11-24). | Availability is a Sling Premium feature, and the center is on the free plan, so Sling has none to read. |
| **The app only changes Sling shifts it created itself.** | Shifts the director makes by hand in Sling are never overwritten. |
| **The app's shifts go into Sling unpublished**; the director publishes them there (decided 2026-11-24). | A last check in Sling before employees are notified. |
| **App accounts are Radius accounts** ("Login with Radius"). | Radius has no OAuth, so there's nothing to sign in with except a Radius username and password. Everyone who would use the app already has one, so there's no separate password to manage. |
| **The app stores Radius and Sling passwords, encrypted.** | Radius has no refresh tokens, and Sling's token expires. To keep working without asking the director to log in again, the server signs in again itself. |
| **CapMonster solves Sling's login captcha.** | Sling's login API requires a reCAPTCHA token. |
| **Radius and Sling are shown in the app through same-origin proxies.** | Both refuse to be shown in another site's iframe. Proxying also keeps their cookies and tokens on the server. |
| **React built with Vite**, no framework. Bun is the package manager and script runner. The server is plain Fetch API code (`Request` in, `Response` out), run by Hono's Lambda adapter in production and by the Vite dev server in dev. | One dev server gives hot reload for both on one origin, and the server code doesn't depend on where it runs. |
| **DynamoDB, one table** (decided 2026-11-24). | Serverless with no VPC, and nearly free at one director's scale. The app's data is small and read whole (all programs, the whole roster), so it fits a few item types under one partition. |
| **One sign-in at a time per account, coordinated in DynamoDB** with conditional writes. | Requests that find an expired login together share one sign-in, instead of each signing in again (for Sling, each paying for a captcha). Requests can land in different Lambda instances, so the lock can't live in memory. |
| **Sling sign-in runs in its own Lambda, invoked asynchronously** (decided 2026-11-24). | It waits up to 2 minutes for the captcha, and keeps going if the tab closes. The simplest thing that fits a 2-minute job; Step Functions or durable functions would add little. |
| **Responses are streamed** (function URL in `RESPONSE_STREAM` mode). | Sling's JavaScript bundles can be bigger than Lambda's 6 MB limit for buffered responses. |

## Overview

```
Browser ──> CloudFront
              ├─ /api/*, /radius*, /sling*, /signalr/* ──> API Lambda (server/lambda.ts → server/app.ts)
              └─ everything else ──> S3 (the React app; paths without a file extension get index.html)

API Lambda (server/app.ts)
  ├─ /api/auth/*, /api/sling ──> DynamoDB (accounts, sessions, stored logins)
  ├─ /api/setup/*, /api/roster/* ──> DynamoDB (center setup, roster) + Sling reads
  ├─ /api/demand ──> Radius reads + Sling reads + DynamoDB
  ├─ /api/drafts/* ──> Radius reads + Sling reads + HiGHS (in the Lambda) + DynamoDB
  ├─ /radius/*   ── signed-in proxy ──> radius.mathnasium.com
  ├─ /sling/*    ── proxy ───────────> app.getsling.com
  └─ /sling/__api/* ── adds token ───> api.getsling.com

Sign-ins go through server/accountLock.ts:
  Radius: signs in itself, holding a lease in DynamoDB
  Sling:  invokes the Sling sign-in Lambda (server/slingSignIn.ts) asynchronously,
          which calls CapMonster (api.capmonster.cloud) to solve the captcha
```

The infrastructure is one CDK stack per stage (`infra/stack.ts`). CloudFront's paths for the API
Lambda have to match `SERVER_PATHS` in `server/app.ts`, which the dev server uses too. CloudFront
doesn't cache them, and passes on every header except `Host`.

### Routes

| Route | File | What it does |
| --- | --- | --- |
| `POST /api/auth/radius` | `server/auth.ts` | Log in with Radius. Creates or updates the account and starts an app session. |
| `DELETE /api/auth/radius` | `server/auth.ts` | Unlink Radius: deletes the account, its stored password and cookies, all its sessions and its Sling link. |
| `GET /api/auth/me` | `server/auth.ts` | The signed-in account, or 401. |
| `POST /api/auth/logout` | `server/auth.ts` | Ends this browser's session. Radius stays linked. |
| `GET`, `POST`, `DELETE /api/sling` | `server/sling.ts` | Whether Sling is linked; start linking Sling (202 with the sign-in's ID); unlink Sling, stopping a sign-in that's still running. |
| `GET /api/sling/sign-in/:id` | `server/sling.ts` | Whether a Sling sign-in is pending, done or failed. Only the account's own sign-ins. |
| `/radius/*` | `server/radiusProxy.ts` | Radius pages and requests, made as the signed-in account. |
| `/sling/*` | `server/sling.ts` | Sling's web app files. |
| `/sling/__api/*` | `server/sling.ts` | Sling's API, with the stored token added. |
| `/radius/__proxy-sw.js`, `/sling/__proxy-sw.js` | the proxy files | Service workers for the embedded views (see below). |
| `GET /api/demand?start=&days=` | `server/demandApi.ts` | Booked demand per 15-minute block for up to 14 days, with the people on Sling's schedule, time off and shifts. |
| `GET /api/setup` | `server/setup.ts` | Center settings, opening hours and school programs. |
| `PUT /api/setup/center` | `server/setup.ts` | Saves the settings and replaces the opening hours. |
| `GET /api/setup/sling-groups` | `server/setup.ts` | Sling's locations and positions, for mapping. |
| `POST /api/setup/programs`, `PUT`, `DELETE /api/setup/programs/:id` | `server/setup.ts` | School programs and their sessions. |
| `GET /api/roster` | `server/roster.ts` | Everyone on the roster, with programs, availability and preferences. |
| `POST /api/roster/sync` | `server/roster.ts` | Imports people from Sling. |
| `PUT /api/roster/:slingUserId` | `server/roster.ts` | Saves a person's details and assigned programs. |
| `PUT /api/roster/:slingUserId/availability` | `server/roster.ts` | Replaces one availability pattern (`effectiveFrom` and its windows). |
| `PUT /api/roster/:slingUserId/preferences` | `server/roster.ts` | Replaces a person's prefer/avoid times. |
| `GET /api/roster/availability-suggestions?weeks=` | `server/roster.ts` | Each person's usual times from their past Sling shifts. |
| `GET /api/drafts/:weekStart` | `server/draftApi.ts` | The latest draft for the week starting that Monday, or null. |
| `POST /api/drafts/:weekStart/generate` | `server/draftApi.ts` | Generates a new draft for the week, keeping the last draft's locked shifts, and stores it. |
| `PUT /api/drafts/:weekStart/shifts` | `server/draftApi.ts` | Replaces the draft's shifts with the edited list and checks them. |
| `GET /api/db/health` | `server/app.ts` | Checks DynamoDB. |

Any other `/api/*` path returns 404 as JSON.

## Accounts and sessions

**Login with Radius** (`server/auth.ts`, `server/radius.ts`):

1. The app's own login form sends the Radius username and password to `POST /api/auth/radius`.
2. The server loads Radius' login page (`/Account/Login`) for its anti-forgery token and cookie, then
   posts the credentials. Radius redirects away from the login page on success and shows the form
   again on failure.
3. The server saves the Radius session cookies and the encrypted password on the account item. The
   username is unique and case-insensitive (a `USERNAME#` item points to the account), so logging
   in again updates the same account.
4. It starts an app session: a random 32-byte token in an `HttpOnly`, `Secure`, `SameSite=Lax`
   cookie named `session`, valid for 30 days. Only a SHA-256 hash of the token is stored. DynamoDB's
   TTL deletes expired sessions, and reads check the expiry too, since TTL can lag.

**Acting as the account in Radius**: `radiusFetch()` sends a request with the stored cookies. If
Radius answers with a 401 or a redirect to its login page, it asks `radiusSignIn()` for new cookies
and retries once. It doesn't follow redirects, and the request body must be replayable
(not a stream), because it may be sent twice. All Radius access goes through it.

**Sign-in lock** (`server/accountLock.ts`): a caller passes the time it sent the request that was
turned down. If a sign-in finished after that, the caller gets that result instead of starting
another. For Radius, the account item records when the server last signed in. A caller that needs
a sign-in takes the account's `LOCK#radius` lease (a conditional write that succeeds only if the
lease is free or past its 60-second expiry), decrypts the password, signs in and saves the cookies.
Callers that don't get the lease check every half second for a newer sign-in, for up to 90
seconds. For Sling, see below.

## Sling link

`server/sling.ts`:

1. The director enters their Sling email and password (`POST /api/sling`). The server encrypts the
   password and starts a sign-in with it (`slingSignIn()` in `server/accountLock.ts`): it writes a
   pending sign-in record, `sling-<account ID>-<time>`, and points the account's `SLING_SIGN_IN`
   item at it, marking any older pending one cancelled. Then it invokes the Sling sign-in Lambda
   asynchronously with the account ID, the sign-in ID and the encrypted credentials. It answers 202
   with the sign-in ID, and the page checks `GET /api/sling/sign-in/:id` every 3 seconds.
2. The Lambda (`server/slingSignIn.ts`) decrypts the password and asks CapMonster to solve Sling's
   reCAPTCHA v2 (task type `RecaptchaV2Task`, with the site key from Sling's login page). It checks
   every 5 seconds, for up to 2 minutes. A solve usually takes 10–60 seconds.
3. It posts the email, password and captcha answer to `api.getsling.com/v1/account/login`. Sling
   returns its token in the `Authorization` response header, along with the organization ID. A 401 or
   409 means wrong credentials, unless the message mentions the captcha. Wrong credentials fail the
   sign-in at once (`SlingLoginError`). Anything else is retried once, after 10 seconds, since each
   attempt pays for a captcha. Lambda's own retries are off.
4. In one transaction, it saves the token, organization ID and encrypted password as the account's
   Sling link and marks the sign-in done, on condition that `SLING_SIGN_IN` still points at it. That
   condition is how a newer sign-in, or unlinking Sling, stops an older one: it finishes but can't
   save. A sign-in still pending after 10 minutes counts as failed (its Lambda timed out or
   crashed).

**Using the token**: requests to `/sling/__api/*` get the stored token added. If Sling answers 401,
the server signs in again with the stored login. It reuses a running sign-in, or one that finished
after the turned-down request, and otherwise starts one. Starting one replaces `SLING_SIGN_IN` with
a compare-and-swap, so of two requests that start at once, one starts it and the other joins it.
The request waits for it (up to 3 minutes) and retries once. If Sling sends back a refreshed token,
it is saved.

Sling sits behind Cloudflare's bot protection, which rejects requests without a browser-like
`User-Agent`, so the server sends one.

## Reading Radius and Sling

The scheduler's data comes from two modules, and nothing else calls Radius or Sling for data:

- **`server/radiusData.ts`**: Radius' levels and ratios (parsed from the Center Settings page,
  where they're embedded as `radius.utilities.levels.push({...})` calls) and appointments (the
  Appointment Management grid's data request). Radius' POSTs need an anti-forgery token from any
  page, so the levels page load also provides the token. If a POST comes back as an error page (the
  session was renewed and the token went stale), it loads the page again and retries once. Dates
  and times are read from Radius' ready-made local strings, so no time zone conversion is needed.
- **`server/slingData.ts`**: people and groups (`/v1/users/concise`), and the calendar of shifts and
  time off (`/v1/calendar/{org}/users/{user}`, which returns everyone's for an admin). Calls go
  through `slingGet()` in `server/sling.ts`, which uses the stored token and signs in again when it
  expires, like the proxy.

Both check the shapes they get back and throw on anything unexpected, rather than guessing.

**Demand** (`server/demand.ts`) is pure: it turns appointments and levels into students and
instructors needed per block. An appointment counts if it's scheduled, attended or a drop-in, in
every 15-minute block it overlaps, at its level's in-center or online ratio. Grades map to levels
through Radius' grade ranges (Pre K = -1, K = 0, College counts as 12). The Demand tab reads
Radius and Sling fresh on each load, two requests each, with nothing cached. That stays well within
Radius' rate limit for one director.

## Center setup and roster

Everything Radius and Sling don't hold is in DynamoDB:

- **Center setup**: one settings item with the opening hours, and one item per school program with
  its weekly sessions. Settings not saved yet take their defaults from `DEFAULT_SETTINGS` in
  `server/setup.ts`. Settings cover the presence rules, shift and break rules, travel, cadence and which
  Sling locations are the center and remote work.
- **Roster**: one item per Sling user, holding their details, assigned programs, availability
  and preferences. `POST /api/roster/sync` adds active Sling users who aren't on
  the roster, guessing their role from their Sling positions, and refreshes everyone's name, email,
  positions and active flag. The director's details are never overwritten.
- **Availability**: weekly patterns, each a list of windows with a starting date (`effectiveFrom`); the pattern in force on a date is the latest one starting on or before it. The
  suggestions merge the shifts each person worked on each weekday over the last 8 weeks, at any
  location, read four weeks per Sling request.
- Supervisors are the owner and assistant center directors (`SUPERVISOR_ROLES`).

## Draft schedules

`POST /api/drafts/:weekStart/generate` (`server/draftApi.ts`) reads the week from Radius (levels and
appointments) and Sling (existing shifts and time off), one request after another, then solves it
with `server/scheduler.ts` and stores the result as one item (`DRAFT#<weekStart>`: the draft, and the
inputs it was made from, both as JSON).
It runs within the request: Radius and Sling take a few seconds and the solver stops after 25
seconds with the best draft so far, inside CloudFront's 60.

**The model** (`solveWeek()`) is an integer program in CPLEX LP format, solved by HiGHS (npm
`highs`, WebAssembly, loaded once per Lambda instance; `infra/stack.ts` copies `highs.wasm` next to
the bundle). It plans in 15-minute blocks, per employee and day: working at the center or not, where
each center shift starts, remote blocks only where there are online students, and one yes/no per
school program session (the session plus the drive each way). Teaching is continuous, in
instructors per level, so a mixed group uses each student's own ratio share. Hard rules are
constraints (availability, approved time off, existing shifts, qualifications by grade, max hours,
shift length, shifts per day, one place at a time, travel between home and the center). Coverage,
presence, program staffing, minimum and preferred hours and teaching limits have slack variables
with weights (`W` in `server/scheduler.ts`), so a draft always comes back and the slack is the
coverage report. Existing Sling shifts are fixed: they count toward presence, teaching and program
staffing. The presence rules apply over opening hours plus the setup and cleanup minutes around them.

**Editing** (feature 7): the Draft tab sends the whole edited list of shifts to
`PUT /api/drafts/:weekStart/shifts`. The server checks it with the same model, using the stored
inputs (so an edit doesn't read Radius or Sling) and with `draftNew` off: every shift is fixed, and
the solver only works out teaching, breaks and the coverage report. Each shift gets `issues` for the
rules it breaks (outside availability, during time off, overlapping another shift, too short or
long, at the center on a work-from-home day), and the hours table flags going over maximum hours.
Shifts edited or added by hand are locked. Generating again reads Radius and Sling fresh and keeps
the locked shifts as fixed.

Simplifications for now: breaks are placed after solving, in the block nearest the middle of the
shift where the others still cover the whole instructors' worth of students (a fraction over is
fine for 10 minutes, decided 2026-11-24), and reported when no block allows it. The longest shift is enforced
per day (with one shift a day, the default, that's the same thing). Fairness, consistency with
previous weeks and test prep or assessment qualifications aren't modelled yet. Predicted
(unbooked) students aren't in the demand until feature 5.

## Stored credentials

- Radius and Sling passwords are encrypted with AES-GCM using a 256-bit key, `RADIUS_CREDENTIAL_KEY`
  (base64). Despite the name, the same key covers Sling. `server/crypto.ts` uses only WebCrypto.
- Each password gets a random 12-byte IV. The ciphertext is tied to its account (the lowercased
  Radius username, or `sling:<email>`), so it can't be copied onto another item and still decrypt.
- If the key is lost or changed, stored passwords can't be decrypted, and the director has to log in
  and link Sling again.
- Anyone with both the key and the database can read the passwords.
- Credentials never reach the browser. The Radius proxy strips Radius' cookies from responses. The
  Sling page only gets a placeholder token, and the API proxy swaps in the real one.

## Embedded views

Radius and Sling both send `X-Frame-Options: SAMEORIGIN`, so the app shows them through proxies on
its own origin.

**Radius** (`server/radiusProxy.ts`, shown by `src/RadiusSchedule.tsx`):

- The server fetches each page with `radiusFetch()` and serves it under `/radius/`.
- HTML responses have `href`, `src` and form `action` attributes rewritten to stay under `/radius/`,
  by a small rewriter (`server/html.ts`) that changes only those attributes and leaves the rest of
  the page as it was.
  They also get a small script that patches `XMLHttpRequest.open`, because synchronous requests skip
  service workers.
- A service worker scoped to `/radius/` catches every other same-origin request a page makes (fetch,
  images, CSS) and prefixes it with `/radius`.
- If a Radius page navigates to a root-relative URL from a script, the frame lands on the app
  itself. `src/main.tsx` notices that it's inside its own frame and sends it on to `/radius/`.
- Responses lose `Set-Cookie`, `X-Frame-Options`, content security policy and HSTS headers.
  Redirects are rewritten to stay under `/radius/`. Requests get Radius' own `Origin` and `Referer`,
  because some Radius endpoints check them.
- Radius' live updates (SignalR websockets) can't be proxied this way, and Lambda can't take
  websockets anyway. They arrive at `/signalr/*`, where the server answers 404, so SignalR falls back
  to long polling through the proxy.

**Sling** (`server/sling.ts`, shown by `src/SlingPanel.tsx`):

- `/sling/*` serves Sling's web app from `app.getsling.com`. Its JavaScript is rewritten to call
  `/sling/__api/` instead of `api.getsling.com`.
- Its HTML gets `<base href="/sling/">`, a placeholder `authorization-token` cookie, the
  organization ID cookie, and the same `XMLHttpRequest` patch. A service worker scoped to `/sling/`
  does the same job as the Radius one.
- Sling's realtime socket isn't proxied, so changes made elsewhere only show after a reload.

**Frontend**: `src/App.tsx` renders `src/RadiusLogin.tsx`, which shows the login form, then tabs:
Demand (`src/DemandView.tsx`), Center (`src/CenterSetup.tsx`), Roster (`src/Roster.tsx`), the Radius
schedule and the Sling panel. A tab mounts the first time it's opened and then stays mounted. The
Sling panel links Sling, then shows Sling's app. Opening hours, program sessions, availability and
preferences are drawn on a Google Calendar-style week view (`src/WeekCalendar.tsx`): drag to add a block, drag it to move or
resize it, click it to delete it or switch prefer/avoid. Times snap to 15 minutes; overlapping
blocks of one kind merge, and drawing over another kind replaces it. Kinds can sit in layers:
a person's availability and preferences share one week, with preferences drawn narrower on top
of availability, and only the layer being drawn can be edited. One button saves both. `src/api.ts` has the API client and the response
shapes, which have to be kept in step with the server's.

## Database

One DynamoDB table per stage, keyed by `pk` (partition) and `sk` (sort), on-demand billing, with
point-in-time recovery. `server/db.ts` has the helpers and the keys:

| pk | sk | Holds |
| --- | --- | --- |
| `ACCOUNT#<id>` | `ACCOUNT` | An app account: Radius username, encrypted password and IV, current Radius cookies, when the server last signed in. |
| `ACCOUNT#<id>` | `SLING` | Its Sling link: email, encrypted password and IV, current token, organization ID. |
| `ACCOUNT#<id>` | `LOCK#radius` | The Radius sign-in lease. |
| `ACCOUNT#<id>` | `SLING_SIGN_IN` | The ID of its latest Sling sign-in. |
| `ACCOUNT#<id>` | `SLING_SIGN_IN#<id>` | One Sling sign-in: pending, done, failed or cancelled. Kept 7 days. |
| `USERNAME#<lowercase>` | `USERNAME` | Username → account ID. |
| `SESSION#<sha256>` | `SESSION` | An app session: account, expiry. |
| `CENTER` | `SETTINGS` | Center settings and opening hours. |
| `CENTER` | `PROGRAM#<id>` | A school program and its weekly sessions. |
| `CENTER` | `EMPLOYEE#<Sling user ID>` | A person on the roster: details, first-choice programs, availability patterns, preferences. |
| `COUNTER` | `account`, `program` | The last ID handed out. |

Items with a `ttl` attribute (sessions, leases, sign-in records) are deleted by DynamoDB after it
passes. Unlinking Radius deletes everything under the account's partition and its `USERNAME#` item.
Its sessions stop working at once, since reading a session also reads the account, and expire later.
Deleting a program leaves it in people's first-choice lists until their next save; `loadRoster`
leaves out programs that no longer exist.

There are no migrations: items are read with defaults for missing attributes. A change that needs
existing items rewritten gets a one-off script in `scripts/`. `scripts/import-d1.ts` copied the
Cloudflare D1 database in.

## Secrets and configuration

| Secret | Used for |
| --- | --- |
| `RADIUS_CREDENTIAL_KEY` | Encrypting the stored Radius and Sling passwords. Generate with `openssl rand -base64 32`. |
| `CAPMONSTER_API_KEY` | Solving Sling's login captcha. |

In AWS they're SSM Parameter Store SecureStrings, `/mathnasium-scheduling/<stage>/<name>`, created by
hand (CloudFormation can't create SecureStrings). The Lambdas read them once per instance
(`server/lambda.ts`); a missing one fails every request with a 500. In dev they come from
`.env.local`. `server/env.ts` is what the server code sees: the two secrets and a function that
starts a Sling sign-in in the background.

The Lambdas also get `TABLE_NAME`, `SSM_PREFIX` and (the API Lambda) `SLING_SIGN_IN_FUNCTION`.

**Stages**: `infra/app.ts` makes one stack per stage, `MathnasiumScheduling-<stage>`, from CDK
context (`-c stage=staging`; `prod` by default), each with its own table, Lambdas, bucket and
CloudFront distribution. Production's table has deletion protection, and every stage's table is
kept if its stack is deleted.

**Type checking**: TypeScript project references: `tsconfig.app.json` (the React app in `src/`, DOM
types), `tsconfig.server.json` (`server/` and `scripts/`, Node types), `tsconfig.infra.json`
(`infra/`) and `tsconfig.node.json` (`vite.config.ts`), so browser and Node globals never mix.

## Build and development

- **Build** (`bun run build`): `tsc -b` type checks, then `vite build` writes the React app to
  `dist/client/`.
- **Deploy** (`bun run deploy`, `bun run deploy:staging`): builds, then `cdk deploy`. The CDK app
  (`cdk.json`, run with Bun) bundles `server/lambda.ts` with esbuild into both Lambdas (ES module,
  Node.js 24 on ARM, the AWS SDK left to the runtime), uploads `dist/client/` to S3 and clears
  CloudFront's cache. Synthesizing fails if `dist/client/` hasn't been built.
- **Dev server** (`bun run dev`, `vite`): a plugin in `vite.config.ts` runs `server/app.ts` inside
  the Vite dev server for `SERVER_PATHS`, loaded through Vite so server edits apply on the next
  request. Sling sign-ins run in the dev server instead of a Lambda. Settings and secrets come from
  `.env.local` (see `.env.example`): the table is either DynamoDB Local (`bun run db:local` creates
  it) or a real one.
- **Pinned versions**: see `package.json`.

## Known limitations

- **CloudFront waits 60 seconds for the API.** A Sling request that has to wait for a sign-in can
  take longer than that and get a 504; the sign-in carries on, and a reload works once it's done.
  AWS can raise the limit to 180 seconds on request.
- **The API's function URL is public.** CloudFront's origin access control for function URLs would
  need the browser to sign every POST body, so it isn't used. Every route checks the app session, so
  calling the URL directly gets no further than going through CloudFront.

- **A refreshed Sling token still makes one request wait.** The sign-in runs in the background, but
  the proxy request that found the token expired waits for it.
- **Leaving the page while linking Sling** doesn't stop the sign-in, but the page won't show the
  result until it's reloaded.
- **Unofficial endpoints.** Neither Radius nor Sling has a public API for this. The app uses the
  endpoints their own sites use, which can change without notice.
- **No live updates** in the embedded views (see above).
