/** Writes the mimic-intent replay record (T0/T02) from a mined corpus file (a JSON list of {intent, seenIn}).
 * Run it only to re-baseline, deliberately, on the old path:
 *   bun tests/display-replay/record.ts <absolute corpus.json> */
import { join } from 'node:path'
import { replayIntent, BUDGETS, type CorpusIntent } from './mimic-replay.ts'

const source = Bun.argv[2]
if (!source) throw new Error('Usage: bun tests/display-replay/record.ts <absolute corpus.json>')
const corpus = await Bun.file(source).json() as ReadonlyArray<CorpusIntent>
const record = {
  about: 'Every unique mimic intent agents wrote across the display evaluation runs (Leitbild-evaluation-evidence 2026-10-09 … 2026-10-19a), replayed at bacf7a115 on the 4-loop PWR reference Plant.',
  budgets: BUDGETS,
  intents: corpus.map(entry => ({ ...entry, outcomes: replayIntent(entry.intent) })),
}
const target = join(import.meta.dir, '../fixtures/display-replay/mimic-intents.json')
await Bun.write(target, JSON.stringify(record, null, 1) + '\n')
const drawn = record.intents.filter(entry => entry.outcomes[0]!.draws).length
console.log(`Recorded ${record.intents.length} intents (${drawn} draw at 800 × 624) to ${target}`)
