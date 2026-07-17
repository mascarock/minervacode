/**
 * Fixed inputs the harness feeds to interactive student programs. Shared by
 * the verifier (which pipes them in) and the oracles (which compute the
 * expected results from them) — the two must never drift apart.
 */

/** A stable probe for small interactive exercises, consumed in order. */
export const NUMBER_PROBE_VALUES = [9, 4, 2, 7, 1, 6, 3, 8, 5, 0] as const;

/** The three-number probe: distinct, unordered, non-trivial sum. */
export const THREE_NUMBER_PROBE = [9, 4, 2] as const;
