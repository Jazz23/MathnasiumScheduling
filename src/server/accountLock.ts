// One Durable Object per app account (named by the account ID), so that only
// one Radius or Sling sign-in runs at a time for it. Requests that find an
// expired login at the same time share one sign-in, instead of each signing
// in again (for Sling, each solving a paid captcha).
//
// Radius sign-ins are quick and run here. Sling sign-ins take up to a couple
// of minutes, so they run in the SlingSignIn Workflow; this object only makes
// sure there's one running, and remembers its instance ID in storage in case
// the object restarts while it runs.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { radiusSignInAgain } from "./radius";

/** The Sling credentials to link, with the password already encrypted. */
export interface SlingLinkCredentials {
  email: string;
  ciphertext: string;
  iv: string;
}

/** Input of the SlingSignIn Workflow. Without `link`, it uses the stored login. */
export interface SlingSignInParams {
  accountId: number;
  link?: SlingLinkCredentials;
}

/** Output of a completed SlingSignIn Workflow. */
export interface SlingSignInResult {
  signedInAt: number;
}

/** Either a sign-in already finished, or the Workflow instance to wait for. */
export type SlingSignInTicket = { done: true } | { instanceId: string };

const SLING_INSTANCE_KEY = "slingInstance";
const ACTIVE = new Set(["queued", "running", "waiting", "paused", "waitingForPause"]);

export class AccountLock extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private radiusSignedInAt = 0;

  /** Runs calls one after another, even across awaits. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Returns fresh Radius cookies. `since` is when the caller sent the request
   * that found its session expired: if another caller signed in after that,
   * its cookies are reused.
   */
  radiusSignIn(accountId: number, since: number): Promise<string> {
    return this.serial(async () => {
      if (this.radiusSignedInAt >= since) {
        const row = await this.env.DB.prepare("SELECT radius_cookies FROM radius_accounts WHERE id = ?")
          .bind(accountId)
          .first<{ radius_cookies: string | null }>();
        if (row?.radius_cookies) return row.radius_cookies;
      }
      const cookies = await radiusSignInAgain(this.env, accountId);
      this.radiusSignedInAt = Date.now();
      return cookies;
    });
  }

  /**
   * Starts a Sling sign-in, or joins the one already running.
   *
   * - With `link`, always starts a new one with those credentials, stopping
   *   any that's running with the old ones.
   * - Otherwise signs in again with the stored login, unless one finished
   *   after `since` (when the caller's token was turned down).
   */
  slingSignIn(
    accountId: number,
    options: { since: number; link?: undefined } | { link: SlingLinkCredentials },
  ): Promise<SlingSignInTicket> {
    return this.serial(async () => {
      const current = await this.currentSlingInstance();
      if (options.link) {
        await current?.terminate().catch(() => {});
      } else if (current) {
        const status = await current.status();
        if (ACTIVE.has(status.status)) return { instanceId: current.id };
        const output = status.output as SlingSignInResult | undefined;
        if (status.status === "complete" && output && output.signedInAt >= options.since) return { done: true };
      }
      const instance = await this.env.SLING_SIGN_IN.create({
        id: `sling-${accountId}-${Date.now()}`,
        params: { accountId, link: options.link } satisfies SlingSignInParams,
      });
      await this.ctx.storage.put(SLING_INSTANCE_KEY, instance.id);
      return { instanceId: instance.id };
    });
  }

  /** Stops a running Sling sign-in, for example when Sling is unlinked. */
  cancelSlingSignIn(): Promise<void> {
    return this.serial(async () => {
      const current = await this.currentSlingInstance();
      await current?.terminate().catch(() => {});
      await this.ctx.storage.delete(SLING_INSTANCE_KEY);
    });
  }

  private async currentSlingInstance() {
    const id = await this.ctx.storage.get<string>(SLING_INSTANCE_KEY);
    if (!id) return null;
    return this.env.SLING_SIGN_IN.get(id).catch(() => null);
  }
}
