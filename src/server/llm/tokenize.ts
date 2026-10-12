/**
 * Shared response handling for the backend tokenizer endpoints
 * (OpenAI-compatible /tokenize and Ollama /api/tokenize): both return
 * `{ tokens: [...] }` — count them, null on any failure.
 */
export async function countTokensFromResponse(response: Response): Promise<number | null> {
  if (!response.ok) return null
  const data = (await response.json()) as { tokens?: unknown }
  return Array.isArray(data.tokens) ? data.tokens.length : null
}
