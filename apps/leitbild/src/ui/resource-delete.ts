// Deleting Resources from the Workspace page and the Run view: simulations
// and conversations, each through the delete Capability its own descriptor
// names (`deleteCapabilityId`, checked by cardCapability), invoked like any
// Capability. The Host never names a Module's delete itself. ConfirmDialog
// shows the words and runs the deletes.

import type { ModuleCapabilityDescriptor, ModuleResourceDescriptor } from '@leitbild/contracts'
import { CONVERSATION_NOUN, ITEM_NOUN, SIMULATION_NOUN, type DeleteItem, type Noun, type RemoveOutcome } from './bulk-delete.ts'
import { cardCapability } from './card-actions.ts'
import { ageText, readHostJson } from './launch-workspace.ts'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const RUN = 'world.simulation-run'
const ROOM = 'agents.room'

export interface ResourceDeleteItem extends DeleteItem {
  readonly resource: ModuleResourceDescriptor
  readonly capability: ModuleCapabilityDescriptor
}

/**
 * A Resource with a usable delete Capability, or null when it offers none.
 * Beside a Run's name go its status and when it started ("Running · started
 * 5 min ago"), so Runs of one scenario, which share a name, can be told apart.
 */
export const resourceDeleteItem = (
  resource: ModuleResourceDescriptor, capabilities: ReadonlyArray<ModuleCapabilityDescriptor>, now: Date = new Date(),
): ResourceDeleteItem | null => {
  const capability = cardCapability(resource, 'delete', capabilities)
  if (!capability) return null
  const summary = (key: string) => resource.summary.find(item => item.key === key)
  const started = summary('started-at')
  const note = resource.ref.type !== RUN ? [] : [
    ...(summary('status') === undefined ? [] : [String(summary('status')!.value)]),
    ...(started?.kind === 'timestamp' ? [`started ${ageText(new Date(started.value), now)}`] : []),
  ]
  return {
    key: `${resource.ref.type}:${resource.ref.id}`,
    label: resource.title,
    ...(note.length === 0 ? {} : { note: note.join(' · ') }),
    resource,
    capability,
  }
}

export const resourceNoun = (items: ReadonlyArray<ResourceDeleteItem>): Noun =>
  items.every(item => item.resource.ref.type === RUN) ? SIMULATION_NOUN
    : items.every(item => item.resource.ref.type === ROOM) ? CONVERSATION_NOUN
      : ITEM_NOUN

export const resourceDeleteBody = (items: ReadonlyArray<ResourceDeleteItem>): string => {
  const one = items.length === 1
  const noun = resourceNoun(items)
  if (noun === SIMULATION_NOUN) return `Deleting stops ${one ? 'it' : 'them'} and removes ${one ? 'it' : 'them'} for everyone. This cannot be undone.`
  if (noun === CONVERSATION_NOUN) return `${one ? 'Its' : 'Their'} messages are deleted for everyone. This cannot be undone.`
  return 'They are deleted for everyone. This cannot be undone.'
}

/**
 * Invokes each item's own delete Capability. Only Capabilities the catalogue
 * published for that Resource are invoked, so a 404 means the Resource (or
 * its Workspace) is already gone. Any other refusal is thrown with its Host
 * code; the bulk runner turns it into plain text.
 */
export const createResourceRemover = (workspaceId: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)) =>
  async (item: ResourceDeleteItem): Promise<RemoveOutcome> => {
    const response = await fetchImpl(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities/${encodeURIComponent(item.capability.id)}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: item.resource.ref, input: {}, actor: { kind: 'human' } }),
      },
    )
    if (response.status === 404) return { kind: 'gone' }
    await readHostJson(response)
    return { kind: 'deleted' }
  }
