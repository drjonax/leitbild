/** T02 hash parity on the mimic-intent replay corpus: how many intents draw today with the drawing hash recorded at
 * bacf7a115, how many draw differently, and which no longer draw or newly draw.
 *   bun tests/display-replay/hash-parity.ts */
import { join } from 'node:path'
import { replayIntent, BUDGETS, type ReplayOutcome } from './mimic-replay.ts'

const record = await Bun.file(join(import.meta.dir, '../fixtures/display-replay/mimic-intents.json')).json() as {
  readonly intents: ReadonlyArray<{ readonly intent: Record<string, unknown>; readonly outcomes: ReadonlyArray<ReplayOutcome> }>
}
const report = BUDGETS.map((budget, index) => {
  const tally = { budget, same: 0, changed: [] as unknown[], lost: [] as unknown[], gained: [] as unknown[], refusedBoth: 0 }
  for (const entry of record.intents) {
    const then = entry.outcomes[index]!
    const now = replayIntent(entry.intent)[index]!
    if (then.draws && now.draws) { if (then.hash === now.hash) tally.same += 1; else tally.changed.push(entry.intent) }
    else if (then.draws) tally.lost.push(entry.intent)
    else if (now.draws) tally.gained.push(entry.intent)
    else tally.refusedBoth += 1
  }
  return tally
})
console.log(JSON.stringify(report, null, 1))
