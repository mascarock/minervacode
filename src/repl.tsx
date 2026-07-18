import chalk from 'chalk';
import { render } from 'ink';
import { MinervaClient } from './api/client.js';
import type { MinervaConfig } from './types.js';
import { validateSession } from './api/auth.js';
import { modelSupportsWebSearch, getDefaultModel } from './api/models.js';
import { runAgent } from './agent/loop.js';
import { ChangeLog } from './agent/context.js';
import { revertNetChanges } from './agent/rollback.js';
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

/** Returns false when the run ended without a verified, complete result. */
export async function runChatOnce(
  client: MinervaClient,
  prompt: string,
  agent: AgentSettings,
): Promise<boolean> {
  const changeLog = new ChangeLog();
  const permissionMode = agent.permissionMode ?? (agent.auto ? 'dontAsk' : 'default');
  if (agent.webSearch) {
    const model = await getDefaultModel(client);
    if (!modelSupportsWebSearch(model)) {
      console.log(
        chalk.yellow(
          '  ⚠ --web is on, but the current model does not advertise web_search — Open WebUI may ignore it until an admin enables it on Chat Minerva.',
        ),
      );
    }
  }
  const result = await runAgent(client, {
    history: [],
    prompt,
    projectDir: agent.projectDir,
    permissionMode,
    language: agent.language,
    webSearch: agent.webSearch,
    events: consoleAgentEvents(),
    changeLog,
  });

  // A completed run whose changes had no applicable verifier counts as
  // success (verified === null); anything else incomplete is a failure.
  const succeeded = result.status === 'completed' && result.verified !== false;

  // Unattended run that ended incomplete or with failing checks: leaving a
  // silently broken project behind is worse than doing nothing — restore it.
  if (!succeeded && permissionMode === 'dontAsk' && result.netChanges.length) {
    const reverted = await revertNetChanges(agent.projectDir, result.netChanges);
    const reason =
      result.verified === false ? 'verification failed' : `run ended with status "${result.status}"`;
    console.log(
      chalk.yellow(
        `\n  ⚠ ${reason} — reverted: ${reverted.join(', ') || '(nothing revertable)'}`,
      ),
    );
    console.log(
      chalk.dim(
        '  Minerva (a 7B model) often cannot finish a task autonomously. Run without --auto to work through it step by step.',
      ),
    );
    return false;
  }

  if (!succeeded && permissionMode === 'dontAsk' && !result.netChanges.length) {
    const reason = result.status === 'no-change'
      ? 'no applicable file change was produced'
      : `run ended with status "${result.status}"`;
    console.log(chalk.yellow(`\n  ⚠ ${reason}.`));
    console.log(
      chalk.dim(
        '  Minerva (a 7B model) often cannot finish a task autonomously. Run without --auto to work through it step by step.',
      ),
    );
  }

  if (result.changes.length) {
    const files = [...new Set(result.changes.map((c) => c.path))];
    console.log(chalk.dim(`\n  changed: ${files.join(', ')}`));
  }
  if (result.verified === false) {
    console.log(chalk.yellow('\n  ⚠ Changes were not successfully verified.'));
  }
  // Show the real evidence: the check that ran and what it printed. The
  // harness proves the code compiled/ran/passed — whether the OUTPUT is what
  // the student wanted is theirs to confirm.
  if (succeeded && result.verification?.ok) {
    const { command, output, source } = result.verification;
    console.log(chalk.dim(`\n  verified (${source}): $ ${command}`));
    const lines = output.split('\n').slice(0, 10);
    for (const line of lines) console.log(`    ${line}`);
    if (output.split('\n').length > 10) console.log(chalk.dim('    …'));
    if (source === 'compile and run') {
      console.log(chalk.dim('  ↑ program output — confirm it matches what you asked for.'));
    }
  }
  return succeeded;
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

    console.log(chalk.dim('Goodbye!\n'));
    return;
  }
}

export { runLoginFlow, ensureConfig };
