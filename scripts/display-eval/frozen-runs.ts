/** Frozen Runs for the replay tier (plan v3.1 Appendix F: T08 context, T09
 * frozen-context replay, T10 citation replay). Each open Scenario (no roles:
 * the AI is refused in role Runs) and the integrated fixture is started
 * in-process with the production assembly, driven to its declared peak and
 * paused; the Run then answers what the Assistant's tools would ask of it:
 * World's Run context (the text the Agents pre-fetch gives the model each
 * turn, stored nowhere), observables.search, resolveName and observation reads,
 * all as the AI caller. Nothing here calls a model. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { newWorkspaceId } from '../../packages/contracts/src/index.ts'
import type { ActorId, IsoTimestamp, SimulationRunId } from '../../apps/world/src/core/model/index.ts'
import type { Actor } from '../../apps/world/src/core/simulation-runs/actors.ts'
import { createSimulationRunRegistry } from '../../apps/world/src/core/simulation-runs/registry.ts'
import { createWorldApplicationAssembly } from '../../apps/world/src/app-assembly.ts'
import { scenarioAuthoringCatalogFor } from '../../apps/world/src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../../apps/world/src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../../apps/world/src/core/scenarios/definition.ts'
import { createScenarioRuntimeResolver } from '../../apps/world/src/core/scenarios/runtime-resolver.ts'
import { builtinScenarioDefinitions } from '../../apps/world/src/scenarios/definitions.ts'
import { createDirectRoutingAdapter } from '../../apps/world/src/routing/direct-adapter.ts'
import { assembleRunContext } from '../../apps/world/src/features/displays/context/run-context.ts'
import type { SearchRun } from '../../apps/world/src/features/displays/observation/search.ts'
import { displayRunOf } from '../../apps/world/src/core/api/display-capabilities.ts'
import type { ViewRun } from '../../apps/world/src/features/displays/compose/view.ts'
import { fixturePath, type SetupStep } from './scenarios.ts'

/** An open Scenario at its peak: the most the Assistant must take in, after the Scenario's main events. */
export interface FrozenSpec {
  readonly id: string
  /** A bundled Scenario id or fixture:<name>. */
  readonly scenario: string
  /** Invocations as a person, in order; an advance step plays at maximum pace. */
  readonly setup: ReadonlyArray<SetupStep>
  readonly peakSeconds: number
  /** A live Pack cannot fast-forward: played in realtime. */
  readonly live?: true
  readonly why: string
}

const plantAction = (plantId: string, actionId: string): SetupStep => ({ operationId: 'world.process-plant.action.invoke', input: { plantId, actionId, parameters: {} } })
const openBranch = (assetId: string): SetupStep => ({ operationId: 'world.electric-grid.open-branch', input: { gridId: 'grid:halden-four-unit', assetId } })

/** Every open bundled Scenario and the integrated fixture, each at a declared peak (decided before any measurement). */
export const FROZEN_SPECS: ReadonlyArray<FrozenSpec> = [
  { id: 'halden-dispatch', scenario: 'halden-dispatch', setup: [], peakSeconds: 6_660, why: 'after its last cue (late-evening demand at 110 min): every incident created' },
  { id: 'halden-normal-operation', scenario: 'halden-normal-operation', setup: [], peakSeconds: 300, why: 'no cues: steady state with its standing grid alarms' },
  { id: 'halden-offsite-power-restoration', scenario: 'halden-offsite-power-restoration', setup: [], peakSeconds: 240, why: 'two minutes after the busbar fault: four units in LOOP, the switchyard island dead, LFDD operated' },
  { id: 'halden-power-complex', scenario: 'halden-power-complex', setup: [], peakSeconds: 300, why: 'no cues before the weather keyframes: four units at power' },
  { id: 'halden-weather-response', scenario: 'halden-weather-response', setup: [], peakSeconds: 180, why: 'the front at hazard while the ambulance drives' },
  { id: 'nordic-frequency-event', scenario: 'nordic-frequency-event', setup: [], peakSeconds: 180, why: 'a minute after the Kvilldal trip (120 s)' },
  { id: 'nordland-corridor-security', scenario: 'nordland-corridor-security', setup: [], peakSeconds: 660, why: 'a minute after Svartisen – Rana trips (600 s): the Helgeland split' },
  { id: 'norway-situation-monitor', scenario: 'norway-situation-monitor', setup: [], peakSeconds: 60, live: true, why: 'live feeds: one realtime minute after start' },
  { id: 'rogaland-black-start', scenario: 'rogaland-black-start', setup: [], peakSeconds: 120, why: 'a minute after both Sør-Rogaland transformers trip (60 s)' },
  { id: 'supply-run', scenario: 'supply-run', setup: [], peakSeconds: 1_320, why: 'most requests open before the exercise ends at 30 min' },
  { id: 'integrated-all-packs', scenario: 'fixture:integrated-all-packs', peakSeconds: 960,
    setup: [openBranch('branch:osm-1022cbf125eebbb4'), openBranch('branch:osm-50a77b48767677b0'), { operationId: 'world.simulation-run.execution.advance', input: { minutes: 2 } }, plantAction('plant:halden-3', 'loss-offsite-power')],
    why: 'every pack busy at 16 min (industrial release at 15 min), two Tegneby circuits out, Unit 3 in LOOP since 2 min' },
]

export const replayAgent: Actor = { id: 'actor:ai:replay-agent' as ActorId, label: 'Replay agent', role: 'ai_agent' }
const person: Actor = { id: 'actor:human:replay-setup' as ActorId, label: 'Replay setup', role: 'operator' }

export interface FrozenRun {
  readonly spec: FrozenSpec
  readonly runId: SimulationRunId
  readonly at: string
  /** World's Run context as the AI caller gets it. */
  readonly context: { readonly text: string; readonly at: string; readonly clock: 'simulation' | 'wall' }
  /** What search and resolveName read, as the AI caller. */
  readonly searchRun: SearchRun
  /** The Run as World's composer reads it for the AI caller (display.compose; E1 production T10). */
  readonly displayRun: ViewRun
  readonly close: () => Promise<void>
}

/** Starts, drives and pauses one Run; `dataRoot` holds its data until `close`. */
export const freezeRun = async (spec: FrozenSpec, dataRoot: string): Promise<FrozenRun> => {
  const routing = createDirectRoutingAdapter()
  const assembly = createWorldApplicationAssembly({ routing })
  const fixture = fixturePath(spec.scenario)
  const source = fixture === null ? null : scenarioDefinitionSchema.parse(await Bun.file(fixture).json())
  const dataDir = await mkdtemp(join(dataRoot, `${spec.id}-`))
  const registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(),
    scenarioDefinitions: source === null ? builtinScenarioDefinitions : [...builtinScenarioDefinitions, source],
    compileScenarioDefinition: input => compileScenarioDefinition(input, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs),
    runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }),
    // A frozen Run is asked for minutes after its last step: it must not close as idle.
    idleRuntimeCloseTimer: () => () => {},
  })
  const run = await registry.create({ scenarioId: source?.id ?? spec.scenario })
  await run.setClock({ paused: true })
  const startedAt = Date.parse(run.snapshot().clock!.currentTime)
  const playTo = async (seconds: number) => {
    if (spec.live === undefined) return run.runMaximumPace(new Date(startedAt + seconds * 1_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
    await run.setClock({ paused: false })
    while (Date.parse(run.snapshot().clock!.currentTime) < startedAt + seconds * 1_000) await Bun.sleep(500)
    await run.setClock({ paused: true })
  }
  let at = 0
  for (const step of spec.setup) {
    if (step.operationId === 'world.simulation-run.execution.advance') { at += Number(step.input.minutes) * 60; await playTo(at); continue }
    const outcome = await run.invokeCapability(person, { capabilityId: step.operationId, input: step.input })
    if (outcome.kind === 'command' && !outcome.result.ok) throw new Error(`${spec.id}: ${step.operationId} refused: ${JSON.stringify(outcome.result).slice(0, 300)}`)
  }
  await playTo(spec.peakSeconds)
  const snapshot = run.snapshot()
  const port = run.observations(replayAgent)
  const searchRun: SearchRun = { objects: snapshot.objects, denied: new Set(), packs: run.packs(), port }
  const context = await assembleRunContext({ title: (await registry.summary(run.id)).title, objects: snapshot.objects, denied: new Set(), clock: snapshot.clock, packs: run.packs(), port })
  const displayRun = await displayRunOf(registry, run, replayAgent, new Set())
  return {
    spec, runId: run.id, at: snapshot.clock!.currentTime, context, searchRun, displayRun,
    close: async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) },
  }
}

/** T08: an asset line names its object, then the full refs of its lead values (objectId#signalId of that object). */
export const assetLineRefs = (text: string) => text.split('\n').filter(line => line.startsWith('- ') && / · (?:lead|lead values refused): /.test(line)).map(line => {
  const objectId = line.slice(2).split(' · ')[0]!
  const lead = /· lead: (.*)$/.exec(line)?.[1]
  const refs = lead === undefined || lead === 'none declared' ? [] : lead.split(', ')
  // A line cut at its length cap ends in "…": the ref it cuts is no ref.
  const cut = refs.filter(ref => !ref.startsWith(`${objectId}#`) || ref.length <= objectId.length + 1 || ref.endsWith('…') || /\s/.test(ref))
  return { objectId, refs: refs.filter(ref => !cut.includes(ref)), cut, refused: /lead values refused/.test(line), full: cut.length === 0 }
})
