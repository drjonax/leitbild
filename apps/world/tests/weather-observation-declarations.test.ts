import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat, recordingSeriesIdFor, type IsoTimestamp, type OperationalObject } from '../src/core/model/index.ts'
import { observationShapes, type ObservationDeclaration } from '../src/core/observation/capabilities.ts'
import { weatherAdvisories, weatherPresentationSeverityForState, weatherSeverityLadder } from '../src/packs/weather/conditions.ts'
import { weatherItemSchema, weatherPackConfigSchema, weatherPackDataSchema } from '../src/packs/weather/model.ts'
import { weatherObservationDeclarations } from '../src/packs/weather/observation/declarations.ts'
import { weatherObservationRead } from '../src/packs/weather/observation/read.ts'
import { createWeatherObject } from '../src/packs/weather/scenario.ts'

// N5 (plan v3.1 §2.2; T12 weather): probes and areas declare the weather quantities in core unit
// codes; the severity ladder's rules are their thresholds (one source with the presentation severity).
const at = '2026-01-01T00:00:00.000Z' as IsoTimestamp
const point = geoPointFromLonLat(10.7522, 59.9139).coordinates
const settings = weatherPackConfigSchema.parse({})
const probe = createWeatherObject(weatherItemSchema.parse({ pack: 'weather', type: 'weather_probe', id: 'weather-probe:oslo', label: 'Oslo probe', point }), at, settings, at)
const area = createWeatherObject(weatherItemSchema.parse({ pack: 'weather', type: 'weather_area', id: 'weather:front', label: 'Front', center: point, semiMajorAxisM: 1500, semiMinorAxisM: 1500 }), at, settings, at)
/** The probe in fog: visibility 500 m is past both visibility rules, and its advisories are raised as the projection raises them. */
const foggy = (object: OperationalObject): OperationalObject => {
  const data = weatherPackDataSchema.parse(object.packData)
  const state = { ...data.sample.state, atmosphere: { ...data.sample.state.atmosphere, visibilityM: 500 } }
  return { ...object, alerts: [...weatherAdvisories(object, state, at)], packData: { ...data, sample: { ...data.sample, state } } }
}
const objects = new Map([[probe.id, foggy(probe)], [area.id, area]])
const declare = (objectId: string, recording = { packId: 'weather', profileId: 'probes' }) =>
  observationShapes.declarations.output.parse(weatherObservationDeclarations.answer({ objectIds: [objectId] }, objects, recording)).declarations[0] as ObservationDeclaration
const of = (declaration: ObservationDeclaration, id: string) => declaration.observables.find(observable => observable.ref === `${declaration.objectId}#${id}`)!

describe('weather observation declarations (N5)', () => {
  test('T12 weather: every quantity in a core unit code; a probe\'s recorded by the probes profile, an area\'s not', () => {
    const declaration = declare(probe.id)
    expect(declaration.observables.map(observable => [observable.ref.split('#')[1], observable.quantity, observable.unit]).slice(0, 5)).toEqual([
      ['airTemperatureC', 'temperature', 'degC'], ['humidity', 'fraction', '1'], ['windSpeedMps', 'speed', 'm/s'], ['windDirectionDeg', 'direction-from', 'deg'], ['visibilityM', 'length', 'm'],
    ])
    expect(of(declaration, 'precipitationType')).toMatchObject({ quantity: 'state', unit: '', valueType: 'enum', states: expect.arrayContaining([{ value: 'freezing_rain', label: 'freezing rain' }]) })
    expect(of(declaration, 'airTemperatureC').series).toEqual({ seriesId: recordingSeriesIdFor(probe.id, 'airTemperatureC'), intervalMs: 5_000 })
    expect(declare(area.id).observables.every(observable => observable.series === null)).toBe(true)
    const unrecorded = weatherObservationDeclarations.answer({ objectIds: [probe.id] }, objects, undefined).declarations[0] as ObservationDeclaration
    expect(unrecorded.observables.every(observable => observable.series === null)).toBe(true)
    expect(declaration.elements).toEqual([])
  })

  test('the severity ladder is each quantity\'s thresholds (mutation), and the presentation severity reads the same rules', () => {
    expect(of(declare(probe.id), 'visibilityM').thresholds.map(threshold => [threshold.id, threshold.direction, threshold.value, threshold.priority]))
      .toEqual([['hazard-visibilityM', 'low', 800, 'warning'], ['adverse-visibilityM', 'low', 2000, 'caution']])
    expect(of(declare(probe.id), 'wetness').thresholds.map(threshold => [threshold.value, threshold.priority])).toEqual([[0.2, 'notice']])
    expect(declare(probe.id).observables.flatMap(observable => observable.thresholds).every(threshold => threshold.effect === 'advisory')).toBe(true)
    const ladder = weatherSeverityLadder as Array<(typeof weatherSeverityLadder)[number]>
    const saved = [...ladder]
    const state = weatherPackDataSchema.parse(foggy(probe).packData).sample.state
    try {
      ladder.splice(ladder.findIndex(rule => rule.severity === 'hazard' && rule.quantity === 'visibilityM'), 1, { severity: 'hazard', quantity: 'visibilityM', direction: 'low', limit: 400 })
      expect(of(declare(probe.id), 'visibilityM').thresholds[0]).toMatchObject({ id: 'hazard-visibilityM', value: 400 })
      expect(weatherPresentationSeverityForState(state)).toBe('adverse')
      ladder.splice(ladder.findIndex(rule => rule.quantity === 'windSpeedMps'), 1)
      expect(of(declare(probe.id), 'windSpeedMps').thresholds).toEqual([])
    } finally {
      ladder.splice(0, ladder.length, ...saved)
    }
    expect(weatherPresentationSeverityForState(state)).toBe('hazard')
  })

  test('read: values at the sample time, coloured only by an active advisory (T05), unknown refs listed, lead advised first', () => {
    const answer = observationShapes.read.output.parse(weatherObservationRead.answer({ refs: [`${probe.id}#visibilityM`, `${probe.id}#airTemperatureC`, `${area.id}#visibilityM`, `${probe.id}#nothing`] }, objects))
    expect(answer.observations.map(observation => [observation.ref, observation.value, observation.priority])).toEqual([
      [`${probe.id}#visibilityM`, 500, 'warning'],
      [`${probe.id}#airTemperatureC`, weatherPackDataSchema.parse(probe.packData).sample.state.atmosphere.airTemperatureC, 'none'],
      [`${area.id}#visibilityM`, weatherPackDataSchema.parse(area.packData).sample.state.atmosphere.visibilityM, 'none'],
    ])
    expect(answer.observations.every(observation => observation.clock === 'simulation' && observation.quality === 'good')).toBe(true)
    expect(answer.unknown).toEqual([`${probe.id}#nothing`])
    // T05: every coloured value has a matching active advisory of that priority, and every advisory colours its value.
    const all = observationShapes.read.output.parse(weatherObservationRead.answer({ refs: [...objects.keys()].flatMap(id => declare(id).observables.map(observable => observable.ref)) }, objects)).observations
    const advisories = [...objects.values()].flatMap(object => object.alerts)
    expect(advisories.length).toBeGreaterThan(0)
    expect(all.filter(observation => observation.priority !== 'none').map(observation => [observation.ref, observation.priority]))
      .toEqual([...new Set(advisories.map(alert => alert.observable!))].map(ref => [ref, advisories.some(alert => alert.observable === ref && alert.priority === 'warning') ? 'warning' : 'caution']))
    const lead = observationShapes.read.output.parse(weatherObservationRead.answer({ lead: { objectId: probe.id, count: 3 } }, objects))
    expect(lead.observations.map(observation => [observation.ref.split('#')[1], observation.rank])).toEqual([['visibilityM', 1], ['windSpeedMps', 2], ['precipitationType', 3]])
    expect(() => weatherObservationRead.answer({ lead: { objectId: 'weather-probe:nowhere', count: 3 } }, objects)).toThrow(/No weather probe or area/)
  })

  test('lead ranks are declared beside the quantities; the lead reads advised values, then by those ranks', () => {
    expect(declare(area.id).observables.filter(observable => observable.lead !== undefined).map(observable => [observable.ref.split('#')[1], observable.lead]))
      .toEqual([['airTemperatureC', 4], ['windSpeedMps', 2], ['visibilityM', 1], ['precipitationType', 3], ['snow', 6], ['ice', 5]])
    const lead = observationShapes.read.output.parse(weatherObservationRead.answer({ lead: { objectId: area.id, count: 8 } }, objects))
    expect(lead.observations.map(observation => observation.ref.split('#')[1])).toEqual(['visibilityM', 'windSpeedMps', 'precipitationType', 'airTemperatureC', 'ice', 'snow'])
  })
})
