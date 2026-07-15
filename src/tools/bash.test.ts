import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bashTool } from './bash.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Bash tool', () => {
  it('returns stdout for successful commands', async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), 'minervacli-bash-'));
    dirs.push(projectDir);
    await expect(
      bashTool.call({ command: 'node -e "console.log(42)"' }, { projectDir }),
    ).resolves.toBe('42');
  });

  it('rejects failed commands so the agent can fix failed tests', async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), 'minervacli-bash-'));
    dirs.push(projectDir);
    await expect(
      bashTool.call(
        { command: 'node -e "console.error(\'broken test\'); process.exit(2)"' },
        { projectDir },
      ),
    ).rejects.toThrow(/Command failed \(exit 2\).*broken test/s);
  });
});
