// Performance budgets on a shared machine. Wall time measures the machine: at
// load 100 the dense mimic layout, 20 ms on a quiet machine, took up to 1 s.
// Main-thread CPU time leaves out that preemption, but slower efficiency cores
// and contention still inflate it (three- to four-fold at load 40 to 120), so
// a cost is judged against a reference computation timed alongside it on the
// same thread, which slows alike: the 4-loop overview compile kept 3.0 to 3.8
// references on any core while its CPU time ranged from 112 to 162 ms.

/** What the reference computation takes on a quiet machine: a budget of 50 quiet ms is about four references. */
export const referenceQuietMs = 12

/** A fixed computation of the kind these budgets cover: allocating, sorting, keyed lookups. */
export const referenceComputation = (): number => {
  let sum = 0
  for (let round = 0; round < 40; round++) {
    const values = Array.from({ length: 2_000 }, (_, index) => ({ id: `n${(index * 7919) % 2_000}`, x: (index * 104729) % 1_013 }))
    values.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id))
    const byId = new Map(values.map(value => [value.id, value.x]))
    for (const value of values) sum += byId.get(value.id)!
  }
  return sum
}

/** Main-thread CPU milliseconds that `run` takes. */
export const threadCpuMs = (run: () => unknown): number => {
  const before = process.threadCpuUsage()
  run()
  const used = process.threadCpuUsage(before)
  return (used.user + used.system) / 1_000
}

/**
 * Each run's fastest CPU time in multiples of the reference's fastest, over
 * `rounds` rounds that each time the reference and then every run. Slow
 * samples measure the machine, not the code.
 */
export const costsInReferences = (runs: ReadonlyArray<() => unknown>, rounds: number): ReadonlyArray<number> => {
  const runMs = runs.map(() => Number.POSITIVE_INFINITY)
  let referenceMs = Number.POSITIVE_INFINITY
  for (let round = 0; round < rounds; round += 1) {
    referenceMs = Math.min(referenceMs, threadCpuMs(referenceComputation))
    runs.forEach((run, index) => { runMs[index] = Math.min(runMs[index]!, threadCpuMs(run)) })
  }
  return runMs.map(ms => ms / referenceMs)
}
