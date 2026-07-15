import chalk from 'chalk';
import { ACCENT } from '../tui/theme.js';

export interface InlineSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  dim?: boolean;
  underline?: boolean;
}

export type MarkdownBlock =
  | { kind: 'paragraph'; segments: InlineSegment[] }
  | { kind: 'heading'; level: number; segments: InlineSegment[] }
  | { kind: 'code'; lang: string; content: string }
  | { kind: 'list-item'; indent: number; marker: string; segments: InlineSegment[] }
  | { kind: 'quote'; segments: InlineSegment[] }
  | { kind: 'hr' };

/**
 * Weak models sometimes wrap an ENTIRE reply in a ```markdown fence. That
 * hides the real formatting and mangles the pairing of the fences inside
 * it, so strip the wrapper when the fence opens the response. If removing
 * the opener leaves an odd number of fence lines, the trailing bare fence
 * was the wrapper's closer — drop it too.
 */
export function unwrapMarkdownWrapper(text: string): string {
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.trim());
  if (first === -1 || !/^```(?:markdown|md)\s*$/i.test(lines[first].trim())) return text;
  // A wrapper is only a wrapper when other fences nest inside it. A single
  // plain ```markdown block is left intact so the code-block Write fallback
  // can still inspect it (its contents are often mislabelled code).
  const nestedFences = lines
    .slice(first + 1)
    .filter((line) => line.trimStart().startsWith('```')).length;
  if (nestedFences <= 1) return text;
  lines.splice(first, 1);
  const fences = lines.filter((line) => line.trimStart().startsWith('```')).length;
  if (fences % 2 === 1) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      if (lines[i].trim() === '```') lines.splice(i, 1);
      break;
    }
  }
  return lines.join('\n');
}

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/;

interface InlinePattern {
  regex: RegExp;
  style: Partial<InlineSegment>;
  /** Parse the inner text again so `**bold with `code`**` nests. */
  recurse?: boolean;
}

const INLINE_PATTERNS: InlinePattern[] = [
  { regex: /`([^`\n]+)`/, style: { code: true } },
  { regex: /\*\*\*([^*\n]+)\*\*\*/, style: { bold: true, italic: true } },
  { regex: /\*\*([^*]+?)\*\*/, style: { bold: true }, recurse: true },
  { regex: /(?<![\w*])\*([^*\n]+)\*(?!\*)/, style: { italic: true }, recurse: true },
  { regex: /(?<![\w_])_([^_\n]+)_(?![\w_])/, style: { italic: true }, recurse: true },
  { regex: /~~([^~\n]+)~~/, style: { strike: true }, recurse: true },
];

export function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let rest = text;
  while (rest) {
    let earliest: { index: number; length: number; produce: InlineSegment[] } | null = null;
    const link = LINK.exec(rest);
    if (link) {
      earliest = {
        index: link.index,
        length: link[0].length,
        produce: [
          { text: link[1], underline: true },
          { text: ` (${link[2]})`, dim: true },
        ],
      };
    }
    for (const pattern of INLINE_PATTERNS) {
      const match = pattern.regex.exec(rest);
      if (!match || (earliest && match.index >= earliest.index)) continue;
      const produce = pattern.recurse
        ? parseInline(match[1]).map((seg) => ({ ...seg, ...pattern.style }))
        : [{ text: match[1], ...pattern.style }];
      earliest = { index: match.index, length: match[0].length, produce };
    }
    if (!earliest) {
      segments.push({ text: rest });
      break;
    }
    if (earliest.index > 0) segments.push({ text: rest.slice(0, earliest.index) });
    segments.push(...earliest.produce);
    rest = rest.slice(earliest.index + earliest.length);
  }
  return segments.filter((seg) => seg.text);
}

const FENCE_OPEN = /^[ \t]{0,3}```+[ \t]*(\S*)[ \t]*$/;
const FENCE_CLOSE = /^[ \t]{0,3}```+[ \t]*$/;
const HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t#]*$/;
const HR = /^[ \t]{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE = /^[ \t]{0,3}>[ \t]?(.*)$/;
const LIST_ITEM = /^([ \t]*)(?:([-*+])|(\d{1,3})[.)])[ \t]+(.+)$/;

export function parseMarkdown(text: string): MarkdownBlock[] {
  const lines = unwrapMarkdownWrapper(text).split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ kind: 'paragraph', segments: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    blocks.push({ kind: 'quote', segments: parseInline(quote.join('\n')) });
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(FENCE_OPEN);
    if (fence) {
      flushAll();
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      blocks.push({ kind: 'code', lang: fence[1], content: body.join('\n') });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      flushAll();
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        segments: parseInline(heading[2]),
      });
      continue;
    }

    if (HR.test(line)) {
      flushAll();
      blocks.push({ kind: 'hr' });
      continue;
    }

    const quoted = line.match(QUOTE);
    if (quoted) {
      flushParagraph();
      quote.push(quoted[1]);
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item) {
      flushAll();
      const indentWidth = item[1].replaceAll('\t', '  ').length;
      blocks.push({
        kind: 'list-item',
        indent: Math.min(Math.floor(indentWidth / 2), 3),
        marker: item[2] ? '•' : `${item[3]}.`,
        segments: parseInline(item[4]),
      });
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    flushQuote();
    paragraph.push(line);
  }

  flushAll();
  return blocks;
}

function styleAnsi(seg: InlineSegment): string {
  let style = chalk;
  if (seg.code) style = style.hex(ACCENT);
  if (seg.bold) style = style.bold;
  if (seg.italic) style = style.italic;
  if (seg.strike) style = style.strikethrough;
  if (seg.underline) style = style.underline;
  if (seg.dim) style = style.dim;
  return style === chalk ? seg.text : style(seg.text);
}

function segmentsAnsi(segments: InlineSegment[], extra: Partial<InlineSegment> = {}): string {
  return segments.map((seg) => styleAnsi({ ...seg, ...extra })).join('');
}

const GUTTER = '│ ';

function blockAnsi(block: MarkdownBlock): string {
  switch (block.kind) {
    case 'heading': {
      const plain = block.segments.map((seg) => seg.text).join('');
      return block.level <= 2 ? chalk.hex(ACCENT).bold(plain) : chalk.bold(plain);
    }
    case 'code': {
      const rows = [
        ...(block.lang ? [chalk.dim(block.lang)] : []),
        ...block.content.split('\n'),
      ];
      return rows.map((row) => chalk.dim(GUTTER) + row).join('\n');
    }
    case 'list-item':
      return (
        '  '.repeat(block.indent) + chalk.dim(block.marker) + ' ' + segmentsAnsi(block.segments)
      );
    case 'quote':
      return (
        chalk.dim(GUTTER) +
        segmentsAnsi(block.segments, { dim: true, italic: true }).replaceAll(
          '\n',
          `\n${chalk.dim(GUTTER)}`,
        )
      );
    case 'hr':
      return chalk.dim('─'.repeat(30));
    case 'paragraph':
      return segmentsAnsi(block.segments);
  }
}

export interface CodeBlock {
  lang: string;
  content: string;
}

/**
 * The `back`-th most recent non-empty fenced code block across the given
 * texts (1 = newest). Used by /copy so the student gets the raw code
 * without the rendered gutter.
 */
export function latestCodeBlock(texts: string[], back = 1): CodeBlock | null {
  const blocks: CodeBlock[] = [];
  for (const text of texts) {
    for (const block of parseMarkdown(text)) {
      if (block.kind === 'code' && block.content.trim()) {
        blocks.push({ lang: block.lang, content: block.content });
      }
    }
  }
  return blocks[blocks.length - back] ?? null;
}

/** Markdown → ANSI string, for the plain-stdout one-shot mode. */
export function renderMarkdownAnsi(text: string): string {
  const blocks = parseMarkdown(text);
  const parts: string[] = [];
  let prev: MarkdownBlock | null = null;
  for (const block of blocks) {
    const tight = prev?.kind === 'list-item' && block.kind === 'list-item';
    if (prev) parts.push(tight ? '\n' : '\n\n');
    parts.push(blockAnsi(block));
    prev = block;
  }
  return parts.join('');
}
