import { stat } from 'node:fs/promises';
import path from 'node:path';
import { useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { MinervaClient } from '../api/client.js';
import { listModels } from '../api/models.js';
import { saveConfig } from '../auth/store.js';
import { gatherSessionInfo } from '../session.js';
import type { ChatMessage, MinervaConfig, ModelInfo, SessionInfo } from '../types.js';
import { HELP_LINES, sessionInfoLines } from '../ui/info.js';
import { copyToClipboard } from '../ui/clipboard.js';
import { latestCodeBlock } from '../ui/markdown.js';
import { runAgent } from '../agent/loop.js';
import { ChangeLog } from '../agent/context.js';
import { collectGitDiff, runReview } from '../agent/review.js';
import { compactMessages, formatContextStats } from '../agent/compact.js';
import { buildRepoMap } from '../agent/repo-map.js';
import type { PermissionMode } from '../agent/permissions.js';
import type { AgentLanguage } from '../agent/prompts.js';
import { getTools } from '../tools/registry.js';
import { Transcript, type Entry } from './Transcript.js';
import { InputBox } from './InputBox.js';
import { Spinner } from './Spinner.js';
import { ModelPicker } from './ModelPicker.js';
import { ApprovalPrompt, type ApprovalRequest } from './ApprovalPrompt.js';

export type ReplAction = 'exit' | 'login' | 'logout';

type Phase = 'idle' | 'waiting' | 'tooling' | 'approving' | 'picking-model';

type NewEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'system'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'tool'; name: string; summary: string; ok: boolean }
  | { kind: 'diff'; patch: string };

export interface AgentSettings {
  projectDir: string;
  auto: boolean;
  /** Explicit --permission-mode; when unset it follows the auto toggle. */
  permissionMode?: PermissionMode;
  language: AgentLanguage;
}

interface AppProps {
  client: MinervaClient;
  config: MinervaConfig;
  sessionInfo: SessionInfo;
  agent: AgentSettings;
  onAction: (action: ReplAction) => void;
}

export function App({ client, config: initialConfig, sessionInfo, agent, onAction }: AppProps) {
  const { exit } = useApp();
  const [auto, setAuto] = useState(agent.auto);
  const [language, setLanguage] = useState<AgentLanguage>(agent.language);
  const [projectDir, setProjectDir] = useState(agent.projectDir);
  const [entries, setEntries] = useState<Entry[]>([
    {
      id: 0,
      kind: 'welcome',
      info: sessionInfo,
      extra: [
        `agent: ${agent.auto ? 'auto' : 'assisted'} · language: ${agent.language} · dir: ${agent.projectDir}`,
      ],
    },
  ]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [config, setConfig] = useState(initialConfig);
  const [waitStart, setWaitStart] = useState(0);
  const [liveTool, setLiveTool] = useState('');
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  // Last change-expecting request that produced no change; "yes" resumes it.
  const pendingIntentRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const changeLogRef = useRef(new ChangeLog());
  const nextId = useRef(1);

  const push = (entry: NewEntry) => {
    setEntries((prev) => [...prev, { ...entry, id: nextId.current++ }]);
  };

  const permissionMode = (): PermissionMode =>
    agent.permissionMode ?? (auto ? 'dontAsk' : 'default');

  useInput((_input, key) => {
    if (key.escape && (phase === 'waiting' || phase === 'tooling')) {
      abortRef.current?.abort();
    }
  });

  const finish = (action: ReplAction) => {
    onAction(action);
    exit();
  };

  const send = async (text: string) => {
    push({ kind: 'user', text });
    setPhase('waiting');
    setWaitStart(Date.now());
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await runAgent(client, {
        history: messagesRef.current,
        prompt: text,
        pendingIntent: pendingIntentRef.current,
        projectDir,
        permissionMode: permissionMode(),
        language,
        signal: controller.signal,
        changeLog: changeLogRef.current,
        events: {
          onText: (t) => {
            push({ kind: 'assistant', text: t });
            setPhase('waiting');
            setWaitStart(Date.now());
          },
          onStatus: (t) => {
            push({ kind: 'system', text: t });
          },
          onToolStart: (e) => {
            setLiveTool(`[${e.tool.name}] ${e.summary}`);
            setPhase('tooling');
          },
          onToolEnd: (e) => {
            setLiveTool('');
            push({ kind: 'tool', name: e.tool.name, summary: e.summary, ok: e.ok });
            setPhase('waiting');
            setWaitStart(Date.now());
          },
          confirm: (e) =>
            new Promise<boolean>((resolve) => {
              setApproval({
                name: e.tool.name,
                summary: e.summary,
                preview: e.preview,
                resolve: (approved) => {
                  setApproval(null);
                  setPhase('waiting');
                  setWaitStart(Date.now());
                  resolve(approved);
                },
              });
              setPhase('approving');
            }),
        },
      });
      messagesRef.current = result.history;
      pendingIntentRef.current = result.pendingIntent;
      if (result.verified === false && result.netChanges.length) {
        push({
          kind: 'system',
          text: 'Changes were kept so you can inspect them with /diff. Ask Minerva to fix the failure or revert manually.',
        });
      }
    } catch (err) {
      push({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      abortRef.current = null;
      setApproval(null);
      setLiveTool('');
      setPhase('idle');
    }
  };

  const handleCommand = async (line: string) => {
    const [rawCmd, ...rest] = line.split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    // Paths and language names are case-sensitive/insensitive respectively;
    // keep the raw argument and lowercase per command as needed.
    const rawArg = rest.join(' ');
    const arg = rawArg.toLowerCase();

    if (cmd === '/exit' || cmd === '/quit') return finish('exit');
    if (cmd === '/logout') return finish('logout');
    if (cmd === '/login') return finish('login');
    if (cmd === '/help') return push({ kind: 'system', text: HELP_LINES.join('\n') });

    if (cmd === '/clear') {
      messagesRef.current = [];
      pendingIntentRef.current = null;
      return push({ kind: 'system', text: 'Conversation cleared.' });
    }

    if (cmd === '/info') {
      const info = await gatherSessionInfo(client, config);
      return push({ kind: 'system', text: sessionInfoLines(info).join('\n') });
    }

    if (cmd === '/context') {
      const result = compactMessages(messagesRef.current);
      messagesRef.current = result.messages;
      return push({
        kind: 'system',
        text: `${formatContextStats(result.after)}${result.compacted ? '\nCompaction ran now.' : ''}`,
      });
    }

    if (cmd === '/repomap') {
      const result = await buildRepoMap({ projectDir, query: rawArg });
      const cache = result.cacheHit ? 'cache hit' : 'refreshed';
      return push({
        kind: 'system',
        text: `${result.map}\n\n${result.fileCount} files · ${result.symbolCount} symbols · ${cache}${result.truncated ? ' · token-budgeted' : ''}`,
      });
    }

    if (cmd === '/auto') {
      const next = arg === 'on' ? true : arg === 'off' ? false : !auto;
      setAuto(next);
      return push({
        kind: 'system',
        text: next
          ? 'Auto mode on (experimental) — edits and shell commands run without asking. A 7B model often cannot finish unaided; unverified runs are reported honestly.'
          : 'Assisted mode — every change needs your approval.',
      });
    }

    if (cmd === '/language' || cmd === '/lang') {
      const aliases: Record<string, AgentLanguage> = {
        auto: 'auto',
        en: 'en',
        english: 'en',
        it: 'it',
        italian: 'it',
        italiano: 'it',
      };
      const next = aliases[arg];
      if (!next) {
        return push({ kind: 'system', text: 'Usage: /language auto|en|it' });
      }
      setLanguage(next);
      return push({ kind: 'system', text: `Reply language set to ${next}.` });
    }

    if (cmd === '/tools') {
      const lines = getTools().map(
        (t) => `${t.name}${t.isReadOnly() ? '' : ' *'}  ${t.description}`,
      );
      return push({
        kind: 'system',
        text: `${lines.join('\n')}\n* requires approval depending on mode`,
      });
    }

    if (cmd === '/copy') {
      const back = rawArg ? Number.parseInt(rawArg, 10) : 1;
      if (!Number.isInteger(back) || back < 1) {
        return push({
          kind: 'system',
          text: 'Usage: /copy [n] — copies the newest code block; n counts further back.',
        });
      }
      const texts = entries
        .filter((e): e is Entry & { kind: 'assistant' } => e.kind === 'assistant')
        .map((e) => e.text);
      const block = latestCodeBlock(texts, back);
      if (!block) {
        return push({
          kind: 'system',
          text: back === 1 ? 'No code block in this conversation yet.' : `No code block ${back} back.`,
        });
      }
      const content = block.content.endsWith('\n') ? block.content : `${block.content}\n`;
      await copyToClipboard(content);
      const lines = content.split('\n').length - 1;
      return push({
        kind: 'system',
        text: `Copied ${lines}-line ${block.lang || 'code'} block to the clipboard.`,
      });
    }

    if (cmd === '/diff') {
      const changes = changeLogRef.current.all();
      if (!changes.length) return push({ kind: 'system', text: 'No changes this session.' });
      for (const change of changes) {
        push({ kind: 'diff', patch: change.patch });
      }
      return;
    }

    if (cmd === '/dir') {
      if (!rawArg) {
        return push({ kind: 'system', text: `Project directory: ${projectDir}` });
      }
      const next = path.resolve(rawArg.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
      try {
        const info = await stat(next);
        if (!info.isDirectory()) throw new Error('not a directory');
      } catch {
        return push({ kind: 'system', text: `Not a directory: ${next}` });
      }
      // The conversation carries the OLD project's injected file contents
      // and the changelog its diffs — both must not leak into the new one.
      setProjectDir(next);
      messagesRef.current = [];
      changeLogRef.current = new ChangeLog();
      return push({
        kind: 'system',
        text: `Project directory set to ${next}\nConversation and session diff were reset for the new project.`,
      });
    }

    if (cmd === '/review') {
      const changes = changeLogRef.current.all();
      const diff = changes.length
        ? changes.map((c) => c.patch).join('\n\n')
        : await collectGitDiff(projectDir);
      if (!diff) {
        return push({
          kind: 'system',
          text: 'Nothing to review — no session changes and no pending git diff.',
        });
      }
      push({
        kind: 'system',
        text: changes.length
          ? `Reviewing ${changes.length} change(s) from this session…`
          : 'Reviewing pending git diff…',
      });
      setPhase('waiting');
      setWaitStart(Date.now());
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const review = await runReview(client, {
          diff,
          language,
          signal: controller.signal,
        });
        push({ kind: 'assistant', text: `Code review:\n${review.raw}` });
      } finally {
        abortRef.current = null;
        setPhase('idle');
      }
      return;
    }

    if (cmd === '/model') {
      const list = await listModels(client);
      if (!list.length) return push({ kind: 'system', text: 'No models available.' });
      setModels(list);
      setPhase('picking-model');
      return;
    }

    push({ kind: 'system', text: `Unknown command: ${line}. Type /help` });
  };

  const onSubmit = (raw: string) => {
    const line = raw.trim();
    if (!line || phase !== 'idle') return;
    setInputHistory((prev) => (prev.at(-1) === line ? prev : [...prev, line]));
    // Only a bare word after the slash is a command — "/Users/nick/…" or
    // "/tmp/file.py" in a message is a path, not a command.
    const firstToken = line.split(/\s+/, 1)[0];
    if (/^\/[a-z]+$/i.test(firstToken)) {
      void handleCommand(line).catch((err: unknown) => {
        push({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
      });
      return;
    }
    void send(line);
  };

  const onModelDone = async (model: ModelInfo | null) => {
    setPhase('idle');
    if (!model || model.id === config.model) return;
    const next = { ...config, model: model.id };
    setConfig(next);
    client.updateConfig(next);
    await saveConfig(next);
    push({ kind: 'system', text: `Model set to ${model.name}` });
  };

  return (
    <Box flexDirection="column">
      <Transcript entries={entries} />
      {phase === 'waiting' ? (
        <Box marginBottom={1}>
          <Spinner startedAt={waitStart} />
        </Box>
      ) : null}
      {phase === 'tooling' ? (
        <Box marginBottom={1} marginLeft={2}>
          <Text dimColor>{liveTool} …</Text>
        </Box>
      ) : null}
      {phase === 'approving' && approval ? <ApprovalPrompt request={approval} /> : null}
      {phase === 'picking-model' ? (
        <ModelPicker
          models={models}
          activeId={config.model}
          onDone={(m) => void onModelDone(m)}
        />
      ) : null}
      {phase === 'idle' ? <InputBox onSubmit={onSubmit} history={inputHistory} /> : null}
    </Box>
  );
}
