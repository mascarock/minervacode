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
  isBareAffirmation,
  isConversationalRequest,
  requestExplicitSourcePaths,
  requestAllowsNewFile,
  requestExpectsChanges,
  requestAllowsTestEdit,
  requestRequiredDefinitions,
  requestRequiredDefinitionsWithConfidence,
  runAgent,
  runAgentWithModel,
  type AgentEvents,
} from './loop.js';
import type { ModelAdapter, ModelRequest } from '../model/index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sseResponse(text: string): Response {
  const chunk = JSON.stringify({ choices: [{ delta: { content: text } }] });
  return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { status: 200 });
}

async function tempProject(): Promise<string> {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'minervacode-loop-'));
  dirs.push(projectDir);
  return projectDir;
}

function stubClient(postStream: MinervaClient['postStream']): MinervaClient {
  return {
    model: 'test-model',
    postStream,
  } as unknown as MinervaClient;
}

function mockClient(responses: string[], requestBodies: unknown[] = []): MinervaClient {
  return stubClient(async (_path: string, body: unknown) => {
    requestBodies.push(body);
    return sseResponse(responses.shift() ?? 'Done.');
  });
}

/**
 * An adapter with no Minerva anywhere behind it: no MinervaClient, no HTTP,
 * no SSE. Anything that reaches for the provider fails here rather than
 * silently working.
 */
function fakeModel(responses: string[], requests: ModelRequest[] = []): ModelAdapter {
  return {
    id: 'fake',
    model: 'fake-model',
    capabilities: { streaming: false, systemRole: true, toolCalls: false },
    async send(request) {
      // The loop appends to its live message array between turns; the real
      // transport serializes the body on the spot. Snapshot so each recorded
      // request is what was actually sent, not the final state.
      requests.push({ ...request, messages: [...request.messages] });
      return responses.shift() ?? 'Done.';
    },
  };
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

describe('isBareAffirmation', () => {
  it.each(['yes', 'Yes!', 'ok', 'good. write', 'go ahead', 'sì', 'va bene, procedi', 'do it now'])(
    'recognizes: %s',
    (text) => {
      expect(isBareAffirmation(text)).toBe(true);
    },
  );

  it.each([
    'Write a program that sorts three numbers.',
    'yes, but use bubble sort instead',
    'why?',
    'Explain how sorting works.',
    '',
  ])('rejects: %s', (text) => {
    expect(isBareAffirmation(text)).toBe(false);
  });
});

describe('pending intent across turns', () => {
  it('returns the unfulfilled request as pendingIntent when nothing was applied', async () => {
    const projectDir = await tempProject();
    const prompt = 'Python script that asks for the user input of 5 numbers and then it sort';

    const result = await runAgent(mockClient(['Sure, ready when you are.']), {
      history: [],
      prompt,
      projectDir,
      permissionMode: 'default',
      language: 'en',
      events: {
        onText() {},
        onToolStart() {},
        onToolEnd() {},
        async confirm() {
          return true;
        },
      },
    });

    expect(result.pendingIntent).toBe(prompt);
  });

  it('a bare affirmation resumes the stored intent and applies the write', async () => {
    const projectDir = await tempProject();
    const intent = 'Python script that asks for the user input of 5 numbers and then it sort';
    const requestBodies: unknown[] = [];
    // A filename-less python fence: only fallbackNewFile (driven by the
    // ORIGINAL intent, not by "yes") can turn it into main.py.
    const responses = ['```python\nnums = sorted(int(input()) for _ in range(5))\nprint(nums)\n```'];

    const result = await runAgent(mockClient(responses, requestBodies), {
      history: [
        { role: 'user', content: intent },
        { role: 'assistant', content: 'Would you like me to also validate the input?' },
      ],
      prompt: 'yes',
      pendingIntent: intent,
      projectDir,
      permissionMode: 'default',
      language: 'en',
      events: {
        onText() {},
        onToolStart() {},
        onToolEnd() {},
        async confirm() {
          return true;
        },
      },
    });

    expect(existsSync(path.join(projectDir, 'main.py'))).toBe(true);
    expect(JSON.stringify(requestBodies[0])).toContain('5 numbers');
    expect(result.pendingIntent).toBeNull();
  });

  it('clears pendingIntent after a successful change', async () => {
    const projectDir = await tempProject();
    const result = await runAgent(
      mockClient(['Updated `main.py`:\n\n```python\nprint("hi")\n```']),
      {
        history: [],
        prompt: 'Write me a program that prints hi.',
        projectDir,
        permissionMode: 'default',
        language: 'en',
        events: {
          onText() {},
          onToolStart() {},
          onToolEnd() {},
          async confirm() {
            return true;
          },
        },
      },
    );
    expect(result.pendingIntent).toBeNull();
  });
});

describe('semantic false-success guard (t07-style)', () => {
  it('does not report a degenerate prime sequence as verified', async () => {
    const projectDir = await tempProject();
    // Broken generator: resets num=2 every iteration → appends 2 forever.
    const broken = [
      'primes = []',
      'while len(primes) < 20:',
      '    num = 2',
      '    while True:',
      '        primes.append(num)',
      '        break',
      'print(primes)',
      '',
    ].join('\n');
    const responses = [
      `Updated \`main.py\`:\n\n\`\`\`python\n${broken}\`\`\``,
      'It prints twenty 2s.',
      'Still the same.',
      'Cannot fix.',
    ];
    const result = await runAgent(mockClient(responses), {
      history: [],
      prompt: 'Write main.py that prints the first 20 prime numbers.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    // The program runs and prints, but it must NOT be reported verified.
    expect(result.verified).not.toBe(true);
  }, 30_000);
});

describe('semantic false-success guard (t03-style)', () => {
  it('does not verify a program that reads one number instead of three', async () => {
    const projectDir = await tempProject();
    const broken = [
      'numbers = []',
      'while True:',
      '    numbers.append(int(input("Numero: ")))',
      '    break',
      'print("Il più piccolo è", min(numbers))',
      '',
    ].join('\n');
    const responses = [
      `Updated \`main.py\`:\n\n\`\`\`python\n${broken}\`\`\``,
      'It reads one number.',
      'Still the same.',
      'Cannot fix.',
    ];
    const result = await runAgent(mockClient(responses), {
      history: [],
      prompt:
        "Chiedi all'utente di inserire tre numeri, dopodiché verifica qual è il più piccolo e sommali.",
      projectDir,
      permissionMode: 'dontAsk',
      language: 'it',
      events: autoEvents(),
    });

    expect(result.verified).not.toBe(true);
  }, 30_000);
});

describe('no-op write breaker', () => {
  const identicalWrite = (content: string) =>
    `<minerva_tool name="Write">\n<path>main.py</path>\n<content>\n${content}</content>\n</minerva_tool>`;

  it('tells the model a Write changed nothing and stops after three no-ops', async () => {
    const projectDir = await tempProject();
    const content = 'print("hi")\n';
    await writeFile(path.join(projectDir, 'main.py'), content);

    const requestBodies: unknown[] = [];
    // The model re-sends the exact current file contents forever.
    const responses = Array.from({ length: 8 }, () => identicalWrite(content));
    const statuses: string[] = [];
    const events = autoEvents();
    events.onStatus = (text) => statuses.push(text);

    await runAgent(mockClient(responses, requestBodies), {
      history: [],
      prompt: 'Fix main.py so it prints hi.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events,
    });

    // Feedback: the model is told the write was a no-op…
    expect(JSON.stringify(requestBodies)).toContain('No change: main.py already contains');
    // …and the run stops instead of burning all 20 turns.
    expect(requestBodies.length).toBeLessThanOrEqual(4);
    expect(statuses.some((s) => s.startsWith('⚠') && /identical/i.test(s))).toBe(true);
  });

  it('a real change resets the no-op counter', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'main.py'), 'print("a")\n');

    const responses = [
      identicalWrite('print("a")\n'),
      identicalWrite('print("a")\n'),
      identicalWrite('print("b")\n'), // real change — counter resets
      'Done. The file now prints b.',
    ];
    const statuses: string[] = [];
    const events = autoEvents();
    events.onStatus = (text) => statuses.push(text);

    const result = await runAgent(mockClient(responses), {
      history: [],
      prompt: 'Fix main.py so it prints b.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events,
    });

    expect(statuses.some((s) => s.startsWith('⚠') && /identical/i.test(s))).toBe(false);
    expect(result.changes.length).toBeGreaterThan(0);
  });
});

describe('identical verification error three-strike stop', () => {
  const brokenWrite = (comment: string) =>
    `<minerva_tool name="Write">\n<path>main.py</path>\n<content>\nraise ValueError("boom")  # ${comment}\n</content>\n</minerva_tool>`;

  it('stops after the same verification error three times despite file changes', async () => {
    const projectDir = await tempProject();
    // Each attempt changes the file (new comment) but fails identically.
    const responses = [
      brokenWrite('v1'),
      brokenWrite('v2'),
      brokenWrite('v3'),
      brokenWrite('v4'),
      brokenWrite('v5'),
      'Giving up.',
    ];
    const statuses: string[] = [];
    const events = autoEvents();
    events.onStatus = (text) => statuses.push(text);

    const result = await runAgent(mockClient(responses), {
      history: [],
      prompt: 'Write me a program that prints ok.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events,
    });

    const verifyRuns = statuses.filter((s) => s.startsWith('Verifying changes')).length;
    expect(verifyRuns).toBeLessThanOrEqual(3);
    expect(statuses.some((s) => s.startsWith('⚠') && /identical error/i.test(s))).toBe(true);
    expect(result.status).toBe('requirements-unmet');
  }, 60_000);
});

describe('truncated fence handling', () => {
  it('auto mode refuses a truncated Write once and applies the resent complete file', async () => {
    const projectDir = await tempProject();
    const responses = [
      // Generation cut off mid-file: the fence never closes.
      'Updated `main.py`:\n\n```python\nprint("part one")\n',
      'Updated `main.py`:\n\n```python\nprint("part one")\nprint("part two")\n```',
    ];
    const requestBodies: unknown[] = [];

    await runAgent(mockClient(responses, requestBodies), {
      history: [],
      prompt: 'Write me a program that prints two parts.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(await readFile(path.join(projectDir, 'main.py'), 'utf-8')).toBe(
      'print("part one")\nprint("part two")\n',
    );
    expect(JSON.stringify(requestBodies)).toContain('cut off');
  });

  it('assisted mode warns about a truncated Write but leaves the student in charge', async () => {
    const projectDir = await tempProject();
    const responses = ['Updated `main.py`:\n\n```python\nprint("half a progr\n'];
    const statuses: string[] = [];

    await runAgent(mockClient(responses), {
      history: [],
      prompt: 'Write me a program that prints something.',
      projectDir,
      permissionMode: 'default',
      language: 'en',
      events: {
        onText() {},
        onToolStart() {},
        onToolEnd() {},
        onStatus: (text) => statuses.push(text),
        async confirm() {
          return true;
        },
      },
    });

    expect(statuses.some((s) => s.startsWith('⚠') && /cut off|incomplete/i.test(s))).toBe(true);
    expect(existsSync(path.join(projectDir, 'main.py'))).toBe(true);
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
    const client = stubClient(async () => {
      throw new Error('upstream unavailable');
    });

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

  it('uses a compact, file-grounded prompt for a failed autonomous repair', async () => {
    const projectDir = await tempProject();
    const requestBodies: unknown[] = [];
    const responses = [
      'Updated `answer.py`:\n\n```python\nprint(missing_name)\n```',
      'Updated `answer.py`:\n\n```python\nprint("fixed")\n```',
      'Done.',
    ];

    const result = await runAgent(mockClient(responses, requestBodies), {
      history: [],
      prompt: 'Create answer.py that prints fixed and run it.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      review: false,
      events: autoEvents(),
    });

    const repairRequest = JSON.stringify(requestBodies[1]);
    expect(repairRequest).toContain('Return exactly one complete replacement file');
    expect(repairRequest).toContain('print(missing_name)');
    expect(repairRequest).not.toContain('Use the tools below to read files');
    expect(result.status).toBe('completed');
    expect(result.verified).toBe(true);
  });

  it('does not leak Python input-probe implementation into a repair prompt', async () => {
    const projectDir = await tempProject();
    const requestBodies: unknown[] = [];
    const responses = [
      'Updated `main.py`:\n\n```python\nprint(missing_name)\n```',
      'Updated `main.py`:\n\n```python\nprint(sum(map(int, input().split())))\n```',
      'Done.',
    ];

    const result = await runAgent(mockClient(responses, requestBodies), {
      history: [],
      prompt: 'Create main.py, ask the user for three integers, print their sum, and run it.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      review: false,
      events: autoEvents(),
    });

    const repairRequest = JSON.stringify(requestBodies[1]);
    expect(repairRequest).toContain("python3 -m py_compile 'main.py' && python3 - 'main.py'");
    expect(repairRequest).not.toContain('class ProbeInput(str)');
    expect(await readFile(path.join(projectDir, 'main.py'), 'utf-8')).toContain('sum(map(int');
    expect(result.verified).toBe(true);
    expect(result.verification?.command).toContain('…');
    expect(result.verification?.command).not.toContain('class ProbeInput');
  });

  it('allows a file created this run to be rewritten when its path spelling changes', async () => {
    const projectDir = await tempProject();
    const responses = [
      'Updated `./main.py`:\n\n```python\ndef obsolete():\n    return 0\n\nprint(missing_name)\n```',
      'Updated `main.py`:\n\n```python\nprint("fixed")\n```',
      'Done.',
    ];

    const result = await runAgent(mockClient(responses), {
      history: [],
      prompt: 'Create main.py that prints fixed and run it.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      review: false,
      events: autoEvents(),
    });

    expect(await readFile(path.join(projectDir, 'main.py'), 'utf-8')).toBe('print("fixed")\n');
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

  it('feeds a failing initial test run into the first model request', { timeout: 20_000 }, async () => {
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
    const client = stubClient(async () => {
      calls++;
      if (calls === 1) {
        return sseResponse('Updated `answer.js`:\n\n```js\nconsole.log(42);\n```');
      }
      if (calls === 2) return sseResponse('Done.');
      throw new Error('review service unavailable');
    });

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
    const client = stubClient(async () => {
      calls++;
      if (calls === 1) throw new Error('Model response timed out after 60000ms');
      return sseResponse(
        calls === 2 ? 'Updated `calc.py`:\n\n```python\nx = 2\n```' : 'Done.',
      );
    });

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
    // Each version verifies green so the budget is spent on PASSING runs.
    const responses = Array.from(
      { length: MAX_VERIFY_RUNS + 1 },
      (_, i) => `Updated \`calc.py\`:\n\n\`\`\`python\nx = ${i + 2}\nprint(x)\n\`\`\``,
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
      `x = ${MAX_VERIFY_RUNS + 2}\nprint(x)\n`,
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

  it('warns immediately when an assisted code-block write has a syntax error', async () => {
    const projectDir = await tempProject();
    // `finally` without a colon — the file the model proposes is broken.
    const responses = [
      'Updated `main.py`:\n\n```python\ntry:\n    print("hi")\nfinally\n    print("done")\n```',
    ];
    const requestBodies: unknown[] = [];
    const statuses: string[] = [];

    await runAgent(mockClient(responses, requestBodies), {
      history: [],
      prompt: 'Write me a program that prints hi.',
      projectDir,
      permissionMode: 'default',
      language: 'en',
      events: {
        onText() {},
        onToolStart() {},
        onToolEnd() {},
        onStatus: (text) => statuses.push(text),
        async confirm() {
          return true;
        },
      },
    });

    expect(statuses.some((s) => s.startsWith('⚠') && /syntax/i.test(s))).toBe(true);
    // Advisory only: no extra model round-trips in assisted mode.
    expect(requestBodies).toHaveLength(1);
  });

  it('warns about a possibly undefined name after an assisted write', async () => {
    const projectDir = await tempProject();
    // Syntactically valid, crashes at runtime: comprehension binds I, loads i.
    const responses = [
      'Updated `main.py`:\n\n```python\nnums = input().split()\nnums = [int(i) for I in nums]\nprint(nums)\n```',
    ];
    const statuses: string[] = [];

    await runAgent(mockClient(responses), {
      history: [],
      prompt: 'Write me a program that reads numbers and prints them.',
      projectDir,
      permissionMode: 'default',
      language: 'en',
      events: {
        onText() {},
        onToolStart() {},
        onToolEnd() {},
        onStatus: (text) => statuses.push(text),
        async confirm() {
          return true;
        },
      },
    });

    expect(statuses.some((s) => s.startsWith('⚠') && /undefined name/i.test(s))).toBe(true);
  });

  it('stays quiet when an assisted code-block write compiles cleanly', async () => {
    const projectDir = await tempProject();
    const responses = ['Updated `main.py`:\n\n```python\nprint("hi")\n```'];
    const statuses: string[] = [];

    await runAgent(mockClient(responses), {
      history: [],
      prompt: 'Write me a program that prints hi.',
      projectDir,
      permissionMode: 'default',
      language: 'en',
      events: {
        onText() {},
        onToolStart() {},
        onToolEnd() {},
        onStatus: (text) => statuses.push(text),
        async confirm() {
          return true;
        },
      },
    });

    expect(statuses.filter((s) => s.startsWith('⚠'))).toEqual([]);
  });

  it('scrubs stale assistant code fences from history before calling the model', async () => {
    const projectDir = await tempProject();
    const requestBodies: unknown[] = [];
    const responses = ['Updated `main.py`:\n\n```python\nnums = sorted(int(input()) for _ in range(3))\nprint(sum(nums))\n```'];

    await runAgent(mockClient(responses, requestBodies), {
      history: [
        { role: 'user', content: 'Print the first 3 primes.' },
        {
          role: 'assistant',
          content: 'Here you go:\n\n```python\ndef is_prime(n):\n    return n > 1\n\nprint(is_prime(7))\n```',
        },
        { role: 'user', content: 'thanks' },
        { role: 'assistant', content: 'You are welcome!' },
      ],
      prompt: 'Now write a program that asks for three numbers, sorts them and prints the sum.',
      projectDir,
      permissionMode: 'default',
      language: 'en',
      events: {
        onText() {},
        onToolStart() {},
        onToolEnd() {},
        async confirm() {
          return true;
        },
      },
    });

    expect(JSON.stringify(requestBodies[0])).not.toContain('is_prime');
  });

  it('nudges once when the model stalls with a question instead of acting', async () => {
    const projectDir = await tempProject();
    const responses = [
      'Great! Just one more thing to ensure everything works smoothly: let’s include a quick check at the end to see if the user actually entered five distinct integers. Would you like me to add that?',
      'Updated `main.py`:\n\n```python\nnums = sorted(int(input()) for _ in range(5))\nprint(nums)\n```',
    ];
    const requestBodies: unknown[] = [];

    await runAgent(mockClient(responses, requestBodies), {
      history: [],
      prompt: 'Python script that asks for the user input of 5 numbers and then it sort',
      projectDir,
      permissionMode: 'default',
      language: 'en',
      events: {
        onText() {},
        onToolStart() {},
        onToolEnd() {},
        async confirm() {
          return true;
        },
      },
    });

    expect(requestBodies).toHaveLength(2);
    expect(existsSync(path.join(projectDir, 'main.py'))).toBe(true);
  });

  it('does not fight questions on informational requests', async () => {
    const projectDir = await tempProject();
    const requestBodies: unknown[] = [];

    await runAgent(
      mockClient(['Do you mean the built-in sorted() function?'], requestBodies),
      {
        history: [],
        prompt: 'Explain how sorting works in Python.',
        projectDir,
        permissionMode: 'default',
        language: 'en',
        events: {
          onText() {},
          onToolStart() {},
          onToolEnd() {},
          async confirm() {
            return true;
          },
        },
      },
    );

    expect(requestBodies).toHaveLength(1);
  });

  it('nudges once when the model returns a generic refusal', async () => {
    const projectDir = await tempProject();
    const responses = [
      "I'm sorry, but I am unable to fulfill this request.",
      'Updated `main.py`:\n\n```python\nnums = sorted(int(input()) for _ in range(5))\nprint(nums)\n```',
    ];
    const requestBodies: unknown[] = [];

    await runAgent(mockClient(responses, requestBodies), {
      history: [],
      prompt: 'Python script that asks for the user input of 5 numbers and then it sort',
      projectDir,
      permissionMode: 'default',
      language: 'en',
      events: {
        onText() {},
        onToolStart() {},
        onToolEnd() {},
        async confirm() {
          return true;
        },
      },
    });

    expect(requestBodies).toHaveLength(2);
    expect(JSON.stringify(requestBodies[1])).toContain('I could not apply anything');
    expect(existsSync(path.join(projectDir, 'main.py'))).toBe(true);
  });

  it('stops after one structural nudge when the model still produces no action', async () => {
    const projectDir = await tempProject();
    const requestBodies: unknown[] = [];
    const statuses: string[] = [];

    const result = await runAgent(
      mockClient(
        [
          "I'm sorry, but I am unable to fulfill this request.",
          'Sorry, I cannot help with that request.',
        ],
        requestBodies,
      ),
      {
        history: [],
        prompt: 'Write a Python script that asks for numbers and prints their square roots.',
        projectDir,
        permissionMode: 'default',
        language: 'en',
        events: {
          onText() {},
          onToolStart() {},
          onToolEnd() {},
          onStatus: (text) => statuses.push(text),
          async confirm() {
            return true;
          },
        },
      },
    );

    expect(requestBodies).toHaveLength(2);
    expect(result.status).toBe('no-change');
    expect(statuses.at(-1)).toContain('no applicable change');
    expect(existsSync(path.join(projectDir, 'main.py'))).toBe(false);
  });

  it('nudges once when the model emits code without fences', async () => {
    const projectDir = await tempProject();
    const responses = [
      'Sure thing—let’s proceed step‐by‐step.\n\nFunction definition – get_sorted()\n\ndef get_sorted(numbers):\n    """Returns a sorted list."""\n    return sorted(numbers)\n\nNow you can simply call get_sorted() with a list of five integers.',
      'Updated `main.py`:\n\n```python\nnums = sorted(int(input()) for _ in range(5))\nprint(nums)\n```',
    ];
    const requestBodies: unknown[] = [];

    await runAgent(mockClient(responses, requestBodies), {
      history: [],
      prompt: 'Python script that asks for the user input of 5 numbers and then it sort',
      projectDir,
      permissionMode: 'default',
      language: 'en',
      events: {
        onText() {},
        onToolStart() {},
        onToolEnd() {},
        async confirm() {
          return true;
        },
      },
    });

    expect(requestBodies).toHaveLength(2);
    expect(existsSync(path.join(projectDir, 'main.py'))).toBe(true);
  });
});

describe('requestRequiredDefinitions (prose parentheticals)', () => {
  it('ignores nouns followed by a parenthetical remark', () => {
    // Both observed live: an otherwise-correct run failed "requirements-unmet".
    expect(
      requestRequiredDefinitions(
        'Write Fibonacci.java, a Java program that prints the first 10 Fibonacci numbers (starting 0 1) separated by spaces on one line. Compile and run it to show the output.',
      ),
    ).toEqual([]);
    expect(
      requestRequiredDefinitions(
        'Contatore.java dovrebbe stampare 5 (le vocali di "universita") ma stampa 4. Trova il bug e correggilo.',
      ),
    ).toEqual([]);
  });

  it('still extracts calls with literal or list arguments', () => {
    expect(
      requestRequiredDefinitions(
        'Create stats.py with a function median(numbers) and print median([3, 1, 4, 1, 5]).',
      ),
    ).toEqual(['median']);
    expect(requestRequiredDefinitions('Print gcd(12, 18) and factorial(5).')).toEqual([
      'gcd',
      'factorial',
    ]);
  });

  it('ignores bilingual glosses but honours definition cues with spaces', () => {
    expect(
      requestRequiredDefinitions('Calcola la media(average) di tre numeri e stampala.'),
    ).toEqual([]);
    expect(
      requestRequiredDefinitions('Stampa i numeri in ordine crescente(ascending) fino a 20.'),
    ).toEqual([]);
    expect(
      requestRequiredDefinitions(
        'Scrivi una funzione somma (a, b) che restituisce la somma dei due numeri.',
      ),
    ).toEqual(['somma']);
    expect(requestRequiredDefinitions('Add a function is_prime (n) to utils.py.')).toEqual([
      'is_prime',
    ]);
  });
});

describe('isConversationalRequest', () => {
  const fileless = ['archive.tgz', 'foto.png'];

  it('routes chat-like messages in a contentless directory to plain chat', () => {
    expect(isConversationalRequest('Quanto fa 2+2?', fileless)).toBe(true);
    expect(isConversationalRequest('Rispondi solo con il risultato di 2+2', fileless)).toBe(true);
    expect(isConversationalRequest('Spiega la ricorsione', fileless)).toBe(true);
    expect(isConversationalRequest('Ciao, come stai?', fileless)).toBe(true);
  });

  it('keeps anything project- or code-referential on the agent path', () => {
    expect(
      isConversationalRequest("C'è un bug in utils.py: trovalo e correggilo.", fileless),
    ).toBe(false);
    expect(isConversationalRequest('Explain this project', fileless)).toBe(false);
    expect(isConversationalRequest('Run the program', fileless)).toBe(false);
    expect(isConversationalRequest('Write primes.cpp and run it', fileless)).toBe(false);
    expect(isConversationalRequest('Spiega il codice', fileless)).toBe(false);
    // Question-phrased creation requests defeat the change-verb gate but
    // must still reach the agent (observed adversarial probe).
    expect(
      isConversationalRequest('Perché non crei tu un piccolo gioco in Python e lo salvi qui?', fileless),
    ).toBe(false);
    expect(
      isConversationalRequest('What about creating a small quiz in Python and saving it here?', fileless),
    ).toBe(false);
    expect(
      requestExpectsChanges('Perché non crei tu un piccolo gioco in Python e lo salvi qui?'),
    ).toBe(true);
    expect(
      requestExpectsChanges('What about creating a small quiz in Python and saving it here?'),
    ).toBe(true);
  });

  it('never routes to chat when the directory has content files', () => {
    expect(isConversationalRequest('Quanto fa 2+2?', ['calc.py'])).toBe(false);
    expect(isConversationalRequest('Count x up.', ['calc.py'])).toBe(false);
    expect(isConversationalRequest('Inspect validateToken in auth.', ['auth.ts'])).toBe(false);
    // Web and notes directories count as content too.
    expect(
      isConversationalRequest('Perché la mia pagina è tutta blu?', ['index.html', 'style.css']),
    ).toBe(false);
    expect(isConversationalRequest('Summarize my notes', ['notes.txt'])).toBe(false);
  });
});

describe('conversational light chat routing', () => {
  it('answers without the agent scaffold or repository map', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'archive.tgz'), 'not-content\n');
    const requestBodies: unknown[] = [];
    const texts: string[] = [];
    const events = autoEvents();
    events.onText = (t) => texts.push(t);

    const result = await runAgent(mockClient(['4'], requestBodies), {
      history: [],
      prompt: 'Quanto fa 2+2?',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'auto',
      events,
    });

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('4');
    expect(result.changes).toEqual([]);
    expect(texts).toEqual(['4']);
    const first = JSON.stringify(requestBodies[0]);
    expect(first).not.toContain('Repository map');
    expect(first).not.toContain('minerva_tool');
    expect(first).not.toContain('programming agent');
    // History persists the student's words, not the injected persona.
    expect(result.history.at(-2)).toEqual({ role: 'user', content: 'Quanto fa 2+2?' });
  });

  it('still injects the agent scaffold on the first agent turn after light chat', async () => {
    const projectDir = await tempProject();
    const chat = await runAgent(mockClient(['4']), {
      history: [],
      prompt: 'Quanto fa 2+2?',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'auto',
      events: autoEvents(),
    });
    expect(chat.status).toBe('completed');

    await writeFile(path.join(projectDir, 'calc.py'), 'x = 1\n');
    const requestBodies: unknown[] = [];
    await runAgent(mockClient(['Done.'], requestBodies), {
      history: chat.history,
      prompt: 'Set x to 2 in calc.py.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });
    // The chat turn left history non-empty; instruction injection must key
    // on content, or the model never learns the tool protocol.
    expect(JSON.stringify(requestBodies[0])).toContain('You are Minerva, a programming agent');
  });

  it('acts on a question-phrased creation request instead of treating it as chat', async () => {
    const projectDir = await tempProject();
    const requestBodies: unknown[] = [];
    const write = 'Updated `quiz.py`:\n\n```python\nprint("quiz")\n```';

    const result = await runAgent(
      mockClient(['Would you like me to create it?', write, 'Done.'], requestBodies),
      {
        history: [],
        prompt: 'What about creating a small quiz in Python and saving it here?',
        projectDir,
        permissionMode: 'dontAsk',
        language: 'en',
        events: autoEvents(),
        review: false,
      },
    );

    expect(result.status).toBe('completed');
    expect(existsSync(path.join(projectDir, 'quiz.py'))).toBe(true);
    expect(requestBodies.length).toBeGreaterThan(1);
  });
});

describe('web search reporting', () => {
  it('warns honestly when the server ignores the web-search request', async () => {
    const projectDir = await tempProject();
    const client = stubClient(async () => sseResponse('4'));
    const statuses: string[] = [];
    const events = autoEvents();
    events.onStatus = (text) => statuses.push(text);

    const result = await runAgent(client, {
      history: [],
      prompt: 'Quanto fa 2+2?',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      webSearch: true,
      events,
    });

    expect(result.status).toBe('completed');
    expect(
      statuses.some((s) => s.startsWith('⚠') && /web search/i.test(s) && /no sources/i.test(s)),
    ).toBe(true);
  });

  it('reports the sources Open WebUI actually used', async () => {
    const projectDir = await tempProject();
    const client = stubClient(async () => {
      const sourcesChunk = JSON.stringify({
        sources: [{ source: { urls: ['https://example.com/docs'] } }],
      });
      const textChunk = JSON.stringify({ choices: [{ delta: { content: 'It is 4.' } }] });
      return new Response(`data: ${sourcesChunk}\n\ndata: ${textChunk}\n\ndata: [DONE]\n\n`, {
        status: 200,
      });
    });
    const statuses: string[] = [];
    const events = autoEvents();
    events.onStatus = (text) => statuses.push(text);

    const result = await runAgent(client, {
      history: [],
      prompt: 'Quanto fa 2+2?',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      webSearch: true,
      events,
    });

    expect(result.status).toBe('completed');
    expect(statuses.some((s) => s.includes('🔎') && s.includes('https://example.com/docs'))).toBe(
      true,
    );
  });

  it('says nothing about search when it was never requested', async () => {
    const projectDir = await tempProject();
    const client = mockClient(['4']);
    const statuses: string[] = [];
    const events = autoEvents();
    events.onStatus = (text) => statuses.push(text);

    await runAgent(client, {
      history: [],
      prompt: 'Quanto fa 2+2?',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events,
    });

    expect(statuses.some((s) => /web search/i.test(s))).toBe(false);
  });
});

describe('repeated refusal bail-out', () => {
  it('stops after the same guardrail refuses three times', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'calc.py'), 'def add(a, b):\n    return a - b\n');
    const badWrite =
      '<minerva_tool name="Write">\n<path>helper.py</path>\n<content>\nprint(1)\n</content>\n</minerva_tool>';
    const statuses: string[] = [];
    const events = autoEvents();
    events.onStatus = (t) => statuses.push(t);
    const requestBodies: unknown[] = [];

    const result = await runAgent(
      mockClient([badWrite, badWrite, badWrite, badWrite, badWrite], requestBodies),
      {
        history: [],
        prompt: 'Fix the bug in calc.py.',
        projectDir,
        permissionMode: 'dontAsk',
        language: 'en',
        events,
      },
    );

    expect(result.status).toBe('requirements-unmet');
    expect(statuses.some((s) => s.includes('refused 3 times'))).toBe(true);
    // 3 refusals, not the full turn budget.
    expect(requestBodies.length).toBe(3);
    expect(existsSync(path.join(projectDir, 'helper.py'))).toBe(false);
  });
});

describe('unverifiable execution request', () => {
  it('never reports success when a run request had no applicable verifier', async () => {
    const projectDir = await tempProject();
    await writeFile(
      path.join(projectDir, 'main.go'),
      'package main\n\nfunc main() { println(41) }\n',
    );
    const fixWrite =
      '<minerva_tool name="Write">\n<path>main.go</path>\n<content>\npackage main\n\nfunc main() { println(42) }\n</content>\n</minerva_tool>';
    const statuses: string[] = [];
    const events = autoEvents();
    events.onStatus = (t) => statuses.push(t);

    const result = await runAgent(mockClient([fixWrite, 'Done.']), {
      history: [],
      prompt: 'Fix main.go and run it to show the output.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events,
    });

    expect(result.verified).toBe(false);
    expect(statuses.some((s) => s.includes('UNVERIFIED'))).toBe(true);
  });

  it('does not let an unrelated passing package test stand in for running the program', async () => {
    const projectDir = await tempProject();
    await writeFile(
      path.join(projectDir, 'main.go'),
      'package main\n\nfunc main() { println(41) }\n',
    );
    await writeFile(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
    );
    const fixWrite =
      '<minerva_tool name="Write">\n<path>main.go</path>\n<content>\npackage main\n\nfunc main() { println(42) }\n</content>\n</minerva_tool>';
    const statuses: string[] = [];
    const events = autoEvents();
    events.onStatus = (text) => statuses.push(text);

    const result = await runAgent(mockClient([fixWrite, 'Done.']), {
      history: [],
      prompt: 'Fix main.go and run it to show the output.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events,
      review: false,
    });

    expect(result.verification).toMatchObject({ source: 'package.json test script', ok: true });
    expect(result.verified).toBe(false);
    expect(statuses.some((s) => s.includes('no command actually executed main.go'))).toBe(true);
  });
});

describe('required-definition confidence policy', () => {
  it('does not reject a verified result over a definition only inferred from prose', async () => {
    const projectDir = await tempProject();
    const statuses: string[] = [];
    const events = autoEvents();
    events.onStatus = (text) => statuses.push(text);
    // "area(5)" is bare call syntax with no definition cue: prose writes
    // examples this way, so it must not be able to fail an otherwise
    // verified run.
    const responses = [
      'Updated `main.py`:\n\n```python\nprint(78.5)\n```',
      'Done.',
      'Done.',
      'Done.',
    ];

    const result = await runAgent(mockClient(responses), {
      history: [],
      prompt: 'Write main.py that prints the result of area(5).',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      review: false,
      events,
    });

    expect(requestRequiredDefinitionsWithConfidence(
      'Write main.py that prints the result of area(5).',
    )).toEqual([{ name: 'area', confidence: 'likely' }]);
    expect(result.status).toBe('completed');
    expect(result.verified).toBe(true);
    // The student is still told, without the run being thrown away.
    expect(statuses.some((s) => s.includes('area'))).toBe(true);
  });

  it('still fails when an explicitly requested function is never defined', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'utils.py'), 'def double(n):\n    return n * 2\n');
    const responses = [
      'Updated `utils.py`:\n\n```python\ndef double(n):\n    return n * 2\n```',
      'Done.',
      'Done.',
      'Done.',
    ];

    const result = await runAgent(mockClient(responses), {
      history: [],
      prompt: 'Add a function is_even(n) to utils.py that returns True for even numbers.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      review: false,
      events: autoEvents(),
    });

    expect(result.status).toBe('requirements-unmet');
  });
});

describe('guard-keyed refusal bail-out', () => {
  it('stops when one guardrail refuses three times across different paths', async () => {
    const projectDir = await tempProject();
    await writeFile(path.join(projectDir, 'calc.py'), 'def add(a, b):\n    return a - b\n');
    const write = (file: string) =>
      `<minerva_tool name="Write">\n<path>${file}</path>\n<content>\nprint(1)\n</content>\n</minerva_tool>`;
    const statuses: string[] = [];
    const events = autoEvents();
    events.onStatus = (text) => statuses.push(text);
    const requestBodies: unknown[] = [];

    // Same guard every time, a different filename every time. Counting the
    // refusal TEXT would never reach three, letting the model spin to the
    // turn limit by cycling names.
    const result = await runAgent(
      mockClient(
        [write('a.py'), write('b.py'), write('c.py'), write('d.py'), write('e.py')],
        requestBodies,
      ),
      {
        history: [],
        prompt: 'Fix the bug in calc.py.',
        projectDir,
        permissionMode: 'dontAsk',
        language: 'en',
        events,
      },
    );

    expect(result.status).toBe('requirements-unmet');
    expect(statuses.some((s) => s.includes('refused 3 times'))).toBe(true);
    expect(requestBodies.length).toBe(3);
    for (const file of ['a.py', 'b.py', 'c.py']) {
      expect(existsSync(path.join(projectDir, file))).toBe(false);
    }
  });
});

describe('provider independence', () => {
  it('runs the whole agent core on a non-Minerva adapter', async () => {
    const projectDir = await tempProject();
    const requests: ModelRequest[] = [];
    const model = fakeModel(
      [
        'Creating it now.\n<minerva_tool name="Write">\n<path>answer.js</path>\n<content>\nconsole.log(42);\n</content>\n</minerva_tool>',
        'Implemented and verified successfully.',
        'LGTM', // advisory review
      ],
      requests,
    );
    const texts: string[] = [];

    const result = await runAgentWithModel(model, {
      history: [],
      prompt: 'Create the answer program.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: { ...autoEvents(), onText: (text) => texts.push(text) },
    });

    expect(await readFile(path.join(projectDir, 'answer.js'), 'utf-8')).toBe('console.log(42);\n');
    expect(result.changes.map((c) => c.path)).toEqual(['answer.js']);
    expect(result.status).toBe('completed');
    expect(result.verified).toBe(true);
    // Tool blocks are stripped from the visible text, as on the client path.
    expect(texts[0]).toBe('Creating it now.');
    expect(texts.join('\n')).not.toContain('minerva_tool');
  });

  it('sends the agent instructions, the request, and verification results to the adapter', async () => {
    const projectDir = await tempProject();
    const requests: ModelRequest[] = [];
    const model = fakeModel(
      [
        'Updated `answer.js`:\n\n```js\nconsole.log(42);\n```',
        'Done.',
        'LGTM',
      ],
      requests,
    );

    await runAgentWithModel(model, {
      history: [],
      prompt: 'Create the answer program.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(requests).toHaveLength(3);
    // request 1: agent instructions plus the student's request.
    expect(requests[0].messages[0].content).toContain('You are Minerva, a programming agent');
    expect(requests[0].messages.at(-1)?.content).toContain('Create the answer program.');
    // request 2: the harness verification result the model must act on.
    const second = requests[1].messages.at(-1)?.content ?? '';
    expect(second).toContain('node --check');
    expect(second).toContain('Verification passed');
  });

  it('keeps the advisory review on the same adapter', async () => {
    const projectDir = await tempProject();
    const requests: ModelRequest[] = [];
    const model = fakeModel(
      [
        'Updated `answer.js`:\n\n```js\nconsole.log(42);\n```',
        'Done.',
        '[BUG] answer.js — prints 41 instead of 42',
      ],
      requests,
    );
    const texts: string[] = [];
    const statuses: string[] = [];

    await runAgentWithModel(model, {
      history: [],
      prompt: 'Create the answer program.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: {
        ...autoEvents(),
        onText: (text) => texts.push(text),
        onStatus: (text) => statuses.push(text),
      },
    });

    // The review is a fresh one-shot conversation on the SAME adapter — a
    // non-Minerva run must not fall back to a Minerva client to review itself.
    const review = requests[2];
    expect(review.messages).toHaveLength(1);
    expect(review.messages[0].content).toContain("reviewing a student's code change");
    expect(texts.at(-1)).toContain('[BUG] answer.js');
    expect(statuses.at(-1)).toContain('advisory review');
    // Advisory only: the verified file is left exactly as applied.
    expect(await readFile(path.join(projectDir, 'answer.js'), 'utf-8')).toBe('console.log(42);\n');
  });

  it('runs a light chat turn through the adapter', async () => {
    const projectDir = await tempProject();
    const requests: ModelRequest[] = [];
    const result = await runAgentWithModel(fakeModel(['4'], requests), {
      history: [],
      prompt: 'quanto fa 2+2?',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'auto',
      events: autoEvents(),
    });

    expect(result.finalText).toBe('4');
    expect(requests[0].messages.at(-1)?.content).toContain('quanto fa 2+2?');
    // The persona wrapper is not persisted — history keeps the student's words.
    expect(result.history.at(-2)).toEqual({ role: 'user', content: 'quanto fa 2+2?' });
  });

  it('surfaces adapter failures as a model-error without a client', async () => {
    const projectDir = await tempProject();
    const model: ModelAdapter = {
      ...fakeModel([]),
      async send() {
        throw new Error('adapter exploded');
      },
    };

    const result = await runAgentWithModel(model, {
      history: [],
      prompt: 'Create the answer program.',
      projectDir,
      permissionMode: 'dontAsk',
      language: 'en',
      events: autoEvents(),
    });

    expect(result.status).toBe('model-error');
    expect(result.finalText).toContain('adapter exploded');
  });
});
