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
  /** The request asks for printed output — an empty run is a failure. */
  expectOutput?: boolean;
}

/** The request asks for a program whose point is PRINTING something. */
const EXPECTS_PRINTED_OUTPUT =
  /\b(?:print\w*|stamp\w*|output|display\w*|mostra\w*|visualizz\w*|greet\w*|salut\w*|count\w*|conta\w*)\b/i;

/**
 * Requests whose output is an inherently DISTINCT integer sequence — the
 * first N primes or Fibonacci numbers. Deterministic verification cannot
 * judge correctness in general, but for these a collapse to one repeated
 * value is an unambiguous broken-generator signal (observed live: "first
 * 20 primes" emitting twenty 2s, yet passing the compile-and-run gate).
 */
const DISTINCT_SEQUENCE_NOUN = /\b(?:primes?|prime numbers?|numeri primi|fibonacci)\b/i;
const FIRST_PRIME_COUNT = /\b(?:first|primi)\s+(\d+)\s+(?:primes?|prime numbers?|numeri primi)\b/i;

const THREE_NUMBER_REQUEST = /\b(?:three|3|tre)\s+(?:numbers?|integers?|numeri)\b/i;
const MINIMUM_REQUEST = /\b(?:min(?:imum)?|smallest|pi[uù]\s+piccol\w*|minim\w*)\b/i;
const SUM_REQUEST = /\b(?:sum|add|total|somm\w*)\b/i;
const THREE_NUMBER_PROBE = [9, 4, 2] as const;
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10,
};
const COUNTED_NUMBER_REQUEST = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|uno|due|tre|quattro|cinque|sei|sette|otto|nove|dieci)\s+(?:numbers?|integers?|numeri)\b/i;
const NUMBER_PROBE_VALUES = [9, 4, 2, 7, 1, 6, 3, 8, 5, 0] as const;

/** Number of requested interactive integers, bounded to a small safe probe. */
function requestedNumberCount(request: string): number | null {
  const raw = request.match(COUNTED_NUMBER_REQUEST)?.[1]?.toLowerCase();
  if (!raw) return null;
  const count = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
  return Number.isInteger(count) && count >= 2 && count <= NUMBER_PROBE_VALUES.length
    ? count
    : null;
}

/**
 * True when a distinct-sequence request produced output dominated by a
 * single repeated number — sound (a correct sequence has distinct terms),
 * and narrowly gated so it never fires on ordinary programs.
 */
export function degenerateSequenceOutput(request: string, output: string): boolean {
  if (!DISTINCT_SEQUENCE_NOUN.test(request) || !/\d/.test(request)) return false;
  const nums = output.match(/-?\d+/g);
  if (!nums || nums.length < 4) return false;
  const counts = new Map<string, number>();
  for (const n of nums) counts.set(n, (counts.get(n) ?? 0) + 1);
  const top = Math.max(...counts.values());
  return top >= 3 && top / nums.length > 0.5;
}

/** Exact oracle for the common small exercise “print the first N primes”. */
export function primeSequenceMismatch(request: string, output: string): boolean {
  const count = Number(request.match(FIRST_PRIME_COUNT)?.[1]);
  if (!Number.isInteger(count) || count < 1 || count > 50) return false;
  const expected: number[] = [];
  for (let candidate = 2; expected.length < count; candidate++) {
    let prime = true;
    for (let divisor = 2; divisor * divisor <= candidate; divisor++) {
      if (candidate % divisor === 0) {
        prime = false;
        break;
      }
    }
    if (prime) expected.push(candidate);
  }
  const actual = (output.match(/-?\d+/g) ?? []).map(Number).slice(-count);
  return actual.length !== count || actual.some((value, index) => value !== expected[index]);
}

function requestsThreeNumberMinimumAndSum(request: string): boolean {
  return (
    THREE_NUMBER_REQUEST.test(request) &&
    MINIMUM_REQUEST.test(request) &&
    SUM_REQUEST.test(request)
  );
}

function requestsThreeNumberSum(request: string): boolean {
  return THREE_NUMBER_REQUEST.test(request) && SUM_REQUEST.test(request);
}

/**
 * A stable probe for small interactive exercises. C scanf and repeated
 * Python input() calls consume this directly; Python's input().split()
 * gets a space-separated first line instead (see pythonInputPipe below).
 */
function numberedInputPipe(request: string): string | null {
  const count = requestedNumberCount(request);
  return count
    ? `printf '${NUMBER_PROBE_VALUES.slice(0, count).join('\\n')}\\n'`
    : null;
}

/**
 * Run a small Python numeric-input exercise with input() replaced by a
 * stable probe. Repeated `int(input())` calls receive values in order;
 * input().split() receives all requested values from its first call.
 */
function pythonNumberProbeCommand(file: string, count: number): string {
  const values = NUMBER_PROBE_VALUES.slice(0, count).map(String);
  return [
    `python3 -m py_compile ${file} && python3 - ${file} <<'MINERVA_INPUT'`,
    'import builtins, runpy, sys',
    '',
    'class ProbeInput(str):',
    '    def split(self, *args, **kwargs):',
    `        return ${JSON.stringify(values)}`,
    '',
    `values = iter(${JSON.stringify(values)})`,
    'def probe_input(prompt=""):',
    '    print(prompt, end="", flush=True)',
    '    return ProbeInput(next(values))',
    '',
    'builtins.input = probe_input',
    "runpy.run_path(sys.argv[1], run_name='__main__')",
    'MINERVA_INPUT',
  ].join('\n');
}

/**
 * True when the narrowly recognised "three numbers + minimum + sum" task
 * did not report both deterministic results for the probe 9, 4, 2. This is
 * the live t03 failure class: a program consumed one value and printed that
 * value as the minimum, while exit 0 and non-empty output looked healthy.
 */
export function threeNumberMinimumSumMismatch(request: string, output: string): boolean {
  if (!requestsThreeNumberMinimumAndSum(request)) return false;
  const values = (output.match(/-?\d+(?:[.,]\d+)?/g) ?? []).map((token) =>
    Number(token.replace(',', '.')),
  );
  const expectedMinimum = Math.min(...THREE_NUMBER_PROBE);
  const expectedSum = THREE_NUMBER_PROBE.reduce((total, value) => total + value, 0);
  return !values.includes(expectedMinimum) || !values.includes(expectedSum);
}

/**
 * Reject a runnable three-number arithmetic exercise that printed neither
 * the requested sum nor, when asked, the requested minimum for 9, 4, 2.
 * Exit status alone cannot catch a program that reads only one value.
 */
export function threeNumberArithmeticMismatch(request: string, output: string): boolean {
  if (!requestsThreeNumberSum(request)) return false;
  const values = (output.match(/-?\d+(?:[.,]\d+)?/g) ?? []).map((token) =>
    Number(token.replace(',', '.')),
  );
  const expectedSum = THREE_NUMBER_PROBE.reduce((total, value) => total + value, 0);
  if (!values.includes(expectedSum)) return true;
  return requestsThreeNumberMinimumAndSum(request) && !values.includes(Math.min(...THREE_NUMBER_PROBE));
}

/** A counted ascending-sort task must print the probe values in ascending order. */
export function countedSortMismatch(request: string, output: string): boolean {
  const count = requestedNumberCount(request);
  if (!count || !/\b(?:sort\w*|ordin\w*)\b/i.test(request)) return false;
  const actual = (output.match(/-?\d+/g) ?? []).map(Number).slice(-count);
  const expected = [...NUMBER_PROBE_VALUES.slice(0, count)].sort((a, b) => a - b);
  return actual.length !== count || actual.some((value, index) => value !== expected[index]);
}

const NUMERIC_RANGE =
  /\b(?:from|da)\s+(-?\d+)\s+(?:down\s+to|to|a|fino\s+a)\s+(-?\d+)\b/i;

function fizzBuzzLine(n: number): string {
  if (n % 15 === 0) return 'FizzBuzz';
  if (n % 3 === 0) return 'Fizz';
  if (n % 5 === 0) return 'Buzz';
  return String(n);
}

/** FizzBuzz over an explicit numeric range must print every line in order. */
export function fizzBuzzMismatch(request: string, output: string): boolean {
  if (!/\bfizz\s*buzz\b/i.test(request)) return false;
  const match = request.match(NUMERIC_RANGE);
  if (!match) return false;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > end || end - start > 100) return false;
  const expected = Array.from({ length: end - start + 1 }, (_, index) =>
    fizzBuzzLine(start + index),
  );
  const actual = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const tail = actual.slice(-expected.length);
  return tail.length !== expected.length || tail.some((value, index) => value !== expected[index]);
}

/** Explicit countdown bounds are small enough to verify exactly. */
export function countdownMismatch(request: string, output: string): boolean {
  const match = request.match(NUMERIC_RANGE);
  if (
    !match ||
    !/\b(?:counts?\s+down|count(?:ing)?\s+down|countdown|conto\s+alla\s+rovescia)\b/i.test(
      request,
    )
  ) {
    return false;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < end || start - end > 100) return false;
  const expected = Array.from({ length: start - end + 1 }, (_, index) => start - index);
  const actual = (output.match(/-?\d+/g) ?? []).map(Number).slice(-expected.length);
  return actual.length !== expected.length || actual.some((value, index) => value !== expected[index]);
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
 * Read-only syntax check for changed files, or null when none applies.
 * Used in assisted mode, where nothing is executed without approval but a
 * broken file should still be flagged before the student runs it.
 */
export function syntaxCheckCommand(changedPaths: string[]): VerifyCommand | null {
  const unique = [...new Set(changedPaths)];
  const py = unique.filter((p) => p.endsWith('.py'));
  if (py.length) {
    return { command: `python3 -m py_compile ${py.map(quote).join(' ')}`, source: 'syntax check' };
  }
  const js = unique.filter((p) => /\.(js|mjs|cjs)$/.test(p));
  if (js.length) {
    return {
      command: js.map((f) => `node --check ${quote(f)}`).join(' && '),
      source: 'syntax check',
    };
  }
  return null;
}

/**
 * Scope-aware "possibly undefined name" checker (poor man's pyflakes,
 * stdlib-only). Deliberately conservative: order-insensitive binding
 * collection, class scopes visible to children, global/nonlocal treated as
 * bindings, wildcard imports disable the file — a false positive would
 * block valid student code, a miss only loses an advisory warning. Catches
 * the observed typo class: `[int(i) for I in nums]` with no `i` in scope.
 */
const PY_NAME_CHECK = [
  'import ast, builtins, sys',
  '',
  "BUILTINS = set(dir(builtins)) | {'__file__', '__name__', '__doc__', '__builtins__',",
  "    '__package__', '__spec__', '__loader__', '__debug__', '__annotations__'}",
  '',
  'class S:',
  '    def __init__(self, parent):',
  '        self.parent, self.bound, self.loads = parent, set(), []',
  '',
  'def check(path):',
  '    try:',
  "        with open(path, encoding='utf-8') as fh:",
  '            tree = ast.parse(fh.read(), path)',
  '    except Exception:',
  '        return [], False',
  '    scopes, wildcard = [], [False]',
  '',
  '    def bind_args(sc, a):',
  '        for arg in list(getattr(a, "posonlyargs", [])) + list(a.args) + list(a.kwonlyargs):',
  '            sc.bound.add(arg.arg)',
  '        if a.vararg: sc.bound.add(a.vararg.arg)',
  '        if a.kwarg: sc.bound.add(a.kwarg.arg)',
  '',
  '    def visit(node, sc):',
  '        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):',
  '            sc.bound.add(node.name)',
  '            for d in node.decorator_list: visit(d, sc)',
  '            for d in node.args.defaults + [k for k in node.args.kw_defaults if k]: visit(d, sc)',
  '            inner = S(sc); scopes.append(inner); bind_args(inner, node.args)',
  '            for child in node.body: visit(child, inner)',
  '            return',
  '        if isinstance(node, ast.Lambda):',
  '            inner = S(sc); scopes.append(inner); bind_args(inner, node.args)',
  '            visit(node.body, inner)',
  '            return',
  '        if isinstance(node, ast.ClassDef):',
  '            sc.bound.add(node.name)',
  '            for d in node.decorator_list + node.bases: visit(d, sc)',
  '            for k in node.keywords: visit(k.value, sc)',
  '            inner = S(sc); scopes.append(inner)',
  '            for child in node.body: visit(child, inner)',
  '            return',
  '        if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):',
  '            inner = S(sc); scopes.append(inner)',
  '            for idx, gen in enumerate(node.generators):',
  '                visit(gen.iter, sc if idx == 0 else inner)',
  '                for n in ast.walk(gen.target):',
  '                    if isinstance(n, ast.Name): inner.bound.add(n.id)',
  '                for cond in gen.ifs: visit(cond, inner)',
  '            if isinstance(node, ast.DictComp):',
  '                visit(node.key, inner); visit(node.value, inner)',
  '            else:',
  '                visit(node.elt, inner)',
  '            return',
  '        if isinstance(node, (ast.Import, ast.ImportFrom)):',
  '            for alias in node.names:',
  "                if alias.name == '*': wildcard[0] = True",
  "                else: sc.bound.add((alias.asname or alias.name).split('.')[0])",
  '            return',
  '        if isinstance(node, (ast.Global, ast.Nonlocal)):',
  '            for name in node.names:',
  '                sc.bound.add(name)',
  '                scopes[0].bound.add(name)',
  '                if sc.parent: sc.parent.bound.add(name)',
  '            return',
  '        if isinstance(node, ast.ExceptHandler) and node.name:',
  '            sc.bound.add(node.name)',
  '        if isinstance(node, ast.Name):',
  '            if isinstance(node.ctx, ast.Load):',
  '                sc.loads.append((node.lineno, node.id))',
  '            else:',
  '                sc.bound.add(node.id)',
  '            return',
  "        for attr in ('name', 'rest'):",
  "            if node.__class__.__name__.startswith('Match') and isinstance(getattr(node, attr, None), str):",
  '                sc.bound.add(getattr(node, attr))',
  '        for child in ast.iter_child_nodes(node):',
  '            visit(child, sc)',
  '',
  '    root = S(None); scopes.append(root)',
  '    for child in tree.body: visit(child, root)',
  '    problems = set()',
  '    for sc in scopes:',
  '        for line, name in sc.loads:',
  '            if name in BUILTINS: continue',
  '            cur = sc',
  '            while cur and name not in cur.bound: cur = cur.parent',
  '            if cur is None: problems.add((line, name))',
  '    return sorted(problems), wildcard[0]',
  '',
  'failures = 0',
  'for target in sys.argv[1:]:',
  '    found, wildcard = check(target)',
  '    if wildcard: continue',
  '    for line, name in found:',
  '        failures += 1',
  '        print("%s:%d: possibly undefined name %r" % (target, line, name))',
  'sys.exit(1 if failures else 0)',
].join('\n');

/**
 * Advisory undefined-name check for changed Python files, or null when
 * none apply. Read-only: parses the AST, never executes the program.
 */
export function undefinedNameCheckCommand(changedPaths: string[]): VerifyCommand | null {
  const py = [...new Set(changedPaths)].filter((p) => p.endsWith('.py'));
  if (!py.length) return null;
  return {
    command: `python3 - ${py.map(quote).join(' ')} <<'MINERVA_NAMECHECK'\n${PY_NAME_CHECK}\nMINERVA_NAMECHECK`,
    source: 'undefined-name check',
  };
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
    const inputCount = requestedNumberCount(request);
    return {
      command: inputCount
        ? pythonNumberProbeCommand(quote(changedPy[0]), inputCount)
        : `python3 ${quote(changedPy[0])}`,
      source: 'compile and run',
      timeoutMs: 10_000,
      expectOutput: EXPECTS_PRINTED_OUTPUT.test(request),
    };
  }
  if (cSources.length && executeNamedProgram && cSources.some((p) => requestNamesPath(request, p))) {
    const input = numberedInputPipe(request);
    return {
      command: `bin=$(mktemp "\${TMPDIR:-/tmp}/minervacli-c.XXXXXX") && trap 'rm -f "$bin"' EXIT && cc -std=c11 -Wall -Wextra -pedantic ${cSources.map(quote).join(' ')} -o "$bin" -lm && ${input ? `${input} | ` : ''}"$bin"`,
      source: 'compile and run',
      timeoutMs: 10_000,
    };
  }
  if (
    cppSources.length &&
    executeNamedProgram &&
    cppSources.some((p) => requestNamesPath(request, p))
  ) {
    const input = numberedInputPipe(request);
    return {
      command: `bin=$(mktemp "\${TMPDIR:-/tmp}/minervacli-cpp.XXXXXX") && trap 'rm -f "$bin"' EXIT && c++ -std=c++17 -Wall -Wextra -pedantic ${cppSources.map(quote).join(' ')} -o "$bin" && ${input ? `${input} | ` : ''}"$bin"`,
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
    // Plain `def test_*` functions with pytest absent: a syntax check would
    // never execute the asserts, so "make the tests pass" could never be
    // verified. Run them with a minimal driver instead.
    if (contents.some((c) => /^def test_/m.test(c ?? ''))) {
      const driver = [
        'import runpy, sys',
        'failures = 0',
        `for path in ${JSON.stringify(testFiles)}:`,
        '    try:',
        '        module = runpy.run_path(path)',
        '    except Exception as err:',
        '        failures += 1',
        '        print(f"{path} FAILED during collection: {err!r}")',
        '        continue',
        '    tests = [(k, v) for k, v in sorted(module.items()) if k.startswith("test_") and callable(v)]',
        '    for name, fn in tests:',
        '        try:',
        '            fn()',
        '            print(f"{path}::{name} passed")',
        '        except Exception as err:',
        '            failures += 1',
        '            print(f"{path}::{name} FAILED: {err!r}")',
        'sys.exit(1 if failures else 0)',
      ].join('\n');
      return {
        command: `${compileChanged}python3 - <<'MINERVA_TESTS'\n${driver}\nMINERVA_TESTS`,
        source: 'python test functions',
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

  // No test setup — check the files that were just changed. A single
  // changed script is also RUN with dummy piped input: a syntax check alone
  // passes code that crashes on its first real line, and "verified" must
  // not mean that. Interactive input() scripts read the dummy lines and
  // terminate; crashes feed their traceback back into the repair loop.
  if (changedPy.length === 1) {
    const file = quote(changedPy[0]);
    const inputCount = requestedNumberCount(request);
    return {
      command: inputCount
        ? pythonNumberProbeCommand(file, inputCount)
        : `python3 -m py_compile ${file} && yes 2 | head -50 | python3 ${file}`,
      source: 'compile and run',
      timeoutMs: 10_000,
      expectOutput: EXPECTS_PRINTED_OUTPUT.test(request),
    };
  }
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
    // A print-something program that prints nothing usually defines main()
    // and never calls it — running "cleanly" is not the requested behavior.
    if (cmd.expectOutput && (!output.trim() || output.trim() === '(no output)')) {
      return {
        ok: false,
        output:
          'The program ran but printed NOTHING. The request requires printed output — make sure the file actually executes its logic when run (call main() at the bottom or put the code at top level).',
      };
    }
    return { ok: true, output };
  } catch (err) {
    let output = err instanceof Error ? err.message : String(err);
    if (/exit 5\b/.test(output) && /pytest|unittest/.test(cmd.command)) {
      output += '\n(exit code 5 means the runner collected no tests — check test file and function names)';
    }
    return { ok: false, output };
  }
}
