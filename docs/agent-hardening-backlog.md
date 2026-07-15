# Agent hardening backlog

Distilled from a July 2026 research sweep over open-source agentic CLIs
(Aider, Cline/Roo, Open Interpreter, gpt-engineer, smolagents, Continue,
OpenHands, Goose, OpenClaude), adversarially filtered against minervacli's
constraints (7B chat model, no tool calling, system messages dropped,
prompt-rule additions measurably degrade the model). The techniques that
survived review landed in 0.4.3. These did not — kept here with the reason,
for when the live failure they address actually shows up.

## Deferred (worth building when observed)

- **Task-relevance anchor** — verification is task-agnostic: a regurgitated
  prime printer can verify green against a sorting request. Deterministic
  content-word/identifier overlap between request and changed file (or
  smoke-run output) before a pass counts. Deferred: the history fence scrub
  removes the observed contamination source; overlap scoring is fragile for
  Italian prompts against English-keyword code.
- **Claim-vs-ledger scrub** — post-write summaries hallucinate actions
  ("compiled the module into C code"). Cross-check claimed verbs
  (ran/compiled/tested) against the harness's real command+change ledger and
  annotate unmatched claims before rendering. Cosmetic; students already see
  the real [Write]/[Bash] lines.
- **Best-of-N verifier-guided sampling** — sample 2–3 completions on the
  primary Write turn and keep the first that passes fence-parse + syntax
  check. Nearly free on a self-hosted 7B, but changes latency/API usage —
  needs a live-battery A/B before adopting.
- **Fence-less code salvage** — extract contiguous code-dominant line runs
  from fence-less replies (smolagents/Goose toolshim kernel), syntax-check,
  then propose as a Write. Ordered AFTER the format nudge fails. Risk:
  widens the contamination path; the 0.4.2 unfenced-code nudge already
  covers the retry.
- **One-shot minimal-ask rebuild** — on repeat refusals, rebuild the
  conversation to a single terse "emit only the file" user message
  (OpenClaude toolless self-heal shape). Only if refusals persist through
  the existing nudge ladder.

## Rejected with cause (do not revisit without new evidence)

- SEARCH/REPLACE or udiff edit formats — Aider's own benchmarks show weak
  models fail structured diff grammars; whole-file fences (current
  architecture) are the recommended weak-model format.
- Fuzzy hunk re-anchoring / line-number trust — no line-number contract
  exists in the fence format.
- Lazy-edit ("... rest unchanged") reconstruction — big-model behavior,
  never observed from the 7B; the def-by-def merge covers partial proposals.
- Shadow-git checkpoints — rollback/changelog already cover this without a
  second git dependency.
- Second-model apply/interpreter passes (Continue apply model, Goose
  toolshim LLM) — no second model available; deterministic parsing already
  fills the role.
