import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { assertRealPathInProject, resolveInProject, type Tool } from './tool.js';

const schema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
});

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '__pycache__', '.venv', 'venv']);
const MAX_MATCHES = 100;
const MAX_FILE_SIZE = 1024 * 1024;

async function* walkFiles(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        yield* walkFiles(path.join(dir, entry.name));
      }
    } else if (entry.isFile()) {
      yield path.join(dir, entry.name);
    }
  }
}

export const grepTool: Tool<z.infer<typeof schema>> = {
  name: 'Grep',
  description:
    'Search file contents with a regular expression. Args: pattern, path (optional file or directory)',
  inputSchema: schema,
  summarize: (input) => input.pattern + (input.path ? ` in ${input.path}` : ''),
  isReadOnly: () => true,
  async call(input, ctx) {
    const regex = new RegExp(input.pattern);
    const root = resolveInProject(ctx.projectDir, input.path ?? '.');
    // The recursive walk already skips symlink entries, but a direct path
    // argument would follow one — reject links that escape the project.
    await assertRealPathInProject(ctx.projectDir, root);
    const rootStat = await stat(root);

    const matches: string[] = [];
    const files = rootStat.isFile() ? [root] : walkFiles(root);

    for await (const file of files) {
      const info = await stat(file);
      if (info.size > MAX_FILE_SIZE) continue;
      let text: string;
      try {
        text = await readFile(file, 'utf-8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue; // binary

      const rel = path.relative(ctx.projectDir, file);
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
          if (matches.length >= MAX_MATCHES) {
            matches.push('… (more matches truncated)');
            return matches.join('\n');
          }
        }
      }
    }

    return matches.length ? matches.join('\n') : 'No matches found.';
  },
};
