import { newWorkspaceId } from '@leitbild/contracts'
import { beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActorId, CommandResult, IsoTimestamp } from '../src/core/model/index.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { operationNow, proposalCard, type ProposalCard } from '../src/packs/process-plant/ui/displays/operation/operation-presenter.ts'
import { testScenarioDefinitions } from './fixtures/scenarios.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// Proposal characterization on the old path (plan v3.1 §6.2 "characterization tests green", rt2-delivery S1-2b; the
// plant lane's half beside T01's proposal flow): what a proposal does today, at the Capability boundary of a Run and
// on the approval card a person reviews it on (operation-presenter's proposalCard, which the swap moves unchanged).
// One Run of the four-loop Plant at full power, paused and driven at maximum pace, with the wall clock pinned so the
// wall floor is exact. From P2 week 2 the same facts run against the dark path.
//
// Where plan v3.1 §4 changes a rule on purpose, the fact here is TODAY's and T39 states the new one:
// - expiry counts from the proposal, not from first view (target: from first view);
// - two plant minutes, one person's extension of one plant minute, at least one wall minute (target: 5 to 15 sim-min);
// - a mode change voids nothing (target: void on a mode change);
// - the consequence names every protection rule armed in the mode that reads along the path (target: only thresholds
//   the action moves toward: today SHUT on the PORV block valve names the high- and the low-pressure trip).

const operator: Actor = { id: 'actor:human:proposal-operator' as ActorId, label: 'Proposal operator', role: 'operator' }
const agent: Actor = { id: 'actor:ai:proposal-agent' as ActorId, label: 'Proposal agent', role: 'ai_agent' }

// The persistence fixture's operating-point overrides trip its Plant within two plant seconds; without them the
// reference full-power point holds, so the only mode change is the one the test makes.
const fixture = testScenarioDefinitions.find(definition => definition.id === 'test-plant')!
const steady = {
  ...fixture,
  id: 'test-plant-steady',
  title: 'Steady Plant at full power',
  packs: fixture.packs.map(pack => ({ ...pack, items: pack.items.map(item => ({ ...item, operatingPoint: { ref: 'process-plant.pwr.full-power' } })) })),
}

const WALL_START = Date.parse('2026-10-20T12:00:00.000Z')
const MINUTE = 60_000

const filesUnder = async (dir: string): Promise<ReadonlyArray<string>> => (await Promise.all((await readdir(dir, { withFileTypes: true }))
  .map(async entry => entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]))).flat()

/** Numbers read off the Plant become N: the facts are the rules, not the model's values. */
const shape = (text: string): string => text.replace(/\d+(?:\.\d+)?/g, 'N')

/** A card as the facts it shows: no ids, the Plant's numbers shaped. */
const cardFacts = (card: ProposalCard) => ({
  status: card.status,
  action: card.action,
  from: card.from,
  to: card.to,
  proposer: card.proposer,
  reason: card.reason,
  evidence: card.evidence.map(entry => `${entry.tagId} ${shape(entry.then)} → ${shape(entry.now)}`),
  checked: card.checked,
  expected: card.expected,
  consequence: card.consequence === null ? null : `${shape(card.consequence.text)}; ${card.consequence.mayActuate ?? ''}`,
  reversibility: card.reversibility,
  expires: card.expires,
  extendable: card.extendable,
  approve: card.approve,
  closed: card.closed,
})

interface Facts { readonly [key: string]: any }

const observe = async (): Promise<Facts> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-proposal-characterization-'))
  const authoring = testScenarioAuthoring()
  const registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(), ...authoring, scenarioDefinitions: [...authoring.scenarioDefinitions, steady],
    runtimeAdapters: createTestPackRuntimeAdapters(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
  })
  const wallAt = (offsetMs: number): void => { setSystemTime(new Date(WALL_START + offsetMs)) }
  wallAt(0)
  try {
    const run: SimulationRunRuntime = await registry.create({ scenarioId: steady.id })
    await run.setClock({ paused: true })
    const plantId = run.snapshot().objects.find(object => object.packId === 'process-plant')!.id
    const start = Date.parse(run.snapshot().clock!.currentTime)
    const runTo = (offsetMs: number) => run.runMaximumPace(new Date(start + offsetMs).toISOString() as IsoTimestamp, { shouldStop: () => false })
    const invoke = async (actor: Actor, capabilityId: string, input: Record<string, unknown>): Promise<any> => (await run.invokeCapability(actor, { capabilityId, input: { plantId, ...input } })).result
    const outcome = (result: CommandResult) => result.ok ? 'accepted' : result.reason
    const propose = (tagId: string, value: number | boolean, reason: string, evidence: string) =>
      invoke(agent, 'world.process-plant.control.propose', { tagId, value, reason, evidence: [evidence] }) as Promise<CommandResult & { readonly commandId: string }>
    const decide = async (actor: Actor, proposalId: string, decision: string, reason?: string) =>
      outcome(await invoke(actor, 'world.process-plant.control.decide', { proposalId, decision, ...(reason === undefined ? {} : { reason }) }))

    // The approval cards, as the Plant's element panel builds them from what a person reads: control.proposals (each
    // pending one with World's review now), controls.list, and signals.read with its operations.
    const cards = async (): Promise<Readonly<Record<string, ProposalCard>>> => {
      const held = await invoke(operator, 'world.process-plant.control.proposals', {})
      const listed = await invoke(operator, 'world.process-plant.controls.list', {})
      const paths = [...new Set<string>([
        ...listed.items.flatMap((item: any) => item.offered.flatMap((entry: any) => [entry.control.path, ...(entry.control.state === undefined ? [] : [entry.control.state])])),
        ...held.proposals.flatMap((entry: any) => entry.proposal.evidence.map((cited: any) => cited.path)),
      ])]
      const read = await invoke(operator, 'world.process-plant.signals.read', { signals: paths.map(path => ({ path })), operations: true })
      const now = operationNow(
        { simulationTime: read.operations.simulationTime, plantElapsedMs: read.operations.plantElapsedMs, values: read.signals.map((entry: any) => ({ path: entry.signal.path, value: entry.variable.value })) },
        new Map(read.signals.map((entry: any) => [entry.signal.path, entry.variable.unit])),
      )
      return Object.fromEntries(held.proposals.map((entry: any) =>
        [entry.proposal.id, proposalCard(entry.proposal, entry.review ?? null, listed.items.find((item: any) => item.id === entry.proposal.item), now)]))
    }
    // Plant times count from the first proposal: a new Run plays until it is paused, so the Plant may have stepped once by then.
    let firstProposedAt = 0
    const expiries = async () => Object.fromEntries((await invoke(operator, 'world.process-plant.control.proposals', {})).proposals.map((entry: any) => [entry.proposal.id, entry.proposal.expiresAtElapsedMs - firstProposedAt]))

    // 10:00:00, at power: an AI agent proposes three operations.
    const block = (await propose('MOV-8000A', 0, 'Isolate the relief line with its block valve', 'PT-455')).commandId
    const msiv = (await propose('MSIV-A', 0, 'Isolate steam generator A', 'SG-A-LVL-NR')).commandId
    const pump = (await propose('CHG-PUMP-B', true, 'Start the standby charging pump', 'PT-455')).commandId
    firstProposedAt = (await invoke(operator, 'world.process-plant.control.proposals', {})).proposals.find((entry: any) => entry.proposal.id === block).proposal.proposedAtElapsedMs
    const expiresAsRecorded = await expiries()
    const proposed = await cards()
    const agentDecides = { approve: await decide(agent, block, 'approve'), reject: await decide(agent, block, 'reject', 'Not now'), extend: await decide(agent, block, 'extend') }
    const extensions = [await decide(operator, msiv, 'extend'), await decide(operator, msiv, 'extend')]
    const extended = await cards()
    const expiresAfterReads = await expiries()

    // Still 10:00:00, the Run paused, ten wall minutes on: a person rejects; the decision lapses what is due first.
    wallAt(10 * MINUTE)
    const rejection = await decide(operator, pump, 'reject', 'Not needed at power')
    const paused = await cards()

    // Maximum pace to 10:02:00 and 10:03:00: the plain and the extended proposal lapse at their plant times.
    await runTo(2 * MINUTE)
    const atTwo = await cards()
    await runTo(3 * MINUTE)
    const atThree = await cards()

    // 10:03:00 with the wall clock pinned: plant time runs out two minutes on, the wall floor holds it, then lets go.
    const again = (await propose('MOV-8000A', 0, 'Isolate the relief line with its block valve', 'PT-455')).commandId
    await runTo(5 * MINUTE + 5_000)
    const pastPlantTime = await cards()
    wallAt(11 * MINUTE)
    await runTo(5 * MINUTE + 6_000)
    const pastWallFloor = await cards()
    const approveLapsed = await decide(operator, again, 'approve')

    // 10:05:06: a proposal at power, then a person trips the turbine and the unit leaves power operation.
    const isolate = (await propose('MSIV-A', 0, 'Isolate steam generator A', 'SG-A-LVL-NR')).commandId
    const modeBefore = (await invoke(operator, 'world.process-plant.display.sample', { paths: ['mainSteamIsolationValveA.positionFraction'] })).mode
    const beforeTrip = await cards()
    const trip = outcome(await invoke(operator, 'world.process-plant.action.invoke', { actionId: 'turbine-trip', parameters: {} }))
    await runTo(5 * MINUTE + 16_000)
    const modeAfter = (await invoke(operator, 'world.process-plant.display.sample', { paths: ['mainSteamIsolationValveA.positionFraction'] })).mode
    const afterTrip = await cards()

    // An alarm the trip raised: the AI agent may not acknowledge it on this propose-only Plant; a person may.
    const alarmsBefore = await invoke(operator, 'world.process-plant.alarms.status', {})
    const alarm = alarmsBefore.alarms.find((entry: any) => !entry.acknowledged)
    const acknowledgements = {
      agent: outcome(await invoke(agent, 'world.process-plant.ic.lifecycle', { lifecycleId: alarm.id, action: 'acknowledge' })),
      person: outcome(await invoke(operator, 'world.process-plant.ic.lifecycle', { lifecycleId: alarm.id, action: 'acknowledge' })),
    }
    const alarmAfter = (await invoke(operator, 'world.process-plant.alarms.status', {})).alarms.find((entry: any) => entry.id === alarm.id)

    // A person approves the proposal made before the trip: the stored write, checked against the Plant now.
    const approval = await decide(operator, isolate, 'approve')
    const approved = await cards()
    const operations = (await invoke(operator, 'world.process-plant.display.sample', { paths: ['mainSteamIsolationValveA.positionFraction'], operations: true })).operations

    await registry.shutdown()
    const files = await filesUnder(dataDir)
    const journal = (await Bun.file(files.find(file => file.endsWith('/events.jsonl'))!).text()).trim().split('\n').map(line => JSON.parse(line))
    const runtimeState = await Bun.file(files.find(file => file.endsWith('/runtimes/process-plant.local.json'))!).json()
    const names = new Map<string, string>([[block, 'block'], [msiv, 'msiv'], [pump, 'pump'], [again, 'again'], [isolate, 'isolate']])
    const name = (id: string): string => names.get(id) ?? id
    const named = (text: string): string => [...names].reduce((written, [id, short]) => written.replaceAll(id, short), text)
    const byName = <T>(entries: Readonly<Record<string, T>>): Readonly<Record<string, T>> => Object.fromEntries(Object.entries(entries).map(([id, value]) => [name(id), value]))
    return {
      expiresAsRecorded: byName(expiresAsRecorded), expiresAfterReads: byName(expiresAfterReads),
      proposed: byName(proposed), agentDecides, extensions: extensions.map(named), extended: byName(extended), rejection, paused: byName(paused),
      atTwo: byName(atTwo), atThree: byName(atThree), pastPlantTime: byName(pastPlantTime), pastWallFloor: byName(pastWallFloor), approveLapsed: named(approveLapsed),
      modeBefore, trip, modeAfter, beforeTrip: byName(beforeTrip), afterTrip: byName(afterTrip),
      acknowledgements, alarmAfter: { acknowledged: alarmAfter.acknowledged, phase: alarmAfter.phase },
      approval, approved: byName(approved),
      log: operations.log.map((entry: any) => ({ kind: entry.kind, origin: entry.origin, actorId: entry.actorId, path: entry.path, value: entry.value, proposal: name(entry.proposalId) })),
      journal: journal.flatMap((event: any) => {
        if (event.type === 'command.issued' && /control\.(propose|decide)$/.test(event.command.kind)) {
          return [{ command: event.command.kind.replace('world.process-plant.', ''), by: event.provenance.source, ...(event.command.payload.decision === undefined ? {} : { decision: event.command.payload.decision }) }]
        }
        if (event.type !== 'interaction.signal.received' || !event.signal.type.startsWith('process-plant.proposal.')) return []
        const { proposalId, plantId: plant, closed, ...payload } = event.signal.payload
        expect(plant).toBe(plantId)
        return [{
          signal: event.signal.type.replace('process-plant.proposal.', ''), proposal: name(proposalId), ...payload, expiresAtElapsedMs: payload.expiresAtElapsedMs - firstProposedAt,
          ...(closed === undefined ? {} : { closed: { ...closed, atElapsedMs: closed.atElapsedMs - firstProposedAt, ...(closed.commandId === undefined ? {} : { commandId: 'the decision' }) } }),
        }]
      }),
      stored: runtimeState.state.plants[0].operations.proposals.map((proposal: any) => ({
        proposal: name(proposal.id), status: proposal.status, reason: proposal.reason,
        evidence: proposal.evidence.map((cited: any) => `${cited.tagId} ${cited.path} ${typeof cited.value}`),
      })),
    }
  } finally {
    setSystemTime()
    await registry.shutdown()
    await rm(dataDir, { recursive: true, force: true })
  }
}

let facts: Facts
beforeAll(async () => { facts = await observe() })

const AT_POWER = 'with the unit in power operation'
const BLOCK_CONSEQUENCE = `shuts off primary relief PZR → Relief header, carrying no flow now, ${AT_POWER}; may actuate: Pressurizer pressure low reactor trip; Pressurizer pressure high reactor trip; Safety injection on low pressurizer pressure`
const MSIV_CONSEQUENCE = `shuts off N kg/s main steam SG A → Steam header (N % of main steam flow), ${AT_POWER}; may actuate: Steam generator A low-low level auxiliary feedwater actuation; Steam generator A low-low level reactor trip; Steam generator A high-high level feedwater isolation and turbine trip; Turbine-driven auxiliary feedwater start on low-low level in two steam generators`
const pending = (expires: { readonly at: string; readonly inMs: number }, action: string, extendable = true) =>
  ({ status: 'pending' as const, expires, extendable, approve: { label: `Approve: ${action}`, confirm: 'button' as const, enabled: true }, closed: null })
const lapsed = (at: string) => ({ status: 'expired' as const, expires: null, extendable: false, approve: null, closed: `Expired ${at}, not executed` })
const lifecycle = (card: ProposalCard) => ({ status: card.status, expires: card.expires, extendable: card.extendable, approve: card.approve, closed: card.closed })

describe('proposal characterization on the old path', () => {
  test('an AI agent proposes the exact write; a person reviews it on its approval card', () => {
    expect(cardFacts(facts.proposed.block)).toEqual({
      ...pending({ at: '10:02:00', inMs: 120_000 }, 'SHUT MOV-8000A PORV block'),
      action: 'SHUT MOV-8000A PORV block', from: 'OPEN', to: 'SHUT', proposer: 'AI agent · 10:00:00',
      reason: 'Isolate the relief line with its block valve', evidence: ['PT-455 N MPa → N MPa'],
      checked: { permitted: true, text: 'I&C allows this command now' }, expected: 'MOV-8000A PORV block reads SHUT within 10 s',
      consequence: BLOCK_CONSEQUENCE, reversibility: 'Reversible: OPEN MOV-8000A PORV block is a new command',
    })
    expect(cardFacts(facts.proposed.msiv)).toMatchObject({ action: 'SHUT MSIV-A MSIV A', evidence: ['SG-A-LVL-NR N % → N %'], consequence: MSIV_CONSEQUENCE })
    // A start takes nothing away: no consequence line.
    expect(cardFacts(facts.proposed.pump)).toMatchObject({ action: 'START CHG-PUMP-B CHG B', from: 'STOP', to: 'RUN', consequence: null, expected: 'CHG-PUMP-B CHG B reads RUN at once' })
  })

  test('only a person approves, rejects or extends; a person rejects with a reason', () => {
    expect(facts.agentDecides).toEqual({
      approve: 'Only a person may approve a proposal', reject: 'Only a person may reject a proposal', extend: 'Only a person may extend a proposal',
    })
    expect(facts.rejection).toBe('accepted')
    expect(lifecycle(facts.paused.pump)).toEqual({ status: 'rejected' as const, expires: null, extendable: false, approve: null, closed: 'Rejected by an operator at 10:00:00: Not needed at power' })
  })

  test('expiry is fixed when it is recorded, two plant minutes on; no read starts, extends or restarts it', () => {
    expect(facts.expiresAsRecorded).toEqual({ block: 120_000, msiv: 120_000, pump: 120_000 })
    // Four reads of every proposal later (control.proposals, controls.list, signals.resolve, display.sample) only the person's extension moved one.
    expect(facts.expiresAfterReads).toEqual({ block: 120_000, msiv: 180_000, pump: 120_000 })
    expect(lifecycle(facts.atTwo.block)).toEqual(lapsed('10:02:00'))
  })

  test('the ceiling: one extension, by a person, of one plant minute', () => {
    expect(facts.extensions).toEqual(['accepted', 'Proposal msiv has already been extended once'])
    expect(lifecycle(facts.extended.msiv)).toEqual(pending({ at: '10:03:00', inMs: 180_000 }, 'SHUT MSIV-A MSIV A', false))
    expect(lifecycle(facts.atTwo.msiv)).toMatchObject({ status: 'pending', expires: { at: '10:03:00', inMs: 60_000 } })
    expect(lifecycle(facts.atThree.msiv)).toEqual(lapsed('10:03:00'))
  })

  test('paused: plant time stops and the lapse with it, whatever the wall clock', () => {
    // Ten wall minutes on, the Run paused at 10:00:00: a decision lapses what is due, and nothing is.
    expect(lifecycle(facts.paused.block)).toEqual(pending({ at: '10:02:00', inMs: 120_000 }, 'SHUT MOV-8000A PORV block'))
    expect(lifecycle(facts.paused.msiv)).toEqual(pending({ at: '10:03:00', inMs: 180_000 }, 'SHUT MSIV-A MSIV A', false))
  })

  test('at maximum pace a proposal stands past its plant time until a minute of wall time has passed', () => {
    expect(lifecycle(facts.pastPlantTime.again)).toEqual(pending({ at: '10:05:00', inMs: 0 }, 'SHUT MOV-8000A PORV block'))
    expect(lifecycle(facts.pastWallFloor.again)).toEqual(lapsed('10:05:06'))
    expect(facts.approveLapsed).toBe('Proposal again is already expired')
  })

  test('a mode change voids nothing: the proposal stands with its consequence as proposed, and approval checks the Plant now', () => {
    expect([facts.modeBefore.id, facts.trip, facts.modeAfter.id]).toEqual(['powerOperation', 'accepted', 'hotStandby'])
    expect(cardFacts(facts.beforeTrip.isolate)).toMatchObject({ ...pending({ at: '10:07:06', inMs: 120_000 }, 'SHUT MSIV-A MSIV A'), consequence: MSIV_CONSEQUENCE })
    expect(cardFacts(facts.afterTrip.isolate)).toMatchObject({
      ...pending({ at: '10:07:06', inMs: 110_000 }, 'SHUT MSIV-A MSIV A'), consequence: MSIV_CONSEQUENCE, checked: { permitted: true, text: 'I&C allows this command now' },
    })
    expect(facts.approval).toBe('accepted')
    expect(lifecycle(facts.approved.isolate)).toEqual({ status: 'approved' as const, expires: null, extendable: false, approve: null, closed: 'Approved by an operator at 10:05:16' })
    // The stored write executes under the approver's command.
    expect(facts.log).toEqual([{ kind: 'approval', origin: 'person', actorId: operator.id, path: 'mainSteamIsolationValveA.positionFraction', value: 0, proposal: 'isolate' }])
  })

  test('values journaled: every transition is a durable signal carrying the write; reason and evidence stay in the Plant\'s runtime state', () => {
    const proposer = { actorId: agent.id, origin: 'ai' }
    const block = { path: 'pressurizer.blockValvePositionFraction', value: 0, item: 'pressurizer.blockValve', word: 'SHUT', proposer }
    const msiv = { path: 'mainSteamIsolationValveA.positionFraction', value: 0, item: 'mainSteamIsolationValveA', word: 'SHUT', proposer }
    const pump = { path: 'chargingPumpB.running', value: true, item: 'chargingPumpB', word: 'START', proposer }
    const expired = (atElapsedMs: number) => ({ closed: { atElapsedMs, reason: 'Expired before a person decided' } })
    const propose = { command: 'control.propose', by: 'ai' }
    expect(facts.journal).toEqual([
      propose, { signal: 'recorded', proposal: 'block', ...block, status: 'pending', expiresAtElapsedMs: 120_000 },
      propose, { signal: 'recorded', proposal: 'msiv', ...msiv, status: 'pending', expiresAtElapsedMs: 120_000 },
      propose, { signal: 'recorded', proposal: 'pump', ...pump, status: 'pending', expiresAtElapsedMs: 120_000 },
      // A refused decision is journaled as its command only.
      { command: 'control.decide', by: 'ai', decision: 'approve' }, { command: 'control.decide', by: 'ai', decision: 'reject' }, { command: 'control.decide', by: 'ai', decision: 'extend' },
      { command: 'control.decide', by: 'operator', decision: 'extend' }, { signal: 'extended', proposal: 'msiv', ...msiv, status: 'pending', expiresAtElapsedMs: 180_000 },
      { command: 'control.decide', by: 'operator', decision: 'extend' },
      { command: 'control.decide', by: 'operator', decision: 'reject' },
      { signal: 'rejected', proposal: 'pump', ...pump, status: 'rejected', expiresAtElapsedMs: 120_000, closed: { atElapsedMs: 0, actorId: operator.id, commandId: 'the decision', reason: 'Not needed at power' } },
      { signal: 'expired', proposal: 'block', ...block, status: 'expired', expiresAtElapsedMs: 120_000, ...expired(120_000) },
      { signal: 'expired', proposal: 'msiv', ...msiv, status: 'expired', expiresAtElapsedMs: 180_000, ...expired(180_000) },
      propose, { signal: 'recorded', proposal: 'again', ...block, status: 'pending', expiresAtElapsedMs: 300_000 },
      { signal: 'expired', proposal: 'again', ...block, status: 'expired', expiresAtElapsedMs: 300_000, ...expired(306_000) },
      { command: 'control.decide', by: 'operator', decision: 'approve' },
      propose, { signal: 'recorded', proposal: 'isolate', ...msiv, status: 'pending', expiresAtElapsedMs: 426_000 },
      { command: 'control.decide', by: 'operator', decision: 'approve' },
      { signal: 'approved', proposal: 'isolate', ...msiv, status: 'approved', expiresAtElapsedMs: 426_000, closed: { atElapsedMs: 316_000, actorId: operator.id, commandId: 'the decision' } },
    ])
    expect(facts.stored).toEqual([
      { proposal: 'block', status: 'expired', reason: 'Isolate the relief line with its block valve', evidence: ['PT-455 pressurizer.pressureMPa number'] },
      { proposal: 'msiv', status: 'expired', reason: 'Isolate steam generator A', evidence: ['SG-A-LVL-NR sgA.levelPercent number'] },
      { proposal: 'pump', status: 'rejected', reason: 'Start the standby charging pump', evidence: ['PT-455 pressurizer.pressureMPa number'] },
      { proposal: 'again', status: 'expired', reason: 'Isolate the relief line with its block valve', evidence: ['PT-455 pressurizer.pressureMPa number'] },
      { proposal: 'isolate', status: 'approved', reason: 'Isolate steam generator A', evidence: ['SG-A-LVL-NR sgA.levelPercent number'] },
    ])
  })

  test('an AI agent may not acknowledge an alarm on a propose-only Plant; a person may', () => {
    expect(facts.acknowledgements).toEqual({
      agent: 'An AI agent proposes operations on this Plant for a person to approve (world.process-plant.control.propose); it operates it directly only while it drives an active procedure Run on it',
      person: 'accepted',
    })
    expect(facts.alarmAfter).toEqual({ acknowledged: true, phase: 'activeAcknowledged' })
  })
})
