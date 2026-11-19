// Import Workers types as a module (not ambient) so they don't clash with
// bun-types' global Request/Response.
import type { D1Database } from "@cloudflare/workers-types/index.ts";

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: D1Database;
  // Base64-encoded 32-byte AES key for stored Radius passwords.
  // Set with `wrangler secret put RADIUS_CREDENTIAL_KEY`; locally in .dev.vars.
  RADIUS_CREDENTIAL_KEY: string;
  // CapMonster Cloud API key, used to solve Sling's login reCAPTCHA.
  // Set with `wrangler secret put CAPMONSTER_API_KEY`; locally in .dev.vars.
  CAPMONSTER_API_KEY: string;
}
