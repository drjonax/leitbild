import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineObservationCapability, type ObservationCapabilityKind } from '../src/core/observation/capabilities.ts'
import { validateWorldAssembly } from '../src/core/packs/assembly.ts'
import { createWorldPackDescriptor, type WorldPack } from '../src/core/packs/protocol.ts'
import type { PackRuntimeAdapter, SimulationCapability } from '../src/simulation/protocol.ts'
import { fixturePack } from './fixtures/fixture-pack.ts'
import { createTestPackRuntimeAdapters, testPacks } from './helpers.ts'

describe('World Pack assembly contract', () => {
  test('accepts the complete built-in Pack set', () => {
    const assembly = validateWorldAssembly({
      packs: testPacks,
      runtimeAdapters: createTestPackRuntimeAdapters(),
    })
    expect(assembly.packs.map(pack => pack.descriptor.id)).toEqual(testPacks.map(pack => pack.descriptor.id))
  })

  test('rejects Packs without discovery descriptions', () => {
    const source = testPacks[0]
    const { description: _description, ...descriptor } = source.descriptor
    const pack = { ...source, descriptor } as unknown as WorldPack
    expect(() => validateWorldAssembly({ packs: [pack], runtimeAdapters: [] }))
      .toThrow('has no discovery description')
  })

  test('rejects capabilities outside their owning Pack namespace', () => {
    const adapters = createTestPackRuntimeAdapters()
    const source = adapters[0]!
    const capability = source.capabilities[0]!
    const adapter: PackRuntimeAdapter = {
      ...source,
      capabilities: [{ ...capability, id: 'world.foreign.invalid' }, ...source.capabilities.slice(1)],
    }
    expect(() => validateWorldAssembly({ packs: testPacks, runtimeAdapters: [adapter, ...adapters.slice(1)] }))
      .toThrow('exposes foreign Capability')
  })

  test('rejects Scenario types that the authoring catalog cannot construct', () => {
    const source = testPacks.find(pack => pack.descriptor.id === 'weather')!
    const pack: WorldPack = {
      ...source,
      authoring: { itemTypes: source.authoring!.itemTypes.slice(1) },
    }
    expect(() => validateWorldAssembly({ packs: testPacks.map(candidate => candidate === source ? pack : candidate), runtimeAdapters: createTestPackRuntimeAdapters() }))
      .toThrow('Scenario item types and authoring item types differ')
  })
})

// T25, assembly half (plan v3.1 Appendix F, R10): a Pack's observation Capabilities are the core's exact shapes,
// system-audience read queries; anything else is refused when World assembles.
describe('observation contributions', () => {
  const ids: Readonly<Record<ObservationCapabilityKind, string>> = {
    declarations: 'world.fixture.observation.declarations', read: 'world.fixture.observation.read', topology: 'world.fixture.observation.topology',
  }
  const observing = (observation: WorldPack['observation'] = { categories: ['units'], declarations: ids.declarations, read: ids.read, topology: { family: 'flow', capability: ids.topology } }): WorldPack => ({
    ...fixturePack,
    descriptor: createWorldPackDescriptor({ ...fixturePack.descriptor, contributions: [...fixturePack.descriptor.contributions.map(entry => entry.kind), 'observation'] }),
    ...(observation ? { observation } : {}),
  })
  const capability = (kind: ObservationCapabilityKind) => defineObservationCapability(kind, { id: ids[kind], title: `Observation ${kind}`, description: `Fixture observation ${kind}.` })
  const assemble = (pack: WorldPack, replace: (capabilities: ReadonlyArray<SimulationCapability>) => ReadonlyArray<SimulationCapability> = list => list) => {
    const adapters = createTestPackRuntimeAdapters().map(adapter => adapter.packId !== 'fixture' ? adapter : {
      ...adapter, capabilities: [...adapter.capabilities, ...replace((['declarations', 'read', 'topology'] as const).map(capability))],
    })
    return validateWorldAssembly({ packs: testPacks.map(candidate => candidate === fixturePack ? pack : candidate), runtimeAdapters: adapters })
  }
  const swap = (kind: ObservationCapabilityKind, change: (capability: SimulationCapability) => SimulationCapability) =>
    (list: ReadonlyArray<SimulationCapability>) => list.map(entry => entry.id === ids[kind] ? change(entry) : entry)

  test('accepts the core shapes', () => {
    expect(assemble(observing()).packs.find(pack => pack.descriptor.id === 'fixture')?.observation?.read).toBe(ids.read)
  })

  test('refuses a named Capability the Pack Runtime lacks', () => {
    expect(() => assemble(observing(), list => list.filter(entry => entry.id !== ids.read))).toThrow('lacks observation read Capability')
  })

  test('refuses a Capability that is not system-audience', () => {
    const { audience: _audience, ...open } = capability('declarations')
    expect(() => assemble(observing(), swap('declarations', () => open))).toThrow('must be a system-audience read query')
  })

  test('refuses a wrong output or input schema', () => {
    expect(() => assemble(observing(), swap('topology', entry => ({ ...entry, output: z.object({ nodes: z.array(z.string()) }).strict() })))).toThrow('differs from the core topology shape')
    expect(() => assemble(observing(), swap('read', entry => ({ ...entry, input: z.object({ refs: z.array(z.string()) }).strict() })))).toThrow('differs from the core read shape')
  })

  test('refuses observations for a category the Pack does not present', () => {
    expect(() => assemble(observing({ categories: ['reactors'], declarations: ids.declarations, read: ids.read }))).toThrow('unknown category reactors')
  })

  test('refuses an observation contribution its descriptor does not declare', () => {
    expect(() => assemble({ ...fixturePack, observation: { categories: ['units'], declarations: ids.declarations, read: ids.read } })).toThrow('contribution descriptor mismatch')
  })

  test('refuses Pack guidance longer than one line of 200 characters', () => {
    const plant = testPacks.find(pack => pack.descriptor.id === 'process-plant')!
    const guided = (guidance: string) => validateWorldAssembly({
      packs: testPacks.map(pack => pack === plant ? { ...plant, knowledge: { ...plant.knowledge!, guidance } } : pack),
      runtimeAdapters: createTestPackRuntimeAdapters(),
    })
    expect(guided('Read the first-out alarm before any value.').packs).toHaveLength(testPacks.length)
    expect(() => guided('x'.repeat(201))).toThrow('guidance must be one line')
    expect(() => guided('Read the trip first.\nThen the rest.')).toThrow('guidance must be one line')
  })
})
