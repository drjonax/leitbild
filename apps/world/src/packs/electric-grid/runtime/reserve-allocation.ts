import type { GridGeneratorDefinition } from '../grid-model.ts'
import type { GridAutomation, ReserveRequirement } from '../schemas/grid-automation.ts'
import { reserveRequirementMw, type ReserveProduct } from './frequency/governors.ts'
import type { ExternalReserveAllocation, FrequencyReserveAllocation } from './frequency/types.ts'
import { droopFcrCapabilityMw, dynamicsForGenerator } from './generator-dynamics.ts'

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

export interface IslandReserveProduct {
  readonly product: ReserveProduct
  /** The Automation's requirement evaluated for the island. */
  readonly requirementMw: number
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
 * Allocates an island's reserve requirements to the units in it. Synchronous external systems in
 * the island hold their own share of a synchronous-area volume, so the island's units are
 * allocated only the rest. Each unit offers at most its headroom around its set-point and, for
 * FCR, what its governor droop delivers (`droopFcrCapabilityMw`); the requirement is shared in
 * proportion to that offer. Products are served FCR-N, FCR-D, aFRR, mFRR, each reporting deficits.
 * Allocations are made at dispatch and then kept by the units: an island that later separates keeps
 * only its own units' allocations and headroom.
 */
export const allocateIslandReserves = (config: {
  readonly automation: GridAutomation
  readonly units: ReadonlyArray<ReserveCandidate>
  readonly islandLoadMw: number
  readonly externals: ReadonlyArray<ExternalReserveAllocation>
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
    const requirementMw = reserveRequirementMw(requirement, config.islandLoadMw, requirementUnits)
    const field = externalField[product]
    const externalMw = field === undefined ? 0 : config.externals.reduce((sum, external) => sum + external[field], 0)
    const unitRequirementMw = Math.max(0, requirementMw - externalMw)
    const offer = (unit: ReserveCandidate): number => {
      const id = unit.definition.id
      const room = direction === 'up' ? up.get(id)! : direction === 'down' ? down.get(id)! : Math.min(up.get(id)!, down.get(id)!)
      const capability = droop.get(id)!
      const governor = product === 'fcrN' ? capability.fcrNMw : product === 'fcrDUp' ? capability.fcrDUpMw : product === 'fcrDDown' ? capability.fcrDDownMw : Number.POSITIVE_INFINITY
      return Math.min(room, governor)
    }
    const candidates = synchronised.filter(unit => eligible.includes(dynamicsForGenerator(unit.definition).governorClass))
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
    products.push({ product, requirementMw, externalMw, allocatedMw, deficitMw: Math.max(0, unitRequirementMw - allocatedMw) })
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
