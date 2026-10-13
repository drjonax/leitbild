import { describe, expect, test } from 'bun:test'
import { workspaceResourceReferenceSchema, type WorkspaceId } from '@leitbild/contracts'
import { createExecutionStore, type ExecutionTurn } from '../core/executions/store.ts'
import { createRoomDirectory } from '../core/rooms/directory.ts'
import { SYSTEM_SENDER_ID } from '../core/types/constants.ts'
import { PROCEDURE_RUNNER_SKILL, PROPOSAL_RESUME_CAUSE } from '../core/proposal-resume.ts'
import type { AIAgent, RequestedTurn, RequestedTurnResult } from '../core/types/agent.ts'
import { PROPOSE_OPERATION_ID } from './operation-claims.ts'
import { createProposalCardReader, PROPOSALS_OPERATION_ID } from './proposal-cards.ts'
import { createProposalResumes } from './proposal-resumes.ts'
import { createTeam } from './team.ts'

// The procedure runner proposes the reactor trip on unit 2 and ends its turn;
// a person approves it in the display window. World's status is read through
// a fake Host; the Agent records each requested turn.

const workspaceId = '6f1c4b8e-3a2d-4c1b-9f0e-1a2b3c4d5e6f' as WorkspaceId
const run = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' })
const PLANT = 'plant:unit-2'
const POLL_MS = 3_000

type Status = 'pending' | 'approved' | 'rejected' | 'expired' | 'superseded' | 'withdrawn'

const tripInput = { plantId: PLANT, tagId: 'RX-TRIP', value: true, reason: 'Ordered: trip unit 2', procedureStep: 'E-0 entry', evidence: ['NI-PR'] }

const workspaceCall = (id: string, calls: ReadonlyArray<{ key: string; operationId: string; input: unknown }>, results: ReadonlyArray<unknown>) =>
  ({ id, arguments: { calls }, result: { success: true, data: { results } } })
const propose = (id: string, commandId: string, input: Record<string, unknown> = tripInput) => workspaceCall(id, [{ key: 'propose', operationId: PROPOSE_OPERATION_ID, input }], [
  { key: 'propose', operationId: PROPOSE_OPERATION_ID, target: { kind: 'resource', ref: run }, success: true, data: { ok: true, commandId, acceptedAt: 'x' } },
])
const operation = (id: string, operationId: string) => workspaceCall(id, [{ key: 'op', operationId, input: {} }], [
  { key: 'op', operationId, success: true, data: {} },
])

const fakeAgent = (skills: ReadonlyArray<string>) => {
  const turns: Array<{ roomId: string; turn: RequestedTurn }> = []
  const control = { generatingIn: undefined as string | undefined, reply: { kind: 'accepted', queued: false } as RequestedTurnResult }
  const agent = {
    id: crypto.randomUUID(),
    name: 'Leitbild Assistant',
    kind: 'ai',
    metadata: {},
    getSkills: () => skills,
    requestTurn: (roomId: string, turn: RequestedTurn): RequestedTurnResult => {
      turns.push({ roomId, turn })
      return control.reply
    },
    state: { get: () => control.generatingIn === undefined ? 'idle' : 'generating', getContext: () => control.generatingIn },
  } as unknown as AIAgent
  return { agent, turns, control }
}

const setup = (options: { readonly skills?: ReadonlyArray<string>; readonly watchMs?: number } = {}) => {
  const rooms = createRoomDirectory({})
  const team = createTeam()
  const room = rooms.createRoom({ name: 'Assistant', createdBy: SYSTEM_SENDER_ID })
  const { agent, turns, control } = fakeAgent(options.skills ?? ['leitbild-assistance', 'operator-displays', PROCEDURE_RUNNER_SKILL])
  team.addAgent(agent)
  room.addMember(agent.id)
  const store = createExecutionStore(':memory:')

  // World's proposal book of the Plant, as the Host returns it.
  const world = new Map<string, { status: Status; actorId?: string }>()
  const host = { reads: 0, down: false, refusal: undefined as string | undefined, bodies: [] as unknown[] }
  const reader = createProposalCardReader({
    workspaceId,
    hostBaseUrl: 'http://127.0.0.1:4000',
    fetchImpl: (async (_url: string, init: RequestInit) => {
      host.reads += 1
      if (host.down) throw new Error('connect ECONNREFUSED 127.0.0.1:4000')
      if (host.refusal !== undefined) return Response.json({ error: { code: 'agent_access_restricted', message: host.refusal } }, { status: 403 })
      host.bodies.push(JSON.parse(String(init.body)))
      return Response.json({ result: { plantId: PLANT, plantElapsedMs: 70_000, proposals: [...world].map(([id, entry]) => ({ proposal: {
        id, plantId: PLANT, write: { path: 'reactor.tripDemand', value: true }, item: 'reactor.trip', word: 'TRIP', reason: 'x', evidence: [],
        proposer: { actorId: `actor:ai:${agent.id}`, origin: 'ai' }, proposedAtElapsedMs: 45_000, proposedAtWallMs: 1, expiresAtElapsedMs: 165_000, extended: false,
        status: entry.status, ...(entry.status === 'pending' ? {} : { closed: { atElapsedMs: 65_000, ...(entry.actorId === undefined ? {} : { actorId: entry.actorId }) } }),
      } })) } })
    }) as unknown as typeof fetch,
  })

  const clock = { now: Date.now() }
  const timers: number[] = []
  const resumes = createProposalResumes({
    rooms, team, executions: store, readStatus: reader.read,
    now: () => clock.now,
    ...(options.watchMs === undefined ? {} : { watchMs: options.watchMs }),
    setTimer: (_run, ms) => { timers.push(ms); return () => {} },
  })
  const tick = async (): Promise<void> => {
    clock.now += POLL_MS
    await resumes.tick()
  }

  // A turn of the agent in the Room, as its execution evidence records it.
  const turn = (id: string, calls: ReadonlyArray<ReturnType<typeof workspaceCall>>, status: Exclude<ExecutionTurn['status'], 'running'> = 'completed'): void => {
    store.beginTurn({ id, roomId: room.profile.id, agentId: agent.id, startedAt: clock.now })
    for (const call of calls) {
      store.recordAttempt(id, { id: call.id, tool: 'workspace_call', arguments: call.arguments, startedAt: clock.now })
      store.recordOutcome(id, call.id, call.result)
    }
    store.finishTurn(id, status)
  }
  // The turn's answer posts, as spawn links it.
  const answered = (turnId: string, messageId = `answer-of-${turnId}`): void => resumes.answered({ executionTurnId: turnId, roomId: room.profile.id, messageId })
  const decide = (proposalId: string, status: Status, actorId = 'actor:human:hilde'): void => { world.set(proposalId, { status, actorId }) }

  return { room, agent, turns, control, world, host, clock, timers, resumes, tick, turn, answered, decide }
}

describe('resuming a procedure once its proposal is approved', () => {
  test('a trip proposed for E-0 resumes the same agent in the same room once, replying to the proposing answer', async () => {
    const s = setup()
    s.turn('turn-1', [propose('call_0_0', 'command:trip')])
    s.world.set('command:trip', { status: 'pending' })
    s.answered('turn-1')
    expect(s.resumes.watching()).toEqual(['turn-1'])
    expect(s.timers).toEqual([POLL_MS])

    await s.tick()
    expect(s.turns).toHaveLength(0)
    // Read through the Host as the proposing agent, as its card is.
    expect(s.host.bodies).toEqual([{ resource: run, input: { plantId: PLANT }, actor: { kind: 'ai', id: s.agent.id, displayName: 'Leitbild Assistant' } }])
    s.decide('command:trip', 'approved')
    await s.tick()
    expect(s.turns).toEqual([{
      roomId: s.room.profile.id,
      turn: {
        instruction: '[Proposal approved] hilde approved your proposal TRIP RX-TRIP on Plant plant:unit-2 for E-0 entry (your answer, messageId "answer-of-turn-1") in the display window, and World executed it. '
          + 'Continue the procedure as you would on "continue": read where it stands, say what changed that you did not do, and carry on.',
        inReplyTo: ['answer-of-turn-1'],
        cause: { kind: PROPOSAL_RESUME_CAUSE, name: 'hilde approved TRIP RX-TRIP' },
        requireView: false,
      },
    }])
    // At most once: the watch has ended, and reads stop.
    expect(s.resumes.watching()).toEqual([])
    const reads = s.host.reads
    await s.tick()
    expect(s.turns).toHaveLength(1)
    expect(s.host.reads).toBe(reads)
    // A second link of the same turn's answer watches nothing again.
    s.answered('turn-1', 'answer-2-of-turn-1')
    expect(s.resumes.watching()).toEqual([])
  })

  test('a rejected, expired, superseded or withdrawn proposal ends the watch without a turn', async () => {
    for (const status of ['rejected', 'expired', 'superseded', 'withdrawn'] as const) {
      const s = setup()
      s.turn('turn-1', [propose('call_0_0', 'command:trip')])
      s.world.set('command:trip', { status: 'pending' })
      s.answered('turn-1')
      s.decide('command:trip', status)
      await s.tick()
      expect(s.turns).toHaveLength(0)
      expect(s.resumes.watching()).toEqual([])
    }
  })

  test('only a proposal for a procedure is watched: one carrying procedureStep, or one of a procedure-runner turn that worked a Run', () => {
    const { procedureStep: _, ...plain } = tripInput
    // An operation proposed outside any procedure: the person continues the conversation.
    const outside = setup()
    outside.turn('turn-1', [propose('call_0_0', 'command:trip', plain)])
    outside.answered('turn-1')
    expect(outside.resumes.watching()).toEqual([])
    // Mid-procedure, the turn worked the Run.
    const runner = setup()
    runner.turn('turn-1', [operation('call_0_0', 'world.procedure.run.step.read'), propose('call_1_0', 'command:trip', plain)])
    runner.answered('turn-1')
    expect(runner.resumes.watching()).toEqual(['turn-1'])
    // The same turn by an agent without the procedure-runner Skill used none.
    const noSkill = setup({ skills: ['leitbild-assistance'] })
    noSkill.turn('turn-1', [operation('call_0_0', 'world.procedure.run.step.read'), propose('call_1_0', 'command:trip', plain)])
    noSkill.answered('turn-1')
    expect(noSkill.resumes.watching()).toEqual([])
    // A procedureStep is enough, whoever proposed it.
    const stepped = setup({ skills: [] })
    stepped.turn('turn-1', [propose('call_0_0', 'command:trip')])
    stepped.answered('turn-1')
    expect(stepped.resumes.watching()).toEqual(['turn-1'])
  })

  test('a turn that failed or was cancelled, or whose propose World refused, is not watched', () => {
    for (const status of ['failed', 'interrupted'] as const) {
      const s = setup()
      s.turn('turn-1', [propose('call_0_0', 'command:trip')], status)
      s.answered('turn-1')
      expect(s.resumes.watching()).toEqual([])
    }
    const refused = setup()
    refused.turn('turn-1', [workspaceCall('call_0_0', [{ key: 'propose', operationId: PROPOSE_OPERATION_ID, input: tripInput }], [
      { key: 'propose', operationId: PROPOSE_OPERATION_ID, success: false, error: 'simulation_command_rejected: Not offered to operators' },
    ])])
    refused.answered('turn-1')
    expect(refused.resumes.watching()).toEqual([])
  })

  test('no turn once a later turn of the agent took the procedure up after the approval; an unrelated turn does not count', async () => {
    const taken = setup()
    taken.turn('turn-1', [propose('call_0_0', 'command:trip')])
    taken.world.set('command:trip', { status: 'pending' })
    taken.answered('turn-1')
    await taken.tick()
    taken.decide('command:trip', 'approved')
    // The person pressed Continue procedure: the agent read its proposal and started E-0.
    taken.clock.now += 1
    taken.turn('turn-2', [operation('call_0_0', PROPOSALS_OPERATION_ID), operation('call_1_0', 'world.procedure.run.start')])
    await taken.tick()
    expect(taken.turns).toHaveLength(0)
    expect(taken.resumes.watching()).toEqual([])

    const unrelated = setup()
    unrelated.turn('turn-1', [propose('call_0_0', 'command:trip')])
    unrelated.world.set('command:trip', { status: 'pending' })
    unrelated.answered('turn-1')
    await unrelated.tick()
    unrelated.decide('command:trip', 'approved')
    // "What is the pressure?" read a signal only.
    unrelated.clock.now += 1
    unrelated.turn('turn-2', [operation('call_0_0', 'world.process-plant.signals.read')])
    await unrelated.tick()
    expect(unrelated.turns).toHaveLength(1)
  })

  test('a turn that read the proposal while it was still pending does not count', async () => {
    const s = setup()
    s.turn('turn-1', [propose('call_0_0', 'command:trip')])
    s.world.set('command:trip', { status: 'pending' })
    s.answered('turn-1')
    // Continue pressed too early: the agent read the proposal pending and held.
    s.clock.now += 1
    s.turn('turn-2', [operation('call_0_0', PROPOSALS_OPERATION_ID)])
    await s.tick()
    s.decide('command:trip', 'approved')
    await s.tick()
    expect(s.turns).toHaveLength(1)
  })

  test('while the agent answers in that room the resume waits, then runs unless that answer took the procedure up', async () => {
    const s = setup()
    s.turn('turn-1', [propose('call_0_0', 'command:trip')])
    s.world.set('command:trip', { status: 'pending' })
    s.answered('turn-1')
    s.decide('command:trip', 'approved')
    s.control.generatingIn = s.room.profile.id
    await s.tick()
    await s.tick()
    expect(s.turns).toHaveLength(0)
    expect(s.resumes.watching()).toEqual(['turn-1'])
    // Busy in another room: the requested turn queues there.
    s.control.generatingIn = 'another-room'
    await s.tick()
    expect(s.turns).toHaveLength(1)
  })

  test('a paused room holds the resume, another pending request is waited out, and a script ends it', async () => {
    const s = setup()
    s.turn('turn-1', [propose('call_0_0', 'command:trip')])
    s.world.set('command:trip', { status: 'pending' })
    s.answered('turn-1')
    s.decide('command:trip', 'approved')
    s.room.setPaused(true)
    await s.tick()
    expect(s.turns).toHaveLength(0)
    s.room.setPaused(false)
    s.control.reply = { kind: 'refused', reason: 'pending', message: 'already working on a request' }
    await s.tick()
    expect(s.turns).toHaveLength(1)
    expect(s.resumes.watching()).toEqual(['turn-1'])
    s.control.reply = { kind: 'accepted', queued: true }
    await s.tick()
    expect(s.turns).toHaveLength(2)
    expect(s.resumes.watching()).toEqual([])

    const scripted = setup()
    scripted.turn('turn-1', [propose('call_0_0', 'command:trip')])
    scripted.world.set('command:trip', { status: 'approved' })
    scripted.answered('turn-1')
    scripted.control.reply = { kind: 'refused', reason: 'script', message: 'A script directs this room' }
    await scripted.tick()
    await scripted.tick()
    expect(scripted.turns).toHaveLength(1)
    expect(scripted.resumes.watching()).toEqual([])
  })

  test('a manual room, a muted or departed agent, or a deleted room ends the watch without a turn', async () => {
    const cases: ReadonlyArray<(s: ReturnType<typeof setup>) => void> = [
      s => s.room.setDeliveryMode('manual'),
      s => s.room.setMuted(s.agent.id, true),
      s => s.room.removeMember(s.agent.id),
    ]
    for (const change of cases) {
      const s = setup()
      s.turn('turn-1', [propose('call_0_0', 'command:trip')])
      s.world.set('command:trip', { status: 'approved' })
      s.answered('turn-1')
      change(s)
      await s.tick()
      expect(s.turns).toHaveLength(0)
      expect(s.resumes.watching()).toEqual([])
    }
  })

  test('a Host that does not answer is read again; a refused read or a proposal World no longer keeps ends the watch', async () => {
    const down = setup()
    down.turn('turn-1', [propose('call_0_0', 'command:trip')])
    down.world.set('command:trip', { status: 'pending' })
    down.answered('turn-1')
    down.host.down = true
    await down.tick()
    expect(down.resumes.watching()).toEqual(['turn-1'])
    down.host.down = false
    down.decide('command:trip', 'approved')
    await down.tick()
    expect(down.turns).toHaveLength(1)

    const refused = setup()
    refused.turn('turn-1', [propose('call_0_0', 'command:trip')])
    refused.answered('turn-1')
    refused.host.refusal = 'AI inspect access is restricted for: plant:unit-2'
    await refused.tick()
    expect(refused.resumes.watching()).toEqual([])

    const gone = setup()
    gone.turn('turn-1', [propose('call_0_0', 'command:trip')])
    gone.answered('turn-1')
    await gone.tick()
    expect(gone.resumes.watching()).toEqual([])
    expect(gone.turns).toHaveLength(0)
  })

  test('a proposal left pending gives up after the watch time', async () => {
    const s = setup({ watchMs: 2 * POLL_MS })
    s.turn('turn-1', [propose('call_0_0', 'command:trip')])
    s.world.set('command:trip', { status: 'pending' })
    s.answered('turn-1')
    await s.tick()
    await s.tick()
    expect(s.resumes.watching()).toEqual(['turn-1'])
    await s.tick()
    expect(s.resumes.watching()).toEqual([])
    s.decide('command:trip', 'approved')
    await s.tick()
    expect(s.turns).toHaveLength(0)
  })

  test('two proposals approved together resume once naming both; one approved later resumes again', async () => {
    const both = setup()
    both.turn('turn-1', [propose('call_0_0', 'command:a'), propose('call_1_0', 'command:b', { ...tripInput, tagId: 'MSIV-A', value: false, procedureStep: 'E-0 step 4' })])
    both.decide('command:a', 'approved')
    both.decide('command:b', 'approved', 'actor:human:kari')
    both.answered('turn-1')
    await both.tick()
    expect(both.turns.map(entry => entry.turn.cause)).toEqual([{ kind: PROPOSAL_RESUME_CAUSE, name: 'hilde and kari approved TRIP RX-TRIP, TRIP MSIV-A' }])
    expect(both.turns[0]!.turn.instruction).toContain('approved your proposals TRIP RX-TRIP on Plant plant:unit-2 for E-0 entry; TRIP MSIV-A on Plant plant:unit-2 for E-0 step 4')

    const apart = setup()
    apart.turn('turn-1', [propose('call_0_0', 'command:a'), propose('call_1_0', 'command:b')])
    apart.world.set('command:a', { status: 'approved' })
    apart.world.set('command:b', { status: 'pending' })
    apart.answered('turn-1')
    await apart.tick()
    expect(apart.turns).toHaveLength(1)
    expect(apart.resumes.watching()).toEqual(['turn-1'])
    apart.decide('command:b', 'approved')
    await apart.tick()
    expect(apart.turns).toHaveLength(2)
    expect(apart.resumes.watching()).toEqual([])
  })

  test('dispose stops the watch', async () => {
    const s = setup()
    s.turn('turn-1', [propose('call_0_0', 'command:trip')])
    s.world.set('command:trip', { status: 'approved' })
    s.answered('turn-1')
    s.resumes.dispose()
    await s.tick()
    s.answered('turn-1')
    expect(s.turns).toHaveLength(0)
    expect(s.resumes.watching()).toEqual([])
  })
})
