# Ink TUI ("Claude Code style") for minervacli

Date: 2026-07-15 · Status: approved

## Goal

Replace the readline REPL with a Claude Code-feel terminal UI: dim `>`
prompt in a rounded input box, `●`-prefixed assistant responses with
hanging indent, a thinking spinner with elapsed time and Esc-to-interrupt,
and a compact welcome banner instead of the ASCII logo + cyan info box.

## Non-goals

- Markdown rendering of responses (raw streamed text in v1).
- Cursor-movement line editing in the input box (append/backspace/submit only).
- Test infrastructure (repo has none; verification is `tsc` + live run).

## Dependencies

`ink@^6`, `react@^19` (runtime), `@types/react` (dev). No ink-* extras;
spinner, input, and select list are hand-rolled. tsconfig gains
`"jsx": "react-jsx"`.

## Architecture

Untouched: `commander` entry (`index.ts`), `src/auth/*`, `src/api/*`
except one addition — `MinervaClient.postStream` and `streamChat` accept
an optional `AbortSignal`; `streamChat` moves to an options object
(`{ onChunk?, signal? }`) and returns partial text on abort.

New `src/tui/`:

- `App.tsx` — root state machine. State: `transcript: Entry[]`
  (`user | assistant | system | error`), `phase: idle | waiting |
  streaming | picking-model`, live stream buffer, AbortController ref.
  Handles slash commands.
- `Transcript.tsx` — committed entries rendered via Ink `<Static>` so
  history lands in native terminal scrollback and only the active area
  re-renders. `>` user lines dim; `●` assistant lines with 2-space
  hanging indent.
- `InputBox.tsx` — single-line rounded-border box, dim `> ` prompt,
  custom `useInput` editing. Hidden while a response is in flight.
- `Spinner.tsx` — `✳ Thinking… (4s · esc to interrupt)`; animated glyph,
  elapsed seconds, shown in `waiting` phase.
- `Welcome.tsx` — `✻ Welcome to Minerva CLI` + one dim line with model,
  Open WebUI version, email, `/help` hint. Emitted as the first Static
  entry.
- `ModelPicker.tsx` — arrow-key + Enter selection for `/model`
  (replaces the inquirer number prompt); Esc cancels.

`repl.ts` becomes `repl.tsx`: `runRepl` mounts the Ink app in a loop —
`/login`/`/logout` unmount, run the existing plain-stdout browser flow,
then remount (`/logout` ends the loop). `ensureConfig`, `runLoginFlow`
keep their behavior.

## Slash commands

- `/help`, `/info`, `/clear` — handled in-app, output committed to the
  transcript as system entries.
- `/model` — in-app picker (above).
- `/login` — unmount → login flow → remount with fresh client, cleared
  history.
- `/logout`, `/exit` — unmount and terminate.

## Streaming flow

Submit → commit `> text` to transcript → phase `waiting`, spinner with
AbortController → first chunk flips to `streaming`, buffer renders live
below Static → done: commit `●` entry, phase `idle`. Esc aborts; partial
text is committed with an ` · interrupted` marker. Errors commit a red
`● Error: …` entry; the input box returns either way.

## One-shot mode

`minervacli "hi"` stays plain streaming (no Ink): `● ` prefix, hanging
indent via a newline-aware stdout writer in `ui/stream.ts`, no cyan
`Minerva ›` header. `minervacli info` reuses the same compact banner
styling as the TUI welcome (old box UI removed).

## Verification

`npm run build` clean; manual live run of REPL (chat, spinner, Esc
interrupt, each slash command) and one-shot mode.
