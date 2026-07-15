import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  assertRealPathInProject,
  atomicWriteFile,
  resolveInProject,
  type Tool,
} from './tool.js';

const schema = z.object({
  path: z.string(),
  old_string: z.string().min(1),
  new_string: z.string(),
});

export const editTool: Tool<z.infer<typeof schema>> = {
  name: 'Edit',
  description:
    'Replace text in a file. Args: path, old_string (must appear exactly once in the file), new_string',
  inputSchema: schema,
  summarize: (input) => input.path,
  isReadOnly: () => false,
  async call(input, ctx) {
    const file = resolveInProject(ctx.projectDir, input.path);
    await assertRealPathInProject(ctx.projectDir, file);
    const text = await readFile(file, 'utf-8');
    const index = text.indexOf(input.old_string);
    if (index === -1) {
      throw new Error(`old_string not found in ${input.path}`);
    }
    const occurrences = text.split(input.old_string).length - 1;
    if (occurrences > 1) {
      throw new Error(
        `old_string appears ${occurrences} times in ${input.path} — include more surrounding lines so it matches exactly once`,
      );
    }
    const updated =
      text.slice(0, index) + input.new_string + text.slice(index + input.old_string.length);
    await atomicWriteFile(file, updated);
    return `Edited ${input.path}`;
  },
};
