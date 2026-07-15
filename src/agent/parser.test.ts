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
});

describe('parseToolCalls — plain text', () => {
  it('returns text unchanged with no tool calls', () => {
    const response = 'La funzione calcola la somma di due numeri.';
    const result = parseToolCalls(response);
    expect(result.toolCalls).toEqual([]);
    expect(result.text).toBe(response);
  });
});
