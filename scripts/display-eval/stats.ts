/** Small statistics for the display evaluation: Wilson score intervals,
 * medians, and the paired per-scenario comparison the gates use (plan v3.1
 * §5.5): a scenario scores the majority of its runs; a tie needs a third run;
 * net regression = only-new-fails − only-new-passes; pre-named flaky
 * scenarios are reported apart. */

export interface Interval { readonly hits: number; readonly n: number; readonly rate: number | null; readonly low: number | null; readonly high: number | null }

/** Wilson score interval for hits out of n, at z = 1.96 (95 %). */
export const wilson = (hits: number, n: number, z = 1.96): Interval => {
  if (!Number.isInteger(hits) || !Number.isInteger(n) || hits < 0 || n < 0 || hits > n) throw new Error(`Invalid proportion ${hits}/${n}`)
  if (n === 0) return { hits, n, rate: null, low: null, high: null }
  const p = hits / n
  const denominator = 1 + z * z / n
  const centre = (p + z * z / (2 * n)) / denominator
  const half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denominator
  const round = (value: number) => Math.round(value * 1000) / 1000
  return { hits, n, rate: round(p), low: round(Math.max(0, centre - half)), high: round(Math.min(1, centre + half)) }
}

export const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export const mean = (values: ReadonlyArray<number>): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length

/** p-quantile by nearest rank. */
export const quantile = (values: ReadonlyArray<number>, p: number): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!
}

/** A scenario's verdict over its runs: the majority, or 'tie' (needs a third run), or null when no run was judged. */
export type Verdict = 'pass' | 'fail' | 'tie' | null
export const majority = (outcomes: ReadonlyArray<boolean | null>): Verdict => {
  const judged = outcomes.filter((outcome): outcome is boolean => outcome !== null)
  if (judged.length === 0) return null
  const passes = judged.filter(Boolean).length
  const fails = judged.length - passes
  return passes > fails ? 'pass' : fails > passes ? 'fail' : 'tie'
}

export interface PairedComparison {
  readonly onlyNewFails: ReadonlyArray<string>
  readonly onlyNewPasses: ReadonlyArray<string>
  readonly bothPass: number
  readonly bothFail: number
  /** Scenarios where either side tied: they need a third run before the gate reads them. */
  readonly needsThirdRun: ReadonlyArray<string>
  /** Scenarios judged on one side only. */
  readonly unpaired: ReadonlyArray<string>
  readonly netRegression: number
}

/** Pairs two sides scenario by scenario (old = baseline, new = candidate) over the scenarios both name. */
export const pairedComparison = (old: ReadonlyMap<string, Verdict>, candidate: ReadonlyMap<string, Verdict>): PairedComparison => {
  const onlyNewFails: string[] = []
  const onlyNewPasses: string[] = []
  const needsThirdRun: string[] = []
  const unpaired: string[] = []
  let bothPass = 0
  let bothFail = 0
  for (const id of [...new Set([...old.keys(), ...candidate.keys()])].sort()) {
    const before = old.get(id) ?? null
    const after = candidate.get(id) ?? null
    if (before === 'tie' || after === 'tie') { needsThirdRun.push(id); continue }
    if (before === null || after === null) { if (before !== after) unpaired.push(id); continue }
    if (before === 'pass' && after === 'pass') bothPass++
    else if (before === 'fail' && after === 'fail') bothFail++
    else if (before === 'pass') onlyNewFails.push(id)
    else onlyNewPasses.push(id)
  }
  return { onlyNewFails, onlyNewPasses, bothPass, bothFail, needsThirdRun, unpaired, netRegression: onlyNewFails.length - onlyNewPasses.length }
}
