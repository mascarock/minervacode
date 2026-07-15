import { exec } from 'node:child_process';
import { z } from 'zod';
import type { Tool } from './tool.js';

const schema = z.object({ command: z.string() });

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 20_000;

export const bashTool: Tool<z.infer<typeof schema>> = {
  name: 'Bash',
  description: 'Run a shell command in the project directory. Args: command',
  inputSchema: schema,
  summarize: (input) => input.command,
  isReadOnly: () => false,
  call(input, ctx) {
    return new Promise((resolve) => {
      exec(
        input.command,
        {
          cwd: ctx.projectDir,
          timeout: TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
          signal: ctx.signal,
        },
        (error, stdout, stderr) => {
          let output = [stdout, stderr].filter(Boolean).join('\n').trim();
          if (output.length > MAX_OUTPUT) {
            output = `${output.slice(0, MAX_OUTPUT)}\n… (output truncated)`;
          }
          if (error) {
            const code = error.code ?? 'unknown';
            resolve(`Command failed (exit ${code})${output ? `:\n${output}` : ''}`);
          } else {
            resolve(output || '(no output)');
          }
        },
      );
    });
  },
};
