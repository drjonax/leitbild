import { newWorkspaceId } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { displayRunOf } from '../src/core/api/display-capabilities.ts'
import type { ActorId, IsoTimestamp, ObjectId } from '../src/core/model/index.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { composeDefault } from '../src/features/displays/compose/compose.ts'
import { leadRefs } from '../src/features/displays/compose/defaults.ts'
import type { VignetteState, VignetteView } from '../src/features/displays/compose/model.ts'
import { compileVignette, sampleVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { OBSERVATION_READ_REFS } from '../src/core/observation/capabilities.ts'
import { requestPort, type ObservationPort } from '../src/features/displays/observation/port.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { viewWithLeads } from '../src/ui/embed/vignette/vignette-client.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// W0.5 on four-loop Halden (UX audit H1, H2; §5.1): the unit's default, its core's and its turbine's, composed at power
// and sampled on through a turbine trip and the reactor trip it brings, as a display opened at power and left open. Each
// sample leads as the Plant leads at that moment: the column's lead rows take the post-trip set, and the core and the
// turbine lead with what verifies their trip (E-0), in the rows the view reserved as it opened, nothing else moving.

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const person = { id: 'actor:human:leads' as ActorId, label: 'Leads', role: 'operator' as const }
const plantId = 'plant:halden-1' as ObjectId
const path = (ref: string) => ref.slice(ref.indexOf('#') + 1)

let registry: SimulationRunRegistry
let dataDir: string
let runtime: SimulationRunRuntime
let start: number
const play = (seconds: number) => runtime.runMaximumPace(new Date(start + seconds * 1_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
const runNow = (): Promise<ViewRun> => displayRunOf(registry, runtime, person, new Set())
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'leitbild-lead-request-'))
  registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), idleRuntimeCloseTimer: () => () => {},
  })
  runtime = await registry.create({ scenarioId: 'halden-power-complex' })
  await runtime.setClock({ paused: true })
  start = Date.parse(runtime.snapshot().clock!.currentTime)
  await play(30)
})
afterAll(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

const valuesOf = (view: VignetteView): ReadonlyArray<string> => {
  const section = view.sections.find(entry => entry.kind === 'values')
  return section?.kind === 'values' ? section.values.map(value => path(value.ref)) : []
}
const rowsOf = (view: VignetteView) => view.sections.map(section => `${section.kind} ${section.rows}`)

describe('a display opened at power and left open through a trip (W0.5)', () => {
  test('within one sample its lead rows take the post-trip set, and the core and the turbine lead with what verifies their trip, in the same rows', async () => {
    const atPower = await runNow()
    const opened: Record<string, { state: VignetteState; view: VignetteView }> = {}
    for (const subject of [plantId, `${plantId}#core`, `${plantId}#turbine`]) {
      const outcome = await composeDefault(atPower, subject)
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
      opened[subject] = { state: outcome.state, view: await compileVignette(atPower, outcome.state) }
    }
    const unit = opened[plantId]!
    const core = opened[`${plantId}#core`]!
    const turbine = opened[`${plantId}#turbine`]!
    // Each holds a lead request and reserves its rows; no ref is fixed as it opens.
    expect(unit.state.views[0]).toMatchObject({ kind: 'values', lead: { objectId: plantId }, rows: 8 })
    expect(core.state.views[0]).toMatchObject({ kind: 'values', lead: { objectId: plantId, element: 'core' }, rows: 8 })
    expect(turbine.state.views[0]).toMatchObject({ kind: 'values', lead: { objectId: plantId, element: 'turbine' } })
    for (const { state } of Object.values(opened)) expect(state.views[0]?.kind === 'values' && state.views[0].refs).toBeUndefined()
    // At power: the unit leads with reactor power and makes electrical output; the core with its power range.
    expect(valuesOf(unit.view)[0]).toBe('core.powerRangePercent')
    expect(valuesOf(unit.view)).toContain('turbine.electricMw')
    expect(valuesOf(core.view)[0]).toBe('core.powerRangePercent')
    expect(valuesOf(core.view)).not.toContain('core.rodsOnBottom')
    expect(valuesOf(turbine.view)[0]).toBe('turbine.electricMw')

    const tripped = await runtime.invokeCapability(person, { capabilityId: 'world.process-plant.action.invoke', input: { plantId, actionId: 'turbine-trip', parameters: {} } })
    if (tripped.kind === 'command' && !tripped.result.ok) throw new Error(JSON.stringify(tripped.result))
    const drawn = Object.fromEntries(Object.entries(opened).map(([subject, entry]) => [subject, entry.view]))
    // A sample each second, as the window takes them: each leads as the Plant leads at that moment, never a sample late.
    for (let second = 31; second <= 45; second += 1) {
      await play(second)
      const run = await runNow()
      const own = new Set((await run.port.declarations([plantId]).then(([declaration]) => declaration === undefined || 'refused' in declaration ? []
        : declaration.observables.filter(observable => observable.quantity === 'state' && observable.element === undefined).map(observable => observable.ref))))
      const unitSample = await sampleVignette(run, unit.state)
      expect(unitSample.leads?.[0]?.map(value => value.ref)).toEqual((await leadRefs(run, plantId, 16)).filter(ref => !own.has(ref)).slice(0, 8))
      for (const [subject, entry] of Object.entries(opened)) {
        const sample = subject === plantId ? unitSample : await sampleVignette(run, entry.state)
        const next = viewWithLeads(drawn[subject]!, sample)
        // No layout jump: the same sections in the same rows; only the lead rows' values change, every other section is the one drawn.
        expect(rowsOf(next)).toEqual(rowsOf(entry.view))
        next.sections.forEach((section, index) => { if (section.kind !== 'values') expect<unknown>(section).toBe(drawn[subject]!.sections[index]) })
        drawn[subject] = next
      }
    }
    // After the reactor trip: the unit leads with the heat sink and inventory, no longer with a power it does not make.
    const post = valuesOf(drawn[plantId]!)
    expect(post.slice(0, 3)).toEqual(['vessel.subcoolingMarginC', 'core.coreExitTemperatureC', 'auxFeedwaterHeader.outletFlowKgPerS'])
    expect(post).not.toContain('turbine.electricMw')
    // The core: rods on the bottom, both trip breakers, rod steps, then its flux on the power and intermediate ranges.
    expect(valuesOf(drawn[`${plantId}#core`]!).slice(0, 7)).toEqual([
      'core.rodsOnBottom', 'reactorTripBreakerA.closedState', 'reactorTripBreakerB.closedState', 'core.rodStepsWithdrawn',
      'core.powerRangePercent', 'core.intermediateRangeCurrentAmps', 'core.intermediateRangeStartupRateDpm',
    ])
    // The turbine: its output breaker, its stop valve, its output, then its speed among the rest.
    expect(valuesOf(drawn[`${plantId}#turbine`]!).slice(0, 3)).toEqual(['turbine.outputBreakerClosed', 'turbineStopValve.effectivePositionFraction', 'turbine.electricMw'])
    expect(valuesOf(drawn[`${plantId}#turbine`]!)).toContain('turbine.speedRpm')
    // And the readings say so: rods in, breakers open.
    const last = await sampleVignette(await runNow(), core.state)
    const value = (signal: string) => last.observations.find(observation => observation.ref === `${plantId}#${signal}`)?.value
    expect([value('core.rodsOnBottom'), value('reactorTripBreakerA.closedState'), value('reactorTripBreakerB.closedState')]).toEqual([true, false, false])
  }, 240_000)

  // R1 perf: each Pack query pays a fixed cost, so a sample asks the Plant once for values: its views' refs, its
  // drawing's bindings and its lead request's (the unit's lead; an element's values and its stop's commands) in one read.
  test('each sample reads the Plant once: its views\' values and its lead request\'s in one call', async () => {
    const run = await runNow()
    for (const subject of [plantId, `${plantId}#core`, `${plantId}#turbine`]) {
      const outcome = await composeDefault(run, subject)
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
      const reads: Array<{ readonly objects: ReadonlyArray<string>; readonly refs: number; readonly leads: number }> = []
      const plain = runtime.observations(person)
      const counted: ObservationPort = { ...plain, read: async request => {
        reads.push({ objects: [...new Set([...(request.refs ?? []).map(ref => ref.slice(0, ref.indexOf('#'))), ...(request.leads ?? []).map(lead => lead.objectId)])], refs: request.refs?.length ?? 0, leads: request.leads?.length ?? 0 })
        return plain.read(request)
      } }
      const sample = await sampleVignette({ ...await runNow(), port: requestPort(counted) }, outcome.state)
      expect(reads, subject).toHaveLength(1)
      expect(reads[0]!.objects).toEqual([plantId])
      expect(reads[0]!.refs).toBeLessThanOrEqual(OBSERVATION_READ_REFS)
      expect(reads[0]!.leads).toBe(subject === plantId ? 1 : 0)
      // And it shows what a sample read through the Run's own request port shows.
      expect(sample).toEqual(await sampleVignette(await runNow(), outcome.state))
    }
  }, 120_000)
})
