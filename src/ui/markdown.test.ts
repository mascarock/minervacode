import { describe, expect, it } from 'vitest';
import {
  latestCodeBlock,
  parseInline,
  parseMarkdown,
  renderMarkdownAnsi,
  unwrapMarkdownWrapper,
} from './markdown.js';

describe('unwrapMarkdownWrapper', () => {
  it('strips a wrapper fence that spans the whole reply', () => {
    const text = '```markdown\n# Title\n\n```python\nx = 1\n```\nDone!\n```';
    const result = unwrapMarkdownWrapper(text);
    expect(result).not.toContain('```markdown');
    expect(result).toContain('# Title');
    // The inner python fence stays balanced.
    expect(result.match(/```/g)).toHaveLength(2);
  });

  it('strips only the opener when the wrapper was never closed', () => {
    const text = '```markdown\n# Title\n\n```python\nx = 1\n```';
    const result = unwrapMarkdownWrapper(text);
    expect(result).not.toContain('```markdown');
    expect(result).toContain('```python\nx = 1\n```');
  });

  it('leaves a reply without a wrapper untouched', () => {
    const text = 'Prose first.\n\n```markdown\n# doc\n```';
    expect(unwrapMarkdownWrapper(text)).toBe(text);
  });
});

describe('parseMarkdown — blocks', () => {
  it('parses headings with their level', () => {
    expect(parseMarkdown('# Top\n\n### Deep')).toEqual([
      { kind: 'heading', level: 1, segments: [{ text: 'Top' }] },
      { kind: 'heading', level: 3, segments: [{ text: 'Deep' }] },
    ]);
  });

  it('parses a fenced code block with its language', () => {
    const blocks = parseMarkdown('Intro:\n\n```python\ndef f():\n    return 1\n```\nAfter.');
    expect(blocks).toEqual([
      { kind: 'paragraph', segments: [{ text: 'Intro:' }] },
      { kind: 'code', lang: 'python', content: 'def f():\n    return 1' },
      { kind: 'paragraph', segments: [{ text: 'After.' }] },
    ]);
  });

  it('recovers an unclosed trailing fence', () => {
    const blocks = parseMarkdown('```python\nx = 1');
    expect(blocks).toEqual([{ kind: 'code', lang: 'python', content: 'x = 1' }]);
  });

  it('parses bullet and ordered list items with indent', () => {
    const blocks = parseMarkdown('- first\n- second\n  1. nested');
    expect(blocks).toEqual([
      { kind: 'list-item', indent: 0, marker: '•', segments: [{ text: 'first' }] },
      { kind: 'list-item', indent: 0, marker: '•', segments: [{ text: 'second' }] },
      { kind: 'list-item', indent: 1, marker: '1.', segments: [{ text: 'nested' }] },
    ]);
  });

  it('parses quotes and horizontal rules', () => {
    const blocks = parseMarkdown('> quoted line\n\n---');
    expect(blocks).toEqual([
      { kind: 'quote', segments: [{ text: 'quoted line' }] },
      { kind: 'hr' },
    ]);
  });

  it('keeps multi-line paragraphs together', () => {
    const blocks = parseMarkdown('line one\nline two');
    expect(blocks).toEqual([
      { kind: 'paragraph', segments: [{ text: 'line one\nline two' }] },
    ]);
  });
});

describe('parseInline', () => {
  it('parses bold, italic, and inline code', () => {
    expect(parseInline('a **b** *c* `d`')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' ' },
      { text: 'c', italic: true },
      { text: ' ' },
      { text: 'd', code: true },
    ]);
  });

  it('nests inline code inside bold', () => {
    expect(parseInline('**use `is_prime()` here**')).toEqual([
      { text: 'use ', bold: true },
      { text: 'is_prime()', code: true, bold: true },
      { text: ' here', bold: true },
    ]);
  });

  it('does not treat snake_case as italic', () => {
    expect(parseInline('call test_calc_helper now')).toEqual([
      { text: 'call test_calc_helper now' },
    ]);
  });

  it('does not style markers inside inline code', () => {
    expect(parseInline('`a ** b`')).toEqual([{ text: 'a ** b', code: true }]);
  });

  it('renders links as text plus dim url', () => {
    expect(parseInline('see [docs](https://x.dev) now')).toEqual([
      { text: 'see ' },
      { text: 'docs', underline: true },
      { text: ' (https://x.dev)', dim: true },
      { text: ' now' },
    ]);
  });
});

describe('latestCodeBlock', () => {
  const texts = [
    'First reply:\n\n```python\nx = 1\n```',
    'Prose only, no code.',
    'Second reply:\n\n```python\ny = 2\n```\n\nAnd:\n\n```\nz = 3\n```',
  ];

  it('returns the newest block by default', () => {
    expect(latestCodeBlock(texts)).toEqual({ lang: '', content: 'z = 3' });
  });

  it('counts further back with the back parameter', () => {
    expect(latestCodeBlock(texts, 2)).toEqual({ lang: 'python', content: 'y = 2' });
    expect(latestCodeBlock(texts, 3)).toEqual({ lang: 'python', content: 'x = 1' });
  });

  it('returns null when out of range or no code exists', () => {
    expect(latestCodeBlock(texts, 4)).toBeNull();
    expect(latestCodeBlock(['just prose'])).toBeNull();
  });

  it('skips empty code blocks', () => {
    expect(latestCodeBlock(['```python\nx = 1\n```\n\n```\n\n```'])).toEqual({
      lang: 'python',
      content: 'x = 1',
    });
  });
});

describe('renderMarkdownAnsi', () => {
  it('strips markdown syntax from the rendered output', () => {
    const out = renderMarkdownAnsi('# Title\n\nSome **bold** and `code`.\n\n- item');
    expect(out).toContain('Title');
    expect(out).toContain('bold');
    expect(out).not.toContain('# Title');
    expect(out).not.toContain('**');
    expect(out).not.toContain('`');
    expect(out).toContain('• item');
  });

  it('prefixes code lines with a gutter and drops the fences', () => {
    const out = renderMarkdownAnsi('```python\nx = 1\n```');
    expect(out).not.toContain('```');
    expect(out).toContain('│ python');
    expect(out).toContain('│ x = 1');
  });

  it('groups list items tightly and separates other blocks', () => {
    const out = renderMarkdownAnsi('para\n\n- a\n- b');
    expect(out).toContain('para\n\n');
    expect(out).toContain('• a\n• b');
  });
});
