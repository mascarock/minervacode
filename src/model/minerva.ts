import { streamChat } from '../api/chat.js';
import type { MinervaClient } from '../api/client.js';
import type { ModelAdapter, ModelCapabilities, ModelEvent, ModelRequest } from './types.js';

/**
 * Chat Minerva behind Open WebUI. Wraps the existing SSE streaming path
 * without changing it — `streamChat` remains the transport and the public
 * API for callers that predate this abstraction.
 */
export class MinervaModelAdapter implements ModelAdapter {
  readonly id = 'minerva';

  readonly capabilities: ModelCapabilities = {
    streaming: true,
    // Open WebUI drops system-role messages, so the agent instructions must
    // ride in a user message. Removing this workaround needs a real fix
    // upstream, not optimism here.
    systemRole: false,
    // The 7B has no native tool-call API; the agent parses tool blocks and
    // filename-labelled fences out of plain text instead.
    toolCalls: false,
    maxOutputTokens: 2048,
  };

  constructor(private readonly client: MinervaClient) {}

  get model(): string {
    return this.client.model;
  }

  async send(request: ModelRequest, onEvent?: (event: ModelEvent) => void): Promise<string> {
    const text = await streamChat(this.client, request.messages, {
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      onChunk: onEvent ? (chunk) => onEvent({ type: 'text', text: chunk }) : undefined,
    });
    onEvent?.({ type: 'done', text });
    return text;
  }
}
