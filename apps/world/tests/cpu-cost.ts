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
 * Each run's cost in references: over `rounds` rounds, the median ratio of
 * the run's CPU time to the reference's, timed immediately before it. The
 * two of a pair share a core and a moment; the fastest of each, taken from
 * different rounds, did not (a lucky performance-core reference against
 * dense layouts all on efficiency cores read 4.3 where pairs read 1.5 to 2).
 * The median discards pairs that a migration or a collection split.
 */
export const costsInReferences = (runs: ReadonlyArray<() => unknown>, rounds: number): ReadonlyArray<number> => {
  const ratios = runs.map((): number[] => [])
  for (let round = 0; round < rounds; round += 1) {
    runs.forEach((run, index) => {
      const referenceMs = threadCpuMs(referenceComputation)
      ratios[index]!.push(threadCpuMs(run) / referenceMs)
    })
  }
  return ratios.map(values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!)
}
