# Mathnasium Scheduling

React app built with Vite, served by a Cloudflare Worker (static assets + `/api/*`, `/radius/*` and `/sling/*` routes) backed by D1. The Vite build and dev server use `@cloudflare/vite-plugin`.

```bash
bun install               # install dependencies
bun run dev               # Vite dev server with HMR; the Worker runs in workerd against the local D1
bun run build             # type check, then build the app and Worker into dist/
bun run preview           # build, then preview the production build locally
bun run deploy            # build + deploy to Cloudflare
bun run deploy:staging    # build for env.staging + deploy mathnasium-scheduling-staging
bun run typecheck         # check generated Worker types are current, then tsc -b
bun run types             # regenerate worker-configuration.d.ts after changing wrangler.jsonc
bun run lint              # oxlint
```

Layout: `src/` is the React app, `worker/` is the Worker, `migrations/` holds D1 migrations. See `docs/ARCHITECTURE.md`.

Database migrations (D1, files in `migrations/`):

```bash
bun run db:migration:new <name>   # create a migration
bun run db:migrate:local          # apply to the local dev database
bun run db:migrate                # apply to the production database
```

## Login with Radius

Radius (radius.mathnasium.com) has no OAuth or refresh tokens, and it can't be embedded in an iframe. So "Log in with Radius" is the app's own form: the Worker signs in to Radius with those credentials, saves the Radius session cookies, and saves the password AES-GCM encrypted in D1. `radiusFetch()` in `worker/radius.ts` makes requests as the user and signs in again whenever the Radius session expires. "Unlink Radius" deletes everything stored for the account.

The encryption key is a Worker secret:

```bash
openssl rand -base64 32 | bunx wrangler secret put RADIUS_CREDENTIAL_KEY   # production
echo "RADIUS_CREDENTIAL_KEY=$(openssl rand -base64 32)" > .dev.vars         # local dev
```

If the key is lost or changed, stored passwords can't be decrypted and users have to log in with Radius again.
