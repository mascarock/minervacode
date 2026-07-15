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
