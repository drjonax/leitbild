import { afterEach, describe, expect, test } from 'bun:test'
import { workspaceIdSchema } from '@leitbild/contracts'
import { readFileSync } from 'node:fs'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { evaluateProcedureCsfs, readProcedureCatalog, readProcedureDocument, readProcedureRuns, readProcedureTagValue, readProcedureSourceEvidence, validateProcedureTags } from '../src/ui/procedures/procedure-client.ts'
import { processPlantPackView } from '../src/packs/process-plant/ui-pack.ts'
import type { PackProcedureContribution } from '../src/core/packs/protocol.ts'
import { configureActiveWorkspace } from '../src/ui/workspace-context.ts'
import { answerProcessPlantQuery, compileProcessPlant, createProcessPlantRampRunner, createProcessPlantRuntime, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance } from '../src/packs/process-plant/runtime-instance.ts'
import type { RequestedSignalValueView } from '../src/packs/process-plant/queries/signal-units.ts'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import { procedureTestSource } from './procedure-fixtures.ts'

const originalFetch = globalThis.fetch
const workspaceId = workspaceIdSchema.parse('11111111-1111-4111-8111-111111111111')

configureActiveWorkspace(workspaceId)
const provider = processPlantPackView.procedures

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('procedure client', () => {
  test('retained source uses published resource capability and rejects substituted revision or invalid line frames', async () => {
    const revision = 'a'.repeat(40)
    const request = { sourceId: 'publication', sourceRevision: revision, sourcePath: 'world/basis/levels.md', section: 'levels', lineCount: 100 }
    const valid = { revision, path: request.sourcePath, title: 'Levels', content: '## Levels\nEvidence', startLine: 4, endLine: 5, totalLines: 5 }
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      expect(String(input)).toBe(`/api/workspaces/${workspaceId}/capabilities/world.procedure.source.read/invoke`)
      expect(JSON.parse(String(init?.body))).toEqual({
        resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-test' }, input: request, actor: { kind: 'human' },
      })
      return Response.json({ result: valid })
    }) as typeof fetch
    expect(await readProcedureSourceEvidence('run-test' as SimulationRunId, request)).toEqual(valid)
    for (const result of [
      { ...valid, revision: 'b'.repeat(40) }, { ...valid, path: 'other.md' },
      { ...valid, startLine: 6 }, { ...valid, endLine: 6 }, { ...valid, nextLine: 4 },
    ]) {
      globalThis.fetch = (async (_input: string | URL | Request): Promise<Response> => Response.json({ result })) as typeof fetch
      await expect(readProcedureSourceEvidence('run-test' as SimulationRunId, request)).rejects.toThrow()
    }
    let calls = 0
    globalThis.fetch = (async (_input: string | URL | Request): Promise<Response> => { calls++; return Response.json({ error: 'retained source unavailable' }, { status: 404 }) }) as typeof fetch
    await expect(readProcedureSourceEvidence('run-test' as SimulationRunId, request)).rejects.toThrow('retained procedure source read failed')
    expect(calls).toBe(1)
  })

  test('uses a non-process provider and shows a CSF colour only by declared criteria', async () => {
    const queries: string[] = []
    const independent: PackProcedureContribution = {
      scopeIdForObject: object => String(object.id),
      signalReadQuery: (resource, tag) => ({ capabilityId: 'world.example.observations.read', input: { resource, measurements: [tag.id] } }),
      tagValidationQuery: (resource, tags) => ({ capabilityId: 'world.example.references.validate', input: { resource, references: tags.map(tag => tag.id) } }),
      assessmentsQuery: (resource, assessmentIds) => ({ capabilityId: 'world.example.assessments.read', input: { resource, assessmentIds } }),
    }
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      queries.push(url)
      expect(JSON.parse(String(init?.body)).input.resource).toBe('example:one')
      if (url.includes('references.validate')) return Response.json({ kind: 'query', result: { tags: [{ id: 'T', status: 'resolved', warnings: [] }] } })
      if (url.includes('observations.read')) return Response.json({ kind: 'query', result: { signals: [{ signal: { unit: 'degC', label: 'Temperature' }, variable: { value: 21 } }] } })
      const level = { question: 'Level above 10 %', basis: 'Tree', answer: 'no', comparisons: [
        { reads: [{ signal: 'L', path: 'tank.levelPercent', label: 'Level', value: 0, unit: 'percent' }], operator: '>', threshold: 10, unit: 'percent', answer: 'no' },
        { reads: [{ signal: 'F1', path: 'a.flow', label: 'Flow', value: 20, unit: 'kg/s' }, { signal: 'F2', path: 'b.flow', label: 'Flow', value: 10, unit: 'kg/s' }], combines: 'total', measured: 30, operator: '>=', threshold: 27.8, unit: 'kg/s', answer: 'yes' },
      ] }
      return Response.json({ kind: 'query', result: { assessments: [
        { id: 'unqualified', title: 'Unqualified', status: 'green', path: [], simTimeMs: 10 },
        { id: 'observation', title: 'Observation', status: 'red', procedure: 'FR-X.1', qualification: 'observation-only', path: [] },
        { id: 'reference', title: 'Reference', status: 'yellow', procedure: 'FR-H.5', meaning: 'Level below span.', qualification: 'reference-model-criteria', path: [level, level] },
        { id: 'qualified', title: 'Qualified', status: 'green', qualification: 'qualified-criterion', path: [] },
      ] } })
    }) as typeof fetch
    const id = 'run-test' as SimulationRunId
    expect((await validateProcedureTags(id, 'example:one', [{ id: 'T' }], independent)).get('T')?.status).toBe('resolved')
    expect((await readProcedureTagValue(id, 'example:one', { id: 'T' }, independent)).formatted).toBe('21 degC')
    const results = await evaluateProcedureCsfs(id, 'example:one', ['unqualified', 'observation', 'reference', 'qualified'], independent)
    expect(results.get('unqualified')).toMatchObject({ status: 'unknown', qualification: 'not-established', simTimeMs: 10, reason: 'Assessment criterion qualification is not established.' })
    expect(results.get('observation')).toMatchObject({ status: 'unknown' })
    expect(results.get('observation')?.procedure).toBeUndefined()
    // A colour judged by the provider's declared criteria shows, with each comparison of its path once.
    expect(results.get('reference')).toMatchObject({ status: 'yellow', procedure: 'FR-H.5', reason: 'Level below span.', qualification: 'reference-model-criteria', signalCount: 2 })
    expect(results.get('reference')?.signals).toEqual([
      { id: 'L > 10', label: 'Level', path: 'tank.levelPercent', formatted: '0 percent', operator: '>', expected: 10, matches: false },
      { id: 'F1|F2 >= 27.8', label: 'Total of F1, F2', formatted: '30 kg/s', operator: '>=', expected: 27.8, matches: true },
    ])
    expect(results.get('qualified')?.status).toBe('green')
    expect(queries.every(url => !url.includes('process-plant'))).toBe(true)
  })

  test('rejects malformed catalog, document and Run HTTP responses', async () => {
    const id = 'run-test' as SimulationRunId
    globalThis.fetch = (async (_input: string | URL | Request): Promise<Response> => Response.json({ catalog: { source: 'invalid' }, procedure: { procedureId: 42 }, procedures: { runs: [{ status: 'imaginary' }] } })) as typeof fetch
    await expect(readProcedureCatalog(id)).rejects.toThrow()
    await expect(readProcedureDocument(id, 'E-0')).rejects.toThrow()
    await expect(readProcedureRuns(id)).rejects.toThrow()
  })

  test('validates all tags through one tolerant Process Plant query', async () => {
    const requests: unknown[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      expect(String(input)).toBe(`/api/workspaces/${workspaceId}/world/simulation-runs/run-test/capabilities/world.process-plant.procedure-tags.validate/invoke`)
      requests.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({
        kind: 'query',
        result: {
          plantId: 'plant:test',
          tags: [
            { id: 'PT-455', status: 'resolved', signal: { path: 'pressurizer.pressureMPa' }, measuredOn: 'pressurizer', warnings: [] },
            { id: 'SI-SIG', status: 'missing', warnings: [] },
          ],
        },
      }), { status: 200 })
    }) as typeof fetch

    const validation = await validateProcedureTags(
      'run-test' as SimulationRunId,
      'plant:test',
      [
        { id: 'PT-455', units: 'psig' },
        { id: 'SI-SIG', units: 'bool' },
      ],
      provider,
    )

    expect(requests).toEqual([{
      input: {
        plantId: 'plant:test',
        tags: [
          { id: 'PT-455', units: 'psig' },
          { id: 'SI-SIG', units: 'bool' },
        ],
      },
    }])
    expect(validation.get('PT-455')).toMatchObject({ id: 'PT-455', status: 'resolved', measuredOn: 'pressurizer' })
    expect(validation.get('SI-SIG')).toEqual({ id: 'SI-SIG', status: 'missing', warnings: [] })
  })

  test('rejects tag validation naming equipment malformed or for a tag the model lacks', async () => {
    for (const row of [
      { id: 'PT-455', status: 'resolved', measuredOn: '', warnings: [] },
      { id: 'PT-455', status: 'resolved', measuredOn: 7, warnings: [] },
      { id: 'SI-SIG', status: 'missing', measuredOn: 'pressurizer', warnings: [] },
    ]) {
      globalThis.fetch = (async (_input: string | URL | Request): Promise<Response> => Response.json({ kind: 'query', result: { plantId: 'plant:test', tags: [row] } })) as typeof fetch
      await expect(validateProcedureTags('run-test' as SimulationRunId, 'plant:test', [{ id: row.id }], provider)).rejects.toThrow()
    }
  })

  test('real parsed E-0 document tags cross the client and strict Pack boundary without document metadata', async () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:parsed-procedure' }))
    const runtime = createProcessPlantRuntime({ system: plant })
    const plants = new Map([[plant.id, { plant, runtime, ramps: createProcessPlantRampRunner({ runtime }), performance: createProcessPlantRuntimePerformance() }]])
    const frozenSource = readFileSync(`${import.meta.dir}/../../../packages/procmd/fixtures/pwr-ops/E-0.md`, 'utf8')
    // Test both the unchanged corpus and a source-authored extension. Neither
    // empty nor populated document annotations belong in a signal computation.
    for (const rawMarkdown of [frozenSource, frozenSource.replace('  source: Vogtle UFSAR §7.2', '  source: Vogtle UFSAR §7.2\n  operator-note: reference only')]) {
      const parsed = parseProcedureMarkdown({ source: procedureTestSource, sourcePath: 'wiki/procedures/E-0.md',
        sourceUrl: 'https://example.test/frozen/E-0.md', rawMarkdown })
      const original = JSON.stringify(parsed)
      const requests: Array<{ plantId: string; tags: Record<string, unknown>[] }> = []
      // Test-only HTTP transport uses the actual document decoder and Pack
      // query handler, including its strict input schema and real signal model.
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.endsWith('/procedures/E-0')) return Response.json({ procedure: parsed })
        expect(url).toBe(`/api/workspaces/${workspaceId}/world/simulation-runs/run-test/capabilities/world.process-plant.procedure-tags.validate/invoke`)
        const body = JSON.parse(String(init?.body)) as { input: { plantId: string; tags: Record<string, unknown>[] } }
        requests.push(body.input)
        const result = answerProcessPlantQuery({ request: { capabilityId: 'world.process-plant.procedure-tags.validate', input: body.input }, plants, objects: new Map() })
        return Response.json({ kind: 'query', result })
      }) as typeof fetch
      const document = await readProcedureDocument('run-test' as SimulationRunId, 'E-0')
      expect(document.tags[0]!.annotations).toEqual(rawMarkdown === frozenSource ? {} : { 'operator-note': 'reference only' })
      const validation = await validateProcedureTags('run-test' as SimulationRunId, plant.id, document.tags, provider)
      expect(requests).toHaveLength(1)
      expect(requests[0]!.tags).toEqual(document.tags.map(tag => Object.fromEntries(Object.entries({
        id: tag.id, description: tag.description, simPath: tag.simPath, units: tag.units, equipment: tag.equipment, source: tag.source, range: tag.range,
      }).filter(([, value]) => value !== undefined))))
      expect(validation.size).toBe(document.tags.length)
      expect(validation.get('SI-SIG')).toEqual({ id: 'SI-SIG', status: 'missing', warnings: [] })
      expect(validation.get('PT-455')?.status).toBe('resolved-with-warnings')
      expect(validation.get('PT-455')?.warnings.join(' ')).toContain('Conversion from MPa to psig is unavailable')
      expect(document.tags.some(tag => tag.range !== undefined)).toBe(true)
      expect([...validation.values()].some(row => row.warnings.some(warning => warning.startsWith('Declared procedure range')))).toBe(true)
      expect(JSON.stringify(document)).toBe(original)
      expect(JSON.stringify(parsed)).toBe(original)
      // Directly forwarding an AST still fails: do not weaken the Pack schema.
      expect(() => answerProcessPlantQuery({ request: { capabilityId: 'world.process-plant.procedure-tags.validate',
        input: { plantId: plant.id, tags: document.tags } }, plants, objects: new Map() })).toThrow('annotations')
    }
  })

  test('displays the same backend requested-unit observation available to Agents, without UI conversions', async () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:ui-unit-views' }))
    const runtime = createProcessPlantRuntime({ system: plant })
    const plants = new Map([[plant.id, { plant, runtime, ramps: createProcessPlantRampRunner({ runtime }), performance: createProcessPlantRuntimePerformance() }]])
    type SignalRow = { signal: { path: string; unit: string }; variable: { value: number | boolean }; quality: { status: string }; valueView?: RequestedSignalValueView }
    const requests: unknown[] = []
    const responses: SignalRow[] = []
    // Test-only transport delegates to the real Pack query; the browser receives
    // exactly the serialized result exposed through the Capability to Agents.
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { input: unknown }
      requests.push(body.input)
      const result = answerProcessPlantQuery({ request: { capabilityId: 'world.process-plant.signals.read', input: body.input }, plants, objects: new Map() }) as { signals: SignalRow[] }
      responses.push(result.signals[0]!)
      return Response.json({ kind: 'query', result })
    }) as typeof fetch
    const absolute = plant.graph.signalBindings.find(signal => signal.quantity === 'temperature' && signal.unit === 'degC' && signal.tagId !== undefined)!
    const delta = plant.graph.signalBindings.find(signal => signal.quantity === 'temperatureDelta' && signal.unit === 'degC' && signal.tagId !== undefined)!
    for (const [id, units] of [
      ['NIS-PR-AVG', 'percent'],
      ['PT-455', 'psig'],
      ['ROD-POS-AVG', 'steps_withdrawn'],
      ['CHG-PUMP-A', 'enum[RUNNING,STOPPED]'],
      ['RVLS-DYN', 'percent_collapsed_liquid'],
      ['CHG-PUMP-A', 'bool'],
      ['NIS-PR-AVG', 'MW'],
      [absolute.tagId!, 'degF'],
      [delta.tagId!, 'degF'],
    ] as const) {
      const result = await readProcedureTagValue('run-test' as SimulationRunId, plant.id, { id, units }, provider)
      const row = responses.at(-1)!
      expect(requests.at(-1)).toEqual({ plantId: plant.id, signals: [{ tagId: id, requestedUnit: units }] })
      expect(result).toMatchObject({ value: row.valueView!.value, unit: row.valueView!.unit, conversionStatus: row.valueView!.status, quality: row.quality.status, path: row.signal.path })
      expect(result.formatted).toEndWith(` ${row.valueView!.unit}`)
      if (row.valueView!.status === 'unavailable') {
        expect(result.warning).toBe(row.valueView!.reason)
        expect(result.unit).toBe(row.signal.unit)
        expect(result.value).toBe(row.variable.value)
      } else {
        expect(result).not.toHaveProperty('warning')
      }
    }
    const native = await readProcedureTagValue('run-test' as SimulationRunId, plant.id, { id: 'NIS-PR-AVG' }, provider)
    expect(requests.at(-1)).toEqual({ plantId: plant.id, signals: [{ tagId: 'NIS-PR-AVG' }] })
    expect(responses.at(-1)).not.toHaveProperty('valueView')
    expect(native).toMatchObject({ value: responses.at(-1)!.variable.value, unit: 'percent' })
    expect(native).not.toHaveProperty('conversionStatus')
  })

  test('rejects missing, malformed or relabeled requested-unit views instead of inventing a conversion', async () => {
    const native = { signal: { unit: 'MW' }, variable: { value: 1300 } }
    for (const view of [
      undefined,
      { status: 'success', value: 1300, unit: 'MW', requestedUnit: 'percent' },
      { status: 'unavailable', value: 1300, unit: 'MW', requestedUnit: 'percent' },
      { status: 'native', value: 1300, unit: 'percent', requestedUnit: 'percent' },
      { status: 'unavailable', value: 100, unit: 'MW', requestedUnit: 'percent', reason: 'unsupported' },
      { status: 'converted', value: 100, unit: 'MW', requestedUnit: 'percent' },
      { status: 'converted', value: 100, unit: 'percent', requestedUnit: 'MW' },
      { status: 'converted', value: '100', unit: 'percent', requestedUnit: 'percent' },
    ]) {
      globalThis.fetch = (async (_input: string | URL | Request): Promise<Response> => Response.json({
        kind: 'query', result: { signals: [{ ...native, ...(view === undefined ? {} : { valueView: view }) }] },
      })) as typeof fetch
      await expect(readProcedureTagValue('run-test' as SimulationRunId, 'plant:test', { id: 'NIS-PR-AVG', units: 'percent' }, provider)).rejects.toThrow()
    }
  })
})
