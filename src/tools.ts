import path from 'node:path';
import type { Sandbox } from '@vercel/sandbox';
import { tool } from 'ai';
import { z } from 'zod';
import { runSingleCheck, type CheckName } from './checks.js';

export interface ToolCallTracker {
  counts: Record<string, number>;
}

export function validatePath(
  repoDir: string,
  userPath: string,
  isWrite = false,
): { ok: true; resolved: string } | { ok: false; error: string } {
  if (typeof userPath !== 'string' || userPath.trim() === '') {
    return { ok: false, error: 'Path must be a non-empty string.' };
  }

  // Reject absolute paths
  if (
    path.isAbsolute(userPath) ||
    userPath.startsWith('/') ||
    userPath.startsWith('\\') ||
    /^[a-zA-Z]:/.test(userPath)
  ) {
    return {
      ok: false,
      error: `Access denied: absolute paths are not permitted ("${userPath}"). Provide a relative path from the repository root.`,
    };
  }

  // Reject .. segments
  const segments = userPath.replace(/\\/g, '/').split('/');
  if (segments.includes('..')) {
    return {
      ok: false,
      error: `Access denied: parent directory traversal ("..") is not permitted ("${userPath}").`,
    };
  }

  const resolved = path.posix.normalize(path.posix.join(repoDir, userPath));
  if (!resolved.startsWith(repoDir + '/') && resolved !== repoDir) {
    return {
      ok: false,
      error: `Access denied: path escapes repository root ("${userPath}").`,
    };
  }

  if (isWrite) {
    for (const segment of segments) {
      if (
        segment === '.git' ||
        segment === 'node_modules' ||
        segment === '.github'
      ) {
        return {
          ok: false,
          error: `Forbidden: modifying protected path component "${segment}" is not permitted.`,
        };
      }
    }

    const basename = path.posix.basename(resolved);
    if (basename.startsWith('.env')) {
      return {
        ok: false,
        error: `Forbidden: modifying environment files ("${basename}") is not permitted.`,
      };
    }
    if (basename === 'pnpm-lock.yaml') {
      return {
        ok: false,
        error: `Forbidden: modifying "${basename}" directly is not permitted.`,
      };
    }
    if (basename === 'package.json') {
      return {
        ok: false,
        error: `Forbidden: modifying any package.json ("${userPath}") is not permitted.`,
      };
    }
  }

  return { ok: true, resolved };
}

function formatShortArgs(name: string, args: Record<string, unknown>): string {
  if (name === 'writeFile' && typeof args.content === 'string') {
    return JSON.stringify({
      path: args.path,
      contentLength: args.content.length,
    });
  }
  return JSON.stringify(args);
}

export function createSandboxTools(
  sandbox: Sandbox,
  repoDir: string,
  placeholderEnv?: Record<string, string>,
  tracker?: ToolCallTracker,
) {
  const recordTool = (name: string, args: Record<string, unknown>) => {
    if (tracker) {
      tracker.counts[name] = (tracker.counts[name] ?? 0) + 1;
    }
    console.log(`[tool:call] ${name} ${formatShortArgs(name, args)}`);
  };

  const listFilesTool = tool({
    description:
      'List files and directories in the repository up to a given depth (skipping node_modules, .git, .next, .turbo, dist).',
    inputSchema: z.object({
      dir: z
        .string()
        .optional()
        .describe('Relative directory path to list (default: ".")'),
      depth: z
        .number()
        .int()
        .min(1)
        .max(5)
        .default(2)
        .describe('Depth of directory traversal (default: 2)'),
    }),
    execute: async ({ dir = '.', depth = 2 }) => {
      const started = Date.now();
      recordTool('listFiles', { dir, depth });

      const check = validatePath(repoDir, dir, false);
      if (!check.ok) {
        return { error: check.error };
      }

      const skipDirs = new Set(['node_modules', '.git', '.next', '.turbo', 'dist']);
      const maxEntries = 200;
      const results: string[] = [];

      async function traverse(currentDir: string, currentDepth: number): Promise<void> {
        if (currentDepth > depth || results.length >= maxEntries) return;

        const exists = await sandbox.fs.exists(currentDir).catch(() => false);
        if (!exists) return;

        const entries = await sandbox.fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= maxEntries) break;
          if (skipDirs.has(entry.name)) continue;

          const fullChild = path.posix.join(currentDir, entry.name);
          const relFromRepo = path.posix.relative(repoDir, fullChild);

          if (entry.isDirectory()) {
            results.push(`${relFromRepo}/`);
            await traverse(fullChild, currentDepth + 1);
          } else {
            results.push(relFromRepo);
          }
        }
      }

      try {
        await traverse(check.resolved, 1);
        let output = results.join('\n');
        if (results.length >= maxEntries) {
          output += `\n[TRUNCATED: listing capped at ${maxEntries} entries]`;
        }
        console.log(`[tool:done] listFiles (${results.length} items, ${Date.now() - started}ms)`);
        return { files: output, count: results.length };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Failed to list directory: ${msg}` };
      }
    },
  });

  const readFileTool = tool({
    description: 'Read the text content of a file in the repository (truncated at ~20k characters).',
    inputSchema: z.object({
      path: z.string().describe('Relative path to the file to read'),
    }),
    execute: async ({ path: filePath }) => {
      const started = Date.now();
      recordTool('readFile', { path: filePath });

      const check = validatePath(repoDir, filePath, false);
      if (!check.ok) {
        return { error: check.error };
      }

      try {
        const exists = await sandbox.fs.exists(check.resolved);
        if (!exists) {
          return { error: `File not found: ${filePath}` };
        }

        const raw = await sandbox.fs.readFile(check.resolved, 'utf8');
        const MAX_CHARS = 20_000;
        let content = raw;
        let truncated = false;

        if (content.length > MAX_CHARS) {
          content =
            content.slice(0, MAX_CHARS) +
            `\n\n[TRUNCATED: file content exceeded ${MAX_CHARS} characters; showing first ${MAX_CHARS}]`;
          truncated = true;
        }

        console.log(`[tool:done] readFile (${content.length} chars, ${Date.now() - started}ms)`);
        return { path: filePath, content, truncated };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Failed to read file: ${msg}` };
      }
    },
  });

  const writeFileTool = tool({
    description: 'Write full content to a file in the repository (automatically creates parent directories).',
    inputSchema: z.object({
      path: z.string().describe('Relative path to the file to write'),
      content: z.string().describe('Full text content to write to the file'),
    }),
    execute: async ({ path: filePath, content }) => {
      const started = Date.now();
      recordTool('writeFile', { path: filePath, content });

      const check = validatePath(repoDir, filePath, true);
      if (!check.ok) {
        return { error: check.error };
      }

      try {
        const parentDir = path.posix.dirname(check.resolved);
        await sandbox.fs.mkdir(parentDir, { recursive: true });
        await sandbox.fs.writeFile(check.resolved, content);

        console.log(
          `[tool:done] writeFile (${Buffer.byteLength(content, 'utf8')} bytes, ${Date.now() - started}ms)`,
        );
        return {
          success: true,
          path: filePath,
          bytesWritten: Buffer.byteLength(content, 'utf8'),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Failed to write file: ${msg}` };
      }
    },
  });

  const runCheckTool = tool({
    description:
      'Run one of the verification checks on the repository: typegen, schema-validate, check-types, lint, format, or test.',
    inputSchema: z.object({
      name: z
        .enum(['typegen', 'schema-validate', 'check-types', 'lint', 'format', 'test'])
        .describe('Name of the check to run'),
    }),
    execute: async ({ name }) => {
      const started = Date.now();
      recordTool('runCheck', { name });

      try {
        const res = await runSingleCheck(
          sandbox,
          repoDir,
          name as CheckName,
          placeholderEnv,
          true,
        );
        console.log(
          `[tool:done] runCheck (${name}, exitCode=${res.exitCode}, ${Date.now() - started}ms)`,
        );
        return {
          name,
          exitCode: res.exitCode,
          output: res.output,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          name,
          exitCode: 1,
          output: `Failed to run check: ${msg}`,
        };
      }
    },
  });

  return {
    listFiles: listFilesTool,
    readFile: readFileTool,
    writeFile: writeFileTool,
    runCheck: runCheckTool,
  };
}
