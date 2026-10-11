import { afterEach, describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { workspaceIdSchema } from '@leitbild/contracts'
import { configureActiveWorkspace } from '../src/ui/workspace-context.ts'
import {
  deleteSimulationRun,
  joinSimulationRun,
  resetSimulationRun,
  invokeSimulationRunCapability,
  querySimulationRunCapability,
  fetchRunExecution,
  syncSimulationRunSnapshot,
} from '../src/ui/simulation-run-client.ts'

const originalFetch = globalThis.fetch
const workspaceId = workspaceIdSchema.parse('11111111-1111-4111-8111-111111111111')
const apiPrefix = `/api/workspaces/${workspaceId}/world`

configureActiveWorkspace(workspaceId)

const installFetch = (
  handler: (input: string | URL | Request, init: RequestInit | undefined) => Response,
): void => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    handler(input, init)) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('simulation run client', () => {
  test('uses the Simulation Run API paths for join, snapshot, and delete', async () => {
    const calls: string[] = []
    installFetch((input, init) => {
      const path = String(input)
      calls.push(`${init?.method ?? 'GET'} ${path}`)
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ id: 'run-test', deleted: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: 'run-test', snapshot: { objects: [], seq: 0 } }), { status: 200 })
    })

    await joinSimulationRun('run-test' as SimulationRunId)
    await syncSimulationRunSnapshot('run-test' as SimulationRunId)
    await deleteSimulationRun('run-test' as SimulationRunId)

    expect(calls).toEqual([
      `GET ${apiPrefix}/simulation-runs/run-test`,
      `GET ${apiPrefix}/simulation-runs/run-test/snapshot`,
      `DELETE ${apiPrefix}/simulation-runs/run-test`,
    ])
  })

  test('sends typed inputs through the Simulation Run Capability endpoint', async () => {
    let recordedBody = ''
    installFetch((input, init) => {
      expect(String(input)).toBe(`${apiPrefix}/simulation-runs/run-test/capabilities/world.fixture.assign/invoke`)
      expect(init?.method).toBe('POST')
      recordedBody = String(init?.body ?? '')
      return new Response(JSON.stringify({ kind: 'command', result: { ok: true }, replayed: false }), { status: 200 })
    })

    const response = await invokeSimulationRunCapability('run-test' as SimulationRunId, {
      capabilityId: 'world.fixture.assign',
      input: { value: 1 },
    })

    expect(response.kind).toBe('command')
    expect(JSON.parse(recordedBody)).toEqual({
      input: { value: 1 },
    })
  })

  test('returns the direct result of a query Capability without rebuilding a Pack envelope', async () => {
    let recordedBody = ''
    installFetch((input, init) => {
      expect(String(input)).toBe(`${apiPrefix}/simulation-runs/run-test/capabilities/world.weather.map-features/invoke`)
      recordedBody = String(init?.body ?? '')
      return new Response(JSON.stringify({ kind: 'query', result: { features: [{ id: 'weather:test' }] } }), { status: 200 })
    })

    const result = await querySimulationRunCapability<{ readonly features: ReadonlyArray<{ readonly id: string }> }>(
      'run-test' as SimulationRunId,
      'world.weather.map-features',
      { zoom: 10 },
    )

    expect(result.features[0]?.id).toBe('weather:test')
    expect(JSON.parse(recordedBody)).toEqual({ input: { zoom: 10 } })
  })

  test('reads execution through the discoverable Workspace capability', async () => {
    installFetch((input, init) => {
      expect(String(input)).toBe(`/api/workspaces/${workspaceId}/capabilities/world.simulation-run.execution.read/invoke`)
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-test' },
        input: {}, actor: { kind: 'human' },
      })
      return new Response(JSON.stringify({
        result: { playback: 'paused', pace: 'realtime', currentSimulationTime: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:00:00.000Z', maximumPace: { available: true }, acceleration: null },
      }), { status: 200 })
    })

    const response = await fetchRunExecution('run-test' as SimulationRunId)

    expect(response).toMatchObject({ playback: 'paused', pace: 'realtime' })
  })

  test('does not accept Scenario replacement on join or reset', async () => {
    const calls: Array<{ readonly path: string; readonly method: string; readonly body: string }> = []
    installFetch((input, init) => {
      calls.push({ path: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
      return new Response(JSON.stringify({ id: 'run-test', snapshot: { objects: [], seq: 0 } }), { status: 200 })
    })

    await joinSimulationRun('run-test' as SimulationRunId)
    await resetSimulationRun('run-test' as SimulationRunId)

    expect(calls).toEqual([
      { path: `${apiPrefix}/simulation-runs/run-test`, method: 'GET', body: '' },
      { path: `${apiPrefix}/simulation-runs/run-test/reset`, method: 'POST', body: '' },
    ])
  })

  test('throws visible errors for failed API responses', async () => {
    installFetch(() => new Response('nope', { status: 503 }))

    await expect(joinSimulationRun('run-test' as SimulationRunId)).rejects.toThrow('simulation run join failed: 503')
  })
})
