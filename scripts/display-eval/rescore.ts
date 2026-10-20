/** Re-scores a recorded probe stage with corrected decisive-evidence keys,
 * from the transcripts the probe saved, with no model call. A scenario whose
 * prompt, fault, advance or expectation changed is not re-scored: it needs a
 * new run, and is listed as such.
 *
 *   bun scripts/display-eval/rescore.ts <absolute-stage-dir> <stage> [--scenarios=<abs module>#<export>]
 *
 * Writes <stage>-rescored-rows.jsonl beside the stage and prints its summary. */
import { join } from 'node:path'
import { allScenarios, loadScenarioModule, type EvalScenario } from './scenarios.ts'
import { displayEvidenceOf, scoreKey, type KeyResult } from './decisive.ts'
import { referencePlantCatalog } from './plant-catalog.ts'
import { summariseRows, type ProbeRow } from './report.ts'

const viewFence = (content: string): boolean => /```leitbild-view\n(view \S+)\n```/.test(content)

/** What decides whether a recorded run still answers a scenario as written. */
const runShape = (scenario: Pick<EvalScenario, 'prompt' | 'fault' | 'advanceMinutes' | 'expect' | 'operation'>): string =>
  JSON.stringify([scenario.prompt, scenario.fault ?? null, scenario.advanceMinutes ?? null, scenario.expect, scenario.operation ?? null])

export interface Recorded {
  readonly scenario: EvalScenario
  readonly row: ProbeRow & Record<string, unknown>
  readonly answer: { readonly content: string }
  readonly composes: ReadonlyArray<{ readonly input: unknown; readonly result: any }>
}

/** A recorded row with its decisive evidence scored against `scenario`'s keys, or null when the run no longer matches it. */
export const rescoreRow = (recorded: Recorded, scenario: EvalScenario, catalog = referencePlantCatalog()): (ProbeRow & Record<string, unknown>) | null => {
  if (runShape(recorded.scenario) !== runShape(scenario)) return null
  const fence = viewFence(recorded.answer.content)
  const presented = fence ? recorded.composes.filter(record => record.result?.success === true && typeof record.result.viewRef === 'string').at(-1) : undefined
  const display = presented === undefined ? null : displayEvidenceOf(presented as never)
  const decisive: ReadonlyArray<KeyResult> = scenario.evidence.map(key => key.use === 'P0'
    ? scoreKey(key, display, recorded.answer.content, catalog)
    : { key: key.key, kind: key.kind, use: key.use, hit: null, hits: [], unknown: [] })
  const scored = decisive.filter(result => result.kind === 'signal' && result.use === 'P0')
  return {
    ...recorded.row,
    decisive,
    decisiveSignalKeys: scored.length,
    decisiveSignalHits: scored.filter(result => result.hit === true).length,
    decisivePass: scenario.expect !== 'display' || scored.length === 0 ? null : fence && scored.every(result => result.hit === true),
    staleKeyNames: [...new Set(decisive.flatMap(result => result.unknown))],
  }
}

if (import.meta.main) {
  const [directory, stage, ...rest] = Bun.argv.slice(2)
  if (!directory || !stage) throw new Error('Usage: rescore.ts <absolute-stage-dir> <stage> [--scenarios=<abs module>#<export>]')
  const external = rest.find(argument => argument.startsWith('--scenarios='))?.slice('--scenarios='.length)
  const pool = external === undefined ? allScenarios : await (async () => {
    const [path, exportName] = external.split('#')
    if (!path || !exportName) throw new Error('--scenarios takes <absolute module path>#<export>')
    return loadScenarioModule(path, exportName)
  })()
  const recordedRows = (await Bun.file(join(directory, `${stage}-rows.jsonl`)).text()).split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as ProbeRow)
  const catalog = referencePlantCatalog()
  const rows: ProbeRow[] = []
  const needsRun: string[] = []
  for (const recordedRow of recordedRows) {
    const { id } = recordedRow
    // A refused setup never reached the agent: there is nothing to re-score.
    if (recordedRow.answerType === 'setup-refused') { rows.push(recordedRow); continue }
    const scenario = pool.find(entry => entry.id === id)
    if (scenario === undefined) { needsRun.push(`${id} (no longer in the set)`); continue }
    const recorded = await Bun.file(join(directory, `${stage}-${id}.json`)).json() as Recorded
    const row = rescoreRow(recorded, scenario, catalog)
    if (row === null) needsRun.push(`${id} (prompt, fault, advance, expectation or operation changed)`)
    else rows.push(row)
  }
  const added = pool.filter(scenario => !recordedRows.some(row => row.id === scenario.id)).map(scenario => `${scenario.id} (not recorded)`)
  await Bun.write(join(directory, `${stage}-rescored-rows.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  console.log(JSON.stringify({ rescored: rows.length, needsRun: [...needsRun, ...added], summary: summariseRows(rows) }, null, 2))
}
