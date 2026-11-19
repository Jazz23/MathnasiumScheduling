# Mathnasium Scheduling

React frontend bundled with Bun, served by a Cloudflare Worker (static assets + `/api/*` routes) backed by D1.

```bash
bun install          # install dependencies
bun run dev          # wrangler dev: rebuilds on src/ changes, local D1
bun run deploy       # build + deploy to Cloudflare
bun check            # type check
```

Database migrations (D1, files in `migrations/`):

```bash
bun run db:migration:new <name>   # create a migration
bun run db:migrate:local          # apply to the local dev database
bun run db:migrate                # apply to the production database
```
