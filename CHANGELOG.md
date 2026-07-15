# Changelog

## 0.3.2 — 2026-07-15

- In-line cursor editing in the TUI input: ←/→ move the caret, typing and
  paste insert at the caret, Backspace/fn+Delete delete around it, Home/End
  and Ctrl+A/E jump to the edges, Ctrl+U/K kill to start/end, Ctrl+W
  deletes the previous word.

## 0.3.1 — 2026-07-15

- Fix paste in the TUI input: pasted text (including multi-line snippets)
  is now inserted into the prompt via bracketed paste instead of instantly
  submitting the first line and discarding the rest. Enter still sends the
  message; newlines in the pasted content are preserved.
- Recall previously sent messages with ↑/↓ in the input (shell-style
  history): ↑ walks back, ↓ walks forward and restores the in-progress
  draft; editing a recalled message turns it into the current draft.

## 0.3.0 — 2026-07-15

- Render assistant replies as formatted markdown in the TUI and one-shot
  console: headings, gutter-bordered code blocks with a language label,
  bullet/ordered lists, quotes, and inline bold/italic/`code` styling,
  instead of raw markdown source.
- Handle replies wrapped in a ` ```markdown ` fence: unwrap whole-reply
  wrappers, extract the real nested fence, and language-sniff mislabelled
  code so the code-block Write fallback still applies the file change
  (previously such replies produced no file write at all). Markdown prose
  is never written into source files.
- Anchor fence closing to bare ``` lines so nested fences no longer split
  into mangled blocks.
- Tell the model to label fences with the code's real language and never
  use ` ```markdown ` wrappers.
- Reposition the product as an **assisted coding companion**: measured 7B
  limitations are now stated in the README, `--help`, and end-of-run UX, and
  `--auto` is labelled experimental. Failed autonomous runs keep rolling back
  and exiting nonzero; the CLI never reports unverified success.
- Verify requested C/C++ programs by compiling **and running** them (with a
  bounded timeout) when the request asks for execution, instead of only
  syntax-checking; print the verification command and real program output at
  the end of a one-shot run.
- Enforce explicitly requested output paths in auto mode: alternative or
  case-mismatched filenames are refused/normalized, and a run that never
  creates a required file ends as `requirements-unmet` instead of "completed".
- Parse more real 7B reply shapes: fence info-string filenames
  (` ```primes.c `), complete C sources mislabelled as shell fences, and a
  trailing fence the model never closed.
- Recover from failing verifications with a focused-repair context reset,
  re-run checks only after the source actually changed, and stop treating a
  model-run compiler invocation as verification when the request requires
  real execution.
- Add per-command timeouts to Bash/verification runs, a 60s model-response
  timeout, and low-temperature deterministic agent requests; API failures now
  end the run as `model-error` instead of crashing.
- Show the informative lines of failed commands in the console instead of a
  bare "Command failed (exit 1):" header.
- Make the auto-mode self-review strictly advisory: findings are displayed
  for the student but never trigger an automatic fix cycle, after live runs
  showed hallucinated review findings rewriting verified working code.
- Run a single requested Python script (with a bounded timeout) when the
  request asks for execution, mirroring the C/C++ compile-and-run check.
- Limit preserve-bias (partial-write merging, definition-removal refusals)
  to files that existed before the run: the model may fully rewrite a broken
  file it created itself instead of staying trapped in its first draft.
- Report runaway command output as a likely infinite loop instead of leaking
  the internal ERR_CHILD_PROCESS_STDIO_MAXBUFFER code.

## 0.2.0 — 2026-07-15

- Add a cached, relevance-ranked repository map with safe recursive discovery,
  lightweight symbol/import extraction, and `/repomap` inspection.
- Refresh relevant file contents for every user request while keeping stable
  agent instructions separate from disposable repository snapshots.
- Add deterministic context budgeting and compaction for older tool results,
  tool calls, and complete-file proposals, plus `/context` reporting.
- Exclude secret/key files and dependency/build directories from automatic
  repository context.
- Run an existing test suite before the first autonomous edit so the model
  receives the actual baseline failure.
- Extend partial-write merging to JavaScript and TypeScript, retain exports,
  and refuse focused overwrites that delete unrelated definitions.
- Enforce negated test instructions, block unsolicited new files during
  focused fixes, and fail mutating runs that produce no applicable change.
- Package compiled `dist/` output and omit tests/internal development files
  from npm release tarballs.

## 0.1.0 — 2026-07-15

- Initial terminal client and dual-mode coding agent with local tools,
  approvals, autonomous verification, rollback, and code review.
