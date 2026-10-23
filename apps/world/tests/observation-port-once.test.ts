import { describe, expect, test } from 'bun:test'
import type { ObjectId, OperationalObject } from '../src/core/model/index.ts'
import { createObservationCache, createObservationPort, requestPort } from '../src/features/displays/observation/port.ts'

// R1 perf (plan v5 §5.8): a lead request reads its object's declaration, lead and own values before the sample reads its
// views, and each Pack query reads the Run where it stands. A request reads through requestPort, which asks the Pack
// for each declaration, topology, lead and value once, so every view of the request sees that one answer; the Run's
// own port stays a plain reader, read again on every call.

const unit = { id: 'unit:one' as ObjectId, label: 'Unit one' } as OperationalObject
const provider = { categories: ['units'], declarations: 'fixture.declarations', read: 'fixture.read', topology: { family: 'flow' as const, capability: 'fixture.topology' } }
const declaration = { objectId: unit.id, revision: 'r1', observables: [], elements: [] }

const counted = () => {
  const asked: Array<{ readonly capabilityId: string; readonly input: any }> = []
  const plain = createObservationPort({
    object: objectId => (objectId === unit.id ? unit : undefined),
    provider: () => provider,
    cache: createObservationCache(),
    query: async (capabilityId, input: any) => {
      asked.push({ capabilityId, input })
      if (capabilityId === provider.declarations) return { declarations: [declaration] }
      if (capabilityId === provider.topology.capability) return { objectId: unit.id, revision: 'm1', family: 'flow', nodes: [], edges: [] }
      const refs: ReadonlyArray<string> = 'lead' in input ? ['unit:one#speed', 'unit:one#level'] : input.refs
      return {
        observations: refs.filter(ref => ref !== 'unit:one#gone').map(ref => ({ ref, at: '2026-10-22T10:00:00.000Z', clock: 'simulation', value: asked.length, quality: 'good', priority: 'none' })),
        unknown: refs.filter(ref => ref === 'unit:one#gone'),
      }
    },
  })
  return { asked, plain, port: requestPort(plain) }
}

describe('a request reads each answer once', () => {
  test('each declaration and topology is asked for once, however many views read it', async () => {
    const { asked, port } = counted()
    await port.declarations([unit.id])
    await port.declarations([unit.id])
    await port.declarations([unit.id], ['engine'])
    await port.topology(unit.id)
    await port.topology(unit.id)
    expect(asked.map(entry => entry.capabilityId)).toEqual(['fixture.declarations', 'fixture.declarations', 'fixture.topology'])
  })

  test('a value already read, by the lead or by another view, is answered from that reading; only new refs go to the Pack', async () => {
    const { asked, port } = counted()
    const lead = await port.read({ lead: { objectId: unit.id, count: 2 } })
    expect(lead.observations.map(observation => observation.ref)).toEqual(['unit:one#speed', 'unit:one#level'])
    const views = await port.read({ refs: ['unit:one#level', 'unit:one#flow', 'unit:one#gone', 'unit:one#speed'] })
    // In the order asked, the lead's readings among them, and the unknown ref said so.
    expect(views.observations.map(observation => [observation.ref, observation.value])).toEqual([['unit:one#level', 1], ['unit:one#flow', 2], ['unit:one#speed', 1]])
    expect(views.unknown).toEqual(['unit:one#gone'])
    expect(asked.map(entry => entry.input)).toEqual([{ lead: { objectId: unit.id, count: 2 } }, { refs: ['unit:one#flow', 'unit:one#gone'] }])
    // Asked again, nothing goes to the Pack.
    await port.read({ refs: ['unit:one#flow', 'unit:one#gone'] })
    await port.read({ lead: { objectId: unit.id, count: 2 } })
    expect(asked).toHaveLength(2)
  })

  test('the Run\'s own port reads again on every call: one held across a Run\'s changes reads them', async () => {
    const { asked, plain } = counted()
    await plain.read({ refs: ['unit:one#flow'] })
    expect((await plain.read({ refs: ['unit:one#flow'] })).observations[0]?.value).toBe(2)
    expect(asked).toHaveLength(2)
  })
})
