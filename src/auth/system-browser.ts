import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';

const execFileAsync = promisify(execFile);

export async function openInSystemBrowser(url: string): Promise<void> {
  const os = platform();

  if (os === 'darwin') {
    await execFileAsync('open', [url]);
    return;
  }

  if (os === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', url]);
    return;
  }

  await execFileAsync('xdg-open', [url]);
}
