// Deleting what a Workspace's catalogue lists, from the Workspace page and
// the Run view: simulations and conversations (Resources) and scenarios
// (Definitions), each through the delete Capability its own descriptor names
// (`deleteCapabilityId`, checked by cardCapability), invoked like any
// Capability. ConfirmDialog shows the words and runs the deletes.

import type { ModuleCapabilityDescriptor, ModuleDefinitionDescriptor, ModuleResourceDescriptor } from '@leitbild/contracts'
import {
  CONVERSATION_NOUN, isAlreadyGone, ITEM_NOUN, SCENARIO_NOUN, SIMULATION_NOUN, type DeleteItem, type Noun, type RemoveOutcome,
} from './bulk-delete.ts'
import { cardCapability } from './card-actions.ts'
import { ageText, readHostJson } from './launch-workspace.ts'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
export type CatalogSubject = ModuleResourceDescriptor | ModuleDefinitionDescriptor

const RUN = 'world.simulation-run'
const ROOM = 'agents.room'

/**
 * The code each Module's delete answers when the thing itself no longer
 * exists, by type, as their delete handlers return it. Only that 404 is
 * "someone deleted it first"; a 404 for an unknown Capability, route or
 * Module is a failure, and a type not listed here has no "already gone".
 */
const GONE_CODES: Readonly<Record<string, string>> = {
  [RUN]: 'simulation_run_not_found',
  [ROOM]: 'room_not_found',
  'world.scenario': 'scenario_not_found',
  'agents.room-definition': 'room_definition_not_found',
}

export interface CatalogDeleteItem extends DeleteItem {
  readonly subject: CatalogSubject
  readonly capability: ModuleCapabilityDescriptor
}

const isDefinition = (subject: CatalogSubject): subject is ModuleDefinitionDescriptor => 'currentRevisionId' in subject

/**
 * What can be deleted, through the delete Capability the subject's own
 * descriptor names, or null when it offers none. Beside a Run's name go its
 * status and when it started ("Running · started 5 min ago"), so Runs of one
 * scenario, which share a name, can be told apart.
 */
export const catalogDeleteItem = (
  subject: CatalogSubject, capabilities: ReadonlyArray<ModuleCapabilityDescriptor>, now: Date = new Date(),
): CatalogDeleteItem | null => {
  const capability = cardCapability(subject, 'delete', capabilities)
  if (!capability) return null
  const summary = (key: string) => isDefinition(subject) ? undefined : subject.summary.find(item => item.key === key)
  const status = summary('status')
  const started = summary('started-at')
  const note = subject.ref.type !== RUN ? [] : [
    ...(status === undefined ? [] : [String(status.value)]),
    ...(started?.kind === 'timestamp' ? [`started ${ageText(new Date(started.value), now)}`] : []),
  ]
  return {
    key: `${subject.ref.type}:${subject.ref.id}`,
    label: subject.title,
    ...(note.length === 0 ? {} : { note: note.join(' · ') }),
    subject,
    capability,
  }
}

const allOf = (items: ReadonlyArray<CatalogDeleteItem>, type: string): boolean =>
  items.length > 0 && items.every(item => item.subject.ref.type === type)

/** Runs are simulations and rooms conversations; every Definition is listed under "More scenarios", so it is a scenario. */
export const catalogNoun = (items: ReadonlyArray<CatalogDeleteItem>): Noun =>
  allOf(items, RUN) ? SIMULATION_NOUN : allOf(items, ROOM) ? CONVERSATION_NOUN
    : items.length > 0 && items.every(item => isDefinition(item.subject)) ? SCENARIO_NOUN : ITEM_NOUN

export const catalogDeleteBody = (items: ReadonlyArray<CatalogDeleteItem>): string => {
  const one = items.length === 1
  const noun = catalogNoun(items)
  if (noun === SIMULATION_NOUN) return `Deleting stops ${one ? 'it' : 'them'} and removes ${one ? 'it' : 'them'} for everyone. This cannot be undone.`
  if (noun === CONVERSATION_NOUN) return `${one ? 'Its' : 'Their'} messages are deleted for everyone. This cannot be undone.`
  if (noun === SCENARIO_NOUN) return `${one ? 'It is' : 'They are'} removed from this Workspace for everyone; what was already started from ${one ? 'it' : 'them'} keeps running. This cannot be undone.`
  return `${one ? 'It is' : 'They are'} deleted for everyone. This cannot be undone.`
}

/**
 * Invokes each item's own delete Capability: a Resource by its reference, a
 * Definition by its current revision. Its Module's "does not exist" answer
 * is "already gone"; any other refusal is thrown with its Host code, and the
 * bulk runner turns it into plain text.
 */
export const createCatalogRemover = (workspaceId: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)) =>
  async (item: CatalogDeleteItem): Promise<RemoveOutcome> => {
    const { subject } = item
    const response = await fetchImpl(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities/${encodeURIComponent(item.capability.id)}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(isDefinition(subject) ? { definition: { ...subject.ref, revisionId: subject.currentRevisionId } } : { resource: subject.ref }),
          input: {}, actor: { kind: 'human' },
        }),
      },
    )
    try {
      await readHostJson(response)
    } catch (error) {
      const goneCode = GONE_CODES[subject.ref.type]
      if (goneCode !== undefined && isAlreadyGone(error, goneCode)) return { kind: 'gone' }
      throw error
    }
    return { kind: 'deleted' }
  }
