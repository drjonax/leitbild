import { newWorkspaceId } from '@leitbild/contracts'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActorId, CommandEnvelope, CommandId, CommandResult, IsoTimestamp, SimulationRunId } from '../src/core/model/index.ts'
import { createSimulationClock, type SimulationClock } from '../src/core/model/time.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import type { PackRuntimeConnection, PackRuntimeEmission, PackRuntimeStateStore } from '../src/simulation/protocol.ts'
import {
  createLocalProcessPlantPackRuntimeAdapter,
  processPlantControlProposeCommandKind,
} from '../src/packs/process-plant/index.ts'
import type { ListedItem } from '../src/packs/process-plant/operations/instance-ports.ts'
import type { ProcessPlantProposal, ProposalReview } from '../src/packs/process-plant/operations/proposals.ts'
import { processPlantRuntimeStateSchema } from '../src/packs/process-plant/sim/runtime-state.ts'
import { scenarios } from './fixtures/scenarios.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// An AI agent proposes; a person approves in the display window, and World
// executes the stored write under that person's command; every step is a
// durable Run event (plan-final §4.4, QA-1, QA-9).

const operator: Actor = { id: 'actor:human:operations-operator' as ActorId, label: 'Operations test operator', role: 'operator' }
const agent: Actor = { id: 'actor:ai:operations-agent' as ActorId, label: 'Operations test agent', role: 'ai_agent' }

const withRun = async (body: (run: SimulationRunRuntime, plantId: string) => Promise<void>): Promise<void> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-operation-capabilities-'))
  const registry = createSimulationRunRegistry({
    dataDir,
    workspaceId: newWorkspaceId(),
    ...testScenarioAuthoring(),
    runtimeAdapters: createTestPackRuntimeAdapters(),
    scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
  })
  try {
    const run = await registry.create({ scenarioId: 'test-plant' })
    await run.setClock({ paused: true })
    await body(run, run.snapshot().objects.find(object => object.packId === 'process-plant')!.id)
  } finally {
    await registry.shutdown()
    await rm(dataDir, { recursive: true, force: true })
  }
}

const command = async (run: SimulationRunRuntime, actor: Actor, capabilityId: string, input: Record<string, unknown>): Promise<CommandResult> => {
  const outcome = await run.invokeCapability(actor, { capabilityId, input })
  if (outcome.kind !== 'command') throw new Error(`${capabilityId} is not a command`)
  return outcome.result
}
const query = async <T,>(run: SimulationRunRuntime, actor: Actor, capabilityId: string, input: Record<string, unknown>): Promise<T> => {
  const outcome = await run.invokeCapability(actor, { capabilityId, input })
  if (outcome.kind !== 'query') throw new Error(`${capabilityId} is not a query`)
  return outcome.result as T
}
const proposals = async (run: SimulationRunRuntime, plantId: string) =>
  (await query<{ readonly proposals: ReadonlyArray<{ readonly proposal: ProcessPlantProposal; readonly review?: ProposalReview }> }>(run, agent, 'world.process-plant.control.proposals', { plantId })).proposals
const signalTypes = (run: SimulationRunRuntime) => run.events().flatMap(event => event.type === 'interaction.signal.received' && event.signal.type.startsWith('process-plant.proposal.') ? [event.signal.type] : [])

const shutBlockValve = (plantId: string) => ({
  plantId,
  tagId: 'MOV-8000A',
  value: 0,
  reason: 'PORV-456A is open and not following its SHUT demand: isolate the relief line with its block valve',
  procedureStep: 'Isolate a leaking PORV',
  evidence: ['PT-455'],
})

describe('an AI agent proposes, a person approves', () => {
  test('the stored write executes under the person\'s command, and every step is journaled', async () => {
    await withRun(async (run, plantId) => {
      const proposed = await command(run, agent, 'world.process-plant.control.propose', shutBlockValve(plantId))
      expect(proposed.ok).toBe(true)
      const [pending] = await proposals(run, plantId)
      expect(pending!.proposal).toMatchObject({ id: proposed.commandId, status: 'pending', word: 'SHUT', item: 'pressurizer.blockValve', proposer: { actorId: agent.id, origin: 'ai' } })
      expect(pending!.review).toMatchObject({ permitted: true, changed: false })
      // The agent may not decide; the person does.
      expect(await command(run, agent, 'world.process-plant.control.decide', { plantId, proposalId: proposed.commandId, decision: 'approve' })).toMatchObject({ ok: false, reason: 'Only a person may approve a proposal' })
      const approved = await command(run, operator, 'world.process-plant.control.decide', { plantId, proposalId: proposed.commandId, decision: 'approve' })
      expect(approved.ok).toBe(true)
      expect((await proposals(run, plantId))[0]!.proposal).toMatchObject({ status: 'approved', closed: { actorId: operator.id, commandId: approved.commandId } })
      expect(signalTypes(run)).toEqual(['process-plant.proposal.recorded', 'process-plant.proposal.approved'])
      // The block valve strokes shut within its travel and margin; the log names the approval.
      const startedAt = Date.parse(run.snapshot().clock!.currentTime)
      await run.runMaximumPace(new Date(startedAt + 13_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
      const sample = await query<{ readonly values: ReadonlyArray<{ readonly path: string; readonly value: number }>; readonly operations: { readonly log: ReadonlyArray<{ readonly kind: string; readonly proposalId?: string; readonly origin: string; readonly actorId: string }> } }>(
        run, operator, 'world.process-plant.display.sample', { plantId, paths: ['pressurizer.blockValveEffectivePositionFraction', 'pressurizer.blockValvePositionFraction'], operations: true })
      expect(sample.values[0]!.value).toBeLessThanOrEqual(0.05)
      expect(sample.operations.log).toEqual([expect.objectContaining({ kind: 'approval', proposalId: proposed.commandId, origin: 'person', actorId: operator.id })])
    })
  })

  test('what is not on offer, a fault and an AI proposal without published evidence are refused with why', async () => {
    await withRun(async (run, plantId) => {
      expect(await command(run, agent, 'world.process-plant.control.propose', { ...shutBlockValve(plantId), tagId: 'RCP-A-RUN', value: true }))
        .toMatchObject({ ok: false, reason: 'Not offered to operators: An RCP start needs seal injection and oil lift, which the model does not have: not started from the display' })
      const fault = await command(run, agent, 'world.process-plant.control.propose', { ...shutBlockValve(plantId), tagId: undefined, path: 'pressurizer.reliefValveFailureActive', value: false })
      expect(fault.ok).toBe(false)
      if (!fault.ok) expect(fault.reason).toContain('is a fault the scenario injects')
      expect((await command(run, agent, 'world.process-plant.control.propose', { ...shutBlockValve(plantId), evidence: ['NO-SUCH-TAG'] })).ok).toBe(false)
      expect(await proposals(run, plantId)).toEqual([])
    })
  })

  test('controls.list gives the derivation with where its rules stand and the travel time', async () => {
    await withRun(async (run, plantId) => {
      const listed = await query<{ readonly items: ReadonlyArray<ListedItem> }>(run, agent, 'world.process-plant.controls.list', { plantId, items: ['pressurizer.blockValve', 'core'] })
      expect(listed.items.map(item => item.id)).toEqual(['core', 'pressurizer.blockValve'])
      const [block] = listed.items.find(item => item.id === 'pressurizer.blockValve')!.offered
      expect(block).toMatchObject({ control: { tagId: 'MOV-8000A', form: 'twoState' }, travelMs: 10_000 })
      expect(block!.standing.length).toBe(block!.control.options.length)
      const trip = listed.items.find(item => item.id === 'core')!.offered.find(entry => entry.control.tagId === 'RX-TRIP-MAN')!
      expect(trip.standing[0]!.consequences.map(rule => [rule.action, rule.state])).toEqual([['RX TRIP', 'armed']])
    })
  })
})

describe('a modulating valve set to a % (owner feedback, plan-final §12 item 3)', () => {
  test('controls.list gives its span and where it stands; a proposal reads "OPEN to 40 %", and approved it opens the valve there', async () => {
    await withRun(async (run, plantId) => {
      const listed = await query<{ readonly items: ReadonlyArray<ListedItem> }>(run, agent, 'world.process-plant.controls.list', { plantId, items: ['auxFeedwaterValveA', 'feedwaterControlValveA'] })
      const afw = listed.items.find(item => item.id === 'auxFeedwaterValveA')!
      const [valve] = afw.offered
      expect(valve).toMatchObject({ control: { tagId: 'AFW-A-CV', form: 'demand', demand: { min: 0, max: 1, step: 0.01, unit: 'fraction', shownUnit: '%' } }, now: { demand: 0, position: 0 } })
      expect(afw.position).toEqual({ path: valve!.control.state!, value: 0 })
      // A controller's valve is withheld as AUTO with what manual operation would take, and still shows its position.
      const feed = listed.items.find(item => item.id === 'feedwaterControlValveA')!
      expect(feed.offered).toEqual([])
      expect(feed.withheld[0]!.reason).toMatchObject({ kind: 'automatic', manual: expect.stringContaining('AUTO/MAN') })
      expect(feed.position!.value).toBeGreaterThan(0)
      // World checks the exact % write as a person's.
      expect(await query(run, operator, 'world.process-plant.control.validate', { plantId, tagId: 'AFW-A-CV', value: 0.4 })).toMatchObject({ accepted: true })
      const throttle = { ...shutBlockValve(plantId), tagId: 'AFW-A-CV', value: 0.4, reason: 'Feed steam generator A at 40 % of its auxiliary feedwater valve', procedureStep: undefined, evidence: ['SG-A-LVL-NR'] }
      expect(await command(run, agent, 'world.process-plant.control.propose', { ...throttle, value: 0.405 }))
        .toMatchObject({ ok: false, reason: 'Not offered to operators: AFW-A-CV AFW valve A is set from 0 % to 100 % in steps of 1 %' })
      const proposed = await command(run, agent, 'world.process-plant.control.propose', throttle)
      expect(proposed.ok).toBe(true)
      expect((await proposals(run, plantId))[0]!.proposal).toMatchObject({ word: 'OPEN to 40 %', item: 'auxFeedwaterValveA', write: { value: 0.4 } })
      expect((await command(run, operator, 'world.process-plant.control.decide', { plantId, proposalId: proposed.commandId, decision: 'approve' })).ok).toBe(true)
      // Within a second: the fixture's own feedwater line-up trips the unit on steam generator A level a second later.
      const startedAt = Date.parse(run.snapshot().clock!.currentTime)
      await run.runMaximumPace(new Date(startedAt + 1_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
      const after = await query<{ readonly items: ReadonlyArray<ListedItem> }>(run, operator, 'world.process-plant.controls.list', { plantId, items: ['auxFeedwaterValveA'] })
      expect(after.items[0]!.offered[0]!.now!.demand).toBe(0.4)
      expect(after.items[0]!.position!.value).toBeCloseTo(0.4, 2)
    })
  })
})

describe('a throttle under a standing actuation', () => {
  test('after the trip, an AI proposal to shut AFW-A-CV is refused and one to throttle it to 40 % executes on a person\'s approval, logged and listed as a throttle, and holds', async () => {
    await withRun(async (run, plantId) => {
      // The fixture's own feedwater line-up trips the unit on steam generator A level within seconds; AFW opens its valves.
      const startedAt = Date.parse(run.snapshot().clock!.currentTime)
      await run.runMaximumPace(new Date(startedAt + 5_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
      const listed = async () => (await query<{ readonly items: ReadonlyArray<ListedItem> }>(run, operator, 'world.process-plant.controls.list', { plantId, items: ['auxFeedwaterValveA'] })).items[0]!.offered[0]!
      const opened = await listed()
      expect(opened.now!.demand).toBe(1)
      expect(opened.throttledUnder).toBeUndefined()
      const throttle = { ...shutBlockValve(plantId), tagId: 'AFW-A-CV', reason: 'Steam generator A level is recovering: control AFW flow', procedureStep: undefined, evidence: ['SG-A-LVL-NR'] }
      const shut = await command(run, agent, 'world.process-plant.control.propose', { ...throttle, value: 0 })
      expect(shut.ok).toBe(false)
      if (!shut.ok) expect(shut.reason).toMatch(/ \(AFW START\) stands (active|sealed in) and holds AFW-A-CV: a command against it is refused until it is reset$/)
      const proposed = await command(run, agent, 'world.process-plant.control.propose', { ...throttle, value: 0.4 })
      expect(proposed.ok).toBe(true)
      expect((await proposals(run, plantId))[0]!.proposal).toMatchObject({ word: 'OPEN to 40 %', status: 'pending' })
      expect((await command(run, operator, 'world.process-plant.control.decide', { plantId, proposalId: proposed.commandId, decision: 'approve' })).ok).toBe(true)
      // The approved write is queued and applied with the next step.
      const approvedAt = Date.parse(run.snapshot().clock!.currentTime)
      await run.runMaximumPace(new Date(approvedAt + 1_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
      const throttled = await listed()
      expect(throttled.now!.demand).toBe(0.4)
      expect(throttled.throttledUnder!.length).toBeGreaterThan(0)
      expect(throttled.throttledUnder!.every(rule => rule.action === 'AFW START' && rule.label !== rule.ruleId)).toBe(true)
      const sample = await query<{ readonly operations: { readonly log: ReadonlyArray<{ readonly kind: string; readonly throttledUnder?: ReadonlyArray<{ readonly ruleId: string; readonly label: string }> }> } }>(
        run, operator, 'world.process-plant.display.sample', { plantId, paths: [throttled.control.path, throttled.control.state!], operations: true })
      expect(sample.operations.log).toEqual([expect.objectContaining({ kind: 'approval', throttledUnder: throttled.throttledUnder })])
      // It holds: nothing rewrites the demand after the actuation's edge.
      await run.runMaximumPace(new Date(approvedAt + 13_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
      const held = await listed()
      expect(held.now!.demand).toBe(0.4)
      expect(held.now!.position).toBeCloseTo(0.4, 2)
    })
  })
})

describe('a pending proposal across a restore', () => {
  const builtIn = scenarios.find(scenario => scenario.id === 'test-plant')!
  const plant = builtIn.initialObjects.find(object => object.packId === 'process-plant')!
  const scenario = { scenarioId: builtIn.id, runtimeIds: ['process-plant.local'], connections: [], world: builtIn.world, initialObjects: [plant], runtimeConfig: {} }
  const clockAt = (currentTime: string): SimulationClock => createSimulationClock({ currentTime: currentTime as IsoTimestamp, updatedAt: '2026-01-01T09:00:00.000Z' as IsoTimestamp, paused: true })

  test('restores pending and lapses at its plant time once its minute of wall time has passed', async () => {
    let state: unknown | null = null
    const store: PackRuntimeStateStore = { load: async () => state, save: async next => { state = structuredClone(next) } }
    const first = await createLocalProcessPlantPackRuntimeAdapter().connect({ simulationRunId: 'run:proposal-restore' as SimulationRunId, scenario, runtimeStateStore: store, runClock: clockAt(builtIn.world.startsAt) })
    try {
      const proposed = await first.sendCommand({
        id: 'command:proposal-restore' as CommandId,
        simulationRunId: 'run:proposal-restore' as SimulationRunId,
        actorId: agent.id,
        kind: processPlantControlProposeCommandKind,
        targetObjectIds: [],
        payload: shutBlockValve(String(plant.id)),
        issuedAt: builtIn.world.startsAt,
      } satisfies CommandEnvelope, { origin: 'ai' })
      expect(proposed.ok).toBe(true)
    } finally {
      await first.close()
    }
    // Restored a while later: its minute of wall time has passed.
    const saved = processPlantRuntimeStateSchema.parse(state)
    const book = saved.plants[0]!.operations!.proposals
    expect(book.map(proposal => proposal.status)).toEqual(['pending'])
    state = { ...saved, plants: saved.plants.map(entry => ({ ...entry, operations: { ...entry.operations!, proposals: book.map(proposal => ({ ...proposal, proposedAtWallMs: 0 })) } })) }
    const clock = clockAt(builtIn.world.startsAt)
    const restored: PackRuntimeConnection = await createLocalProcessPlantPackRuntimeAdapter().connect({ simulationRunId: 'run:proposal-restore' as SimulationRunId, scenario, runtimeStateStore: store, runClock: clock })
    const emitted: string[] = []
    restored.subscribe((emission: PackRuntimeEmission) => {
      if (emission.type === 'event.emission') for (const event of emission.events) if (event.type === 'interaction.signal') emitted.push(event.signal.type)
    })
    try {
      const read = async () => ((await restored.invokeQuery({ capabilityId: 'world.process-plant.control.proposals', input: { plantId: String(plant.id) } })) as { readonly proposals: ReadonlyArray<{ readonly proposal: ProcessPlantProposal }> }).proposals[0]!.proposal.status
      expect(await read()).toBe('pending')
      const advance = async (ms: number) => {
        const next = { ...clock.read(), currentTime: new Date(Date.parse(clock.read().currentTime) + ms).toISOString() as IsoTimestamp }
        await restored.advanceTo!(next)
        clock.set(next)
      }
      await advance(110_000)
      expect(await read()).toBe('pending')
      await advance(12_000)
      expect(await read()).toBe('expired')
      expect(emitted).toContain('process-plant.proposal.expired')
    } finally {
      await restored.close()
    }
  })
})
