import { describe, expect, test } from 'bun:test'
import { alertStateSchema } from '../src/core/model/alerts.ts'
import { geoPointFromLonLat, nowIso, type IsoTimestamp, type OperationalObject, type SimulationRunId } from '../src/core/model/index.ts'
import { weatherAdvisories } from '../src/packs/weather/conditions.ts'
import { weatherItemSchema, weatherPackConfigSchema, weatherPackDataSchema, type WeatherState } from '../src/packs/weather/model.ts'
import { createWeatherObject } from '../src/packs/weather/scenario.ts'
import { createLocalWeatherPackRuntimeAdapter } from '../src/packs/weather/sim/adapter.ts'
import { testRuntimeConnectionConfig } from './helpers.ts'

// R42(a), R43: a probe or area raises one advisory alert per adverse or hazard ladder condition that holds, with
// observable and threshold facets and a priority agreeing with its severity; it is gone when the condition clears.
const at = '2026-01-01T00:00:00.000Z' as IsoTimestamp
const later = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString() as IsoTimestamp
const point = geoPointFromLonLat(10.7522, 59.9139).coordinates
const settings = weatherPackConfigSchema.parse({})
const probe = createWeatherObject(weatherItemSchema.parse({ pack: 'weather', type: 'weather_probe', id: 'weather-probe:oslo', label: 'Oslo probe', point }), at, settings, at)
const state = weatherPackDataSchema.parse(probe.packData).sample.state
const withState = (patch: { readonly visibilityM?: number; readonly ice?: number; readonly wetness?: number }): WeatherState => ({
  ...state,
  atmosphere: { ...state.atmosphere, ...(patch.visibilityM === undefined ? {} : { visibilityM: patch.visibilityM }) },
  surface: { ...state.surface, ...(patch.ice === undefined ? {} : { ice: patch.ice }), ...(patch.wetness === undefined ? {} : { wetness: patch.wetness }) },
})

describe('weather advisories in the core alert slot', () => {
  test('one advisory per adverse or hazard condition, with facets, a stable message and priority agreeing with severity', () => {
    const alerts = weatherAdvisories(probe, withState({ visibilityM: 500, ice: 0.3 }), at).map(alert => alertStateSchema.parse(alert))
    expect(alerts.map(alert => [alert.id, alert.priority, alert.severity, alert.threshold, alert.observable, alert.message])).toEqual([
      ['weather-probe:oslo:advisory:hazard-visibilityM', 'warning', 'warning', 'hazard-visibilityM', 'weather-probe:oslo#visibilityM', 'Visibility low (hazard): Oslo probe'],
      ['weather-probe:oslo:advisory:adverse-ice', 'caution', 'warning', 'adverse-ice', 'weather-probe:oslo#ice', 'Ice high (adverse): Oslo probe'],
      ['weather-probe:oslo:advisory:adverse-visibilityM', 'caution', 'warning', 'adverse-visibilityM', 'weather-probe:oslo#visibilityM', 'Visibility low (adverse): Oslo probe'],
    ])
    expect(alerts.every(alert => alert.advisory === true && alert.acknowledged === false && alert.clock === 'simulation' && alert.raisedAt === at && alert.returned === undefined)).toBe(true)
    // Notice-level wetness is routine weather and raises nothing.
    expect(weatherAdvisories(probe, withState({ wetness: 0.9 }), at)).toEqual([])
  })

  test('the JSON stays identical over 100 steady steps (the first raise time kept) and the advisory is gone when the condition clears', () => {
    let object: OperationalObject = { ...probe, alerts: [...weatherAdvisories(probe, withState({ ice: 0.7 }), at)] }
    const steady = JSON.stringify(object.alerts)
    for (let step = 1; step <= 100; step += 1) {
      object = { ...object, alerts: [...weatherAdvisories(object, withState({ ice: 0.7 }), later(step))] }
      expect(JSON.stringify(object.alerts)).toBe(steady)
    }
    expect(object.alerts.map(alert => alert.priority)).toEqual(['warning', 'caution'])
    const cleared = { ...object, alerts: [...weatherAdvisories(object, withState({ ice: 0.1 }), later(101))] }
    expect(cleared.alerts).toEqual([])
    // A new occurrence is raised at its own time.
    expect(weatherAdvisories(cleared, withState({ ice: 0.7 }), later(102)).every(alert => alert.raisedAt === later(102))).toBe(true)
  })

  test('the runtime projects them onto its objects: a probe in a fog area carries its advisories from the start, unchanged while the fog holds', async () => {
    const fog = createWeatherObject(weatherItemSchema.parse({
      pack: 'weather', type: 'weather_area', id: 'weather:fog', label: 'Fog bank', center: point, semiMajorAxisM: 3000, semiMinorAxisM: 3000, falloff: 'uniform', atmosphere: { visibilityM: 400 },
    }), at, settings, at)
    const config = testRuntimeConnectionConfig({ simulationRunId: 'run-weather-advisories' as SimulationRunId, runtimeIds: ['weather.local'] })
    const connection = await createLocalWeatherPackRuntimeAdapter().connect({ ...config, scenario: { ...config.scenario, initialObjects: [probe, fog] } })
    try {
      await connection.setClock({ currentTime: at, updatedAt: nowIso(), paused: true })
      const alertsOf = async (id: string) => (await connection.getSnapshot()).objects.find(object => object.id === id)!.alerts
      const first = await alertsOf(probe.id)
      expect(first.map(alert => alert.threshold)).toEqual(['hazard-visibilityM', 'adverse-visibilityM'])
      expect(first.every(alert => alert.raisedAt === at)).toBe(true)
      for (const seconds of [30, 60, 120]) await connection.setClock({ currentTime: later(seconds), updatedAt: nowIso(), paused: true })
      expect(JSON.stringify(await alertsOf(probe.id))).toBe(JSON.stringify(first))
    } finally { await connection.close() }
  })
})
