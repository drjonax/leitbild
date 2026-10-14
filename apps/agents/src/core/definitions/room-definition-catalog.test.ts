import { describe, expect, test } from 'bun:test'
import { BUNDLED_ROOM_DEFINITIONS, getBundledRoomDefinition } from './room-definition-catalog.ts'

describe('bundled Room Definitions', () => {
  test('ids are unique and every Prompt Deck action has the content it needs', () => {
    const ids = BUNDLED_ROOM_DEFINITIONS.map(definition => definition.id)
    expect(new Set(ids).size).toBe(ids.length)

    for (const definition of BUNDLED_ROOM_DEFINITIONS) {
      expect(definition.deck.entries.length).toBeGreaterThan(0)
      for (const entry of definition.deck.entries) {
        if (entry.action.kind === 'start-script') expect(entry.action.scriptName.length).toBeGreaterThan(0)
        else expect(entry.action.content.length).toBeGreaterThan(0)
      }
    }
  })

  test('ships one Assistant definition whose Room Scope is selected at creation', () => {
    expect(BUNDLED_ROOM_DEFINITIONS.map(definition => definition.id)).toEqual(['leitbild-assistant'])
    expect(getBundledRoomDefinition('leitbild-assistant')?.assistance).toBe(true)
  })

  test('Assistant configuration carries no duplicated access policy', () => {
    const definition = getBundledRoomDefinition('leitbild-assistant')!
    const assistant = definition.room.agents[0]!
    expect(assistant.includeContext).toEqual({ participants: true, activity: false, knownAgents: false })
    expect(assistant.tools).toEqual(['product_search', 'product_read', 'place_resolve', 'wiki_lookup'])
    // A cost guard: past 40 tool rounds in one turn the Assistant asks the person whether to continue.
    // A whole E-0 run takes about 25, so it finishes without a check-in.
    expect(assistant.maxToolIterations).toBe(40)
    expect(assistant).not.toHaveProperty('toolGrants')
    expect(definition.room).not.toHaveProperty('scope')
  })
})
