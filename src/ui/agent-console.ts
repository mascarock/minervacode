import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import type { AgentEvents } from '../agent/loop.js';
import { renderMarkdownAnsi } from './markdown.js';

export function diffLineColor(line: string): 'green' | 'red' | 'cyan' | null {
  if (line.startsWith('+++') || line.startsWith('---')) return null;
  if (line.startsWith('+')) return 'green';
  if (line.startsWith('-')) return 'red';
  if (line.startsWith('@@')) return 'cyan';
  return null;
}

function renderDiffAnsi(patch: string): string {
  return patch
    .split('\n')
    .map((line) => {
      switch (diffLineColor(line)) {
        case 'green':
          return chalk.green(line);
        case 'red':
          return chalk.red(line);
        case 'cyan':
          return chalk.cyan(line);
        default:
          return chalk.dim(line);
      }
    })
    .join('\n');
}

function firstLine(text: string, max = 100): string {
  const line = text.split('\n', 1)[0];
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** First informative lines of a failed result — an error message whose first
 * line is just "Command failed (exit 1):" would otherwise hide everything. */
function errorLines(text: string, maxLines = 6, max = 160): string[] {
  const lines = text.split('\n').filter((l) => l.trim());
  const shown = lines
    .slice(0, maxLines)
    .map((l) => (l.length > max ? `${l.slice(0, max)}…` : l));
  if (lines.length > maxLines) shown.push(`… (${lines.length - maxLines} more lines)`);
  return shown;
}

function indent(text: string, pad = '  '): string {
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

/** Plain-stdout agent events for one-shot mode. */
export function consoleAgentEvents(): AgentEvents {
  return {
    onText(text) {
      console.log(`\n● ${renderMarkdownAnsi(text).replaceAll('\n', '\n  ')}\n`);
    },
    onStatus(text) {
      console.log(chalk.dim(`  ◦ ${text}`));
    },
    onToolStart(event) {
      console.log(chalk.dim(`  [${event.tool.name}] ${event.summary}`));
    },
    onToolEnd(event) {
      if (event.ok) {
        console.log(chalk.dim(`    ⎿ ${firstLine(event.result)}`));
        return;
      }
      const [head, ...rest] = errorLines(event.result);
      console.log(chalk.red(`    ⎿ ${head ?? '(no output)'}`));
      for (const line of rest) console.log(chalk.red(`      ${line}`));
    },
    async confirm(event) {
      console.log('');
      console.log(chalk.bold(`  ${event.tool.name}: ${event.summary}`));
      console.log(indent(renderDiffAnsi(event.preview)));
      console.log('');
      try {
        return await confirm({ message: `Run ${event.tool.name}?`, default: true });
      } catch {
        return false; // closed stdin / ctrl+c on the prompt = deny
      }
    },
  };
}
