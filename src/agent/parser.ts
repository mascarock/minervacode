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
}

const XML_BLOCK = /<minerva_tool\s+name="([^"]+)"\s*>([\s\S]*?)<\/minerva_tool>/g;
const XML_ARG = /<(\w+)>([\s\S]*?)<\/\1>/g;
const JSON_BLOCK = /```json\s*\n([\s\S]*?)```/g;
const CODE_BLOCK = /```\w*\n([\s\S]*?)```/g;
const FILENAME = /([\w./-]+\.[A-Za-z0-9]{1,6})/g;

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

function parseCodeBlockLayer(response: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  for (const match of response.matchAll(CODE_BLOCK)) {
    const [raw, content] = match;
    const index = match.index ?? 0;
    const before = response.slice(0, index).trimEnd();
    // The filename usually sits right above the fence, but weaker models
    // often slip an explanation sentence in between — scan a few lines back.
    const lines = before.split('\n').filter((l) => l.trim()).slice(-3).reverse();
    let path: string | undefined;
    for (const line of lines) {
      const filenames = [...line.matchAll(FILENAME)];
      path = filenames.at(-1)?.[1];
      if (path) break;
    }
    if (path) {
      calls.push({ tool: 'Write', args: { path, content }, raw, source: 'codeblock' });
    }
  }
  return calls;
}

export function parseToolCalls(response: string, options: ParseOptions = {}): ParseResult {
  let calls = parseXmlLayer(response);
  if (!calls.length) calls = parseJsonLayer(response);
  if (!calls.length && options.codeBlockWriteFallback) {
    calls = parseCodeBlockLayer(response);
  }

  let text = response;
  for (const call of calls) {
    text = text.replace(call.raw, '');
  }
  text = text.replaceAll(/\n{3,}/g, '\n\n').trim();

  return { toolCalls: calls, text };
}
