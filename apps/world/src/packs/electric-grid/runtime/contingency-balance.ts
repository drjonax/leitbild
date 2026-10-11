// How one electrical part of a screening case closes its balance after a contingency or a remedial
// change. Dependency-free, so the N-1 worker threads load it without the Grid runtime.

/** Below this an island's injection sum counts as balanced (MW); the runtime closes balances to 1e-6 MW. */
export const balanceToleranceMw = 1e-6

/** Reserve participation at each bus: what picks up an imbalance after a contingency. */
export interface CaseParticipation {
  /** FCR-N + FCR-D up of synchronised units and synchronous external systems (MW). */
  readonly upMw: Float64Array
  /** FCR-N + FCR-D down (MW). */
  readonly downMw: Float64Array
  /** Kinetic energy of synchronised synchronous units and external systems (MWs); shares an imbalance where no reserve can. */
  readonly kineticEnergyMws: Float64Array
  /** Voltage-forming sources (synchronised synchronous units and synchronous external systems). */
  readonly formingCount: Int32Array
  /** Demand served at each bus (MW). */
  readonly servedLoadMw: Float64Array
}

export type Balancing = 'reserves' | 'inertia' | 'de-energised'

export interface PartBalance {
  readonly balancing: Balancing
  /** Injection sum the part had to absorb (MW, positive: surplus). */
  readonly imbalanceMw: number
  /** Imbalance beyond the part's reserve in that direction (MW). */
  readonly reserveShortfallMw: number
  readonly unservedLoadMw: number
}

/** One unit taken out of a part's participation (a generator contingency). */
export interface RemovedParticipant {
  readonly bus: number
  readonly upMw: number
  readonly downMw: number
  readonly kineticEnergyMws: number
  readonly forming: number
}

/**
 * Rebalances the buses `members` (one electrical part) in `injections`: a part without a
 * voltage-forming source loses every injection (its demand is unserved); a live part shares its
 * injection sum among its FCR providers in proportion to their reserve in the needed direction, or
 * by kinetic energy where it holds no such reserve. `removed` takes one unit out of the part.
 */
export const rebalancePart = (config: {
  readonly participation: CaseParticipation
  readonly members: ArrayLike<number>
  readonly injections: Float64Array
  readonly removed: RemovedParticipant | null
}): PartBalance => {
  const { participation, members, injections, removed } = config
  const at = (bus: number, values: Float64Array, field: 'upMw' | 'downMw' | 'kineticEnergyMws'): number =>
    removed !== null && removed.bus === bus ? values[bus]! - removed[field] : values[bus]!
  let sumMw = 0
  let forming = 0
  for (let index = 0; index < members.length; index += 1) {
    const bus = members[index]!
    sumMw += injections[bus]!
    forming += removed !== null && removed.bus === bus ? participation.formingCount[bus]! - removed.forming : participation.formingCount[bus]!
  }
  if (forming === 0) {
    let unservedMw = 0
    for (let index = 0; index < members.length; index += 1) {
      const bus = members[index]!
      unservedMw += participation.servedLoadMw[bus]!
      injections[bus] = 0
    }
    return { balancing: 'de-energised', imbalanceMw: sumMw, reserveShortfallMw: 0, unservedLoadMw: unservedMw }
  }
  if (Math.abs(sumMw) <= balanceToleranceMw) return { balancing: 'reserves', imbalanceMw: sumMw, reserveShortfallMw: 0, unservedLoadMw: 0 }
  // A surplus (sum > 0) is absorbed by downward reserve, a deficit by upward reserve.
  const surplus = sumMw > 0
  const reserve = (bus: number): number => surplus ? at(bus, participation.downMw, 'downMw') : at(bus, participation.upMw, 'upMw')
  const inertia = (bus: number): number => at(bus, participation.kineticEnergyMws, 'kineticEnergyMws')
  let reserveMw = 0
  for (let index = 0; index < members.length; index += 1) reserveMw += reserve(members[index]!)
  const byReserve = reserveMw > balanceToleranceMw
  const weight = byReserve ? reserve : inertia
  let totalWeight = 0
  for (let index = 0; index < members.length; index += 1) totalWeight += weight(members[index]!)
  for (let index = 0; index < members.length; index += 1) {
    const bus = members[index]!
    const share = weight(bus)
    if (share !== 0) injections[bus] = injections[bus]! - sumMw * share / totalWeight
  }
  return { balancing: byReserve ? 'reserves' : 'inertia', imbalanceMw: sumMw, reserveShortfallMw: Math.max(0, Math.abs(sumMw) - reserveMw), unservedLoadMw: 0 }
}
