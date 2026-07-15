import { Box, Text, useInput } from 'ink';
import { ACCENT } from './theme.js';
import { DiffText } from './DiffText.js';

export interface ApprovalRequest {
  name: string;
  summary: string;
  preview: string;
  resolve: (approved: boolean) => void;
}

export function ApprovalPrompt({ request }: { request: ApprovalRequest }) {
  useInput((input, key) => {
    const char = input.toLowerCase();
    if (char === 'y' || char === 's' || key.return) {
      request.resolve(true);
    } else if (char === 'n' || key.escape) {
      request.resolve(false);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Text>
        <Text color={ACCENT} bold>
          {request.name}
        </Text>{' '}
        {request.summary}
      </Text>
      <Box marginY={1} marginLeft={1}>
        <DiffText patch={request.preview} />
      </Box>
      <Text dimColor>y approve · n deny</Text>
    </Box>
  );
}
