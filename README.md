# Minerva CLI

A terminal chat client for [Chat Minerva](https://chatminerva.org) — the Italian AI assistant based on the Minerva LLM (Sapienza NLP & Babelscape).

Chat Minerva runs on **Open WebUI v0.7.2**. This CLI lets you log in and chat from the terminal with live streaming output.

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
| `/clear` | Clear conversation history |
| `/login` | Re-authenticate |
| `/logout` | Clear saved credentials |
| `/exit` | Quit |

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
