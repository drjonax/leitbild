import type { LonLat } from './geometry.ts'
import { compareText } from './ids.ts'

// Every source element the compiler does not turn into a model asset, and every inference it
// makes, is recorded here. The reason fixes the disposition so consumers can filter reliably.
const reasonDispositions = {
  // dropped: deliberately outside the operational ≥minimum-kV 50 Hz model
  'below-minimum-voltage': 'dropped',
  'traction-system': 'dropped',
  'unsupported-frequency': 'dropped',
  'voltage-unparseable': 'dropped',
  'system-ambiguous': 'dropped',
  'not-operational': 'dropped',
  'unsupported-geometry': 'dropped',
  'busbar-outside-station': 'dropped',
  'corridor-self-loop': 'dropped',
  'station-internal-way': 'dropped',
  // unresolved: mapped elements that should be in the model but could not be connected
  'voltage-unknown': 'unresolved',
  'corridor-dangling': 'unresolved',
  'corridor-isolated': 'unresolved',
  'busbar-spans-stations': 'unresolved',
  'hvdc-unmatched': 'unresolved',
  'interconnector-unmatched': 'unresolved',
  'interconnector-split': 'unresolved',
  'interconnector-foreign-end-missing': 'unresolved',
  'interconnector-terminal-mismatch': 'unresolved',
  'interconnector-way-missing': 'unresolved',
  'converter-without-ac-bus': 'unresolved',
  // inferred: the model contains the element, but a value was inferred rather than mapped
  'terminal-buffer': 'inferred',
  'terminal-point-radius': 'inferred',
  'voltage-inherited': 'inferred',
  'voltage-normalised': 'inferred',
  'station-level-untagged': 'inferred',
  'parallel-spans-merged': 'inferred',
  'circuits-inferred': 'inferred',
  'transformer-inferred': 'inferred',
  // reported: observations for audit and curation; no model element depends on them
  'passes-through-station': 'reported',
  'endpoint-in-incompatible-station': 'reported',
  'ambiguous-container': 'reported',
  'same-name-nearby-stations': 'reported',
  'station-without-corridor': 'reported',
  'plant-contains-multiple-stations': 'reported',
  'transformer-unmatched': 'reported',
  'traction-station-fed': 'reported',
} as const

export type TopologyLedgerReason = keyof typeof reasonDispositions
export type TopologyLedgerDisposition = (typeof reasonDispositions)[TopologyLedgerReason]

export const topologyLedgerReasons = Object.keys(reasonDispositions) as ReadonlyArray<TopologyLedgerReason>

export const dispositionOf = (reason: TopologyLedgerReason): TopologyLedgerDisposition => reasonDispositions[reason]

export type TopologyLedgerEntry = {
  readonly reason: TopologyLedgerReason
  readonly disposition: TopologyLedgerDisposition
  readonly elementIds: ReadonlyArray<string>    // source feature ids, OSM way ids, or interconnector ids
  readonly voltageKv: number | null
  readonly location: LonLat | null
  readonly stationId: string | null             // station group id the entry refers to
  readonly distanceM: number | null             // buffer distance, or distance to the nearest station
  readonly detail: string
}

export type LedgerEntryInput = {
  readonly reason: TopologyLedgerReason
  readonly elementIds: ReadonlyArray<string>
  readonly detail: string
  readonly voltageKv?: number
  readonly location?: LonLat
  readonly stationId?: string
  readonly distanceM?: number
}

export const ledgerEntry = (input: LedgerEntryInput): TopologyLedgerEntry => ({
  reason: input.reason,
  disposition: dispositionOf(input.reason),
  elementIds: [...new Set(input.elementIds)].sort(compareText),
  voltageKv: input.voltageKv ?? null,
  location: input.location ?? null,
  stationId: input.stationId ?? null,
  distanceM: input.distanceM === undefined ? null : Math.round(input.distanceM * 10) / 10,
  detail: input.detail,
})

export type TopologyLedger = {
  readonly add: (input: LedgerEntryInput) => void
  readonly addEntry: (entry: TopologyLedgerEntry) => void
  readonly entries: () => ReadonlyArray<TopologyLedgerEntry>
}

const compareEntries = (left: TopologyLedgerEntry, right: TopologyLedgerEntry): number =>
  compareText(left.reason, right.reason) ||
  compareText(left.elementIds.join(','), right.elementIds.join(',')) ||
  (left.voltageKv ?? 0) - (right.voltageKv ?? 0) ||
  compareText(left.stationId ?? '', right.stationId ?? '') ||
  compareText(left.detail, right.detail) ||
  (left.location?.[0] ?? 0) - (right.location?.[0] ?? 0) ||
  (left.location?.[1] ?? 0) - (right.location?.[1] ?? 0)

export const createTopologyLedger = (): TopologyLedger => {
  const collected: TopologyLedgerEntry[] = []
  return {
    add: input => { collected.push(ledgerEntry(input)) },
    addEntry: entry => { collected.push(entry) },
    entries: () => [...collected].sort(compareEntries),
  }
}
