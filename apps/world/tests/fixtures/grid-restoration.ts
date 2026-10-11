// Two islands for restoration tests. Main island M: a 2 GW hydro station and 800 MW of demand.
// Island R starts dead: a power station bus with a black-start capable hydro unit and one that is
// not, and a load bus whose demand is a 31 MW base feeder, just above the black-start unit's 30 MW
// minimum stable output, and six 15 MW feeders, all flat over the day. The tie M–R is open.
import type { CompiledGridDefinition, GridBranchDefinition, GridBusDefinition, GridModelDefinition } from '../../src/packs/electric-grid/grid-model.ts'
import { gridDefinitionForModel, handBuiltModel, syntheticHydroUnit, testLine, testLoad } from './synthetic-grid.ts'

const bus = (id: string, longitude: number): GridBusDefinition => ({ id, label: id, kind: 'substation', nominalKv: 132, location: [longitude, 61] })

const line = (id: string, fromBusId: string, toBusId: string): GridBranchDefinition =>
  testLine({ id, fromBusId, toBusId, nominalKv: 132, ratingMw: 400, emergencyRatingMw: 480, reactancePu: 0.05, resistancePu: 0.005 })

export const restorationFeederIds = Array.from({ length: 6 }, (_, index) => `load:r-feeder-${index + 1}`)

export const restorationModel: GridModelDefinition = handBuiltModel({
  id: 'test-restoration',
  title: 'Test restoration',
  description: 'A live main island and a dead island with a black-start unit',
  buses: [bus('bus:m', 8), bus('bus:r1', 9), bus('bus:r2', 9.2)],
  branches: [line('branch:tie', 'bus:m', 'bus:r1'), line('branch:r1-r2', 'bus:r1', 'bus:r2')],
  generators: [
    syntheticHydroUnit({ id: 'generator:m', label: 'M', busId: 'bus:m', location: [8, 61], capacityMw: 2_000 }),
    syntheticHydroUnit({ id: 'generator:black-start', label: 'Black-start unit', busId: 'bus:r1', location: [9, 61], capacityMw: 300, blackStartCapable: true, initialState: 'offline' }),
    syntheticHydroUnit({ id: 'generator:follower', label: 'Follower unit', busId: 'bus:r1', location: [9, 61], capacityMw: 300, initialState: 'offline' }),
  ],
  loads: [
    testLoad({ id: 'load:m', busId: 'bus:m', location: [8, 61], demandMw: 800 }),
    testLoad({ id: 'load:r-base', busId: 'bus:r2', location: [9.2, 61], demandMw: 31 }),
    ...restorationFeederIds.map(id => testLoad({ id, busId: 'bus:r2', location: [9.2, 61], demandMw: 15 })),
  ],
})

/** The restoration model with the tie open, as the Operating Point sets it. */
export const restorationDefinition = (): CompiledGridDefinition => {
  const base = gridDefinitionForModel(restorationModel)
  return {
    ...base,
    operatingPoint: {
      ...base.operatingPoint,
      branchStates: base.operatingPoint.branchStates.map(state => state.branchId === 'branch:tie' ? { ...state, state: 'open' as const } : state),
    },
  }
}
