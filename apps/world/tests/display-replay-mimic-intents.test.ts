import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { replayIntent, type ReplayOutcome } from './display-replay/mimic-replay.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// T0 replay (plan v3.1 Appendix F; the corpus T02's hash parity is measured on): every unique mimic intent agents
// wrote in the evaluation runs. A drawing may change (the engine lane fixes anchors, lanes and crossings, and
// tests/display-replay/hash-parity.ts reports how many hashes still match), but an intent that drew must still draw.
const record = await Bun.file(join(import.meta.dir, 'fixtures/display-replay/mimic-intents.json')).json() as {
  readonly intents: ReadonlyArray<{ readonly intent: Record<string, unknown>; readonly outcomes: ReadonlyArray<ReplayOutcome> }>
}

describe('T0 mimic-intent replay corpus', () => {
  test('holds the agents\' unique intents, most of which draw in a chat display', () => {
    expect(record.intents.length).toBeGreaterThanOrEqual(65)
    expect(record.intents.filter(entry => entry.outcomes[0]!.draws).length).toBeGreaterThanOrEqual(63)
  })

  test('every intent that drew at bacf7a115 still draws, at both chat budgets', () => {
    const lost = record.intents.flatMap(entry => {
      const now = replayIntent(entry.intent)
      return entry.outcomes.flatMap((then, budget) => then.draws && !now[budget]!.draws ? [{ intent: entry.intent, budget, issues: (now[budget] as { issues: ReadonlyArray<string> }).issues }] : [])
    })
    expect(lost).toEqual([])
  })
})
