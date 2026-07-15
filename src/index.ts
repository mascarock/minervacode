#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { MinervaClient } from './api/client.js';
import { clearConfig } from './auth/store.js';
import { runRepl, runInfo, runChatOnce, runLoginFlow, ensureConfig } from './repl.js';
import { PERMISSION_MODES, type PermissionMode } from './agent/permissions.js';
import {
  AGENT_LANGUAGES,
  PROJECT_CONTEXT_FILE,
  PROJECT_CONTEXT_TEMPLATE,
  type AgentLanguage,
} from './agent/prompts.js';
import { collectGitDiff, runReview, type ReviewSeverity } from './agent/review.js';
import type { AgentSettings } from './tui/App.js';
import { CLI_VERSION } from './version.js';

const program = new Command();

function parsePermissionMode(value: string): PermissionMode {
  if (!PERMISSION_MODES.includes(value as PermissionMode)) {
    throw new InvalidArgumentError(`Must be one of: ${PERMISSION_MODES.join(', ')}`);
  }
  return value as PermissionMode;
}

function parseLanguage(value: string): AgentLanguage {
  if (!AGENT_LANGUAGES.includes(value as AgentLanguage)) {
    throw new InvalidArgumentError(`Must be one of: ${AGENT_LANGUAGES.join(', ')}`);
  }
  return value as AgentLanguage;
}

interface MainOptions {
  auto?: boolean;
  projectDir: string;
  permissionMode?: PermissionMode;
  language: AgentLanguage;
  init?: boolean;
  headless?: boolean;
}

function agentSettings(opts: MainOptions): AgentSettings {
  return {
    projectDir: path.resolve(opts.projectDir),
    auto: opts.auto ?? false,
    permissionMode: opts.permissionMode,
    language: opts.language,
  };
}

async function scaffoldProjectContext(projectDir: string): Promise<void> {
  const file = path.join(path.resolve(projectDir), PROJECT_CONTEXT_FILE);
  if (existsSync(file)) {
    console.log(chalk.yellow(`${file} already exists — not overwriting.`));
    return;
  }
  await writeFile(file, PROJECT_CONTEXT_TEMPLATE, 'utf-8');
  console.log(chalk.dim(`Created ${file} — describe your project there.`));
}

program
  .name('minervacli')
  .description('Terminal chat client and coding agent for Chat Minerva')
  .version(CLI_VERSION)
  // Without this, the root --project-dir option swallows the identically
  // named option of subcommands like `review`.
  .enablePositionalOptions()
  .argument('[prompt]', 'Send a one-shot message and exit')
  .option('--auto', 'Full autonomous agent (default: assisted, approve each change)')
  .option('--project-dir <dir>', 'Project root the agent works in', process.cwd())
  .option('--permission-mode <mode>', 'default | acceptEdits | dontAsk', parsePermissionMode)
  .option('--language <language>', 'Reply language: auto | en | it', parseLanguage, 'auto')
  .option('--init', `Scaffold a ${PROJECT_CONTEXT_FILE} project context file and exit`)
  .option('--headless', 'Run browser login headless')
  .action(async (prompt: string | undefined, opts: MainOptions) => {
    try {
      if (opts.init) {
        await scaffoldProjectContext(opts.projectDir);
        return;
      }
      const agent = agentSettings(opts);
      if (prompt) {
        const config = await ensureConfig();
        const client = new MinervaClient(config);
        const ok = await runChatOnce(client, prompt, agent);
        if (!ok) process.exitCode = 1;
        return;
      }
      await runRepl(agent);
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

const SEVERITY_COLOR: Record<ReviewSeverity, (s: string) => string> = {
  bug: chalk.red,
  warn: chalk.yellow,
  nit: chalk.dim,
};

program
  .command('review')
  .description('Ask Minerva to review pending git changes in the project')
  .option('--project-dir <dir>', 'Project root to review', process.cwd())
  .option('--language <language>', 'Reply language: auto | en | it', parseLanguage, 'auto')
  .action(async (opts: { projectDir: string; language: AgentLanguage }) => {
    try {
      const projectDir = path.resolve(opts.projectDir);
      const diff = await collectGitDiff(projectDir);
      if (!diff) {
        console.log(chalk.dim('Nothing to review — no pending git changes.'));
        return;
      }
      const config = await ensureConfig();
      const client = new MinervaClient(config);
      console.log(chalk.dim('Reviewing pending git diff…'));
      const review = await runReview(client, { diff, language: opts.language });
      if (review.findings.length) {
        console.log('');
        for (const finding of review.findings) {
          const tag = `[${finding.severity.toUpperCase()}]`;
          console.log(`  ${SEVERITY_COLOR[finding.severity](tag)} ${finding.text}`);
        }
        console.log('');
      } else {
        console.log(`\n● ${review.raw.replaceAll('\n', '\n  ')}\n`);
      }
      process.exitCode = review.hasBugs ? 1 : 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Review failed: ${msg}`));
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
