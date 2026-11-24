// What the server needs from where it runs: the two secrets, and a way to
// start a Sling sign-in in the background. In Lambda (server/lambda.ts) the
// secrets come from SSM Parameter Store and sign-ins run in their own Lambda;
// in `vite` dev (vite.config.ts) both come from the dev server.

import type { SlingSignInJob } from "./slingSignIn";

export interface Env {
  /** Base64 AES-256 key for the stored Radius and Sling passwords. */
  RADIUS_CREDENTIAL_KEY: string;
  /** CapMonster Cloud API key, for Sling's login captcha. */
  CAPMONSTER_API_KEY: string;
  /** Starts a Sling sign-in that keeps running after the request ends. */
  startSlingSignIn(job: SlingSignInJob): Promise<void>;
}
