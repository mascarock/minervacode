import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { bashTool } from '../tools/bash.js';
import { PROJECT_CONTEXT_FILE } from './prompts.js';

const execFileAsync = promisify(execFile);

export interface VerifyCommand {
  command: string;
  /** Where the command came from, e.g. `.minervacli.md` or `pytest files`. */
  source: string;
  /** Optional shorter timeout for directly executed smoke-test programs. */
  timeoutMs?: number;
}

/** `- Test: `python -m pytest`` line in the project context file. */
const CONTEXT_TEST_LINE = /^\s*[-*]?\s*test[^:`]*:\s*`([^`]+)`/im;

const PY_TEST_FILE = /(^|\/)(test_[^/]+\.py|[^/]+_test\.py)$/;
const REQUIRES_EXECUTION =
  /\b(?:run|runs|running|execute|executes|executed|executing|launch|esegu\w*|avvi\w*)\b/i;
const TEST_EXECUTION_PHRASE =
  /\b(?:run|runs|running|execute|executes|executed|executing|esegu\w*|avvi\w*)\s+(?:the\s+|i\s+|gli\s+|la\s+|le\s+)?tests?\b/gi;

export function requestRequiresExecution(request: string): boolean {
  // "Run the tests" asks for verification, not for executing a changed
  // source module as a standalone program.
  return REQUIRES_EXECUTION.test(request.replace(TEST_EXECUTION_PHRASE, ''));
}

async function pythonHasPytest(): Promise<boolean> {
  try {
    await execFileAsync('python3', ['-c', 'import pytest']);
    return true;
  } catch {
    return false;
  }
}

async function readProjectFile(projectDir: string, rel: string): Promise<string | null> {
  try {
    return await readFile(path.join(projectDir, rel), 'utf-8');
  } catch {
    return null;
  }
}

function quote(p: string): string {
  return `'${p.replaceAll("'", String.raw`'\''`)}'`;
}

function requestNamesPath(request: string, file: string): boolean {
  const normalized = file.replace(/^\.\//, '');
  const base = path.basename(normalized);
  return request.includes(normalized) || request.includes(base);
}

type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

function detectPackageManager(projectFiles: string[]): PackageManager {
  if (projectFiles.includes('pnpm-lock.yaml')) return 'pnpm';
  if (projectFiles.includes('yarn.lock')) return 'yarn';
  if (projectFiles.includes('bun.lock') || projectFiles.includes('bun.lockb')) return 'bun';
  return 'npm';
}

function runScriptCommand(pm: PackageManager, script: string): string {
  if (pm === 'yarn') return `yarn ${script}`;
  if (pm === 'npm') return `npm run ${script} --silent`;
  return `${pm} run ${script}`;
}

/**
 * Picks the command the harness runs to verify the agent's file changes.
 * Priority: explicit Test command in .minervacli.md, then the project's
 * test setup, then a syntax check of the changed files.
 */
export async function detectVerifyCommand(
  projectDir: string,
  projectFiles: string[],
  changedPaths: string[],
  hasPytest: () => Promise<boolean> = pythonHasPytest,
  request = '',
): Promise<VerifyCommand | null> {
  const uniqueChangedPaths = [...new Set(changedPaths)];
  const context = await readProjectFile(projectDir, PROJECT_CONTEXT_FILE);
  const contextCommand = context?.match(CONTEXT_TEST_LINE)?.[1]?.trim();
  if (contextCommand) {
    return { command: contextCommand, source: PROJECT_CONTEXT_FILE };
  }

  const changedPy = uniqueChangedPaths.filter((p) => p.endsWith('.py'));
  const cSources = uniqueChangedPaths.filter((p) => p.endsWith('.c'));
  const cppSources = uniqueChangedPaths.filter((p) => /\.(?:cpp|cc|cxx)$/.test(p));
  const executeNamedProgram = requestRequiresExecution(request);

  // An explicit "write X and run X" request must execute X even inside a
  // repository that has an unrelated package test/build script. Otherwise a
  // green project test can incorrectly stand in for the requested program.
  if (
    changedPy.length === 1 &&
    executeNamedProgram &&
    requestNamesPath(request, changedPy[0])
  ) {
    return {
      command: `python3 ${quote(changedPy[0])}`,
      source: 'compile and run',
      timeoutMs: 10_000,
    };
  }
  if (cSources.length && executeNamedProgram && cSources.some((p) => requestNamesPath(request, p))) {
    return {
      command: `bin=$(mktemp "\${TMPDIR:-/tmp}/minervacli-c.XXXXXX") && trap 'rm -f "$bin"' EXIT && cc -std=c11 -Wall -Wextra -pedantic ${cSources.map(quote).join(' ')} -o "$bin" -lm && "$bin"`,
      source: 'compile and run',
      timeoutMs: 10_000,
    };
  }
  if (
    cppSources.length &&
    executeNamedProgram &&
    cppSources.some((p) => requestNamesPath(request, p))
  ) {
    return {
      command: `bin=$(mktemp "\${TMPDIR:-/tmp}/minervacli-cpp.XXXXXX") && trap 'rm -f "$bin"' EXIT && c++ -std=c++17 -Wall -Wextra -pedantic ${cppSources.map(quote).join(' ')} -o "$bin" && "$bin"`,
      source: 'compile and run',
      timeoutMs: 10_000,
    };
  }

  const packageManager = detectPackageManager(projectFiles);
  const packageJson = await readProjectFile(projectDir, 'package.json');
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson) as { scripts?: Record<string, string> };
      const test = pkg.scripts?.test;
      if (test && !test.includes('no test specified')) {
        return {
          command: packageManager === 'npm' ? 'npm test --silent' : `${packageManager} test`,
          source: 'package.json test script',
        };
      }
      // No tests — a typecheck or build script still catches most damage.
      for (const script of ['typecheck', 'build']) {
        if (pkg.scripts?.[script]) {
          return {
            command: runScriptCommand(packageManager, script),
            source: `package.json ${script} script`,
          };
        }
      }
    } catch {
      // malformed package.json — fall through
    }
  }

  // Syntax-check changed files first: test runners skip modules they never
  // import, so a broken file can otherwise slip through unnoticed.
  const compileChanged = changedPy.length
    ? `python3 -m py_compile ${changedPy.map(quote).join(' ')} && `
    : '';

  const testFiles = projectFiles.filter((f) => PY_TEST_FILE.test(f));
  if (testFiles.length) {
    if (await hasPytest()) {
      return { command: `${compileChanged}python3 -m pytest -q`, source: 'pytest files' };
    }
    // Without pytest, unittest discover only collects TestCase classes —
    // for function-style tests it exits 5 with no output, which is useless.
    const contents = await Promise.all(testFiles.map((f) => readProjectFile(projectDir, f)));
    if (contents.some((c) => c?.includes('unittest'))) {
      return {
        command: `${compileChanged}python3 -m unittest discover -q`,
        source: 'unittest files',
      };
    }
    const toCheck = [...new Set([...changedPy, ...testFiles])];
    return {
      command: `python3 -m py_compile ${toCheck.map(quote).join(' ')}`,
      source: 'syntax check (pytest not installed)',
    };
  }

  // Changed TypeScript with no scripts — typecheck the project directly.
  const changedTs = uniqueChangedPaths.some((p) => /\.(ts|tsx|mts|cts)$/.test(p));
  if (changedTs && projectFiles.includes('tsconfig.json')) {
    return { command: 'npx tsc --noEmit', source: 'tsconfig.json' };
  }

  // No test setup — syntax-check the files that were just changed.
  if (changedPy.length) {
    return {
      command: `python3 -m py_compile ${changedPy.map(quote).join(' ')}`,
      source: 'syntax check',
    };
  }
  const jsFiles = uniqueChangedPaths.filter((p) => /\.(js|mjs|cjs)$/.test(p));
  if (jsFiles.length) {
    return {
      command: jsFiles.map((f) => `node --check ${quote(f)}`).join(' && '),
      source: 'syntax check',
    };
  }
  if (cSources.length && requestRequiresExecution(request)) {
    return {
      command: `bin=$(mktemp "\${TMPDIR:-/tmp}/minervacli-c.XXXXXX") && trap 'rm -f "$bin"' EXIT && cc -std=c11 -Wall -Wextra -pedantic ${cSources.map(quote).join(' ')} -o "$bin" -lm && "$bin"`,
      source: 'compile and run',
      timeoutMs: 10_000,
    };
  }
  const cFiles = uniqueChangedPaths.filter((p) => /\.(c|h)$/.test(p));
  if (cFiles.length) {
    return {
      command: `cc -fsyntax-only ${cFiles.map(quote).join(' ')}`,
      source: 'syntax check',
    };
  }
  if (cppSources.length && requestRequiresExecution(request)) {
    return {
      command: `bin=$(mktemp "\${TMPDIR:-/tmp}/minervacli-cpp.XXXXXX") && trap 'rm -f "$bin"' EXIT && c++ -std=c++17 -Wall -Wextra -pedantic ${cppSources.map(quote).join(' ')} -o "$bin" && "$bin"`,
      source: 'compile and run',
      timeoutMs: 10_000,
    };
  }
  const cppFiles = uniqueChangedPaths.filter((p) => /\.(cpp|cc|cxx|hpp)$/.test(p));
  if (cppFiles.length) {
    return {
      command: `c++ -fsyntax-only ${cppFiles.map(quote).join(' ')}`,
      source: 'syntax check',
    };
  }

  return null;
}

export interface VerifyOutcome {
  ok: boolean;
  output: string;
}

/** Runs the verification command with the Bash tool's timeout/truncation. */
export async function runVerification(
  cmd: VerifyCommand,
  projectDir: string,
  signal?: AbortSignal,
): Promise<VerifyOutcome> {
  try {
    const output = await bashTool.call(
      { command: cmd.command, timeout_ms: cmd.timeoutMs },
      { projectDir, signal },
    );
    return { ok: true, output };
  } catch (err) {
    let output = err instanceof Error ? err.message : String(err);
    if (/exit 5\b/.test(output) && /pytest|unittest/.test(cmd.command)) {
      output += '\n(exit code 5 means the runner collected no tests — check test file and function names)';
    }
    return { ok: false, output };
  }
}
