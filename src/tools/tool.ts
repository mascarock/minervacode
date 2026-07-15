import { chmod, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ZodType } from 'zod';

export interface ToolContext {
  /** Project root all file operations are resolved against. */
  projectDir: string;
  signal?: AbortSignal;
}

export interface Tool<Input = unknown> {
  name: string;
  description: string;
  /** Zod schema used to validate parsed tool-call arguments. */
  inputSchema: ZodType<Input>;
  /** Human-readable arg summary shown in the tool indicator, e.g. `src/main.py`. */
  summarize(input: Input): string;
  isReadOnly(): boolean;
  call(input: Input, ctx: ToolContext): Promise<string>;
}

/**
 * Resolves a model-supplied path against the project dir and rejects
 * escapes outside it — students point this at a homework folder and the
 * model must not touch anything else.
 */
export function resolveInProject(projectDir: string, relPath: string): string {
  const resolved = path.resolve(projectDir, relPath);
  const root = path.resolve(projectDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes project directory: ${relPath}`);
  }
  return resolved;
}

/**
 * Atomic write via a temp sibling + rename, preserving the mode of an
 * existing target (a plain rename would reset an executable run.sh to the
 * umask default).
 */
export async function atomicWriteFile(file: string, content: string): Promise<void> {
  const existingMode = await stat(file).then(
    (s) => s.mode & 0o777,
    () => null,
  );
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.minerva-tmp`);
  await writeFile(tmp, content, 'utf-8');
  if (existingMode !== null) await chmod(tmp, existingMode);
  await rename(tmp, file);
}

/**
 * The lexical check above misses symlinks: a link inside the project can
 * point anywhere. Before writing, resolve the nearest existing ancestor to
 * its real path and re-check containment.
 */
export async function assertRealPathInProject(projectDir: string, resolved: string): Promise<void> {
  const root = await realpath(path.resolve(projectDir));
  let existing = resolved;
  let suffix = '';
  for (;;) {
    try {
      const real = await realpath(existing);
      const target = suffix ? path.join(real, suffix) : real;
      if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error(`Path escapes project directory (via symlink): ${resolved}`);
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      suffix = suffix ? path.join(path.basename(existing), suffix) : path.basename(existing);
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error(`Path escapes project directory: ${resolved}`);
      existing = parent;
    }
  }
}
