import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { revertNetChanges } from './rollback.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'minervacli-rollback-'));
  dirs.push(dir);
  return dir;
}

describe('revertNetChanges', () => {
  it('restores modified files to their pre-run contents', async () => {
    const dir = await tempProject();
    await writeFile(path.join(dir, 'a.py'), 'broken\n');
    const reverted = await revertNetChanges(dir, [
      { path: 'a.py', before: 'original\n', after: 'broken\n', existedBefore: true },
    ]);
    expect(reverted).toEqual(['a.py']);
    expect(await readFile(path.join(dir, 'a.py'), 'utf-8')).toBe('original\n');
  });

  it('removes files the run created', async () => {
    const dir = await tempProject();
    await writeFile(path.join(dir, 'new.py'), 'created\n');
    const reverted = await revertNetChanges(dir, [
      { path: 'new.py', before: '', after: 'created\n', existedBefore: false },
    ]);
    expect(reverted).toEqual(['new.py']);
    expect(existsSync(path.join(dir, 'new.py'))).toBe(false);
  });

  it('restores a pre-existing EMPTY file instead of deleting it', async () => {
    const dir = await tempProject();
    await writeFile(path.join(dir, 'empty.py'), 'filled by the run\n');
    const reverted = await revertNetChanges(dir, [
      { path: 'empty.py', before: '', after: 'filled by the run\n', existedBefore: true },
    ]);
    expect(reverted).toEqual(['empty.py']);
    expect(existsSync(path.join(dir, 'empty.py'))).toBe(true);
    expect(await readFile(path.join(dir, 'empty.py'), 'utf-8')).toBe('');
  });

  it('skips no-op entries and leaves unrelated files alone', async () => {
    const dir = await tempProject();
    await writeFile(path.join(dir, 'untouched.py'), 'user content\n');
    await writeFile(path.join(dir, 'same.py'), 'x\n');
    const reverted = await revertNetChanges(dir, [
      { path: 'same.py', before: 'x\n', after: 'x\n', existedBefore: true },
    ]);
    expect(reverted).toEqual([]);
    expect(await readFile(path.join(dir, 'untouched.py'), 'utf-8')).toBe('user content\n');
    expect(await readFile(path.join(dir, 'same.py'), 'utf-8')).toBe('x\n');
  });

  it('ignores entries whose path escapes the project', async () => {
    const dir = await tempProject();
    const reverted = await revertNetChanges(dir, [
      { path: '../outside.py', before: 'x\n', after: 'y\n', existedBefore: true },
    ]);
    expect(reverted).toEqual([]);
  });
});
