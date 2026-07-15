import type { MinervaClient } from '../api/client.js';
import { streamChat } from '../api/chat.js';
import type { ChatMessage } from '../types.js';
import { getTool, getTools } from '../tools/registry.js';
import { resolveInProject, type Tool } from '../tools/tool.js';
import type { ChangeLog } from './context.js';
import { parseToolCalls } from './parser.js';
import { needsApproval, type PermissionMode } from './permissions.js';
import { buildPreview, filePatch, readIfExists } from './preview.js';
import {
  buildSystemPrompt,
  formatToolResult,
  listProjectFiles,
  loadProjectContext,
  loadProjectFileContents,
} from './prompts.js';

export const MAX_TURNS = 20;
export const MAX_CALLS_PER_TURN = 3;

export interface ToolCallEvent {
  tool: Tool;
  input: Record<string, unknown>;
  summary: string;
}

export interface AgentEvents {
  /** Visible assistant text for a turn, tool blocks already stripped. */
  onText(text: string): void;
  onToolStart(event: ToolCallEvent): void;
  onToolEnd(event: ToolCallEvent & { ok: boolean; result: string }): void;
  /** Ask the user to approve a tool call. Resolves false to deny. */
  confirm(event: ToolCallEvent & { preview: string }): Promise<boolean>;
}

export interface AgentOptions {
  history: ChatMessage[];
  prompt: string;
  projectDir: string;
  permissionMode: PermissionMode;
  /** Assisted mode enables the code-block → Write proposal fallback. */
  assisted: boolean;
  events: AgentEvents;
  signal?: AbortSignal;
  changeLog?: ChangeLog;
}

export interface AgentResult {
  /** Updated conversation history (without the system prompt). */
  history: ChatMessage[];
  finalText: string;
}

async function executeCall(
  tool: Tool,
  input: Record<string, unknown>,
  opts: AgentOptions,
): Promise<{ ok: boolean; result: string }> {
  const tracksChanges =
    opts.changeLog && (tool.name === 'Write' || tool.name === 'Edit') && typeof input.path === 'string';
  const file = tracksChanges ? resolveInProject(opts.projectDir, String(input.path)) : null;
  const before = file ? await readIfExists(file) : '';

  try {
    const result = await tool.call(input, { projectDir: opts.projectDir, signal: opts.signal });
    if (file) {
      const after = await readIfExists(file);
      opts.changeLog?.add({
        path: String(input.path),
        patch: filePatch(String(input.path), before, after),
      });
    }
    return { ok: true, result };
  } catch (err) {
    return { ok: false, result: err instanceof Error ? err.message : String(err) };
  }
}

export async function runAgent(client: MinervaClient, opts: AgentOptions): Promise<AgentResult> {
  const tools = getTools();
  const [projectContext, projectFiles] = await Promise.all([
    loadProjectContext(opts.projectDir),
    listProjectFiles(opts.projectDir),
  ]);
  const { files: fileContents, skipped } = await loadProjectFileContents(
    opts.projectDir,
    projectFiles,
  );
  const instructions = buildSystemPrompt({
    projectDir: opts.projectDir,
    tools,
    projectContext,
    projectFiles,
    fileContents,
    skippedFiles: skipped,
  });

  // Chat Minerva's Open WebUI drops system-role messages, so the agent
  // instructions ride inside the first user message of the conversation.
  const firstTurn = opts.history.length === 0;
  const userContent = firstTurn
    ? `${instructions}\n\n---\n\nRichiesta dello studente: ${opts.prompt}`
    : opts.prompt;

  const messages: ChatMessage[] = [
    ...opts.history,
    { role: 'user', content: userContent },
  ];
  let finalText = '';

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await streamChat(client, messages, { signal: opts.signal });
    messages.push({ role: 'assistant', content: response });

    // The code-block fallback is the primary write path for ChatMinerva —
    // the model proposes whole files in fences rather than emitting tool
    // blocks. Permission mode still gates whether the Write auto-applies.
    const { toolCalls, text } = parseToolCalls(response, {
      codeBlockWriteFallback: true,
    });
    if (text) {
      finalText = text;
      opts.events.onText(text);
    }

    if (!toolCalls.length || opts.signal?.aborted) break;

    const results: string[] = [];
    for (const call of toolCalls.slice(0, MAX_CALLS_PER_TURN)) {
      if (opts.signal?.aborted) break;

      const tool = getTool(call.tool);
      if (!tool) {
        results.push(formatToolResult(call.tool, `Unknown tool: ${call.tool}`, false));
        continue;
      }

      const parsed = tool.inputSchema.safeParse(call.args);
      if (!parsed.success) {
        results.push(
          formatToolResult(tool.name, `Invalid arguments: ${parsed.error.message}`, false),
        );
        continue;
      }

      const input = parsed.data as Record<string, unknown>;
      const event: ToolCallEvent = { tool, input, summary: tool.summarize(input) };

      if (needsApproval(tool, opts.permissionMode)) {
        const preview = await buildPreview(tool.name, input, opts.projectDir);
        const approved = await opts.events.confirm({ ...event, preview });
        if (!approved) {
          const denied = 'User denied this tool call. Do not retry it; ask what to do instead.';
          opts.events.onToolEnd({ ...event, ok: false, result: 'denied' });
          results.push(formatToolResult(tool.name, denied, false));
          continue;
        }
      }

      opts.events.onToolStart(event);
      const { ok, result } = await executeCall(tool, input, opts);
      opts.events.onToolEnd({ ...event, ok, result });
      results.push(formatToolResult(tool.name, result, ok));
    }

    if (toolCalls.length > MAX_CALLS_PER_TURN) {
      results.push(
        `Note: only the first ${MAX_CALLS_PER_TURN} tool calls were executed. Request the others again if still needed.`,
      );
    }
    if (opts.signal?.aborted) break;

    // Code-block proposals weren't requested by the model as tool calls —
    // feeding results back would only confuse it. Apply and end the turn.
    if (toolCalls.every((c) => c.source === 'codeblock')) break;

    messages.push({ role: 'user', content: results.join('\n\n') });

    if (turn === MAX_TURNS - 1) {
      opts.events.onText('(Limite di turni raggiunto — riprendi con un nuovo messaggio.)');
    }
  }

  return { history: messages, finalText };
}
