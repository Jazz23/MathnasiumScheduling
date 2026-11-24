// The whole app on AWS, one stack per stage (prod, staging):
//
//   Browser ──> CloudFront ──┬─ /api/*, /radius*, /sling*, /signalr/* ──> API Lambda (function URL, streamed)
//                            └─ everything else ──> S3 (the React app, single-page fallback)
//   API Lambda ──> DynamoDB table, SSM parameters (secrets),
//                  Sling sign-in Lambda (invoked asynchronously)

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_DIR = path.join(ROOT, "dist", "client");

export interface AppStackProps extends cdk.StackProps {
  stage: string;
}

export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { stage } = props;
    const ssmPrefix = `/mathnasium-scheduling/${stage}`;

    // Keys and items are described in server/db.ts.
    const table = new dynamodb.TableV2(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: stage === "prod",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const functionProps = (name: string): nodejs.NodejsFunctionProps => ({
      entry: path.join(ROOT, "server", "lambda.ts"),
      projectRoot: ROOT,
      depsLockFilePath: path.join(ROOT, "bun.lock"),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      environment: { TABLE_NAME: table.tableName, SSM_PREFIX: ssmPrefix, NODE_OPTIONS: "--enable-source-maps" },
      bundling: {
        format: nodejs.OutputFormat.ESM,
        minify: true,
        sourceMap: true,
        // Some dependencies call require() in an ES module bundle.
        banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      logGroup: new logs.LogGroup(this, `${name}Logs`, {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // One Sling sign-in per invocation: up to two attempts of about 2 minutes
    // each. It retries itself, so Lambda doesn't.
    const slingSignIn = new nodejs.NodejsFunction(this, "SlingSignIn", {
      ...functionProps("SlingSignIn"),
      handler: "slingSignIn",
      memorySize: 256,
      timeout: cdk.Duration.minutes(8),
      retryAttempts: 0,
    });

    // A request can wait up to 3 minutes for a Sling sign-in (server/sling.ts),
    // though CloudFront gives up on it after 60 seconds.
    const api = new nodejs.NodejsFunction(this, "Api", {
      ...functionProps("Api"),
      handler: "api",
      memorySize: 1024,
      timeout: cdk.Duration.minutes(3),
    });
    api.addEnvironment("SLING_SIGN_IN_FUNCTION", slingSignIn.functionName);
    slingSignIn.grantInvoke(api);

    for (const fn of [api, slingSignIn]) {
      table.grantReadWriteData(fn);
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameters"],
          resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${ssmPrefix}/*`],
        }),
      );
    }

    // Public, as CloudFront's origin access control for function URLs needs
    // browsers to sign POST bodies. Every route checks the app session itself.
    const apiUrl = api.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    const site = new s3.Bucket(this, "Site", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Paths without a file extension are the React app's own pages.
    const spaFallback = new cloudfront.Function(this, "SpaFallback", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  if (request.uri.indexOf(".") === -1) request.uri = "/index.html";
  return request;
}`),
    });

    const serverBehavior: cloudfront.BehaviorOptions = {
      origin: new origins.FunctionUrlOrigin(apiUrl, { readTimeout: cdk.Duration.seconds(60) }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };

    // Keep in step with SERVER_PATHS in server/app.ts.
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: `Mathnasium Scheduling (${stage})`,
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [{ function: spaFallback, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        "/api/*": serverBehavior,
        "/radius*": serverBehavior,
        "/sling*": serverBehavior,
        "/signalr/*": serverBehavior,
      },
    });

    if (!existsSync(path.join(CLIENT_DIR, "index.html"))) {
      throw new Error(`${CLIENT_DIR} has no build. Run \`bun run build\` first (\`bun run deploy\` does).`);
    }
    new s3deploy.BucketDeployment(this, "SiteDeployment", {
      sources: [s3deploy.Source.asset(CLIENT_DIR)],
      destinationBucket: site,
      distribution,
      distributionPaths: ["/*"],
    });

    new cdk.CfnOutput(this, "Url", { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, "TableName", { value: table.tableName });
    new cdk.CfnOutput(this, "SsmPrefix", { value: ssmPrefix });
  }
}
