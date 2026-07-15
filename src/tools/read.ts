import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { resolveInProject, type Tool } from './tool.js';

const schema = z.object({ path: z.string() });

const MAX_CHARS = 40_000;

export const readTool: Tool<z.infer<typeof schema>> = {
  name: 'Read',
  description: 'Read the contents of a file. Args: path',
  inputSchema: schema,
  summarize: (input) => input.path,
  isReadOnly: () => true,
  async call(input, ctx) {
    const file = resolveInProject(ctx.projectDir, input.path);
    const text = await readFile(file, 'utf-8');
    if (!text) return '(empty file)';
    if (text.length > MAX_CHARS) {
      return `${text.slice(0, MAX_CHARS)}\n… (truncated, ${text.length} chars total)`;
    }
    return text;
  },
};
