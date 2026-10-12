import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createSkillStore, loadSkills } from '../skills/loader.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import assistantRoom from './leitbild-assistant.room.json'

// Skills are injected in full into every prompt of the agents that select
// them, so their size is an attention budget, not just a storage detail.
const OPERATOR_DISPLAYS_BODY_MAX_CHARS = 4_800
// The assistance skill's body as v0.5.0 shipped it: a new rule tightens
// existing wording rather than growing every prompt.
const LEITBILD_ASSISTANCE_BODY_MAX_CHARS = 13_208
const DESCRIPTION_MAX_CHARS = 1_024

describe('Leitbild Assistant skills', () => {
  test('every selected skill exists and the display and assistance skills stay within their prompt budgets', async () => {
    const store = createSkillStore()
    await loadSkills(join(import.meta.dir, '..', '..', 'skills'), store, createToolRegistry())
    for (const name of assistantRoom.room.agents[0]!.skills) expect(store.get(name)).toBeDefined()
    const displays = store.get('operator-displays')!
    expect(displays.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS)
    expect(displays.body.length).toBeLessThanOrEqual(OPERATOR_DISPLAYS_BODY_MAX_CHARS)
    expect(displays.body).toContain('world.process-plant.display.compose')
    expect(displays.body).toContain('```leitbild-view\nview <viewRef>\n```')
    // Plant equipment is operated by proposing it for a person's decision (plan C1 §4.4).
    const assistance = store.get('leitbild-assistance')!
    expect(assistance.body.length).toBeLessThanOrEqual(LEITBILD_ASSISTANCE_BODY_MAX_CHARS)
    expect(assistance.body).toContain('world.process-plant.control.propose')
    expect(assistance.body).toContain('never say it was done')
    // Run-26 SME: E-0 concludes its SI decision, and an SI line-up gets a verdict.
    expect(assistance.body).toContain('conclude "go to ES-0.1"')
    expect(assistance.body).toContain('readiness verdict')
    // Run-26c SME: a proposal states its consequence and basis, challenges a premise the display contradicts,
    // and asks why before stopping, shutting or isolating at power; ES-0.1 throttles on Tavg below no-load.
    expect(assistance.body).toContain('state the consequence the listing or propose result gives')
    expect(assistance.body).toContain('challenge any premise of the request the display contradicts')
    expect(assistance.body).toContain('ask their reason before proposing anything that stops, shuts or isolates at power')
    expect(assistance.body).toContain('total feed against the heat-sink tree\'s minimum')
    expect(assistance.body).toContain('Tavg falls below its no-load value')
    // A rate the display marks "reversing" is turning, not going one way (run-26c rcp-trip).
    expect(assistance.body).toContain('one marked "reversing" is turning')
  })
})
