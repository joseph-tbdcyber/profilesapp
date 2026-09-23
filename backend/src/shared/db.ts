/**
 * Thin wrapper around the RDS Data API.
 *
 * WHY THE DATA API: normally, talking to a database means opening a TCP
 * connection, which means your Lambda has to live inside the database's VPC,
 * which means VPC configuration, security groups, and (usually) a NAT Gateway
 * that costs real money. The Data API instead exposes the database over plain
 * HTTPS with IAM authentication. Our Lambdas need no VPC at all.
 *
 * The three environment variables come from template.yaml.
 */
import {
  RDSDataClient,
  ExecuteStatementCommand,
  BeginTransactionCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
  type SqlParameter,
} from '@aws-sdk/client-rds-data';

const client = new RDSDataClient({});

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const SECRET_ARN = process.env.SECRET_ARN!;
const DATABASE_NAME = process.env.DATABASE_NAME!;

/** Build a named string parameter for a SQL statement. */
export function str(name: string, value: string | null): SqlParameter {
  return { name, value: value === null ? { isNull: true } : { stringValue: value } };
}

/** Build a named integer parameter. */
export function num(name: string, value: number): SqlParameter {
  return { name, value: { longValue: value } };
}

/** Build a named float parameter (for similarity thresholds). */
export function dbl(name: string, value: number): SqlParameter {
  return { name, value: { doubleValue: value } };
}

/**
 * The cluster auto-pauses when idle (MinAcu=0 in template.yaml). The first
 * request after a pause has to wake it up, and the Data API rejects that first
 * call while the cluster is resuming. Retrying a few times with a pause turns
 * that into "slow" instead of "broken".
 */
const RESUMING_ERRORS = new Set([
  'DatabaseResumingException',
  'StatementTimeoutException',
  'ServiceUnavailableError',
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a SQL statement and get rows back as ordinary JavaScript objects.
 *
 * `formatRecordsAs: 'JSON'` asks the Data API to hand us a JSON string instead
 * of its verbose column-by-column format, which saves a lot of decoding.
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  parameters: SqlParameter[] = [],
  transactionId?: string,
): Promise<T[]> {
  let lastError: unknown;

  // Up to 5 attempts, backing off, to cover a cold cluster waking up.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await client.send(
        new ExecuteStatementCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          database: DATABASE_NAME,
          sql,
          parameters,
          transactionId,
          formatRecordsAs: 'JSON',
        }),
      );

      // No rows (e.g. an INSERT without RETURNING) -> empty array.
      if (!result.formattedRecords) return [];
      return JSON.parse(result.formattedRecords) as T[];
    } catch (err) {
      lastError = err;
      const name = (err as { name?: string })?.name ?? '';
      if (!RESUMING_ERRORS.has(name)) throw err;   // a real error - do not retry

      // Cluster is waking up. Wait and try again: 1s, 2s, 4s, 8s.
      await sleep(1000 * 2 ** attempt);
    }
  }

  throw lastError;
}

/** Run several statements atomically - all of them commit, or none do. */
export async function withTransaction<T>(
  fn: (transactionId: string) => Promise<T>,
): Promise<T> {
  const begun = await client.send(
    new BeginTransactionCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DATABASE_NAME,
    }),
  );
  const transactionId = begun.transactionId!;

  try {
    const out = await fn(transactionId);
    await client.send(
      new CommitTransactionCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        transactionId,
      }),
    );
    return out;
  } catch (err) {
    // Undo every write in this transaction so a half-finished submission never
    // lands in the database.
    await client
      .send(
        new RollbackTransactionCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          transactionId,
        }),
      )
      .catch(() => { /* rollback failures must not mask the original error */ });
    throw err;
  }
}

/** Standard HTTP response helper. CORS headers are added by API Gateway. */
export function respond(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
