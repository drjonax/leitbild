// Everything the model build leaves out, infers beyond the topology, or explains by a curation.
// The topology compiler keeps its own ledger; the build writes both into *.ledger.json.

const reasonDispositions = {
  'excluded-by-curation': 'dropped',
  'offshore-supply-explained': 'curated',
  'component-isolated': 'dropped',
  'pump-not-a-generator': 'dropped',
  'wind-registry-out-of-operation': 'dropped',
  'generator-beyond-radius': 'dropped',
  'generator-attached-by-containment': 'inferred',
  'generator-attached-nearest': 'inferred',
  'generator-attached-by-regional-route': 'curated',
  'generators-aggregated': 'inferred',
  'municipality-unlocated': 'dropped',
  'municipality-load-attached': 'inferred',
  'municipality-without-residents': 'inferred',
  'site-load-attached': 'curated',
  'site-without-station': 'dropped',
  'site-generator-attached': 'curated',
  'curated-branch-added': 'curated',
  'curated-rating-set': 'curated',
  'network-equivalent-added': 'curated',
  'transformer-units-added': 'curated',
  'branch-normally-open': 'curated',
  'curated-circuits-set': 'curated',
  'generator-split-by-curation': 'curated',
} as const

export type BuildLedgerReason = keyof typeof reasonDispositions
export type BuildLedgerDisposition = (typeof reasonDispositions)[BuildLedgerReason]

export interface BuildLedgerEntry {
  readonly reason: BuildLedgerReason
  readonly disposition: BuildLedgerDisposition
  /** Model asset ids, registry ids (nve-hydro:<nr>), OSM ids or curation ids. */
  readonly elementIds: ReadonlyArray<string>
  readonly mw: number | null
  readonly distanceKm: number | null
  readonly detail: string
}

export interface BuildLedgerInput {
  readonly reason: BuildLedgerReason
  readonly elementIds: ReadonlyArray<string>
  readonly detail: string
  readonly mw?: number
  readonly distanceKm?: number
}

export interface BuildLedger {
  readonly add: (entry: BuildLedgerInput) => void
  readonly entries: () => ReadonlyArray<BuildLedgerEntry>
}

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

export const createBuildLedger = (): BuildLedger => {
  const collected: BuildLedgerEntry[] = []
  return {
    add: entry => {
      collected.push({
        reason: entry.reason,
        disposition: reasonDispositions[entry.reason],
        elementIds: [...entry.elementIds],
        mw: entry.mw === undefined ? null : Math.round(entry.mw * 1000) / 1000,
        distanceKm: entry.distanceKm === undefined ? null : Math.round(entry.distanceKm * 100) / 100,
        detail: entry.detail,
      })
    },
    entries: () => [...collected].sort((left, right) =>
      compare(left.reason, right.reason) || compare(left.elementIds.join(','), right.elementIds.join(',')) || compare(left.detail, right.detail)),
  }
}
