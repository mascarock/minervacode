# Minerva CLI

A terminal chat client and **coding agent** for [Chat Minerva](https://chatminerva.org) — the Italian AI assistant based on the Minerva LLM (Sapienza NLP & Babelscape).

Chat Minerva runs on **Open WebUI v0.7.2**. This CLI lets you log in and chat from a Claude Code-style terminal UI, and lets Minerva read and fix the files in your project — every change shown as a diff you approve first.

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
| `/tools` | List agent tools |
| `/diff` | Show changes applied this session |
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

**Auto mode** — file edits apply without asking (shell commands still ask):

```bash
minervacli --auto --project-dir ~/compiti "scrivi i test per utils.py"
```

Flags:

| Flag | Description |
|------|-------------|
| `--project-dir <dir>` | Project root the agent works in (default: cwd) |
| `--auto` | Auto mode: apply edits without asking |
| `--permission-mode <m>` | `default` \| `acceptEdits` \| `dontAsk` |
| `--init` | Scaffold a `.minervacli.md` project context file |

Create a `.minervacli.md` in your project (via `--init`) to give Minerva
standing context — what the project is, how to run it, your professor's
constraints. Minerva reads it at the start of every session.

**How it works under the hood:** Chat Minerva's API exposes no native
function calling (and drops `system` messages entirely), so the CLI
injects your project files into the conversation, parses structured tool
blocks (`<minerva_tool>`, fenced JSON) and full-file code-block proposals
out of the model's replies, and executes Read/Glob/Grep/Write/Edit/Bash
locally — gated by the permission mode. Minerva is a 7B model: expect to
guide it, and keep assisted mode on while you're learning.

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
