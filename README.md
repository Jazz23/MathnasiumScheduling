# Mathnasium Scheduling

React app built with Vite, on AWS: CloudFront serves the app from S3 and sends `/api/*`, `/radius/*`
and `/sling/*` to a Lambda, backed by DynamoDB. The infrastructure is a TypeScript CDK app in
`infra/`.

```bash
bun install               # install dependencies
bun run dev               # Vite dev server with HMR; the server runs inside it (needs .env.local)
bun run build             # type check, then build the app into dist/client/
bun run deploy            # build + deploy the prod stack (needs AWS credentials)
bun run deploy:staging    # build + deploy the staging stack
bun run typecheck         # tsc -b over the app, server and infrastructure
bun run lint              # oxlint
bun run cdk diff -c stage=prod   # any other CDK command
```

Layout: `src/` is the React app, `server/` the API and proxies (run by Lambda, or by the Vite dev
server), `infra/` the CDK stack, `scripts/` one-off tools. See `docs/ARCHITECTURE.md`.

## Local development

```bash
cp .env.example .env.local                                  # then fill in the two secrets
docker run -d -p 8000:8000 amazon/dynamodb-local            # DynamoDB Local
bun run db:local                                            # create the table in it
bun run dev
```

Or point `.env.local` at a real table (staging's) with your AWS credentials instead.

## First deploy of a stage

```bash
aws configure                                               # or AWS_PROFILE=...
bunx cdk bootstrap aws://<account-id>/us-east-2             # once per account and region
aws ssm put-parameter --type SecureString --name /mathnasium-scheduling/prod/RADIUS_CREDENTIAL_KEY --value "$(openssl rand -base64 32)"
aws ssm put-parameter --type SecureString --name /mathnasium-scheduling/prod/CAPMONSTER_API_KEY --value <key>
bun run deploy                                              # prints the CloudFront URL
```

For staging, use `/mathnasium-scheduling/staging/...` and `bun run deploy:staging`.

To bring over the data from the old Cloudflare D1 database (settings, programs, roster, accounts),
with Wrangler logged in to Cloudflare:

```bash
bun run import-d1 <TableName output of the stack>
```

Run it on a new table. Stored passwords only decrypt if the stage's `RADIUS_CREDENTIAL_KEY` is the
Worker's key. Cloudflare can't show a secret again, so without a saved copy, log in with Radius
again after the import and link Sling again.

## Login with Radius

Radius (radius.mathnasium.com) has no OAuth or refresh tokens, and it can't be embedded in an iframe. So "Log in with Radius" is the app's own form: the server signs in to Radius with those credentials, saves the Radius session cookies, and saves the password AES-GCM encrypted in DynamoDB. `radiusFetch()` in `server/radius.ts` makes requests as the user and signs in again whenever the Radius session expires. "Unlink Radius" deletes everything stored for the account.

If `RADIUS_CREDENTIAL_KEY` is lost or changed, stored passwords can't be decrypted and users have to log in with Radius again.
