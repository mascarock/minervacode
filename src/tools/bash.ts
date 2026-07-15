import { exec } from 'node:child_process';
import { z } from 'zod';
import type { Tool } from './tool.js';

const schema = z.object({
  command: z.string(),
  timeout_ms: z.number().int().min(1_000).max(60_000).optional(),
});

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 20_000;

export const bashTool: Tool<z.infer<typeof schema>> = {
  name: 'Bash',
  description: 'Run a shell command in the project directory. Args: command',
  inputSchema: schema,
  summarize: (input) => input.command,
  isReadOnly: () => false,
  call(input, ctx) {
    const timeoutMs = input.timeout_ms ?? TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      exec(
        input.command,
        {
          cwd: ctx.projectDir,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          signal: ctx.signal,
        },
        (error, stdout, stderr) => {
          let output = [stdout, stderr].filter(Boolean).join('\n').trim();
          if (output.length > MAX_OUTPUT) {
            output = `${output.slice(0, MAX_OUTPUT)}\n… (output truncated)`;
          }
          if (error) {
            if (String(error.code) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              reject(
                new Error(
                  `Command produced too much output and was stopped — this usually means an infinite loop.${output ? `\nFirst lines:\n${output.slice(0, 2_000)}` : ''}`,
                ),
              );
              return;
            }
            if (error.killed || error.signal === 'SIGTERM') {
              reject(
                new Error(
                  `Command timed out after ${timeoutMs}ms${output ? `:\n${output}` : ''}`,
                ),
              );
              return;
            }
            const code = error.code ?? 'unknown';
            reject(new Error(`Command failed (exit ${code})${output ? `:\n${output}` : ''}`));
          } else {
            resolve(output || '(no output)');
          }
        },
      );
    });
  },
};
