// Signs in to Sling in the background. A sign-in waits up to 2 minutes for
// CapMonster to solve Sling's captcha, which is too long to tie to a web
// request: a Workflow step has no wall-clock limit and keeps going if the tab
// closes. Started only by AccountLock, so there's one at a time per account.
//
// Solving the captcha and logging in stay in one step, because a solved
// captcha expires quickly. The step saves the token itself and returns only
// a timestamp, so no token or password is kept in the Workflow's saved state.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env } from "./env";
import type { SlingSignInParams, SlingSignInResult } from "./accountLock";
import { SLING_LOGIN_ERROR, SlingLoginError, slingSignInAndSave } from "./sling";

export class SlingSignIn extends WorkflowEntrypoint<Env, SlingSignInParams> {
  override async run(event: WorkflowEvent<SlingSignInParams>, step: WorkflowStep): Promise<SlingSignInResult> {
    return step.do(
      "sign in to Sling",
      // One retry: each attempt pays for a captcha.
      { retries: { limit: 1, delay: "10 seconds", backoff: "constant" }, timeout: "5 minutes" },
      async () => {
        try {
          await slingSignInAndSave(this.env, event.payload);
        } catch (err) {
          // Wrong credentials won't get better on a retry.
          if (err instanceof SlingLoginError) throw new NonRetryableError(err.message, SLING_LOGIN_ERROR);
          throw err;
        }
        return { signedInAt: Date.now() };
      },
    );
  }
}
