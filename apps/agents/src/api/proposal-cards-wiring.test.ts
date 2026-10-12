// ============================================================================
// Integration test: an answer's proposal card crosses execution evidence →
// workspace runtime → Workspace Host → route. The turn's workspace_call
// evidence says what it proposed and where; the runtime reads World's status
// through the Host as the proposing agent; the route returns the cards.
// ============================================================================

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { createAgentsWorkspaceRuntime } from '../workspace-runtime.ts'
import { makeStubGateway, makeStubSetup, stubProviderConfig } from './__fixtures__/stub-gateway.ts'
import { roomRoutes } from './routes/rooms.ts'
import type { RouteContext } from './routes/types.ts'
import { PROPOSE_OPERATION_ID } from '../agents/operation-claims.ts'
import type { ProposalCard } from '../agents/proposal-cards.ts'

describe('proposal card wiring', () => {
  let homeDir: string
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'leitbild-proposal-cards-'))
    process.env.LEITBILD_HOME = homeDir
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
    delete process.env.LEITBILD_HOME
  })

  test('the route gives each proposal of a turn World\'s status, read through the Host as its proposer', async () => {
    const workspaceId = newWorkspaceId()
    const run = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' })
    const hostRequests: unknown[] = []
    const host = Bun.serve({
      port: 0,
      fetch: async request => {
        hostRequests.push({ path: new URL(request.url).pathname, body: await request.json() })
        return Response.json({ result: { plantId: 'plant:halden-1', plantElapsedMs: 70_000, proposals: [{
          proposal: {
            id: 'command:p1', plantId: 'plant:halden-1', write: { path: 'pressurizer.blockValvePositionFraction', value: 0 }, item: 'pressurizer.blockValve', word: 'SHUT',
            reason: 'isolate', evidence: [], proposer: { actorId: 'actor:ai:x', origin: 'ai' }, proposedAtElapsedMs: 45_000, proposedAtWallMs: 1,
            expiresAtElapsedMs: 165_000, extended: false, status: 'approved', closed: { atElapsedMs: 65_000, actorId: 'actor:human:hilde', commandId: 'command:d1' },
          },
        }] } })
      },
    })
    try {
      const deployment = createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup(makeStubGateway()) })
      const system = createAgentsWorkspaceRuntime({ deployment, workspaceId, workspaceHostUrl: `http://127.0.0.1:${host.port}` })
      const room = system.rooms.createRoom({ name: 'Operation', createdBy: 'test' })
      const assistant = await system.spawnAIAgent({ name: 'Shift advisor', model: 'mock-model', persona: 'Advise.' })
      const input = { plantId: 'plant:halden-1', tagId: 'MOV-8000A', value: 0, reason: 'isolate', evidence: ['PT-455'] }
      system.executionStore.beginTurn({ id: 'turn-1', roomId: room.profile.id, agentId: assistant.id, startedAt: 1 })
      system.executionStore.recordAttempt('turn-1', { id: 'call_0_0', tool: 'workspace_call', arguments: { calls: [{ key: 'propose', operationId: PROPOSE_OPERATION_ID, input }] }, startedAt: 2 })
      system.executionStore.recordOutcome('turn-1', 'call_0_0', { success: true, data: { results: [
        { key: 'propose', operationId: PROPOSE_OPERATION_ID, target: { kind: 'resource', ref: run }, success: true, data: { ok: true, commandId: 'command:p1', acceptedAt: 'x' } },
      ] } })
      system.executionStore.finishTurn('turn-1', 'completed')

      const route = roomRoutes.find(candidate => candidate.pattern.source.endsWith('\\/proposals$'))!
      const call = async (turnId: string) => await route.handler(
        new Request(`http://agents/rooms/${room.profile.id}/executions/${turnId}/proposals`),
        `/rooms/${room.profile.id}/executions/${turnId}/proposals`.match(route.pattern)!,
        { system } as unknown as RouteContext,
      )
      const response = await call('turn-1')
      expect(response.status).toBe(200)
      const { cards } = await response.json() as { cards: ReadonlyArray<ProposalCard> }
      expect(cards).toHaveLength(1)
      expect(cards[0]).toMatchObject({ target: 'MOV-8000A', value: 0, outcome: { kind: 'recorded', proposalId: 'command:p1', proposal: { status: 'approved', word: 'SHUT' } } })
      expect(hostRequests).toEqual([{
        path: `/api/workspaces/${workspaceId}/capabilities/world.process-plant.control.proposals/invoke`,
        body: { resource: run, input: { plantId: 'plant:halden-1' }, actor: { kind: 'ai', id: assistant.id, displayName: 'Shift advisor' } },
      }])
      expect((await call('no-such-turn')).status).toBe(404)
    } finally {
      host.stop(true)
    }
  })
})
