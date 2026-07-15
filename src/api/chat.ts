import type { MinervaClient } from './client.js';
import type { ChatMessage } from '../types.js';

export interface StreamChatOptions {
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
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
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
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
    if (timeoutSignal.aborted && !signal?.aborted) {
      throw new Error(`Model response timed out after ${timeoutMs}ms`);
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
    if (timeoutSignal.aborted && !signal?.aborted) {
      throw new Error(`Model response timed out after ${timeoutMs}ms`);
    }
    throw err;
  }

  return fullText;
}
