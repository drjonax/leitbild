import { describe, expect, test } from 'bun:test'
import { answerProcessPlantQuery, compileProcessPlant, createProcessPlantRampRunner, createProcessPlantRuntime, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { processPlantSignalReferenceSchema } from '../src/packs/process-plant/signals.ts'
import { evaluateProcessPlantProcedureCondition, processPlantProcedureConditionSchema, type ProcessPlantProcedureCondition } from '../src/packs/process-plant/condition-evidence.ts'
import { evaluateProcessPlantAssessments } from '../src/packs/process-plant/assessments.ts'
import { processPlantCapabilities } from '../src/packs/process-plant/capabilities.ts'
import { createProcessPlantRecordingPlan } from '../src/packs/process-plant/recording.ts'
import { isoTimestampSchema, objectIdSchema } from '../src/core/model/index.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:procedure-evidence', loopCount: 2 }))
const runtime = createProcessPlantRuntime({ system: compiled })
const plant: ProcessPlantRuntimeInstance = { plant: compiled, runtime, ramps: createProcessPlantRampRunner({ runtime }), performance: createProcessPlantRuntimePerformance() }
const basis = { modelRef: compiled.modelRef, modelDigest: compiled.modelDigest, source: 'source:apps/world/src/packs/process-plant/specs/pwr-reference-template.graph.json', description: 'A bounded model comparison; no CSF adequacy claim.' }
const power = (value: number, operator: '>' | '<' = '>'): ProcessPlantProcedureCondition => ({ type: 'comparison', signal: processPlantSignalReferenceSchema.parse({ path: 'core.powerMw' }), operator, value, unit: 'MW' })
const missing: ProcessPlantProcedureCondition = { type: 'comparison', signal: processPlantSignalReferenceSchema.parse({ tagId: 'UNINSTALLED-NI' }), operator: '>', value: 0, unit: 'MW' }
const evaluate = (condition: ProcessPlantProcedureCondition, target = plant) => evaluateProcessPlantProcedureCondition({ plant: target, condition, basis })

describe('read-only procedure condition evidence', () => {
  test('retains actual values, native metadata, model identity and simulation time without accepting any actuation', () => {
    const before = runtime.checkpoint()
    const result = evaluate(power(1))
    expect(result).toMatchObject({ status: 'satisfied', modelRef: compiled.modelRef, modelDigest: compiled.modelDigest, simTimeMs: 0, automaticCsfQualified: false, basis: { ...basis, qualification: 'authored-comparison' } })
    expect(result.evidence[0]).toMatchObject({ provenance: 'runtime-model', instrumentationValidity: 'not-established', variable: { path: 'core.powerMw', value: runtime.readVariable(processPlantSignalReferenceSchema.parse({ path: 'core.powerMw' }).path!), unit: 'MW' }, comparison: { operator: '>', value: 1, unit: 'MW' } })
    expect(runtime.checkpoint()).toEqual(before)
  })

  test('unknown units, absent bindings and value types cannot become successful comparisons', () => {
    expect(evaluate({ ...power(1), unit: 'percent' } as ProcessPlantProcedureCondition).evidence[0]?.reason).toContain('native signal unit MW')
    expect(evaluate(missing)).toMatchObject({ status: 'unknown', evidence: [{ status: 'unknown', rangeValidity: 'unavailable' }] })
    expect(evaluate({ ...power(1), value: true } as ProcessPlantProcedureCondition)).toMatchObject({ status: 'unknown' })
    expect(evaluate({ type: 'not', condition: missing }).status).toBe('unknown')
  })

  test('all, any and voting retain unknown evidence without short-circuiting the observation frame', () => {
    for (const [type, value, expected] of [ ['all', 0, 'unknown'], ['all', 1e9, 'challenged'], ['any', 0, 'satisfied'], ['any', 1e9, 'unknown'] ] as const) {
      const result = evaluate({ type, conditions: [power(value), missing] })
      expect(result.status).toBe(expected)
      expect(result.evidence).toHaveLength(2)
      expect(result.evidence[1]?.status).toBe('unknown')
    }
    expect(evaluate({ type: 'vote', required: 2, conditions: [power(0), power(0), missing] }).status).toBe('satisfied')
    expect(evaluate({ type: 'vote', required: 2, conditions: [power(0), power(1e9), missing] }).status).toBe('unknown')
    expect(evaluate({ type: 'vote', required: 2, conditions: [power(1e9), power(1e9), missing] }).status).toBe('challenged')
  })

  test('changed model or digest withholds evaluation before reading any signal', () => {
    for (const changed of [{ ...basis, modelRef: 'process-plant.ld01.uninstalled' }, { ...basis, modelDigest: 'a'.repeat(64) }]) {
      expect(evaluateProcessPlantProcedureCondition({ plant, condition: power(0), basis: changed })).toMatchObject({ status: 'unknown', evidence: [], reason: expect.stringContaining('does not match') })
    }
  })

  test('an out-of-range reading is unknown rather than a qualified overrange bound', () => {
    // Test-only failed reading; production variable tables reject invalid writes.
    const failed = { ...plant, runtime: { ...runtime, readVariableSnapshot: (path: Parameters<typeof runtime.readVariableSnapshot>[0]) => ({ ...runtime.readVariableSnapshot(path), value: 5000, limits: { hardRange: { min: 0, max: 4000 } } }) } }
    expect(evaluate(power(1), failed)).toMatchObject({ status: 'unknown', evidence: [{ rangeValidity: 'outside-declared-range', instrumentationValidity: 'not-established' }] })
  })

  test('capability binds the canonical target and validates typed input and full output', () => {
    const capability = processPlantCapabilities.find(item => item.id === 'world.process-plant.procedure-condition.evaluate')!
    const input = { targetObjectId: compiled.id, condition: power(0), basis }
    expect(capability.input.parse(input)).toEqual(input)
    expect(capability.inspectObjectIds?.(capability.input.parse(input))).toEqual([objectIdSchema.parse(compiled.id)])
    expect(capability.inspectObjectIds?.({ ...input, targetObjectId: objectIdSchema.parse('plant:other') })).toEqual([objectIdSchema.parse('plant:other')])
    expect(capability.input.safeParse({ ...input, condition: { ...power(0), unit: undefined } }).success).toBe(false)
    expect(processPlantProcedureConditionSchema.safeParse({ type: 'vote', required: 3, conditions: [power(0)] }).success).toBe(false)
    const result = answerProcessPlantQuery({ request: { capabilityId: capability.id, input }, plants: new Map([[compiled.id, plant]]), objects: new Map() })
    expect(capability.output.parse(result)).toMatchObject({ targetObjectId: compiled.id, status: 'satisfied' })
  })

  test('generic CSF observations never invent an automatic adequacy conclusion, and heat-sink discovers the actual loops', () => {
    const rows = evaluateProcessPlantAssessments(plant, ['subcriticality', 'core-cooling', 'heat-sink', 'rcs-integrity', 'containment', 'rcs-inventory'])
    expect(rows.every(row => row.status === 'unknown')).toBe(true)
    expect(rows.every(row => String(row.reason).includes('No qualified automatic CSF criterion'))).toBe(true)
    expect(rows.find(row => row.id === 'heat-sink')?.signalsRead).toHaveLength(4)
    expect(rows.every(row => row.modelDigest === compiled.modelDigest)).toBe(true)
  })

  test('bounds hostile recursive input before recursive parsing and retains partial failed observation evidence', () => {
    let deep: unknown = power(0)
    for (let index = 0; index < 2000; index++) deep = { type: 'not', condition: deep }
    const parsed = processPlantProcedureConditionSchema.safeParse(deep)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain('32-level input limit')
    const failed = { ...plant, runtime: { ...runtime, readVariableSnapshot: (path: Parameters<typeof runtime.readVariableSnapshot>[0]) => {
      if (String(path) === 'core.effectiveReactivityPcm') throw new Error('Acquisition failed')
      return runtime.readVariableSnapshot(path)
    } } }
    expect(evaluateProcessPlantAssessments(failed, ['subcriticality'])[0]).toMatchObject({ status: 'unknown', unavailableSignals: [{ path: 'core.effectiveReactivityPcm', reason: 'Acquisition failed' }] })
    const reactivity: ProcessPlantProcedureCondition = { type: 'comparison', signal: processPlantSignalReferenceSchema.parse({ path: 'core.effectiveReactivityPcm' }), operator: '<', value: 0, unit: 'pcm' }
    const frame = evaluate({ type: 'all', conditions: [reactivity, power(1e9)] }, failed)
    expect(frame).toMatchObject({ status: 'challenged', evidence: [{ status: 'unknown', rangeValidity: 'unavailable', reason: 'Acquisition failed' }, { status: 'challenged', variable: { unit: 'MW' } }] })
  })

  test('recording preserves a declared range failure instead of marking every sample good', () => {
    const failed = { ...plant, runtime: { ...runtime, readVariableSnapshotHandle: (handle: Parameters<typeof runtime.readVariableSnapshotHandle>[0]) => ({ ...runtime.readVariableSnapshotHandle(handle), ...(String(handle.path) === 'core.powerMw' ? { value: 5000, limits: { hardRange: { min: 0, max: 4000 } } } : {}) }) } }
    const plan = createProcessPlantRecordingPlan({ selection: { packId: 'process-plant', profileId: 'operations' }, plants: new Map([[compiled.id, failed]]) })
    const timestamp = isoTimestampSchema.parse('2026-10-02T10:00:00.000Z')
    const descriptor = plan.descriptors.find(row => row.signalId === 'core.powerMw')!
    const batch = plan.sample({ observedAt: timestamp, simulationTime: timestamp })
    expect(batch.samples.find(row => row.seriesId === descriptor.id)).toMatchObject({ value: 5000, quality: 'bad', elapsedMs: 0, observedAt: timestamp, simulationTime: timestamp })
    expect(batch.samples.some(row => row.quality === 'good')).toBe(true)
  })
})
