/**
 * An oracle judges whether a program's real output CONTRADICTS what the
 * request asked for. Exit status proves a program ran; it cannot see a
 * confidently-printed wrong answer, which is the dominant observed failure.
 *
 * Every oracle must be SOUND rather than complete: it fires only when the
 * request pins the expected output exactly. A false positive fails correct
 * student work, which is far worse than missing a wrong answer.
 */
export interface Oracle {
  /** Stable identity, used for registry ordering and tests. */
  readonly name: string;
  /** True when `output` cannot satisfy `request`. */
  mismatch(request: string, output: string): boolean;
  /**
   * Correction appended to the failing output, telling the model what the
   * exit code could not. Only read when `mismatch` returned true.
   */
  guidance(request: string, output: string): string;
}

/** The first oracle that rejected the output, with its correction text. */
export interface OracleVerdict {
  readonly oracle: string;
  readonly guidance: string;
}
