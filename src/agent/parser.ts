export type ToolCallSource = 'xml' | 'json' | 'codeblock';

export interface ParsedToolCall {
  tool: string;
  args: Record<string, unknown>;
  /** Original block text, used to strip the call from the visible response. */
  raw: string;
  /** Which parser layer produced the call. */
  source: ToolCallSource;
}

export interface ParseResult {
  toolCalls: ParsedToolCall[];
  /** Model response with tool blocks removed. */
  text: string;
}

export interface ParseOptions {
  /**
   * Assisted-only fallback: treat a fenced code block preceded by a filename
   * as a Write proposal when the model emitted no structured tool calls.
   */
  codeBlockWriteFallback?: boolean;
  /** Existing project paths, used to validate code-block filename guesses. */
  knownFiles?: string[];
  /** Registered tool names. XML blocks naming only unknown tools do not
   * suppress the JSON and code-block fallback layers. */
  knownTools?: string[];
}

const XML_BLOCK = /<minerva_tool\s+name="([^"]+)"\s*>([\s\S]*?)<\/minerva_tool>/g;
const XML_ARG = /<(\w+)>([\s\S]*?)<\/\1>/g;
const JSON_BLOCK = /```json\s*\n([\s\S]*?)```/g;
const CODE_BLOCK = /```(\w*)[^\S\n]*\n([\s\S]*?)```/g;
const FILENAME = /([\w./-]+\.[A-Za-z0-9]{1,6})/g;

/**
 * A comment line that names a file, e.g. `# Updated calc.py`, `// file:
 * app.js`, `<!-- index.html -->`. Weak models often put the filename inside
 * the fence instead of above it. Trailing description text is allowed only
 * after an explicit marker word ("Updated calc.py: removed the bug"), so a
 * comment that merely mentions a file does not count.
 */
const COMMENT_PREFIX = /^(?:#|\/\/|--|;+|\/\*|<!--)\s*/;
const MARKER_BARE = /^[`'"]?([\w./-]+\.[A-Za-z0-9]{1,6})[`'"]?\s*(?:\*\/|-->)?\s*:?\s*$/;
const MARKER_WORDED = /^(?:updated?|new file|file(?:name)?|path)\b[\s:]*[`'"]?([\w./-]+\.[A-Za-z0-9]{1,6})[`'"]?/i;

/** Fence languages that hold commands or output, not file contents. */
const NON_FILE_LANGS = new Set([
  'bash',
  'sh',
  'shell',
  'zsh',
  'console',
  'terminal',
  'text',
  'output',
  'diff',
]);

/** Extensions a Write proposal may plausibly target. */
const WRITABLE_EXTENSIONS = new Set([
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'md', 'txt', 'html',
  'css', 'scss', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb',
  'php', 'swift', 'kt', 'sql', 'sh', 'bash', 'yml', 'yaml', 'toml', 'ini',
  'cfg', 'xml', 'csv', 'r', 'lua', 'pl', 'dart', 'vue', 'svelte', 'tex',
]);

/** Fields where inner whitespace is meaningful and must not be trimmed. */
const RAW_FIELDS = new Set(['content', 'old_string', 'new_string']);

function parseXmlArgs(inner: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const match of inner.matchAll(XML_ARG)) {
    const [, key, rawValue] = match;
    if (RAW_FIELDS.has(key)) {
      // Models put the value on its own line; drop only the newline that
      // follows the opening tag, everything else is verbatim.
      args[key] = rawValue.startsWith('\n') ? rawValue.slice(1) : rawValue;
    } else {
      args[key] = rawValue.trim();
    }
  }
  return args;
}

function parseXmlLayer(response: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  for (const match of response.matchAll(XML_BLOCK)) {
    const [raw, name, inner] = match;
    calls.push({ tool: name, args: parseXmlArgs(inner), raw, source: 'xml' });
  }
  return calls;
}

function parseJsonLayer(response: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  for (const match of response.matchAll(JSON_BLOCK)) {
    const [raw, body] = match;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const tool = parsed.tool ?? parsed.name;
      const args = parsed.args ?? parsed.arguments;
      if (typeof tool === 'string' && args && typeof args === 'object') {
        calls.push({ tool, args: args as Record<string, unknown>, raw, source: 'json' });
      }
    } catch {
      // not a tool call — leave it in the visible text
    }
  }
  return calls;
}

function isKnownFile(name: string, knownFiles?: string[]): boolean {
  return !!knownFiles?.some((f) => f === name || f.endsWith(`/${name}`));
}

/**
 * Maps a bare filename to its unique project path (`calc.py` →
 * `src/calc.py`). Returns null when the name matches several project files
 * — writing to a guessed root path would silently target the wrong file.
 */
function canonicalKnownPath(name: string, knownFiles?: string[]): string | null {
  if (!knownFiles || knownFiles.includes(name)) return name;
  const matches = knownFiles.filter((f) => f.endsWith(`/${name}`));
  if (matches.length > 1) return null;
  return matches.length === 1 ? matches[0] : name;
}

function isWritablePath(name: string, knownFiles?: string[]): boolean {
  if (isKnownFile(name, knownFiles)) return true;
  const ext = name.split('.').at(-1)?.toLowerCase() ?? '';
  return WRITABLE_EXTENSIONS.has(ext);
}

/** Picks the best filename candidate from a line: known files win. */
function pickFilename(line: string, knownFiles?: string[]): string | undefined {
  const candidates = [...line.matchAll(FILENAME)].map((m) => m[1]);
  return (
    candidates.findLast((c) => isKnownFile(c, knownFiles)) ??
    candidates.findLast((c) => isWritablePath(c, knownFiles))
  );
}

/**
 * Detects a filename marker comment on the fence's first line and returns
 * the content with the marker stripped.
 */
function filenameInsideFence(
  content: string,
  knownFiles?: string[],
): { path: string; content: string } | null {
  const newline = content.indexOf('\n');
  const firstLine = (newline === -1 ? content : content.slice(0, newline)).trim();
  const prefix = firstLine.match(COMMENT_PREFIX);
  if (!prefix) return null;
  const comment = firstLine.slice(prefix[0].length);
  const match = comment.match(MARKER_BARE) ?? comment.match(MARKER_WORDED);
  if (!match || !isWritablePath(match[1], knownFiles)) return null;
  const rest = newline === -1 ? '' : content.slice(newline + 1);
  return { path: match[1], content: rest.replace(/^\n/, '') };
}

function parseCodeBlockLayer(response: string, knownFiles?: string[]): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  for (const match of response.matchAll(CODE_BLOCK)) {
    const [raw, lang, content] = match;
    const index = match.index ?? 0;
    const before = response.slice(0, index).trimEnd();
    // The filename usually sits right above the fence, but weaker models
    // often slip an explanation sentence in between — scan a few lines back.
    const lines = before.split('\n').filter((l) => l.trim()).slice(-3).reverse();
    let path: string | undefined;
    for (const line of lines) {
      path = pickFilename(line, knownFiles);
      if (path) break;
    }

    // Weak models also put the filename inside the fence as a leading
    // comment — that marker is more specific than prose above the fence.
    const inside = filenameInsideFence(content, knownFiles);
    let body = content;
    if (inside) {
      path = inside.path;
      body = inside.content;
    }

    if (!path) continue;
    // Shell/output fences hold commands, not file contents.
    if (NON_FILE_LANGS.has(lang.toLowerCase()) && !/\.(sh|bash)$/.test(path)) continue;

    const canonical = canonicalKnownPath(path, knownFiles);
    if (canonical === null) continue; // ambiguous — let the nudge ask for a full path

    calls.push({
      tool: 'Write',
      args: { path: canonical, content: body },
      raw,
      source: 'codeblock',
    });
  }
  return calls;
}

export function parseToolCalls(response: string, options: ParseOptions = {}): ParseResult {
  const knowsTool = (name: string) =>
    !options.knownTools || options.knownTools.some((t) => t.toLowerCase() === name.toLowerCase());

  let calls = parseXmlLayer(response);
  // XML blocks that only name hallucinated tools must not shadow the
  // fallback layers — but still strip them from the visible text.
  const junk = calls.filter((c) => !knowsTool(c.tool));
  if (calls.length && junk.length === calls.length) calls = [];
  if (!calls.length) calls = parseJsonLayer(response);
  if (!calls.length && options.codeBlockWriteFallback) {
    calls = parseCodeBlockLayer(response, options.knownFiles);
    calls.push(...junk.map((c) => ({ ...c, args: {} })));
  }

  let text = response;
  for (const call of calls) {
    text = text.replace(call.raw, '');
  }
  text = text.replaceAll(/\n{3,}/g, '\n\n').trim();

  return { toolCalls: calls, text };
}
