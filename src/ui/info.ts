import chalk from 'chalk';
import type { SessionInfo } from '../types.js';

function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return 'unknown';
  return new Date(unixSeconds * 1000).toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function sessionInfoLines(info: SessionInfo): string[] {
  const { user, platform, model } = info;
  const modelName = model?.name ?? info.config.model;
  const caps = model?.info?.meta?.capabilities;
  const capParts: string[] = [];
  if (caps?.vision) capParts.push('vision');
  if (caps?.file_upload) capParts.push('files');
  if (caps?.web_search) capParts.push('web');

  const lines = [
    `model: ${modelName} · Open WebUI ${platform.version}`,
    `${user.email} · token valid until ${formatDate(user.expires_at)}`,
  ];
  if (capParts.length) {
    lines.push(`caps: ${capParts.join(', ')}`);
  }
  return lines;
}

export const HELP_LINES = [
  '/help    show this help',
  '/info    show session info',
  '/model   switch model',
  '/auto    toggle auto mode (on|off) — assisted asks before changes',
  '/tools   list agent tools',
  '/diff    show changes applied this session',
  '/clear   clear conversation history',
  '/login   re-authenticate',
  '/logout  clear saved credentials',
  '/exit    quit',
];

export function printSessionInfo(info: SessionInfo): void {
  console.log('');
  console.log(`${chalk.hex('#d97757')('✻')} ${chalk.bold('Minerva CLI')}`);
  console.log('');
  for (const line of sessionInfoLines(info)) {
    console.log(chalk.dim(`  ${line}`));
  }
  console.log('');
}

export function printHelp(): void {
  console.log('');
  for (const line of HELP_LINES) {
    console.log(chalk.dim(`  ${line}`));
  }
  console.log('');
}
