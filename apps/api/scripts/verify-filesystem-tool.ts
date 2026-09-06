// Phase 24 — Filesystem Tool checks: read-only file/directory access
// scoped to the sandbox root (var/fs-tool-root/), including the actual
// path-traversal guard (not just documented — a `../` escape attempt is
// exercised and rejected). In-process only.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/db/prisma.js';
import { redis } from '../src/cache/redis.js';
import { createChecker } from './lib/verify-helpers.js';
import { aiFoundation } from '../src/ai/foundation.js';
import { registerBuiltinTools } from '../src/ai/tools/builtin/index.js';
import type { AIContext } from '../src/ai/types/context.types.js';

registerBuiltinTools();

const FAKE_CONTEXT: AIContext = {
  user: { id: 'verify-filesystem-tool-user', role: 'USER' },
  toolHistory: [],
  executionHistory: [],
};

const SANDBOX_ROOT = path.resolve(process.cwd(), 'var', 'fs-tool-root');
const FIXTURE_DIR = 'verify-fixture';
const FIXTURE_FILE = `${FIXTURE_DIR}/needle-file.txt`;

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log(
    '0. setup — write a fixture file inside the sandbox root (the tool itself never writes)',
  );
  await mkdir(path.join(SANDBOX_ROOT, FIXTURE_DIR), { recursive: true });
  await writeFile(path.join(SANDBOX_ROOT, FIXTURE_FILE), 'hello from the filesystem tool fixture');

  try {
    console.log('1. fs_list_directory — lists the sandbox root, including the README');
    const rootListing = (await aiFoundation.toolRegistry.execute(
      'fs_list_directory',
      { path: '' },
      FAKE_CONTEXT,
    )) as { entries: { name: string; type: string }[] };
    check(
      'root listing includes README.md',
      rootListing.entries.some((e) => e.name === 'README.md' && e.type === 'file'),
    );
    check(
      'root listing includes the fixture directory',
      rootListing.entries.some((e) => e.name === FIXTURE_DIR && e.type === 'directory'),
    );

    console.log('2. fs_read_file — reads the fixture file');
    const readResult = (await aiFoundation.toolRegistry.execute(
      'fs_read_file',
      { path: FIXTURE_FILE },
      FAKE_CONTEXT,
    )) as { content: string; truncated: boolean };
    check('file content matches', readResult.content === 'hello from the filesystem tool fixture');
    check('not truncated (well under 200KB)', readResult.truncated === false);

    console.log('3. fs_read_file — nonexistent file is rejected');
    const missingResult = await aiFoundation.toolExecutor.run(
      'fs_read_file',
      { path: 'this-file-does-not-exist.txt' },
      FAKE_CONTEXT,
    );
    check('nonexistent file is refused', missingResult.success === false);

    console.log('4. fs_search_files — finds the fixture by a substring of its filename');
    const searchResult = (await aiFoundation.toolRegistry.execute(
      'fs_search_files',
      { query: 'needle' },
      FAKE_CONTEXT,
    )) as { matches: string[] };
    check(
      'search finds the fixture file',
      searchResult.matches.some((m) => m.includes('needle-file.txt')),
      JSON.stringify(searchResult.matches),
    );

    console.log('5. path traversal — every escape attempt is rejected, not silently clamped');
    const traversalAttempts = [
      '../../../../etc/passwd',
      '../../package.json',
      '../..',
      '../server.ts',
    ];
    for (const attempt of traversalAttempts) {
      const result = await aiFoundation.toolExecutor.run(
        'fs_read_file',
        { path: attempt },
        FAKE_CONTEXT,
      );
      check(`traversal rejected: "${attempt}"`, result.success === false, result.error);
    }

    console.log(
      "6. no write operation exists on this tool's surface — only 3 tools are registered",
    );
    check('fs_read_file is registered', aiFoundation.toolRegistry.has('fs_read_file'));
    check('fs_list_directory is registered', aiFoundation.toolRegistry.has('fs_list_directory'));
    check('fs_search_files is registered', aiFoundation.toolRegistry.has('fs_search_files'));
    check('no fs_write_file tool exists', !aiFoundation.toolRegistry.has('fs_write_file'));
    check('no fs_delete_file tool exists', !aiFoundation.toolRegistry.has('fs_delete_file'));

    console.log('7. agent allowlist — filesystem tools are undeclared for every current agent');
    const deniedResult = await aiFoundation.toolExecutor.run(
      'fs_read_file',
      { path: FIXTURE_FILE },
      FAKE_CONTEXT,
      'copilot-agent',
    );
    check(
      "fs_read_file is not on any agent's allowlist yet (undeclared, not wired to Copilot selection)",
      deniedResult.success === false,
    );

    if (state.failed) {
      console.error('\nOne or more Filesystem Tool checks FAILED.');
    } else {
      console.log('\nAll Filesystem Tool checks passed.');
    }
  } finally {
    console.log('8. cleanup');
    await rm(path.join(SANDBOX_ROOT, FIXTURE_DIR), { recursive: true, force: true });
    await redis.quit().catch(() => undefined);
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
