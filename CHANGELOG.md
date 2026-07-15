# Changelog

## 0.4.1 — 2026-07-15

Fixes the "I have to ask too many times" loop observed live: follow-up
turns like "adesso estendi lo script…" showed the right code but never
proposed a Write.

- Recognize extend/expand/improve (and estendi/espandi/amplia/migliora)
  as change requests, so the fence→file machinery stays enabled on
  follow-up turns phrased that way.
- Look for the destination filename in the prose BELOW a fence too
  ("Please copy this into main.py") — the model frequently names the file
  only after the code, which was previously invisible to the parser.

## 0.4.0 — 2026-07-15

Reliability release driven by a 16-scenario live battery against the real
7B model (5 of 16 runs previously reported success for broken or missing
code; all 5 are fixed or now fail honestly).

- Smoke-run verification: when a single Python file changed and no test
  setup exists, the harness now RUNS it with dummy piped input (10s cap)
  after the syntax check. Syntax-valid code that crashes on execution no
  longer counts as verified; the traceback feeds the repair loop.
- Empty-project fallback: a filename-less fence with a known language now
  targets a conventional new file (main.py, main.c, …) when the project
  has no file of that language — the model's first, usually best, reply
  was previously dropped and the nudged retry was usually worse.
- Requested-function acceptance: when the request spells out a function
  ("add is_even(n)"), an auto run that never defines it is nudged and, if
  it still doesn't comply, ends requirements-unmet instead of "completed".
- Merge now appends a definitions-only proposal that overlaps nothing in
  the target file ("add a function" answered with only that function) —
  previously it became a whole-file overwrite that the definition-removal
  guard refused, dead-ending the request.
- Rename requests ("rename add to sum_two", "rinomina") are recognized as
  authorizing removal of the renamed definition.
- One transient model failure (e.g. a 60s timeout) no longer kills the
  whole run — the request is retried once.
- The model-response timeout is now an INACTIVITY bound (no bytes for 60s)
  instead of a whole-response cap, so a slow 7B that keeps streaming a long
  file is no longer killed mid-generation.
- Plain `def test_*` files are executed with a minimal built-in runner when
  pytest is not installed — previously they were only syntax-checked, so
  "fix the bug so the tests pass" could never establish a failing baseline
  or verify the fix on machines without pytest.
- Partial-write merges protect existing functions the request never
  mentions: "add is_even(n)" no longer lets the model silently rewrite
  double()'s body in the same fence.
- Requests that ask for a user-input program ("Chiedi all'utente…", "Ask
  the user…") are checked for an actual input() call in the changed files;
  a run that regurgitated unrelated code fails as requirements-unmet
  instead of passing on a syntax check.
- A print-something program that runs but prints NOTHING (typically main()
  defined and never called) now fails its smoke run with guidance, instead
  of counting as verified.
- One fence packing several files behind bare marker comments
  (`# test_calc.py`) is split into separate Writes, so test code no longer
  gets merged into the source file.
- Prompt hardening: the model is told it cannot refuse ordinary scripts,
  must not reference buttons/panels ("Show Code"), and must emit file
  contents directly instead of code that opens the target file itself.

## 0.3.4 — 2026-07-15

- Add `/copy`: copies the newest code block from the conversation to the
  system clipboard — the raw code, without the rendered gutter or the
  language label. `/copy 2` reaches one block further back. (Terminal
  selection always copies screen glyphs, gutter included; `/copy` is the
  clean path.)

## 0.3.3 — 2026-07-15

- Assisted mode now proposes a Write for filename-less code fences even
  when several project files match the fence language, targeting the top
  relevance-ranked candidate — the approval prompt (with diff preview)
  stays the safety gate. Auto mode keeps requiring a unique match. This
  fixes "⚠ no applicable change was produced" dead ends when the model
  answers with a bare ```python block in a project with several .py files.
- Only unwrap a whole-reply ```markdown fence when other fences nest
  inside it; a single plain ```markdown block is kept for the Write
  fallback's language sniffing.
- Tell the model it has real file access and must not refuse ordinary
  scripts (dates, times, file I/O) or claim it "cannot modify live files".

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
