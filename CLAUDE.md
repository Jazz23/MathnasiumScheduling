- Always Git Pull at the start of a new session.
- Always assume that a user is already running a dev server, but you can check if necessary as this may not be the case.
- The project is React built with Vite and `@cloudflare/vite-plugin`, deployed as a Cloudflare Worker. The React app is in `src/`, the Worker in `worker/`. Bun is the package manager and script runner.
- The current design and the decisions behind it are in docs/ARCHITECTURE.md. Read this before making any major changes or before grilling.
- Always use Context7 to fetch up todate documentation for any library you intend on using, such as bun itself.
- Whenever pinning a version of a library of any kind (postgres, etc), always search the internet for the latest stable release.
- Do not test code unless explicitly asked to do so.

Use Bun as the package manager and script runner.

- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Type check with `bun run typecheck` (checks generated Worker types are current, then `tsc -b`).
- Run `bun run types` after changing `wrangler.jsonc`.
- The Worker runs in the Workers runtime, not Bun: don't use `Bun.*` APIs in `worker/`.
