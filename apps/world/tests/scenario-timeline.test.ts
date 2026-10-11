import { describe,expect,test } from 'bun:test'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import { compiledScenarioSchema } from '../src/core/model/index.ts'
import { dueScenarioTimelineCues } from '../src/core/simulation-runs/timeline-runner.ts'
import { responseScenario,scenarios } from './fixtures/scenarios.ts'

describe('scenario timeline model', () => {
  test('validates timed scenario cues and declarative actions', () => {
    const parsed = compiledScenarioSchema.parse(responseScenario)

    expect(parsed.packs).toEqual(['fixture', 'weather'])
    expect(parsed.initialObjects.some(object => object.id === 'task:charlie')).toBe(true)
    expect(parsed.timeline?.cues.map(cue => cue.id)).toContain('task-delta-created')
    expect(parsed.timeline?.cues.some(cue =>
      cue.actions.some(action => action.type === 'show_guidance'))).toBe(true)
    expect(parsed.timeline?.cues.some(cue =>
      cue.actions.some(action => action.type === 'invoke_capability' && action.capabilityId === 'world.fixture.create-item'))).toBe(true)
    expect(parsed.timeline?.cues.some(cue =>
      cue.actions.some(action => action.type === 'invoke_capability' && action.capabilityId === 'world.object.delete'))).toBe(true)
  })

  test('drone scenario invokes discoverable startup capabilities through the scenario runner', () => {
    const droneScenario = scenarios.find(scenario => scenario.id === 'test-drone')
    if (!droneScenario) throw new Error('missing drone scenario')
    const parsed = compiledScenarioSchema.parse(droneScenario)
    const commandActions = parsed.timeline?.cues.flatMap(cue =>
      cue.actions.filter(action => action.type === 'invoke_capability')) ?? []

    expect(commandActions.map(action => action.capabilityId)).toEqual([
      'world.drone.arm',
      'world.drone.takeoff',
      'world.drone.navigate',
    ])
  })

  test('rejects duplicate scenario timeline cue ids', () => {
    expect(() => compiledScenarioSchema.parse({
      ...responseScenario,
      timeline: {
        cues: [
          responseScenario.timeline?.cues[0],
          responseScenario.timeline?.cues[0],
        ],
      },
    })).toThrow('duplicate scenario timeline cue id')
  })

  test('computes due timeline cues from scenario start and fired cue ids', () => {
    const timeline = responseScenario.timeline
    if (!timeline) throw new Error('scenario missing timeline')
    const startedAt = '2026-01-01T09:00:00.000Z' as IsoTimestamp
    const dueAtThreeMinutes = dueScenarioTimelineCues({
      timeline,
      state: {
        scenarioId: responseScenario.id,
        agentRestrictions: { operationIds: [], objects: [], revision: 0 },
        highlightedObjectIds: [],
        timeline: {
          startedAt,
          firedCueIds: ['scenario-started'],
        },
      },
      nowMs: Date.parse(startedAt) + 180_000,
    })

    expect(dueAtThreeMinutes.map(cue => cue.id)).toEqual([
      'task-bravo-raised',
      'task-delta-created',
      'task-delta-raised',
    ])
  })
})
