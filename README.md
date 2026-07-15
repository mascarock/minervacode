# Minerva CLI

A terminal chat client and **coding agent** for [Chat Minerva](https://chatminerva.org) — the Italian AI assistant based on the Minerva LLM (Sapienza NLP & Babelscape).

Chat Minerva runs on **Open WebUI v0.7.2**. This CLI lets you log in and chat from a Claude Code-style terminal UI, and lets Minerva **write, execute, and review** code in your project: it applies changes, runs your tests to verify them, reviews its own diff, and fixes what it finds — every change shown as a diff you approve first (assisted mode) or applied autonomously (`--auto`).

![Auto mode: write → verify → review](assets/demo-agent.svg)

## Requirements

- Node.js 22+
- A web browser (Chrome, Safari, Firefox, etc.) — used for login only
- Playwright + Chrome (optional) — only needed for automated `--email`/`--password` login

## Installation

```bash
git clone git@github.com:mascarock/minervacli.git
cd minervacli
npm install
npm run build
npm link   # optional: install `minervacli` globally
```

Or run without linking:

```bash
npm run dev          # interactive REPL
node dist/index.js   # same, after build
```

## Usage

### Login

```bash
minervacli login
```

You'll be prompted for your email and password. A Chrome window opens automatically, handles reCAPTCHA, signs you in, and saves the token — you don't need to touch the browser.

**If Chrome is not available**, it falls back to opening your default browser and asking you to paste the token manually.

**Or paste a token directly** (skip the browser entirely):

```bash
minervacli login --token <your-jwt>
```

Credentials are stored in `~/.minervacli/config.json` (mode 0600).

### Session info

```bash
minervacli info
```

### One-shot chat

```bash
minervacli "Ciao Minerva, come stai?"
```

### Interactive REPL

```bash
minervacli
```

Slash commands inside the REPL:

| Command | Description |
|---------|-------------|
| `/help` | Show commands |
| `/info` | Show session info |
| `/model` | List or switch model |
| `/auto` | Toggle auto mode (`/auto on`, `/auto off`) |
| `/dir` | Show or change the project directory the agent works in |
| `/language` | Set reply language (`auto`, `en`, or `it`) |
| `/tools` | List agent tools |
| `/diff` | Show changes applied this session |
| `/review` | Ask Minerva to review this session's changes (or the pending git diff) |
| `/clear` | Clear conversation history |
| `/login` | Re-authenticate |
| `/logout` | Clear saved credentials |
| `/exit` | Quit |

### Coding agent (per studenti)

Point Minerva at your homework folder and ask it to explain or fix things:

```bash
minervacli --project-dir ~/compiti "c'è un bug in utils.py, trovalo e correggilo"
```

**Assisted mode (default)** — Minerva proposes changes; the CLI shows a
unified diff and asks `y/n` before touching any file. Shell commands ask
too. Good for learning: you see and approve every change.

![Assisted mode approval prompt](assets/demo-assisted.svg)

**Auto mode** — the full agentic loop, no questions asked:

```bash
minervacli --auto --project-dir ~/compiti "scrivi i test per utils.py"
```

1. **Write** — Minerva's edits are applied directly (structured tool calls
   or full-file code blocks). Writes to test files are refused unless your
   request explicitly asks to create or change tests — a weak model must
   not "fix" a failure by rewriting the tests.
2. **Execute & verify** — after every verifiable code change the CLI runs a
   verification command and feeds the output back so Minerva can fix
   failures. The command is picked in this order: the `Test:` line of
   `.minervacli.md` → the `package.json` `test`, `typecheck`, or `build`
   script (npm/yarn/pnpm/bun detected from the lockfile) → `pytest` /
   `unittest` if test files exist → `tsc --noEmit` if `tsconfig.json`
   exists → a syntax check of the changed files.
3. **Review** — when Minerva stops, the CLI asks it to review its own
   accumulated diff (tracing each changed function on a concrete input);
   `[BUG]` findings trigger one more fix cycle.

If a one-shot `--auto` run ends incomplete or with failed verification, the
CLI **rolls back every file the run changed or created**, prints why, and
exits nonzero — safe to use in scripts and CI. In the interactive REPL,
failed changes are kept (with a warning) so you can inspect them with
`/diff`.

Flags:

| Flag | Description |
|------|-------------|
| `--project-dir <dir>` | Project root the agent works in (default: cwd) |
| `--auto` | Auto mode: run edits and shell commands without asking |
| `--permission-mode <m>` | `default` \| `acceptEdits` \| `dontAsk` |
| `--language <language>` | Reply language: `auto` (match request) \| `en` \| `it` |
| `--init` | Scaffold a `.minervacli.md` project context file |

### Standalone code review

Review the pending git changes of any project (also handy in CI — exits 1
when the review finds a `[BUG]`):

```bash
minervacli review --project-dir ~/compiti
```

Inside the REPL, `/review` reviews the changes Minerva made this session,
falling back to the pending git diff.

### Project context

Create a `.minervacli.md` in your project (via `--init`) to give Minerva
standing context — what the project is, how to run it, your professor's
constraints. Minerva reads it at the start of every session, and the
agent uses its `Test:` command line to verify changes:

```markdown
## Commands

- Run: `python main.py`
- Test: `python -m pytest`
```

**How it works under the hood:** Chat Minerva's API exposes no native
function calling (and drops `system` messages entirely), so the CLI
injects your project files into the conversation, parses structured tool
blocks (`<minerva_tool>`, fenced JSON) and full-file code-block proposals
out of the model's replies, and executes Read/Glob/Grep/Write/Edit/Bash
locally — gated by the permission mode.

Minerva is a **7B model**, so the harness does the heavy lifting to keep
it honest:

- **Partial-write protection** — when a code block only re-states some of
  a file's functions, the CLI merges those functions into the existing
  file instead of overwriting it (a 7B loves to "fix one function" by
  deleting the rest).
- **Format nudging** — if Minerva claims it changed something without
  emitting an applicable change, the CLI restates the expected format once
  and asks again.
- **Deterministic verification** — tests are run by the CLI, not by the
  model's goodwill; the model only sees (and reacts to) real output.
- **Guardrails** — file paths are validated against the project listing,
  writes outside the project directory are rejected, and the review pass
  ignores findings that just echo the instruction template.

Expect to guide it, and keep assisted mode on while you're learning.

### Logout

```bash
minervacli logout
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MINERVA_BASE_URL` | `https://chatminerva.org` | API base URL |

## How it works

1. **Login** — Opens `chatminerva.org/auth` in your default system browser. Google reCAPTCHA blocks direct API login, so a real browser is required. You copy the JWT from DevTools and paste it in the terminal.
2. **Token** — Saved locally in `~/.minervacli/config.json`.
3. **Chat** — Messages sent to `POST /api/chat/completions` with SSE streaming, same as the web UI.

## License

MIT
