/** One OpenRouter chat call for the replay tier (T08 token counts, T09, T10),
 * pinned like the probe: model openai/gpt-6-sol, reasoning low, upstream
 * OpenAI with no fallback; every call's model, upstream and billed
 * usage.cost are returned and checked. The key comes from OPENROUTER_API_KEY
 * in this process's environment and is never printed. A ledger stops the
 * run before its budget is crossed. */

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string | null
  readonly tool_calls?: ReadonlyArray<{ readonly id: string; readonly type: 'function'; readonly function: { readonly name: string; readonly arguments: string } }>
  readonly tool_call_id?: string
}
export interface ChatTool { readonly type: 'function'; readonly function: { readonly name: string; readonly description: string; readonly parameters: unknown } }

export interface ChatResult {
  readonly message: ChatMessage
  readonly model: string
  readonly upstream: string | null
  readonly promptTokens: number
  readonly cachedTokens: number
  readonly completionTokens: number
  readonly costUsd: number
}

export const PINNED = { model: 'openai/gpt-6-sol', upstream: 'OpenAI', effort: 'low' } as const

/** A spending guard shared by every call of one run. */
export const createLedger = (budgetUsd: number) => {
  let spent = 0
  let calls = 0
  return {
    charge: (costUsd: number) => { spent += costUsd; calls += 1 },
    check: () => { if (spent >= budgetUsd) throw new Error(`replay budget reached: USD ${spent.toFixed(4)} of ${budgetUsd}`) },
    get spentUsd() { return spent },
    get calls() { return calls },
  }
}
export type Ledger = ReturnType<typeof createLedger>

export const chat = async (ledger: Ledger, messages: ReadonlyArray<ChatMessage>, tools: ReadonlyArray<ChatTool> = [], maxTokens = 4_000, toolChoice: 'auto' | 'none' = 'auto', seed?: number): Promise<ChatResult> => {
  ledger.check()
  const key = process.env.OPENROUTER_API_KEY?.trim()
  if (!key) throw new Error('OPENROUTER_API_KEY is not set in this process')
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: PINNED.model, messages, max_tokens: maxTokens, reasoning: { effort: PINNED.effort },
      provider: { order: [PINNED.upstream], allow_fallbacks: false },
      ...(seed === undefined ? {} : { seed }),
      ...(tools.length === 0 ? {} : { tools, tool_choice: toolChoice }),
    }),
    signal: AbortSignal.timeout(180_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`OpenRouter: HTTP ${response.status} ${text.slice(0, 300)}`)
  const data = JSON.parse(text) as any
  const costUsd = typeof data.usage?.cost === 'number' ? data.usage.cost : Number.NaN
  if (!Number.isFinite(costUsd)) throw new Error('OpenRouter returned no billed usage.cost')
  ledger.charge(costUsd)
  const result: ChatResult = {
    message: data.choices[0].message,
    model: data.model,
    upstream: data.provider ?? null,
    promptTokens: data.usage.prompt_tokens,
    cachedTokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
    completionTokens: data.usage.completion_tokens,
    costUsd,
  }
  if (!result.model.startsWith(PINNED.model) || result.upstream !== PINNED.upstream) throw new Error(`pin violated: ${result.model} via ${result.upstream}`)
  return result
}
