import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gridModelCatalogEntry } from '../definition-refs.ts'
import type { GridAssetLocation, GridModelDefinition } from '../grid-model.ts'
import { gridDataError, type GridDataIssue } from '../schemas/data-issues.ts'
import { validateGridGeometryArtifact } from '../schemas/grid-geometry.ts'
import { defineGridQuery, gridFor, gridPayloadSchema, type ElectricGridQuery } from './common.ts'
import { gridMapGeometryResultSchema, type GridMapGeometryWire } from './map-schemas.ts'

// Static map geometry of a Grid: buses, branch paths and generators in model order and loads per
// bus, so world.electric-grid.map.state can publish compact arrays aligned with it. Built once per
// model and cached; clients refetch it only when geometryDigest changes.

type LonLat = readonly [number, number]

export interface GridMapGeometry {
  readonly modelDigest: string
  readonly geometryDigest: string
  readonly payload: Omit<GridMapGeometryWire, 'gridId'>
}

/**
 * A geometry artifact and what it draws: the paths of the first `branchCount` branches of the
 * model it names (a Model Addition appends its branches after its base's, so the base's artifact
 * covers exactly the base's branches).
 */
export interface GridMapArtifactSource {
  readonly file: string
  readonly modelId: string
  readonly branchCount: number
}

/** Where map geometry comes from: the artifact of a model (null when it has none) and its reader. */
export interface GridMapGeometrySources {
  readonly artifactFor: (model: GridModelDefinition) => GridMapArtifactSource | null
  readonly readArtifact: (file: string) => string
}

/** HVDC links the runtime model carries apart from its branches; the artifact must cover exactly these. */
export interface GridMapLinkEndpoints {
  readonly id: string
  readonly from: LonLat
  readonly to: LonLat
}

export interface GridArtifactPaths {
  readonly branchPaths: ReadonlyMap<string, ReadonlyArray<LonLat>>
  readonly hvdcLinkPaths: ReadonlyMap<string, ReadonlyArray<LonLat>>
  readonly simplificationMeters: number
  readonly sha256: string
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

// 1e-5° is about 1.1 m: finer than any bus location or the artifact's simplification.
const roundDegrees = (value: number): number => Math.round(value * 1e5) / 1e5
const roundPoint = (point: LonLat): [number, number] => [roundDegrees(point[0]), roundDegrees(point[1])]

/** Squared planar distance with longitude scaled by cos(latitude); only compared, never reported. */
const distanceSquared = (a: LonLat, b: LonLat): number => {
  const dx = (a[0] - b[0]) * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180)
  const dy = a[1] - b[1]
  return dx * dx + dy * dy
}

/** A path must start at its from end and finish at its to end; a reversed path would draw flow backwards. */
const orientationIssue = (path: ReadonlyArray<LonLat>, from: LonLat, to: LonLat): string | null => {
  const first = path[0]!
  const last = path[path.length - 1]!
  if (distanceSquared(first, from) > distanceSquared(first, to) || distanceSquared(last, to) > distanceSquared(last, from)) {
    return 'runs from the toBus end to the fromBus end; paths are ordered from fromBus to toBus'
  }
  return null
}

const coverageIssues = (
  field: 'branches' | 'hvdcLinks',
  entries: ReadonlyArray<{ readonly id: string; readonly path: ReadonlyArray<LonLat> }>,
  expected: ReadonlyArray<GridMapLinkEndpoints>,
): ReadonlyArray<GridDataIssue> => {
  const expectedById = new Map(expected.map(item => [item.id, item]))
  const present = new Set(entries.map(entry => entry.id))
  const issues: GridDataIssue[] = []
  entries.forEach((entry, position) => {
    const endpoints = expectedById.get(entry.id)
    if (endpoints === undefined) {
      issues.push({ path: [field, position, 'id'], message: `${entry.id} is not in the model` })
      return
    }
    const orientation = orientationIssue(entry.path, endpoints.from, endpoints.to)
    if (orientation !== null) issues.push({ path: [field, position, 'path'], message: orientation })
  })
  for (const item of expected) {
    if (!present.has(item.id)) issues.push({ path: [field], message: `has no path for ${item.id}` })
  }
  return issues
}

/**
 * Loads a model's geometry artifact. It must name the model (or, for a Model Addition, its base)
 * and the source build and hold exactly one correctly oriented path per covered branch and per
 * HVDC link; anything else is an error naming the file and JSON path.
 */
export const loadGridGeometryArtifact = (config: {
  readonly file: string
  readonly text: string
  readonly model: GridModelDefinition
  /** The model id the artifact names and the leading branches it covers; the whole model when absent. */
  readonly coverage?: { readonly modelId: string; readonly branchCount: number }
  readonly hvdcLinks: ReadonlyArray<GridMapLinkEndpoints>
}): GridArtifactPaths => {
  let json: unknown
  try {
    json = JSON.parse(config.text) as unknown
  } catch (error) {
    throw new Error(`${config.file}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const artifact = validateGridGeometryArtifact(json, config.file)
  const model = config.model
  const coverage = config.coverage ?? { modelId: model.id, branchCount: model.branches.length }
  const busLocation = new Map(model.buses.map(bus => [bus.id, bus.location]))
  const issues: GridDataIssue[] = [
    ...(artifact.modelId === coverage.modelId ? [] : [{ path: ['modelId'], message: `must be the model id ${coverage.modelId}` }]),
    ...(artifact.sourceBuildId === model.sourceBuild.id ? [] : [{ path: ['sourceBuildId'], message: `must be the model's source build ${model.sourceBuild.id}` }]),
    ...coverageIssues('branches', artifact.branches, model.branches.slice(0, coverage.branchCount).map(branch => ({
      id: branch.id,
      from: busLocation.get(branch.fromBusId)!,
      to: busLocation.get(branch.toBusId)!,
    }))),
    ...coverageIssues('hvdcLinks', artifact.hvdcLinks, config.hvdcLinks),
  ]
  if (issues.length > 0) throw gridDataError(config.file, 'Grid Geometry', issues)
  return {
    branchPaths: new Map(artifact.branches.map(entry => [entry.id, entry.path])),
    hvdcLinkPaths: new Map(artifact.hvdcLinks.map(entry => [entry.id, entry.path])),
    simplificationMeters: artifact.simplificationMeters,
    sha256: sha256(config.text),
  }
}

/**
 * The model's loads grouped by bus, in model order of each bus's first load. The map draws one
 * marker per group: a population-split model has several loads per substation (3142 at 648 buses).
 */
export const loadsPerBus = (model: GridModelDefinition): ReadonlyArray<ReadonlyArray<GridModelDefinition['loads'][number]>> => {
  const groups = new Map<string, Array<GridModelDefinition['loads'][number]>>()
  for (const load of model.loads) {
    const group = groups.get(load.busId)
    if (group === undefined) groups.set(load.busId, [load])
    else group.push(load)
  }
  return [...groups.values()]
}

const buildGridMapGeometry = (model: GridModelDefinition, artifact: GridArtifactPaths | null): GridMapGeometry => {
  const modelDigest = sha256(JSON.stringify(model))
  const geometryDigest = sha256(`${modelDigest}\n${artifact?.sha256 ?? 'bus-to-bus'}`)
  const busIndex = new Map(model.buses.map((bus, position) => [bus.id, position]))
  const location = (value: GridAssetLocation): [number, number] => roundPoint(value)
  return {
    modelDigest,
    geometryDigest,
    payload: {
      modelId: model.id,
      sourceBuildId: model.sourceBuild.id,
      modelDigest,
      geometryDigest,
      simplificationMeters: artifact?.simplificationMeters ?? null,
      buses: model.buses.map(bus => ({ id: bus.id, label: bus.label, kv: bus.nominalKv, location: location(bus.location) })),
      branches: model.branches.map(branch => {
        const fromBus = busIndex.get(branch.fromBusId)!
        const toBus = busIndex.get(branch.toBusId)!
        // With an artifact every branch it covers has a path (the loader checks coverage); the others draw bus to bus.
        const path = artifact?.branchPaths.get(branch.id) ?? null
        return {
          id: branch.id,
          label: branch.label,
          kind: branch.kind,
          kv: branch.nominalKv,
          fromBus,
          toBus,
          ratingMw: branch.ratingMw,
          ...(path === null
            ? { pathSource: 'bus-to-bus' as const, path: [location(model.buses[fromBus]!.location), location(model.buses[toBus]!.location)] }
            : { pathSource: 'artifact' as const, path: path.map(roundPoint) }),
        }
      }),
      generators: model.generators.map(generator => ({
        id: generator.id,
        label: generator.label,
        kind: generator.kind,
        bus: busIndex.get(generator.busId)!,
        capacityMw: generator.capacityMw,
        location: location(generator.location),
      })),
      loads: loadsPerBus(model).map(group => {
        const bus = busIndex.get(group[0]!.busId)!
        return {
          bus,
          label: group.length === 1 ? group[0]!.label : `${group.length} loads at ${model.buses[bus]!.label}`,
          loadIds: group.map(load => load.id),
          kinds: [...new Set(group.map(load => load.kind))],
          location: location([
            group.reduce((sum, load) => sum + load.location[0], 0) / group.length,
            group.reduce((sum, load) => sum + load.location[1], 0) / group.length,
          ]),
        }
      }),
    },
  }
}

/** Map geometry per model, built on first use and cached for the model's lifetime. */
export const createGridMapGeometry = (sources: GridMapGeometrySources): ((model: GridModelDefinition) => GridMapGeometry) => {
  const cache = new WeakMap<GridModelDefinition, GridMapGeometry>()
  return model => {
    const cached = cache.get(model)
    if (cached !== undefined) return cached
    const source = sources.artifactFor(model)
    const busLocation = new Map(model.buses.map(bus => [bus.id, bus.location]))
    const artifact = source === null ? null : loadGridGeometryArtifact({
      file: source.file,
      text: sources.readArtifact(source.file),
      model,
      coverage: { modelId: source.modelId, branchCount: source.branchCount },
      hvdcLinks: model.hvdcLinks.map(link => ({ id: link.id, from: busLocation.get(link.fromBusId)!, to: busLocation.get(link.toBusId)! })),
    })
    const geometry = buildGridMapGeometry(model, artifact)
    cache.set(model, geometry)
    return geometry
  }
}

/** A catalog model draws with its geometry artifact; an addition with its base's, its own branches bus to bus. */
const catalogArtifact = (model: GridModelDefinition): GridMapArtifactSource => {
  const entry = gridModelCatalogEntry(model.id)
  if (entry.source.kind === 'grid-model') return { file: entry.source.geometryFile, modelId: entry.id, branchCount: entry.assetCounts.branch }
  const base = gridModelCatalogEntry(entry.source.baseModelRef)
  if (base.source.kind !== 'grid-model') throw new Error(`Grid Model ${entry.id}: base ${base.id} is itself a Model Addition`)
  return { file: base.source.geometryFile, modelId: base.id, branchCount: base.assetCounts.branch }
}

const modelsDirectory = new URL('../models/', import.meta.url)

export const gridMapGeometryFor = createGridMapGeometry({
  artifactFor: catalogArtifact,
  readArtifact: file => readFileSync(fileURLToPath(new URL(file, modelsDirectory)), 'utf8'),
})

export const createGridMapGeometryQuery = (geometryFor: (model: GridModelDefinition) => GridMapGeometry): ElectricGridQuery => defineGridQuery({
  id: 'world.electric-grid.map.geometry',
  title: 'Get Grid map geometry',
  description: 'Returns the static map geometry of one Grid in model order: buses, branches with their path from fromBus to toBus and its source, generators, and loads per bus. world.electric-grid.map.state publishes live state as arrays in the same order; refetch this only when its geometryDigest changes.',
  searchTerms: ['map', 'geometry', 'lines', 'routes', 'substations', 'live map', 'kart', 'geometri', 'linjer', 'traseer', 'stasjoner'],
  input: gridPayloadSchema,
  output: gridMapGeometryResultSchema,
  answer: (payload, grids) => ({ gridId: payload.gridId, ...geometryFor(gridFor(grids, payload.gridId).definition.model).payload }),
})

export const gridMapGeometryQuery = createGridMapGeometryQuery(gridMapGeometryFor)
