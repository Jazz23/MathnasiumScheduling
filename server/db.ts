// The DynamoDB table. Everything is in one table, keyed by `pk` and `sk`:
//
//   pk                  sk                    holds
//   ACCOUNT#<id>        ACCOUNT               a Radius account (app account)
//   ACCOUNT#<id>        SLING                 its Sling link
//   ACCOUNT#<id>        LOCK#<name>           a sign-in lease (server/accountLock.ts)
//   ACCOUNT#<id>        SLING_SIGN_IN         the ID of its latest Sling sign-in
//   ACCOUNT#<id>        SLING_SIGN_IN#<id>    one Sling sign-in's state
//   USERNAME#<lower>    USERNAME              username -> account ID (keeps usernames unique)
//   SESSION#<sha256>    SESSION               an app session
//   CENTER              SETTINGS              center settings and opening hours
//   CENTER              PROGRAM#<id>          a school program and its sessions
//   CENTER              EMPLOYEE#<slingId>    a person on the roster, with availability and preferences
//   CENTER              DRAFT#<YYYY-MM-DD>    the latest draft schedule for the week starting that Monday
//   COUNTER             <name>                the last ID handed out for accounts or programs
//
// Items with a `ttl` (epoch seconds) are deleted by DynamoDB some time after
// it passes, so readers still check expiry themselves.
//
// TABLE_NAME names the table. DYNAMODB_ENDPOINT, if set, points at DynamoDB
// Local for development.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

export type Key = { pk: string; sk: string };
export type Item = Key & Record<string, unknown>;
export type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

let client: DynamoDBDocumentClient | undefined;

function db(): DynamoDBDocumentClient {
  client ??= DynamoDBDocumentClient.from(
    new DynamoDBClient(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  return client;
}

export function table(): string {
  const name = process.env.TABLE_NAME;
  if (!name) throw new Error("TABLE_NAME is not set");
  return name;
}

export const keys = {
  account: (id: number): Key => ({ pk: `ACCOUNT#${id}`, sk: "ACCOUNT" }),
  sling: (accountId: number): Key => ({ pk: `ACCOUNT#${accountId}`, sk: "SLING" }),
  lock: (accountId: number, name: string): Key => ({ pk: `ACCOUNT#${accountId}`, sk: `LOCK#${name}` }),
  slingSignInPointer: (accountId: number): Key => ({ pk: `ACCOUNT#${accountId}`, sk: "SLING_SIGN_IN" }),
  slingSignIn: (accountId: number, signInId: string): Key => ({ pk: `ACCOUNT#${accountId}`, sk: `SLING_SIGN_IN#${signInId}` }),
  username: (username: string): Key => ({ pk: `USERNAME#${username.toLowerCase()}`, sk: "USERNAME" }),
  session: (tokenHash: string): Key => ({ pk: `SESSION#${tokenHash}`, sk: "SESSION" }),
  settings: (): Key => ({ pk: "CENTER", sk: "SETTINGS" }),
  program: (id: number): Key => ({ pk: "CENTER", sk: `PROGRAM#${id}` }),
  employee: (slingUserId: number): Key => ({ pk: "CENTER", sk: `EMPLOYEE#${slingUserId}` }),
  /** The latest generated draft for the week starting on `weekStart` (a Monday). */
  draft: (weekStart: string): Key => ({ pk: "CENTER", sk: `DRAFT#${weekStart}` }),
};

/** Seconds since the epoch, the unit of every stored timestamp except where noted. */
export const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function getItem<T extends object>(key: Key): Promise<(T & Key) | null> {
  const { Item } = await db().send(new GetCommand({ TableName: table(), Key: key, ConsistentRead: true }));
  return (Item as (T & Key) | undefined) ?? null;
}

export interface Condition {
  expression: string;
  names?: Record<string, string>;
  values?: Record<string, unknown>;
}

export async function putItem(item: Item, condition?: Condition): Promise<void> {
  await db().send(
    new PutCommand({
      TableName: table(),
      Item: item,
      ConditionExpression: condition?.expression,
      ExpressionAttributeNames: condition?.names,
      ExpressionAttributeValues: condition?.values,
    }),
  );
}

/**
 * Sets the given attributes on an item (creating it if `mustExist` is false).
 * `undefined` values are skipped; use null to clear one.
 */
export async function updateItem(
  key: Key,
  values: Record<string, unknown>,
  options: { mustExist?: boolean; condition?: Condition } = {},
): Promise<void> {
  await db().send(new UpdateCommand({ TableName: table(), Key: key, ...updateParts(values, options) }));
}

/** The parts of an Update that sets `values`, for updateItem and transactions. */
export function updateParts(
  values: Record<string, unknown>,
  options: { mustExist?: boolean; condition?: Condition } = {},
) {
  const entries = Object.entries(values).filter(([, v]) => v !== undefined);
  const conditions = [options.mustExist ? "attribute_exists(pk)" : null, options.condition?.expression ?? null].filter(Boolean);
  return {
    UpdateExpression: `SET ${entries.map((_, i) => `#k${i} = :v${i}`).join(", ")}`,
    ExpressionAttributeNames: {
      ...Object.fromEntries(entries.map(([k], i) => [`#k${i}`, k])),
      ...options.condition?.names,
    },
    ExpressionAttributeValues: {
      ...Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v])),
      ...options.condition?.values,
    },
    ConditionExpression: conditions.length ? conditions.join(" AND ") : undefined,
  };
}

export async function deleteItem(key: Key): Promise<void> {
  await db().send(new DeleteCommand({ TableName: table(), Key: key }));
}

/** Every item in a partition, optionally only those whose sort key starts with `skPrefix`. */
export async function queryAll<T extends object>(pk: string, skPrefix?: string): Promise<(T & Key)[]> {
  const items: (T & Key)[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await db().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: skPrefix ? "pk = :pk AND begins_with(sk, :sk)" : "pk = :pk",
        ExpressionAttributeValues: skPrefix ? { ":pk": pk, ":sk": skPrefix } : { ":pk": pk },
        ExclusiveStartKey: start,
        ConsistentRead: true,
      }),
    );
    items.push(...((page.Items ?? []) as (T & Key)[]));
    start = page.LastEvaluatedKey;
  } while (start);
  return items;
}

/** Writes all or nothing (up to 100 items). */
export async function transact(items: TransactItem[]): Promise<void> {
  if (items.length === 0) return;
  await db().send(new TransactWriteCommand({ TransactItems: items }));
}

/** Puts and deletes many items, 25 at a time. Not atomic. */
export async function batchWrite(ops: ({ put: Item } | { delete: Key })[]): Promise<void> {
  for (let i = 0; i < ops.length; i += 25) {
    let requests = ops.slice(i, i + 25).map((op) => ("put" in op ? { PutRequest: { Item: op.put } } : { DeleteRequest: { Key: op.delete } }));
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      const result = await db().send(new BatchWriteCommand({ RequestItems: { [table()]: requests } }));
      requests = (result.UnprocessedItems?.[table()] ?? []) as typeof requests;
      if (attempt > 8 && requests.length) throw new Error("DynamoDB kept turning down a batch write");
    }
  }
}

/** The next number in a counter, starting at 1. */
export async function nextId(name: string): Promise<number> {
  const { Attributes } = await db().send(
    new UpdateCommand({
      TableName: table(),
      Key: { pk: "COUNTER", sk: name },
      UpdateExpression: "ADD #v :one",
      ExpressionAttributeNames: { "#v": "value" },
      ExpressionAttributeValues: { ":one": 1 },
      ReturnValues: "UPDATED_NEW",
    }),
  );
  return Attributes!.value as number;
}

/** True for a failed condition, in a single write or a transaction. */
export function isConditionFailure(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "ConditionalCheckFailedException" || name === "TransactionCanceledException";
}
