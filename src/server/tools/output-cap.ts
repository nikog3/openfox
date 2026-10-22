/**
 * Dynamic tool-output capping.
 *
 * A single tool result must not claim more than a fraction of the context
 * window, so that the rest of the conversation plus the model's output still
 * fit. The cap is derived from the REAL window (not a static constant) and
 * expressed in characters using a dense chars/token ratio — code, JSON and
 * markup tokenize far denser than the chars/4 estimate used for budgets.
 */

/** Dense content (code/JSON/markup) tokenizes at ~2.4 chars/token. */
export const DENSE_CHARS_PER_TOKEN = 2.4

/** Max fraction of the context window one tool result may occupy. */
export const TOOL_OUTPUT_WINDOW_FRACTION = 0.25

/**
 * Compute the effective output cap for a tool: the smaller of the tool's
 * static cap and the window-derived dynamic cap.
 */
export function dynamicToolOutputCap(contextWindow: number, staticCap?: number): number {
  const dynamic = Math.floor(contextWindow * TOOL_OUTPUT_WINDOW_FRACTION * DENSE_CHARS_PER_TOKEN)
  const cap = staticCap !== undefined ? Math.min(staticCap, dynamic) : dynamic
  return Math.max(0, cap)
}

/** Guided truncation marker: tells the agent how to fetch the rest. When a
 *  scratch file holds the full output, point at it (re-read is cheaper than
 *  re-running). Kept generic otherwise, since not every tool (MCP, run_command)
 *  supports offset/limit. */
export function truncationMarker(keptChars: number, totalChars: number, fullOutputPath?: string): string {
  if (fullOutputPath) {
    return `\n\n[Output truncated at ${keptChars} chars of ${totalChars} — full output saved to ${fullOutputPath} — re-read that file (or re-run with a narrower scope) to get the rest]`
  }
  return `\n\n[Output truncated at ${keptChars} chars of ${totalChars} — re-run with a narrower scope, or paginate if the tool supports it]`
}

/**
 * Truncate an output string to the cap, appending the guided marker. The
 * marker itself is not counted against the cap (it is appended after the cut).
 */
export function truncateToCap(
  output: string,
  cap: number,
  fullOutputPath?: string,
): { output: string; truncated: boolean } {
  if (cap <= 0) return { output: truncationMarker(0, output.length, fullOutputPath), truncated: true }
  if (output.length <= cap) return { output, truncated: false }
  return {
    output: output.slice(0, cap) + truncationMarker(cap, output.length, fullOutputPath),
    truncated: true,
  }
}
