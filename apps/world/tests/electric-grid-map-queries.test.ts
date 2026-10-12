import { describe, expect, test } from 'bun:test'
import { norwayRuntimeTestOperatingPointRef } from './fixtures/grid-operating-point.ts'
import type { ActorId, CommandEnvelope, CommandId, IsoTimestamp, ObjectId, SimulationRunId } from '../src/core/model/index.ts'
import { gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import { gridTripGeneratorCommandKind } from '../src/packs/electric-grid/commands/generator.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { haversineKm } from '../src/packs/electric-grid/model-build/geo.ts'
import { norwayGridModelRef, nordicFrequencyAutomationRef } from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import type { GridModelDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { answerElectricGridQuery, electricGridQueryCapabilities } from '../src/packs/electric-grid/queries/index.ts'
import { createGridMapGeometry, createGridMapGeometryQuery, loadGridGeometryArtifact } from '../src/packs/electric-grid/queries/map-geometry.ts'
import type { GridMapGeometryResult, GridMapStateResult } from '../src/packs/electric-grid/queries/map-schemas.ts'
import { createGridMapStateQuery } from '../src/packs/electric-grid/queries/map-state.ts'
import { applyGridCommand } from '../src/packs/electric-grid/runtime/apply-command.ts'
import { createGridRuntimeInstance, type GridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { runtimeStateForElectricGrids } from '../src/packs/electric-grid/sim/runtime-state.ts'
import { costsInReferences, referenceQuietMs } from './cpu-cost.ts'
import { gridDefinitionForModel, syntheticGridDefinition } from './fixtures/synthetic-grid.ts'

const at = '2026-01-01T10:00:00.000Z' as IsoTimestamp
const geometryId = 'world.electric-grid.map.geometry'
const stateId = 'world.electric-grid.map.state'

const norway = compileGridDefinition(gridDefinitionSchema.parse({
  id: 'grid:norway',
  model: { ref: norwayGridModelRef },
  operatingPoint: { ref: norwayRuntimeTestOperatingPointRef },
  automation: { ref: nordicFrequencyAutomationRef },
}))

const runningGrid = (): GridRuntimeInstance => {
  const grid = createGridRuntimeInstance({ definition: norway, at })
  advanceGrid(grid, 0, at)
  return grid
}

const capability = (id: string) => electricGridQueryCapabilities.find(candidate => candidate.id === id)!

/** Answers like the Host: the Pack answer, then the published output schema. */
const ask = <Result>(grid: GridRuntimeInstance, id: string): Result => capability(id).output.parse(answerElectricGridQuery({
  request: { capabilityId: id, input: { gridId: grid.definition.gridId } },
  grids: new Map([[grid.definition.gridId, grid]]),
})) as Result

/** Within `quietMs` of a quiet machine's CPU time, judged against the shared reference computation (see cpu-cost.ts). */
const withinQuietBudget = (run: () => unknown, quietMs: number, rounds: number): void => {
  for (let warm = 0; warm < 5; warm += 1) run()
  const [references] = costsInReferences([run], rounds)
  expect(references!).toBeLessThan(quietMs / referenceQuietMs)
}

const command = (grid: GridRuntimeInstance, kind: string, payload: Readonly<Record<string, unknown>>) => {
  const result = applyGridCommand(grid, {
    id: `command:${crypto.randomUUID()}` as CommandId,
    simulationRunId: 'run-grid-map' as SimulationRunId,
    actorId: 'actor:grid-map-test' as ActorId,
    kind,
    targetObjectIds: [grid.definition.gridId as ObjectId],
    payload,
    issuedAt: at,
  } satisfies CommandEnvelope)
  if (!result.ok) throw new Error(result.reason)
  advanceGrid(grid, 0, at)
}

describe('Grid map query Capabilities', () => {
  test('are read-only queries that inspect exactly the Grid object', () => {
    for (const id of [geometryId, stateId]) {
      const published = capability(id)
      expect(published.kind).toBe('query')
      expect(published.risk).toBe('read')
      expect(published.inspectObjectIds?.({ gridId: 'grid:norway' })?.map(String)).toEqual(['grid:norway'])
    }
  })

  test('answering them changes no runtime state', () => {
    const grid = runningGrid()
    const before = JSON.stringify({ state: runtimeStateForElectricGrids(new Map([[grid.definition.gridId, grid]])), tick: grid.tick, projection: grid.projection })
    ask(grid, geometryId)
    ask(grid, stateId)
    expect(JSON.stringify({ state: runtimeStateForElectricGrids(new Map([[grid.definition.gridId, grid]])), tick: grid.tick, projection: grid.projection })).toBe(before)
  })

  test('geometry lists every asset in model order and draws lines along their mapped routes, HVDC links along their cables', () => {
    const grid = runningGrid()
    const geometry = ask<GridMapGeometryResult>(grid, geometryId)
    const model = norway.model
    expect(geometry.buses.map(bus => bus.id)).toEqual(model.buses.map(bus => bus.id))
    expect(geometry.branches.map(branch => branch.id)).toEqual(model.branches.map(branch => branch.id))
    expect(geometry.generators.map(generator => generator.id)).toEqual(model.generators.map(generator => generator.id))
    // Loads draw per bus: every load once, at its own bus, in model order within and across buses.
    expect(geometry.loads.flatMap(group => group.loadIds)).toEqual([...model.loads].sort((left, right) =>
      geometry.loads.findIndex(group => group.loadIds.includes(left.id)) - geometry.loads.findIndex(group => group.loadIds.includes(right.id))).map(load => load.id))
    expect(new Set(geometry.loads.map(group => group.bus)).size).toBe(geometry.loads.length)
    const busOfLoad = new Map(model.loads.map(load => [load.id, load.busId]))
    for (const group of geometry.loads) expect(group.loadIds.every(id => busOfLoad.get(id) === geometry.buses[group.bus]!.id)).toBe(true)
    expect(geometry.simplificationMeters).toBeGreaterThan(0)
    for (const branch of geometry.branches) {
      // Transformers, and the curated equivalent of out-of-scope sub-transmission, are no mapped lines.
      expect(branch.pathSource).toBe(branch.id === 'branch:curated-follo-lambertseter-47kv-equivalent' ? 'network-equivalent' : branch.kind === 'transformer' ? 'transformer' : 'mapped-route')
      expect(branch.path.length).toBeGreaterThanOrEqual(2)
      expect(geometry.buses[branch.fromBus]!.id).toBe(model.branches.find(candidate => candidate.id === branch.id)!.fromBusId)
    }
    expect(geometry.hvdcLinks.map(link => link.id)).toEqual(model.hvdcLinks.map(link => link.id))
    for (const link of geometry.hvdcLinks) {
      expect(link.pathSource).toBe('mapped-route')
      expect(link.path.length).toBeGreaterThan(2)
      expect(geometry.buses[link.fromBus]!.id).toBe(model.hvdcLinks.find(candidate => candidate.id === link.id)!.fromBusId)
    }
    // An interconnector follows its own mapped route to where it leaves the source data, even when its
    // boundary bus stands at another tie's end: Hasle – Borgvik ends in Värmland, not at the
    // Halden – Skogssäter end where SE3 420 kV stands, and no straight segment joins the two.
    const borgvik = geometry.branches.find(branch => branch.id === 'branch:osm-2ead9154d4262ef8')!
    const borgvikEnd = borgvik.path[borgvik.path.length - 1]!
    expect(geometry.buses[borgvik.toBus]!.id).toBe('bus:boundary-SE3@420')
    expect(haversineKm(borgvikEnd, geometry.buses[borgvik.toBus]!.location)).toBeGreaterThan(40)
    expect(borgvikEnd[0]).toBeGreaterThan(12)
    for (const tie of geometry.branches.filter(branch => geometry.buses[branch.toBus]!.external !== undefined)) {
      expect(haversineKm(tie.path[tie.path.length - 2]!, tie.path[tie.path.length - 1]!)).toBeLessThan(5)
    }
    // Boundary buses name their external system; HVDC-only systems are asynchronous.
    const external = (busId: string) => geometry.buses.find(bus => bus.id === busId)!.external
    expect(external('bus:boundary-DE')).toEqual({ label: 'Germany (Continental European synchronous area)', synchronous: false })
    expect(external('bus:boundary-SE3@420')?.synchronous).toBe(true)
    expect(geometry.buses.filter(bus => bus.external !== undefined).map(bus => bus.id).every(id => id.startsWith('bus:boundary-'))).toBe(true)
    expect(ask<GridMapGeometryResult>(grid, geometryId).geometryDigest).toBe(geometry.geometryDigest)
    expect(ask<GridMapStateResult>(grid, stateId).geometryDigest).toBe(geometry.geometryDigest)
  })

  test('a Model Addition draws its base along the base\'s routes and its fictional lines on designed routes along existing corridors', () => {
    const halden = compileGridDefinition(gridDefinitionSchema.parse({
      id: 'grid:halden', model: { ref: 'electric-grid.halden.four-unit' }, operatingPoint: { ref: norwayRuntimeTestOperatingPointRef }, automation: { ref: nordicFrequencyAutomationRef },
    }))
    const grid = createGridRuntimeInstance({ definition: halden, at })
    advanceGrid(grid, 0, at)
    const geometry = ask<GridMapGeometryResult>(grid, geometryId)
    const baseBranchCount = norway.model.branches.length
    expect(geometry.branches.slice(0, baseBranchCount).every(branch => branch.pathSource !== 'bus-to-bus')).toBe(true)
    const added = geometry.branches.slice(baseBranchCount)
    expect(added.map(branch => branch.id)).toEqual(halden.model.branches.slice(baseBranchCount).map(branch => branch.id))
    // Mapped ≥ 300 kV routes of the base: the corridors a designed 420 kV route may follow.
    const corridorPoints = geometry.branches.slice(0, baseBranchCount)
      .filter(branch => branch.pathSource === 'mapped-route' && branch.kv >= 300)
      .flatMap(branch => branch.path.slice(1).flatMap((point, index) => {
        const previous = branch.path[index]!
        const steps = Math.max(1, Math.ceil(haversineKm(previous, point) / 0.25))
        return Array.from({ length: steps }, (_, step) => [previous[0] + (point[0] - previous[0]) * step / steps, previous[1] + (point[1] - previous[1]) * step / steps] as const)
      }))
    for (const branch of added) {
      expect(branch.pathSource).toBe('designed-route')
      const from = geometry.buses[branch.fromBus]!.location
      const to = geometry.buses[branch.toBus]!.location
      expect(branch.path[0]).toEqual(from)
      expect(branch.path[branch.path.length - 1]).toEqual(to)
      // Not a straight line: it bends with the corridors, and runs a little longer than the chord.
      const lengthKm = branch.path.slice(1).reduce((sum, point, index) => sum + haversineKm(branch.path[index]!, point), 0)
      expect(lengthKm / haversineKm(from, to)).toBeGreaterThan(1.02)
      expect(lengthKm / haversineKm(from, to)).toBeLessThan(1.25)
      // Beside existing corridors (lanes 150 m apart), apart from the spur at the plant.
      const offCorridor = branch.path.filter(point => haversineKm(point, from) > 3
        && !corridorPoints.some(corridor => haversineKm(point, corridor) < 0.6))
      expect(offCorridor).toEqual([])
    }
    // The circuits to one destination share a lane; the two destinations run in separate lanes.
    const pathOf = (id: string) => added.find(branch => branch.id === id)!.path
    expect(pathOf('branch:curated-halden-pwr-hasle-2')).toEqual(pathOf('branch:curated-halden-pwr-hasle-1'))
    expect(pathOf('branch:curated-halden-pwr-tegneby-1')[5]).not.toEqual(pathOf('branch:curated-halden-pwr-hasle-1')[5])
  })

  test('state arrays align with the geometry and follow commands', () => {
    const grid = runningGrid()
    const geometry = ask<GridMapGeometryResult>(grid, geometryId)
    const state = ask<GridMapStateResult>(grid, stateId)
    for (const values of Object.values(state.branches)) expect(values).toHaveLength(geometry.branches.length)
    for (const values of Object.values(state.buses)) expect(values).toHaveLength(geometry.buses.length)
    for (const values of Object.values(state.generators)) expect(values).toHaveLength(geometry.generators.length)
    for (const values of Object.values(state.loads)) expect(values).toHaveLength(geometry.loads.length)
    for (const values of Object.values(state.hvdcLinks)) expect(values).toHaveLength(geometry.hvdcLinks.length)
    expect(state.revision).toBe(grid.tick)
    // Every bus lies in an island but an HVDC terminal, which lies in none.
    const terminals = new Set(grid.definition.index.asynchronousBoundaryBusIds)
    geometry.buses.forEach((bus, position) => {
      const island = state.buses.island[position]!
      if (terminals.has(bus.id)) expect(island).toBeNull()
      else expect(island).toBeLessThan(state.islands.length)
    })
    const shared = geometry.loads.findIndex(group => group.loadIds.length > 1)
    const sharedDemandMw = geometry.loads[shared]!.loadIds.reduce((sum, id) => sum + grid.loads.get(id)!.demandMw, 0)
    expect(Math.abs(state.loads.demandMw[shared]! - sharedDemandMw)).toBeLessThanOrEqual(0.05)

    const branchIndex = geometry.branches.findIndex(branch => branch.kind === 'ac_line' && branch.kv === 420)
    const generatorIndex = state.generators.state.indexOf('online')
    expect(state.branches.closed[branchIndex]).toBe(1)
    command(grid, gridOpenBranchCommandKind, { assetId: geometry.branches[branchIndex]!.id })
    command(grid, gridTripGeneratorCommandKind, { assetId: geometry.generators[generatorIndex]!.id })
    const after = ask<GridMapStateResult>(grid, stateId)
    expect(after.branches.closed[branchIndex]).toBe(0)
    expect(after.branches.tripped[branchIndex]).toBe(0)
    expect(after.branches.flowMw[branchIndex]).toBe(0)
    expect(after.generators.state[generatorIndex]).toBe('tripped')
    expect(after.revision).toBeGreaterThan(state.revision)
  })

  test('a de-energised island reports energised 0 and no frequency', () => {
    const grid = runningGrid()
    const geometry = ask<GridMapGeometryResult>(grid, geometryId)
    // A bus without generation whose every branch opens becomes a dead island of its own.
    const generatorBuses = new Set(norway.model.generators.map(generator => generator.busId))
    const busIndex = geometry.buses.findIndex((bus, position) => !generatorBuses.has(bus.id) && !bus.id.startsWith('bus:boundary-')
      && geometry.branches.some(branch => branch.fromBus === position || branch.toBus === position))
    for (const branch of geometry.branches) {
      if (branch.fromBus === busIndex || branch.toBus === busIndex) command(grid, gridOpenBranchCommandKind, { assetId: branch.id })
    }
    const state = ask<GridMapStateResult>(grid, stateId)
    const island = state.islands[state.buses.island[busIndex]!]!
    expect(island.energized).toBe(false)
    expect(island.frequencyHz).toBeNull()
    expect(state.buses.energized[busIndex]).toBe(0)
  })

  test('fit their payload and time budgets for the current model', () => {
    const grid = runningGrid()
    const geometryBytes = JSON.stringify(ask(grid, geometryId)).length
    const stateBytes = JSON.stringify(ask(grid, stateId)).length
    // Norway v2: 1,000 buses, 1,244 mapped branches, 851 generators and 3,142 loads at 648 buses,
    // drawn per bus. Geometry is fetched once per digest (981 KB, 236 KB gzip, measured); state every
    // revision (37 KB, 7 KB gzip). Per load they were 1,248 KB and 62 KB.
    expect(geometryBytes).toBeLessThanOrEqual(1_200_000)
    expect(stateBytes).toBeLessThanOrEqual(60_000)
    // Budget 3 quiet ms: the Pack answer plus the Host's output validation and serialisation. Alone it
    // measured 0.10–0.12 references (1.3–1.5 quiet ms); late in the full suite's heap, 0.167 (2.0 ms).
    withinQuietBudget(() => JSON.stringify(ask(grid, stateId)), 3, 60)
  })

  test('answer state for a synthetic 3,500-branch Grid within 15 ms', () => {
    const definition = syntheticGridDefinition(2_500)
    expect(definition.model.branches.length).toBe(3_500)
    const grid = createGridRuntimeInstance({ definition, at })
    advanceGrid(grid, 0, at)
    const geometryFor = createGridMapGeometry({ artifactsFor: () => [], readArtifact: file => { throw new Error(`no artifact ${file}`) } })
    const stateQuery = createGridMapStateQuery(geometryFor)
    const grids = new Map([[grid.definition.gridId, grid]])
    const answer = () => JSON.stringify(stateQuery.capability.output.parse(structuredClone(stateQuery.answer({ gridId: grid.definition.gridId }, grids))))
    withinQuietBudget(answer, 15, 20)
  })
})

/** A three-bus model with Grid Model v2 ids, the shape a geometry artifact accompanies. */
const v2Model = (): GridModelDefinition => {
  const base = syntheticGridDefinition(10).model
  const busIds = ['bus:osm-way-1@420', 'bus:osm-way-2@420', 'bus:osm-way-3@420']
  const locations = [[10, 60], [11, 60], [11, 61]] as const
  return {
    ...base,
    id: 'electric-grid.test.v2',
    sourceBuild: { id: 'build-1', generatedAt: '2026-10-10T00:00:00.000Z' },
    buses: busIds.map((id, position) => ({ id, label: `Bus ${position}`, kind: 'substation' as const, nominalKv: 420, location: locations[position]! })),
    branches: [
      { ...base.branches[0]!, id: 'branch:osm-0123456789abcdef', fromBusId: busIds[0]!, toBusId: busIds[1]! },
      { ...base.branches[1]!, id: 'branch:osm-fedcba9876543210', fromBusId: busIds[1]!, toBusId: busIds[2]! },
    ],
    generators: [],
    loads: [],
  }
}

const artifactFor = (model: GridModelDefinition, change: (artifact: Record<string, unknown>) => void = () => undefined): string => {
  const artifact: Record<string, unknown> = {
    schemaVersion: 1,
    modelId: model.id,
    sourceBuildId: model.sourceBuild.id,
    simplificationMeters: 50,
    routes: 'mapped',
    branches: [
      { id: 'branch:osm-0123456789abcdef', path: [[10, 60], [10.5, 60.1], [11, 60]] },
      { id: 'branch:osm-fedcba9876543210', path: [[11, 60], [11.1, 60.5], [11, 61]] },
    ],
    hvdcLinks: [],
  }
  change(artifact)
  return JSON.stringify(artifact)
}

const load = (model: GridModelDefinition, text: string) =>
  loadGridGeometryArtifact({ file: 'electric-grid.test.v2.geometry.json', text, model, hvdcLinks: [] })

describe('Grid geometry artifact', () => {
  test('a complete artifact supplies every branch path', () => {
    const model = v2Model()
    const grid = createGridRuntimeInstance({ definition: gridDefinitionForModel(model), at })
    advanceGrid(grid, 0, at)
    const files: string[] = []
    const geometryFor = createGridMapGeometry({
      artifactsFor: candidate => [{ file: `${candidate.id}.geometry.json`, modelId: candidate.id, firstBranch: 0, branchCount: candidate.branches.length, hvdcLinks: true }],
      readArtifact: file => { files.push(file); return artifactFor(model) },
    })
    const query = createGridMapGeometryQuery(geometryFor)
    const result = query.answer({ gridId: grid.definition.gridId }, new Map([[grid.definition.gridId, grid]])) as GridMapGeometryResult
    query.answer({ gridId: grid.definition.gridId }, new Map([[grid.definition.gridId, grid]]))
    expect(files).toEqual(['electric-grid.test.v2.geometry.json'])
    expect(result.simplificationMeters).toBe(50)
    expect(result.branches.map(branch => [branch.pathSource, branch.path.length])).toEqual([['mapped-route', 3], ['mapped-route', 3]])
    const busToBus = createGridMapGeometry({ artifactsFor: () => [], readArtifact: () => '' })(model)
    expect(busToBus.geometryDigest).not.toBe(geometryFor(model).geometryDigest)
    expect(busToBus.modelDigest).toBe(geometryFor(model).modelDigest)
  })

  test('a missing or unknown branch, a reversed path or another build is an error naming the file and path', () => {
    const model = v2Model()
    expect(() => load(model, artifactFor(model, artifact => { (artifact.branches as unknown[]).pop() })))
      .toThrow('$.branches: has no path for branch:osm-fedcba9876543210')
    expect(() => load(model, artifactFor(model, artifact => { (artifact.branches as Array<{ id: string }>)[0]!.id = 'branch:osm-aaaaaaaaaaaaaaaa' })))
      .toThrow('$.branches[0].id: branch:osm-aaaaaaaaaaaaaaaa is not in the model')
    expect(() => load(model, artifactFor(model, artifact => { (artifact.branches as Array<{ path: unknown[] }>)[1]!.path.reverse() })))
      .toThrow('$.branches[1].path: runs from the toBus end')
    expect(() => load(model, artifactFor(model, artifact => { artifact.sourceBuildId = 'build-0' })))
      .toThrow("$.sourceBuildId: must be the model's source build build-1")
    expect(() => load(model, artifactFor(model, artifact => { artifact.hvdcLinks = [{ id: 'hvdc:nordlink', path: [[10, 60], [8, 54]] }] })))
      .toThrow('$.hvdcLinks[0].id: hvdc:nordlink is not in the model')
    expect(() => load(model, artifactFor(model, artifact => { artifact.extra = true })))
      .toThrow('electric-grid.test.v2.geometry.json: invalid Grid Geometry')
    expect(() => load(model, '{')).toThrow('electric-grid.test.v2.geometry.json: invalid JSON')
  })
})
