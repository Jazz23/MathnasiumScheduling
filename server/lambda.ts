// The two Lambda entry points, deployed by infra/stack.ts:
//
// - `api`: behind a function URL (response streaming) and CloudFront. Turns
//   each request into a Fetch API Request for handleRequest().
// - `slingSignIn`: invoked asynchronously by `api` to run one Sling sign-in.
//
// Secrets come from SSM Parameter Store (SecureString parameters under
// SSM_PREFIX), read once per Lambda instance.

import { Hono } from "hono";
import { streamHandle } from "@hono/aws-lambda";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { Env } from "./env";
import { handleRequest } from "./app";
import { runSlingSignIn, type SlingSignInJob } from "./slingSignIn";

const SECRETS = ["RADIUS_CREDENTIAL_KEY", "CAPMONSTER_API_KEY"] as const;

async function loadSecrets(): Promise<Record<(typeof SECRETS)[number], string>> {
  const prefix = process.env.SSM_PREFIX;
  if (!prefix) throw new Error("SSM_PREFIX is not set");
  const names = SECRETS.map((s) => `${prefix}/${s}`);
  const { Parameters = [], InvalidParameters = [] } = await new SSMClient({}).send(
    new GetParametersCommand({ Names: names, WithDecryption: true }),
  );
  if (InvalidParameters.length) throw new Error(`Missing SSM parameters: ${InvalidParameters.join(", ")}`);
  const value = (name: string) => Parameters.find((p) => p.Name === `${prefix}/${name}`)?.Value ?? "";
  return { RADIUS_CREDENTIAL_KEY: value("RADIUS_CREDENTIAL_KEY"), CAPMONSTER_API_KEY: value("CAPMONSTER_API_KEY") };
}

let envPromise: Promise<Env> | undefined;

function getEnv(): Promise<Env> {
  envPromise ??= loadSecrets().then((secrets) => {
    const lambda = new LambdaClient({});
    return {
      ...secrets,
      async startSlingSignIn(job: SlingSignInJob) {
        const functionName = process.env.SLING_SIGN_IN_FUNCTION;
        if (!functionName) throw new Error("SLING_SIGN_IN_FUNCTION is not set");
        // "Event": queued and run in the background; the call returns at once.
        await lambda.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "Event", Payload: JSON.stringify(job) }));
      },
    };
  });
  // Try again on the next request if loading failed.
  envPromise.catch(() => (envPromise = undefined));
  return envPromise;
}

const app = new Hono();
app.all("*", async (c) => handleRequest(c.req.raw, await getEnv()));
app.onError((err) => {
  console.error(err);
  return Response.json({ error: "Something went wrong." }, { status: 500 });
});

export const api = streamHandle(app);

export async function slingSignIn(job: SlingSignInJob): Promise<void> {
  await runSlingSignIn(await getEnv(), job);
}
