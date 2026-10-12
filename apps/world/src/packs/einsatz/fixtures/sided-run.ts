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
 * the same-side invariant refuses. Every id and label carries the nonce after
 * a name no other name of the Run starts or ends with. Production code never
 * imports this file.
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
  }
}

const crewTag = 'crew'

/** The Einsatz Pack Selection: each side's role commands its own crew; each side is hostile to the other. */
export const einsatzSidedSelection = (nonce: string, first: SidedPlayer, second: SidedPlayer) => {
  const names = einsatzSidedNames(nonce)
  const config = {
    ...fixture,
    unitTypes: fixture.unitTypes.map(type => type.id === types.roadCarrier ? { ...type, tags: [crewTag] } : type),
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

export const createEinsatzSidedRuntimeAdapter = (): PackRuntimeAdapter => createEinsatzPackRuntimeAdapter({ routing: createDirectRoutingAdapter() })
