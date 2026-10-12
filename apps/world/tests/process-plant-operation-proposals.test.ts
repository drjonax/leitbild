import { beforeEach, describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type ProcessSignalTagId,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { validateProcessPlantControlWrite } from '../src/packs/process-plant/control-write-validation.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import { derivePlantControls, offeredOption } from '../src/packs/process-plant/operations/controls.ts'
import {
  CLOSED_PROPOSALS_KEPT,
  PROPOSAL_EXTENSION_MS,
  PROPOSAL_LIFETIME_MS,
  PROPOSAL_WALL_FLOOR_MS,
  decideProposal,
  emptyProposalBook,
  expireProposals,
  processPlantProposalBookSchema,
  proposalEvent,
  proposeOperation,
  reviewProposal,
  supersedeByCommand,
  type ProcessPlantProposalBook,
  type ProposalClock,
  type ProposalPorts,
  type ProposeRequest,
} from '../src/packs/process-plant/operations/proposals.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// AI proposes, a person approves: the proposal is the exact write World
// validated, approval executes that stored write validated again, and a
// proposal lapses at a fixed plant time that only a person's explicit
// command extends, once.

const valve = 'plant.blockValve' as VariablePath
const pump = 'plant.pump' as VariablePath
const readings: Record<string, number> = { 'PT-1': 14.8, 'LT-1': 55 }
let refusal: string | null = null
const ports: ProposalPorts = {
  offered: write => write.path === valve || write.path === pump ? { ok: true, item: 'item:x', word: write.value === 0 || write.value === false ? 'SHUT' : 'OPEN' } : { ok: false, reason: 'AUTO · L held to 55 %' },
  validate: () => refusal === null ? { accepted: true } : { accepted: false, reason: refusal },
  reading: tagId => tagId in readings ? { ok: true, path: `plant.${tagId}` as VariablePath, value: readings[tagId]! } : { ok: false, reason: `${tagId} is not a published reading` },
}
beforeEach(() => {
  refusal = null
  readings['PT-1'] = 14.8
})
const ai = { actorId: 'actor:ai:advisor', origin: 'ai' as const }
const person = { actorId: 'actor:human:op', origin: 'person' as const }
const at = (elapsedMs: number, wallMs = elapsedMs): ProposalClock => ({ elapsedMs, wallMs })
const request = (overrides: Partial<ProposeRequest> = {}): ProposeRequest => ({
  id: 'command:p1',
  plantId: 'plant',
  write: { path: valve, value: 0 },
  reason: 'PORV open and not closing: isolate it with its block valve',
  evidence: ['PT-1' as ProcessSignalTagId],
  proposer: ai,
  at: at(10_000),
  ...overrides,
})
const proposed = (overrides: Partial<ProposeRequest> = {}): ProcessPlantProposalBook => {
  const step = proposeOperation(emptyProposalBook, request(overrides), ports)
  if (!step.ok) throw new Error(step.reason)
  return step.book
}

describe('proposing an operation', () => {
  test('records the exact write with its reason, evidence as it reads now, and a fixed expiry', () => {
    const step = proposeOperation(emptyProposalBook, request({ procedureStep: 'AOP-PZR step 3' }), ports)
    expect(step.ok).toBe(true)
    expect(step.transitions.map(transition => transition.type)).toEqual(['recorded'])
    expect(step.book.proposals[0]).toMatchObject({
      id: 'command:p1',
      write: { path: valve, value: 0 },
      item: 'item:x',
      word: 'SHUT',
      procedureStep: 'AOP-PZR step 3',
      evidence: [{ tagId: 'PT-1', path: 'plant.PT-1', value: 14.8 }],
      proposer: ai,
      expiresAtElapsedMs: 10_000 + PROPOSAL_LIFETIME_MS,
      extended: false,
      status: 'pending',
    })
    // The book is the Pack's persisted shape.
    expect(processPlantProposalBookSchema.parse(step.book)).toEqual(step.book)
    expect(proposalEvent(step.transitions[0]!).type).toBe('process-plant.proposal.recorded')
  })

  test('refuses what is not on offer, what the I&C refuses, uncited or unpublished evidence, and the Run itself', () => {
    expect(proposeOperation(emptyProposalBook, request({ write: { path: 'plant.fcv' as VariablePath, value: 0 } }), ports).reason).toBe('Not offered to operators: AUTO · L held to 55 %')
    refusal = 'Safety injection on low pressurizer pressure can be blocked only below P-11'
    expect(proposeOperation(emptyProposalBook, request(), ports).reason).toBe('Safety injection on low pressurizer pressure can be blocked only below P-11')
    refusal = null
    expect(proposeOperation(emptyProposalBook, request({ evidence: [] }), ports).ok).toBe(false)
    expect(proposeOperation(emptyProposalBook, request({ evidence: ['XX-9' as ProcessSignalTagId] }), ports).reason).toBe('XX-9 is not a published reading')
    expect(proposeOperation(emptyProposalBook, request({ reason: ' ' }), ports).ok).toBe(false)
    expect(proposeOperation(emptyProposalBook, request({ reason: 'x'.repeat(301) }), ports).ok).toBe(false)
    expect(proposeOperation(emptyProposalBook, request({ proposer: { actorId: 'system:scenario', origin: 'system' } }), ports).ok).toBe(false)
    expect(proposeOperation(proposed(), request(), ports).reason).toBe('Proposal command:p1 is already recorded')
  })

  test('a newer proposal supersedes the same proposer\'s on the same equipment; another proposer\'s stands beside it', () => {
    const second = proposeOperation(proposed(), request({ id: 'command:p2', at: at(20_000) }), ports)
    expect(second.transitions.map(transition => [transition.type, transition.proposal.id])).toEqual([['superseded', 'command:p1'], ['recorded', 'command:p2']])
    const other = proposeOperation(second.book, request({ id: 'command:p3', proposer: { actorId: 'actor:ai:other', origin: 'ai' } }), ports)
    expect(other.book.proposals.filter(proposal => proposal.status === 'pending').map(proposal => proposal.id)).toEqual(['command:p2', 'command:p3'])
  })
})

describe('deciding on a proposal', () => {
  test('only a person approves; approval executes the stored write and closes it under the approver\'s command', () => {
    const book = proposeOperation(proposed(), request({ id: 'command:p2', proposer: { actorId: 'actor:ai:other', origin: 'ai' } }), ports).book
    const byAi = decideProposal(book, { proposalId: 'command:p1', decision: 'approve', decider: ai, commandId: 'command:d0', at: at(30_000) }, ports)
    expect(byAi).toMatchObject({ ok: false, reason: 'Only a person may approve a proposal' })
    expect(byAi.execute).toBeUndefined()
    const approved = decideProposal(book, { proposalId: 'command:p1', decision: 'approve', decider: person, commandId: 'command:d1', at: at(30_000) }, ports)
    expect(approved.ok).toBe(true)
    expect(approved.execute).toEqual({ path: valve, value: 0 })
    expect(approved.book.proposals.find(proposal => proposal.id === 'command:p1')).toMatchObject({ status: 'approved', closed: { atElapsedMs: 30_000, actorId: person.actorId, commandId: 'command:d1' } })
    // The other proposal for the same equipment no longer stands.
    expect(approved.transitions.map(transition => [transition.type, transition.proposal.id])).toEqual([['approved', 'command:p1'], ['superseded', 'command:p2']])
    expect(decideProposal(approved.book, { proposalId: 'command:p1', decision: 'approve', decider: person, commandId: 'command:d2', at: at(31_000) }, ports).reason).toBe('Proposal command:p1 is already approved')
  })

  test('an approval the I&C refuses now executes nothing and leaves the proposal pending', () => {
    const book = proposed()
    refusal = 'Interlock: bus A dead'
    const step = decideProposal(book, { proposalId: 'command:p1', decision: 'approve', decider: person, commandId: 'command:d1', at: at(30_000) }, ports)
    expect(step).toMatchObject({ ok: false, reason: 'Interlock: bus A dead' })
    expect(step.execute).toBeUndefined()
    expect(step.book.proposals[0]!.status).toBe('pending')
  })

  test('a person rejects with a reason; its proposer alone withdraws it', () => {
    const rejected = decideProposal(proposed(), { proposalId: 'command:p1', decision: 'reject', decider: person, commandId: 'command:d1', reason: 'Block valve stays open per SRO', at: at(30_000) }, ports)
    expect(rejected.book.proposals[0]).toMatchObject({ status: 'rejected', closed: { reason: 'Block valve stays open per SRO' } })
    expect(decideProposal(proposed(), { proposalId: 'command:p1', decision: 'withdraw', decider: person, commandId: 'command:d1', at: at(30_000) }, ports).reason).toBe('Only its proposer withdraws a proposal')
    expect(decideProposal(proposed(), { proposalId: 'command:p1', decision: 'withdraw', decider: ai, commandId: 'command:d1', at: at(30_000) }, ports).book.proposals[0]!.status).toBe('withdrawn')
  })

  test('a person extends it once, by one minute of plant time', () => {
    const extended = decideProposal(proposed(), { proposalId: 'command:p1', decision: 'extend', decider: person, commandId: 'command:d1', at: at(30_000) }, ports)
    expect(extended.book.proposals[0]).toMatchObject({ extended: true, expiresAtElapsedMs: 10_000 + PROPOSAL_LIFETIME_MS + PROPOSAL_EXTENSION_MS, status: 'pending' })
    expect(decideProposal(extended.book, { proposalId: 'command:p1', decision: 'extend', decider: person, commandId: 'command:d2', at: at(40_000) }, ports).reason).toBe('Proposal command:p1 has already been extended once')
    expect(decideProposal(proposed(), { proposalId: 'command:p1', decision: 'extend', decider: ai, commandId: 'command:d1', at: at(30_000) }, ports).ok).toBe(false)
  })
})

describe('lapsing', () => {
  test('lapses once its plant time is up and a minute of wall time has passed, never sooner at maximum pace', () => {
    const book = proposed()
    const expiry = 10_000 + PROPOSAL_LIFETIME_MS
    // Maximum pace: two plant minutes in five wall seconds.
    expect(expireProposals(book, { elapsedMs: expiry + 1, wallMs: 10_000 + 5_000 }).transitions).toEqual([])
    expect(expireProposals(book, { elapsedMs: expiry - 1, wallMs: 10_000 + PROPOSAL_WALL_FLOOR_MS * 10 }).transitions).toEqual([])
    const lapsed = expireProposals(book, { elapsedMs: expiry, wallMs: 10_000 + PROPOSAL_WALL_FLOOR_MS })
    expect(lapsed.transitions.map(transition => transition.type)).toEqual(['expired'])
    expect(lapsed.book.proposals[0]!.status).toBe('expired')
  })

  test('a decision on a lapsed proposal is refused, and the lapse is journaled', () => {
    const step = decideProposal(proposed(), { proposalId: 'command:p1', decision: 'approve', decider: person, commandId: 'command:d1', at: at(10_000 + PROPOSAL_LIFETIME_MS + PROPOSAL_WALL_FLOOR_MS) }, ports)
    expect(step).toMatchObject({ ok: false, reason: 'Proposal command:p1 is already expired' })
    expect(step.transitions.map(transition => transition.type)).toEqual(['expired'])
    expect(step.execute).toBeUndefined()
  })

  test('a command on the same equipment supersedes what was proposed for it', () => {
    const step = supersedeByCommand(proposed(), { path: valve, commandId: 'command:w1', actorId: person.actorId, at: at(20_000) })
    expect(step.book.proposals[0]).toMatchObject({ status: 'superseded', closed: { commandId: 'command:w1' } })
    expect(supersedeByCommand(proposed(), { path: pump, commandId: 'command:w1', actorId: person.actorId, at: at(20_000) }).transitions).toEqual([])
  })

  test('the book keeps every open proposal and the most recent closed ones', () => {
    let book = emptyProposalBook
    for (let index = 0; index < CLOSED_PROPOSALS_KEPT + 5; index += 1) {
      book = proposeOperation(book, request({ id: `command:p${index}`, at: at(index * 1_000) }), ports).book
    }
    book = proposeOperation(book, request({ id: 'command:open', write: { path: pump, value: true } }), ports).book
    expect(book.proposals.filter(proposal => proposal.status === 'superseded').length).toBe(CLOSED_PROPOSALS_KEPT)
    expect(book.proposals.filter(proposal => proposal.status === 'pending').map(proposal => proposal.id)).toEqual([`command:p${CLOSED_PROPOSALS_KEPT + 4}`, 'command:open'])
  })
})

describe('reviewing a pending proposal', () => {
  test('says whether the I&C allows it now and how its evidence moved, changing nothing', () => {
    const book = proposed()
    readings['PT-1'] = 14.3
    refusal = 'Interlock: bus A dead'
    const review = reviewProposal(book.proposals[0]!, ports)
    expect(review).toEqual({ permitted: false, refusal: 'Interlock: bus A dead', evidence: [{ tagId: 'PT-1' as ProcessSignalTagId, then: 14.8, now: 14.3 }], changed: true })
  })
})

describe('the stuck-open PORV on the four-loop plant (demo beat 4)', () => {
  test('the AI proposes shutting the block valve, a person approves, the stored write shuts it and pressure recovers', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:proposals', loopCount: 4 }))
    const graph = plant.graph
    const runtime = createProcessPlantRuntime({ system: plant })
    const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
    const step = () => {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-proposals' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
    const controls = derivePlantControls(plant, { notOffered: () => undefined })
    const plantPorts: ProposalPorts = {
      offered: write => offeredOption(controls, write),
      validate: write => {
        const validation = validateProcessPlantControlWrite({ system: plant, runtime, protection, payload: { plantId: plant.id, path: write.path, value: write.value } })
        return validation.accepted ? { accepted: true } : { accepted: false, reason: validation.reason }
      },
      reading: tagId => {
        const binding = graph.signalBindingByTagId.get(tagId)
        return binding?.published === true ? { ok: true, path: binding.path, value: runtime.readVariable(binding.path) } : { ok: false, reason: `${tagId} is not a published reading` }
      },
    }
    const tag = (tagId: string) => resolveProcessPlantSignalBinding(graph, { tagId: tagId as never })
    const pressure = () => Number(runtime.readVariable(tag('PT-455').path))
    const tripped = () => protection.snapshot().trips.some(trip => trip.active)
    const clock = (): ProposalClock => ({ elapsedMs: runtime.elapsedMs(), wallMs: runtime.elapsedMs() })
    for (let second = 0; second < 5; second += 1) step()
    // The instructor fails the PORV 20 % open (plan QA-17).
    for (const command of commandsForProcessPlantAction({ actionId: 'pressurizer-relief-open', parameters: { positionPercent: 20 }, graph })) {
      runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    }
    for (let second = 0; second < 40; second += 1) step()
    const blockValve = tag('MOV-8000A')
    // Neither the instructor's fault nor a controller's demand is the AI's to propose.
    expect(proposeOperation(emptyProposalBook, { ...request(), plantId: plant.id, write: { path: tag('MFW-A-CV').path, value: 0 }, evidence: ['PT-455' as ProcessSignalTagId], at: clock() }, plantPorts).reason).toMatch(/^Not offered to operators: AUTO · /)
    const failure = graph.components.find(component => component.semantics.embedded.some(device => device.id === 'reliefValve'))!.semantics.embedded.find(device => device.id === 'reliefValve')!.variables.find(path => graph.signalBindingByPath.get(path)?.actuation === 'faultInjection')!
    expect(proposeOperation(emptyProposalBook, { ...request(), plantId: plant.id, write: { path: failure, value: false }, evidence: ['PT-455' as ProcessSignalTagId], at: clock() }, plantPorts).reason).toBe('Not offered to operators: Instructor only: a fault the scenario injects')
    const atProposal = pressure()
    const proposal = proposeOperation(emptyProposalBook, {
      id: 'command:propose', plantId: plant.id, write: { path: blockValve.path, value: 0 },
      reason: 'PORV-456A is open and not following its SHUT demand: isolate the relief line with its block valve',
      evidence: ['PT-455' as ProcessSignalTagId], proposer: ai, at: clock(),
    }, plantPorts)
    expect(proposal.ok).toBe(true)
    expect(proposal.book.proposals[0]).toMatchObject({ word: 'SHUT', item: `${graph.components[blockValve.owner.type === 'component' ? blockValve.owner.componentIndex : -1]!.id}.blockValve` })
    // A person reviews it for 20 s: pressure has moved since it was proposed.
    for (let second = 0; second < 20; second += 1) step()
    expect(reviewProposal(proposal.book.proposals[0]!, plantPorts)).toMatchObject({ permitted: true, changed: true })
    const decision = decideProposal(proposal.book, { proposalId: 'command:propose', decision: 'approve', decider: person, commandId: 'command:approve', at: clock() }, plantPorts)
    expect(decision.ok).toBe(true)
    const write = decision.execute!
    const validation = validateProcessPlantControlWrite({ system: plant, runtime, protection, payload: { plantId: plant.id, path: write.path, value: write.value } })
    expect(validation.accepted).toBe(true)
    runtime.writeCommand({ type: 'setVariable', path: write.path, value: write.value })
    const atApproval = pressure()
    for (let second = 0; second < 15; second += 1) step()
    const blockState = controls.items.flatMap(entry => entry.offered).find(control => control.path === blockValve.path)!.state!
    expect(Number(runtime.readVariable(blockState))).toBeLessThan(0.05)
    for (let second = 0; second < 165; second += 1) step()
    const recovered = pressure()
    expect(recovered).toBeGreaterThan(atApproval)
    expect(tripped()).toBe(false)
  })
})
