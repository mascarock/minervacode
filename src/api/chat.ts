import type { MinervaClient } from './client.js';
import type { ChatMessage } from '../types.js';

export interface StreamChatOptions {
  onChunk?: (text: string) => void;
  /**
   * Open WebUI emits a standalone SSE data line — a top-level `sources`
   * field, not nested under `choices` — when a web-search (or RAG) tool
   * actually ran for this turn. Absence of this callback firing is the
   * honest signal that `webSearch: true` was ignored server-side.
   */
  onSources?: (sources: unknown[]) => void;
  signal?: AbortSignal;
  /**
   * Inactivity bound: the request fails when NO bytes arrive for this long.
   * A model that keeps streaming may legitimately take longer overall — a
   * whole-response cap used to kill slow 7B generations mid-stream.
   */
  timeoutMs?: number;
  /** Overrides the agent-tuned default; see the sampling note below. */
  temperature?: number;
  maxTokens?: number;
  /**
   * Ask Open WebUI to run its web-search pipeline for this chat turn
   * (`features.web_search`). Requires the feature to be enabled on the
   * server, on the model, and for the user's account.
   */
  webSearch?: boolean;
}

/**
 * Coding-agent turns should be reproducible and concise. The platform
 * default is tuned for conversational variety, which makes a small model
 * much more likely to invent APIs or ramble past a closing fence.
 */
export const DEFAULT_TEMPERATURE = 0.1;
export const DEFAULT_MAX_TOKENS = 2048;

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'AbortError'
    : err instanceof Error && err.name === 'AbortError';
}

export async function streamChat(
  client: MinervaClient,
  messages: ChatMessage[],
  options: StreamChatOptions = {},
): Promise<string> {
  const {
    onChunk,
    onSources,
    signal,
    timeoutMs = 60_000,
    temperature = DEFAULT_TEMPERATURE,
    maxTokens = DEFAULT_MAX_TOKENS,
    webSearch = false,
  } = options;
  const idle = new AbortController();
  let idleTimer: NodeJS.Timeout | undefined;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(), timeoutMs);
  };
  armIdle();
  const requestSignal = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;

  try {
    let res: Response;
    try {
      res = await client.postStream(
        '/api/chat/completions',
        {
          model: client.model,
          messages,
          stream: true,
          temperature,
          max_tokens: maxTokens,
          ...(webSearch ? { features: { web_search: true } } : {}),
        },
        requestSignal,
      );
    } catch (err) {
      if (isAbortError(err) && signal?.aborted) return '';
      if (idle.signal.aborted && !signal?.aborted) {
        throw new Error(`Model response timed out after ${timeoutMs}ms without data`);
      }
      throw err;
    }

    if (!res.body) {
      throw new Error('No response body from chat API');
    }

    let fullText = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const payload = trimmed.slice(6);
          if (payload === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
              sources?: unknown[];
            };
            // A `sources` line stands alone (no `choices`) — it is Open
            // WebUI reporting that a tool (web search, RAG) actually ran,
            // not a text delta. See streaming/index.ts in open-webui/open-webui.
            if (parsed.sources) {
              onSources?.(parsed.sources);
              continue;
            }
            const chunk = parsed.choices?.[0]?.delta?.content ?? '';
            if (chunk) {
              fullText += chunk;
              onChunk?.(chunk);
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } catch (err) {
      if (isAbortError(err) && signal?.aborted) {
        return fullText;
      }
      if (idle.signal.aborted && !signal?.aborted) {
        throw new Error(`Model response timed out after ${timeoutMs}ms without data`);
      }
      throw err;
    }

    return fullText;
  } finally {
    clearTimeout(idleTimer);
  }
}
