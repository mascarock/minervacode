import { unwrapMarkdownWrapper } from '../ui/markdown.js';

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
  /** Unique relevance-ranked source candidates for filename-less code fences. */
  preferredFiles?: string[];
  /**
   * Assisted-only: when several preferred files match a filename-less fence
   * with a KNOWN language, propose the top relevance-ranked one instead of
   * giving up — the student approves or denies every proposed Write, so a
   * wrong guess costs one keypress while no guess dead-ends the request.
   */
  guessPreferredFile?: boolean;
  /**
   * When a filename-less fence has a KNOWN language and the project contains
   * no file of that language, target a conventional new file (main.py,
   * main.c, …). Without this, the model's first — often best — reply is
   * dropped in an empty project and the retry is usually worse.
   */
  fallbackNewFile?: boolean;
  /** Registered tool names. XML blocks naming only unknown tools do not
   * suppress the JSON and code-block fallback layers. */
  knownTools?: string[];
}

const XML_BLOCK = /<minerva_tool\s+name="([^"]+)"\s*>([\s\S]*?)<\/minerva_tool>/g;
const XML_ARG = /<(\w+)>([\s\S]*?)<\/\1>/g;
const JSON_BLOCK = /```json\s*\n([\s\S]*?)```/g;
// The closing fence must be a bare ``` on its own line — otherwise a nested
// fence opener (```python inside a ```markdown wrapper) ends the block early
// and the content between two real blocks gets parsed as a third one.
const CODE_BLOCK = /```([^\s`]*)[^\S\n]*\n([\s\S]*?)^[ \t]{0,3}```[^\S\n]*$/gm;
const FILENAME = /([\w./-]+\.[A-Za-z0-9]{1,6})/g;

/**
 * A comment line that names a file, e.g. `# Updated calc.py`, `// file:
 * app.js`, `<!-- index.html -->`. Weak models often put the filename inside
 * the fence instead of above it. Trailing description text is allowed only
 * after an explicit marker word ("Updated calc.py: removed the bug"), so a
 * comment that merely mentions a file does not count.
 */
const COMMENT_PREFIX = /^(?:#|\/\/|--|;+|\/\*+|<!--)\s*/;
const MARKER_BARE = /^[`'"]?([\w./-]+\.[A-Za-z0-9]{1,6})[`'"]?\s*(?:\*+\/|-->)?\s*:?\s*$/;
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

/** A comment line that is ONLY a filename marker (e.g. `# test_calc.py`). */
function bareFilenameMarker(line: string, knownFiles?: string[]): string | null {
  const prefix = line.trim().match(COMMENT_PREFIX);
  if (!prefix) return null;
  const match = line.trim().slice(prefix[0].length).match(MARKER_BARE);
  if (!match || !isWritablePath(match[1], knownFiles)) return null;
  return match[1];
}

/**
 * Weak models pack several files into ONE fence, separated by bare
 * filename-marker comments (`# test_calc.py`). Split them so each file
 * gets its own Write instead of everything merging into the first file.
 */
function splitMultiFileFence(
  body: string,
  knownFiles?: string[],
): Array<{ path?: string; body: string }> {
  const lines = body.split('\n');
  const segments: Array<{ path?: string; lines: string[] }> = [{ lines: [] }];
  for (let i = 0; i < lines.length; i++) {
    const marker = i > 0 ? bareFilenameMarker(lines[i], knownFiles) : null;
    if (marker) {
      segments.push({ path: marker, lines: [] });
    } else {
      segments[segments.length - 1].lines.push(lines[i]);
    }
  }
  return segments
    .map((seg) => ({ path: seg.path, body: seg.lines.join('\n').replace(/^\n+/, '') }))
    .filter((seg) => seg.body.trim() || seg.path === undefined);
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

const LANGUAGE_EXTENSIONS: Record<string, Set<string>> = {
  javascript: new Set(['js', 'mjs', 'cjs', 'jsx']),
  js: new Set(['js', 'mjs', 'cjs', 'jsx']),
  typescript: new Set(['ts', 'mts', 'cts', 'tsx']),
  ts: new Set(['ts', 'mts', 'cts', 'tsx']),
  python: new Set(['py']),
  py: new Set(['py']),
  java: new Set(['java']),
  go: new Set(['go']),
  rust: new Set(['rs']),
  c: new Set(['c', 'h']),
  cpp: new Set(['cpp', 'cc', 'cxx', 'hpp', 'h']),
  html: new Set(['html']),
  css: new Set(['css', 'scss']),
  markdown: new Set(['md', 'markdown']),
  md: new Set(['md', 'markdown']),
};

/**
 * Guesses the language of code the model mislabeled as ```markdown. Weak
 * models use that label as a generic wrapper around real file contents.
 * Only unambiguous structural signals count; prose returns null.
 */
function sniffCodeLanguage(content: string): string | null {
  if (
    /^\s*(?:def\s+\w+\s*\(|class\s+\w+\s*[:(]|from\s+[\w.]+\s+import\s|import\s+[\w.]+(?:\s*,\s*[\w.]+)*\s*$)/m.test(
      content,
    )
  ) {
    return 'python';
  }
  if (/^\s*#include\s*[<"]/m.test(content)) return 'c';
  if (/\b(?:public|private)\s+(?:static\s+)?(?:class|void|int|String)\b/.test(content)) {
    return 'java';
  }
  if (/^\s*(?:package\s+main\b|func\s+\w+\s*\()/m.test(content)) return 'go';
  if (
    /^\s*(?:export\s+(?:default\s+)?\w+|const\s+\w+\s*=|let\s+\w+\s*=|function\s+\w+\s*\()/m.test(
      content,
    )
  ) {
    return 'javascript';
  }
  return null;
}

function uniquePreferredPath(
  lang: string,
  preferredFiles?: string[],
  guess = false,
): string | undefined {
  if (!preferredFiles?.length) return undefined;
  const extensions = LANGUAGE_EXTENSIONS[lang.toLowerCase()];
  const candidates = preferredFiles.filter((file) => {
    if (!extensions || !lang) return true;
    return extensions.has(file.split('.').at(-1)?.toLowerCase() ?? '');
  });
  if (candidates.length === 1) return candidates[0];
  // Guessing requires a mapped fence language so an unlabeled snippet of
  // shell commands or prose is never proposed as source-file contents.
  if (guess && extensions && candidates.length) return candidates[0];
  return undefined;
}

/** Conventional filename for a new file in an otherwise empty project. */
const DEFAULT_NEW_FILE: Record<string, string> = {
  python: 'main.py',
  py: 'main.py',
  c: 'main.c',
  cpp: 'main.cpp',
  javascript: 'main.js',
  js: 'main.js',
  typescript: 'main.ts',
  ts: 'main.ts',
  java: 'Main.java',
  go: 'main.go',
  rust: 'main.rs',
};

function defaultNewFilePath(lang: string, knownFiles?: string[]): string | undefined {
  const name = DEFAULT_NEW_FILE[lang.toLowerCase()];
  if (!name) return undefined;
  const extensions = LANGUAGE_EXTENSIONS[lang.toLowerCase()];
  // Only when the project has no file of this language — otherwise the
  // preferred-file logic owns the decision and a stray main.py would just
  // shadow the student's real entry point.
  const hasSameLanguageFile = knownFiles?.some((file) =>
    extensions?.has(file.split('.').at(-1)?.toLowerCase() ?? ''),
  );
  return hasSameLanguageFile ? undefined : name;
}

function parseCodeBlockLayer(
  response: string,
  knownFiles?: string[],
  preferredFiles?: string[],
  guessPreferredFile = false,
  fallbackNewFile = false,
): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  for (const match of response.matchAll(CODE_BLOCK)) {
    const [raw, info, fenced] = match;
    let lang = info;
    let content = fenced;
    let markdownProse = false;
    // ```markdown is usually a wrapper around real content, not a request
    // to write a .md file: unwrap a nested fence, or sniff the language.
    if (/^(?:markdown|md)$/i.test(info)) {
      const nested = content.match(/(?:^|\n)```([^\s`]*)[^\S\n]*\n([\s\S]*)$/);
      if (nested) {
        lang = nested[1];
        content = nested[2];
      } else {
        const sniffed = sniffCodeLanguage(content);
        if (sniffed) lang = sniffed;
        else markdownProse = true;
      }
    }
    const index = match.index ?? 0;
    const before = response.slice(0, index).trimEnd();
    // The filename usually sits right above the fence, but weaker models
    // often slip an explanation sentence in between — scan a few lines back.
    const lines = before.split('\n').filter((l) => l.trim()).slice(-3).reverse();
    let path: string | undefined;
    // Small models often put the destination filename in the fence info
    // string (` ```primes.c `) instead of a language (` ```c `). Treat that
    // explicit path as stronger than nearby prose and infer the language from
    // its extension for shell-fence and preferred-file checks below.
    if (info.includes('.') && isWritablePath(info, knownFiles)) {
      path = info;
      lang = info.split('.').at(-1) ?? '';
    }
    for (const line of lines) {
      if (path) break;
      path = pickFilename(line, knownFiles);
      if (path) break;
    }
    // Weak models often name the destination only AFTER the code ("Copy
    // this into main.py") — scan a few lines below the fence too.
    if (!path) {
      const after = response
        .slice(index + raw.length)
        .split('\n')
        .filter((l) => l.trim() && !l.trimStart().startsWith('```'))
        .slice(0, 3);
      for (const line of after) {
        path = pickFilename(line, knownFiles);
        if (path) break;
      }
    }

    // Weak models also put the filename inside the fence as a leading
    // comment — that marker is more specific than prose above the fence.
    const inside = filenameInsideFence(content, knownFiles);
    let body = content;
    if (inside) {
      path = inside.path;
      body = inside.content;
    }

    // One fence, several files: emit later marker-separated segments as
    // their own Writes; the first segment continues the normal path logic.
    const segments = splitMultiFileFence(body, knownFiles);
    if (segments.length > 1) {
      body = segments[0].body;
      for (const seg of segments.slice(1)) {
        const canonicalSeg = canonicalKnownPath(seg.path!, knownFiles);
        if (canonicalSeg === null) continue;
        calls.push({
          tool: 'Write',
          args: { path: canonicalSeg, content: seg.body },
          raw: '',
          source: 'codeblock',
        });
      }
      if (!body.trim()) continue;
    }

    // If relevance ranking found exactly one matching non-test source file,
    // a filename-less implementation fence is unambiguous. This is kept out
    // of the generic known-file list so two same-language files still nudge.
    path ??= uniquePreferredPath(lang, preferredFiles, guessPreferredFile);

    // Empty/new project: give the first reply's code a conventional home
    // instead of dropping it and hoping the nudged retry names a file.
    if (!path && fallbackNewFile && !markdownProse) {
      path = defaultNewFilePath(lang, knownFiles);
    }

    if (!path) continue;
    // Markdown prose only ever belongs in markdown/plain-text files.
    if (markdownProse && !/\.(?:md|markdown|txt)$/i.test(path)) continue;
    // Shell/output fences hold commands, not file contents.
    const mislabeledCSource =
      /\.(?:c|cc|cpp|cxx)$/i.test(path) &&
      /^\s*#include\s*[<"][^>"\n]+[>"]/m.test(body) &&
      /\b(?:int|void)\s+main\s*\(/s.test(body);
    if (
      NON_FILE_LANGS.has(lang.toLowerCase()) &&
      !/\.(sh|bash)$/.test(path) &&
      !mislabeledCSource
    ) continue;

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

/**
 * Closes a trailing fence the model never closed (it stopped generating or
 * rambled off). Without this the final — often only — code block is lost.
 */
function closeUnfinishedFence(response: string): string {
  const delimiters = response.match(/```/g)?.length ?? 0;
  if (delimiters % 2 === 0) return response;
  // Only a fence that actually started content can be closed meaningfully.
  const last = response.lastIndexOf('```');
  if (!response.slice(last).includes('\n')) return response;
  return `${response.replace(/\n?$/, '\n')}\`\`\``;
}

export function parseToolCalls(response: string, options: ParseOptions = {}): ParseResult {
  const knowsTool = (name: string) =>
    !options.knownTools || options.knownTools.some((t) => t.toLowerCase() === name.toLowerCase());

  response = closeUnfinishedFence(unwrapMarkdownWrapper(response));
  let calls = parseXmlLayer(response);
  // XML blocks that only name hallucinated tools must not shadow the
  // fallback layers — but still strip them from the visible text.
  const junk = calls.filter((c) => !knowsTool(c.tool));
  if (calls.length && junk.length === calls.length) calls = [];
  if (!calls.length) calls = parseJsonLayer(response);
  if (!calls.length && options.codeBlockWriteFallback) {
    calls = parseCodeBlockLayer(
      response,
      options.knownFiles,
      options.preferredFiles,
      options.guessPreferredFile,
      options.fallbackNewFile,
    );
    calls.push(...junk.map((c) => ({ ...c, args: {} })));
  }

  let text = response;
  for (const call of calls) {
    text = text.replace(call.raw, '');
  }
  text = text.replaceAll(/\n{3,}/g, '\n\n').trim();

  return { toolCalls: calls, text };
}
