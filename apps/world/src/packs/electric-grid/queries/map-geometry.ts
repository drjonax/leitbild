import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gridModelCatalogEntry } from '../definition-refs.ts'
import type { GridAssetLocation, GridModelDefinition } from '../grid-model.ts'
import { gridDataError, type GridDataIssue } from '../schemas/data-issues.ts'
import { validateGridGeometryArtifact } from '../schemas/grid-geometry.ts'
import { defineGridQuery, gridFor, gridPayloadSchema, type ElectricGridQuery } from './common.ts'
import { gridMapGeometryResultSchema, type GridMapGeometryWire } from './map-schemas.ts'

// Static map geometry of a Grid: buses, branch paths, generators and loads in model order, so
// world.electric-grid.map.state can publish compact arrays aligned with it. Built once per
// model and cached; clients refetch it only when geometryDigest changes.

type LonLat = readonly [number, number]

export interface GridMapGeometry {
  readonly modelDigest: string
  readonly geometryDigest: string
  readonly payload: Omit<GridMapGeometryWire, 'gridId'>
}

/** Where map geometry comes from: the artifact file of a model (null when it has none) and its reader. */
export interface GridMapGeometrySources {
  readonly artifactFileFor: (model: GridModelDefinition) => string | null
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
 * Loads a model's geometry artifact. It must name the model and its source build and hold
 * exactly one correctly oriented path per branch and HVDC link; anything else is an error
 * naming the file and JSON path.
 */
export const loadGridGeometryArtifact = (config: {
  readonly file: string
  readonly text: string
  readonly model: GridModelDefinition
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
  const busLocation = new Map(model.buses.map(bus => [bus.id, bus.location]))
  const issues: GridDataIssue[] = [
    ...(artifact.modelId === model.id ? [] : [{ path: ['modelId'], message: `must be the model id ${model.id}` }]),
    ...(artifact.sourceBuildId === model.sourceBuild.id ? [] : [{ path: ['sourceBuildId'], message: `must be the model's source build ${model.sourceBuild.id}` }]),
    ...coverageIssues('branches', artifact.branches, model.branches.map(branch => ({
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
        // With an artifact every branch has a path (the loader checks coverage); without one, none has.
        const path = artifact === null ? null : artifact.branchPaths.get(branch.id)!
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
      loads: model.loads.map(load => ({
        id: load.id,
        label: load.label,
        kind: load.kind,
        bus: busIndex.get(load.busId)!,
        location: location(load.location),
      })),
    },
  }
}

/** Map geometry per model, built on first use and cached for the model's lifetime. */
export const createGridMapGeometry = (sources: GridMapGeometrySources): ((model: GridModelDefinition) => GridMapGeometry) => {
  const cache = new WeakMap<GridModelDefinition, GridMapGeometry>()
  return model => {
    const cached = cache.get(model)
    if (cached !== undefined) return cached
    const file = sources.artifactFileFor(model)
    // The runtime model carries HVDC as hvdc_link branches, so no separate links need paths yet.
    const artifact = file === null ? null : loadGridGeometryArtifact({ file, text: sources.readArtifact(file), model, hvdcLinks: [] })
    const geometry = buildGridMapGeometry(model, artifact)
    cache.set(model, geometry)
    return geometry
  }
}

/** Grid Model v1 predates geometry artifacts: its branches draw bus to bus, which the payload states per branch. */
const catalogArtifactFile = (model: GridModelDefinition): string | null => {
  const source = gridModelCatalogEntry(model.id).source
  switch (source.kind) {
    case 'norway-source-data-v1':
    case 'addition-v1':
      return null
  }
}

const modelsDirectory = new URL('../models/', import.meta.url)

export const gridMapGeometryFor = createGridMapGeometry({
  artifactFileFor: catalogArtifactFile,
  readArtifact: file => readFileSync(fileURLToPath(new URL(file, modelsDirectory)), 'utf8'),
})

export const createGridMapGeometryQuery = (geometryFor: (model: GridModelDefinition) => GridMapGeometry): ElectricGridQuery => defineGridQuery({
  id: 'world.electric-grid.map.geometry',
  title: 'Get Grid map geometry',
  description: 'Returns the static map geometry of one Grid in model order: buses, branches with their path from fromBus to toBus and its source, generators and loads. world.electric-grid.map.state publishes live state as arrays in the same order; refetch this only when its geometryDigest changes.',
  searchTerms: ['map', 'geometry', 'lines', 'routes', 'substations', 'live map', 'kart', 'geometri', 'linjer', 'traseer', 'stasjoner'],
  input: gridPayloadSchema,
  output: gridMapGeometryResultSchema,
  answer: (payload, grids) => ({ gridId: payload.gridId, ...geometryFor(gridFor(grids, payload.gridId).definition.model).payload }),
})

export const gridMapGeometryQuery = createGridMapGeometryQuery(gridMapGeometryFor)
