import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectVerifyCommand, requestRequiresExecution, runVerification } from './verify.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'minervacli-verify-'));
  dirs.push(dir);
  return dir;
}

describe('detectVerifyCommand', () => {
  it('does not mistake running tests for executing a changed module', () => {
    expect(requestRequiresExecution('Fix calc.py and run the tests.')).toBe(false);
    expect(requestRequiresExecution('Write calc.py, run it, then run the tests.')).toBe(true);
  });

  it('prefers the Test command from .minervacli.md', async () => {
    const dir = await tempProject();
    await writeFile(
      path.join(dir, '.minervacli.md'),
      '# Project\n\n- Run: `python main.py`\n- Test: `python -m pytest -q tests/`\n',
    );
    const cmd = await detectVerifyCommand(dir, ['main.py'], ['main.py']);
    expect(cmd).toEqual({ command: 'python -m pytest -q tests/', source: '.minervacli.md' });
  });

  it('uses the package.json test script when real', async () => {
    const dir = await tempProject();
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }),
    );
    const cmd = await detectVerifyCommand(dir, ['package.json', 'index.js'], ['index.js']);
    expect(cmd?.command).toBe('npm test --silent');
  });

  it('falls back to the typecheck script when there is no test script', async () => {
    const dir = await tempProject();
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', build: 'tsc' } }),
    );
    const cmd = await detectVerifyCommand(dir, ['package.json', 'src/a.ts'], ['src/a.ts']);
    expect(cmd).toEqual({
      command: 'npm run typecheck --silent',
      source: 'package.json typecheck script',
    });
  });

  it('falls back to the build script after typecheck', async () => {
    const dir = await tempProject();
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    const cmd = await detectVerifyCommand(dir, ['package.json', 'src/a.ts'], ['src/a.ts']);
    expect(cmd?.command).toBe('npm run build --silent');
  });

  it('respects the detected package manager for scripts', async () => {
    const dir = await tempProject();
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } }),
    );
    const pnpm = await detectVerifyCommand(
      dir,
      ['package.json', 'pnpm-lock.yaml', 'a.ts'],
      ['a.ts'],
    );
    expect(pnpm?.command).toBe('pnpm test');
    const yarn = await detectVerifyCommand(dir, ['package.json', 'yarn.lock', 'a.ts'], ['a.ts']);
    expect(yarn?.command).toBe('yarn test');
  });

  it('typechecks changed TypeScript via tsconfig when no scripts exist', async () => {
    const dir = await tempProject();
    const cmd = await detectVerifyCommand(
      dir,
      ['tsconfig.json', 'src/a.ts'],
      ['src/a.ts'],
    );
    expect(cmd).toEqual({ command: 'npx tsc --noEmit', source: 'tsconfig.json' });
  });

  it('ignores the npm placeholder test script', async () => {
    const dir = await tempProject();
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    );
    const cmd = await detectVerifyCommand(dir, ['package.json', 'index.js'], ['index.js']);
    expect(cmd?.command).toContain('node --check');
  });

  it('runs pytest (after a syntax check) when available', async () => {
    const dir = await tempProject();
    await writeFile(path.join(dir, 'test_calc.py'), 'def test_x():\n    assert True\n');
    const cmd = await detectVerifyCommand(
      dir,
      ['calc.py', 'test_calc.py'],
      ['calc.py'],
      async () => true,
    );
    expect(cmd?.command).toBe("python3 -m py_compile 'calc.py' && python3 -m pytest -q");
  });

  it('uses unittest discover only for unittest-style tests', async () => {
    const dir = await tempProject();
    await writeFile(
      path.join(dir, 'test_calc.py'),
      'import unittest\n\nclass T(unittest.TestCase):\n    pass\n',
    );
    const cmd = await detectVerifyCommand(
      dir,
      ['calc.py', 'test_calc.py'],
      ['calc.py'],
      async () => false,
    );
    expect(cmd?.command).toBe("python3 -m py_compile 'calc.py' && python3 -m unittest discover -q");
  });

  it('syntax-checks function-style tests when pytest is missing', async () => {
    const dir = await tempProject();
    await writeFile(path.join(dir, 'test_calc.py'), 'def test_x():\n    assert True\n');
    const cmd = await detectVerifyCommand(
      dir,
      ['calc.py', 'test_calc.py'],
      ['calc.py'],
      async () => false,
    );
    expect(cmd).toEqual({
      command: "python3 -m py_compile 'calc.py' 'test_calc.py'",
      source: 'syntax check (pytest not installed)',
    });
  });

  it('falls back to a syntax check of changed python files', async () => {
    const dir = await tempProject();
    const cmd = await detectVerifyCommand(dir, ['calc.py'], ['calc.py']);
    expect(cmd).toEqual({
      command: "python3 -m py_compile 'calc.py'",
      source: 'syntax check',
    });
  });

  it('compiles and executes a changed C program when the request requires execution', async () => {
    const dir = await tempProject();
    await writeFile(
      path.join(dir, 'primes.c'),
      '#include <stdio.h>\nint main(void) { puts("2 3 5 7 11 13 17 19 23 29"); return 0; }\n',
    );
    const cmd = await detectVerifyCommand(
      dir,
      ['primes.c'],
      ['primes.c'],
      undefined,
      'Compile the program, execute it, and verify the output.',
    );

    expect(cmd?.source).toBe('compile and run');
    expect(cmd?.timeoutMs).toBe(10_000);
    expect(cmd?.command).toContain("cc -std=c11 -Wall -Wextra -pedantic 'primes.c'");
    const result = await runVerification(cmd!, dir);
    expect(result).toEqual({ ok: true, output: '2 3 5 7 11 13 17 19 23 29' });
  });

  it('runs a single requested Python script when the request requires execution', async () => {
    const dir = await tempProject();
    await writeFile(path.join(dir, 'hello.py'), 'print("hi")\n');
    const cmd = await detectVerifyCommand(
      dir,
      ['hello.py'],
      ['hello.py'],
      async () => false,
      'Write hello.py and run it.',
    );
    expect(cmd?.source).toBe('compile and run');
    expect(cmd?.command).toBe("python3 'hello.py'");
    const result = await runVerification(cmd!, dir);
    expect(result).toEqual({ ok: true, output: 'hi' });
  });

  it('runs an explicitly named script before an unrelated package test', async () => {
    const dir = await tempProject();
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "console.log(\'unrelated\')"' } }),
    );
    await writeFile(path.join(dir, 'hello.py'), 'print("requested")\n');

    const cmd = await detectVerifyCommand(
      dir,
      ['package.json', 'hello.py'],
      ['hello.py'],
      async () => false,
      'Write hello.py, run it, and check its output.',
    );

    expect(cmd?.command).toBe("python3 'hello.py'");
    await expect(runVerification(cmd!, dir)).resolves.toEqual({
      ok: true,
      output: 'requested',
    });
  });

  it('only syntax-checks C when execution was not requested', async () => {
    const dir = await tempProject();
    const cmd = await detectVerifyCommand(dir, ['calc.c'], ['calc.c']);
    expect(cmd).toEqual({ command: "cc -fsyntax-only 'calc.c'", source: 'syntax check' });
  });

  it('returns null when nothing applies', async () => {
    const dir = await tempProject();
    expect(await detectVerifyCommand(dir, ['notes.md'], ['notes.md'])).toBeNull();
  });
});

describe('runVerification', () => {
  it('reports success output', async () => {
    const dir = await tempProject();
    const result = await runVerification({ command: 'echo ok', source: 'test' }, dir);
    expect(result).toEqual({ ok: true, output: 'ok' });
  });

  it('reports failure output without throwing', async () => {
    const dir = await tempProject();
    const result = await runVerification({ command: 'echo bad >&2; exit 3', source: 'test' }, dir);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('bad');
    expect(result.output).toContain('exit 3');
  });
});
