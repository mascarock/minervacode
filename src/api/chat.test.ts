import { describe, expect, it } from 'vitest';
import type { MinervaClient } from './client.js';
import { streamChat } from './chat.js';

describe('streamChat', () => {
  it('uses deterministic bounded generation for coding-agent turns', async () => {
    let request: Record<string, unknown> | undefined;
    const client = {
      model: 'test-model',
      async postStream(_path: string, body: unknown) {
        request = body as Record<string, unknown>;
        const chunk = JSON.stringify({ choices: [{ delta: { content: 'ok' } }] });
        return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { status: 200 });
      },
    } as MinervaClient;

    await expect(streamChat(client, [{ role: 'user', content: 'Fix it.' }])).resolves.toBe('ok');
    expect(request).toMatchObject({
      model: 'test-model',
      stream: true,
      temperature: 0.1,
      max_tokens: 2048,
    });
  });

  it('bounds a stalled model response', async () => {
    const client = {
      model: 'test-model',
      async postStream(_path: string, _body: unknown, signal?: AbortSignal) {
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    } as MinervaClient;

    await expect(streamChat(client, [], { timeoutMs: 10 })).rejects.toThrow(
      'Model response timed out after 10ms',
    );
  });
});
