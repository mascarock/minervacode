import { Box, Text } from 'ink';
import { diffLineColor } from '../ui/agent-console.js';

export function DiffText({ patch }: { patch: string }) {
  return (
    <Box flexDirection="column">
      {patch.split('\n').map((line, i) => {
        const color = diffLineColor(line);
        return (
          <Text key={i} color={color ?? undefined} dimColor={!color}>
            {line || ' '}
          </Text>
        );
      })}
    </Box>
  );
}
