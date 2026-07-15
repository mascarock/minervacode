import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { editTool } from './edit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'minervacli-tools-'));
  dirs.push(dir);
  return dir;
}

describe('Write', () => {
  it('writes and reports line count', async () => {
    const dir = await tempProject();
    const result = await writeTool.call({ path: 'a.py', content: 'x = 1\n' }, { projectDir: dir });
    expect(result).toContain('a.py');
    expect(await readFile(path.join(dir, 'a.py'), 'utf-8')).toBe('x = 1\n');
  });

  it('refuses to write through a symlink that escapes the project', async () => {
    const outside = await tempProject();
    const dir = await tempProject();
    await symlink(outside, path.join(dir, 'link'));
    await expect(
      writeTool.call({ path: 'link/evil.txt', content: 'x' }, { projectDir: dir }),
    ).rejects.toThrow(/escapes project directory/);
  });

  it('preserves the executable bit of an existing file', async () => {
    const dir = await tempProject();
    const file = path.join(dir, 'run.sh');
    await writeFile(file, '#!/bin/sh\necho old\n');
    await chmod(file, 0o755);
    await writeTool.call({ path: 'run.sh', content: '#!/bin/sh\necho new\n' }, { projectDir: dir });
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe('755');
    expect(await readFile(file, 'utf-8')).toBe('#!/bin/sh\necho new\n');
  });
});

describe('Read/Grep symlink containment', () => {
  it('Read rejects a symlink pointing outside the project', async () => {
    const outside = await tempProject();
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    const dir = await tempProject();
    await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
    await expect(readTool.call({ path: 'link.txt' }, { projectDir: dir })).rejects.toThrow(
      /escapes project directory/,
    );
  });

  it('Grep rejects a direct path that is an escaping symlink', async () => {
    const outside = await tempProject();
    await writeFile(path.join(outside, 'secret.txt'), 'needle');
    const dir = await tempProject();
    await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
    await expect(
      grepTool.call({ pattern: 'needle', path: 'link.txt' }, { projectDir: dir }),
    ).rejects.toThrow(/escapes project directory/);
  });

  it('Grep recursive search still works and skips symlink entries', async () => {
    const outside = await tempProject();
    await writeFile(path.join(outside, 'secret.txt'), 'needle');
    const dir = await tempProject();
    await writeFile(path.join(dir, 'real.txt'), 'needle here\n');
    await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
    const result = await grepTool.call({ pattern: 'needle' }, { projectDir: dir });
    expect(result).toContain('real.txt');
    expect(result).not.toContain('link.txt');
  });
});

describe('Edit', () => {
  it('rejects ambiguous old_string without modifying the file', async () => {
    const dir = await tempProject();
    await writeFile(path.join(dir, 'a.py'), 'x = 1\nx = 1\n');
    await expect(
      editTool.call({ path: 'a.py', old_string: 'x = 1', new_string: 'x = 2' }, { projectDir: dir }),
    ).rejects.toThrow(/2 times/);
    expect(await readFile(path.join(dir, 'a.py'), 'utf-8')).toBe('x = 1\nx = 1\n');
  });

  it('replaces a unique match', async () => {
    const dir = await tempProject();
    await writeFile(path.join(dir, 'a.py'), 'x = 1\ny = 2\n');
    await editTool.call({ path: 'a.py', old_string: 'y = 2', new_string: 'y = 3' }, { projectDir: dir });
    expect(await readFile(path.join(dir, 'a.py'), 'utf-8')).toBe('x = 1\ny = 3\n');
  });
});

describe('Glob', () => {
  it('rejects traversal patterns', async () => {
    const dir = await tempProject();
    await expect(globTool.call({ pattern: '../*' }, { projectDir: dir })).rejects.toThrow(
      /inside the project/,
    );
    await expect(globTool.call({ pattern: '/etc/*' }, { projectDir: dir })).rejects.toThrow(
      /inside the project/,
    );
  });

  it('matches files inside the project', async () => {
    const dir = await tempProject();
    await writeFile(path.join(dir, 'a.py'), '');
    const result = await globTool.call({ pattern: '*.py' }, { projectDir: dir });
    expect(result).toContain('a.py');
  });
});
