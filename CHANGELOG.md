# Changelog

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
