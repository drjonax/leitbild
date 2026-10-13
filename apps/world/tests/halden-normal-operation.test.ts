import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat } from '../src/core/model/index.ts'
import { atmosphereAt } from '../src/packs/weather/influence.ts'
import { weatherAreaSchema, weatherPackConfigSchema } from '../src/packs/weather/model.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'

const scenario = (id: string) => builtinScenarioDefinitions.find(source => source.id === id)!
const quiet = scenario('halden-normal-operation')
const offsite = scenario('halden-offsite-power-restoration')
const pack = (id: string, source = quiet) => source.packs.find(item => item.id === id)!

// The walkthrough Scenario: the loss-of-offsite-power demo's setup with
// nothing scheduled, plus a rain shower that drifts over the units.
describe('Halden: normal operation', () => {
  test('keeps the offsite demo\'s units, grid, connections, start time and view', () => {
    expect(quiet.title).toBe('Halden: normal operation')
    for (const id of ['process-plant', 'electric-grid']) expect(pack(id)).toEqual(pack(id, offsite))
    expect(quiet.connections).toEqual(offsite.connections)
    expect(quiet.world).toEqual(offsite.world)
    expect(quiet.view).toEqual(offsite.view)
  })

  test('schedules nothing but a dismissible brief', () => {
    const actions = quiet.timeline?.cues.flatMap(cue => cue.actions) ?? []
    expect(actions.map(action => action.type)).toEqual(['show_guidance'])
    expect(actions.every(action => action.type !== 'show_guidance' || action.guidance.dismissible)).toBe(true)
  })

  test('moves a rain shower over the four units and on past them', () => {
    const weather = pack('weather')
    const baseline = weatherPackConfigSchema.parse(weather.config).atmosphere
    const startsAt = quiet.world.startsAt
    const area = weatherAreaSchema.parse({ ...weather.items.find(item => item.type === 'weather_area'), pack: 'weather' })
    const entries = [{ objectId: area.id, label: area.label, area, startsAt }]
    const units = pack('process-plant').items.map(item => item.location as [number, number])
    expect(units).toHaveLength(4)
    const rainAt = (seconds: number): number[] => units.map(([lon, lat]) => atmosphereAt(
      baseline, entries, geoPointFromLonLat(lon, lat), new Date(Date.parse(startsAt) + seconds * 1000).toISOString(),
    ).atmosphere.precipitation.intensityMmPerHour)
    expect(rainAt(0).every(rain => rain === 0)).toBe(true)
    expect(rainAt(900).every(rain => rain > 5)).toBe(true)
    expect(rainAt(2700).every(rain => rain === 0)).toBe(true)
  })
})
