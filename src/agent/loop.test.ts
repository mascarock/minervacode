import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MinervaClient } from '../api/client.js';
import type { ChatMessage } from '../types.js';
import {
  MAX_VERIFY_RUNS,
  definesIdentifier,
  requestExplicitSourcePaths,
  requestAllowsNewFile,
  requestExpectsChanges,
  requestAllowsTestEdit,
  requestRequiredDefinitions,
  runAgent,
  type AgentEvents,
} from './loop.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sseResponse(text: string): Response {
  const chunk = JSON.stringify({ choices: [{ delta: { content: text } }] });
  return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { status: 200 });
}

async function tempProject(): Promise<string> {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'minervacli-loop-'));
  dirs.push(projectDir);
  return projectDir;
}

function mockClient(responses: string[], requestBodies: unknown[] = []): MinervaClient {
  return {
    model: 'test-model',
    async postStream(_path: string, body: unknown) {
      requestBodies.push(body);
      return sseResponse(responses.shift() ?? 'Done.');
    },
  } as MinervaClient;
}

function autoEvents(): AgentEvents {
  return {
    onText() {},
    onToolStart() {},
    onToolEnd() {},
    async confirm() {
      throw new Error('Autonomous mode must not request approval');
    },
  };
}

describe('requestAllowsTestEdit', () => {
  it.each([
    'Write tests for calc.py.',
    'Add a unit test for average.',
    'Fix the failing tests.',
    'Update test_calc.py to cover the zero case.',
    'Scrivi i test per utils.py.',
    'Aggiungi dei test per la funzione media.',
    'Please add some more tests.',
  ])('allows: %s', (prompt) => {
    expect(requestAllowsTestEdit(prompt, 'test_calc.py')).toBe(true);
  });

  it.each([
    'Fix the bug in math.js so the existing tests pass.', // exact failed smoke prompt
    'Fix the bug in calc.py and verify with the tests.',
    'Verify with the tests.',
    'Make test_calc.py pass by fixing calc.py.',
    'The tests are failing, find out why.',
    'Fix average so all tests are green.',
    'Fix calc.py but do not modify tests.',
    "Fix calc.py; don't change test_calc.py.",
    'Correggi calc.py senza modificare i test.',
    'Correggi calc.py e non cambiare i test.',
  ])('blocks: %s', (prompt) => {
    expect(requestAllowsTestEdit(prompt, 'test_calc.py')).toBe(false);
    expect(requestAllowsTestEdit(prompt, 'math.test.js')).toBe(false);
  });

  it('allows when the change verb targets the exact test file', () => {
    expect(requestAllowsTestEdit('Edit math.test.js to add an edge case.', 'math.test.js')).toBe(
      true,
    );
    expect(requestAllowsTestEdit('Look at math.test.js and fix the source.', 'math.test.js')).toBe(
      false,
    );
  });
});

describe('requestAllowsNewFile', () => {
  it.each([
    'Create the answer program.',
    'Write a note explaining the result.',
    'Add a new authentication module.',
    'Implement login support.',
    'Crea un nuovo file Python.',
  ])('allows explicit creation intent: %s', (prompt) => {
    expect(requestAllowsNewFile(prompt)).toBe(true);
  });

  it.each([
    'Fix the bug in calc.js.',
    'Make the existing tests pass by fixing the source.',
    'Correggi il bug senza cambiare altro.',
  ])('blocks creation during a focused fix: %s', (prompt) => {
    expect(requestAllowsNewFile(prompt)).toBe(false);
  });
});

describe('requestExpectsChanges', () => {
  it('distinguishes mutating instructions from informational requests', () => {
    expect(requestExpectsChanges('Fix the bug in calc.js.')).toBe(true);
    expect(requestExpectsChanges('Correggi il bug in calc.py.')).toBe(true);
    expect(requestExpectsChanges('Explain how to fix calc.js.')).toBe(false);
    expect(requestExpectsChanges('Review the changes.')).toBe(false);
  });

  it('recognizes exercise-style requests that describe program behavior', () => {
    expect(
      requestExpectsChanges(
        "Chiedi all'utente di inserire tre numeri, dopodiché verifica qual è il più piccolo e sommali.",
      ),
    ).toBe(true);
    expect(requestExpectsChanges('Ask the user for a number and print its square.')).toBe(true);
    expect(requestExpectsChanges('Stampa i primi 10 numeri primi.')).toBe(true);
    expect(
      requestExpectsChanges('adesso estendi lo script per i primi 40 numeri primi'),
    ).toBe(true);
    expect(requestExpectsChanges('Extend the script to 40 primes.')).toBe(true);
    // Informational phrasing still wins over behavior verbs.
    expect(requestExpectsChanges('Cosa stampa questo script?')).toBe(false);
    expect(requestExpectsChanges('Explain what this prints.')).toBe(false);
  });
});

describe('requestRequiredDefinitions', () => {
  it('extracts function names spelled with call syntax', () => {
    expect(
      requestRequiredDefinitions('Add a function is_even(n) to utils.py.'),
    ).toEqual(['is_even']);
    expect(
      requestRequiredDefinitions('Create shapes.py with area_circle(r) and area_square(s).'),
    ).toEqual(['area_circle', 'area_square']);
  });

  it('ignores common builtins used in prose', () => {
    expect(requestRequiredDefinitions('Make it print(x) when the user types input().')).toEqual(
      [],
    );
  });
});

describe('definesIdentifier', () => {
  it('matches definitions, not calls', () => {
    expect(definesIdentifier('def is_even(n):\n    return n % 2 == 0\n', 'is_even')).toBe(true);
    expect(definesIdentifier('print(is_even(4))\n', 'is_even')).toBe(false);
    expect(definesIdentifier('const isEven = (n) => n % 2 === 0;\n', 'isEven')).toBe(true);
    expect(definesIdentifier('function greet() {}\n', 'greet')).toBe(true);
  });
});

describe('requestExplicitSourcePaths', () => {
  it('extracts source paths explicitly named in a request', () => {
    expect(
      requestExplicitSourcePaths(
        'Write a C program in primes.c, then update src/report.ts and run it.',
      ),
    ).toEqual(['primes.c', 'src/report.ts']);
  });

  it('matches a path at the end of a sentence', () => {
    expect(requestExplicitSourcePaths('Create primes.c. Then compile it.')).toEqual([
      'primes.c',
    ]);
    expect(requestExplicitSourcePaths('Create primes.c.')).toEqual(['primes.c']);
  });
});

describe('autonomous agent loop', () => {
  it('does not create a missing path that was only mentioned as context', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'calc.py'), 'print("ok")\n');
    const requestBodies: unknown[] = [];

    const result = await runAgent(mockClient(['No change is needed.'], requestBodies), {
      history: [],
      prompt: 'Inspect calc.py; the traceback mentions missing.py.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(existsSync(path.join(projectDir, 'missing.py'))).toBe(false);
    expect(JSON.stringify(requestBodies[0])).not.toContain('Hard acceptance requirement');
    expect(result.status).toBe('completed');
  });

  it('returns a model-error result instead of throwing when the API fails', async () => {
    const projectDir = await tempProject();
    const events = autoEvents();
    const statuses: string[] = [];
    events.onStatus = (text) => statuses.push(text);
    const client = {
      model: 'test-model',
      async postStream() {
        throw new Error('upstream unavailable');
      },
    } as MinervaClient;

    const result = await runAgent(client, {
      history: [],
      prompt: 'Create answer.c.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events,
    });

    expect(result.status).toBe('model-error');
    expect(statuses.at(-1)).toContain('upstream unavailable');
  });

  it('does not report a mutating request as completed when no change was applied', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'calc.py'), 'x = 1\n');
    const statuses: string[] = [];
    const events = autoEvents();
    events.onStatus = (text) => statuses.push(text);

    const result = await runAgent(mockClient(['I could not find anything to change.']), {
      history: [],
      prompt: 'Fix the bug in calc.py.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events,
    });

    expect(result.status).toBe('no-change');
    expect(statuses.at(-1)).toContain('no applicable change');
  });

  it('rejects an alternative new source file when the request names the required path', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'main.py'), 'print("existing")\n');
    const requestBodies: unknown[] = [];
    const responses = [
      '<minerva_tool name="Write">\n<path>new_main.c</path>\n<content>\nint main(void) { return 0; }\n</content>\n</minerva_tool>',
      '<minerva_tool name="Write">\n<path>primes.c</path>\n<content>\n#include <stdio.h>\nint main(void) { puts("2 3 5 7 11 13 17 19 23 29"); return 0; }\n</content>\n</minerva_tool>',
      'Created and executed primes.c.',
      'LGTM',
    ];

    const result = await runAgent(mockClient(responses, requestBodies), {
      history: [],
      prompt: 'Write primes.c to print the first 10 primes, compile it, and execute it.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(existsSync(path.join(projectDir, 'new_main.c'))).toBe(false);
    expect(await readFile(path.join(projectDir, 'primes.c'), 'utf-8')).toContain(
      '2 3 5 7 11 13 17 19 23 29',
    );
    expect(JSON.stringify(requestBodies[1])).toContain('explicitly requires primes.c');
    expect(JSON.stringify(requestBodies[2])).toContain('cc -std=c11 -Wall -Wextra -pedantic');
    expect(JSON.stringify(requestBodies[2])).toContain('2 3 5 7 11 13 17 19 23 29');
    expect(result.status).toBe('completed');
    expect(result.verified).toBe(true);
    // The end-of-run report shows this as evidence: what ran and what it printed.
    expect(result.verification).toMatchObject({ ok: true, source: 'compile and run' });
    expect(result.verification?.output).toContain('2 3 5 7 11 13 17 19 23 29');
  });

  it('does not complete when an explicitly requested new file is still missing', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'main.py'), 'print("existing")\n');
    const statuses: string[] = [];
    const events = autoEvents();
    events.onStatus = (text) => statuses.push(text);
    const responses = [
      'Updated `main.py`:\n\n```python\nprint("wrong target")\n```',
      'Done.',
      'Still done.',
    ];

    const result = await runAgent(mockClient(responses), {
      history: [],
      prompt: 'Create primes.c and execute it.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      review: false,
      events,
    });

    expect(result.status).toBe('requirements-unmet');
    expect(result.verified).toBe(true);
    expect(existsSync(path.join(projectDir, 'primes.c'))).toBe(false);
    expect(statuses.at(-1)).toContain('primes.c');
  });

  it('refuses partial whole-file writes for a requested executable C program', async () => {
    const projectDir = await tempProject();
    const requestBodies: unknown[] = [];
    const responses = [
      'Updated `primes.c`:\n\n```c\nint output = 0;\n```',
      'Updated `Primes.c`:\n\n```c\n#include <stdio.h>\nint main(void) { puts("ok"); return 0; }\n```',
      'Done.',
      'LGTM',
    ];

    const result = await runAgent(mockClient(responses, requestBodies), {
      history: [],
      prompt: 'Create primes.c, compile it, and execute it.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(JSON.stringify(requestBodies[1])).toContain('only a partial snippet');
    expect(await readFile(path.join(projectDir, 'primes.c'), 'utf-8')).toContain('main(void)');
    expect(await readdir(projectDir)).toContain('primes.c');
    expect(await readdir(projectDir)).not.toContain('Primes.c');
    expect(result.verified).toBe(true);
  });

  it('lets the model fully rewrite a broken file it created this run', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'notes.md'), 'existing project\n');
    const responses = [
      // First draft defines helper() but the rewrite drops it — allowed,
      // because there is no student work in a file this run created.
      'Updated `countdown.py`:\n\n```python\ndef helper():\n    pass\n\nhelper2()\n```',
      'The NameError means helper2 is undefined.',
      'Updated `countdown.py`:\n\n```python\nfor i in range(5, 0, -1):\n    print(i)\n```',
      'Done.',
      'LGTM',
    ];

    const result = await runAgent(mockClient(responses), {
      history: [],
      prompt: 'Create countdown.py that counts 5 to 1 and run it.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    // Neither merged with the broken draft nor refused for dropping helper().
    expect(await readFile(path.join(projectDir, 'countdown.py'), 'utf-8')).toBe(
      'for i in range(5, 0, -1):\n    print(i)\n',
    );
    expect(result.status).toBe('completed');
    expect(result.verified).toBe(true);
  });

  it('separates stable instructions from a relevance-ranked current repository snapshot', async () => {
    const projectDir = await tempProject();
    await mkdir(path.join(projectDir, 'src'));
    await writeFile(
      path.join(projectDir, 'src', 'auth.ts'),
      'export function validateToken() { return false; }\n',
    );
    await writeFile(path.join(projectDir, 'src', 'dates.ts'), 'export function formatDate() {}\n');
    const requestBodies: unknown[] = [];

    await runAgent(mockClient(['No change needed.'], requestBodies), {
      history: [],
      prompt: 'Inspect validateToken in auth.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    const body = requestBodies[0] as { messages: ChatMessage[] };
    // The mock retains the request array by reference, so the completed
    // assistant response is appended after postStream receives it.
    expect(body.messages.slice(0, 3).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(body.messages[0].content).toContain('You are Minerva');
    expect(body.messages[0].content).not.toContain('return false');
    expect(body.messages[2].content).toContain('Repository map');
    expect(body.messages[2].content).toContain('symbols: validateToken');
    expect(body.messages[2].content).toContain('=== src/auth.ts ===');
    expect(body.messages[2].content).toContain('return false');
  });

  it('feeds a failing initial test run into the first model request', async () => {
    const projectDir = await tempProject();
    await mkdir(path.join(projectDir, 'src'));
    await mkdir(path.join(projectDir, 'test'));
    await writeFile(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
    );
    await writeFile(
      path.join(projectDir, 'src', 'calc.js'),
      'export function add(a, b) { return a - b; }\n',
    );
    await writeFile(
      path.join(projectDir, 'test', 'calc.test.js'),
      "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from '../src/calc.js';\ntest('sum', () => assert.equal(add(8, 5), 13));\n",
    );
    const requestBodies: unknown[] = [];

    await runAgent(mockClient(['I could not produce a change.'], requestBodies), {
      history: [],
      prompt: 'Fix the bug in src/calc.js.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    const firstRequest = JSON.stringify(requestBodies[0]);
    expect(firstRequest).toContain('Initial verification failed before any changes');
    expect(firstRequest).toContain('3 !== 13');
    expect(firstRequest).toContain('npm test --silent');
  });

  it('compacts old bulk before calling the model and reports it', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'main.py'), 'print(1)\n');
    const huge = 'OLD_BULK_SENTINEL'.repeat(8_000);
    const history: ChatMessage[] = [
      { role: 'user', content: 'Stable agent rules' },
      { role: 'assistant', content: '<minerva_tool name="Read"><path>old.py</path></minerva_tool>' },
      { role: 'user', content: `<tool_result name="Read" status="ok">\n${huge}\n</tool_result>` },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'Earlier request' },
      { role: 'assistant', content: 'Middle answer' },
      { role: 'user', content: 'Middle request' },
      { role: 'assistant', content: 'Recent answer' },
      { role: 'user', content: 'Recent request' },
    ];
    const requestBodies: unknown[] = [];
    const statuses: string[] = [];

    const events = autoEvents();
    events.onStatus = (text) => statuses.push(text);
    const result = await runAgent(mockClient(['Done.'], requestBodies), {
      history,
      prompt: 'Check main.py.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events,
    });

    const serialized = JSON.stringify(requestBodies[0]);
    expect(serialized).toContain('Older successful Read result omitted');
    expect(serialized).not.toContain(huge);
    expect(statuses.some((status) => status.startsWith('Compacted context from'))).toBe(true);
    expect(JSON.stringify(result.history)).toContain('Older successful Read result omitted');
  });

  it('applies a code-block edit, harness-verifies it, and self-reviews', async () => {
    const projectDir = await tempProject();
    const responses = [
      'Updated `answer.js`:\n\n```js\nconsole.log(42);\n```',
      'Implemented and verified successfully.',
      'LGTM', // review pass
    ];
    const requestBodies: unknown[] = [];
    const client = mockClient(responses, requestBodies);

    const result = await runAgent(client, {
      history: [],
      prompt: 'Create the answer program.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(await readFile(path.join(projectDir, 'answer.js'), 'utf-8')).toBe('console.log(42);\n');
    // request 1: prompt; request 2: write result + harness verification;
    // request 3: standalone review call.
    expect(requestBodies).toHaveLength(3);
    const second = JSON.stringify(requestBodies[1]);
    expect(second).toContain('node --check');
    expect(second).toContain('Verification passed');
    expect(JSON.stringify(requestBodies[2])).toContain("reviewing a student's code change");
    expect(result.finalText).toBe('Implemented and verified successfully.');
    expect(result.changes.map((c) => c.path)).toEqual(['answer.js']);
  });

  it('reports review BUG findings as advisory without a fix cycle', async () => {
    const projectDir = await tempProject();
    const statuses: string[] = [];
    const events = autoEvents();
    events.onStatus = (text) => statuses.push(text);
    const responses = [
      'Updated `answer.js`:\n\n```js\nconsole.log(41);\n```',
      'Done.',
      '[BUG] answer.js — prints 41 instead of 42', // review
    ];
    const client = mockClient(responses);

    const result = await runAgent(client, {
      history: [],
      prompt: 'Print 42.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events,
    });

    // The verified file is untouched: a 7B review must never trigger a
    // rewrite of a state that already passed deterministic verification.
    expect(await readFile(path.join(projectDir, 'answer.js'), 'utf-8')).toBe('console.log(41);\n');
    expect(result.changes).toHaveLength(1);
    expect(result.status).toBe('completed');
    expect(statuses.at(-1)).toContain('advisory review');
  });

  it('keeps a verified result when the advisory review request fails', async () => {
    const projectDir = await tempProject();
    const statuses: string[] = [];
    const events = autoEvents();
    events.onStatus = (text) => statuses.push(text);
    let calls = 0;
    const client = {
      model: 'test-model',
      async postStream() {
        calls++;
        if (calls === 1) {
          return sseResponse('Updated `answer.js`:\n\n```js\nconsole.log(42);\n```');
        }
        if (calls === 2) return sseResponse('Done.');
        throw new Error('review service unavailable');
      },
    } as MinervaClient;

    const result = await runAgent(client, {
      history: [],
      prompt: 'Create the answer program.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events,
    });

    expect(result.status).toBe('completed');
    expect(result.verified).toBe(true);
    expect(await readFile(path.join(projectDir, 'answer.js'), 'utf-8')).toBe(
      'console.log(42);\n',
    );
    expect(statuses.at(-1)).toContain('Advisory review unavailable');
  });

  it('waits for a source edit instead of rerunning an unchanged failed verification', async () => {
    const projectDir = await tempProject();
    const requestBodies: unknown[] = [];
    const bashRuns: string[] = [];
    const events = autoEvents();
    events.onToolStart = (event) => {
      if (event.tool.name === 'Bash') bashRuns.push(event.summary);
    };
    const responses = [
      'Updated `answer.c`:\n\n```c\nint main(void) { broken }\n```',
      'The compiler error means the source must be corrected.',
      'Updated `answer.c`:\n\n```c\n#include <stdio.h>\nint main(void) { puts("ok"); return 0; }\n```',
      'Implemented and executed.',
      'LGTM',
    ];

    const result = await runAgent(mockClient(responses, requestBodies), {
      history: [],
      prompt: 'Create answer.c, compile it, and execute it.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events,
    });

    expect(bashRuns).toHaveLength(2);
    expect(JSON.stringify(requestBodies[2])).toContain(
      'previous verification failed and this reply did not apply a source fix',
    );
    expect(result.status).toBe('completed');
    expect(result.verified).toBe(true);
  });

  it('nudges once when the reply has a fence but no applicable file', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'calc.py'), 'x = 1\n');
    const responses = [
      // No filename anywhere the old parser accepted, junk extension inside.
      '```python\ny = 2\n```',
      'Updated `calc.py`:\n\n```python\ny = 2\n```',
      'Done.',
      'LGTM',
    ];
    const requestBodies: unknown[] = [];
    const client = mockClient(responses, requestBodies);

    await runAgent(client, {
      history: [],
      prompt: 'Set y.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(JSON.stringify(requestBodies[1])).toContain('I could not apply anything');
    expect(await readFile(path.join(projectDir, 'calc.py'), 'utf-8')).toBe('y = 2\n');
  });

  it('nudges when the model claims an action without emitting one', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'calc.py'), 'x = 1\n');
    const responses = [
      "I've fixed the average function in calc.py.",
      'Updated `calc.py`:\n\n```python\nx = 2\n```',
      'Done.',
      'LGTM',
    ];
    const requestBodies: unknown[] = [];
    const client = mockClient(responses, requestBodies);

    await runAgent(client, {
      history: [],
      prompt: 'Fix the bug.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(JSON.stringify(requestBodies[1])).toContain('I could not apply anything');
    expect(await readFile(path.join(projectDir, 'calc.py'), 'utf-8')).toBe('x = 2\n');
  });

  it('fails honestly when a requested function is never defined', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'utils.py'), 'def double(n):\n    return n * 2\n');
    const responses = [
      // The model "adds is_even" but actually just restates double().
      'Updated `utils.py`:\n\n```python\ndef double(n):\n    """Return n * 2."""\n    return n * 2\n```',
      'All done!',
      'All done!',
      'All done!',
    ];
    const client = mockClient(responses);

    const result = await runAgent(client, {
      history: [],
      prompt: 'Add a function is_even(n) to utils.py that returns True for even numbers.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(result.status).toBe('requirements-unmet');
  });

  it('accepts the run once the requested function gets defined after a nudge', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'utils.py'), 'def double(n):\n    return n * 2\n');
    const responses = [
      'Updated `utils.py`:\n\n```python\ndef double(n):\n    return n * 2\n```',
      'Updated `utils.py`:\n\n```python\ndef is_even(n):\n    return n % 2 == 0\n```',
      'Done.',
      'LGTM',
    ];
    const client = mockClient(responses);

    const result = await runAgent(client, {
      history: [],
      prompt: 'Add a function is_even(n) to utils.py.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(result.status).toBe('completed');
    const content = await readFile(path.join(projectDir, 'utils.py'), 'utf-8');
    expect(content).toContain('def is_even');
    expect(content).toContain('def double');
  });

  it('allows a rename request to drop the renamed definition', async () => {
    const projectDir = await tempProject();
    await writeFile(
      path.join(projectDir, 'calc.py'),
      'def add(a, b):\n    return a + b\n\nprint(add(1, 2))\n',
    );
    const responses = [
      'Updated `calc.py`:\n\n```python\ndef sum_two(a, b):\n    return a + b\n\nprint(sum_two(1, 2))\n```',
      'Done.',
      'LGTM',
    ];
    const client = mockClient(responses);

    const result = await runAgent(client, {
      history: [],
      prompt: 'Rename the function add to sum_two in calc.py and update its callers.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(result.status).toBe('completed');
    const content = await readFile(path.join(projectDir, 'calc.py'), 'utf-8');
    expect(content).toContain('def sum_two');
    expect(content).not.toContain('def add');
  });

  it('retries once after a transient model failure', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'calc.py'), 'x = 1\n');
    let calls = 0;
    const client = {
      model: 'test-model',
      async postStream() {
        calls++;
        if (calls === 1) throw new Error('Model response timed out after 60000ms');
        return sseResponse(
          calls === 2 ? 'Updated `calc.py`:\n\n```python\nx = 2\n```' : 'Done.',
        );
      },
    } as MinervaClient;

    const result = await runAgent(client, {
      history: [],
      prompt: 'Set x to 2 in calc.py.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(result.status).toBe('completed');
    expect(await readFile(path.join(projectDir, 'calc.py'), 'utf-8')).toBe('x = 2\n');
  });

  it('fails honestly when an ask-the-user program never reads input', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'main.py'), 'print("hi")\n');
    const responses = [
      // Regurgitated context code instead of the requested input program.
      'Updated `main.py`:\n\n```python\nprint("hello world")\n```',
      'Done.',
      'Done.',
      'Done.',
    ];
    const client = mockClient(responses);

    const result = await runAgent(client, {
      history: [],
      prompt: "Chiedi all'utente un numero e stampa la sua tabellina fino a 10.",
      projectDir,
      permissionMode: 'dontAsk',
      language: 'it',
      events: autoEvents(),
    });

    expect(result.status).toBe('requirements-unmet');
  });

  it('accepts an ask-the-user program once it reads input after a nudge', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'main.py'), 'print("hi")\n');
    const responses = [
      'Updated `main.py`:\n\n```python\nprint("hello world")\n```',
      'Updated `main.py`:\n\n```python\nn = int(input("Numero: "))\nfor i in range(1, 11):\n    print(n * i)\n```',
      'Done.',
      'LGTM',
    ];
    const client = mockClient(responses);

    const result = await runAgent(client, {
      history: [],
      prompt: "Chiedi all'utente un numero e stampa la sua tabellina fino a 10.",
      projectDir,
      permissionMode: 'dontAsk',
      language: 'it',
      events: autoEvents(),
    });

    expect(result.status).toBe('completed');
    expect(await readFile(path.join(projectDir, 'main.py'), 'utf-8')).toContain('input(');
  });

  it('nudges Italian action claims and web-UI hallucinations', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'calc.py'), 'x = 1\n');
    const responses = [
      'Ho creato una funzione. Se vuoi vedere il codice, clicca sul pulsante "Show Code".',
      'Updated `calc.py`:\n\n```python\nx = 2\n```',
      'Done.',
      'LGTM',
    ];
    const requestBodies: unknown[] = [];
    const client = mockClient(responses, requestBodies);

    await runAgent(client, {
      history: [],
      prompt: 'Scrivi la funzione in calc.py.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'it',
      events: autoEvents(),
    });

    const nudge = JSON.stringify(requestBodies[1]);
    expect(nudge).toContain('I could not apply anything');
    expect(nudge).toContain('no buttons');
    expect(await readFile(path.join(projectDir, 'calc.py'), 'utf-8')).toBe('x = 2\n');
  });

  it('merges a partial code-block write instead of overwriting the file', async () => {
    const projectDir = await tempProject();
    await writeFile(
      path.join(projectDir, 'calc.py'),
      'def average(n):\n    return sum(n) / (len(n) - 1)\n\n\ndef maximum(n):\n    return max(n)\n',
    );
    const responses = [
      'Updated `calc.py`:\n\n```python\ndef average(n):\n    return sum(n) / len(n)\n```',
      'Done.',
      'LGTM',
    ];
    const client = mockClient(responses);

    await runAgent(client, {
      history: [],
      prompt: 'Fix only average.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    const calc = await readFile(path.join(projectDir, 'calc.py'), 'utf-8');
    expect(calc).toContain('return sum(n) / len(n)');
    expect(calc).toContain('def maximum(n):');
  });

  it('refuses unsolicited test-file writes in auto mode', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'calc.py'), 'x = 1\n');
    await writeFile(path.join(projectDir, 'test_calc.py'), 'from calc import x\n');
    const responses = [
      '<minerva_tool name="Write">\n<path>test_calc.py</path>\n<content>\nassert True\n</content>\n</minerva_tool>',
      'Understood, done.',
    ];
    const requestBodies: unknown[] = [];
    const client = mockClient(responses, requestBodies);

    const result = await runAgent(client, {
      history: [],
      prompt: 'Fix the bug in calc.py and verify.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(await readFile(path.join(projectDir, 'test_calc.py'), 'utf-8')).toBe(
      'from calc import x\n',
    );
    expect(JSON.stringify(requestBodies[1])).toContain('Refused: test_calc.py is a test file');
    expect(result.changes).toEqual([]);
  });

  it('refuses unsolicited new files during a focused fix', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'calc.py'), 'x = 1\n');
    const responses = [
      '<minerva_tool name="Write">\n<path>unrelated.py</path>\n<content>\nx = 2\n</content>\n</minerva_tool>',
      'Understood.',
    ];
    const requestBodies: unknown[] = [];

    const result = await runAgent(mockClient(responses, requestBodies), {
      history: [],
      prompt: 'Fix the bug in calc.py.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(existsSync(path.join(projectDir, 'unrelated.py'))).toBe(false);
    expect(JSON.stringify(requestBodies[1])).toContain('did not ask to create files');
    expect(result.changes).toEqual([]);
  });

  it('refuses an overwrite that deletes unrelated source definitions', async () => {
    const projectDir = await tempProject();
    await writeFile(
      path.join(projectDir, 'calc.js'),
      'export function add(a, b) { return a - b; }\n\nexport function multiply(a, b) { return a * b; }\n',
    );
    const responses = [
      '<minerva_tool name="Write">\n<path>calc.js</path>\n<content>\nimport { add } from "./missing.js";\n</content>\n</minerva_tool>',
      'Understood.',
    ];
    const requestBodies: unknown[] = [];

    const result = await runAgent(mockClient(responses, requestBodies), {
      history: [],
      prompt: 'Fix add in calc.js.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(await readFile(path.join(projectDir, 'calc.js'), 'utf8')).toContain(
      'function multiply',
    );
    expect(JSON.stringify(requestBodies[1])).toContain('would delete unrelated definitions');
    expect(result.changes).toEqual([]);
  });

  it('allows test-file writes when the request asks for tests', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'calc.py'), 'x = 1\n');
    const responses = [
      '<minerva_tool name="Write">\n<path>test_calc.py</path>\n<content>\nassert True\n</content>\n</minerva_tool>',
      'Done.',
      'LGTM',
    ];
    const client = mockClient(responses);

    await runAgent(client, {
      history: [],
      prompt: 'Write tests for calc.py.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(await readFile(path.join(projectDir, 'test_calc.py'), 'utf-8')).toBe('assert True\n');
  });

  it('nudges instead of writing when a bare filename is ambiguous', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'package.json'), '{}');
    await mkdir(path.join(projectDir, 'src'));
    await mkdir(path.join(projectDir, 'lib'));
    await writeFile(path.join(projectDir, 'src', 'config.js'), 'export default 1;\n');
    await writeFile(path.join(projectDir, 'lib', 'config.js'), 'export default 2;\n');
    const responses = [
      'Updated `config.js`:\n\n```js\nexport default 3;\n```',
      'Updated `src/config.js`:\n\n```js\nexport default 3;\n```',
      'Done.',
      'LGTM',
    ];
    const requestBodies: unknown[] = [];
    const client = mockClient(responses, requestBodies);

    await runAgent(client, {
      history: [],
      prompt: 'Bump the config default.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(existsSync(path.join(projectDir, 'config.js'))).toBe(false);
    expect(JSON.stringify(requestBodies[1])).toContain('I could not apply anything');
    expect(await readFile(path.join(projectDir, 'src', 'config.js'), 'utf-8')).toBe(
      'export default 3;\n',
    );
  });

  it('reports net changes with first-seen and final contents', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'calc.py'), 'x = 1\n');
    const responses = [
      'Updated `calc.py`:\n\n```python\nx = 2\n```',
      'Updated `calc.py`:\n\n```python\nx = 3\n```',
      'Done.',
      'LGTM',
    ];
    const client = mockClient(responses);

    const result = await runAgent(client, {
      history: [],
      prompt: 'Set x to 3.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(result.netChanges).toEqual([
      { path: 'calc.py', before: 'x = 1\n', after: 'x = 3\n', existedBefore: true },
    ]);
    expect(result.verified).toBe(true);
  });

  it('downgrades a stale verified=true when later changes could not be checked', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'calc.py'), 'x = 1\n');
    // One more change than the verification budget can cover must downgrade
    // the stale passing result instead of claiming the latest state passed.
    const responses = Array.from(
      { length: MAX_VERIFY_RUNS + 1 },
      (_, i) => `Updated \`calc.py\`:\n\n\`\`\`python\nx = ${i + 2}\n\`\`\``,
    );
    responses.push('Done.', 'LGTM');
    const client = mockClient(responses);

    const result = await runAgent(client, {
      history: [],
      prompt: 'Count x up.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(await readFile(path.join(projectDir, 'calc.py'), 'utf-8')).toBe(
      `x = ${MAX_VERIFY_RUNS + 2}\n`,
    );
    expect(result.verified).toBe(false);
  });

  it('keeps verified=true when later changes have no applicable verifier', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'calc.py'), 'x = 1\n');
    const responses = [
      'Updated `calc.py`:\n\n```python\nx = 2\n```',
      'Updated `NOTES.md`:\n\n```\nhello\n```',
      'Done.',
      'LGTM',
    ];
    const client = mockClient(responses);

    const result = await runAgent(client, {
      history: [],
      prompt: 'Bump x and write a note.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(result.verified).toBe(true);
    expect(result.netChanges.map((c) => c.path).sort()).toEqual(['NOTES.md', 'calc.py']);
  });

  it('does not verify or review in assisted mode after a code-block write', async () => {
    const projectDir = await tempProject();
    const responses = ['Updated `answer.js`:\n\n```js\nconsole.log(42);\n```'];
    const requestBodies: unknown[] = [];
    const client = mockClient(responses, requestBodies);

    const confirms: string[] = [];
    await runAgent(client, {
      history: [],
      prompt: 'Create the answer program.',
      projectDir,
      permissionMode: 'default',
      language: 'en',
      events: {
        onText() {},
        onToolStart() {},
        onToolEnd() {},
        async confirm(event) {
          confirms.push(event.tool.name);
          return true;
        },
      },
    });

    expect(confirms).toEqual(['Write']);
    expect(await readFile(path.join(projectDir, 'answer.js'), 'utf-8')).toBe('console.log(42);\n');
    // Assisted code-block writes end the turn: exactly one model request.
    expect(requestBodies).toHaveLength(1);
  });
});
