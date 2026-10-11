import type { GridGeneratorDefinition } from '../grid-model.ts'
import type { GridAutomation, ReserveRequirement } from '../schemas/grid-automation.ts'
import { reserveRequirementMw, type ReserveProduct } from './frequency/governors.ts'
import type { ExternalReserveAllocation, FrequencyReserveAllocation } from './frequency/types.ts'
import { droopFcrCapabilityMw, governorForGenerator } from './generator-dynamics.ts'

/** Upward reserve allocated to a unit across products (MW). */
export const upwardReserveMw = (reserves: FrequencyReserveAllocation): number =>
  reserves.fcrNMw + reserves.fcrDUpMw + reserves.afrrUpMw + reserves.mfrrUpMw

export interface ReserveCandidate {
  readonly definition: GridGeneratorDefinition
  readonly synchronised: boolean
  /** Minimum stable generation: downward reserve stops there. */
  readonly minimumMw: number
  readonly availableMw: number
  readonly targetMw: number
}

/** A synchronous island's place in its synchronous area: Nordic reserve volumes are dimensioned for the area. */
export interface SynchronousArea {
  /** Connected demand of the island's own loads (MW). */
  readonly islandLoadMw: number
  /** Synchronous external equivalents in the island: with one, the island is part of their synchronous area. */
  readonly externals: ReadonlyArray<{ readonly reserves: ExternalReserveAllocation; readonly loadMw: number }>
}

/**
 * A product's requirement for a synchronous island, dimensioned per synchronous area: the island
 * with the synchronous external equivalent it holds. A fixed volume is the synchronous area's
 * (the Nordic 600 MW FCR-N, 1,450 MW FCR-D up, …): an island that holds no equivalent is detached
 * from that area, carries none of it, and its units hold only their own droop and headroom (null).
 * A share-of-load requirement counts the equivalent's demand with the island's; a largest-unit
 * requirement looks at the island's own units (the equivalent declares none).
 */
export const synchronousAreaRequirementMw = (
  requirement: ReserveRequirement,
  area: SynchronousArea,
  units: ReadonlyArray<{ readonly synchronised: boolean; readonly targetMw: number }>,
): number | null => {
  if (requirement.basis === 'fixed' && area.externals.length === 0) return null
  const areaLoadMw = area.islandLoadMw + area.externals.reduce((sum, external) => sum + external.loadMw, 0)
  return reserveRequirementMw(requirement, areaLoadMw, units)
}

export interface IslandReserveProduct {
  readonly product: ReserveProduct
  /** The Automation's requirement for the island's synchronous area; null for a detached island under a fixed area volume. */
  readonly requirementMw: number | null
  /** Part of the requirement held by synchronous external systems in the island. */
  readonly externalMw: number
  /** Allocated to the island's own units. */
  readonly allocatedMw: number
  readonly deficitMw: number
}

const allocationField: Record<ReserveProduct, keyof FrequencyReserveAllocation> = {
  fcrN: 'fcrNMw', fcrDUp: 'fcrDUpMw', fcrDDown: 'fcrDDownMw',
  afrrUp: 'afrrUpMw', afrrDown: 'afrrDownMw', mfrrUp: 'mfrrUpMw', mfrrDown: 'mfrrDownMw',
}

const externalField: Partial<Record<ReserveProduct, keyof ExternalReserveAllocation>> = {
  fcrN: 'fcrNMw', fcrDUp: 'fcrDUpMw', fcrDDown: 'fcrDDownMw', afrrUp: 'afrrUpMw', afrrDown: 'afrrDownMw',
}

/**
 * Allocates an island's reserve requirements to the units in it, dimensioned per synchronous area
 * (`synchronousAreaRequirementMw`). Synchronous external systems in the island hold their own
 * share of the area's volume, so the island's units are allocated only the rest. Each unit offers
 * at most its headroom around its set-point and, for FCR, what its governor droop delivers
 * (`droopFcrCapabilityMw`); the requirement is shared in proportion to that offer. A detached
 * island under a fixed area volume allocates every eligible unit its full offer. Products are
 * served FCR-N, FCR-D, aFRR, mFRR, each reporting deficits. Allocations are made at dispatch and
 * then kept by the units: an island that later separates keeps only its own units' allocations
 * and headroom.
 */
export const allocateIslandReserves = (config: {
  readonly automation: GridAutomation
  readonly units: ReadonlyArray<ReserveCandidate>
  readonly area: SynchronousArea
}): { readonly allocations: ReadonlyMap<string, FrequencyReserveAllocation>; readonly products: ReadonlyArray<IslandReserveProduct> } => {
  const { automation } = config
  const synchronised = config.units.filter(unit => unit.synchronised)
  const up = new Map(synchronised.map(unit => [unit.definition.id, Math.max(0, unit.availableMw - unit.targetMw)]))
  const down = new Map(synchronised.map(unit => [unit.definition.id, Math.max(0, unit.targetMw - unit.minimumMw)]))
  const droop = new Map(synchronised.map(unit => [unit.definition.id, droopFcrCapabilityMw(unit.definition, automation)]))
  const allocations = new Map(config.units.map(unit => [unit.definition.id, {
    fcrNMw: 0, fcrDUpMw: 0, fcrDDownMw: 0, afrrUpMw: 0, afrrDownMw: 0, mfrrUpMw: 0, mfrrDownMw: 0,
  } as Record<keyof FrequencyReserveAllocation, number>]))
  const requirementUnits = synchronised.map(unit => ({ synchronised: true, targetMw: unit.targetMw }))
  const products: IslandReserveProduct[] = []
  const allocate = (product: ReserveProduct, requirement: ReserveRequirement, eligible: ReadonlyArray<string>, direction: 'up' | 'down' | 'symmetric'): void => {
    const requirementMw = synchronousAreaRequirementMw(requirement, config.area, requirementUnits)
    const field = externalField[product]
    const externalMw = field === undefined ? 0 : config.area.externals.reduce((sum, external) => sum + external.reserves[field], 0)
    const unitRequirementMw = requirementMw === null ? Number.POSITIVE_INFINITY : Math.max(0, requirementMw - externalMw)
    const offer = (unit: ReserveCandidate): number => {
      const id = unit.definition.id
      const room = direction === 'up' ? up.get(id)! : direction === 'down' ? down.get(id)! : Math.min(up.get(id)!, down.get(id)!)
      const capability = droop.get(id)!
      const governor = product === 'fcrN' ? capability.fcrNMw : product === 'fcrDUp' ? capability.fcrDUpMw : product === 'fcrDDown' ? capability.fcrDDownMw : Number.POSITIVE_INFINITY
      return Math.min(room, governor)
    }
    const candidates = synchronised.filter(unit => eligible.includes(governorForGenerator(unit.definition).governorClass))
    const totalOffer = candidates.reduce((sum, unit) => sum + offer(unit), 0)
    const share = totalOffer <= unitRequirementMw ? 1 : unitRequirementMw / totalOffer
    let allocatedMw = 0
    for (const unit of candidates) {
      const mw = offer(unit) * share
      if (mw <= 0) continue
      const id = unit.definition.id
      allocations.get(id)![allocationField[product]] = mw
      if (direction !== 'down') up.set(id, up.get(id)! - mw)
      if (direction !== 'up') down.set(id, down.get(id)! - mw)
      allocatedMw += mw
    }
    products.push({ product, requirementMw, externalMw, allocatedMw, deficitMw: requirementMw === null ? 0 : Math.max(0, unitRequirementMw - allocatedMw) })
  }
  allocate('fcrN', automation.fcrN.requirement, automation.fcrN.eligibleGovernorClasses, 'symmetric')
  allocate('fcrDUp', automation.fcrD.up.requirement, automation.fcrD.eligibleGovernorClasses, 'up')
  allocate('fcrDDown', automation.fcrD.down.requirement, automation.fcrD.eligibleGovernorClasses, 'down')
  if (automation.afrr.enabled) {
    allocate('afrrUp', automation.afrr.requirement.up, automation.afrr.eligibleGovernorClasses, 'up')
    allocate('afrrDown', automation.afrr.requirement.down, automation.afrr.eligibleGovernorClasses, 'down')
  }
  if (automation.mfrr.enabled) {
    allocate('mfrrUp', automation.mfrr.requirement.up, automation.mfrr.eligibleGovernorClasses, 'up')
    allocate('mfrrDown', automation.mfrr.requirement.down, automation.mfrr.eligibleGovernorClasses, 'down')
  }
  return { allocations, products }
}
