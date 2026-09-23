/**
 * Applies db/schema.sql and then db/seed.sql to the deployed Aurora cluster,
 * over the RDS Data API.
 *
 * Usage:
 *   npm run init-db                          # uses defaults below
 *   npm run init-db -- --stack my-stack      # different stack name
 *   npm run init-db -- --region us-east-1    # different region
 *   npm run init-db -- --schema-only         # skip the sample vendors
 *
 * You do not need to look up any ARNs: this reads them from the CloudFormation
 * stack's outputs.
 *
 * Safe to run repeatedly - schema.sql uses IF NOT EXISTS and seed.sql uses
 * ON CONFLICT DO NOTHING, so a second run changes nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';

const here = dirname(fileURLToPath(import.meta.url));

// --- Read command line flags ----------------------------------------------
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const STACK = flag('stack', 'tprm-backend');
const REGION = flag('region', 'us-east-2');
const SCHEMA_ONLY = args.includes('--schema-only');

/**
 * Split a .sql file into individual statements.
 *
 * The Data API runs ONE statement per call, so we cannot just send the whole
 * file. Splitting on ";" naively would break if a semicolon appeared inside a
 * quoted string, so this walks the text and tracks whether it is inside a
 * string, a line comment, or a $$-quoted block.
 */
function splitStatements(sql) {
  const statements = [];
  let buf = '';
  let inLineComment = false;
  let inString = false;
  let inDollar = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next2 = sql.slice(i, i + 2);

    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;                                  // drop comments entirely
    }
    if (!inString && !inDollar && next2 === '--') { inLineComment = true; i++; continue; }
    if (!inString && next2 === '$$') { inDollar = !inDollar; buf += next2; i++; continue; }
    if (!inDollar && c === "'") { inString = !inString; buf += c; continue; }

    if (c === ';' && !inString && !inDollar) {
      if (buf.trim()) statements.push(buf.trim());
      buf = '';
      continue;
    }
    buf += c;
  }

  if (buf.trim()) statements.push(buf.trim());
  return statements;
}

/** Pull the cluster ARN / secret ARN / database name out of the stack outputs. */
async function getStackOutputs() {
  const cfn = new CloudFormationClient({ region: REGION });
  const res = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
  const outputs = res.Stacks?.[0]?.Outputs ?? [];
  const get = (key) => outputs.find((o) => o.OutputKey === key)?.OutputValue;

  const values = {
    clusterArn: get('ClusterArn'),
    secretArn: get('SecretArn'),
    databaseName: get('DatabaseName'),
  };

  for (const [k, v] of Object.entries(values)) {
    if (!v) throw new Error(`Stack "${STACK}" has no output for ${k}. Did the deploy finish?`);
  }
  return values;
}

async function main() {
  console.log(`Stack:  ${STACK}`);
  console.log(`Region: ${REGION}\n`);

  const { clusterArn, secretArn, databaseName } = await getStackOutputs();
  const rds = new RDSDataClient({ region: REGION });

  const run = async (sql) => {
    // The cluster auto-pauses when idle. The very first statement may have to
    // wake it, which can take 15-30 seconds, so retry a few times.
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await rds.send(new ExecuteStatementCommand({
          resourceArn: clusterArn,
          secretArn,
          database: databaseName,
          sql,
        }));
      } catch (err) {
        const retryable = ['DatabaseResumingException', 'StatementTimeoutException', 'ServiceUnavailableError']
          .includes(err.name);
        if (!retryable || attempt === 5) throw err;
        console.log(`   ...database is waking up, retrying (${attempt + 1}/5)`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };

  const files = SCHEMA_ONLY ? ['schema.sql'] : ['schema.sql', 'seed.sql'];

  for (const file of files) {
    const sql = readFileSync(join(here, '..', 'db', file), 'utf8');
    const statements = splitStatements(sql);
    console.log(`Applying ${file} (${statements.length} statements)...`);

    for (const [i, statement] of statements.entries()) {
      const preview = statement.replace(/\s+/g, ' ').slice(0, 70);
      process.stdout.write(`  [${i + 1}/${statements.length}] ${preview}... `);
      await run(statement);
      console.log('ok');
    }
    console.log();
  }

  // Show what actually landed, so you can see it worked.
  const check = await run('SELECT status, count(*) AS n FROM vendors GROUP BY status ORDER BY status');
  console.log('vendors table now contains:');
  for (const row of check.records ?? []) {
    console.log(`  ${row[0].stringValue.padEnd(10)} ${row[1].longValue}`);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
