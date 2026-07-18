import { describe, expect, it } from 'vitest';
import type { MinervaClient } from '../api/client.js';
import { MinervaModelAdapter } from './minerva.js';
import type { ModelEvent } from './types.js';

function sseResponse(chunks: string[]): Response {
  const body = chunks
    .map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
    .join('');
  return new Response(`${body}data: [DONE]\n\n`, { status: 200 });
}

function stubClient(
  postStream: MinervaClient['postStream'],
  model = 'test-model',
): MinervaClient {
  return { model, postStream } as unknown as MinervaClient;
}

describe('MinervaModelAdapter', () => {
  it('reports the client’s current model', () => {
    expect(new MinervaModelAdapter(stubClient(async () => sseResponse([]), 'minerva-7b')).model).toBe(
      'minerva-7b',
    );
  });

  it('declares the Open WebUI constraints the agent works around', () => {
    const { capabilities, id } = new MinervaModelAdapter(stubClient(async () => sseResponse([])));
    expect(id).toBe('minerva');
    expect(capabilities.streaming).toBe(true);
    // Both drive real agent-loop workarounds — see loop.ts.
    expect(capabilities.systemRole).toBe(false);
    expect(capabilities.toolCalls).toBe(false);
  });

  it('returns the concatenated response text', async () => {
    const adapter = new MinervaModelAdapter(stubClient(async () => sseResponse(['Hel', 'lo'])));
    await expect(adapter.send({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toBe(
      'Hello',
    );
  });

  it('streams chunks and ends with the complete text', async () => {
    const adapter = new MinervaModelAdapter(stubClient(async () => sseResponse(['a', 'b'])));
    const events: ModelEvent[] = [];
    await adapter.send({ messages: [] }, (event) => events.push(event));
    expect(events).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'done', text: 'ab' },
    ]);
  });

  it('sends the agent-tuned sampling defaults when none are given', async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = new MinervaModelAdapter(
      stubClient(async (_path, sent) => {
        body = sent as Record<string, unknown>;
        return sseResponse(['ok']);
      }),
    );
    await adapter.send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(body).toMatchObject({ model: 'test-model', stream: true, temperature: 0.1, max_tokens: 2048 });
  });

  it('passes request overrides through to the transport', async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = new MinervaModelAdapter(
      stubClient(async (_path, sent) => {
        body = sent as Record<string, unknown>;
        return sseResponse(['ok']);
      }),
    );
    await adapter.send({ messages: [], temperature: 0.7, maxTokens: 16, webSearch: true });
    expect(body).toMatchObject({ temperature: 0.7, max_tokens: 16, features: { web_search: true } });
  });

  it('forwards Open WebUI sources as a distinct event, not text', async () => {
    const adapter = new MinervaModelAdapter(
      stubClient(async (_path, _body) => {
        const sourcesChunk = JSON.stringify({ sources: [{ source: { urls: ['https://x'] } }] });
        const textChunk = JSON.stringify({ choices: [{ delta: { content: 'hi' } }] });
        return new Response(`data: ${sourcesChunk}\n\ndata: ${textChunk}\n\ndata: [DONE]\n\n`, {
          status: 200,
        });
      }),
    );
    const events: ModelEvent[] = [];
    await adapter.send({ messages: [], webSearch: true }, (event) => events.push(event));
    expect(events).toEqual([
      { type: 'sources', sources: [{ source: { urls: ['https://x'] } }] },
      { type: 'text', text: 'hi' },
      { type: 'done', text: 'hi' },
    ]);
  });

  it('propagates transport failures to the caller', async () => {
    const adapter = new MinervaModelAdapter(
      stubClient(async () => {
        throw new Error('upstream exploded');
      }),
    );
    await expect(adapter.send({ messages: [] })).rejects.toThrow('upstream exploded');
  });

  it('resolves empty when the caller aborts', async () => {
    const controller = new AbortController();
    const adapter = new MinervaModelAdapter(
      stubClient(async (_path, _body, signal) => {
        controller.abort();
        signal?.throwIfAborted();
        return sseResponse(['unreachable']);
      }),
    );
    await expect(adapter.send({ messages: [], signal: controller.signal })).resolves.toBe('');
  });
});
