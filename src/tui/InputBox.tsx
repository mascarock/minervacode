import { useRef, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';

function normalizeNewlines(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

export function InputBox({
  onSubmit,
  history = [],
}: {
  onSubmit: (text: string) => void;
  /** Previously submitted messages, oldest first, recalled with ↑/↓. */
  history?: string[];
}) {
  const [value, setValue] = useState('');
  /** Caret position inside value, moved with ←/→ (0..value.length). */
  const [cursor, setCursor] = useState(0);
  /** Index into history while browsing with ↑/↓; null = editing a draft. */
  const [recall, setRecall] = useState<number | null>(null);
  const draftRef = useRef('');

  const submit = (text: string) => {
    setValue('');
    setCursor(0);
    setRecall(null);
    onSubmit(text);
  };

  // Any edit turns a recalled message into the current draft, so typing
  // after ↑ behaves like editing a shell-history entry.
  const apply = (nextValue: string, nextCursor: number) => {
    setRecall(null);
    setValue(nextValue);
    setCursor(Math.max(0, Math.min(nextCursor, nextValue.length)));
  };

  const insert = (text: string) => {
    apply(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
  };

  const showHistory = (index: number) => {
    setRecall(index);
    setValue(history[index]);
    setCursor(history[index].length);
  };

  // Bracketed paste: the full pasted text (newlines included) arrives here
  // in one piece and is inserted at the caret — never auto-submitted, so a
  // pasted snippet can be read and edited before pressing Enter.
  usePaste((text) => {
    insert(normalizeNewlines(text));
  });

  useInput((input, key) => {
    if (key.return) {
      submit(value);
      return;
    }
    if (key.upArrow) {
      if (!history.length) return;
      if (recall === null) draftRef.current = value;
      showHistory(recall === null ? history.length - 1 : Math.max(0, recall - 1));
      return;
    }
    if (key.downArrow) {
      if (recall === null) return;
      const next = recall + 1;
      if (next >= history.length) {
        setRecall(null);
        setValue(draftRef.current);
        setCursor(draftRef.current.length);
      } else {
        showHistory(next);
      }
      return;
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(value.length, c + 1));
      return;
    }
    if (key.home) {
      setCursor(0);
      return;
    }
    if (key.end) {
      setCursor(value.length);
      return;
    }
    if (key.backspace) {
      if (cursor > 0) apply(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      return;
    }
    if (key.delete) {
      if (cursor < value.length) apply(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
      return;
    }
    if (key.ctrl) {
      // Shell-style line editing.
      if (input === 'a') setCursor(0);
      if (input === 'e') setCursor(value.length);
      if (input === 'u') apply(value.slice(cursor), 0);
      if (input === 'k') apply(value.slice(0, cursor), cursor);
      if (input === 'w') {
        const head = value.slice(0, cursor);
        const kept = /\S/.test(head) ? head.replace(/\S+\s*$/, '') : '';
        apply(kept + value.slice(cursor), kept.length);
      }
      return;
    }
    if (key.escape || key.meta || key.tab) return;
    if (!input) return;
    // Terminals without bracketed paste deliver a paste as one multi-char
    // chunk here; insert it like the paste channel does. A lone newline is
    // still a submit (some terminals send Enter as a bare \n or \r chunk).
    if (/^[\r\n]+$/.test(input)) {
      submit(value);
      return;
    }
    insert(normalizeNewlines(input));
  });

  const atCursor = value[cursor];
  const afterCursor =
    atCursor === undefined ? '' : atCursor === '\n' ? value.slice(cursor) : value.slice(cursor + 1);

  return (
    <Box borderStyle="round" borderDimColor paddingX={1}>
      <Box marginRight={1} flexShrink={0}>
        <Text dimColor>{'>'}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text>
          {value.slice(0, cursor)}
          <Text inverse>{atCursor && atCursor !== '\n' ? atCursor : ' '}</Text>
          {afterCursor}
          {value ? null : <Text dimColor> send a message · ↑ history · /help for commands</Text>}
        </Text>
      </Box>
    </Box>
  );
}
