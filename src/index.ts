#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { MinervaClient } from './api/client.js';
import { clearConfig } from './auth/store.js';
import { runRepl, runInfo, runChatOnce, runLoginFlow, ensureConfig } from './repl.js';

const program = new Command();

program
  .name('minervacli')
  .description('Terminal chat client for Chat Minerva')
  .version('0.1.0')
  .argument('[prompt]', 'Send a one-shot message and exit')
  .option('--headless', 'Run browser login headless')
  .action(async (prompt: string | undefined, opts: { headless?: boolean }) => {
    try {
      if (prompt) {
        const config = await ensureConfig();
        const client = new MinervaClient(config);
        await runChatOnce(client, prompt);
        return;
      }
      await runRepl();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error: ${msg}`));
      process.exit(1);
    }
  });

program
  .command('login')
  .description('Authenticate with Chat Minerva (opens your default browser)')
  .option('--email <email>', 'Account email (optional: auto-fill via Chrome)')
  .option('--password <password>', 'Account password (optional: auto-fill via Chrome)')
  .option('--token <token>', 'Paste JWT token directly (skip browser)')
  .option('--headless', 'Run Chrome headless when using --email/--password')
  .action(async (opts: { email?: string; password?: string; token?: string; headless?: boolean }) => {
    try {
      await runLoginFlow(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Login failed: ${msg}`));
      process.exit(1);
    }
  });

program
  .command('logout')
  .description('Clear saved credentials')
  .action(async () => {
    await clearConfig();
    console.log(chalk.yellow('Logged out.\n'));
  });

program
  .command('info')
  .description('Show session and platform info')
  .action(async () => {
    try {
      const config = await ensureConfig();
      const client = new MinervaClient(config);
      await runInfo(client, config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error: ${msg}`));
      process.exit(1);
    }
  });

program.parse();
