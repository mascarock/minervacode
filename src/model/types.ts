import type { ChatMessage } from '../types.js';

/**
 * What a backing model can actually do. The agent loop reads these instead
 * of hardcoding one provider's quirks — Chat Minerva's Open WebUI silently
 * drops system-role messages, which is why the agent instructions ride in a
 * user message. A provider that supports them should not pay that cost.
 */
export interface ModelCapabilities {
  /** Emits incremental chunks rather than one final blob. */
  readonly streaming: boolean;
  /**
   * Honors system-role messages instead of dropping them.
   *
   * DECLARED, NOT YET CONSUMED. The agent loop unconditionally ships its
   * instructions in a user message — the placement Minerva needs — so no
   * branch reads this flag today. Making prompt placement capability-driven
   * is deferred on purpose: the current Minerva prompts are tuned against a
   * benchmark and must not shift silently, and there is no second adapter
   * yet to validate a system-role variant against. Adding one is the point
   * at which this becomes a real switch rather than metadata.
   */
  readonly systemRole: boolean;
  /** Has a native tool-call API (as opposed to text the agent must parse). */
  readonly toolCalls: boolean;
  /** Provider cap on a single response, when known. */
  readonly maxOutputTokens?: number;
}

export interface ModelRequest {
  readonly messages: ChatMessage[];
  readonly signal?: AbortSignal;
  /** Inactivity bound — no bytes for this long fails the request. */
  readonly timeoutMs?: number;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Open WebUI per-request web search toggle. */
  readonly webSearch?: boolean;
}

/**
 * Streaming progress. `text` events are incremental; `done` carries the
 * complete response, so a consumer may ignore chunks entirely. `sources`
 * is the honest signal that a server-side tool (web search, RAG) actually
 * ran for this request — its absence when `webSearch` was requested means
 * the provider ignored the flag, not that the model chose not to search.
 */
export type ModelEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'sources'; readonly sources: readonly unknown[] }
  | { readonly type: 'done'; readonly text: string };

/**
 * The seam between the agent and whatever produces tokens. Deliberately
 * minimal: one request in, complete text out, chunks along the way. The
 * agent's real intelligence is in its deterministic gates, not the provider.
 */
export interface ModelAdapter {
  /** Stable provider identity, e.g. `minerva`. */
  readonly id: string;
  /** The concrete model being addressed. */
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  /** Resolves to the complete response text. */
  send(request: ModelRequest, onEvent?: (event: ModelEvent) => void): Promise<string>;
}
