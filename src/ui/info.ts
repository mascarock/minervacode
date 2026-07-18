import chalk from 'chalk';
import type { SessionInfo } from '../types.js';
import { CLI_VERSION } from '../version.js';

function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return 'unknown';
  return new Date(unixSeconds * 1000).toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '****@****.***';

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  const visibleLocal = local.slice(0, Math.min(2, local.length));

  return `${visibleLocal}****@****${tld}`;
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
    `${maskEmail(user.email)} · token valid until ${formatDate(user.expires_at)}`,
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
  '/auto    toggle experimental auto mode (on|off) — assisted asks before changes',
  '/dir     show or change the project directory the agent works in',
  '/language set reply language (auto|en|it)',
  '/web     toggle Open WebUI web search (on|off)',
  '/repomap show the ranked repository structure (/repomap <focus>)',
  '/context show context use and compact old bulk if needed',
  '/tools   list agent tools',
  '/copy    copy the newest code block to the clipboard (/copy 2 = one older)',
  '/diff    show changes applied this session',
  '/review  ask Minerva to review session changes (or the git diff)',
  '/clear   clear conversation history',
  '/login   re-authenticate',
  '/logout  clear saved credentials',
  '/exit    quit',
];

export function printSessionInfo(info: SessionInfo): void {
  console.log('');
  console.log(`${chalk.hex('#d97757')('✻')} ${chalk.bold(`MinervaCode v${CLI_VERSION}`)}`);
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
