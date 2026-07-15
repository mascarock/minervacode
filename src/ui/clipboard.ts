import { spawn } from 'node:child_process';

const CLIPBOARD_COMMANDS: Array<{ cmd: string; args: string[] }> =
  process.platform === 'darwin'
    ? [{ cmd: 'pbcopy', args: [] }]
    : process.platform === 'win32'
      ? [{ cmd: 'clip', args: [] }]
      : [
          { cmd: 'wl-copy', args: [] },
          { cmd: 'xclip', args: ['-selection', 'clipboard'] },
          { cmd: 'xsel', args: ['--clipboard', '--input'] },
        ];

function pipeTo(cmd: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    child.stdin.on('error', () => {
      // EPIPE when the tool dies early — the close handler reports it.
    });
    child.stdin.end(text);
  });
}

/** Copies text to the system clipboard using the platform's native tool. */
export async function copyToClipboard(text: string): Promise<void> {
  let lastError: unknown;
  for (const { cmd, args } of CLIPBOARD_COMMANDS) {
    try {
      await pipeTo(cmd, args, text);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  const tools = CLIPBOARD_COMMANDS.map((c) => c.cmd).join(', ');
  throw new Error(
    `no clipboard tool worked (tried: ${tools}) — ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
