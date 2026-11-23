// The Workers runtime types this project uses, made visible without loading
// all of @cloudflare/workers-types as globals (its Request, Response and
// fetch would clash with Bun's).
//
// worker-configuration.d.ts (from `wrangler types --include-runtime=false`)
// names binding types as globals, so they're aliased here. The runtime's
// own modules are declared from the package's module-style types.

type D1Database = import("@cloudflare/workers-types/index.ts").D1Database;
// Only the static assets binding is a Fetcher. The package's Fetcher uses its
// own Request and Response, so this one uses the global (Bun's) ones.
type Fetcher = { fetch(request: Request): Promise<Response> };
type DurableObjectNamespace<T extends import("@cloudflare/workers-types/index.ts").Rpc.DurableObjectBranded | undefined = undefined> =
  import("@cloudflare/workers-types/index.ts").DurableObjectNamespace<T>;
type Workflow<PARAMS = unknown> = import("@cloudflare/workers-types/index.ts").Workflow<PARAMS>;

declare module "cloudflare:workers" {
  import { CloudflareWorkersModule } from "@cloudflare/workers-types/index.ts";
  export = CloudflareWorkersModule;
}

declare module "cloudflare:workflows" {
  export class NonRetryableError extends Error {
    public constructor(message: string, name?: string);
  }
}
