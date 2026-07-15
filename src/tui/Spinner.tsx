import { useEffect, useState } from 'react';
import { Text } from 'ink';
import { ACCENT } from './theme.js';

const FRAMES = ['✳', '✢', '·', '✢', '✳', '✶', '✻', '✶'];

export function Spinner({ startedAt }: { startedAt: number }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 150);
    return () => clearInterval(timer);
  }, []);

  const elapsed = Math.floor((Date.now() - startedAt) / 1000);

  return (
    <Text>
      <Text color={ACCENT}>{FRAMES[tick % FRAMES.length]}</Text>
      <Text dimColor>
        {' '}
        Thinking… ({elapsed}s · esc to interrupt)
      </Text>
    </Text>
  );
}
