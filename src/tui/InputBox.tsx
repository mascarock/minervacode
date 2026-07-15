import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export function InputBox({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [value, setValue] = useState('');

  useInput((input, key) => {
    if (key.return) {
      const text = value;
      setValue('');
      onSubmit(text);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (key.escape || key.ctrl || key.meta || key.tab) return;
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
    if (!input) return;
    // Pasted or piped input can carry the newline inside the chunk instead
    // of as a key.return event — treat the first newline as submit.
    if (/[\r\n]/.test(input)) {
      const first = input.split(/[\r\n]/, 1)[0];
      const text = value + first;
      setValue('');
      onSubmit(text);
      return;
    }
    setValue((v) => v + input);
  });

  return (
    <Box borderStyle="round" borderDimColor paddingX={1}>
      <Text dimColor>{'> '}</Text>
      {value ? <Text>{value}</Text> : null}
      <Text inverse> </Text>
      {value ? null : <Text dimColor> send a message · /help for commands</Text>}
    </Box>
  );
}
