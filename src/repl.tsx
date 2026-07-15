import chalk from 'chalk';
import { render } from 'ink';
import { MinervaClient } from './api/client.js';
import type { MinervaConfig } from './types.js';
import { validateSession } from './api/auth.js';
import { runAgent } from './agent/loop.js';
import { consoleAgentEvents } from './ui/agent-console.js';
import { browserLogin, loginWithToken } from './auth/browser-login.js';
import {
  loadConfig,
  saveConfig,
  clearConfig,
  isTokenExpired,
} from './auth/store.js';
import { gatherSessionInfo } from './session.js';
import { printSessionInfo } from './ui/info.js';
import { App, type AgentSettings, type ReplAction } from './tui/App.js';

async function ensureConfig(): Promise<MinervaConfig> {
  let config = await loadConfig();

  if (config && !isTokenExpired(config)) {
    const client = new MinervaClient(config);
    if (await validateSession(client)) {
      return config;
    }
  }

  console.log(chalk.dim('\nNot logged in. Starting login...\n'));
  return runLoginFlow();
}

async function runLoginFlow(options?: {
  email?: string;
  password?: string;
  token?: string;
  headless?: boolean;
}): Promise<MinervaConfig> {
  if (options?.token) {
    const config = await loginWithToken(options.token);
    await saveConfig(config);
    console.log(chalk.dim(`\nLogged in as ${config.email}\n`));
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
      console.log(chalk.dim(`\nLogged in as ${config.email}\n`));
      return config;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.yellow(`Automated login failed: ${msg}`));
      console.log(chalk.yellow('Falling back to system browser...\n'));
    }
  }

  const config = await browserLogin();
  await saveConfig(config);
  console.log(chalk.dim(`\nLogged in as ${config.email}\n`));
  return config;
}

export async function runInfo(client: MinervaClient, config: MinervaConfig): Promise<void> {
  const info = await gatherSessionInfo(client, config);
  printSessionInfo(info);
}

export async function runChatOnce(
  client: MinervaClient,
  prompt: string,
  agent: AgentSettings,
): Promise<void> {
  await runAgent(client, {
    history: [],
    prompt,
    projectDir: agent.projectDir,
    permissionMode: agent.permissionMode ?? (agent.auto ? 'acceptEdits' : 'default'),
    assisted: !agent.auto,
    events: consoleAgentEvents(),
  });
}

export async function runRepl(agent: AgentSettings, initialConfig?: MinervaConfig): Promise<void> {
  let config = initialConfig ?? (await ensureConfig());

  while (true) {
    const client = new MinervaClient(config);
    const sessionInfo = await gatherSessionInfo(client, config);

    let action = 'exit' as ReplAction;
    const app = render(
      <App
        client={client}
        config={config}
        sessionInfo={sessionInfo}
        agent={agent}
        onAction={(a) => {
          action = a;
        }}
      />,
    );
    await app.waitUntilExit();

    if (action === 'login') {
      config = await runLoginFlow();
      continue;
    }

    if (action === 'logout') {
      await clearConfig();
      console.log(chalk.dim('Logged out.\n'));
      return;
    }

    console.log(chalk.dim('Arrivederci!\n'));
    return;
  }
}

export { runLoginFlow, ensureConfig };
