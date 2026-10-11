import { createAgcState } from './frequency/agc.ts'
import type { LfddStageState, LfddState } from './frequency/lfdd.ts'
import { createMfrrState } from './frequency/mfrr.ts'
import {
  createIslandFrequencyState,
  createUnitFrequencyState,
  idleExternalFrequencyState,
  validateIslandInput,
  type IslandFrequencyState,
} from './frequency/island-state.ts'
import { createStorageFrequencyState } from './frequency/storage.ts'
import { frequencyStateOf, type IslandFrequencyWorkspace } from './frequency/workspace.ts'
import type { GridIsland, GridIslandPlan, GridRuntimeInstance, GridTopologyIsland, GridTopologyPlan } from './instance.ts'
import {
  gridGeneratorIsSynchronised,
  islandFrequencyInput,
  islandHasVoltageFormingSource,
  islandKineticEnergyMws,
  islandMembers,
  storageFrequencyUnit,
} from './island-input.ts'
import { islandWorkspaceFits, islandWorkspaceHolding } from './island-workspace.ts'

const gridSeconds = (grid: GridRuntimeInstance): number => grid.elapsedMs / 1_000

const storageFractions = (grid: GridRuntimeInstance, island: GridTopologyIsland): Readonly<Record<string, number>> =>
  Object.fromEntries(island.storage.map(item => [item.id, grid.storage.get(item.id)!.stateOfChargeFraction]))

/** A just-energised island (black start or re-energisation) starts steady at nominal frequency. */
const freshFrequencyState = (grid: GridRuntimeInstance, island: GridTopologyIsland, islandId: string): IslandFrequencyState =>
  createIslandFrequencyState(grid.definition.automation, islandFrequencyInput(grid, island, islandId), {
    frequencyHz: grid.definition.automation.swing.nominalFrequencyHz,
    startSeconds: gridSeconds(grid),
    storageStateOfChargeFraction: storageFractions(grid, island),
  })

interface Parent {
  readonly island: GridIsland
  readonly kineticEnergyMws: number
}

const publishedStates = new WeakMap<IslandFrequencyWorkspace, { readonly version: number; readonly state: IslandFrequencyState }>()

/** The workspace's state as published, produced again only after the workspace changed. */
const publishedFrequency = (workspace: IslandFrequencyWorkspace): IslandFrequencyState => {
  const published = publishedStates.get(workspace)
  if (published !== undefined && published.version === workspace.version) return published.state
  const state = frequencyStateOf(workspace)
  publishedStates.set(workspace, { version: workspace.version, state })
  return state
}

const frequencyAccessor: PropertyDescriptor = {
  enumerable: true,
  get(this: GridIsland): IslandFrequencyState | null {
    return this.workspace === null ? null : publishedFrequency(this.workspace)
  },
}

/** A stable island record; `frequency` reads the workspace, which is not enumerable. */
const gridIsland = (fields: {
  readonly id: string
  readonly planIndex: number
  readonly anchorBusId: string
  readonly energized: boolean
  readonly workspace: IslandFrequencyWorkspace | null
  readonly rocofHzPerSecond: number | null
  readonly minimumHz: number | null
  readonly maximumHz: number | null
}): GridIsland => {
  const island = { id: fields.id, planIndex: fields.planIndex, anchorBusId: fields.anchorBusId, energized: fields.energized }
  Object.defineProperty(island, 'frequency', frequencyAccessor)
  Object.assign(island, { rocofHzPerSecond: fields.rocofHzPerSecond, minimumHz: fields.minimumHz, maximumHz: fields.maximumHz })
  Object.defineProperty(island, 'workspace', { value: fields.workspace, writable: true })
  return island as GridIsland
}

/** The island's frequency now, null while it has no frequency state. */
const workspaceFrequencyHz = (island: GridIsland): number | null => island.workspace === null ? null : island.workspace.frequencyHz

const mergedLfddStage = (stages: ReadonlyArray<LfddStageState>, loadIds: ReadonlySet<string>): LfddStageState => {
  const shed: Record<string, number> = {}
  let operatedAtSeconds: number | null = null
  for (const stage of stages) {
    if (stage.status !== 'operated') continue
    for (const [loadId, fraction] of Object.entries(stage.shedFractionByLoad)) if (loadIds.has(loadId)) shed[loadId] = fraction
    operatedAtSeconds = operatedAtSeconds === null || stage.operatedAtSeconds === null ? operatedAtSeconds ?? stage.operatedAtSeconds : Math.min(operatedAtSeconds, stage.operatedAtSeconds)
  }
  // A stage stays latched where it disconnected feeders of this island; elsewhere its relays never operated.
  if (Object.keys(shed).length > 0) return { status: 'operated', belowThresholdSeconds: 0, operatedAtSeconds, shedFractionByLoad: shed }
  if (stages.some(stage => stage.status === 'disarmed')) return { status: 'disarmed', belowThresholdSeconds: 0, operatedAtSeconds: null, shedFractionByLoad: {} }
  return { status: 'armed', belowThresholdSeconds: 0, operatedAtSeconds: null, shedFractionByLoad: {} }
}

/**
 * Frequency state of an island formed from energised parents after a split or merge: every unit,
 * storage unit and external keeps its own state, LFDD stages keep their latches for the island's
 * loads, and the frequency is the parents' E_k-weighted mean (a child of one parent inherits it exactly).
 */
const inheritedFrequencyState = (grid: GridRuntimeInstance, island: GridTopologyIsland, islandId: string, parents: ReadonlyArray<Parent>): IslandFrequencyState => {
  const automation = grid.definition.automation
  const live = parents.filter(parent => workspaceFrequencyHz(parent.island) !== null)
  const dominant = [...live].sort((a, b) => b.kineticEnergyMws - a.kineticEnergyMws)[0]!.island.frequency!
  const weight = live.reduce((sum, parent) => sum + parent.kineticEnergyMws, 0)
  const frequencyHz = live.length === 1 || weight <= 0
    ? dominant.frequencyHz!
    : live.reduce((sum, parent) => sum + parent.island.frequency!.frequencyHz! * parent.kineticEnergyMws, 0) / weight
  const states = live.map(parent => parent.island.frequency!)
  const find = <T>(pick: (state: IslandFrequencyState) => T | undefined): T | undefined => {
    for (const state of states) {
      const value = pick(state)
      if (value !== undefined) return value
    }
    return undefined
  }
  const now = gridSeconds(grid)
  const units = Object.fromEntries(island.generators.map(definition => {
    const generator = grid.generators.get(definition.id)!
    return [definition.id, find(state => state.units[definition.id])
      ?? createUnitFrequencyState(automation, gridGeneratorIsSynchronised(generator) ? generator.targetMw : 0)]
  }))
  const storage = Object.fromEntries(island.storage.map(definition => [definition.id, find(state => state.storage[definition.id])
    ?? createStorageFrequencyState(storageFrequencyUnit(definition), grid.storage.get(definition.id)!.stateOfChargeFraction, now)]))
  const externalIds = islandMembers(grid, island).externals.map(system => system.id)
  const externals = Object.fromEntries(externalIds.map(id => [id, find(state => state.externals[id]) ?? idleExternalFrequencyState]))
  const loadIds = new Set(island.loads.map(load => load.id))
  const lfddConfig = automation.lfdd
  const lfdd: LfddState = {
    stages: Object.fromEntries(lfddConfig.stages.map(stage => [stage.id, mergedLfddStage(states.map(state => state.lfdd.stages[stage.id]!), loadIds)])),
  }
  // The aFRR request equals what the island's providers now deliver, so no step is injected at the split or merge.
  const requestMw = island.generators.reduce((sum, definition) => sum + (gridGeneratorIsSynchronised(grid.generators.get(definition.id)!) ? units[definition.id]!.afrrMw : 0), 0)
    + externalIds.reduce((sum, id) => sum + externals[id]!.afrrMw, 0)
  const state: IslandFrequencyState = {
    islandId,
    automationId: automation.id,
    elapsedSeconds: now,
    frequencyHz,
    rocofHzPerSecond: live.length === 1 ? dominant.rocofHzPerSecond : 0,
    units,
    storage,
    externals,
    agc: automation.afrr.enabled
      ? { requestMw, previousErrorMw: dominant.agc?.previousErrorMw ?? 0, nextCycleAtSeconds: dominant.agc?.nextCycleAtSeconds ?? createAgcState(now).nextCycleAtSeconds }
      : null,
    mfrr: automation.mfrr.enabled ? dominant.mfrr ?? createMfrrState() : null,
    lfdd,
  }
  validateIslandInput(automation, state, islandFrequencyInput(grid, island, islandId))
  return state
}

/**
 * A fresh island's id: `island:<anchor bus>` of its structure (GridTopologyIsland.anchorBusId); a
 * suffix keeps it unique among live islands. An island keeps its id while its members change: a
 * split child with the larger E_k and a merge keep the id of the parent with the larger E_k.
 */
const freshIslandId = (island: GridTopologyIsland, taken: ReadonlySet<string>): string => {
  const base = island.id
  if (!taken.has(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}~${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}


interface Component {
  readonly previous: number[]
  readonly next: number[]
}

/** Groups previous and new islands that share buses: unchanged, split, merged, or both at once. */
const overlapComponents = (previous: GridIslandPlan, plan: GridTopologyPlan): ReadonlyArray<Component> => {
  const previousOfBus = previous.plan.islandIndexOfBus
  const nextOfBus = plan.islandIndexOfBus
  const parent = Int32Array.from({ length: previous.islands.length + plan.islands.length }, (_, index) => index)
  const find = (node: number): number => {
    let current = node
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]!]!
      current = parent[current]!
    }
    return current
  }
  for (let bus = 0; bus < nextOfBus.length; bus += 1) {
    // An HVDC terminal lies in no island in every plan.
    if (nextOfBus[bus]! < 0) continue
    const a = find(previousOfBus[bus]!)
    const b = find(previous.islands.length + nextOfBus[bus]!)
    if (a !== b) parent[a] = b
  }
  const components = new Map<number, Component>()
  const component = (root: number): Component => {
    const existing = components.get(root)
    if (existing) return existing
    const created: Component = { previous: [], next: [] }
    components.set(root, created)
    return created
  }
  previous.islands.forEach((_, index) => component(find(index)).previous.push(index))
  plan.islands.forEach((_, index) => component(find(previous.islands.length + index)).next.push(index))
  return [...components.values()]
}

const newIsland = (config: {
  readonly grid: GridRuntimeInstance
  readonly plan: GridTopologyPlan
  readonly planIndex: number
  readonly id: string
  readonly parents: ReadonlyArray<Parent>
}): GridIsland => {
  const island = config.plan.islands[config.planIndex]!
  const energized = islandHasVoltageFormingSource(config.grid, island)
  const liveParents = config.parents.some(parent => workspaceFrequencyHz(parent.island) !== null)
  const frequency = !energized
    ? null
    : liveParents
      ? inheritedFrequencyState(config.grid, island, config.id, config.parents)
      : freshFrequencyState(config.grid, island, config.id)
  return gridIsland({
    id: config.id,
    planIndex: config.planIndex,
    anchorBusId: island.anchorBusId,
    energized,
    workspace: frequency === null ? null : islandWorkspaceHolding(config.grid, island, frequency),
    rocofHzPerSecond: frequency?.rocofHzPerSecond ?? null,
    minimumHz: frequency?.frequencyHz ?? null,
    maximumHz: frequency?.frequencyHz ?? null,
  })
}

const initialIslands = (grid: GridRuntimeInstance, plan: GridTopologyPlan): ReadonlyArray<GridIsland> => {
  const restored = grid.restoredIslands
  grid.restoredIslands = null
  if (restored === null) {
    const taken = new Set<string>()
    return plan.islands.map((island, planIndex) => {
      const id = freshIslandId(island, taken)
      taken.add(id)
      return newIsland({ grid, plan, planIndex, id, parents: [] })
    })
  }
  const network = plan.network
  const byPlanIndex = new Map<number, typeof restored[number]>()
  for (const item of restored) {
    const bus = network.busIndexById.get(item.anchorBusId)
    if (bus === undefined) throw new Error(`stored Grid island ${item.id} is anchored at unknown bus ${item.anchorBusId}`)
    const planIndex = plan.islandIndexOfBus[bus]!
    if (planIndex < 0) throw new Error(`stored Grid island ${item.id} is anchored at HVDC terminal ${item.anchorBusId}, which lies in no island`)
    if (byPlanIndex.has(planIndex)) throw new Error(`stored Grid islands ${byPlanIndex.get(planIndex)!.id} and ${item.id} lie in one island`)
    byPlanIndex.set(planIndex, item)
  }
  if (byPlanIndex.size !== plan.islands.length) throw new Error(`stored Grid state holds ${byPlanIndex.size} islands for a topology of ${plan.islands.length}`)
  return plan.islands.map((island, planIndex) => {
    const item = byPlanIndex.get(planIndex)!
    if (item.frequency !== null) validateIslandInput(grid.definition.automation, item.frequency, islandFrequencyInput(grid, island, item.id))
    return gridIsland({
      id: item.id,
      planIndex,
      anchorBusId: item.anchorBusId,
      energized: item.frequency?.frequencyHz != null,
      workspace: item.frequency === null ? null : islandWorkspaceHolding(grid, island, item.frequency),
      rocofHzPerSecond: item.frequency?.rocofHzPerSecond ?? null,
      minimumHz: item.frequency?.frequencyHz ?? null,
      maximumHz: item.frequency?.frequencyHz ?? null,
    })
  })
}

const reconciledIslands = (grid: GridRuntimeInstance, previous: GridIslandPlan, plan: GridTopologyPlan): ReadonlyArray<GridIsland> => {
  const result: Array<GridIsland | undefined> = new Array(plan.islands.length)
  const taken = new Set<string>()
  // Fresh ids never reuse a previous island's id, so lineage stays unambiguous across components.
  const reserved = new Set(previous.islands.map(island => island.id))
  const rank = (energy: number, island: GridTopologyIsland) => ({ energy, buses: island.busIndices.length, id: island.id })
  const byRank = (a: ReturnType<typeof rank>, b: ReturnType<typeof rank>): number =>
    b.energy - a.energy || b.buses - a.buses || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  for (const component of overlapComponents(previous, plan)) {
    const parents: Parent[] = component.previous.map(index => ({
      island: previous.islands[index]!,
      kineticEnergyMws: islandKineticEnergyMws(grid, previous.plan.islands[index]!),
    }))
    if (component.previous.length === 1 && component.next.length === 1) {
      const island = parents[0]!.island
      const planIndex = component.next[0]!
      const structure = plan.islands[planIndex]!
      taken.add(island.id)
      // The island keeps its workspace while its members are unchanged; otherwise its state moves to one for the new members.
      const workspace = island.workspace === null || islandWorkspaceFits(grid, structure, island.workspace)
        ? island.workspace
        : islandWorkspaceHolding(grid, structure, island.frequency!)
      result[planIndex] = gridIsland({
        id: island.id,
        planIndex,
        anchorBusId: structure.anchorBusId,
        energized: island.energized,
        workspace,
        rocofHzPerSecond: island.rocofHzPerSecond,
        minimumHz: island.minimumHz,
        maximumHz: island.maximumHz,
      })
      continue
    }
    // Largest parent identity goes to the largest child; further children get new ids.
    const parentOrder = component.previous
      .map((index, position) => ({ position, key: rank(parents[position]!.kineticEnergyMws, previous.plan.islands[index]!) }))
      .sort((a, b) => byRank(a.key, b.key))
    const childOrder = component.next
      .map(planIndex => ({ planIndex, key: rank(islandKineticEnergyMws(grid, plan.islands[planIndex]!), plan.islands[planIndex]!) }))
      .sort((a, b) => byRank(a.key, b.key))
    childOrder.forEach((child, order) => {
      const inherited = parentOrder[order]
      const id = inherited ? parents[inherited.position]!.island.id : freshIslandId(plan.islands[child.planIndex]!, new Set([...taken, ...reserved]))
      taken.add(id)
      result[child.planIndex] = newIsland({ grid, plan, planIndex: child.planIndex, id, parents })
    })
  }
  return result.map((island, index) => {
    if (!island) throw new Error(`Grid island reconciliation left plan island ${index} without an identity`)
    return island
  })
}

/**
 * Energisation follows the sources every tick: an island whose last voltage-forming source is gone
 * de-energises at once (frequency absent); a dead island that gains one is energised at nominal.
 */
const refreshEnergisation = (grid: GridRuntimeInstance, plan: GridTopologyPlan, island: GridIsland): void => {
  const structure = plan.islands[island.planIndex]!
  const energized = islandHasVoltageFormingSource(grid, structure)
  if (energized && workspaceFrequencyHz(island) === null) {
    const frequency = freshFrequencyState(grid, structure, island.id)
    island.workspace = islandWorkspaceHolding(grid, structure, frequency)
    island.rocofHzPerSecond = 0
    island.minimumHz = frequency.frequencyHz
    island.maximumHz = frequency.frequencyHz
  } else if (!energized) {
    island.workspace = null
    island.rocofHzPerSecond = null
    island.minimumHz = null
    island.maximumHz = null
  }
  island.energized = energized
}

/** Re-evaluates every island's energisation after unit commitment changed within an advance. */
export const refreshGridIslandEnergisation = (grid: GridRuntimeInstance, islands: GridIslandPlan): void => {
  for (const island of islands.islands) refreshEnergisation(grid, islands.plan, island)
}

/** Stable island identities for the current topology plan, with inherited or fresh frequency state. */
export const reconcileGridIslands = (grid: GridRuntimeInstance, plan: GridTopologyPlan): GridIslandPlan => {
  const previous = grid.islandPlan
  const islands = previous === null
    ? initialIslands(grid, plan)
    : previous.plan === plan ? previous.islands : reconciledIslands(grid, previous, plan)
  for (const island of islands) refreshEnergisation(grid, plan, island)
  const reconciled: GridIslandPlan = { plan, islands }
  grid.islandPlan = reconciled
  return reconciled
}

/** Discards every island's frequency state so the next reconciliation starts all live islands steady at nominal. */
export const resetGridIslandFrequencies = (grid: GridRuntimeInstance): void => {
  if (!grid.islandPlan) return
  for (const island of grid.islandPlan.islands) island.workspace = null
}

/** The stable islands of the Grid's solved topology; readers fail explicitly before the Grid has advanced on it. */
export const solvedGridIslands = (grid: GridRuntimeInstance): GridIslandPlan => {
  const islands = grid.islandPlan
  if (islands === null || grid.topologyPlan === null || islands.plan !== grid.topologyPlan) {
    throw new Error(`Grid ${grid.definition.gridId} has not solved its islands since the last switching change; advance the Grid first`)
  }
  return islands
}

/** The stable island holding a bus; an HVDC terminal lies in none. */
export const gridIslandAtBus = (islands: GridIslandPlan, busId: string): GridIsland => {
  const bus = islands.plan.network.busIndexById.get(busId)
  if (bus === undefined) throw new Error(`unknown Grid bus ${busId}`)
  const planIndex = islands.plan.islandIndexOfBus[bus]!
  if (planIndex < 0) throw new Error(`Grid bus ${busId} is an HVDC terminal of an asynchronous external system and lies in no island`)
  return islands.islands[planIndex]!
}

/** The frequency of a stable island: null while de-energised; an energised island always carries one. */
export const gridIslandFrequencyHz = (island: GridIsland): number | null => {
  if (!island.energized) return null
  const frequencyHz = workspaceFrequencyHz(island)
  if (frequencyHz === null) throw new Error(`energised Grid island ${island.id} has no frequency state`)
  return frequencyHz
}
