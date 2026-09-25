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
 * The cluster auto-pauses when idle (MinAcu=0 in template.yaml) and the Data API
 * rejects calls while it is waking back up.
 *
 * We retry, but only briefly. A full resume can take longer than 30 seconds, and
 * API Gateway's HTTP API cuts the integration off at 30s - so burning the whole
 * budget here just produces an opaque "Service Unavailable" at the client with
 * no idea why. Better to give the wake a short head start, then surface a
 * DatabaseResumingError the caller can turn into "waking up, retrying…".
 */
const RESUMING_ERRORS = new Set([
  'DatabaseResumingException',
  'StatementTimeoutException',
  'ServiceUnavailableError',
]);

/** Total time spent retrying a resuming cluster before giving up and reporting. */
const RESUME_RETRY_BUDGET_MS = 12_000;

/** Thrown when the cluster is still waking. Callers should map this to a 503. */
export class DatabaseResumingError extends Error {
  constructor() {
    super('The database is waking up from auto-pause. Try again in a few seconds.');
    this.name = 'DatabaseResumingError';
  }
}

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
  const deadline = Date.now() + RESUME_RETRY_BUDGET_MS;
  let attempt = 0;

  // Retry only while inside the budget - see RESUME_RETRY_BUDGET_MS above.
  for (;;) {
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
      const name = (err as { name?: string })?.name ?? '';
      if (!RESUMING_ERRORS.has(name)) throw err;   // a real error - do not retry

      // Out of budget: tell the caller the cluster is still waking rather than
      // sitting here until API Gateway times the whole request out.
      if (Date.now() >= deadline) throw new DatabaseResumingError();

      // Still waking. Back off 1s, 2s, 4s... but never past the deadline.
      const wait = Math.min(1000 * 2 ** attempt, deadline - Date.now());
      attempt++;
      if (wait > 0) await sleep(wait);
    }
  }
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
