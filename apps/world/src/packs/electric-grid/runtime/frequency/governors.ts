import type { GridAutomation, ReserveRequirement } from '../../schemas/grid-automation.ts'
import type { ResponseElement } from './swing.ts'
import type { FrequencyReserveAllocation, FrequencyUnit } from './types.ts'

const clamp01 = (value: number): number => value <= 0 ? 0 : value >= 1 ? 1 : value

/** FCR-N activation in −1..1; positive raises output. Linear outside the deadband up to full deviation. */
export const fcrNActivation = (frequencyHz: number, nominalHz: number, config: GridAutomation['fcrN']): number => {
  const deviationHz = frequencyHz - nominalHz
  const magnitude = clamp01((Math.abs(deviationHz) - config.deadbandHz) / (config.fullActivationDeviationHz - config.deadbandHz))
  return deviationHz < 0 ? magnitude : -magnitude
}

/** FCR-D up activation in 0..1, linear from startHz down to fullHz. */
export const fcrDUpActivation = (frequencyHz: number, config: GridAutomation['fcrD']['up']): number =>
  clamp01((config.startHz - frequencyHz) / (config.startHz - config.fullHz))

/** FCR-D down activation in 0..1, linear from startHz up to fullHz. */
export const fcrDDownActivation = (frequencyHz: number, config: GridAutomation['fcrD']['down']): number =>
  clamp01((frequencyHz - config.startHz) / (config.fullHz - config.startHz))

/** Deliverable FCR per unit: allocations limited by the headroom left above and below its base output. */
export interface UnitFcrCaps {
  readonly fcrNUpMw: number
  readonly fcrNDownMw: number
  readonly fcrDUpMw: number
  readonly fcrDDownMw: number
}

/**
 * Splits the headroom around a unit's base output (schedule plus aFRR and mFRR adjustments)
 * between its FCR-N and FCR-D allocations, FCR-N first. Upward room is taken from the highest
 * base output within the step and downward room from the lowest.
 */
export const unitFcrCaps = (unit: FrequencyUnit, highestBaseMw: number, lowestBaseMw: number): UnitFcrCaps => {
  if (!unit.synchronised) return { fcrNUpMw: 0, fcrNDownMw: 0, fcrDUpMw: 0, fcrDDownMw: 0 }
  const upRoom = Math.max(0, unit.maximumMw - highestBaseMw)
  const downRoom = Math.max(0, lowestBaseMw - unit.minimumMw)
  const fcrNUpMw = Math.min(unit.reserves.fcrNMw, upRoom)
  const fcrNDownMw = Math.min(unit.reserves.fcrNMw, downRoom)
  return {
    fcrNUpMw,
    fcrNDownMw,
    fcrDUpMw: Math.min(unit.reserves.fcrDUpMw, upRoom - fcrNUpMw),
    fcrDDownMw: Math.min(unit.reserves.fcrDDownMw, downRoom - fcrNDownMw),
  }
}

/** The governor limiter keeps a response within what the unit can currently deliver. */
const limited = (outputMw: number, upMw: number, downMw: number): number => Math.min(upMw, Math.max(-downMw, outputMw))

export const fcrNElement = (config: {
  readonly outputMw: number
  readonly caps: UnitFcrCaps
  readonly nominalHz: number
  readonly fcrN: GridAutomation['fcrN']
}): ResponseElement => ({
  outputMw: limited(config.outputMw, config.caps.fcrNUpMw, config.caps.fcrNDownMw),
  timeConstantSeconds: config.fcrN.timeConstantSeconds,
  target: frequencyHz => {
    const activation = fcrNActivation(frequencyHz, config.nominalHz, config.fcrN)
    return activation * (activation >= 0 ? config.caps.fcrNUpMw : config.caps.fcrNDownMw)
  },
})

export const fcrDUpElement = (config: {
  readonly outputMw: number
  readonly caps: UnitFcrCaps
  readonly up: GridAutomation['fcrD']['up']
}): ResponseElement => ({
  outputMw: limited(config.outputMw, config.caps.fcrDUpMw, 0),
  timeConstantSeconds: config.up.timeConstantSeconds,
  target: frequencyHz => fcrDUpActivation(frequencyHz, config.up) * config.caps.fcrDUpMw,
})

export const fcrDDownElement = (config: {
  readonly outputMw: number
  readonly caps: UnitFcrCaps
  readonly down: GridAutomation['fcrD']['down']
}): ResponseElement => ({
  outputMw: limited(config.outputMw, 0, config.caps.fcrDDownMw),
  timeConstantSeconds: config.down.timeConstantSeconds,
  target: frequencyHz => -fcrDDownActivation(frequencyHz, config.down) * config.caps.fcrDDownMw,
})

export type ReserveProduct = 'fcrN' | 'fcrDUp' | 'fcrDDown' | 'afrrUp' | 'afrrDown' | 'mfrrUp' | 'mfrrDown'

export interface ReserveProductAllocation {
  readonly product: ReserveProduct
  readonly requirementMw: number
  readonly allocatedMw: number
  readonly deficitMw: number
}

export interface ReserveAllocationResult {
  readonly allocations: ReadonlyMap<string, FrequencyReserveAllocation>
  readonly products: ReadonlyArray<ReserveProductAllocation>
}

export const noReserves: FrequencyReserveAllocation = Object.freeze({
  fcrNMw: 0, fcrDUpMw: 0, fcrDDownMw: 0, afrrUpMw: 0, afrrDownMw: 0, mfrrUpMw: 0, mfrrDownMw: 0,
})

/** A reserve requirement evaluated for one island: fixed, a share of its demand, or a multiple of its largest synchronised unit output. */
export const reserveRequirementMw = (requirement: ReserveRequirement, islandLoadMw: number, units: ReadonlyArray<Pick<FrequencyUnit, 'synchronised' | 'targetMw'>>): number =>
  reserveRequirementFor(requirement, islandLoadMw, requirement.basis === 'largest-unit-output'
    ? units.reduce((maximum, unit) => unit.synchronised ? Math.max(maximum, unit.targetMw) : maximum, 0)
    : 0)

/** reserveRequirementMw given the largest synchronised unit's set-point (read only for a largest-unit requirement). */
export const reserveRequirementFor = (requirement: ReserveRequirement, islandLoadMw: number, largestUnitMw: number): number => {
  if (requirement.basis === 'fixed') return requirement.mw
  if (requirement.basis === 'share-of-island-load') return requirement.fraction * islandLoadMw
  return requirement.factor * largestUnitMw
}

const allocationField: Record<ReserveProduct, keyof FrequencyReserveAllocation> = {
  fcrN: 'fcrNMw', fcrDUp: 'fcrDUpMw', fcrDDown: 'fcrDDownMw',
  afrrUp: 'afrrUpMw', afrrDown: 'afrrDownMw', mfrrUp: 'mfrrUpMw', mfrrDown: 'mfrrDownMw',
}

/**
 * Allocates each reserve product's requirement over eligible synchronised units in proportion
 * to their remaining headroom around the set-point. Products are served in the order FCR-N,
 * FCR-D, aFRR, mFRR; a product that cannot be covered reports its deficit.
 */
export const allocateFrequencyReserves = (config: {
  readonly automation: GridAutomation
  readonly units: ReadonlyArray<Omit<FrequencyUnit, 'reserves'>>
  readonly islandLoadMw: number
}): ReserveAllocationResult => {
  const { automation, units } = config
  const up = new Map(units.map(unit => [unit.id, unit.synchronised ? Math.max(0, unit.maximumMw - unit.targetMw) : 0]))
  const down = new Map(units.map(unit => [unit.id, unit.synchronised ? Math.max(0, unit.targetMw - unit.minimumMw) : 0]))
  const allocations = new Map(units.map(unit => [unit.id, { ...noReserves } as Record<keyof FrequencyReserveAllocation, number>]))
  const products: ReserveProductAllocation[] = []
  const allocate = (
    product: ReserveProduct,
    requirement: ReserveRequirement,
    eligible: ReadonlyArray<string>,
    direction: 'up' | 'down' | 'symmetric',
  ): void => {
    const required = reserveRequirementMw(requirement, config.islandLoadMw, units)
    const candidates = units.filter(unit => unit.synchronised && eligible.includes(unit.governorClass))
    const room = (unitId: string): number => direction === 'up' ? up.get(unitId)! : direction === 'down' ? down.get(unitId)! : Math.min(up.get(unitId)!, down.get(unitId)!)
    const totalRoom = candidates.reduce((sum, unit) => sum + room(unit.id), 0)
    const share = totalRoom <= required ? 1 : required / totalRoom
    let allocated = 0
    for (const unit of candidates) {
      const mw = room(unit.id) * share
      if (mw <= 0) continue
      allocations.get(unit.id)![allocationField[product]] = mw
      if (direction !== 'down') up.set(unit.id, up.get(unit.id)! - mw)
      if (direction !== 'up') down.set(unit.id, down.get(unit.id)! - mw)
      allocated += mw
    }
    products.push({ product, requirementMw: required, allocatedMw: allocated, deficitMw: Math.max(0, required - allocated) })
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
