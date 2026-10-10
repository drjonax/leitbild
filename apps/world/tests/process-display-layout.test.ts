import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  readProcessDisplayWindowBounds,
  storeProcessDisplayWindowBounds,
} from '../src/ui/process-display/process-display-layout.ts'

const createMemoryStorage = () => {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value)
    },
  }
}

describe('process display window storage', () => {
  test('stores the one window bounds per Simulation Run', () => {
    const storage = createMemoryStorage()
    const simulationRunId = 'run-window-test' as SimulationRunId
    storeProcessDisplayWindowBounds({
      simulationRunId,
      bounds: { x: 40, y: 50, width: 900, height: 640 },
    }, storage)

    expect(readProcessDisplayWindowBounds({ simulationRunId }, storage)).toEqual({ x: 40, y: 50, width: 900, height: 640 })
    expect(readProcessDisplayWindowBounds({ simulationRunId: 'run-other' as SimulationRunId }, storage)).toBeNull()
    expect([...storage.values.keys()]).toEqual(['leitbild.processDisplayWindow.v2:run-window-test'])
  })

  test('rejects corrupted window bounds visibly', () => {
    const storage = createMemoryStorage()
    storage.setItem('leitbild.processDisplayWindow.v2:run-window-test', '{"x":1,"y":2,"width":"wide","height":4}')

    expect(() => readProcessDisplayWindowBounds({
      simulationRunId: 'run-window-test' as SimulationRunId,
    }, storage)).toThrow('invalid coordinates')
  })
})
