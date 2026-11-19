# Mathnasium Scheduling

React frontend bundled with Bun, served by a Cloudflare Worker (static assets + `/api/*` routes) backed by D1.

```bash
bun install          # install dependencies
bun run dev          # app with HMR on http://localhost:3000, /api/* proxied to wrangler dev (local D1)
bun run dev:worker   # wrangler dev only (http://localhost:8787, no HMR)
bun run deploy       # build + deploy to Cloudflare
bun check            # type check
```

Database migrations (D1, files in `migrations/`):

```bash
bun run db:migration:new <name>   # create a migration
bun run db:migrate:local          # apply to the local dev database
bun run db:migrate                # apply to the production database
```

## Login with Radius

Radius (radius.mathnasium.com) has no OAuth or refresh tokens, and it can't be embedded in an iframe. So "Log in with Radius" is the app's own form: the Worker signs in to Radius with those credentials, saves the Radius session cookies, and saves the password AES-GCM encrypted in D1. `radiusFetch()` in `src/server/radius.ts` makes requests as the user and signs in again whenever the Radius session expires. "Unlink Radius" deletes everything stored for the account.

The encryption key is a Worker secret:

```bash
openssl rand -base64 32 | bunx wrangler secret put RADIUS_CREDENTIAL_KEY   # production
echo "RADIUS_CREDENTIAL_KEY=$(openssl rand -base64 32)" > .dev.vars         # local dev
```

If the key is lost or changed, stored passwords can't be decrypted and users have to log in with Radius again.
