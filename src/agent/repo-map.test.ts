import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRepoMap,
  clearRepoMapCache,
  discoverProjectFiles,
  extractFileStructure,
  isSensitiveProjectFile,
} from './repo-map.js';

const dirs: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'minervacode-repomap-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  clearRepoMapCache();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('repository map', () => {
  it('discovers nested files while excluding dependencies, build output, and secrets', async () => {
    const dir = await tempProject();
    await mkdir(path.join(dir, 'src'));
    await mkdir(path.join(dir, 'node_modules'));
    await mkdir(path.join(dir, 'dist'));
    await writeFile(path.join(dir, 'src', 'main.ts'), 'export const answer = 42;\n');
    await writeFile(path.join(dir, 'node_modules', 'dep.js'), 'secret\n');
    await writeFile(path.join(dir, 'dist', 'main.js'), 'built\n');
    await writeFile(path.join(dir, '.env'), 'TOKEN=secret\n');
    await writeFile(path.join(dir, 'private.pem'), 'secret\n');

    expect(await discoverProjectFiles(dir)).toEqual(['src/main.ts']);
    expect(isSensitiveProjectFile('.env.local')).toBe(true);
    expect(isSensitiveProjectFile('config/credentials.json')).toBe(true);
    expect(isSensitiveProjectFile('src/config.ts')).toBe(false);
  });

  it('extracts common declarations and imports without parsing comments as files', () => {
    const structure = extractFileStructure(
      'src/service.ts',
      "import { db } from './db.js';\nexport interface User {}\nexport async function loadUser() {\n  const localOnly = 1;\n}\nconst cache = new Map();\n",
    );
    expect(structure).toEqual({
      symbols: ['loadUser', 'User', 'cache'],
      imports: ['./db.js'],
    });
    expect(structure.symbols).not.toContain('localOnly');
    expect(extractFileStructure('app.py', 'from lib.math import average\nclass App:\n    pass\ndef run():\n    pass\n')).toEqual({
      symbols: ['run', 'App'],
      imports: ['lib.math'],
    });
  });

  it('ranks paths and matching symbols for the current request', async () => {
    const dir = await tempProject();
    await mkdir(path.join(dir, 'src'));
    await mkdir(path.join(dir, 'test'));
    await writeFile(path.join(dir, 'src', 'auth.ts'), 'export function validateToken() { return true; }\n');
    await writeFile(path.join(dir, 'src', 'unrelated.ts'), 'export function formatDate() {}\n');
    await writeFile(path.join(dir, 'test', 'auth.test.ts'), "import { validateToken } from '../src/auth.js';\n");

    const result = await buildRepoMap({ projectDir: dir, query: 'Fix validateToken in auth' });

    expect(result.rankedFiles[0]).toBe('src/auth.ts');
    expect(result.contextFiles).toEqual(['src/auth.ts']);
    expect(result.map).toContain('symbols: validateToken');
    expect(result.fileCount).toBe(3);
    expect(result.symbolCount).toBe(2);
    expect(result.cacheHit).toBe(false);

    const structural = await buildRepoMap({ projectDir: dir });
    expect(structural.rankedFiles[0]).toBe('src/auth.ts');
    expect(structural.cacheHit).toBe(true);
  });

  it('does not inject unrelated manifests when source and tests match the request', async () => {
    const dir = await tempProject();
    await mkdir(path.join(dir, 'src'));
    await mkdir(path.join(dir, 'test'));
    await writeFile(path.join(dir, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
    await writeFile(path.join(dir, 'src', 'calc.js'), 'export function add(a, b) { return a - b; }\n');
    await writeFile(path.join(dir, 'test', 'calc.test.js'), "import { add } from '../src/calc.js';\n");

    const result = await buildRepoMap({
      projectDir: dir,
      query: 'Fix the bug in src/calc.js so the existing tests pass. Do not modify tests.',
    });

    expect(result.contextFiles).toContain('src/calc.js');
    expect(result.contextFiles).toContain('test/calc.test.js');
    expect(result.contextFiles).not.toContain('package.json');
    expect(result.map).toContain('package.json');
  });

  it('reuses unchanged per-file metadata and invalidates a modified file', async () => {
    const dir = await tempProject();
    await writeFile(path.join(dir, 'main.py'), 'def first():\n    pass\n');

    expect((await buildRepoMap({ projectDir: dir })).cacheHit).toBe(false);
    expect((await buildRepoMap({ projectDir: dir })).cacheHit).toBe(true);

    await writeFile(path.join(dir, 'main.py'), 'def second_name():\n    pass\n');
    const changed = await buildRepoMap({ projectDir: dir });
    expect(changed.cacheHit).toBe(false);
    expect(changed.map).toContain('second_name');
  });

  it('honors the render budget and reports truncation', async () => {
    const dir = await tempProject();
    await mkdir(path.join(dir, 'src'));
    for (let i = 0; i < 80; i++) {
      await writeFile(path.join(dir, 'src', `module-${i}.ts`), `export function feature${i}() {}\n`);
    }

    const result = await buildRepoMap({ projectDir: dir, maxChars: 1_000 });
    expect(result.truncated).toBe(true);
    expect(result.map.length).toBeLessThan(1_200);
    expect(result.map).toContain('lower-ranked files omitted');
  });
});
