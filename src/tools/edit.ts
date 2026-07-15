import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { resolveInProject, type Tool } from './tool.js';

const schema = z.object({
  path: z.string(),
  old_string: z.string().min(1),
  new_string: z.string(),
});

export const editTool: Tool<z.infer<typeof schema>> = {
  name: 'Edit',
  description:
    'Replace text in a file. Args: path, old_string (must exist in the file), new_string',
  inputSchema: schema,
  summarize: (input) => input.path,
  isReadOnly: () => false,
  async call(input, ctx) {
    const file = resolveInProject(ctx.projectDir, input.path);
    const text = await readFile(file, 'utf-8');
    const index = text.indexOf(input.old_string);
    if (index === -1) {
      throw new Error(`old_string not found in ${input.path}`);
    }
    const updated =
      text.slice(0, index) + input.new_string + text.slice(index + input.old_string.length);
    await writeFile(file, updated, 'utf-8');
    const occurrences = text.split(input.old_string).length - 1;
    return occurrences > 1
      ? `Edited ${input.path} (replaced first of ${occurrences} occurrences)`
      : `Edited ${input.path}`;
  },
};
