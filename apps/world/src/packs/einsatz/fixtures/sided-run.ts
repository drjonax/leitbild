import { createDirectRoutingAdapter } from '../../../routing/direct-adapter.ts'
import type { PackRuntimeAdapter } from '../../../simulation/protocol.ts'
import { einsatzCommandIds } from '../capabilities.ts'
import { einsatzPackId } from '../ids.ts'
import { createEinsatzPackRuntimeAdapter } from '../runtime/adapter.ts'
import { low, templates, types } from './engine-harness.ts'
import fixture from './engine.config.json'

/**
 * Test-only: the Einsatz part of a sided Run for the wire oracle. Each of two
 * sides holds a carrier of the one tag both sides' roles command, the second
 * side's nearer the first side's task, and a task of its own; a public site
 * serves both, and only a role seeing the truth opens and closes it. A cue a
 * minute in sends the second side's carrier to the first side's task, which
 * the same-side invariant refuses. The configuration also declares a scout
 * and a shooter, which no item places: a step creates them to fight, so
 * tracks, damage and step-loss tasks appear only once it does. Every id and
 * label carries the nonce after a name no other name of the Run starts or
 * ends with. Production code never imports this file.
 */

/** A side of the Run and the operator role that plays it. */
export interface SidedPlayer {
  readonly side: string
  readonly role: string
}

export const einsatzSidedNames = (nonce: string) => {
  const object = (kind: string, name: string) => ({ id: `${kind}:${name}-${nonce}`, label: `${name} ${nonce}` })
  return {
    firstCarrier: object('unit', 'ecarfirst'),
    secondCarrier: object('unit', 'ecarsecond'),
    firstTask: object('task', 'ecallfirst'),
    secondTask: object('task', 'ecallsecond'),
    site: object('site', 'epost'),
    scout: object('unit', 'escout'),
    nearGun: object('unit', 'egunnear'),
    farGun: object('unit', 'egunfar'),
  }
}

const crewTag = 'crew'
const scoutTag = 'scout'

/**
 * A scout that sees far and is seen little, and loses a step to a step-loss
 * task, and a shooter that fires on scouts at will: both commanded by their
 * side's role, like its carrier.
 */
const combatTypes = [
  {
    id: 'escout-type', label: 'Scout', icon: 'binoculars', tags: [crewTag, scoutTag],
    components: { mobility: { mode: 'road', mobilizeS: 30 }, sensor: { detectM: 3000, identifyM: 2000 }, signature: { factor: 0.6 }, durability: { stepFireS: 20 } },
    standingOrders: { withdraw: { whenDamaged: true }, onStepLost: { createTask: templates.load, perStep: { [low]: 1 } } },
  },
  {
    id: 'egun-type', label: 'Shooter', icon: 'shield', tags: [crewTag],
    components: { mobility: { mode: 'road', mobilizeS: 30 }, sensor: { detectM: 1500, identifyM: 1000 }, signature: { factor: 1 }, effector: { rangeM: 2000, targets: [scoutTag] }, durability: { stepFireS: 90 } },
    standingOrders: { roe: 'free' },
  },
] as const

/** The Einsatz Pack Selection: each side's role commands its own crew; each side is hostile to the other. */
export const einsatzSidedSelection = (nonce: string, first: SidedPlayer, second: SidedPlayer) => {
  const names = einsatzSidedNames(nonce)
  const config = {
    ...fixture,
    unitTypes: [...fixture.unitTypes.map(type => type.id === types.roadCarrier ? { ...type, tags: [crewTag] } : type), ...combatTypes],
    hostility: { [first.side]: [second.side], [second.side]: [first.side] },
    authority: [
      { roleId: first.role, units: { tags: [crewTag] }, taskTemplates: [templates.load] },
      { roleId: second.role, units: { tags: [crewTag] }, taskTemplates: [templates.load] },
    ],
  }
  const item = (name: { readonly id: string; readonly label: string }, fields: Record<string, unknown>) => ({ id: name.id, label: name.label, ...fields })
  return {
    id: einsatzPackId,
    config,
    items: [
      item(names.firstCarrier, { type: 'unit', unitType: types.roadCarrier, side: first.side, position: [10.70, 59.91] }),
      item(names.secondCarrier, { type: 'unit', unitType: types.roadCarrier, side: second.side, position: [10.719, 59.919] }),
      item(names.firstTask, { type: 'task', template: templates.load, side: first.side, position: [10.72, 59.92], loads: { [low]: 1 } }),
      item(names.secondTask, { type: 'task', template: templates.load, side: second.side, position: [10.80, 59.94], loads: { [low]: 1 } }),
      item(names.site, { type: 'unit', unitType: types.publicSite, position: [10.75, 59.935] }),
    ],
  }
}

/** A cue a minute in that sends the second side's carrier to the first side's task. */
export const einsatzCrossSideCue = (nonce: string) => {
  const names = einsatzSidedNames(nonce)
  return {
    id: 'einsatz-cross-side',
    at: { kind: 'after_scenario_start' as const, seconds: 60 },
    actions: [{ type: 'invoke_capability' as const, capabilityId: einsatzCommandIds.send, input: { units: [names.secondCarrier.id], to: { taskId: names.firstTask.id } } }],
  }
}

/**
 * The `unit.create` inputs of a fight: the first side's scout, the second
 * side's shooter 200 m away, which identifies and fires on it, and a second
 * shooter 2.5 km away, which the scout holds only as a contact.
 */
export const einsatzSidedCombat = (nonce: string, first: SidedPlayer, second: SidedPlayer) => {
  const names = einsatzSidedNames(nonce)
  const at = (east: number) => ({ type: 'Point' as const, coordinates: [10.60 + east, 59.85] as [number, number] })
  return {
    scout: { type: combatTypes[0].id, side: first.side, at: at(0), label: names.scout.label },
    nearGun: { type: combatTypes[1].id, side: second.side, at: at(0.00358), label: names.nearGun.label },
    farGun: { type: combatTypes[1].id, side: second.side, at: at(0.0447), label: names.farGun.label },
  }
}

export const createEinsatzSidedRuntimeAdapter = (): PackRuntimeAdapter => createEinsatzPackRuntimeAdapter({ routing: createDirectRoutingAdapter() })
