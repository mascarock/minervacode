import type { MinervaClient } from './client.js';
import type { ChatMessage } from '../types.js';

export interface StreamChatOptions {
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
  /**
   * Inactivity bound: the request fails when NO bytes arrive for this long.
   * A model that keeps streaming may legitimately take longer overall — a
   * whole-response cap used to kill slow 7B generations mid-stream.
   */
  timeoutMs?: number;
}

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
  const { onChunk, signal, timeoutMs = 60_000 } = options;
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
          // Coding-agent turns should be reproducible and concise. The platform
          // default is tuned for conversational variety, which makes a small
          // model much more likely to invent APIs or ramble past a closing fence.
          temperature: 0.1,
          max_tokens: 2048,
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
            };
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
