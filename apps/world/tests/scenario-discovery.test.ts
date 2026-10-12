import { describe,expect,test } from 'bun:test'
import { mkdtemp,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinScenarioDefinitions,discoverScenarioDefinitions } from '../src/scenarios/definitions.ts'

describe('bundled scenario discovery', () => {
  test('ships editable physical examples and one live Norway observation scenario', () => {
    expect(builtinScenarioDefinitions.map(source => source.id)).toEqual([
      'halden-dispatch',
      'halden-emergency',
      'halden-offsite-power-restoration',
      'halden-power-complex',
      'halden-weather-response',
      'nordic-frequency-event',
      'nordland-corridor-security',
      'norway-situation-monitor',
      'rogaland-black-start',
      'supply-run',
    ])
    expect(builtinScenarioDefinitions.find(source => source.id === 'halden-power-complex')?.packs.map(pack => pack.id)).toEqual(['process-plant', 'electric-grid', 'weather'])
    expect(builtinScenarioDefinitions.find(source => source.id === 'halden-offsite-power-restoration')?.packs.map(pack => pack.id)).toEqual(['process-plant', 'electric-grid'])
    for (const id of ['nordic-frequency-event', 'nordland-corridor-security', 'rogaland-black-start']) {
      expect(builtinScenarioDefinitions.find(source => source.id === id)?.packs.map(pack => pack.id)).toEqual(['electric-grid'])
    }
    for (const id of ['halden-emergency', 'supply-run']) {
      expect(builtinScenarioDefinitions.find(source => source.id === id)?.packs.map(pack => pack.id)).toEqual(['einsatz'])
    }
    for (const id of ['norway-situation-monitor']) {
      expect(builtinScenarioDefinitions.find(source => source.id === id)?.packs.map(pack => pack.id)).toEqual(['situation-monitor'])
    }
  })
  test('accepts an empty catalog and discovers new files without a registry edit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leitbild-scenario-discovery-'))
    try {
      expect(discoverScenarioDefinitions(directory)).toEqual([])
      const source = builtinScenarioDefinitions[0]!
      await writeFile(join(directory, 'z.scenario.json'), JSON.stringify({ ...source, id: 'last' }))
      await writeFile(join(directory, 'a.scenario.json'), JSON.stringify({ ...source, id: 'first' }))
      expect(discoverScenarioDefinitions(directory).map(entry => entry.id)).toEqual(['first', 'last'])
      await writeFile(join(directory, 'duplicate.scenario.json'), JSON.stringify({ ...source, id: 'first' }))
      expect(() => discoverScenarioDefinitions(directory)).toThrow('duplicate bundled Scenario')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
