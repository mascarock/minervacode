import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  assertRealPathInProject,
  atomicWriteFile,
  resolveInProject,
  type Tool,
} from './tool.js';

const schema = z.object({ path: z.string(), content: z.string() });

export const writeTool: Tool<z.infer<typeof schema>> = {
  name: 'Write',
  description: 'Create or overwrite a file. Args: path, content',
  inputSchema: schema,
  summarize: (input) => input.path,
  isReadOnly: () => false,
  async call(input, ctx) {
    const file = resolveInProject(ctx.projectDir, input.path);
    await assertRealPathInProject(ctx.projectDir, file);
    await mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, input.content);
    const lines = input.content.split('\n').length;
    return `Wrote ${input.path} (${lines} lines)`;
  },
};
