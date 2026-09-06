import { z } from 'zod';
import type { ToolDefinition } from '../tool.types.js';
import type { ToolRegistry } from '../tool-registry.js';
import { ToolError } from '../tool-error.js';
import { prisma } from '../../../db/prisma.js';

// Read-only Postgres access for agents (Phase 24 spec #3) — SQL query
// execution, table inspection, row counts, metadata. "Never allow
// writes" is enforced twice: (1) every write-shaped keyword is rejected
// anywhere in the query text before it ever reaches the database, and
// (2) `postgres_table_info`'s row count only ever interpolates a table
// name that was just independently confirmed to exist via
// `postgres_list_tables`'s own query, never the caller's raw string,
// closing the identifier-injection gap a naive `COUNT(*) FROM "<table>"`
// would otherwise have.
//
// This tool grants read access to the *entire* application database, not
// just the calling agent's own asset's data — there is no per-row
// authorization layer here the way `getOwnedAsset()` provides for
// asset-scoped routes. It is deliberately not wired into Copilot's
// automatic free-text tool selection for that reason (see
// copilot.tool-selector.ts): only fixed, code-authored queries ever run
// through it today, never a query built from raw user input.

const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|EXECUTE|CALL|MERGE|VACUUM|REINDEX)\b/i;

function assertReadOnlySelect(sql: string): void {
  const trimmed = sql.trim();
  if (trimmed.includes(';') && !trimmed.endsWith(';')) {
    throw new ToolError('postgres_query', 'multiple statements are not allowed');
  }
  const withoutTrailingSemicolon = trimmed.replace(/;$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    throw new ToolError('postgres_query', 'multiple statements are not allowed');
  }
  if (!/^(SELECT|WITH)\b/i.test(withoutTrailingSemicolon)) {
    throw new ToolError(
      'postgres_query',
      'only SELECT (or WITH ... SELECT) statements are allowed',
    );
  }
  if (WRITE_KEYWORDS.test(withoutTrailingSemicolon)) {
    throw new ToolError('postgres_query', 'query contains a disallowed write/DDL keyword');
  }
}

// Postgres COUNT(*)/bigint columns come back as JS `bigint`, which
// neither `JSON.stringify` nor this tool's own zod output schema
// serializes — converted to `number` here (safe: nothing in this
// database approaches Number.MAX_SAFE_INTEGER row counts) so every
// caller (HTTP response, Copilot's tool-selection explanation, verify
// scripts) can treat a row like any other JSON-safe object.
function toJsonSafeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? Number(value) : value,
    ]),
  );
}

const queryInputSchema = z.object({ sql: z.string().min(1).max(4000) });
const queryOutputSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int().nonnegative(),
});

const tableInfoInputSchema = z.object({ table: z.string().min(1).max(200) });
const tableInfoOutputSchema = z.object({
  table: z.string(),
  columns: z.array(z.object({ name: z.string(), type: z.string(), nullable: z.boolean() })),
  rowCount: z.number().int().nonnegative(),
});

const emptyInputSchema = z.object({});
const listTablesOutputSchema = z.object({ tables: z.array(z.string()) });

async function listPublicTables(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  return rows.map((row) => row.table_name);
}

export const postgresQueryTool: ToolDefinition<
  z.infer<typeof queryInputSchema>,
  z.infer<typeof queryOutputSchema>
> = {
  id: 'postgres_query',
  name: 'postgres_query',
  description:
    'Executes a read-only SQL SELECT (or WITH ... SELECT) query against the application database. INSERT/UPDATE/DELETE/DDL and every other write-shaped statement are rejected before the query ever reaches Postgres.',
  permissions: ['read', 'database'],
  inputSchema: queryInputSchema,
  outputSchema: queryOutputSchema,
  async execute(input) {
    assertReadOnlySelect(input.sql);
    try {
      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(input.sql);
      return { rows: rows.map(toJsonSafeRow), rowCount: rows.length };
    } catch (error) {
      throw new ToolError(
        'postgres_query',
        error instanceof Error ? error.message : 'query execution failed',
      );
    }
  },
};

export const postgresListTablesTool: ToolDefinition<
  z.infer<typeof emptyInputSchema>,
  z.infer<typeof listTablesOutputSchema>
> = {
  id: 'postgres_list_tables',
  name: 'postgres_list_tables',
  description: 'Lists every base table in the public schema.',
  permissions: ['read', 'database'],
  inputSchema: emptyInputSchema,
  outputSchema: listTablesOutputSchema,
  async execute() {
    return { tables: await listPublicTables() };
  },
};

export const postgresTableInfoTool: ToolDefinition<
  z.infer<typeof tableInfoInputSchema>,
  z.infer<typeof tableInfoOutputSchema>
> = {
  id: 'postgres_table_info',
  name: 'postgres_table_info',
  description: 'Returns column metadata and the row count for one table.',
  permissions: ['read', 'database'],
  inputSchema: tableInfoInputSchema,
  outputSchema: tableInfoOutputSchema,
  async execute(input) {
    const knownTables = await listPublicTables();
    if (!knownTables.includes(input.table)) {
      throw new ToolError('postgres_table_info', `unknown table "${input.table}"`);
    }

    const columns = await prisma.$queryRaw<
      { column_name: string; data_type: string; is_nullable: string }[]
    >`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${input.table}
      ORDER BY ordinal_position
    `;
    // `input.table` is safe to interpolate here — it was just verified
    // above to be an exact match against a table name Postgres itself
    // reported via information_schema, never the caller's raw string.
    const countRows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*) as count FROM "${input.table}"`,
    );

    return {
      table: input.table,
      columns: columns.map((col) => ({
        name: col.column_name,
        type: col.data_type,
        nullable: col.is_nullable === 'YES',
      })),
      rowCount: Number(countRows[0]?.count ?? 0),
    };
  },
};

export function registerPostgresTools(toolRegistry: ToolRegistry): void {
  toolRegistry.register(postgresQueryTool);
  toolRegistry.register(postgresListTablesTool);
  toolRegistry.register(postgresTableInfoTool);
}
