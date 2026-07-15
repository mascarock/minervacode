import { Box, Text } from 'ink';
import {
  parseMarkdown,
  type InlineSegment,
  type MarkdownBlock,
} from '../ui/markdown.js';
import { ACCENT } from './theme.js';

function Segments({ segments }: { segments: InlineSegment[] }) {
  return (
    <Text>
      {segments.map((seg, i) => (
        <Text
          key={i}
          bold={seg.bold}
          italic={seg.italic}
          strikethrough={seg.strike}
          underline={seg.underline}
          dimColor={seg.dim}
          color={seg.code ? ACCENT : undefined}
        >
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}

function BlockView({ block }: { block: MarkdownBlock }) {
  switch (block.kind) {
    case 'heading':
      return (
        <Text bold color={block.level <= 2 ? ACCENT : undefined}>
          <Segments segments={block.segments} />
        </Text>
      );
    case 'code':
      return (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderDimColor
          paddingLeft={1}
        >
          {block.lang ? <Text dimColor>{block.lang}</Text> : null}
          {block.content ? <Text>{block.content}</Text> : null}
        </Box>
      );
    case 'list-item':
      return (
        <Box paddingLeft={block.indent * 2}>
          <Box marginRight={1} flexShrink={0}>
            <Text dimColor>{block.marker}</Text>
          </Box>
          <Box flexGrow={1}>
            <Segments segments={block.segments} />
          </Box>
        </Box>
      );
    case 'quote':
      return (
        <Box
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderDimColor
          paddingLeft={1}
        >
          <Text italic dimColor>
            <Segments segments={block.segments} />
          </Text>
        </Box>
      );
    case 'hr':
      return <Text dimColor>{'─'.repeat(30)}</Text>;
    case 'paragraph':
      return <Segments segments={block.segments} />;
  }
}

/** Consecutive list items group tightly; every other block gets air. */
function gapBefore(prev: MarkdownBlock, block: MarkdownBlock): number {
  return prev.kind === 'list-item' && block.kind === 'list-item' ? 0 : 1;
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => (
        <Box
          key={i}
          flexDirection="column"
          marginTop={i > 0 ? gapBefore(blocks[i - 1], block) : 0}
        >
          <BlockView block={block} />
        </Box>
      ))}
    </Box>
  );
}
