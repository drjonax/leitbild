import { z } from 'zod'
import { objectIdSchema } from '../../core/model/index.ts'

export const weatherPackId = 'weather' as const
export const precipitationTypeSchema = z.enum(['none', 'rain', 'snow', 'sleet', 'freezing_rain', 'hail'])
const fraction = z.number().finite().min(0).max(1)
export const weatherAtmosphereSchema = z
  .object({
    airTemperatureC: z.number().finite().min(-100).max(70),
    humidity: fraction,
    windSpeedMps: z.number().finite().min(0).max(150),
    windDirectionDeg: z.number().finite().min(0).max(360),
    visibilityM: z.number().finite().min(0).max(100_000),
    cloudCover: fraction,
    precipitation: z
      .object({ type: precipitationTypeSchema, intensityMmPerHour: z.number().finite().min(0).max(500) })
      .strict()
      .refine(value => value.type !== 'none' || value.intensityMmPerHour === 0, 'No precipitation requires a zero rate'),
  })
  .strict()
export const weatherAtmospherePatchSchema = weatherAtmosphereSchema.partial()
export type WeatherAtmosphere = z.infer<typeof weatherAtmosphereSchema>
export type WeatherAtmospherePatch = z.infer<typeof weatherAtmospherePatchSchema>
export const weatherSurfaceSchema = z
  .object({
    groundTemperatureC: z.number().finite().min(-100).max(100),
    wetness: fraction,
    standingWater: fraction,
    snow: fraction,
    ice: fraction,
    frost: fraction,
  })
  .strict()
export const weatherSurfacePatchSchema = weatherSurfaceSchema.partial()
export type WeatherSurface = z.infer<typeof weatherSurfaceSchema>
export const weatherStateSchema = z
  .object({ atmosphere: weatherAtmosphereSchema, surface: weatherSurfaceSchema })
  .strict()
export type WeatherState = z.infer<typeof weatherStateSchema>
export const backgroundAtmosphere: WeatherAtmosphere = {
  airTemperatureC: 8,
  humidity: 0.65,
  windSpeedMps: 3,
  windDirectionDeg: 240,
  visibilityM: 12000,
  cloudCover: 0.45,
  precipitation: { type: 'none', intensityMmPerHour: 0 },
}
export const initialGround: WeatherSurface = {
  groundTemperatureC: 8,
  wetness: 0,
  standingWater: 0,
  snow: 0,
  ice: 0,
  frost: 0,
}
export const weatherPackConfigSchema = z
  .object({
    gridResolution: z.number().int().min(0).max(11).default(8),
    atmosphere: weatherAtmosphereSchema.default(backgroundAtmosphere),
    surface: weatherSurfaceSchema.default(initialGround),
  })
  .strict()
  .default({ gridResolution: 8, atmosphere: backgroundAtmosphere, surface: initialGround })
export type WeatherConfig = z.infer<typeof weatherPackConfigSchema>
const position = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-80).max(80)])
const radius = z.number().finite().min(1).max(100_000)
const geometry = {
  center: position,
  semiMajorAxisM: radius.default(4000),
  semiMinorAxisM: radius.default(2000),
  rotationDeg: z.number().finite().min(0).max(360).default(0),
}
export const weatherKeyframeSchema = z
  .object({
    atSeconds: z.number().finite().min(0).max(31_536_000).describe(
      'Endpoint time in simulation seconds after area creation, not when the change starts. Values interpolate from the preceding endpoint (the initial area at 0 seconds). To start worsening after 120 seconds, add an unchanged frame {atSeconds:120}, then a changed endpoint at a later time. Updating an existing area preserves its creation-time origin.',
    ),
    center: position.optional(),
    semiMajorAxisM: radius.optional(),
    semiMinorAxisM: radius.optional(),
    rotationDeg: z.number().finite().min(0).max(360).optional(),
    atmosphere: weatherAtmospherePatchSchema.default({}).describe(
      'Atmospheric values at this endpoint. Omitted quantities retain their preceding endpoint values. Every animated quantity needs an explicit initial value in the area atmosphere. Numeric values interpolate; wind direction uses the shortest arc. Precipitation intensity interpolates, with precipitation type switching halfway when both endpoints have different non-none types.',
    ),
  })
  .strict()
const identity = { pack: z.literal('weather'), id: objectIdSchema, label: z.string().trim().min(1).max(160) }
export const weatherAreaSchema = z
  .object({
    ...identity,
    type: z.literal('weather_area'),
    ...geometry,
    enabled: z.boolean().default(true),
    priority: z.number().int().min(-1000).max(1000).default(0),
    falloff: z.enum(['linear', 'uniform']).default('linear'),
    atmosphere: weatherAtmospherePatchSchema.default({}),
    keyframes: z.array(weatherKeyframeSchema).max(128).default([]).describe(
      'Ordered endpoint states, not timed step changes. Geometry and atmosphere interpolate from the initial area at 0 seconds to the first endpoint, then between endpoints; the final state holds afterwards. Omitted fields inherit the preceding endpoint. An empty frame {atSeconds:120} holds the initial state until 120 seconds before interpolation to a later changed frame.',
    ),
  })
  .strict()
  .superRefine((area, ctx) => {
    let previous = -1
    area.keyframes.forEach((frame, index) => {
      if (frame.atSeconds <= previous)
        ctx.addIssue({
          code: 'custom',
          path: ['keyframes', index, 'atSeconds'],
          message: 'Keyframe times must be strictly increasing',
        })
      for (const key of Object.keys(frame.atmosphere)) {
        if (!(key in area.atmosphere))
          ctx.addIssue({
            code: 'custom',
            path: ['keyframes', index, 'atmosphere', key],
            message: 'Animated quantities require an explicit starting value in the area atmosphere',
          })
      }
      previous = frame.atSeconds
    })
  })
export const weatherProbeSchema = z.object({ ...identity, type: z.literal('weather_probe'), point: position }).strict()
export const weatherItemSchema = z.discriminatedUnion('type', [weatherAreaSchema, weatherProbeSchema])
export type WeatherArea = z.infer<typeof weatherAreaSchema>
export type WeatherItem = z.infer<typeof weatherItemSchema>
export const weatherSampleSchema = z
  .object({
    state: weatherStateSchema,
    quality: z
      .object({
        provenance: z.literal('scenario'),
        validAt: z.string().datetime(),
        model: z.literal('prescribed-atmosphere/heuristic-ground'),
      })
      .strict(),
    activeInfluenceIds: z.array(z.string()),
    resolution: z.number().int().min(0).max(11),
    fieldRevision: z.number().int().nonnegative(),
  })
  .strict()
export type WeatherSample = z.infer<typeof weatherSampleSchema>
export const weatherPackDataSchema = z
  .object({
    definition: weatherItemSchema,
    startsAt: z.string().datetime(),
    sample: weatherSampleSchema,
  })
  .strict()
export type WeatherPackData = z.infer<typeof weatherPackDataSchema>
