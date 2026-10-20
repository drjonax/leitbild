/** Summaries of probe stages and the paired comparison between two of them.
 *
 *   bun scripts/display-eval/report.ts <absolute-dir>/<stage>-rows.jsonl [...more rows files]
 *   bun scripts/display-eval/report.ts --compare <old rows.jsonl>[,<old rows.jsonl>...] <new rows.jsonl>[,...]
 *
 * Several rows files of one side are runs of the same design (k > 1): a
 * scenario scores the majority of its runs and a tie needs a third run. */
import { mean, median, quantile, wilson, majority, pairedComparison, type Verdict } from './stats.ts'

/** The fields of a probe row this report reads. */
export interface ProbeRow {
  readonly id: string
  readonly set: string
  readonly flaky: boolean
  readonly expect: 'display' | 'none' | 'either'
  readonly answerType: string
  readonly displayed: boolean
  readonly correct: boolean | null
  readonly composeCalls: number
  readonly firstComposeAccepted: boolean | null
  readonly validWithinTwo: boolean | null
  readonly mimic: 'expected' | 'avoid' | null
  readonly mimicShown: boolean
  readonly keyPanelHit: boolean | null
  readonly decisive: ReadonlyArray<{ readonly kind: string; readonly use: string; readonly hit: boolean | null; readonly by?: string }>
  readonly decisiveSignalKeys: number
  readonly decisiveSignalHits: number
  readonly decisivePass: boolean | null
  readonly addedEvidence: ReadonlyArray<{ readonly kind: string; readonly cited: boolean }>
  readonly wallMs: number
  readonly modelCalls: number | null
  readonly loggedCalls: number
  readonly generationMs: number | null
  readonly promptTokens: number | null
  readonly completionTokens: number | null
  readonly costUsd: number
  readonly unbilledCalls: number
  readonly pinViolations: ReadonlyArray<string>
  readonly words: number
  readonly corrections: ReadonlyArray<{ readonly cause: string; readonly detail: ReadonlyArray<string> }> | null
  readonly correctionRounds: number | null
  readonly operationCorrect?: boolean | null
  readonly requested?: { readonly displayed: boolean; readonly correct: boolean | null; readonly costUsd: number; readonly modelCalls: number | null; readonly wallMs: number }
}

const round = (value: number | null, places = 1): number | null => value === null ? null : Math.round(value * 10 ** places) / 10 ** places
const count = <T>(items: ReadonlyArray<T>, key: (item: T) => string): Record<string, number> =>
  items.reduce<Record<string, number>>((tally, item) => { const name = key(item); tally[name] = (tally[name] ?? 0) + 1; return tally }, {})

/** Gate metrics of one stage (plan v3.1 §5.5 G0 and the E0 brief). */
export const summariseRows = (rows: ReadonlyArray<ProbeRow>) => {
  const answered = rows.filter(row => row.answerType === 'chat')
  const expectDisplay = rows.filter(row => row.expect === 'display')
  const expectNone = rows.filter(row => row.expect === 'none')
  const displayAnswers = answered.filter(row => row.displayed)
  const composed = rows.filter(row => row.firstComposeAccepted !== null)
  const corrected = (row: ProbeRow) => (row.correctionRounds ?? 0) > 0
  const decisiveRows = rows.filter(row => row.decisivePass !== null)
  const signalResults = rows.flatMap(row => row.decisive.filter(result => result.kind === 'signal' && result.use === 'P0' && row.expect === 'display'))
  const evidence = rows.flatMap(row => row.addedEvidence)
  const requested = rows.flatMap(row => row.requested === undefined ? [] : [row.requested])
  const operated = rows.filter(row => row.operationCorrect !== undefined)
  return {
    scenarios: rows.length,
    answered: answered.length,
    notAnswered: rows.filter(row => row.answerType !== 'chat').map(row => `${row.id}: ${row.answerType}`),
    displayRecall: wilson(expectDisplay.filter(row => row.displayed).length, expectDisplay.length),
    falsePositives: wilson(expectNone.filter(row => row.displayed).length, expectNone.length),
    firstComposeValid: wilson(composed.filter(row => row.firstComposeAccepted).length, composed.length),
    validWithinTwo: wilson(composed.filter(row => row.validWithinTwo).length, composed.length),
    mimicRecall: wilson(rows.filter(row => row.mimic === 'expected' && row.mimicShown).length, rows.filter(row => row.mimic === 'expected').length),
    unwantedMimics: wilson(rows.filter(row => row.mimic === 'avoid' && row.mimicShown).length, rows.filter(row => row.mimic === 'avoid').length),
    decisiveEvidence: {
      // A display scenario passes when it showed a display and every P0 signal key is carried.
      scenarios: wilson(decisiveRows.filter(row => row.decisivePass).length, decisiveRows.length),
      keys: wilson(signalResults.filter(result => result.hit === true).length, signalResults.length),
      carriedBy: count(signalResults.filter(result => result.hit === true), result => result.by ?? 'unknown'),
      status: 'AI-drafted, pending SME',
    },
    medianModelCalls: median(answered.flatMap(row => row.modelCalls === null ? [] : [row.modelCalls])),
    medianModelCallsDisplayAnswers: median(displayAnswers.flatMap(row => row.modelCalls === null ? [] : [row.modelCalls])),
    medianWallS: round((median(answered.map(row => row.wallMs)) ?? 0) / 1000),
    p90WallS: round((quantile(answered.map(row => row.wallMs), 0.9) ?? 0) / 1000),
    medianGenerationS: round((median(answered.flatMap(row => row.generationMs === null ? [] : [row.generationMs])) ?? 0) / 1000),
    correctionRateDisplayAnswers: wilson(displayAnswers.filter(corrected).length, displayAnswers.length),
    correctionRateAllAnswers: wilson(answered.filter(corrected).length, answered.length),
    correctionCauses: count(answered.flatMap(row => row.corrections ?? []), correction => correction.cause),
    correctionDetails: count(answered.flatMap(row => (row.corrections ?? []).flatMap(correction => correction.detail.map(detail => `${correction.cause}:${detail}`))), name => name),
    correctionsUnread: answered.filter(row => row.corrections === null).map(row => row.id),
    meanPromptTokensDisplayAnswers: round(mean(displayAnswers.flatMap(row => row.promptTokens === null ? [] : [row.promptTokens])), 0),
    meanPromptTokensAllAnswers: round(mean(answered.flatMap(row => row.promptTokens === null ? [] : [row.promptTokens])), 0),
    meanWordsDisplayAnswers: round(mean(displayAnswers.map(row => row.words)), 0),
    medianWordsAllAnswers: median(answered.map(row => row.words)),
    costUsd: round(rows.reduce((sum, row) => sum + row.costUsd + (row.requested?.costUsd ?? 0), 0), 4),
    meanAnswerCostUsd: round(mean(answered.map(row => row.costUsd)), 4),
    unbilledCalls: rows.reduce((sum, row) => sum + row.unbilledCalls, 0),
    pinViolations: rows.flatMap(row => row.pinViolations.map(violation => `${row.id}: ${violation}`)),
    addedEvidenceByKind: Object.fromEntries(Object.entries(count(evidence, entry => entry.kind)).map(([kind, items]) =>
      [kind, { items, cited: evidence.filter(entry => entry.kind === kind && entry.cited).length }])),
    requestedDisplays: requested.length === 0 ? null : {
      requests: requested.length,
      displayed: wilson(requested.filter(entry => entry.displayed).length, requested.length),
      correct: wilson(requested.filter(entry => entry.correct === true).length, requested.filter(entry => entry.correct !== null).length),
    },
    operations: { scenarios: operated.length, correct: operated.filter(row => row.operationCorrect === true).length, judged: operated.filter(row => row.operationCorrect !== null).length },
    flaky: rows.filter(row => row.flaky).map(row => ({ id: row.id, correct: row.correct, decisivePass: row.decisivePass })),
  }
}

/** Per-scenario verdicts over k runs: display decision (recall/restraint) and decisive evidence. */
export const verdicts = (runs: ReadonlyArray<ReadonlyArray<ProbeRow>>, field: 'correct' | 'decisivePass'): Map<string, Verdict> => {
  const byId = new Map<string, Array<boolean | null>>()
  for (const rows of runs) for (const row of rows) byId.set(row.id, [...(byId.get(row.id) ?? []), row[field]])
  return new Map([...byId].map(([id, outcomes]) => [id, majority(outcomes)]))
}

/** The paired comparison of plan §5.5, with pre-named flaky scenarios reported apart. */
export const compareSides = (old: ReadonlyArray<ReadonlyArray<ProbeRow>>, candidate: ReadonlyArray<ReadonlyArray<ProbeRow>>) => {
  const flaky = new Set([...old, ...candidate].flat().filter(row => row.flaky).map(row => row.id))
  const split = (map: Map<string, Verdict>, keepFlaky: boolean) => new Map([...map].filter(([id]) => flaky.has(id) === keepFlaky))
  const side = (field: 'correct' | 'decisivePass') => {
    const before = verdicts(old, field)
    const after = verdicts(candidate, field)
    return { gated: pairedComparison(split(before, false), split(after, false)), flaky: pairedComparison(split(before, true), split(after, true)) }
  }
  const metrics = (runs: ReadonlyArray<ReadonlyArray<ProbeRow>>) => summariseRows(runs.flat())
  const before = metrics(old)
  const after = metrics(candidate)
  return {
    recall: side('correct'),
    decisiveEvidence: side('decisivePass'),
    medianModelCalls: { old: before.medianModelCalls, new: after.medianModelCalls },
    medianWallS: { old: before.medianWallS, new: after.medianWallS },
    correctionRateDisplayAnswers: { old: before.correctionRateDisplayAnswers, new: after.correctionRateDisplayAnswers },
    meanPromptTokensDisplayAnswers: {
      old: before.meanPromptTokensDisplayAnswers, new: after.meanPromptTokensDisplayAnswers,
      ratio: before.meanPromptTokensDisplayAnswers && after.meanPromptTokensDisplayAnswers ? round(after.meanPromptTokensDisplayAnswers / before.meanPromptTokensDisplayAnswers, 3) : null,
    },
  }
}

const readRows = async (path: string): Promise<ReadonlyArray<ProbeRow>> =>
  (await Bun.file(path).text()).split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as ProbeRow)

if (import.meta.main) {
  const args = Bun.argv.slice(2)
  if (args[0] === '--compare') {
    const [oldPaths, newPaths] = [args[1], args[2]]
    if (!oldPaths || !newPaths) throw new Error('Usage: report.ts --compare <old rows.jsonl,...> <new rows.jsonl,...>')
    const load = (paths: string) => Promise.all(paths.split(',').map(readRows))
    console.log(JSON.stringify(compareSides(await load(oldPaths), await load(newPaths)), null, 2))
  } else {
    if (args.length === 0) throw new Error('Usage: report.ts <rows.jsonl> [...]')
    console.log(JSON.stringify(summariseRows((await Promise.all(args.map(readRows))).flat()), null, 2))
  }
}
