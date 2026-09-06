// Phase 24 — Postgres Tool checks: read-only query execution, table
// inspection, row counts/metadata, and the "never allow writes" guard
// (single-statement SELECT/WITH only, write/DDL keywords rejected,
// multiple-statement injection rejected). In-process only — no live
// server dependency; KnowledgeDocument-style direct-repository fixtures
// (Resource/Finding) exercise a real, scoped COUNT(*) query end to end.
import { prisma } from '../src/db/prisma.js';
import { redis } from '../src/cache/redis.js';
import { createChecker } from './lib/verify-helpers.js';
import { aiFoundation } from '../src/ai/foundation.js';
import { registerBuiltinTools } from '../src/ai/tools/builtin/index.js';
import { resourceRepository } from '../src/repositories/resource.repository.js';
import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import type { AIContext } from '../src/ai/types/context.types.js';

registerBuiltinTools();

const FAKE_CONTEXT: AIContext = {
  user: { id: 'verify-postgres-tool-user', role: 'USER' },
  toolHistory: [],
  executionHistory: [],
};

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();

  console.log('1. postgres_list_tables — lists known application tables');
  const tablesResult = (await aiFoundation.toolRegistry.execute(
    'postgres_list_tables',
    {},
    FAKE_CONTEXT,
  )) as { tables: string[] };
  check('User table is listed', tablesResult.tables.includes('User'));
  check('Finding table is listed', tablesResult.tables.includes('Finding'));
  check('Resource table is listed', tablesResult.tables.includes('Resource'));

  console.log('2. postgres_table_info — column metadata + row count for one table');
  const tableInfo = (await aiFoundation.toolRegistry.execute(
    'postgres_table_info',
    { table: 'User' },
    FAKE_CONTEXT,
  )) as { columns: { name: string; type: string; nullable: boolean }[]; rowCount: number };
  check(
    'columns include "email"',
    tableInfo.columns.some((c) => c.name === 'email'),
  );
  check('rowCount is a non-negative number', tableInfo.rowCount >= 0);

  console.log('3. postgres_table_info — unknown table is rejected, not silently interpolated');
  const unknownTableResult = await aiFoundation.toolExecutor.run(
    'postgres_table_info',
    { table: 'User"; DROP TABLE "User' },
    FAKE_CONTEXT,
  );
  check('unknown/malicious table name is refused', unknownTableResult.success === false);

  console.log('4. postgres_query — a plain SELECT executes and returns rows');
  const selectResult = (await aiFoundation.toolRegistry.execute(
    'postgres_query',
    { sql: 'SELECT 1 as x, 2 as y' },
    FAKE_CONTEXT,
  )) as { rows: Record<string, unknown>[]; rowCount: number };
  check('rowCount is 1', selectResult.rowCount === 1, `${selectResult.rowCount}`);
  check(
    'row values are correct',
    Number(selectResult.rows[0]?.x) === 1 && Number(selectResult.rows[0]?.y) === 2,
  );

  console.log('5. postgres_query — every write/DDL shape is rejected before reaching Postgres');
  const rejectedQueries = [
    'INSERT INTO "User" (id) VALUES (1)',
    'UPDATE "User" SET email = \'x\'',
    'DELETE FROM "User"',
    'DROP TABLE "User"',
    'ALTER TABLE "User" ADD COLUMN x TEXT',
    'TRUNCATE "User"',
    'CREATE TABLE evil (id INT)',
    'SELECT 1; DROP TABLE "User";',
    'SELECT * FROM "User" WHERE 1=1; DELETE FROM "User"',
  ];
  for (const sql of rejectedQueries) {
    const result = await aiFoundation.toolExecutor.run('postgres_query', { sql }, FAKE_CONTEXT);
    check(`rejected: ${sql.slice(0, 40)}...`, result.success === false, result.error);
  }

  console.log(
    '6. postgres_query — a non-SELECT-prefixed statement is rejected even without a keyword match',
  );
  const nonSelectResult = await aiFoundation.toolExecutor.run(
    'postgres_query',
    { sql: '(SELECT 1)' },
    FAKE_CONTEXT,
  );
  check('parenthesized non-SELECT-prefixed query is rejected', nonSelectResult.success === false);

  console.log(
    '7. real scoped COUNT(*) — matches what Copilot\'s "count findings" tool-selection uses',
  );
  const { admin, categoryId } = await createAdminAndCategoryDirect();
  const asset = await assetRepository.create({
    userId: admin.id,
    categoryId,
    name: `verify-postgres-tool-asset-${stamp}`,
  });
  const resource = await resourceRepository.upsert({
    provider: 'github',
    providerResourceId: `verify-postgres-tool-repo-${stamp}`,
    accountId: `verify-postgres-tool-account-${stamp}`,
    assetId: asset.id,
    resourceType: 'repository',
    displayName: 'verify-postgres-tool-repo',
    hash: 'verify-postgres-tool-hash',
  });
  const finding = await prisma.finding.create({
    data: {
      resourceId: resource.id,
      provider: 'github',
      ruleCode: 'VERIFY_POSTGRES_TOOL_RULE',
      severity: 'MEDIUM',
      title: 'verify-postgres-tool finding',
      description: 'fixture finding for postgres tool verification',
    },
  });

  const countSql = `SELECT COUNT(*) as count FROM "Finding" f JOIN "Resource" r ON f."resourceId" = r.id WHERE r."assetId" = '${asset.id}' AND f.status = 'OPEN'`;
  const countResult = (await aiFoundation.toolRegistry.execute(
    'postgres_query',
    { sql: countSql },
    FAKE_CONTEXT,
  )) as { rows: Record<string, unknown>[] };
  check(
    'scoped count matches the one fixture finding',
    Number(countResult.rows[0]?.count) === 1,
    JSON.stringify(countResult.rows),
  );

  await prisma.finding.delete({ where: { id: finding.id } });
  await resourceRepository.delete(resource.id).catch(() => undefined);
  await assetRepository.delete(asset.id);
  await categoryRepository.delete(categoryId);
  await userRepository.delete(admin.id);

  console.log('8. agent allowlist — postgres tools are only usable by agents declared for them');
  const deniedResult = await aiFoundation.toolExecutor.run(
    'postgres_query',
    { sql: 'SELECT 1' },
    FAKE_CONTEXT,
    'discovery-agent',
  );
  check('discovery-agent (undeclared) is denied postgres_query', deniedResult.success === false);
  const allowedResult = await aiFoundation.toolExecutor.run(
    'postgres_query',
    { sql: 'SELECT 1' },
    FAKE_CONTEXT,
    'compliance-agent',
  );
  check('compliance-agent (declared) is allowed postgres_query', allowedResult.success === true);

  if (state.failed) {
    console.error('\nOne or more Postgres Tool checks FAILED.');
  } else {
    console.log('\nAll Postgres Tool checks passed.');
  }

  await redis.quit().catch(() => undefined);
  await prisma.$disconnect();

  if (state.failed) {
    process.exitCode = 1;
  }
}

async function createAdminAndCategoryDirect(): Promise<{
  admin: { id: string };
  categoryId: string;
}> {
  const stamp = Date.now();
  const admin = await userRepository.create({
    email: `verify-postgres-tool-admin-${stamp}@example.test`,
    passwordHash: 'not-a-real-hash',
    firstName: 'Verify',
    lastName: 'PostgresTool',
    role: 'ADMIN',
  });
  const category = await categoryRepository.create({
    name: `Verify Postgres Tool Category ${stamp}`,
    slug: `verify-postgres-tool-category-${stamp}`,
  });
  return { admin: { id: admin.id }, categoryId: category.id };
}

void main();
