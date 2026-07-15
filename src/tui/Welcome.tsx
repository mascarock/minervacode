import { Box, Text } from 'ink';
import type { SessionInfo } from '../types.js';
import { sessionInfoLines } from '../ui/info.js';
import { ACCENT } from './theme.js';

export function Welcome({ info }: { info: SessionInfo }) {
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={ACCENT}>✻</Text> <Text bold>Welcome to Minerva CLI</Text>
      </Text>
      <Box flexDirection="column" marginTop={1} marginLeft={2}>
        {sessionInfoLines(info).map((line) => (
          <Text key={line} dimColor>
            {line}
          </Text>
        ))}
        <Text dimColor>/help for commands</Text>
      </Box>
    </Box>
  );
}
