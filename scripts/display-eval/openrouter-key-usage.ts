/** Prints the OpenRouter key's billed usage (USD) as one JSON line: numbers
 * only, never the key. The key comes from OPENROUTER_API_KEY in this process's
 * environment (the eval lane sources ~/.config/openrouter/env into it).
 *
 *   bun scripts/display-eval/openrouter-key-usage.ts
 *
 * A key-level delta includes every caller of that key, so it only
 * cross-checks the per-call usage.cost the Agents log records. */
export const readKeyUsage = async (apiKey: string): Promise<{ readonly at: string; readonly usageUsd: number; readonly limitUsd: number | null }> => {
  const response = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`OpenRouter /key: HTTP ${response.status}`)
  const { data } = await response.json() as { data?: { usage?: unknown; limit?: unknown } }
  if (typeof data?.usage !== 'number') throw new Error('OpenRouter /key: no numeric usage')
  return { at: new Date().toISOString(), usageUsd: data.usage, limitUsd: typeof data.limit === 'number' ? data.limit : null }
}

if (import.meta.main) {
  const key = process.env.OPENROUTER_API_KEY?.trim()
  if (!key) throw new Error('OPENROUTER_API_KEY is not set in this process')
  console.log(JSON.stringify(await readKeyUsage(key)))
}
