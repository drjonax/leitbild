import { newWorkspaceId } from '@leitbild/contracts'
import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'

// A fast-forward commits its terminal state before its job releases the Run.
// Acting on that terminal state at once (pausing, closing, resetting) must wait
// for the completing job instead of refusing because maximum pace still holds it.
test('a fast-forward that has reached its target can be paused, closed and reset at once', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-maximum-pace-completion-'))
  const registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(),
    scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(),
    runtimeAdapters: createTestPackRuntimeAdapters(),
  })
  const atTerminalState = async (id: Parameters<typeof registry.executionStatus>[0]) => {
    while ((await registry.executionStatus(id)).acceleration?.status === 'running') await new Promise(resolve => setImmediate(resolve))
  }
  try {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const runtime = await registry.create({ scenarioId: 'test-response' })
      await registry.advanceExecution(runtime.id, { minutes: 0.01, onComplete: 'pause' })
      await atTerminalState(runtime.id)
      if (attempt % 3 === 0) {
        expect(await registry.setExecution(runtime.id, { playback: 'paused' })).toMatchObject({ playback: 'paused', acceleration: { status: 'completed' } })
        expect(await registry.close(runtime.id)).toBe(true)
      } else if (attempt % 3 === 1) {
        expect(await registry.close(runtime.id)).toBe(true)
      } else {
        const reset = await registry.reset(runtime.id)
        expect(reset.snapshot().clock?.paused).toBeDefined()
        expect(await registry.close(runtime.id)).toBe(true)
      }
    }
  } finally { await registry.shutdown() }
}, 30_000)
