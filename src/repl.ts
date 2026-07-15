import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import { input as promptInput } from '@inquirer/prompts';
import { MinervaClient } from './api/client.js';
import type { MinervaConfig, ChatMessage } from './types.js';
import { streamChat } from './api/chat.js';
import { listModels } from './api/models.js';
import { validateSession } from './api/auth.js';
import { browserLogin, loginWithToken } from './auth/browser-login.js';
import {
  loadConfig,
  saveConfig,
  clearConfig,
  isTokenExpired,
} from './auth/store.js';
import { gatherSessionInfo } from './session.js';
import { printLogo } from './ui/logo.js';
import { printSessionInfo, printHelp } from './ui/info.js';
import { endStreamLine } from './ui/stream.js';

async function ensureConfig(): Promise<MinervaConfig> {
  let config = await loadConfig();

  if (config && !isTokenExpired(config)) {
    const client = new MinervaClient(config);
    if (await validateSession(client)) {
      return config;
    }
  }

  console.log(chalk.yellow('\nNot logged in. Starting login...\n'));
  return runLoginFlow();
}

async function runLoginFlow(options?: {
  email?: string;
  password?: string;
  token?: string;
  headless?: boolean;
  browserOnly?: boolean;
}): Promise<MinervaConfig> {
  if (options?.token) {
    const config = await loginWithToken(options.token);
    await saveConfig(config);
    console.log(chalk.green(`\nLogged in as ${config.email}\n`));
    return config;
  }

  if (options?.email && options?.password) {
    console.log(chalk.dim('\nTrying automated login in Chrome (reCAPTCHA required)...\n'));
    try {
      const config = await browserLogin({
        email: options.email,
        password: options.password,
        headless: options?.headless ?? false,
      });
      await saveConfig(config);
      console.log(chalk.green(`\nLogged in as ${config.email}\n`));
      return config;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.yellow(`Automated login failed: ${msg}`));
      console.log(chalk.yellow('Falling back to system browser...\n'));
    }
  }

  const config = await browserLogin({ browserOnly: true });
  await saveConfig(config);
  console.log(chalk.green(`\nLogged in as ${config.email}\n`));
  return config;
}

export async function runInfo(client: MinervaClient, config: MinervaConfig): Promise<void> {
  const info = await gatherSessionInfo(client, config);
  printSessionInfo(info);
}

export async function runChatOnce(
  client: MinervaClient,
  prompt: string,
  messages: ChatMessage[] = [],
): Promise<string> {
  const history = [...messages, { role: 'user' as const, content: prompt }];
  console.log(chalk.bold.cyan('\nMinerva ›'));
  const reply = await streamChat(client, history);
  endStreamLine();
  console.log('');
  return reply;
}

export async function runRepl(initialConfig?: MinervaConfig): Promise<void> {
  await printLogo();

  let config = initialConfig ?? (await ensureConfig());
  let client = new MinervaClient(config);
  let messages: ChatMessage[] = [];

  const info = await gatherSessionInfo(client, config);
  printSessionInfo(info);
  printHelp();

  const rl = readline.createInterface({ input, output, terminal: true });

  const prompt = () => rl.question(chalk.green('You › '));

  try {
    while (true) {
      const line = (await prompt()).trim();
      if (!line) continue;

      if (line.startsWith('/')) {
        const cmd = line.toLowerCase();

        if (cmd === '/exit' || cmd === '/quit') {
          console.log(chalk.dim('Arrivederci!\n'));
          break;
        }

        if (cmd === '/help') {
          printHelp();
          continue;
        }

        if (cmd === '/info') {
          await runInfo(client, config);
          continue;
        }

        if (cmd === '/clear') {
          messages = [];
          console.log(chalk.dim('Conversation cleared.\n'));
          continue;
        }

        if (cmd === '/logout') {
          await clearConfig();
          console.log(chalk.yellow('Logged out.\n'));
          break;
        }

        if (cmd === '/login') {
          config = await runLoginFlow();
          client = new MinervaClient(config);
          messages = [];
          await runInfo(client, config);
          continue;
        }

        if (cmd === '/model') {
          const models = await listModels(client);
          console.log(chalk.bold('\nAvailable models:'));
          models.forEach((m, i) => {
            const active = m.id === config.model ? chalk.green(' (active)') : '';
            console.log(`  ${i + 1}. ${m.name} [${m.id}]${active}`);
          });
          const choice = await promptInput({
            message: 'Select model number (empty to cancel):',
          });
          const idx = parseInt(choice, 10) - 1;
          if (idx >= 0 && idx < models.length) {
            config = { ...config, model: models[idx].id };
            client.updateConfig(config);
            await saveConfig(config);
            console.log(chalk.green(`\nModel set to ${models[idx].name}\n`));
          }
          continue;
        }

        console.log(chalk.yellow(`Unknown command: ${line}. Type /help\n`));
        continue;
      }

      try {
        console.log(chalk.bold.cyan('\nMinerva ›'));
        const reply = await streamChat(client, [...messages, { role: 'user', content: line }]);
        endStreamLine();
        console.log('');
        messages.push({ role: 'user', content: line });
        messages.push({ role: 'assistant', content: reply });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`\nError: ${msg}\n`));
      }
    }
  } finally {
    rl.close();
  }
}

export { runLoginFlow, ensureConfig };
