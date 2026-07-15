import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ModelInfo } from '../types.js';
import { ACCENT } from './theme.js';

interface ModelPickerProps {
  models: ModelInfo[];
  activeId: string;
  onDone: (model: ModelInfo | null) => void;
}

export function ModelPicker({ models, activeId, onDone }: ModelPickerProps) {
  const [index, setIndex] = useState(() => {
    const active = models.findIndex((m) => m.id === activeId);
    return active >= 0 ? active : 0;
  });

  useInput((_input, key) => {
    if (key.upArrow) {
      setIndex((i) => (i - 1 + models.length) % models.length);
    } else if (key.downArrow) {
      setIndex((i) => (i + 1) % models.length);
    } else if (key.return) {
      onDone(models[index]);
    } else if (key.escape) {
      onDone(null);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Text dimColor>Select model · enter to confirm · esc to cancel</Text>
      {models.map((m, i) => (
        <Text key={m.id} color={i === index ? ACCENT : undefined} dimColor={i !== index}>
          {i === index ? '❯ ' : '  '}
          {m.name}
          {m.id === activeId ? ' (active)' : ''}
        </Text>
      ))}
    </Box>
  );
}
