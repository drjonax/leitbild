import type { Balancing, CaseParticipation } from './contingency-balance.ts'

// The compact input and output of an N-1 screening. A snapshot is a self-contained copy of one
// screening case in typed arrays on SharedArrayBuffers: posting it to a worker thread shares the
// memory instead of cloning it. Nothing writes to a snapshot after capture. The kernel writes each
// contingency's result into fixed-width records, also shared, so chunks screened on different
// threads merge by position. This module only declares the layout; contingency-capture.ts fills
// a snapshot from a case.

/**
 * An outage to screen: `circuitsLost` of the circuits of a branch by network index, or a generator
 * by asset id. A Model branch of n circuits holds n identical parallel circuits (or transformer
 * units); losing m < n of them leaves it in service with (n − m)/n of its admittance and ratings.
 */
export type GridContingency =
  | { readonly kind: 'branch'; readonly branchIndex: number; readonly circuitsLost: number }
  | { readonly kind: 'generator'; readonly generatorId: string }

export interface SnapshotNetwork {
  readonly sBaseMva: number
  readonly busCount: number
  readonly branchCount: number
  readonly branchFrom: Int32Array
  readonly branchTo: Int32Array
  /** Series susceptance 1/x (pu on sBaseMva) of all the branch's circuits in parallel. */
  readonly branchSusceptancePu: Float64Array
  /** Parallel circuits (or transformer units) per branch. */
  readonly branchCircuits: Int32Array
  /** 1 on a bus of the Norwegian network, 0 on a boundary bus of an external system (GridTables.norwegianBus). */
  readonly norwegianBus: Uint8Array
}

/** The case's AC components in compressed rows; component i owns `buses[busStart[i] .. busStart[i + 1])`, ascending, the first its angle reference. */
export interface SnapshotIslands {
  readonly count: number
  readonly energised: Uint8Array
  readonly busStart: Int32Array
  readonly buses: Int32Array
  readonly branchStart: Int32Array
  /** Closed branches inside each island. */
  readonly branches: Int32Array
  /** Island index per bus. */
  readonly islandOfBus: Int32Array
}

/**
 * Each island's sparse Cholesky factor of its reduced susceptance matrix, copied from the case.
 * Island i has n_i = buses_i − 1 reduced buses: its perm and iperm (n_i entries) start at
 * busStart[i] − i, its columnStart and rowStart (n_i + 1 local offsets) at busStart[i], its
 * rowIndex and values at entryStart[i], its rowColumns at linkStart[i].
 */
export interface SnapshotFactors {
  readonly perm: Int32Array
  readonly iperm: Int32Array
  readonly columnStart: Int32Array
  readonly rowStart: Int32Array
  readonly entryStart: Int32Array
  readonly rowIndex: Int32Array
  readonly values: Float64Array
  readonly linkStart: Int32Array
  readonly rowColumns: Int32Array
}

/** Bridges of the energised islands from one DFS: opening branch b separates the DFS subtree of bus childOf[b] (-1: no bridge). */
export interface SnapshotBridges {
  readonly childOf: Int32Array
  /** DFS entry time per bus and the last entry time in its subtree. */
  readonly entry: Int32Array
  readonly exit: Int32Array
}

/** The outages, resolved: a branch by index, or a unit by its bus, output and reserve participation. */
export interface SnapshotContingencies {
  readonly count: number
  /** Branch index, or -1 for a unit. */
  readonly branch: Int32Array
  /** Circuits of the branch the outage takes out (1 to its circuits), or 0 for a unit. */
  readonly circuitsLost: Int32Array
  /** The unit's bus, or -1 for a branch. */
  readonly bus: Int32Array
  /** The unit's output (MW); a branch's pre-contingency flow is in `flowsMw`. */
  readonly unitOutputMw: Float64Array
  readonly removedUpMw: Float64Array
  readonly removedDownMw: Float64Array
  readonly removedKineticEnergyMws: Float64Array
  readonly removedForming: Int32Array
}

/**
 * Each branch's loading basis (contingency-case.ts CaseLoadingBase): `mva` 1 where its island's AC
 * load flow converged, judged on the larger end apparent power with the base reactive power held;
 * else on |active power|.
 */
export interface SnapshotLoading {
  readonly mva: Uint8Array
  readonly toActiveMw: Float64Array
  readonly fromReactiveMvar: Float64Array
  readonly toReactiveMvar: Float64Array
}

export interface ContingencySnapshot {
  readonly network: SnapshotNetwork
  readonly islands: SnapshotIslands
  readonly factors: SnapshotFactors
  readonly bridges: SnapshotBridges
  readonly participation: CaseParticipation
  /**
   * DC balance injections per bus, and base flows per branch in the model the case declares for
   * each island (ContingencyCase.baseFlowModels: AC where its load flow converged, else DC); the
   * kernel adds DC increments to them (MW, positive from-bus to to-bus).
   */
  readonly injectionsMw: Float64Array
  readonly flowsMw: Float64Array
  /** Rating basis × availability per branch (MW, or MVA on the apparent-power basis). */
  readonly capacityMw: Float64Array
  readonly loading: SnapshotLoading
  readonly contingencies: SnapshotContingencies
}

/** Most-loaded overloaded branches each result lists. */
export const maximumListedOverloads = 20

export const balancingByCode: ReadonlyArray<Balancing> = ['reserves', 'inertia', 'de-energised']

/** Integer fields of one result record; each of the (at most two) parts adds a bus count and a balancing code. */
export const recordInteger = { islanding: 0, partCount: 1, worstBranch: 2, violationCount: 3, listedCount: 4, firstPart: 5 } as const
export const recordIntegerWidth = 9
/** Float fields of one result record; each part adds imbalance, reserve shortfall and unserved load (MW). */
export const recordValue = { lostMw: 0, worstFlowMw: 1, worstLoadingPercent: 2, firstPart: 3 } as const
export const recordValueWidth = 9
export const maximumRecordParts = 2

/** Per-contingency results in input order. */
export interface ScreeningRecords {
  readonly count: number
  readonly integers: Int32Array
  readonly values: Float64Array
  /** Listed overloaded branches with their post-contingency flows (MW) and loading (%), `maximumListedOverloads` slots per contingency. */
  readonly listedBranches: Int32Array
  readonly listedFlowsMw: Float64Array
  readonly listedLoadingPercent: Float64Array
}

export const sharedInt32 = (length: number): Int32Array => new Int32Array(new SharedArrayBuffer(length * Int32Array.BYTES_PER_ELEMENT))
export const sharedFloat64 = (length: number): Float64Array => new Float64Array(new SharedArrayBuffer(length * Float64Array.BYTES_PER_ELEMENT))
export const sharedUint8 = (length: number): Uint8Array => new Uint8Array(new SharedArrayBuffer(length))

export const sharedScreeningRecords = (count: number): ScreeningRecords => ({
  count,
  integers: sharedInt32(count * recordIntegerWidth),
  values: sharedFloat64(count * recordValueWidth),
  listedBranches: sharedInt32(count * maximumListedOverloads),
  listedFlowsMw: sharedFloat64(count * maximumListedOverloads),
  listedLoadingPercent: sharedFloat64(count * maximumListedOverloads),
})
