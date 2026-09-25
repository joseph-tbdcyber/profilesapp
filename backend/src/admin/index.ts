/**
 * Read-only database console API. Two routes:
 *
 *   POST /admin/schema  - the topology: Aurora cluster + its tables/columns/row
 *                         counts, plus the Amplify DynamoDB tables
 *   POST /admin/query   - run one SELECT and return columns + rows
 *
 * ---------------------------------------------------------------------------
 * SECURITY - READ THIS BEFORE CHANGING ANYTHING HERE
 * ---------------------------------------------------------------------------
 * This endpoint is PUBLIC and UNAUTHENTICATED. Anyone who finds the URL can run
 * SELECT statements against the database. That is a deliberate, accepted
 * trade-off for a demo holding fake vendor data - it would be unacceptable for
 * anything real.
 *
 * Writes are prevented by THREE layers, in order of how much they are worth:
 *
 *   1. A Postgres READ ONLY transaction that is ALWAYS rolled back, never
 *      committed. This is the guarantee that actually matters: the engine
 *      itself refuses any write, no matter what SQL got this far.
 *
 *   2. A statement timeout, so nobody can pin the cluster at max ACUs with a
 *      deliberately expensive query and run up the bill.
 *
 *   3. A cheap parser check (single statement, must begin SELECT or WITH).
 *      This is the WEAKEST layer and must never be relied on alone - a
 *      data-modifying CTE like `WITH x AS (INSERT ...) SELECT * FROM x` begins
 *      with WITH and passes it. Layer 1 is what stops that.
 *
 * TODO(auth): put a Cognito JWT authorizer in front of this and the read-only
 * restriction becomes a choice rather than a necessity.
 */
import {
  RDSDataClient,
  ExecuteStatementCommand,
  BeginTransactionCommand,
  RollbackTransactionCommand,
} from '@aws-sdk/client-rds-data';
import { RDSClient, DescribeDBClustersCommand } from '@aws-sdk/client-rds';
import { DynamoDBClient, ListTablesCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { query, respond, DatabaseResumingError } from '../shared/db';

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const SECRET_ARN = process.env.SECRET_ARN!;
const DATABASE_NAME = process.env.DATABASE_NAME!;

const data = new RDSDataClient({});
const rds = new RDSClient({});
const ddb = new DynamoDBClient({});
const cw = new CloudWatchClient({});

/**
 * Current capacity in ACUs, from CloudWatch.
 *
 * DescribeDBClusters has a `Capacity` field, but it is a Serverless *v1*
 * concept and is always null on v2 - reading it made the console report
 * "paused" on a cluster that was actively serving queries. The real number is
 * the ServerlessDatabaseCapacity metric.
 *
 * The metric stops being published while the cluster is paused, so "no recent
 * datapoints" is how we infer paused.
 */
async function getCurrentCapacity(clusterId: string) {
  try {
    const res = await cw.send(
      new GetMetricStatisticsCommand({
        Namespace: 'AWS/RDS',
        MetricName: 'ServerlessDatabaseCapacity',
        Dimensions: [{ Name: 'DBClusterIdentifier', Value: clusterId }],
        StartTime: new Date(Date.now() - 10 * 60 * 1000),
        EndTime: new Date(),
        Period: 60,
        Statistics: ['Average'],
      }),
    );
    const points = (res.Datapoints ?? []).sort(
      (a, b) => (a.Timestamp?.getTime() ?? 0) - (b.Timestamp?.getTime() ?? 0),
    );
    const latest = points[points.length - 1];
    if (!latest || latest.Average === undefined) return { currentCapacity: null, paused: true };

    // A datapoint older than ~3 minutes means publishing stopped, i.e. paused.
    const ageMs = Date.now() - (latest.Timestamp?.getTime() ?? 0);
    return {
      currentCapacity: Number(latest.Average.toFixed(2)),
      paused: ageMs > 3 * 60 * 1000,
    };
  } catch {
    // Never let a metrics hiccup break the topology view.
    return { currentCapacity: null, paused: null };
  }
}

/** Stop a runaway query from pinning the cluster at max capacity. */
const STATEMENT_TIMEOUT = '15s';

/** Hard cap on rows returned, so the response cannot balloon. */
const MAX_ROWS = 1000;

// ---------------------------------------------------------------------------
// Read-only query execution
// ---------------------------------------------------------------------------

class BadRequest extends Error {}

/**
 * Layer 3 (weakest). Normalizes and does a cheap sanity check.
 * Deliberately NOT a security boundary - see the header comment.
 */
function prepareSql(raw: string): string {
  const stripped = String(raw ?? '')
    .replace(/--[^\n]*/g, ' ')        // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .trim()
    .replace(/;\s*$/, '');             // one optional trailing semicolon

  if (!stripped) throw new BadRequest('Enter a query.');

  // One statement at a time - stops "SELECT 1; DROP TABLE vendors".
  if (stripped.includes(';')) {
    throw new BadRequest('One statement at a time please.');
  }

  if (!/^(select|with|table|explain|show)\b/i.test(stripped)) {
    throw new BadRequest(
      'This console is read-only: queries must start with SELECT, WITH, TABLE, EXPLAIN or SHOW.',
    );
  }

  return stripped;
}

/**
 * Run a statement inside a READ ONLY transaction and roll it back.
 *
 * The rollback is not cleanup-on-error - it is the normal path. We never commit,
 * so even a write that somehow executed would be discarded.
 */
async function runReadOnly(sql: string) {
  const begun = await data.send(
    new BeginTransactionCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DATABASE_NAME,
    }),
  );
  const transactionId = begun.transactionId!;

  const exec = (statement: string) =>
    data.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE_NAME,
        transactionId,
        sql: statement,
        formatRecordsAs: 'JSON',
        includeResultMetadata: true,
      }),
    );

  try {
    // Layer 1: the engine now refuses every write for the rest of this transaction.
    await exec('SET TRANSACTION READ ONLY');
    // Layer 2.
    await exec(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);

    const result = await exec(sql);

    const rows = result.formattedRecords ? JSON.parse(result.formattedRecords) : [];
    const columns = (result.columnMetadata ?? []).map((c) => c.label || c.name || '');

    return {
      columns: columns.length ? columns : Object.keys(rows[0] ?? {}),
      rows: rows.slice(0, MAX_ROWS),
      rowCount: rows.length,
      truncated: rows.length > MAX_ROWS,
    };
  } finally {
    // Always. Even on success.
    await data
      .send(
        new RollbackTransactionCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          transactionId,
        }),
      )
      .catch(() => { /* never mask the real error */ });
  }
}

// ---------------------------------------------------------------------------
// Schema / topology
// ---------------------------------------------------------------------------

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
}

async function getAuroraTopology() {
  // Columns for every user table.
  const columns = await query<ColumnRow>(`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);

  // Group columns under their table.
  const tables = new Map<string, { name: string; columns: unknown[]; rowCount: number | null }>();
  for (const c of columns) {
    if (!tables.has(c.table_name)) {
      tables.set(c.table_name, { name: c.table_name, columns: [], rowCount: null });
    }
    tables.get(c.table_name)!.columns.push({
      name: c.column_name,
      type: c.data_type,
      nullable: c.is_nullable === 'YES',
    });
  }

  // Exact row counts. Table names come from information_schema, not from user
  // input, but they are still quoted as identifiers rather than interpolated raw.
  if (tables.size) {
    const counts = await query<{ t: string; n: number }>(
      [...tables.keys()]
        .map((t) => `SELECT '${t.replace(/'/g, "''")}' AS t, count(*)::int AS n FROM "${t.replace(/"/g, '""')}"`)
        .join(' UNION ALL '),
    );
    for (const { t, n } of counts) {
      const entry = tables.get(t);
      if (entry) entry.rowCount = Number(n);
    }
  }

  // Live cluster metadata - status, engine, capacity range.
  const clusterId = CLUSTER_ARN.split(':').pop()!;
  let cluster: Record<string, unknown> = { identifier: clusterId };
  try {
    const described = await rds.send(
      new DescribeDBClustersCommand({ DBClusterIdentifier: clusterId }),
    );
    const c = described.DBClusters?.[0];
    if (c) {
      const live = await getCurrentCapacity(clusterId);
      cluster = {
        identifier: c.DBClusterIdentifier,
        engine: c.Engine,
        engineVersion: c.EngineVersion,
        status: c.Status,
        minAcu: c.ServerlessV2ScalingConfiguration?.MinCapacity,
        maxAcu: c.ServerlessV2ScalingConfiguration?.MaxCapacity,
        dataApi: c.HttpEndpointEnabled,
        ...live,
      };
    }
  } catch (err) {
    cluster.error = (err as Error).message;
  }

  return {
    kind: 'aurora',
    engine: 'Aurora PostgreSQL Serverless v2',
    queryable: true,
    cluster,
    databases: [{ name: DATABASE_NAME, tables: [...tables.values()] }],
  };
}

async function getDynamoTopology() {
  try {
    const listed = await ddb.send(new ListTablesCommand({}));
    const names = listed.TableNames ?? [];

    const tables = await Promise.all(
      names.map(async (name) => {
        try {
          const d = await ddb.send(new DescribeTableCommand({ TableName: name }));
          const t = d.Table;
          return {
            name,
            rowCount: t?.ItemCount ?? null,
            sizeBytes: t?.TableSizeBytes ?? null,
            status: t?.TableStatus,
            // DynamoDB's "schema" is just its keys - there are no fixed columns.
            columns: (t?.KeySchema ?? []).map((k) => ({
              name: k.AttributeName,
              type: k.KeyType === 'HASH' ? 'partition key' : 'sort key',
              nullable: false,
            })),
          };
        } catch {
          return { name, rowCount: null, columns: [] };
        }
      }),
    );

    return {
      kind: 'dynamodb',
      engine: 'DynamoDB (via Amplify AppSync)',
      // Important for the UI: these cannot be queried with SQL.
      queryable: false,
      note: 'Created by Amplify defineData. Queried with GraphQL, not SQL - listed here for visibility only.',
      databases: [{ name: 'default', tables }],
    };
  } catch (err) {
    return {
      kind: 'dynamodb',
      engine: 'DynamoDB (via Amplify AppSync)',
      queryable: false,
      error: (err as Error).message,
      databases: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event: {
  body?: string | null;
  rawPath?: string;
  requestContext?: { http?: { path?: string } };
}) => {
  const path = event.requestContext?.http?.path ?? event.rawPath ?? '';

  try {
    if (path.endsWith('/schema')) {
      // Both stores in parallel; neither should block the other.
      const [aurora, dynamo] = await Promise.all([getAuroraTopology(), getDynamoTopology()]);
      return respond(200, { stores: [aurora, dynamo] });
    }

    if (path.endsWith('/query')) {
      const { sql } = JSON.parse(event.body || '{}');
      const prepared = prepareSql(sql);
      const result = await runReadOnly(prepared);
      return respond(200, result);
    }

    return respond(404, { error: 'unknown_route', path });
  } catch (err) {
    if (err instanceof BadRequest) {
      return respond(400, { error: 'bad_request', message: err.message });
    }

    // The cluster is auto-paused and still waking. This is expected, not a
    // failure - waking takes longer than API Gateway will hold a request open,
    // so answer immediately and let the client retry.
    const name = (err as Error)?.name ?? '';
    if (err instanceof DatabaseResumingError || name === 'DatabaseResumingException') {
      return respond(503, {
        error: 'database_resuming',
        message: 'The database is waking up from auto-pause. Retrying shortly.',
      });
    }

    // Postgres errors are genuinely useful in a query console, so pass the
    // message through rather than hiding it behind a generic 500.
    const message = (err as Error).message ?? 'Query failed.';
    console.error('admin route failed', path, err);
    return respond(400, { error: 'query_failed', message });
  }
};
