import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allScenarios, devScenarios, FLAKY_SCENARIO_IDS, fixturePath, KEY_STATUS, loadScenarioModule, NEAR_DUPLICATES, runRequests, smokeScenarios } from './scenarios.ts'
import { keyNames } from './decisive.ts'
import { referencePlantCatalog } from './plant-catalog.ts'
import p0 from './p0-requests.json'

const catalog = referencePlantCatalog()

describe('display evaluation scenarios', () => {
  test('31 scenarios: 24 dev, 7 near-duplicates of dev scenarios', () => {
    expect(allScenarios).toHaveLength(31)
    expect(new Set(allScenarios.map(scenario => scenario.id)).size).toBe(31)
    expect(devScenarios).toHaveLength(24)
    expect(Object.keys(NEAR_DUPLICATES)).toHaveLength(7)
    for (const [id, { of }] of Object.entries(NEAR_DUPLICATES)) {
      expect(allScenarios.find(scenario => scenario.id === id)?.set).toBe('near-duplicate')
      expect(devScenarios.some(scenario => scenario.id === of)).toBe(true)
    }
  })

  test('the T1 smoke is 8 dev scenarios, none of them pre-named flaky', () => {
    expect(smokeScenarios).toHaveLength(8)
    for (const scenario of smokeScenarios) expect({ id: scenario?.id, set: scenario?.set, flaky: scenario?.flaky }).toEqual({ id: scenario!.id, set: 'dev', flaky: false })
  })

  test('every pre-named flaky scenario runs in the dev set, and only those are flagged', () => {
    expect(FLAKY_SCENARIO_IDS.size).toBe(7)
    for (const id of FLAKY_SCENARIO_IDS) expect(devScenarios.find(scenario => scenario.id === id)?.flaky).toBe(true)
    expect(allScenarios.filter(scenario => scenario.flaky).map(scenario => scenario.id).sort()).toEqual([...FLAKY_SCENARIO_IDS].sort())
  })

  test('every key is AI-drafted pending the SME, and every signal key names signals the Plant has', () => {
    for (const scenario of allScenarios) {
      for (const key of scenario.evidence) {
        expect(key.status).toBe(KEY_STATUS)
        if (key.kind !== 'signal') continue
        const names = keyNames(key, catalog)
        expect({ scenario: scenario.id, key: key.key, stale: names.filter(name => catalog.signal(name) === undefined) }).toEqual({ scenario: scenario.id, key: key.key, stale: [] })
        expect(names.length).toBeGreaterThan(0)
      }
    }
  })

  test('every dev scenario that expects a display has a scored signal key', () => {
    for (const scenario of devScenarios.filter(entry => entry.expect === 'display')) {
      expect({ id: scenario.id, signalKeys: scenario.evidence.filter(key => key.kind === 'signal' && key.use === 'P0').length > 0 }).toEqual({ id: scenario.id, signalKeys: true })
    }
  })
})

describe('the parametric probe (plan §6, AG S1-4)', () => {
  test('every P0 item sends what the P0 probe sent: its Scenario, the requests on its copy, the Room focus and the prompt', () => {
    expect(allScenarios.map(scenario => scenario.id)).toEqual(p0.scenarios.map(entry => entry.id))
    for (const scenario of allScenarios) {
      const sent = { id: scenario.id, scenario: scenario.run.scenario, requests: runRequests(scenario.run), focus: 'run', prompt: scenario.prompt,
        operation: scenario.operation === undefined ? null : { plantId: scenario.operation.plantId, equipment: scenario.operation.equipment } }
      expect(sent).toEqual(p0.scenarios.find(entry => entry.id === scenario.id)! as never)
      expect(scenario.run.pace ?? 'maximum').toBe('maximum')
    }
  })

  test('a realtime Run sends no advance: its minutes are played, not fast-forwarded', () => {
    expect(runRequests({ scenario: 'fixture:integrated-all-packs', setup: [], advanceMinutes: 2, pace: 'realtime' })).toEqual([])
    expect(runRequests({ scenario: 'halden-power-complex', setup: [], advanceMinutes: 2 })).toEqual([{ operationId: 'world.simulation-run.execution.advance', input: { minutes: 2, onComplete: 'pause' } }])
  })

  test('a fixture Scenario resolves beside the World tests; a bundled id is not a fixture', () => {
    expect(fixturePath('fixture:integrated-all-packs')).toEndWith('/apps/world/tests/fixtures/scenarios/integrated-all-packs.scenario.json')
    expect(fixturePath('halden-power-complex')).toBeNull()
  })

  const directories: string[] = []
  afterAll(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }) })
  const external = async (items: ReadonlyArray<unknown>) => {
    const directory = await mkdtemp(join(tmpdir(), 'display-eval-scenarios-'))
    directories.push(directory)
    const path = join(directory, 'set.ts')
    await writeFile(path, `export const items = ${JSON.stringify(items)}\n`)
    return loadScenarioModule(path, 'items')
  }
  const item = { id: 'ext-1', prompt: 'Anything to worry about?', expect: 'either', holdout: { evidence: [] }, run: { scenario: 'halden-power-complex', setup: [], advanceMinutes: 1 } }

  test('a scenario module outside the repository declares each Run; P0-style fields and follow-up turns are refused', async () => {
    expect((await external([item]))[0]).toMatchObject({ id: 'ext-1', set: 'holdout', run: { scenario: 'halden-power-complex', setup: [], advanceMinutes: 1 } })
    await expect(external([{ ...item, run: undefined }])).rejects.toThrow('must declare the Scenario')
    await expect(external([{ ...item, fault: { actionId: 'turbine-trip' } }])).rejects.toThrow('belongs under run')
    await expect(external([{ ...item, followUp: { prompt: 'And now?' } }])).rejects.toThrow('followUp')
    await expect(external([{ ...item, run: { ...item.run, setup: [{ operationId: 'world.electric-grid.open-branch' }] } }])).rejects.toThrow('setup[0]')
    await expect(external([{ ...item, operation: { equipment: 'x', named: 'x', tags: ['x'], proposal: 'refused' } }])).rejects.toThrow('plantId')
  })
})
