import type { GridAutomation, ReserveRequirement } from '../schemas/grid-automation.ts'
import { reserveRequirementFor } from './frequency/governors.ts'
import { eligibleAfrr, eligibleFcrD, eligibleFcrN, eligibleMfrr, governorEligibility } from './frequency/workspace.ts'
import { droopFcrCapabilityMw, governorForGenerator } from './generator-dynamics.ts'
import type { GridRuntimeInstance, GridTopologyIsland } from './instance.ts'
import { externalReserveVolumes } from './island-input.ts'
import { connectedGridLoadMw } from './load-service.ts'
import { generatorOnline, type GridGeneratorArrays } from './state/arrays.ts'
import { generatorMinimumStableMw } from './unit-commitment.ts'

const allocationInputs = new WeakMap<GridRuntimeInstance, WeakMap<GridTopologyIsland, Float64Array>>()

/**
 * Allocates an energised island's reserves to its online units from their present set-points:
 * each unit offers its headroom (availability − set-point) and footroom (set-point − minimum
 * stable generation) within its droop and product eligibility, against the requirement of the
 * island's synchronous area (allocateIslandReserves below); a detached island uses its own units' droop
 * and room. Called before every frequency advance and at dispatch, so a unit started into a live
 * island, a trimmed set-point or a black-started island picking up load holds reserve from its
 * present room. A pure function of set-points, availability, lifecycle and connected demand, which
 * change only at segment boundaries, so the advance does not depend on the adapter step.
 */
export const allocateGridIslandReserves = (grid: GridRuntimeInstance, structure: GridTopologyIsland): void => {
  const generators = grid.arrays.generators
  const loads = grid.arrays.loads
  let islandLoadMw = 0
  for (let loadPosition = 0; loadPosition < structure.loadIndices.length; loadPosition += 1) {
    const load = structure.loadIndices[loadPosition]!
    islandLoadMw += connectedGridLoadMw(loads, load)
  }
  const externalSystems = grid.definition.index.externalSystems
  // The allocation is a pure function of these inputs: when none changed since the island's last
  // allocation, the units keep it (most advances: set-points move only by command or dispatch).
  const length = structure.generatorIndices.length * 3 + 1 + structure.externalIndices.length * 6
  let byIsland = allocationInputs.get(grid)
  if (byIsland === undefined) {
    byIsland = new WeakMap()
    allocationInputs.set(grid, byIsland)
  }
  let inputs = byIsland.get(structure)
  let changed = inputs === undefined || inputs.length !== length
  if (inputs === undefined || inputs.length !== length) {
    inputs = new Float64Array(length)
    byIsland.set(structure, inputs)
  }
  let position = 0
  const record = (value: number): void => {
    if (inputs![position] !== value) {
      inputs![position] = value
      changed = true
    }
    position += 1
  }
  for (let generatorPosition = 0; generatorPosition < structure.generatorIndices.length; generatorPosition += 1) {
    const generator = structure.generatorIndices[generatorPosition]!
    record(generators.lifecycle[generator] === generatorOnline ? 1 : 0)
    record(generators.availableMw[generator]!)
    record(generators.targetMw[generator]!)
  }
  record(islandLoadMw)
  for (let systemPosition = 0; systemPosition < structure.externalIndices.length; systemPosition += 1) {
    const system = structure.externalIndices[systemPosition]!
    const reserves = externalReserveVolumes(grid, externalSystems[system]!)
    for (let field = 0; field < reserves.length; field += 1) record(reserves[field]!)
  }
  if (!changed) return
  allocateIslandReserves(grid, structure, islandLoadMw)
}

/** A reserve product as the allocation serves it, in serving order. */
interface ServedProduct {
  readonly requirement: ReserveRequirement
  /** The eligible* bit of the product's family (frequency/workspace.ts). */
  readonly eligibility: number
  readonly direction: 'up' | 'down' | 'symmetric'
  /** The governor's droop capability that bounds the offer (0 FCR-N, 1 FCR-D up, 2 FCR-D down); −1: the room alone. */
  readonly droop: number
  /** Position of the product in externalReserveVolumes; −1: external systems hold none of it. */
  readonly externalVolume: number
  readonly allocated: (generators: GridGeneratorArrays) => Float64Array
}

const servedProductTables = new WeakMap<GridAutomation, ReadonlyArray<ServedProduct>>()

/** Products in serving order: FCR-N, FCR-D, aFRR, mFRR (aFRR and mFRR only when the Automation runs them). */
const servedProducts = (automation: GridAutomation): ReadonlyArray<ServedProduct> => {
  const cached = servedProductTables.get(automation)
  if (cached) return cached
  const products: ServedProduct[] = [
    { requirement: automation.fcrN.requirement, eligibility: eligibleFcrN, direction: 'symmetric', droop: 0, externalVolume: 0, allocated: generators => generators.fcrNReserveMw },
    { requirement: automation.fcrD.up.requirement, eligibility: eligibleFcrD, direction: 'up', droop: 1, externalVolume: 1, allocated: generators => generators.fcrDUpReserveMw },
    { requirement: automation.fcrD.down.requirement, eligibility: eligibleFcrD, direction: 'down', droop: 2, externalVolume: 2, allocated: generators => generators.fcrDDownReserveMw },
    ...(automation.afrr.enabled ? [
      { requirement: automation.afrr.requirement.up, eligibility: eligibleAfrr, direction: 'up', droop: -1, externalVolume: 3, allocated: generators => generators.afrrUpReserveMw },
      { requirement: automation.afrr.requirement.down, eligibility: eligibleAfrr, direction: 'down', droop: -1, externalVolume: 4, allocated: generators => generators.afrrDownReserveMw },
    ] satisfies ServedProduct[] : []),
    ...(automation.mfrr.enabled ? [
      { requirement: automation.mfrr.requirement.up, eligibility: eligibleMfrr, direction: 'up', droop: -1, externalVolume: -1, allocated: generators => generators.mfrrUpReserveMw },
      { requirement: automation.mfrr.requirement.down, eligibility: eligibleMfrr, direction: 'down', droop: -1, externalVolume: -1, allocated: generators => generators.mfrrDownReserveMw },
    ] satisfies ServedProduct[] : []),
  ]
  servedProductTables.set(automation, products)
  return products
}

/** Per-Grid unit data of the allocation by model index, and its room scratch. */
interface ReserveTables {
  readonly minimumMw: Float64Array
  /** Droop capability (MW): FCR-N, FCR-D up, FCR-D down (droopFcrCapabilityMw). */
  readonly droop: readonly [Float64Array, Float64Array, Float64Array]
  readonly eligibility: Uint8Array
  /** Remaining headroom and footroom of each online unit while products are served. */
  readonly up: Float64Array
  readonly down: Float64Array
}

const reserveTablesByGrid = new WeakMap<GridRuntimeInstance, ReserveTables>()

const reserveTablesFor = (grid: GridRuntimeInstance): ReserveTables => {
  const cached = reserveTablesByGrid.get(grid)
  if (cached) return cached
  const { model, automation } = grid.definition
  const capabilities = model.generators.map(definition => droopFcrCapabilityMw(definition, automation))
  const tables: ReserveTables = {
    minimumMw: Float64Array.from(model.generators, generatorMinimumStableMw),
    droop: [
      Float64Array.from(capabilities, capability => capability.fcrNMw),
      Float64Array.from(capabilities, capability => capability.fcrDUpMw),
      Float64Array.from(capabilities, capability => capability.fcrDDownMw),
    ],
    eligibility: Uint8Array.from(model.generators, definition => governorEligibility(automation, governorForGenerator(definition).governorClass)),
    up: new Float64Array(model.generators.length),
    down: new Float64Array(model.generators.length),
  }
  reserveTablesByGrid.set(grid, tables)
  return tables
}

/**
 * Allocates an island's reserve requirements to its online units, dimensioned per synchronous
 * area: the island's demand with that of the synchronous external systems it holds, which hold
 * their own share of the area's volume, so the units are allocated only the rest. An island that
 * holds no external system is detached from the area: under a fixed area volume (the Nordic
 * 600 MW FCR-N, 1,450 MW FCR-D up, …) every eligible unit is allocated its full offer. A unit
 * offers at most its room around its set-point and, for FCR, what its governor droop delivers;
 * the requirement is shared in proportion to the offers. Products are served FCR-N, FCR-D, aFRR,
 * mFRR, each from the room the earlier ones left. Writes every island unit's allocation.
 */
const allocateIslandReserves = (grid: GridRuntimeInstance, structure: GridTopologyIsland, islandLoadMw: number): void => {
  const generators = grid.arrays.generators
  const tables = reserveTablesFor(grid)
  const { up, down, droop, eligibility } = tables
  const units = structure.generatorIndices
  const externalSystems = grid.definition.index.externalSystems
  let externalLoadMw = 0
  for (let systemPosition = 0; systemPosition < structure.externalIndices.length; systemPosition += 1) {
    externalLoadMw += externalReserveVolumes(grid, externalSystems[structure.externalIndices[systemPosition]!]!)[5]!
  }
  const areaLoadMw = islandLoadMw + externalLoadMw
  let largestUnitMw = 0
  for (let position = 0; position < units.length; position += 1) {
    const generator = units[position]!
    generators.fcrNReserveMw[generator] = 0
    generators.fcrDUpReserveMw[generator] = 0
    generators.fcrDDownReserveMw[generator] = 0
    generators.afrrUpReserveMw[generator] = 0
    generators.afrrDownReserveMw[generator] = 0
    generators.mfrrUpReserveMw[generator] = 0
    generators.mfrrDownReserveMw[generator] = 0
    if (generators.lifecycle[generator] !== generatorOnline) continue
    const availableMw = generators.availableMw[generator]!
    const targetMw = generators.targetMw[generator]!
    up[generator] = Math.max(0, availableMw - targetMw)
    down[generator] = Math.max(0, targetMw - tables.minimumMw[generator]!)
    largestUnitMw = Math.max(largestUnitMw, targetMw)
  }
  for (const product of servedProducts(grid.definition.automation)) {
    const requirementMw = product.requirement.basis === 'fixed' && structure.externalIndices.length === 0
      ? null
      : reserveRequirementFor(product.requirement, areaLoadMw, largestUnitMw)
    let externalMw = 0
    for (let systemPosition = 0; product.externalVolume >= 0 && systemPosition < structure.externalIndices.length; systemPosition += 1) {
      externalMw += externalReserveVolumes(grid, externalSystems[structure.externalIndices[systemPosition]!]!)[product.externalVolume]!
    }
    const unitRequirementMw = requirementMw === null ? Number.POSITIVE_INFINITY : Math.max(0, requirementMw - externalMw)
    const capability = product.droop >= 0 ? droop[product.droop]! : null
    const offerMw = (generator: number): number => {
      const room = product.direction === 'up' ? up[generator]! : product.direction === 'down' ? down[generator]! : Math.min(up[generator]!, down[generator]!)
      return Math.min(room, capability === null ? Number.POSITIVE_INFINITY : capability[generator]!)
    }
    const candidate = (generator: number): boolean => generators.lifecycle[generator] === generatorOnline && (eligibility[generator]! & product.eligibility) !== 0
    let totalOfferMw = 0
    for (let position = 0; position < units.length; position += 1) {
      const generator = units[position]!
      if (candidate(generator)) totalOfferMw += offerMw(generator)
    }
    const share = totalOfferMw <= unitRequirementMw ? 1 : unitRequirementMw / totalOfferMw
    const allocated = product.allocated(generators)
    for (let position = 0; position < units.length; position += 1) {
      const generator = units[position]!
      if (!candidate(generator)) continue
      const mw = offerMw(generator) * share
      if (mw <= 0) continue
      allocated[generator] = mw
      if (product.direction !== 'down') up[generator] = up[generator]! - mw
      if (product.direction !== 'up') down[generator] = down[generator]! - mw
    }
  }
  for (let position = 0; position < units.length; position += 1) {
    const generator = units[position]!
    generators.reserveMw[generator] = generators.fcrNReserveMw[generator]! + generators.fcrDUpReserveMw[generator]!
      + generators.afrrUpReserveMw[generator]! + generators.mfrrUpReserveMw[generator]!
  }
}
