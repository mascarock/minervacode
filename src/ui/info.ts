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

function truncateEmail(email: string, max = 24): string {
  if (email.length <= max) return email;
  const [local, domain] = email.split('@');
  if (!domain) return email.slice(0, max - 1) + '…';
  const keep = max - domain.length - 2;
  return `${local.slice(0, Math.max(keep, 3))}…@${domain}`;
}

export function printSessionInfo(info: SessionInfo): void {
  const { user, platform, model } = info;
  const modelName = model?.name ?? info.config.model;
  const caps = model?.info?.meta?.capabilities;
  const capParts: string[] = [];
  if (caps?.vision) capParts.push('vision');
  if (caps?.file_upload) capParts.push('files');
  if (caps?.web_search) capParts.push('web');

  const lines = [
    `User:   ${user.name} (${truncateEmail(user.email)})`,
    `Model:  ${modelName}`,
    `API:    Open WebUI ${platform.version}`,
    `Token:  valid until ${formatDate(user.expires_at)}`,
  ];
  if (capParts.length) {
    lines.push(`Caps:   ${capParts.join(', ')}`);
  }

  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const border = '─'.repeat(width - 2);

  console.log('');
  console.log(chalk.cyan(`  ╭─ Minerva CLI ${border.slice(13)}╮`));
  for (const line of lines) {
    const padded = line.padEnd(width - 4);
    console.log(chalk.cyan(`  │ ${padded} │`));
  }
  console.log(chalk.cyan(`  ╰${border}╯`));
  console.log('');
}

export function printHelp(): void {
  console.log(chalk.bold('\nCommands:'));
  console.log('  /help    Show this help');
  console.log('  /info    Show session info');
  console.log('  /model   List or switch model');
  console.log('  /clear   Clear conversation history');
  console.log('  /login   Re-authenticate');
  console.log('  /logout  Clear saved credentials');
  console.log('  /exit    Quit\n');
}
