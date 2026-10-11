import { describe, expect, test } from 'bun:test'
import { answerProcessPlantQuery, compileProcessPlant, createPwrReferencePlantDefinition } from '../index.ts'
import { processPlantCapabilities } from '../capabilities.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:graph-read' }))
const plants = new Map([[plant.id, { plant } as ProcessPlantRuntimeInstance]])
const capability = processPlantCapabilities.find(item => item.id === 'world.process-plant.graph.read')!

interface Connections {
  mode: 'connections'
  total: number; offset: number; returned: number; hasMore: boolean
  components: Array<{ id: string; kind: string; label: string; shortLabel?: string; loop?: string }>
  links: Array<{ id: string; kind: string; service?: string; from: string; fromPort: string; to: string; toPort: string; loop?: string }>
  continues: Array<{ componentId: string; direction: 'upstream' | 'downstream'; links: number; next: string[] }>
}

// Through the published input and output contracts, as the Workspace Host invokes it.
const read = (input: Record<string, unknown>): unknown => {
  const result = answerProcessPlantQuery({
    request: { capabilityId: 'world.process-plant.graph.read', input: capability.input.parse({ plantId: plant.id, ...input }) },
    plants,
    objects: new Map(),
  })
  expect(capability.output.parse(result)).toEqual(result)
  return result
}
const connections = (input: Record<string, unknown>): Connections => read(input) as Connections
const bytes = (value: unknown): number => JSON.stringify(value).length
const linkIds = (result: Connections): string[] => result.links.map(link => link.id)
const rejection = (input: Record<string, unknown>): { code?: string; message: string } => {
  try {
    read(input)
  } catch (error) {
    return error as { code?: string; message: string }
  }
  throw new Error('graph.read accepted an input it must reject')
}

describe('Plant graph read', () => {
  test('answers what a pump takes its water and power from and where its flow goes in a compact read', () => {
    const result = connections({ componentIds: ['auxFeedwaterPumpMotor'] })
    expect(result).toMatchObject({ mode: 'connections', total: 3, returned: 3, hasMore: false })
    expect(result.links.map(({ from, fromPort, to, toPort, kind, service }) => ({ from, fromPort, to, toPort, kind, service }))).toEqual([
      { from: 'auxFeedwaterTank', fromPort: 'outlet', to: 'auxFeedwaterPumpMotor', toPort: 'inlet', kind: 'fluidFlow', service: 'auxFeedwater' },
      { from: 'auxFeedwaterPumpMotor', fromPort: 'outlet', to: 'auxFeedwaterHeader', toPort: 'inletA', kind: 'fluidFlow', service: 'auxFeedwater' },
      { from: 'safetyBusA', fromPort: 'outlet', to: 'auxFeedwaterPumpMotor', toPort: 'power', kind: 'electricalPower', service: undefined },
    ])
    expect(result.components.map(component => component.id).sort()).toEqual(['auxFeedwaterHeader', 'auxFeedwaterPumpMotor', 'auxFeedwaterTank', 'safetyBusA'])
    expect(result.components.find(component => component.id === 'safetyBusA')).toEqual({ id: 'safetyBusA', kind: 'electricalBus', label: 'Safety Bus A', shortLabel: 'Bus A' })
    // Where the read stops is stated, with what comes next: never a silent cut.
    expect(result.continues).toEqual([
      // The condensate storage tank also takes the hotwell's reject.
      { componentId: 'auxFeedwaterTank', direction: 'upstream', links: 1, next: ['hotwellRejectValve'] },
      { componentId: 'safetyBusA', direction: 'upstream', links: 2, next: ['dieselBreakerA', 'offsiteBreakerA'] },
      { componentId: 'auxFeedwaterHeader', direction: 'downstream', links: 4, next: ['auxFeedwaterValveA', 'auxFeedwaterValveB', 'auxFeedwaterValveC', 'auxFeedwaterValveD'] },
    ])
    // The production turn read the complete compiled graph (812,258 bytes) for this answer.
    expect(bytes(result)).toBeLessThan(2_000)
    expect(JSON.stringify(result)).not.toContain('parameters')
    expect(JSON.stringify(result)).not.toContain('variables')
  })

  test('follows flow downstream to say which loops a header feeds', () => {
    const result = connections({ componentIds: ['auxFeedwaterHeader'], direction: 'downstream', reach: 2 })
    expect(result.links.every(link => link.from === 'auxFeedwaterHeader' || link.from.startsWith('auxFeedwaterValve'))).toBe(true)
    expect(result.links.filter(link => link.toPort === 'feedwaterInlet').map(link => [link.to, link.loop])).toEqual([['sgA', 'A'], ['sgB', 'B'], ['sgC', 'C'], ['sgD', 'D']])
    expect(result.continues.every(stop => stop.direction === 'downstream' && stop.componentId.startsWith('sg'))).toBe(true)
    expect(connections({ componentIds: ['auxFeedwaterHeader'], direction: 'upstream' }).links.every(link => link.to === 'auxFeedwaterHeader')).toBe(true)
  })

  test('one more step of reach adds exactly the links continues announced', () => {
    for (const componentIds of [['auxFeedwaterPumpMotor'], ['sgB'], ['pressurizer', 'safetyBusB']]) {
      for (let reach = 1; reach <= 4; reach += 1) {
        const near = connections({ componentIds, reach, limit: 500 })
        const far = connections({ componentIds, reach: reach + 1, limit: 500 })
        const added = linkIds(far).filter(id => !linkIds(near).includes(id))
        expect(linkIds(far)).toEqual(expect.arrayContaining(linkIds(near)))
        expect(added.length).toBe(near.continues.reduce((sum, stop) => sum + stop.links, 0))
      }
    }
  })

  test('services narrow a scoped read to the links of that service', () => {
    const result = connections({ componentIds: ['auxFeedwaterPumpMotor'], services: ['electricalPower'], reach: 2 })
    expect(result.links.length).toBeGreaterThan(0)
    expect(result.links.every(link => link.kind === 'electricalPower')).toBe(true)
    expect(result.links.map(link => link.to)).toContain('auxFeedwaterPumpMotor')
  })

  test('without components, pages through every link of the Plant exactly once', () => {
    const first = connections({})
    expect(first).toMatchObject({ total: plant.graph.links.length, offset: 0, returned: 100, hasMore: true, continues: [] })
    const second = connections({ offset: first.offset + first.returned })
    expect(second).toMatchObject({ returned: plant.graph.links.length - 100, hasMore: false })
    expect([...linkIds(first), ...linkIds(second)]).toEqual(plant.graph.links.map(link => String(link.id)))
    const ends = new Set(second.links.flatMap(link => [link.from, link.to]))
    expect(second.components.map(component => component.id).sort()).toEqual([...ends].sort())
    const afw = connections({ services: ['auxFeedwater'] })
    expect(afw.total).toBe(plant.graph.linksByService.get('auxFeedwater' as never)!.length)
    expect(afw.links.every(link => link.service === 'auxFeedwater')).toBe(true)
  })

  test('the complete compiled graph is returned only when mode full asks for it', () => {
    const full = read({ mode: 'full' }) as { mode: string; graph: { components: unknown[]; links: unknown[]; variables: unknown[] } }
    expect(full.mode).toBe('full')
    expect(full.graph.components).toHaveLength(plant.graph.components.length)
    expect(full.graph.variables).toHaveLength(plant.graph.variables.length)
    // The input a production turn sent, { plantId }, no longer returns it.
    const whole = connections({ limit: 500 })
    expect(bytes(whole)).toBeLessThan(bytes(full) / 20)
  })

  test('rejects with every issue and how to fix it', () => {
    const unknown = rejection({ componentIds: ['afwPumpA'] })
    expect(unknown.code).toBe('capability_target_not_found')
    expect(unknown.message).toContain('no component afwPumpA; did you mean auxFeedwaterPumpMotor')
    expect(unknown.message).toContain('world.process-plant.components.search')

    const issues = rejection({ services: ['afw'], reach: 2, direction: 'upstream' })
    expect(issues.code).toBe('capability_input_rejected')
    expect(issues.message).toContain('3 issues')
    expect(issues.message).toContain('no service or link kind afw; it has auxFeedwater,')
    expect(issues.message).toContain('reach applies only with componentIds')
    expect(issues.message).toContain('direction applies only with componentIds')

    expect(() => read({ mode: 'full', componentIds: ['auxFeedwaterPumpMotor'] })).toThrow()
    expect(() => read({ componentIds: [] })).toThrow()
    expect(() => read({ componentIds: ['auxFeedwaterPumpMotor'], reach: 0 })).toThrow()
  })
})
