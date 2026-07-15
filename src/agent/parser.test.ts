import { describe, expect, it } from 'vitest';
import { parseToolCalls } from './parser.js';

describe('parseToolCalls — XML layer', () => {
  it('parses a single minerva_tool block', () => {
    const response = `Leggo il file principale.

<minerva_tool name="Read">
<path>src/main.py</path>
</minerva_tool>`;

    const result = parseToolCalls(response);
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ tool: 'Read', args: { path: 'src/main.py' } }),
    ]);
    expect(result.text).toBe('Leggo il file principale.');
  });

  it('parses multiple blocks and preserves surrounding text', () => {
    const response = `Prima leggo, poi cerco.
<minerva_tool name="Read">
<path>a.py</path>
</minerva_tool>
Nel frattempo:
<minerva_tool name="Grep">
<pattern>def main</pattern>
</minerva_tool>`;

    const result = parseToolCalls(response);
    expect(result.toolCalls.map((c) => c.tool)).toEqual(['Read', 'Grep']);
    expect(result.text).toContain('Prima leggo, poi cerco.');
    expect(result.text).toContain('Nel frattempo:');
    expect(result.text).not.toContain('minerva_tool');
  });

  it('keeps multi-line arg content intact (Write with code)', () => {
    const content = 'def main():\n    print("ciao")\n';
    const response = `<minerva_tool name="Write">
<path>hello.py</path>
<content>
${content}</content>
</minerva_tool>`;

    const result = parseToolCalls(response);
    expect(result.toolCalls[0].tool).toBe('Write');
    expect(result.toolCalls[0].args).toEqual({ path: 'hello.py', content });
  });

  it('handles Edit with old_string/new_string', () => {
    const response = `<minerva_tool name="Edit">
<path>main.py</path>
<old_string>x = 1</old_string>
<new_string>x = 2</new_string>
</minerva_tool>`;

    const result = parseToolCalls(response);
    expect(result.toolCalls[0].args).toEqual({
      path: 'main.py',
      old_string: 'x = 1',
      new_string: 'x = 2',
    });
  });
});

describe('parseToolCalls — JSON fallback layer', () => {
  it('parses fenced json blocks when no XML present', () => {
    const response = `Eseguo il test.

\`\`\`json
{"tool": "Bash", "args": {"command": "python -m pytest"}}
\`\`\``;

    const result = parseToolCalls(response);
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ tool: 'Bash', args: { command: 'python -m pytest' } }),
    ]);
    expect(result.text).toBe('Eseguo il test.');
  });

  it('accepts name/arguments key variants', () => {
    const response = '```json\n{"name": "Read", "arguments": {"path": "x.py"}}\n```';
    const result = parseToolCalls(response);
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ tool: 'Read', args: { path: 'x.py' } }),
    ]);
  });

  it('ignores malformed JSON and non-tool JSON blocks', () => {
    const response = '```json\n{not valid\n```\n\n```json\n{"foo": 1}\n```';
    const result = parseToolCalls(response);
    expect(result.toolCalls).toEqual([]);
  });

  it('prefers XML when both layers are present', () => {
    const response = `<minerva_tool name="Read">
<path>a.py</path>
</minerva_tool>
\`\`\`json
{"tool": "Bash", "args": {"command": "rm -rf /"}}
\`\`\``;
    const result = parseToolCalls(response);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe('Read');
  });
});

describe('parseToolCalls — code-block Write heuristic (assisted only)', () => {
  it('applies a trailing fence the model never closed', () => {
    const response =
      'Updated `primes.c`:\n\n```c\n#include <stdio.h>\nint main(void) { return 0; }\n';
    const result = parseToolCalls(response, { codeBlockWriteFallback: true });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        tool: 'Write',
        args: {
          path: 'primes.c',
          content: '#include <stdio.h>\nint main(void) { return 0; }\n',
        },
      }),
    ]);
    expect(result.text).not.toContain('#include');
  });

  it('does not invent content for a fence opened at the very end', () => {
    const response = 'Updated `primes.c`:\n\n```c';
    expect(parseToolCalls(response, { codeBlockWriteFallback: true }).toolCalls).toEqual([]);
  });

  it('flags an auto-closed trailing fence as suspect truncated', () => {
    const truncated =
      'Updated `main.py`:\n\n```python\nnums = [1, 2, 3]\nprint(sorted(nums)\n';
    const complete = 'Updated `main.py`:\n\n```python\nprint("done")\n```';
    expect(
      parseToolCalls(truncated, { codeBlockWriteFallback: true }).suspectTruncated,
    ).toBe(true);
    expect(
      parseToolCalls(complete, { codeBlockWriteFallback: true }).suspectTruncated,
    ).toBe(false);
  });

  it('accepts a destination filename in the fence info string', () => {
    const response = '```primes.c\n#include <stdio.h>\nint main(void) { return 0; }\n```';
    const result = parseToolCalls(response, { codeBlockWriteFallback: true });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        tool: 'Write',
        args: {
          path: 'primes.c',
          content: '#include <stdio.h>\nint main(void) { return 0; }\n',
        },
      }),
    ]);
  });

  it('proposes a Write when a fence is preceded by a filename and heuristic enabled', () => {
    const response = `Ecco la versione corretta di \`utils.py\`:

\`\`\`python
def add(a, b):
    return a + b
\`\`\``;

    const result = parseToolCalls(response, { codeBlockWriteFallback: true });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        tool: 'Write',
        args: { path: 'utils.py', content: 'def add(a, b):\n    return a + b\n' },
      }),
    ]);
  });

  it('finds the filename up to three non-empty lines above the fence', () => {
    const response = `Ecco il contenuto aggiornato di \`utils.py\`:

Il problema era l'operatore sbagliato; ho cambiato \`-\` con \`+\`.

\`\`\`python
x = 1
\`\`\``;

    const result = parseToolCalls(response, { codeBlockWriteFallback: true });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ tool: 'Write', args: { path: 'utils.py', content: 'x = 1\n' } }),
    ]);
  });

  it('does not fire without the flag', () => {
    const response = 'Ecco `utils.py`:\n\n```python\nx = 1\n```';
    expect(parseToolCalls(response).toolCalls).toEqual([]);
  });

  it('does not fire when no filename precedes the fence', () => {
    const response = 'Esempio:\n\n```python\nx = 1\n```';
    expect(parseToolCalls(response, { codeBlockWriteFallback: true }).toolCalls).toEqual([]);
  });

  it('finds the destination filename in prose after the fence', () => {
    const response =
      'Here is the extended script:\n\n```python\nx = 1\n```\n\nPlease copy this into main.py and run it.';
    const result = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      knownFiles: ['main.py'],
    });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ tool: 'Write', args: { path: 'main.py', content: 'x = 1\n' } }),
    ]);
  });

  it('uses a unique relevance-ranked source for a filename-less matching fence', () => {
    const response = 'Here is the fix:\n\n```javascript\nfunction add(a, b) { return a + b; }\n```';
    const result = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      knownFiles: ['src/calc.js', 'test/calc.test.js'],
      preferredFiles: ['src/calc.js'],
    });
    expect(result.toolCalls[0]).toEqual(
      expect.objectContaining({
        tool: 'Write',
        args: { path: 'src/calc.js', content: 'function add(a, b) { return a + b; }\n' },
      }),
    );
  });

  it('does not guess when several preferred files match the fence language', () => {
    const response = '```javascript\nfunction add(a, b) { return a + b; }\n```';
    const result = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      knownFiles: ['src/calc.js', 'src/math.js'],
      preferredFiles: ['src/calc.js', 'src/math.js'],
    });
    expect(result.toolCalls).toEqual([]);
  });

  it('guessPreferredFile proposes the top-ranked match among several (assisted)', () => {
    const response = 'Here is the script:\n\n```python\nprint("hi")\n```';
    const result = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      knownFiles: ['greet.py', 'main.py'],
      preferredFiles: ['greet.py', 'main.py'],
      guessPreferredFile: true,
    });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        tool: 'Write',
        args: { path: 'greet.py', content: 'print("hi")\n' },
      }),
    ]);
  });

  it('guessPreferredFile still requires a mapped fence language', () => {
    const unlabeled = 'Example:\n\n```\nsome output\n```';
    const shell = 'Run:\n\n```bash\npython3 main.py\n```';
    for (const response of [unlabeled, shell]) {
      const result = parseToolCalls(response, {
        codeBlockWriteFallback: true,
        knownFiles: ['greet.py', 'main.py'],
        preferredFiles: ['greet.py', 'main.py'],
        guessPreferredFile: true,
      });
      expect(result.toolCalls).toEqual([]);
    }
  });

  it('fallbackNewFile targets main.py for a filename-less fence in an empty project', () => {
    const response = "Here's a simple script:\n\n```python\nimport datetime\nprint(datetime.date.today())\n```";
    const result = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      knownFiles: [],
      fallbackNewFile: true,
    });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        tool: 'Write',
        args: expect.objectContaining({ path: 'main.py' }),
      }),
    ]);
  });

  it('fallbackNewFile stays out of projects that already have same-language files', () => {
    const response = 'Example:\n\n```python\nx = 1\n```';
    const result = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      knownFiles: ['greet.py', 'README.md'],
      fallbackNewFile: true,
    });
    expect(result.toolCalls).toEqual([]);
  });

  it('fallbackNewFile ignores unlabeled and prose fences', () => {
    for (const response of ['```\nsome text\n```', '```markdown\njust prose\n```']) {
      const result = parseToolCalls(response, {
        codeBlockWriteFallback: true,
        knownFiles: [],
        fallbackNewFile: true,
      });
      expect(result.toolCalls).toEqual([]);
    }
  });

  it('guessPreferredFile applies to code sniffed out of a ```markdown fence', () => {
    const response = '```markdown\nimport math\n\ndef f():\n    return math.pi\n```';
    const result = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      knownFiles: ['greet.py', 'main.py'],
      preferredFiles: ['main.py', 'greet.py'],
      guessPreferredFile: true,
    });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        tool: 'Write',
        args: expect.objectContaining({ path: 'main.py' }),
      }),
    ]);
  });

  it('splits a fence that packs several files behind marker comments', () => {
    const response =
      'Updated `calc.py`:\n\n```python\ndef add(a, b):\n    return a + b\n\n# test_calc.py\nfrom calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n```';
    const result = parseToolCalls(response, { codeBlockWriteFallback: true });
    expect(result.toolCalls).toHaveLength(2);
    const byPath = Object.fromEntries(
      result.toolCalls.map((c) => [c.args.path, c.args.content]),
    );
    expect(byPath['calc.py']).toBe('def add(a, b):\n    return a + b\n');
    expect(byPath['test_calc.py']).toContain('def test_add');
    expect(byPath['calc.py']).not.toContain('test_add');
  });

  it('does not split on descriptive comments that merely mention a file', () => {
    const response =
      'Updated `calc.py`:\n\n```python\ndef add(a, b):\n    # keeps parity with test_calc.py expectations\n    return a + b\n```';
    const result = parseToolCalls(response, { codeBlockWriteFallback: true });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].args.path).toBe('calc.py');
  });

  it('detects a filename marker comment inside the fence and strips it', () => {
    const response = '```python\n# Updated `calc.py`\n\ndef add(a, b):\n    return a + b\n```';
    const result = parseToolCalls(response, { codeBlockWriteFallback: true });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        tool: 'Write',
        args: { path: 'calc.py', content: 'def add(a, b):\n    return a + b\n' },
      }),
    ]);
  });

  it('accepts a decorative block-comment filename header from weaker models', () => {
    const response = '```javascript\n/*** src/calc.js ***/\nexport const add = (a, b) => a + b;\n```';
    const result = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      knownFiles: ['src/calc.js'],
    });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        tool: 'Write',
        args: { path: 'src/calc.js', content: 'export const add = (a, b) => a + b;\n' },
      }),
    ]);
  });

  it('accepts a trailing description after an explicit marker word', () => {
    const response =
      '```python\n# Updated `calc.py`: Remove division by zero error\nx = 1\n```';
    const result = parseToolCalls(response, { codeBlockWriteFallback: true });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ tool: 'Write', args: { path: 'calc.py', content: 'x = 1\n' } }),
    ]);
  });

  it('prefers the inside-fence marker over prose above the fence', () => {
    const response = 'Guarda test_calc.py per i test:\n\n```python\n// file: app.js\nlet x = 1;\n```';
    const result = parseToolCalls(response, { codeBlockWriteFallback: true });
    expect(result.toolCalls[0].args.path).toBe('app.js');
  });

  it('does not treat a descriptive comment as a filename marker', () => {
    const response = 'Updated `calc.py`:\n\n```python\n# This module implements calc.py logic\nx = 1\n```';
    const result = parseToolCalls(response, { codeBlockWriteFallback: true });
    expect(result.toolCalls[0].args).toEqual({
      path: 'calc.py',
      content: '# This module implements calc.py logic\nx = 1\n',
    });
  });

  it('rejects implausible extensions like unittest.main', () => {
    const response = 'Run it via unittest.main as shown:\n\n```python\nimport unittest\n```';
    expect(parseToolCalls(response, { codeBlockWriteFallback: true }).toolCalls).toEqual([]);
  });

  it('skips shell fences even when a filename precedes them', () => {
    const response = 'Poi esegui calc.py così:\n\n```bash\npython3 calc.py\n```';
    expect(parseToolCalls(response, { codeBlockWriteFallback: true }).toolCalls).toEqual([]);
  });

  it('recovers complete C source mislabeled as a shell fence', () => {
    const response = '```sh\n#include <stdio.h>\nint main(void) { return 0; }\n```';
    const result = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      preferredFiles: ['primes.c'],
    });
    expect(result.toolCalls[0]).toEqual(
      expect.objectContaining({
        tool: 'Write',
        args: expect.objectContaining({ path: 'primes.c' }),
      }),
    );
  });

  it('prefers a known project file over other candidates on the same line', () => {
    const response = 'In `helpers.py` c\'è la logica usata da `main.py`:\n\n```python\nx = 1\n```';
    const result = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      knownFiles: ['helpers.py', 'README.md'],
    });
    expect(result.toolCalls[0].args.path).toBe('helpers.py');
  });

  it('maps a bare filename to its unique nested project path', () => {
    const response = 'Updated `config.ts`:\n\n```ts\nexport const x = 1;\n```';
    const result = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      knownFiles: ['src/config.ts', 'src/index.ts'],
    });
    expect(result.toolCalls[0].args.path).toBe('src/config.ts');
  });

  it('rejects a bare filename that matches several project files', () => {
    const response = 'Updated `config.ts`:\n\n```ts\nexport const x = 1;\n```';
    const result = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      knownFiles: ['src/config.ts', 'test/config.ts'],
    });
    expect(result.toolCalls).toEqual([]);
  });

  it('still accepts an explicit nested path when the basename is ambiguous', () => {
    const response = 'Updated `src/config.ts`:\n\n```ts\nexport const x = 1;\n```';
    const result = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      knownFiles: ['src/config.ts', 'test/config.ts'],
    });
    expect(result.toolCalls[0].args.path).toBe('src/config.ts');
  });

  it('unwraps a whole-reply ```markdown wrapper so inner fences pair correctly', () => {
    const response = `\`\`\`markdown
# Count Primes

Updated \`calc.py\`:

\`\`\`python
x = 1
\`\`\`

Let me know if you need anything else!
\`\`\``;
    const result = parseToolCalls(response, { codeBlockWriteFallback: true });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ tool: 'Write', args: { path: 'calc.py', content: 'x = 1\n' } }),
    ]);
    expect(result.text).not.toContain('```markdown');
    expect(result.text).toContain('Let me know');
  });

  it('sniffs code mislabeled as ```markdown and applies it to the unique preferred file', () => {
    const response = `Here's the revised script:

\`\`\`markdown
# Main File Revised – Prints First Twenty Prime Numbers

import math

def is_prime(n):
    return n > 1
\`\`\`
The rest of the repository remains unchanged.`;
    const result = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      knownFiles: ['main.py', 'notes.txt'],
      preferredFiles: ['main.py', 'notes.txt'],
    });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        tool: 'Write',
        args: expect.objectContaining({ path: 'main.py' }),
      }),
    ]);
    expect(result.toolCalls[0].args.content).toContain('import math');
  });

  it('unwraps a nested real fence inside a mid-reply ```markdown wrapper', () => {
    const response = `Here:

\`\`\`markdown
Some intro prose

\`\`\`python
x = 1
\`\`\`
`;
    const result = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      preferredFiles: ['calc.py'],
    });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ tool: 'Write', args: { path: 'calc.py', content: 'x = 1\n' } }),
    ]);
  });

  it('refuses to write markdown prose into a source file', () => {
    const response =
      'Updated `calc.py`:\n\n```markdown\n# Notes\n\nThis explains the fix in prose.\n```';
    expect(parseToolCalls(response, { codeBlockWriteFallback: true }).toolCalls).toEqual([]);
  });

  it('still writes markdown prose into a markdown file', () => {
    const response = 'Updated `NOTES.md`:\n\n```markdown\n# Notes\n\nhello\n```';
    const result = parseToolCalls(response, { codeBlockWriteFallback: true });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        tool: 'Write',
        args: { path: 'NOTES.md', content: '# Notes\n\nhello\n' },
      }),
    ]);
  });

  it('falls through to the code-block layer when XML names only unknown tools', () => {
    const response = `<minerva_tool name="RunTests">
<command>pytest</command>
</minerva_tool>

Updated \`calc.py\`:
\`\`\`python
x = 1
\`\`\``;
    const result = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      knownTools: ['Read', 'Write', 'Bash'],
    });
    expect(result.toolCalls.map((c) => c.tool)).toContain('Write');
    expect(result.text).not.toContain('minerva_tool');
  });
});

describe('parseToolCalls — prose fence bodies are not source files', () => {
  // The exact failure observed live: every ```python fence in a one-file
  // project resolves to main.py, and the 7B model puts INSTRUCTIONS about
  // editing the file inside such fences. Those must never become Writes.
  const opts = {
    codeBlockWriteFallback: true,
    knownFiles: ['main.py'],
    preferredFiles: ['main.py'],
    guessPreferredFile: true,
  };

  it('skips a python fence whose body is prose instructions about the file', () => {
    const response = [
      'let’s simply add the filename on its own line just before the fenced block:',
      '',
      '```python',
      'Updated `main.py`:',
      '',
      "The rest of the script remains unchanged since it doesn't depend on specific lines within the file. Just paste those two lines together wherever you see “Updated” above each section where you would normally write your code.",
      '```',
    ].join('\n');
    expect(parseToolCalls(response, opts).toolCalls).toEqual([]);
  });

  it('skips a python fence holding editor instructions', () => {
    const response = [
      '```python',
      'Then save and exit the editor. Once you run the script again, it should execute without any syntax errors.',
      '```',
    ].join('\n');
    expect(parseToolCalls(response, opts).toolCalls).toEqual([]);
  });

  it('still writes real code whose strings and comments read like prose', () => {
    const response = [
      'Here is the fix:',
      '',
      '```python',
      'nums = input().split()',
      'try:',
      '    nums = [int(i) for i in nums]',
      'except ValueError:',
      '    print("Please enter exactly three numbers.")',
      'total = sum(sorted(nums))',
      'print(total)  # Print the final result',
      '```',
    ].join('\n');
    expect(parseToolCalls(response, opts).toolCalls).toEqual([
      expect.objectContaining({
        tool: 'Write',
        args: expect.objectContaining({ path: 'main.py' }),
      }),
    ]);
  });

  it('keeps a code fence that trails off into one prose sentence', () => {
    const response = [
      '```python',
      'import math',
      '',
      'def is_prime(n):',
      '    return n > 1 and all(n % i for i in range(2, int(math.sqrt(n)) + 1))',
      '',
      'print(is_prime(7))',
      'This fixed syntax error makes the program execute without errors.',
      '```',
    ].join('\n');
    expect(parseToolCalls(response, opts).toolCalls).toEqual([
      expect.objectContaining({
        tool: 'Write',
        args: expect.objectContaining({ path: 'main.py' }),
      }),
    ]);
  });

  it('still allows prose bodies for markdown and plain-text targets', () => {
    const response =
      'Updated `NOTES.md`:\n\n```markdown\nJust some notes about the running project.\n```';
    const result = parseToolCalls(response, { codeBlockWriteFallback: true });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        tool: 'Write',
        args: expect.objectContaining({ path: 'NOTES.md' }),
      }),
    ]);
  });
});

describe('parseToolCalls — plain text', () => {
  it('returns text unchanged with no tool calls', () => {
    const response = 'La funzione calcola la somma di due numeri.';
    const result = parseToolCalls(response);
    expect(result.toolCalls).toEqual([]);
    expect(result.text).toBe(response);
  });
});
