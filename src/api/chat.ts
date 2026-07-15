import type { MinervaClient } from './client.js';
import type { ChatMessage } from '../types.js';

export interface StreamChatOptions {
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
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
  const { onChunk, signal } = options;
  const res = await client.postStream(
    '/api/chat/completions',
    {
      model: client.model,
      messages,
      stream: true,
    },
    signal,
  );

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
    if (isAbortError(err)) {
      return fullText;
    }
    throw err;
  }

  return fullText;
}
