import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MinervaClient } from '../api/client.js';
import { requestAllowsTestEdit, runAgent, type AgentEvents } from './loop.js';

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

describe('autonomous agent loop', () => {
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

  it('feeds review BUG findings back for a fix cycle', async () => {
    const projectDir = await tempProject();
    const responses = [
      'Updated `answer.js`:\n\n```js\nconsole.log(41);\n```',
      'Done.',
      '[BUG] answer.js — prints 41 instead of 42', // review
      'Updated `answer.js`:\n\n```js\nconsole.log(42);\n```', // fix cycle
      'Fixed.',
    ];
    const client = mockClient(responses);

    const result = await runAgent(client, {
      history: [],
      prompt: 'Print 42.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(await readFile(path.join(projectDir, 'answer.js'), 'utf-8')).toBe('console.log(42);\n');
    // Only one review pass: two Write changes, no second review request.
    expect(result.changes).toHaveLength(2);
    expect(result.finalText).toBe('Fixed.');
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
    // Three verified writes exhaust the verify budget; the fourth change
    // can no longer be checked, so the run must not report verified=true.
    const responses = [
      'Updated `calc.py`:\n\n```python\nx = 2\n```',
      'Updated `calc.py`:\n\n```python\nx = 3\n```',
      'Updated `calc.py`:\n\n```python\nx = 4\n```',
      'Updated `calc.py`:\n\n```python\nx = 5\n```',
      'Done.',
      'LGTM',
    ];
    const client = mockClient(responses);

    const result = await runAgent(client, {
      history: [],
      prompt: 'Count x up.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(await readFile(path.join(projectDir, 'calc.py'), 'utf-8')).toBe('x = 5\n');
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
