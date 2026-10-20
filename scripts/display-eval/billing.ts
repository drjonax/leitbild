/** Every model call a scenario caused, read from the local stack's Agents log:
 * one `[llm]` line per call (llm-service.ts logLine), carrying OpenRouter's
 * generation id, upstream provider and billed usage.cost. The probe runs one
 * scenario at a time on its own stack, so the lines written between a
 * scenario's start and end offsets are that scenario's calls. */
import { open } from 'node:fs/promises'

export interface ModelCall {
  readonly source: string
  readonly path: string
  readonly provider: string
  readonly model: string
  readonly toolCalls: number
  readonly promptTokens: number | null
  readonly completionTokens: number | null
  readonly cacheRead: number | null
  readonly cacheWrite: number | null
  readonly durationMs: number
  readonly generationId: string | null
  readonly upstream: string | null
  /** OpenRouter's billed cost (usage.cost), USD; null when the line carries none. */
  readonly costUsd: number | null
}

const numberOrNull = (value: string | undefined): number | null => value === undefined || value === '?' ? null : Number(value)

export const parseModelCall = (line: string): ModelCall | null => {
  if (!line.startsWith('[llm] ')) return null
  const fields = Object.fromEntries([...line.slice(6).matchAll(/(\w+)=(\S+)/g)].map(match => [match[1]!, match[2]!]))
  if (fields.source === undefined || fields.duration_ms === undefined) throw new Error(`Unrecognised [llm] log line: ${line.slice(0, 200)}`)
  return {
    source: fields.source, path: fields.path ?? '?', provider: fields.provider ?? '?', model: fields.model ?? '?',
    toolCalls: Number(fields.tools ?? 0),
    promptTokens: numberOrNull(fields.prompt_tokens), completionTokens: numberOrNull(fields.completion_tokens),
    cacheRead: numberOrNull(fields.cache_read), cacheWrite: numberOrNull(fields.cache_write),
    durationMs: Number(fields.duration_ms),
    generationId: fields.generation === undefined || fields.generation === '?' ? null : fields.generation,
    upstream: fields.upstream === undefined || fields.upstream === '?' ? null : fields.upstream,
    costUsd: numberOrNull(fields.cost_usd),
  }
}

export const parseModelCalls = (text: string): ReadonlyArray<ModelCall> =>
  text.split('\n').flatMap(line => { const call = parseModelCall(line); return call === null ? [] : [call] })

/** The log's current size, the offset a scenario starts reading from. */
export const logOffset = async (path: string): Promise<number> => (await Bun.file(path).stat()).size

/** The calls logged between two offsets. */
export const callsBetween = async (path: string, start: number, end: number): Promise<ReadonlyArray<ModelCall>> => {
  if (end < start) throw new Error(`Agents log ${path} shrank (${start} → ${end}); was the stack restarted?`)
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(end - start)
    await handle.read(buffer, 0, buffer.length, start)
    return parseModelCalls(buffer.toString('utf8'))
  } finally { await handle.close() }
}

export interface BillingSummary {
  readonly calls: number
  readonly costUsd: number
  /** Calls whose line carried no billed cost: the sum then understates the bill. */
  readonly unbilledCalls: number
  readonly upstreams: ReadonlyArray<string>
  readonly models: ReadonlyArray<string>
}

export const summariseCalls = (calls: ReadonlyArray<ModelCall>): BillingSummary => ({
  calls: calls.length,
  costUsd: Math.round(calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0) * 1e7) / 1e7,
  unbilledCalls: calls.filter(call => call.costUsd === null).length,
  upstreams: [...new Set(calls.map(call => call.upstream ?? 'unknown'))],
  models: [...new Set(calls.map(call => call.model))],
})
