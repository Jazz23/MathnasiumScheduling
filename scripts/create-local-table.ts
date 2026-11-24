// Creates the dev table in DynamoDB Local, with the same keys as
// infra/stack.ts. Reads TABLE_NAME and DYNAMODB_ENDPOINT from .env.local
// (Bun loads it). Does nothing if the table exists.
//
//   bun run db:local

import { CreateTableCommand, DynamoDBClient, ResourceInUseException } from "@aws-sdk/client-dynamodb";

const endpoint = process.env.DYNAMODB_ENDPOINT;
const TableName = process.env.TABLE_NAME;
if (!endpoint || !TableName) throw new Error("Set TABLE_NAME and DYNAMODB_ENDPOINT in .env.local");

try {
  await new DynamoDBClient({ endpoint }).send(
    new CreateTableCommand({
      TableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    }),
  );
  console.log(`Created ${TableName} at ${endpoint}.`);
} catch (err) {
  if (!(err instanceof ResourceInUseException)) throw err;
  console.log(`${TableName} already exists.`);
}
