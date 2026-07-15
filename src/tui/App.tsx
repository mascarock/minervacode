import { useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { MinervaClient } from '../api/client.js';
import { streamChat } from '../api/chat.js';
import { listModels } from '../api/models.js';
import { saveConfig } from '../auth/store.js';
import { gatherSessionInfo } from '../session.js';
import type { ChatMessage, MinervaConfig, ModelInfo, SessionInfo } from '../types.js';
import { HELP_LINES, sessionInfoLines } from '../ui/info.js';
import { Transcript, type Entry } from './Transcript.js';
import { InputBox } from './InputBox.js';
import { Spinner } from './Spinner.js';
import { ModelPicker } from './ModelPicker.js';

export type ReplAction = 'exit' | 'login' | 'logout';

type Phase = 'idle' | 'waiting' | 'streaming' | 'picking-model';

type NewEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; interrupted?: boolean }
  | { kind: 'system'; text: string }
  | { kind: 'error'; text: string };

interface AppProps {
  client: MinervaClient;
  config: MinervaConfig;
  sessionInfo: SessionInfo;
  onAction: (action: ReplAction) => void;
}

export function App({ client, config: initialConfig, sessionInfo, onAction }: AppProps) {
  const { exit } = useApp();
  const [entries, setEntries] = useState<Entry[]>([
    { id: 0, kind: 'welcome', info: sessionInfo },
  ]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [streamText, setStreamText] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [config, setConfig] = useState(initialConfig);
  const [waitStart, setWaitStart] = useState(0);
  const messagesRef = useRef<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);

  const push = (entry: NewEntry) => {
    setEntries((prev) => [...prev, { ...entry, id: nextId.current++ }]);
  };

  useInput((_input, key) => {
    if (key.escape && (phase === 'waiting' || phase === 'streaming')) {
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
      const reply = await streamChat(
        client,
        [...messagesRef.current, { role: 'user', content: text }],
        {
          signal: controller.signal,
          onChunk: (chunk) => {
            setPhase('streaming');
            setStreamText((prev) => prev + chunk);
          },
        },
      );
      messagesRef.current.push({ role: 'user', content: text });
      if (reply) {
        messagesRef.current.push({ role: 'assistant', content: reply });
      }
      push({ kind: 'assistant', text: reply, interrupted: controller.signal.aborted });
    } catch (err) {
      push({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      abortRef.current = null;
      setStreamText('');
      setPhase('idle');
    }
  };

  const handleCommand = async (line: string) => {
    const cmd = line.toLowerCase();

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
      {phase === 'streaming' ? (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Box marginRight={1}>
              <Text>●</Text>
            </Box>
            <Box flexGrow={1}>
              <Text>{streamText}</Text>
            </Box>
          </Box>
          <Box marginLeft={2}>
            <Text dimColor>esc to interrupt</Text>
          </Box>
        </Box>
      ) : null}
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
