import type { GridDataIssue } from './data-issues.ts'
import type { GridModelV2 } from './grid-model.ts'
import { municipalityLoadIdParts, nordicSynchronousExternalAreas, transformerIdParts } from './grid-ids.ts'

// Cross-asset rules of Grid Model v2: unique ids, resolvable references, boundary coverage
// and provenance sources that name a recorded build input.

export const gridModelAssetCollections = ['buses', 'branches', 'hvdcLinks', 'externalSystems', 'generators', 'loads', 'shunts', 'connectionPoints'] as const
export type GridModelAssetCollection = typeof gridModelAssetCollections[number]

type Model = Pick<GridModelV2, GridModelAssetCollection | 'sourceBuild'>
type Bus = GridModelV2['buses'][number]

export const gridModelReferenceIssues = (model: Model): ReadonlyArray<GridDataIssue> => {
  const issues: GridDataIssue[] = []
  const fail = (path: ReadonlyArray<PropertyKey>, message: string): void => { issues.push({ path, message }) }

  const firstPathById = new Map<string, string>()
  for (const collection of gridModelAssetCollections) {
    model[collection].forEach((asset, index) => {
      const first = firstPathById.get(asset.id)
      if (first !== undefined) fail([collection, index, 'id'], `duplicates the id at ${first}`)
      else firstPathById.set(asset.id, `${collection}[${index}]`)
    })
  }
  const inputIds = new Set<string>()
  model.sourceBuild.inputs.forEach((input, index) => {
    if (inputIds.has(input.sourceId)) fail(['sourceBuild', 'inputs', index, 'sourceId'], `duplicate source input ${input.sourceId}`)
    inputIds.add(input.sourceId)
  })
  for (const collection of gridModelAssetCollections) {
    if (collection === 'connectionPoints') continue
    model[collection].forEach((asset, index) => asset.provenance.sources.forEach((source, sourceIndex) => {
      if (!inputIds.has(source)) fail([collection, index, 'provenance', 'sources', sourceIndex], `${source} is not a sourceBuild input`)
    }))
  }

  const busById = new Map(model.buses.map(bus => [bus.id, bus]))
  const requireBus = (path: ReadonlyArray<PropertyKey>, busId: string, placement: 'any' | 'norwegian' | 'boundary'): Bus | undefined => {
    const bus = busById.get(busId)
    if (bus === undefined) fail(path, `unknown bus ${busId}`)
    else if (placement === 'norwegian' && bus.kind === 'boundary') fail(path, `${busId} is a boundary bus; attach to a Norwegian bus`)
    else if (placement === 'boundary' && bus.kind !== 'boundary') fail(path, `${busId} is not a boundary bus`)
    return bus
  }

  model.branches.forEach((branch, index) => {
    const placement = branch.kind === 'transformer' ? 'norwegian' : 'any'
    const from = requireBus(['branches', index, 'fromBusId'], branch.fromBusId, placement)
    const to = requireBus(['branches', index, 'toBusId'], branch.toBusId, placement)
    if (branch.kind !== 'transformer' || from === undefined || to === undefined) return
    if (from.nominalKv === to.nominalKv) fail(['branches', index, 'toBusId'], 'a transformer connects two voltage levels')
    if (Math.max(from.nominalKv, to.nominalKv) !== branch.nominalKv) fail(['branches', index, 'nominalKv'], 'must equal the high-side bus voltage')
    const parts = transformerIdParts(branch.id)
    if (parts === undefined) return
    if (from.substationId !== parts.substationId || to.substationId !== parts.substationId) {
      fail(['branches', index, 'id'], `both buses must belong to substation ${parts.substationId}`)
    }
    if (parts.lowKv !== String(Math.min(from.nominalKv, to.nominalKv))) fail(['branches', index, 'id'], 'the low-side voltage in the id must equal the low-side bus voltage')
  })
  model.hvdcLinks.forEach((link, index) => {
    requireBus(['hvdcLinks', index, 'fromBusId'], link.fromBusId, 'norwegian')
    requireBus(['hvdcLinks', index, 'toBusId'], link.toBusId, 'any')
  })

  const externalByBoundaryBus = new Map<string, string>()
  model.externalSystems.forEach((system, index) => system.boundaryBusIds.forEach((busId, busIndex) => {
    const path = ['externalSystems', index, 'boundaryBusIds', busIndex]
    const bus = requireBus(path, busId, 'boundary')
    const owner = externalByBoundaryBus.get(busId)
    if (owner !== undefined) fail(path, `${busId} already belongs to ${owner}`)
    externalByBoundaryBus.set(busId, system.id)
    if (bus?.externalArea === undefined) return
    if (system.area === 'nordic-remainder' ? !nordicSynchronousExternalAreas.has(bus.externalArea) : bus.externalArea !== system.area) {
      fail(path, `${busId} lies in ${bus.externalArea}, outside ${system.area}`)
    }
  }))
  model.buses.forEach((bus, index) => {
    if (bus.kind === 'boundary' && !externalByBoundaryBus.has(bus.id)) fail(['buses', index, 'id'], 'a boundary bus must belong to exactly one external system')
  })

  model.generators.forEach((generator, index) => { requireBus(['generators', index, 'busId'], generator.busId, 'norwegian') })
  model.loads.forEach((load, index) => {
    const bus = requireBus(['loads', index, 'busId'], load.busId, 'norwegian')
    const parts = municipalityLoadIdParts(load.id)
    if (bus !== undefined && parts !== undefined && bus.substationId !== parts.substationId) fail(['loads', index, 'busId'], `the load id names substation ${parts.substationId}`)
  })
  model.shunts.forEach((shunt, index) => { requireBus(['shunts', index, 'busId'], shunt.busId, 'norwegian') })
  model.connectionPoints.forEach((point, index) => {
    const bus = requireBus(['connectionPoints', index, 'busId'], point.busId, 'norwegian')
    if (bus !== undefined && bus.nominalKv !== point.nominalKv) fail(['connectionPoints', index, 'nominalKv'], `must equal the bus voltage ${bus.nominalKv} kV`)
  })
  return issues
}
