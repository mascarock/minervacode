import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import type { AgentEvents } from '../agent/loop.js';

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
      console.log(`\n● ${text.replaceAll('\n', '\n  ')}\n`);
    },
    onToolStart(event) {
      console.log(chalk.dim(`  [${event.tool.name}] ${event.summary}`));
    },
    onToolEnd(event) {
      const summary = `    ⎿ ${firstLine(event.result)}`;
      console.log(event.ok ? chalk.dim(summary) : chalk.red(summary));
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
