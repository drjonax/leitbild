import { describe, expect, test } from 'bun:test'
import {
  answerProcessPlantQuery,
  compileProcessPlant,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
} from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance } from '../src/packs/process-plant/runtime-instance.ts'
import { processPlantCapabilities } from '../src/packs/process-plant/capabilities.ts'
import { requestedSignalValueView, type RequestedSignalValueView } from '../src/packs/process-plant/queries/signal-units.ts'

describe('requested signal units', () => {
  test('keeps exact units and explicit boolean spelling native', () => {
    expect(requestedSignalValueView({ unit: 'MW', quantity: 'power', value: 1300 }, 'MW'))
      .toEqual({ status: 'native', value: 1300, unit: 'MW', requestedUnit: 'MW' })
    expect(requestedSignalValueView({ unit: 'boolean', quantity: 'state', value: false }, 'bool'))
      .toEqual({ status: 'native', value: false, unit: 'boolean', requestedUnit: 'bool' })
    expect(requestedSignalValueView({ unit: 'boolean', quantity: 'state', value: true }, 'boolean').status).toBe('native')
  })

  test('converts absolute and delta temperatures without confusing their offsets', () => {
    for (const [quantity, value, expected] of [
      ['temperature', 0, 32],
      ['temperature', 100, 212],
      ['temperatureDelta', 10, 18],
      ['temperatureDelta', -10, -18],
    ] as const) {
      expect(requestedSignalValueView({ unit: 'degC', quantity, value }, 'degF'))
        .toEqual({ status: 'converted', value: expected, unit: 'degF', requestedUnit: 'degF' })
      expect(requestedSignalValueView({ unit: 'degF', quantity, value: expected }, 'degC').value).toBe(value)
    }
    expect(requestedSignalValueView({ unit: 'degC', quantity: 'ratio', value: 10 }, 'degF').status).toBe('unavailable')
    expect(requestedSignalValueView({ unit: 'degC', quantity: 'temperature', value: true }, 'degF'))
      .toMatchObject({ status: 'unavailable', value: true, unit: 'degC', reason: expect.stringContaining('finite numeric') })
    expect(requestedSignalValueView({ unit: 'degC', quantity: 'temperature', value: Number.MAX_VALUE }, 'degF'))
      .toMatchObject({ status: 'unavailable', value: Number.MAX_VALUE, unit: 'degC', reason: expect.stringContaining('non-finite') })
  })

  test('never invents density, pressure basis, rod calibration, enum semantics or case-insensitive symbols', () => {
    for (const [unit, requestedUnit, value] of [
      ['kg/s', 'gpm', 10],
      ['MPa', 'psig', 15.5],
      ['Pa', 'psig', 101325],
      ['Pa', 'inHgA', 101325],
      ['fraction', 'steps_withdrawn', 0.25],
      ['boolean', 'enum[RUNNING,STOPPED]', true],
      ['fraction', 'enum[OPEN,CLOSED,INTERMEDIATE]', 0.5],
      ['percent', 'enum[OPEN,CLOSED]', 50],
      ['percent', 'percent_collapsed_liquid', 70],
      ['MW', 'percent', 1300],
      ['MW', 'mW', 1300],
      ['MPa', 'mPa', 15.5],
      ['degC', 'degf', 100],
    ] as const) {
      expect(requestedSignalValueView({ unit, quantity: 'temperature', value }, requestedUnit)).toEqual({
        status: 'unavailable', value, unit, requestedUnit,
        reason: expect.stringContaining(`Native values remain in ${unit}`),
      })
    }
  })
})

describe('requested-unit signal read boundary', () => {
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:unit-views' }))
  const runtime = createProcessPlantRuntime({ system: plant })
  const plants = new Map([[plant.id, {
    plant, runtime, ramps: createProcessPlantRampRunner({ runtime }), performance: createProcessPlantRuntimePerformance(),
  }]])
  const query = (capabilityId: string, input: unknown): unknown => answerProcessPlantQuery({ request: { capabilityId, input }, plants, objects: new Map() })
  const read = (signals: unknown[]) => query('world.process-plant.signals.read', { plantId: plant.id, signals }) as {
    signals: Array<{ signal: { path: string; unit: string; quantity: string; description?: string }; variable: { value: number | boolean }; quality: unknown; valueView?: RequestedSignalValueView }>
  }

  test('preserves native observations and quality; adds a view only when requested', () => {
    // Fission power in MW, asked for in percent: the power-range instruments read that, and no conversion is declared.
    const native = read([{ path: 'core.powerMw' }]).signals[0]!
    const projected = read([{ path: 'core.powerMw', requestedUnit: 'percent' }]).signals[0]!
    expect(native).not.toHaveProperty('valueView')
    expect(projected.signal).toEqual(native.signal)
    expect(projected.variable).toEqual(native.variable)
    expect(projected.quality).toEqual(native.quality)
    expect(projected.valueView).toEqual({
      status: 'unavailable', value: native.variable.value, unit: 'MW', requestedUnit: 'percent',
      reason: expect.stringContaining('Conversion from MW to percent is unavailable'),
    })
    expect(projected.signal.description).toContain('NIS-PR-AVG')
    const capability = processPlantCapabilities.find(entry => entry.id === 'world.process-plant.signals.read')!
    expect(capability.output.parse({ plantId: plant.id, signals: [projected] })).toEqual({ plantId: plant.id, signals: [projected] })
  })

  test('uses quantity metadata on real absolute and delta temperature bindings', () => {
    for (const quantity of ['temperature', 'temperatureDelta']) {
      const binding = plant.graph.signalBindings.find(signal => signal.quantity === quantity && signal.unit === 'degC')!
      expect(binding).toBeDefined()
      const row = read([{ path: binding.path, requestedUnit: 'degF' }]).signals[0]!
      expect(row.valueView).toEqual(requestedSignalValueView({ ...binding, value: row.variable.value }, 'degF'))
      expect(row.valueView?.status).toBe('converted')
      expect(row.signal.unit).toBe('degC')
    }
  })

  test('external-reference matches cannot bypass unit warnings, and SI-SIG stays missing', () => {
    for (const units of ['percent', 'bogus-units']) {
      const row = read([{ tagId: 'nis.intermediate_range.avg', requestedUnit: units }]).signals[0]!
      expect(query('world.process-plant.procedure-tags.validate', {
        plantId: plant.id, tags: [{ id: 'nis.intermediate_range.avg', units, simPath: 'nis.intermediate_range.avg' }],
      })).toMatchObject({ tags: [{ id: 'nis.intermediate_range.avg', status: 'resolved-with-warnings', warnings: [row.valueView!.reason] }] })
    }
    expect(query('world.process-plant.procedure-tags.validate', { plantId: plant.id, tags: [{ id: 'SI-SIG', units: 'bool' }] }))
      .toMatchObject({ tags: [{ id: 'SI-SIG', status: 'missing', warnings: [] }] })
    expect(() => read([{ tagId: 'SI-SIG', requestedUnit: 'bool' }])).toThrow('signal tag not found: SI-SIG')
  })

  test('allows requestedUnit only on a read reference, retaining exact-one identity validation', () => {
    const input = (id: string) => processPlantCapabilities.find(capability => capability.id === `world.process-plant.${id}`)!.input
    expect(input('signals.read').safeParse({ plantId: plant.id, signals: [{ tagId: 'PT-455', requestedUnit: 'psig' }] }).success).toBe(true)
    for (const signal of [{ requestedUnit: 'psig' }, { tagId: 'PT-455', path: 'pressurizer.pressureMPa', requestedUnit: 'psig' }, { tagId: 'PT-455', requestedUnit: '' }]) {
      expect(input('signals.read').safeParse({ plantId: plant.id, signals: [signal] }).success).toBe(false)
    }
    expect(input('signals.resolve').safeParse({ plantId: plant.id, signals: [{ tagId: 'PT-455', requestedUnit: 'psig' }] }).success).toBe(false)
    const condition = { type: 'comparison', signal: { tagId: 'PT-455' }, operator: '>', value: 10 }
    expect(input('conditions.evaluate').safeParse({ plantId: plant.id, condition }).success).toBe(true)
    expect(input('conditions.evaluate').safeParse({ plantId: plant.id, condition: { ...condition, requestedUnit: 'psig' } }).success).toBe(false)
    expect(input('conditions.evaluate').safeParse({ plantId: plant.id, condition: { ...condition, signal: { tagId: 'PT-455', requestedUnit: 'psig' } } }).success).toBe(false)
    for (const id of ['control.validate', 'control.write']) {
      expect(input(id).safeParse({ plantId: plant.id, tagId: 'PT-455', value: 10, requestedUnit: 'psig' }).success).toBe(false)
    }
    expect(input('control.ramp').safeParse({ plantId: plant.id, tagId: 'PT-455', targetValue: 10, durationSeconds: 10, requestedUnit: 'psig' }).success).toBe(false)
  })

  test('procedure range and equipment claims are checked even for external-reference matches', () => {
    // The power range declares its 0 to 120 % span as its hard range, so a procedure's 0 to 100 % span is checked against it.
    expect(query('world.process-plant.procedure-tags.validate', {
      plantId: plant.id, tags: [{ id: 'NIS-PR-AVG', equipment: 'unverified-detector', units: 'percent', range: [0, 100] }],
    })).toMatchObject({ tags: [{ status: 'resolved-with-warnings', warnings: [expect.stringContaining('does not match process equipment nuclear-instrumentation'), expect.stringContaining('does not match signal hard range 0..120 percent')] }] })
    // The intermediate range, matched by its external reference, declares the 1e-11 A to 1e-3 A span a procedure expects.
    expect(query('world.process-plant.procedure-tags.validate', {
      plantId: plant.id, tags: [{ id: 'nis.intermediate_range.avg', equipment: 'nuclear-instrumentation', units: 'amps', range: [1e-11, 1e-3] }],
    })).toMatchObject({ tags: [{ status: 'resolved', warnings: [] }] })
    // A signal with no hard range, matched by its external reference, cannot have a declared range verified.
    expect(query('world.process-plant.procedure-tags.validate', {
      plantId: plant.id, tags: [{ id: 'rcs.t_avg', equipment: 'vessel', units: 'degC', range: [260, 330] }],
    })).toMatchObject({ tags: [{ status: 'resolved-with-warnings', warnings: [expect.stringContaining('no explicit hard range')] }] })
    expect(query('world.process-plant.procedure-tags.validate', {
      plantId: plant.id, tags: [{ id: 'ROD-POS-AVG', equipment: 'wrong-equipment', units: 'fraction', range: [0, 2] }],
    })).toMatchObject({ tags: [{ status: 'resolved-with-warnings', warnings: [expect.stringContaining('does not match process equipment'), expect.stringContaining('does not match signal hard range')] }] })
    expect(query('world.process-plant.procedure-tags.validate', {
      plantId: plant.id, tags: [{ id: 'ROD-POS-AVG', equipment: 'rod-control-system', units: 'fraction', range: [0, 1] }],
    })).toMatchObject({ tags: [{ status: 'resolved', warnings: [] }] })
    expect(() => query('world.process-plant.procedure-tags.validate', {
      plantId: plant.id, tags: [{ id: 'ROD-POS-AVG', range: [1, 0] }],
    })).toThrow('range minimum cannot exceed maximum')
  })
})
