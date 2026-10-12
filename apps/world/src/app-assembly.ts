import type { WorldPack } from './core/packs/protocol.ts'
import { ambulancePack } from './packs/ambulance/pack.ts'
import { dronePack } from './packs/drone/pack.ts'
import { einsatzPack } from './packs/einsatz/pack.ts'
import { electricGridPack } from './packs/electric-grid/pack.ts'
import { electricGridReferenceDatasetBuilders } from './packs/electric-grid/reference-datasets.ts'
import { processPlantPack } from './packs/process-plant/pack.ts'
import { weatherPack } from './packs/weather/pack.ts'
import { situationMonitorPack } from './packs/situation-monitor/pack.ts'
import { createSituationMonitorRuntimeAdapter } from './packs/situation-monitor/runtime.ts'
import type { RoutingAdapter } from './routing/protocol.ts'
import type { PackRuntimeAdapter } from './simulation/protocol.ts'
import { validateWorldAssembly } from './core/packs/assembly.ts'
import { createLocalAmbulancePackRuntimeAdapter } from './packs/ambulance/sim/adapter.ts'
import { createLocalElectricGridPackRuntimeAdapter } from './packs/electric-grid/sim/adapter.ts'
import { createDroneNativePackRuntimeAdapter } from './packs/drone/native/adapter.ts'
import { createEinsatzPackRuntimeAdapter } from './packs/einsatz/runtime/adapter.ts'
import { createLocalProcessPlantPackRuntimeAdapter } from './packs/process-plant/sim/adapter.ts'
import { createLocalWeatherPackRuntimeAdapter } from './packs/weather/sim/adapter.ts'

const withReferenceDatasetBuilders = (
  pack: WorldPack,
  referenceDatasetBuilders: NonNullable<WorldPack['referenceData']>['builders'],
): WorldPack => ({
  ...pack,
  referenceData: {
    builders: referenceDatasetBuilders,
    datasetIds: pack.referenceData?.datasetIds ?? referenceDatasetBuilders.map(builder => builder.id),
  },
})

export const worldPacks: ReadonlyArray<WorldPack> = [
  ambulancePack,
  einsatzPack,
  weatherPack,
  situationMonitorPack,
  dronePack,
  processPlantPack,
  withReferenceDatasetBuilders(electricGridPack, electricGridReferenceDatasetBuilders),
]

export interface WorldApplicationAssembly {
  readonly packs: ReadonlyArray<WorldPack>
  readonly runtimeAdapters: ReadonlyArray<PackRuntimeAdapter>
}

export const createWorldApplicationAssembly = (config: {
  readonly routing: RoutingAdapter
}): WorldApplicationAssembly => {
  const runtimeAdapters: ReadonlyArray<PackRuntimeAdapter> = [
      createLocalAmbulancePackRuntimeAdapter({ routing: config.routing }),
      createEinsatzPackRuntimeAdapter({ routing: config.routing }),
      createLocalWeatherPackRuntimeAdapter(),
      createSituationMonitorRuntimeAdapter(),
      createDroneNativePackRuntimeAdapter(),
      createLocalProcessPlantPackRuntimeAdapter(),
      createLocalElectricGridPackRuntimeAdapter(),
    ]
  return validateWorldAssembly({ packs: worldPacks, runtimeAdapters })
}
