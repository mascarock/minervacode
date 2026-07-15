import { Box, Static, Text } from 'ink';
import type { SessionInfo } from '../types.js';
import { Welcome } from './Welcome.js';
import { DiffText } from './DiffText.js';

export type Entry =
  | { id: number; kind: 'welcome'; info: SessionInfo; extra?: string[] }
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string; interrupted?: boolean }
  | { id: number; kind: 'system'; text: string }
  | { id: number; kind: 'error'; text: string }
  | { id: number; kind: 'tool'; name: string; summary: string; ok: boolean }
  | { id: number; kind: 'diff'; patch: string };

function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case 'welcome':
      return <Welcome info={entry.info} extra={entry.extra} />;
    case 'user':
      return (
        <Box>
          <Box marginRight={1}>
            <Text dimColor>{'>'}</Text>
          </Box>
          <Box flexGrow={1}>
            <Text dimColor>{entry.text}</Text>
          </Box>
        </Box>
      );
    case 'assistant':
      return (
        <Box>
          <Box marginRight={1}>
            <Text>●</Text>
          </Box>
          <Box flexGrow={1}>
            <Text>
              {entry.text || <Text dimColor>(no response)</Text>}
              {entry.interrupted ? <Text dimColor> · interrupted</Text> : null}
            </Text>
          </Box>
        </Box>
      );
    case 'system':
      return (
        <Box marginLeft={2}>
          <Text dimColor>{entry.text}</Text>
        </Box>
      );
    case 'error':
      return (
        <Box>
          <Box marginRight={1}>
            <Text color="red">●</Text>
          </Box>
          <Box flexGrow={1}>
            <Text color="red">Error: {entry.text}</Text>
          </Box>
        </Box>
      );
    case 'tool':
      return (
        <Box marginLeft={2}>
          <Text dimColor={entry.ok} color={entry.ok ? undefined : 'red'}>
            [{entry.name}] {entry.summary}
            {entry.ok ? '' : ' ✗'}
          </Text>
        </Box>
      );
    case 'diff':
      return (
        <Box marginLeft={2}>
          <DiffText patch={entry.patch} />
        </Box>
      );
  }
}

/** Tool indicators group tightly under their turn; everything else gets air. */
function marginFor(entry: Entry): number {
  return entry.kind === 'tool' ? 0 : 1;
}

export function Transcript({ entries }: { entries: Entry[] }) {
  return (
    <Static items={entries}>
      {(entry) => (
        <Box key={entry.id} marginBottom={marginFor(entry)}>
          <EntryView entry={entry} />
        </Box>
      )}
    </Static>
  );
}
