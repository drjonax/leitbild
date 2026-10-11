import { expect, test } from 'bun:test'
import { answerProcessPlantQuery, compileProcessPlant, createPwrReferencePlantDefinition, createProcessPlantRuntime, createProcessPlantRampRunner } from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance } from '../src/packs/process-plant/runtime-instance.ts'
import { processPlantCapabilities } from '../src/packs/process-plant/capabilities.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

test('compact search preserves selection and meaning, with exact full metadata and live-read drilldown', () => {
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:discovery' }))
  const runtime = createProcessPlantRuntime({ system: plant })
  const plants = new Map([[plant.id, { plant, runtime, ramps: createProcessPlantRampRunner({ runtime }), performance: createProcessPlantRuntimePerformance() }]])
  const query = (capabilityId: string, input: Record<string, unknown>): any => {
    const result = answerProcessPlantQuery({ request: { capabilityId, input: { plantId: plant.id, ...input } }, plants, objects: new Map() })
    expect(processPlantCapabilities.find(capability => capability.id === capabilityId)!.output.parse(result)).toEqual(result)
    return result
  }
  const search = (input: Record<string, unknown> = {}) => query('world.process-plant.signals.search', input)
  const summary = search()
  const full = search({ detail: 'full' })
  expect(summary).toMatchObject({ total: full.total, offset: full.offset, returned: full.returned, hasMore: full.hasMore })
  expect(summary.signals).toEqual(full.signals.map(({ plantId, signal }: any) => {
    const { capabilities, limits, owner, externalRefs, ...rest } = signal
    return { plantId, signal: rest }
  }))
  const summaryBytes = Buffer.byteLength(JSON.stringify(summary))
  const fullBytes = Buffer.byteLength(JSON.stringify(full))
  console.info(`signal search default page: summary ${summaryBytes} bytes; full ${fullBytes} bytes`)
  expect(summaryBytes).toBeLessThan(fullBytes * 0.8)
  // Hidden metadata must remain searchable/filterable, not removed before matching.
  for (const filter of [{ text: 'RCP running' }, { procedureRelevant: true }, { writable: true }, { offset: 100, limit: 2 }]) {
    const compactPage = search(filter)
    const fullPage = search({ ...filter, detail: 'full' })
    expect(compactPage.signals.map((row: any) => row.signal.path)).toEqual(fullPage.signals.map((row: any) => row.signal.path))
  }
  const references = summary.signals.slice(0, 3).map((row: any) => ({ path: row.signal.path }))
  const resolved = query('world.process-plant.signals.resolve', { signals: references })
  const live = query('world.process-plant.signals.read', { signals: references })
  expect(resolved.signals).toEqual(full.signals.slice(0, 3).map((row: any) => row.signal))
  expect(live.signals.map((row: any) => row.signal)).toEqual(resolved.signals)
  expect(live.signals.every((row: any) => row.variable.value !== undefined && row.quality.status)).toBe(true)
})
