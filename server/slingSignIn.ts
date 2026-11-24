// Signs in to Sling in the background. A sign-in waits up to 2 minutes for
// CapMonster to solve Sling's captcha, which is too long to tie to a web
// request. In production it runs in its own Lambda, invoked asynchronously
// (server/lambda.ts), so it keeps going if the tab closes; in dev it runs in
// the dev server. Started only by slingSignIn() in accountLock.ts, so there's
// one at a time per account.
//
// Solving the captcha and logging in stay together, because a solved captcha
// expires quickly. The result is saved only while this is still the
// account's latest sign-in (see slingSignInAndSave).

import type { Env } from "./env";
import { finishSlingSignIn, type SlingLinkCredentials } from "./accountLock";
import { SlingLoginError, SlingSignInSuperseded, slingSignInAndSave } from "./sling";

/** What a background Sling sign-in is given. Without `link`, it uses the stored login. */
export interface SlingSignInJob {
  accountId: number;
  signInId: string;
  link?: SlingLinkCredentials;
}

// One retry: each attempt pays for a captcha.
const ATTEMPTS = 2;
const RETRY_DELAY_MS = 10_000;

export async function runSlingSignIn(env: Env, job: SlingSignInJob): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await slingSignInAndSave(env, job);
      return; // slingSignInAndSave marked it done
    } catch (err) {
      if (err instanceof SlingSignInSuperseded) return;
      // Wrong credentials won't get better on a retry.
      if (err instanceof SlingLoginError) {
        await finishSlingSignIn(job.accountId, job.signInId, { state: "failed", credentials: true, message: err.message });
        return;
      }
      console.error(`Sling sign-in ${job.signInId}, attempt ${attempt}, failed`, err);
      if (attempt >= ATTEMPTS) {
        await finishSlingSignIn(job.accountId, job.signInId, {
          state: "failed",
          credentials: false,
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}
