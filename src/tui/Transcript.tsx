import { Box, Static, Text } from 'ink';
import type { SessionInfo } from '../types.js';
import { Welcome } from './Welcome.js';

export type Entry =
  | { id: number; kind: 'welcome'; info: SessionInfo }
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string; interrupted?: boolean }
  | { id: number; kind: 'system'; text: string }
  | { id: number; kind: 'error'; text: string };

function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case 'welcome':
      return <Welcome info={entry.info} />;
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
  }
}

export function Transcript({ entries }: { entries: Entry[] }) {
  return (
    <Static items={entries}>
      {(entry) => (
        <Box key={entry.id} marginBottom={1}>
          <EntryView entry={entry} />
        </Box>
      )}
    </Static>
  );
}
