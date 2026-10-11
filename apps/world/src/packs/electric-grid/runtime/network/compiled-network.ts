import type { GridBusKind, GridModelDefinition } from '../../grid-model.ts'

export interface CompiledGridNetwork {
  /** The Model's base power of its per-unit impedances, so a DC solve θ = B⁻¹·P/S_base yields angles in radians. */
  readonly sBaseMva: number
  readonly busCount: number
  readonly branchCount: number
  /** Bus and branch ids in model order; the position is the integer index used by the network core. */
  readonly busIds: ReadonlyArray<string>
  readonly branchIds: ReadonlyArray<string>
  readonly busIndexById: ReadonlyMap<string, number>
  readonly branchFrom: Int32Array
  readonly branchTo: Int32Array
  /** Series susceptance 1/x in per unit on `sBaseMva`. */
  readonly branchSusceptancePu: Float64Array
  /**
   * Rank of each bus in the island naming order (0 first); the lowest-ranked bus of an island names
   * it. Station buses (substation, plant terminal, connection point) come before junctions, and
   * junctions before boundary buses; then the highest nominal voltage; then the largest connected
   * capacity, the summed continuous rating of the Model's branches at the bus whatever their
   * switching state; then the id in UTF-16 code-unit order. The rank depends on the Model alone.
   */
  readonly busNamingRank: Int32Array
}

/** Naming class of each bus kind: a station's voltage level, then a junction, then an external system's boundary bus. */
const namingClass: Readonly<Record<GridBusKind, number>> = { substation: 0, 'plant-terminal': 0, 'connection-point': 0, junction: 1, boundary: 2 }

type GridNetworkModel = Pick<GridModelDefinition, 'id' | 'sBaseMva' | 'buses' | 'branches'>

export const compileGridNetwork = (model: GridNetworkModel): CompiledGridNetwork => {
  const busIds = model.buses.map(bus => bus.id)
  const busIndexById = new Map(busIds.map((id, index) => [id, index]))
  if (busIndexById.size !== busIds.length) throw new Error(`Grid Model ${model.id} network has duplicate bus ids`)
  const branchCount = model.branches.length
  const branchFrom = new Int32Array(branchCount)
  const branchTo = new Int32Array(branchCount)
  const branchSusceptancePu = new Float64Array(branchCount)
  model.branches.forEach((branch, index) => {
    const from = busIndexById.get(branch.fromBusId)
    const to = busIndexById.get(branch.toBusId)
    if (from === undefined || to === undefined) throw new Error(`Grid Model ${model.id} branch ${branch.id} references an unknown bus`)
    if (from === to) throw new Error(`Grid Model ${model.id} branch ${branch.id} connects a bus to itself`)
    const susceptancePu = 1 / branch.reactancePu
    if (!Number.isFinite(susceptancePu)) throw new Error(`Grid Model ${model.id} branch ${branch.id} has no finite susceptance (reactance ${branch.reactancePu} pu)`)
    branchFrom[index] = from
    branchTo[index] = to
    branchSusceptancePu[index] = susceptancePu
  })
  const connectedRatingMw = new Float64Array(busIds.length)
  model.branches.forEach((branch, index) => {
    connectedRatingMw[branchFrom[index]!] = connectedRatingMw[branchFrom[index]!]! + branch.ratingMw
    connectedRatingMw[branchTo[index]!] = connectedRatingMw[branchTo[index]!]! + branch.ratingMw
  })
  const busNamingRank = new Int32Array(busIds.length)
  const buses = model.buses
  busIds
    .map((_, index) => index)
    .sort((a, b) => namingClass[buses[a]!.kind] - namingClass[buses[b]!.kind]
      || buses[b]!.nominalKv - buses[a]!.nominalKv
      || connectedRatingMw[b]! - connectedRatingMw[a]!
      || (busIds[a]! < busIds[b]! ? -1 : busIds[a]! > busIds[b]! ? 1 : 0))
    .forEach((busIndex, rank) => { busNamingRank[busIndex] = rank })
  return {
    sBaseMva: model.sBaseMva,
    busCount: busIds.length,
    branchCount,
    busIds,
    branchIds: model.branches.map(branch => branch.id),
    busIndexById,
    branchFrom,
    branchTo,
    branchSusceptancePu,
    busNamingRank,
  }
}

const compiledNetworks = new WeakMap<GridNetworkModel, CompiledGridNetwork>()

/** The compiled network of an immutable Grid Model, compiled once per Model object. */
export const compiledGridNetworkFor = (model: GridNetworkModel): CompiledGridNetwork => {
  const cached = compiledNetworks.get(model)
  if (cached) return cached
  const network = compileGridNetwork(model)
  compiledNetworks.set(model, network)
  return network
}
