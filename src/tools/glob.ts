import { glob } from 'node:fs/promises';
import { z } from 'zod';
import type { Tool } from './tool.js';

const schema = z.object({ pattern: z.string() });

const MAX_RESULTS = 200;

export const globTool: Tool<z.infer<typeof schema>> = {
  name: 'Glob',
  description: 'Find files by glob pattern, e.g. "**/*.py". Args: pattern',
  inputSchema: schema,
  summarize: (input) => input.pattern,
  isReadOnly: () => true,
  async call(input, ctx) {
    if (input.pattern.startsWith('/') || input.pattern.split(/[\\/]/).includes('..')) {
      throw new Error('Glob patterns must stay inside the project directory.');
    }
    const results: string[] = [];
    for await (const entry of glob(input.pattern, {
      cwd: ctx.projectDir,
      exclude: (name: string) => name === 'node_modules' || name === '.git' || name === 'dist',
    })) {
      results.push(entry);
      if (results.length >= MAX_RESULTS) {
        results.push('… (more results truncated)');
        break;
      }
    }
    return results.length ? results.join('\n') : 'No files matched.';
  },
};
