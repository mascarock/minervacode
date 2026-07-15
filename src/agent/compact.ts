import type { ChatMessage } from '../types.js';

/** Minerva-7B supports 16,384 tokens; reserve roughly 4k for its response. */
export const MODEL_CONTEXT_TOKENS = 16_384;
export const INPUT_CONTEXT_BUDGET_TOKENS = 12_000;
export const DEFAULT_RECENT_MESSAGES = 6;

const CHARS_PER_TOKEN = 4;
const SUCCESS_RESULT_CHARS = 900;
const ERROR_RESULT_CHARS = 4_000;
const AGGRESSIVE_ERROR_CHARS = 2_000;

export interface ContextStats {
  messages: number;
  characters: number;
  estimatedTokens: number;
  budgetTokens: number;
  utilization: number;
  compactedMessages: number;
}

export interface CompactOptions {
  maxEstimatedTokens?: number;
  keepRecentMessages?: number;
}

export interface CompactResult {
  messages: ChatMessage[];
  before: ContextStats;
  after: ContextStats;
  compacted: boolean;
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function getContextStats(
  messages: ChatMessage[],
  budgetTokens = INPUT_CONTEXT_BUDGET_TOKENS,
): ContextStats {
  const characters = messages.reduce((total, message) => total + message.content.length, 0);
  // Four tokens per chat envelope is a small but useful approximation.
  const estimatedTokens = Math.ceil(characters / CHARS_PER_TOKEN) + messages.length * 4;
  return {
    messages: messages.length,
    characters,
    estimatedTokens,
    budgetTokens,
    utilization: budgetTokens ? estimatedTokens / budgetTokens : 0,
    compactedMessages: messages.filter((message) => message.content.includes('[Older ')).length,
  };
}

function clampWithTail(text: string, maxChars: number, marker: string): string {
  if (text.length <= maxChars) return text;
  const markerText = `\n[… ${text.length - maxChars} characters ${marker} …]\n`;
  const available = Math.max(0, maxChars - markerText.length);
  const head = Math.ceil(available * 0.65);
  const tail = available - head;
  return `${text.slice(0, head)}${markerText}${tail ? text.slice(-tail) : ''}`;
}

function compactToolResults(content: string, aggressive: boolean): string {
  return content.replace(
    /<tool_result name="([^"]+)" status="(ok|error)">\n?([\s\S]*?)\n?<\/tool_result>/g,
    (whole, name: string, status: string, result: string) => {
      const maxChars = status === 'error'
        ? aggressive
          ? AGGRESSIVE_ERROR_CHARS
          : ERROR_RESULT_CHARS
        : SUCCESS_RESULT_CHARS;
      if (result.length <= maxChars) return whole;
      if (status === 'ok') {
        return `<tool_result name="${name}" status="ok">\n[Older successful ${name} result omitted: ${result.length} characters. Re-run the tool if needed.]\n</tool_result>`;
      }
      return `<tool_result name="${name}" status="error">\n${clampWithTail(result, maxChars, 'omitted from older error output')}\n</tool_result>`;
    },
  );
}

function tagValue(body: string, tag: string): string | null {
  const match = body.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`));
  return match?.[1]?.trim() ?? null;
}

function compactToolCalls(content: string): string {
  return content.replace(
    /<minerva_tool name="([^"]+)">([\s\S]*?)<\/minerva_tool>/g,
    (_whole, name: string, body: string) => {
      const path = tagValue(body, 'path');
      const command = tagValue(body, 'command');
      const detail = path
        ? ` path=${JSON.stringify(path)}`
        : command
          ? ` command=${JSON.stringify(clampWithTail(command, 160, 'omitted'))}`
          : '';
      return `<minerva_tool name="${name}">[Older ${name} call payload omitted${detail}.]</minerva_tool>`;
    },
  );
}

function compactCodeFences(content: string): string {
  return content.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_whole, language: string, code: string) => {
    const label = language.trim() ? ` ${language.trim()}` : '';
    return `\`\`\`${label}\n[Older code proposal omitted: ${code.length} characters; read the current file for authoritative contents.]\n\`\`\``;
  });
}

function compactBulk(content: string, aggressive: boolean): string {
  return compactCodeFences(compactToolCalls(compactToolResults(content, aggressive)));
}

/**
 * Stubs code fences in all but the newest ASSISTANT message. Old code
 * proposals sitting verbatim in history are the model's main regurgitation
 * seed: asked for a sorting exercise it re-emits last week's prime printer.
 * User-pasted fences are the student's own context and stay intact.
 */
export function scrubStaleAssistantFences(messages: ChatMessage[]): ChatMessage[] {
  const lastAssistant = messages.findLastIndex((m) => m.role === 'assistant');
  let changed = false;
  const scrubbed = messages.map((message, index) => {
    if (message.role !== 'assistant' || index === lastAssistant) return message;
    const content = compactCodeFences(message.content);
    if (content === message.content) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? scrubbed : messages;
}

function meaningfulMessageStub(message: ChatMessage): string {
  const withoutBulk = compactBulk(message.content, true).trim();
  if (message.role === 'user') {
    const request = withoutBulk.match(/Student request:\s*([\s\S]*?)(?:\n\n(?:Current repository|Relevant current|Repository map)|$)/i)?.[1]?.trim();
    if (request) {
      return `[Earlier student request]\n${clampWithTail(request, 700, 'omitted')}`;
    }
    if (withoutBulk.includes('<tool_result')) {
      // The tool-specific compressor has already bounded this content and
      // left a semantic omission marker. Keep that marker intact.
      return clampWithTail(withoutBulk, 2_600, 'omitted from older tool feedback');
    }
    return `[Earlier user turn]\n${clampWithTail(withoutBulk, 700, 'omitted')}`;
  }
  const prose = withoutBulk
    .replace(/<minerva_tool[\s\S]*?<\/minerva_tool>/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim();
  return prose
    ? `[Earlier assistant turn; bulk payloads omitted]\n${clampWithTail(prose, 700, 'omitted')}`
    : '[Older assistant tool/code turn omitted; inspect the current files for authoritative state.]';
}

function replaceMessage(messages: ChatMessage[], index: number, content: string): void {
  if (messages[index].content === content) return;
  messages[index] = { ...messages[index], content };
}

/**
 * Deterministically shrinks old bulk while preserving the bootstrap rules,
 * the latest turns, error shape, and user intent. No model-generated summary
 * is trusted as context-management infrastructure.
 */
export function compactMessages(
  input: ChatMessage[],
  options: CompactOptions = {},
): CompactResult {
  const budget = options.maxEstimatedTokens ?? INPUT_CONTEXT_BUDGET_TOKENS;
  const keepRecent = Math.max(2, options.keepRecentMessages ?? DEFAULT_RECENT_MESSAGES);
  const before = getContextStats(input, budget);
  if (before.estimatedTokens <= budget) {
    return { messages: input, before, after: before, compacted: false };
  }

  const messages = input.map((message) => ({ ...message }));
  const oldEnd = Math.max(1, messages.length - keepRecent);

  // Pass 1: retain conversation prose but remove bulk from older tool/code turns.
  for (let i = 1; i < oldEnd; i++) replaceMessage(messages, i, compactBulk(messages[i].content, false));

  // Pass 2: if necessary, retain only deterministic intent/result stubs for old turns.
  if (getContextStats(messages, budget).estimatedTokens > budget) {
    for (let i = 1; i < oldEnd; i++) {
      replaceMessage(messages, i, meaningfulMessageStub(messages[i]));
      if (getContextStats(messages, budget).estimatedTokens <= budget) break;
    }
  }

  // Pass 3: a single recent Read/Bash response can itself be huge. Keep the
  // latest message exact, but compact earlier recent bulk from oldest first.
  if (getContextStats(messages, budget).estimatedTokens > budget) {
    for (let i = oldEnd; i < messages.length - 1; i++) {
      replaceMessage(messages, i, compactBulk(messages[i].content, true));
      if (getContextStats(messages, budget).estimatedTokens <= budget) break;
    }
  }

  // Pass 4: hard fallback for pathological long prose. Bootstrap message 0
  // and the newest message remain untouched because they carry rules/current intent.
  if (getContextStats(messages, budget).estimatedTokens > budget) {
    for (let i = 1; i < messages.length - 1; i++) {
      replaceMessage(messages, i, meaningfulMessageStub(messages[i]));
      if (getContextStats(messages, budget).estimatedTokens <= budget) break;
    }
  }

  const after = getContextStats(messages, budget);
  const compactedMessages = messages.reduce(
    (count, message, index) => count + (message.content === input[index]?.content ? 0 : 1),
    0,
  );
  after.compactedMessages = compactedMessages;
  return { messages, before, after, compacted: compactedMessages > 0 };
}

export function formatContextStats(stats: ContextStats): string {
  const percent = Math.round(stats.utilization * 100);
  const chars = stats.characters.toLocaleString('en-US');
  const compacted = stats.compactedMessages ? ` · ${stats.compactedMessages} compacted` : '';
  return `Context: ~${stats.estimatedTokens.toLocaleString('en-US')} / ${stats.budgetTokens.toLocaleString('en-US')} input tokens (${percent}%) · ${stats.messages} messages · ${chars} chars${compacted}\nThe remaining model context is reserved for Minerva's response; old tool/code payloads compact automatically.`;
}
