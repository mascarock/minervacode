import chalk from 'chalk';
import { input as promptInput } from '@inquirer/prompts';
import { DEFAULT_BASE_URL } from './store.js';
import { openInSystemBrowser } from './system-browser.js';
import { loginWithToken } from './browser-login.js';
import type { MinervaConfig } from '../types.js';

export async function manualBrowserLogin(baseUrl = DEFAULT_BASE_URL): Promise<MinervaConfig> {
  const authUrl = `${baseUrl}/auth`;

  console.log(chalk.cyan('\nOpening Chat Minerva in your default browser...\n'));
  await openInSystemBrowser(authUrl);

  console.log(chalk.dim('After you sign in:'));
  console.log(chalk.dim('  1. Press F12 (or Cmd+Option+I on Mac)'));
  console.log(chalk.dim('  2. Go to Application → Local Storage → https://chatminerva.org'));
  console.log(chalk.dim('  3. Copy the value of the "token" key\n'));

  const token = await promptInput({
    message: 'Paste your token:',
    validate: (v) => (v.trim() ? true : 'Token is required'),
  });

  return loginWithToken(token.trim(), baseUrl);
}
