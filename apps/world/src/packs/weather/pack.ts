import type { OperationalObject } from '../../core/model/index.ts'
import { packField,packStatus } from '../../core/packs/presentation.ts'
import type { PackScenarioAuthoringField,WorldPack } from '../../core/packs/protocol.ts'
import { createWorldPackDescriptor } from '../../core/packs/protocol.ts'
import { weatherPresentationSeverityForState } from './conditions.ts'
import {
  backgroundAtmosphere,
  precipitationTypeSchema,
  weatherItemSchema,
  weatherKeyframeSchema,
  weatherPackConfigSchema,
  weatherPackDataSchema,
  weatherSampleSchema,
} from './model.ts'
import { formatWeatherQuantity,weatherQuantities,weatherRecordingProfiles } from './quantities.ts'
import { weatherScenarioSupport } from './scenario.ts'
import { weatherSimRuntimeId } from './sim/constants.ts'

const dataFor = (object: OperationalObject) => {
  const parsed = weatherPackDataSchema.safeParse(object.packData)
  return object.packId === 'weather' && parsed.success ? parsed.data : null
}
const number = (
  path: (string | number)[],
  label: string,
  defaultValue: number,
  min: number,
  max: number,
  step = 1,
): PackScenarioAuthoringField => ({
    path,
  label,
  control: { kind: 'number', min, max, step },
})
export const atmosphereFields: ReadonlyArray<PackScenarioAuthoringField> = [
  number(['atmosphere', 'airTemperatureC'], 'Air temperature (°C)', 8, -100, 70),
  number(['atmosphere', 'humidity'], 'Humidity (0–1)', 0.65, 0, 1, 0.05),
  number(['atmosphere', 'windSpeedMps'], 'Wind (m/s)', 3, 0, 150, 0.5),
  number(['atmosphere', 'windDirectionDeg'], 'Wind FROM (°)', 240, 0, 360),
  number(['atmosphere', 'visibilityM'], 'Visibility (m)', 12000, 0, 100000, 100),
  number(['atmosphere', 'cloudCover'], 'Cloud cover (0–1)', 0.45, 0, 1, 0.05),
  {
        path: ['atmosphere', 'precipitation', 'type'],
    label: 'Precipitation',
    control: {
      kind: 'select',
      options: precipitationTypeSchema.options.map((value) => ({ value, label: value.replaceAll('_', ' ') })),
    },
  },
  number(['atmosphere', 'precipitation', 'intensityMmPerHour'], 'Precipitation (mm/h)', 0, 0, 500, 0.5),
]
export const areaDefault = {
  semiMajorAxisM: 4000,
  semiMinorAxisM: 2000,
  rotationDeg: 0,
  enabled: true,
  priority: 0,
  falloff: 'linear',
  atmosphere: backgroundAtmosphere,
  keyframes: [],
}
export const weatherPack: WorldPack = {
  descriptor: createWorldPackDescriptor({
    id: 'weather',
    version: '1.0.0',
    name: 'Weather',
    description:
      'Prescribed atmosphere and persistent heuristic ground conditions. Editable areas, timed changes and probes; no forecast feed or terrain hydrology.',
    contributions: ['runtime', 'scenario', 'presentation', 'creation', 'recording', 'observation'],
  }),
  scenarioConfigSchema: weatherPackConfigSchema,
  authoring: {
    configFields: [
      number(['gridResolution'], 'Ground H3 resolution (restart required)', 8, 0, 11),
      ...atmosphereFields,
      number(['surface', 'groundTemperatureC'], 'Initial ground temperature (°C)', 8, -100, 100),
      ...(['wetness', 'standingWater', 'snow', 'ice', 'frost'] as const).map((key) =>
        number(['surface', key], 'Initial ' + key, 0, 0, 1, 0.05),
      ),
    ],
    itemTypes: [
      {
        id: 'weather_area',
        label: 'Weather area',
        description:
          'An elliptical atmospheric influence; ground evolves underneath at the configured mesh resolution.',
        idPrefix: 'weather',
        defaultItem: areaDefault,
        placement: { kind: 'point', path: ['center'] },
        collections: [
          {
            path: ['keyframes'],
            label: 'Keyframe endpoints (seconds after area creation)',
            maxItems: 128,
            defaultItem: { atSeconds: 300 },
            keyframes: { timePath: ['atSeconds'], increment: 300 },
            fields: [
              {
                ...number(['atSeconds'], 'Endpoint time (seconds)', 300, 0, 31536000),
                description: weatherKeyframeSchema.shape.atSeconds.description!,
              },
              number(['center', 0], 'Center longitude', 10.7522, -180, 180, 0.001),
              number(['center', 1], 'Center latitude', 59.9139, -80, 80, 0.001),
              number(['semiMajorAxisM'], 'Length radius (m)', 4000, 1, 100000, 100),
              number(['semiMinorAxisM'], 'Width radius (m)', 2000, 1, 100000, 100),
              number(['rotationDeg'], 'Rotation (°)', 0, 0, 360),
              ...atmosphereFields,
            ],
          },
        ],
        fields: [
          number(['semiMajorAxisM'], 'Length radius (m)', 4000, 1, 100000, 100),
          number(['semiMinorAxisM'], 'Width radius (m)', 2000, 1, 100000, 100),
          number(['rotationDeg'], 'Rotation (°)', 0, 0, 360),
          number(['priority'], 'Priority', 0, -1000, 1000),
          { path: ['enabled'], label: 'Enabled', control: { kind: 'boolean',} },
          {
                        path: ['falloff'],
            label: 'Edge blend',
            control: {
              kind: 'select',
              options: [
                { value: 'linear', label: 'Linear' },
                { value: 'uniform', label: 'Uniform' },
              ],
            },
          },
          ...atmosphereFields,
        ],
      },
      {
        id: 'weather_probe',
        label: 'Weather probe',
        description:
          'A named observation point sampling the authoritative field; optionally recorded by the Historian.',
        idPrefix: 'weather-probe',
        defaultItem: {},
        placement: { kind: 'point', path: ['point'] },
        fields: [],
      },
    ],
  },
  recording: { profiles: weatherRecordingProfiles, estimateSeries: objects => 2 + objects.filter(object => dataFor(object)?.definition.type === 'weather_probe').length * weatherQuantities.length },
  runtime: {
    runtimes: [
      { id: weatherSimRuntimeId, version: '1.0.0', label: 'Local weather', kind: 'local', clock: 'simulation' },
    ],
    defaultRuntimeId: weatherSimRuntimeId,
  },
  scenario: weatherScenarioSupport,
  // The runtime's Capabilities (observation/), named here so the main app never loads them; assembly checks they exist.
  observation: { categories: ['weather'], declarations: 'world.weather.observation.declarations', read: 'world.weather.observation.read' },
  presentation: {
    contextualFieldQueries: (object) =>
      object.packId !== 'weather' && object.spatial.position
        ? [
            {
              capabilityId: 'world.weather.sample-at-point',
              input: { point: object.spatial.position.point },
              toFields: (result) => {
                const sample = weatherSampleSchema.parse(result)
                return [
                  ...weatherQuantities.map((q) =>
                    packField('weather:' + q.id, 'Weather · ' + q.title, formatWeatherQuantity(q.value(sample.state), q.unit)),
                  ),
                  packField('weather:time', 'Weather sample time', sample.quality.validAt),
                ]
              },
            },
          ]
        : [],
    categories: [
      {
        id: 'weather',
        label: 'Weather',
        emptyLabel: 'No weather areas or probes',
        matches: (object) => dataFor(object) !== null,
      },
    ],
    mapFeatureLayers: ['weather'],
    mapFeatureSourcePackIds: ['weather'],
    presentObject: (object) => {
      const data = dataFor(object)
      const severity = data ? weatherPresentationSeverityForState(data.sample.state) : 'hazard'
      const tone = severity === 'hazard' ? 'error' : severity === 'normal' ? 'ready' : 'working'
      return {
        categoryId: 'weather',
        icon: 'cloud-rain',
        color: '#4669ff',
        summary: data
          ? `${data.definition.type === 'weather_probe' ? 'Probe' : data.definition.enabled ? 'Area' : 'Disabled area'} · ${severity}`
          : 'Invalid Weather data',
        status: packStatus(tone, severity),
        fields: data
          ? [
              ...weatherQuantities.map((q) =>
                packField(q.id, q.title, formatWeatherQuantity(q.value(data.sample.state), q.unit)),
              ),
              packField('sample-at', 'Simulation time', data.sample.quality.validAt),
              packField('model', 'Model', data.sample.quality.model),
              packField('resolution', 'Ground H3 resolution', String(data.sample.resolution)),
              packField('influences', 'Influences', data.sample.activeInfluenceIds.join(', ') || 'Background'),
            ]
          : [packField('error', 'Error', 'Invalid Weather definition')],
        mapIconVisible: data?.definition.type === 'weather_probe',
        noteworthyUpdates: false,
      }
    },
    mapFeatureQueries: (context) =>
      context.map
        ? [
            {
              capabilityId: 'world.weather.map-features',
              input: {
                viewport: context.map.viewport,
                zoom: context.map.zoom,
                layers:
                  context.map.zoom < 7
                    ? ['affectedCells', 'influenceShapes']
                    : ['baseGrid', 'affectedCells', 'influenceShapes'],
              },
            },
          ]
        : [],
  },
  creation: {
    createObjectTypes: [
      {
        id: 'weather_probe',
        label: 'Weather probe',
        categoryId: 'weather',
        icon: 'cloud-rain',
        color: '#4669ff',
        placementKind: 'point',
      },
      {
        id: 'weather_area',
        label: 'Weather area',
        categoryId: 'weather',
        icon: 'cloud-rain',
        color: '#4669ff',
        placementKind: 'point',
      },
    ],
    defaultObjectLabel: (typeId, context) =>
      `${typeId === 'weather_probe' ? 'Weather probe' : 'Weather area'} ${context.objects.filter((o) => o.packId === 'weather').length + 1}`,
    buildCreateObjectCommand: (typeId, label, geometry, parameters) => {
      if (geometry.kind !== 'point') throw new Error('Weather creation requires a point')
      const item = weatherItemSchema.parse({
        ...(typeId === 'weather_area'
          ? { ...areaDefault, center: geometry.point.coordinates }
          : { point: geometry.point.coordinates }),
        ...(parameters && typeof parameters === 'object' ? parameters : {}),
        pack: 'weather',
        type: typeId,
        id: 'weather:' + crypto.randomUUID(),
        label,
      })
      return { kind: 'world.weather.create', targetObjectIds: [], payload: item }
    },
  },
}
