/** Fork-only (drjonax/leitbild): direct OpenAI prices and the per-run spend
 * guards of the multiunit plan (§6). Direct OpenAI `[llm]` log lines carry
 * tokens but no billed cost, so cost is computed here from tokens at list
 * price. Direct OpenAI bills no cache write: uncached input is input.
 *
 * Guards: an eval run on gpt-6-luna stops at $0.50, one on gpt-6-sol at
 * $2.00. LEITBILD_PROBE_BUDGET_USD may lower a guard, never raise it. The
 * monthly cap ($10, alert at $7) is an OpenAI project limit set by the owner.
 */

export interface OpenAIPrice {
  /** USD per million tokens. */
  readonly input: number
  readonly cached: number
  readonly output: number
  /** The most one composition turn is allowed to cost before the guard stops a probe (measured worst ×2–5). */
  readonly worstTurnUsd: number
  /** The per-run guard for an eval run on this model. */
  readonly runGuardUsd: number
}

export const OPENAI_PRICES: Readonly<Record<string, OpenAIPrice>> = {
  'gpt-6-luna': { input: 0.10, cached: 0.01, output: 0.50, worstTurnUsd: 0.01, runGuardUsd: 0.50 },
  'gpt-6-sol': { input: 2.00, cached: 0.20, output: 10, worstTurnUsd: 0.10, runGuardUsd: 2.00 },
}

export const MONTHLY_CAP_USD = 10
export const MONTHLY_ALERT_USD = 7

const bare = (model: string): string => model.replace(/^(?:openai[:/])/, '')

/** A model's price by its id as the router, a log line or OpenRouter names it; refused when the table has none. */
export const priceOf = (model: string): OpenAIPrice => {
  const price = OPENAI_PRICES[bare(model)]
  if (price === undefined) throw new Error(`No direct OpenAI price for ${model}; add it to scripts/fork/openai-spend.ts before spending on it`)
  return price
}

export interface TokenUsage { readonly model: string; readonly promptTokens: number; readonly cacheRead: number; readonly completionTokens: number }

export const callCostUsd = (usage: TokenUsage): number => {
  const price = priceOf(usage.model)
  const uncached = Math.max(0, usage.promptTokens - usage.cacheRead)
  return (uncached * price.input + usage.cacheRead * price.cached + usage.completionTokens * price.output) / 1e6
}

/** A run's guard: the strictest of the models it may call; an env value only lowers it. */
export const runGuardUsd = (models: ReadonlyArray<string>, requested = process.env.LEITBILD_PROBE_BUDGET_USD): number => {
  if (models.length === 0) throw new Error('A spend guard needs the models the run calls')
  const cap = Math.max(...models.map(model => priceOf(model).runGuardUsd))
  if (requested === undefined) return cap
  const asked = Number(requested)
  if (!(asked > 0)) throw new Error('LEITBILD_PROBE_BUDGET_USD must be a positive number')
  if (asked > cap) throw new Error(`LEITBILD_PROBE_BUDGET_USD=${asked} exceeds the fork's $${cap} guard for ${models.join(', ')}`)
  return asked
}

/** Spend so far against a guard: `allows` before a turn (its worst case must fit), `add` after it. */
export const createSpendGuard = (budgetUsd: number, worstTurnUsd: number) => {
  let spentUsd = 0
  return {
    allows: (): boolean => spentUsd + worstTurnUsd <= budgetUsd,
    add: (costUsd: number): void => { spentUsd += costUsd },
    spentUsd: (): number => spentUsd,
    budgetUsd,
  }
}

/** The fork never probes production: the origin must be a loopback stack. */
export const assertLocalOrigin = (origin: string): string => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) {
    throw new Error(`Probe origin ${origin} is not a loopback stack; the fork never probes leitbild.app or any other deployment`)
  }
  return origin
}
