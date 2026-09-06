import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition } from '../tool.types.js';
import type { ToolRegistry } from '../tool-registry.js';
import { ToolError } from '../tool-error.js';

// Read-only Filesystem Tool (Phase 24 spec #5) — every path is resolved
// against, and verified to stay inside, one fixed sandbox root
// (`apps/api/var/fs-tool-root/`, see that directory's own README). No
// write operation is exposed at all — not "declared read-only and
// trusted," genuinely absent from this file's API surface.
const SANDBOX_ROOT = path.resolve(process.cwd(), 'var', 'fs-tool-root');
const MAX_FILE_BYTES = 200_000;

// Resolves a caller-supplied relative path against SANDBOX_ROOT and
// throws if the result would land outside it — the actual path-traversal
// guard (`../../etc/passwd` style escapes are rejected here, not by
// pattern-matching the input string, which is easy to bypass).
function resolveSandboxed(relativePath: string, toolName: string): string {
  const resolved = path.resolve(SANDBOX_ROOT, relativePath);
  if (resolved !== SANDBOX_ROOT && !resolved.startsWith(SANDBOX_ROOT + path.sep)) {
    throw new ToolError(toolName, 'path escapes the sandboxed root — access denied');
  }
  return resolved;
}

const pathInputSchema = z.object({ path: z.string().default('') });
const readFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
  truncated: z.boolean(),
});

export const fsReadFileTool: ToolDefinition<
  z.infer<typeof pathInputSchema>,
  z.infer<typeof readFileOutputSchema>
> = {
  id: 'fs_read_file',
  name: 'fs_read_file',
  description: 'Reads a text file from the sandboxed filesystem root, up to 200KB.',
  permissions: ['read', 'filesystem'],
  inputSchema: pathInputSchema,
  outputSchema: readFileOutputSchema,
  async execute(input) {
    const resolved = resolveSandboxed(input.path, 'fs_read_file');
    const stats = await stat(resolved).catch(() => {
      throw new ToolError('fs_read_file', `no such file: ${input.path}`);
    });
    if (!stats.isFile()) {
      throw new ToolError('fs_read_file', `not a file: ${input.path}`);
    }
    const buffer = await readFile(resolved);
    const truncated = buffer.byteLength > MAX_FILE_BYTES;
    const content = buffer.subarray(0, MAX_FILE_BYTES).toString('utf8');
    return { path: input.path, content, truncated };
  },
};

const listDirectoryOutputSchema = z.object({
  path: z.string(),
  entries: z.array(z.object({ name: z.string(), type: z.enum(['file', 'directory']) })),
});

export const fsListDirectoryTool: ToolDefinition<
  z.infer<typeof pathInputSchema>,
  z.infer<typeof listDirectoryOutputSchema>
> = {
  id: 'fs_list_directory',
  name: 'fs_list_directory',
  description:
    'Lists files and subdirectories at a path in the sandboxed filesystem root (default: the root itself).',
  permissions: ['read', 'filesystem'],
  inputSchema: pathInputSchema,
  outputSchema: listDirectoryOutputSchema,
  async execute(input) {
    const resolved = resolveSandboxed(input.path, 'fs_list_directory');
    const entries = await readdir(resolved, { withFileTypes: true }).catch(() => {
      throw new ToolError('fs_list_directory', `no such directory: ${input.path}`);
    });
    return {
      path: input.path,
      entries: entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? ('directory' as const) : ('file' as const),
      })),
    };
  },
};

const searchInputSchema = z.object({ query: z.string().min(1), path: z.string().default('') });
const searchOutputSchema = z.object({ matches: z.array(z.string()) });
const MAX_SEARCH_RESULTS = 100;

export const fsSearchFilesTool: ToolDefinition<
  z.infer<typeof searchInputSchema>,
  z.infer<typeof searchOutputSchema>
> = {
  id: 'fs_search_files',
  name: 'fs_search_files',
  description:
    'Recursively searches filenames under a path (default: the sandbox root) for a case-insensitive substring match.',
  permissions: ['read', 'filesystem'],
  inputSchema: searchInputSchema,
  outputSchema: searchOutputSchema,
  async execute(input) {
    const startDir = resolveSandboxed(input.path, 'fs_search_files');
    const needle = input.query.toLowerCase();
    const matches: string[] = [];

    async function walk(dir: string): Promise<void> {
      if (matches.length >= MAX_SEARCH_RESULTS) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (matches.length >= MAX_SEARCH_RESULTS) return;
        const entryPath = path.join(dir, entry.name);
        if (entry.name.toLowerCase().includes(needle)) {
          matches.push(path.relative(SANDBOX_ROOT, entryPath));
        }
        if (entry.isDirectory()) {
          await walk(entryPath);
        }
      }
    }

    await walk(startDir);
    return { matches };
  },
};

export function registerFilesystemTools(toolRegistry: ToolRegistry): void {
  toolRegistry.register(fsReadFileTool);
  toolRegistry.register(fsListDirectoryTool);
  toolRegistry.register(fsSearchFilesTool);
}
