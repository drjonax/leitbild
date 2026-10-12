import { describe, expect, test } from 'bun:test'
import { einsatzCapabilities, einsatzCommandIds as ids } from './capabilities.ts'
import { borderDefinitions, roleCommanding, runOrder } from './fixtures/border-harness.ts'
import { advanceTo, at, blue, place, red, run, stateWith, trackOf, types, unit } from './fixtures/combat-harness.ts'
import type { EngineState } from './engine/model.ts'
import { refusalCode } from './refusal.ts'
import { openViewer, type EinsatzViewer } from './viewer.ts'

const definition = borderDefinitions.scripted
const blueGunner = roleCommanding(definition, blue, types.blueGun)
const blueWatcher = roleCommanding(definition, blue, types.watcher)
const redGunner = roleCommanding(definition, red, types.redGun)

const order = async (state: EngineState, viewer: EinsatzViewer, capabilityId: string, input: unknown) => runOrder(state, { capabilityId, input }, viewer, viewer.roles[0]?.id ?? 'Controller', definition.roles ?? [])
const codeOf = async (state: EngineState, viewer: EinsatzViewer, capabilityId: string, input: unknown): Promise<string> => {
  const result = await order(state, viewer, capabilityId, input)
  if (result.reason === undefined) throw new Error(`Expected a refusal of ${capabilityId}`)
  return refusalCode(result.reason)
}

describe('Einsatz engagement commands', () => {
  test('rules of engagement and a priority target are schedulable commands', () => {
    const commands = einsatzCapabilities.filter(capability => capability.id === ids.setRoe || capability.id === ids.engage)
    expect(commands.map(capability => [capability.id, capability.kind, capability.schedulable])).toEqual([[ids.setRoe, 'command', true], [ids.engage, 'command', true]])
  })

  test('a side engages only identified hostile tracks of its own picture that its unit can fire on', async () => {
    let state = await stateWith([
      place('s1', types.blueScout, blue, at(0)),
      place('b1', types.blueGun, blue, at(0, 100)),
      place('r1', types.redGun, red, at(1_500)),
      place('rw', types.watcher, red, at(500)),
      place('far', types.redGun, red, at(2_800)),
      place('rs', types.redScout, red, at(-1_800)),
      place('dead', types.redScout, red, at(300, 300)),
    ])
    state = (await advanceTo(state, 4)).state
    const identified = trackOf(state, blue, 'r1')!
    const contact = trackOf(state, blue, 'far')!
    const untargetable = trackOf(state, blue, 'rw')!
    const redTrack = trackOf(state, red, 's1')!
    expect(contact.tier).toBe('contact')
    expect(untargetable.tier).toBe('identified')

    const engaged = await order(state, blueGunner, ids.engage, { unitId: 'b1', trackId: identified.id })
    expect(engaged.reason).toBeUndefined()
    expect(unit(engaged.state, 'b1')).toMatchObject({ engage: identified.id, lastAction: { verb: 'engage', target: identified.id, by: blueGunner.roles[0]!.id } })
    // Another side's track is outside the picture for a side role, and a cross-side reference for the Controller.
    expect(await codeOf(state, blueGunner, ids.engage, { unitId: 'b1', trackId: redTrack.id })).toBe('not_in_picture')
    expect(await codeOf(state, openViewer, ids.engage, { unitId: 'b1', trackId: redTrack.id })).toBe('cross_side_reference')
    expect(await codeOf(state, redGunner, ids.engage, { unitId: 'b1', trackId: identified.id })).toBe('not_in_picture')
    expect(await codeOf(state, blueGunner, ids.engage, { unitId: 'b1', trackId: contact.id })).toBe('track_not_engageable')
    expect((await order(state, blueGunner, ids.engage, { unitId: 'b1', trackId: untargetable.id })).reason).toBe(`track_not_engageable: B1 cannot engage ${untargetable.label} (${untargetable.identity!.typeLabel})`)
    expect(await codeOf(state, blueGunner, ids.engage, { unitId: 's1', trackId: identified.id })).toBe('no_effector')
    expect(await codeOf(state, blueGunner, ids.engage, { unitId: 'b1', trackId: 'track:nowhere:1' })).toBe('not_in_picture')
    // A destroyed track cannot be engaged.
    let fought = await run(state, { kind: 'set-roe', unitId: 'b1', roe: 'free' })
    fought = await run(fought, { kind: 'engage', unitId: 'b1', trackId: trackOf(fought, blue, 'dead')!.id })
    fought = (await advanceTo(fought, 60)).state
    expect(trackOf(fought, blue, 'dead')!.tier).toBe('destroyed')
    expect(unit(fought, 'b1').engage).toBeUndefined()
    expect(await codeOf(fought, blueGunner, ids.engage, { unitId: 'b1', trackId: trackOf(fought, blue, 'dead')!.id })).toBe('track_not_engageable')
  })

  test('rules of engagement belong to the unit\'s commander and to units that can fire', async () => {
    const state = await stateWith([place('s1', types.blueScout, blue, at(0)), place('b1', types.blueGun, blue, at(0, 100))])
    const set = await order(state, blueGunner, ids.setRoe, { unitId: 'b1', roe: 'hold' })
    expect(set.reason).toBeUndefined()
    expect(unit(set.state, 'b1')).toMatchObject({ roe: 'hold', lastAction: { verb: 'set', cause: 'weapons hold' } })
    expect((await order(set.state, blueGunner, ids.setRoe, { unitId: 'b1', roe: 'hold' })).reason).toBeUndefined()
    expect(await codeOf(state, blueWatcher, ids.setRoe, { unitId: 'b1', roe: 'free' })).toBe('unit_not_authorized')
    expect(await codeOf(state, redGunner, ids.setRoe, { unitId: 'b1', roe: 'free' })).toBe('not_in_picture')
    expect(await codeOf(state, blueGunner, ids.setRoe, { unitId: 's1', roe: 'free' })).toBe('no_effector')
    expect(await codeOf(state, blueGunner, ids.setRoe, { unitId: 'b1', roe: 'later' })).toBe('invalid_input')
  })
})
