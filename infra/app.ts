// CDK app (cdk.json runs it with Bun). The stage comes from context:
// `cdk deploy -c stage=staging`; production is the default.

import * as cdk from "aws-cdk-lib";
import { AppStack } from "./stack.ts";

const app = new cdk.App();
const stage = (app.node.tryGetContext("stage") as string | undefined) ?? "prod";
if (!/^[a-z][a-z0-9-]*$/.test(stage)) throw new Error(`Bad stage name: ${stage}`);

new AppStack(app, `MathnasiumScheduling-${stage}`, {
  stage,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" },
  tags: { app: "mathnasium-scheduling", stage },
});
