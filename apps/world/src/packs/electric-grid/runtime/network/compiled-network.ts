import type { GridModelDefinition } from '../../grid-model.ts'

/**
 * System base power in MVA for the model's per-unit branch reactances. 100 MVA is the
 * conventional transmission study base (IEEE test systems, ENTSO-E/Nordic planning
 * models), so a DC solve θ = B⁻¹·P/S_base yields bus angles in radians.
 */
export const gridSystemBaseMva = 100

export interface CompiledGridNetwork {
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
  /** Rank of each bus id in UTF-16 code-unit order; the lowest-ranked bus names its island. */
  readonly busIdSortRank: Int32Array
}

type GridNetworkModel = Pick<GridModelDefinition, 'id' | 'buses' | 'branches'>

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
  const busIdSortRank = new Int32Array(busIds.length)
  busIds
    .map((_, index) => index)
    .sort((a, b) => (busIds[a]! < busIds[b]! ? -1 : busIds[a]! > busIds[b]! ? 1 : 0))
    .forEach((busIndex, rank) => { busIdSortRank[busIndex] = rank })
  return {
    sBaseMva: gridSystemBaseMva,
    busCount: busIds.length,
    branchCount,
    busIds,
    branchIds: model.branches.map(branch => branch.id),
    busIndexById,
    branchFrom,
    branchTo,
    branchSusceptancePu,
    busIdSortRank,
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
