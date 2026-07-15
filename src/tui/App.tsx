import { useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { MinervaClient } from '../api/client.js';
import { listModels } from '../api/models.js';
import { saveConfig } from '../auth/store.js';
import { gatherSessionInfo } from '../session.js';
import type { ChatMessage, MinervaConfig, ModelInfo, SessionInfo } from '../types.js';
import { HELP_LINES, sessionInfoLines } from '../ui/info.js';
import { runAgent } from '../agent/loop.js';
import { ChangeLog } from '../agent/context.js';
import type { PermissionMode } from '../agent/permissions.js';
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
  const [entries, setEntries] = useState<Entry[]>([
    {
      id: 0,
      kind: 'welcome',
      info: sessionInfo,
      extra: [
        `agent: ${agent.auto ? 'auto' : 'assisted'} · dir: ${agent.projectDir}`,
      ],
    },
  ]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [config, setConfig] = useState(initialConfig);
  const [waitStart, setWaitStart] = useState(0);
  const [liveTool, setLiveTool] = useState('');
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const changeLogRef = useRef(new ChangeLog());
  const nextId = useRef(1);

  const push = (entry: NewEntry) => {
    setEntries((prev) => [...prev, { ...entry, id: nextId.current++ }]);
  };

  const permissionMode = (): PermissionMode =>
    agent.permissionMode ?? (auto ? 'acceptEdits' : 'default');

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
        projectDir: agent.projectDir,
        permissionMode: permissionMode(),
        assisted: !auto,
        signal: controller.signal,
        changeLog: changeLogRef.current,
        events: {
          onText: (t) => {
            push({ kind: 'assistant', text: t });
            setPhase('waiting');
            setWaitStart(Date.now());
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
    const [cmd, ...rest] = line.toLowerCase().split(/\s+/);
    const arg = rest.join(' ');

    if (cmd === '/exit' || cmd === '/quit') return finish('exit');
    if (cmd === '/logout') return finish('logout');
    if (cmd === '/login') return finish('login');
    if (cmd === '/help') return push({ kind: 'system', text: HELP_LINES.join('\n') });

    if (cmd === '/clear') {
      messagesRef.current = [];
      return push({ kind: 'system', text: 'Conversation cleared.' });
    }

    if (cmd === '/info') {
      const info = await gatherSessionInfo(client, config);
      return push({ kind: 'system', text: sessionInfoLines(info).join('\n') });
    }

    if (cmd === '/auto') {
      const next = arg === 'on' ? true : arg === 'off' ? false : !auto;
      setAuto(next);
      return push({
        kind: 'system',
        text: next
          ? 'Auto mode on — edits apply without asking, bash still asks.'
          : 'Assisted mode — every change needs your approval.',
      });
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

    if (cmd === '/diff') {
      const changes = changeLogRef.current.all();
      if (!changes.length) return push({ kind: 'system', text: 'No changes this session.' });
      for (const change of changes) {
        push({ kind: 'diff', patch: change.patch });
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
    if (line.startsWith('/')) {
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
      {phase === 'idle' ? <InputBox onSubmit={onSubmit} /> : null}
    </Box>
  );
}
