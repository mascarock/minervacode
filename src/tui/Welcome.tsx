import { Box, Text } from 'ink';
import type { SessionInfo } from '../types.js';
import { sessionInfoLines } from '../ui/info.js';
import { CLI_VERSION } from '../version.js';
import { ACCENT } from './theme.js';

export function Welcome({ info, extra = [] }: { info: SessionInfo; extra?: string[] }) {
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={ACCENT}>✻</Text> <Text bold>Welcome to MinervaCode v{CLI_VERSION}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1} marginLeft={2}>
        {[...sessionInfoLines(info), ...extra].map((line) => (
          <Text key={line} dimColor>
            {line}
          </Text>
        ))}
        <Text dimColor>/help for commands</Text>
      </Box>
    </Box>
  );
}
