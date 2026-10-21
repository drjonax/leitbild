import type { AlertState } from '../../core/model/alerts.ts'
import type { IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import type { WeatherState, WeatherSurface, WeatherAtmosphere } from './model.ts'
import { weatherQuantities } from './quantities.ts'
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))
const precipitationAddsWetness = (type: string): boolean => ['rain', 'freezing_rain', 'sleet', 'hail'].includes(type)
const precipitationAddsSnow = (type: string): boolean => ['snow', 'sleet'].includes(type)
export const evolveSurface = (config: {
  readonly surface: WeatherSurface
  readonly atmosphere: WeatherAtmosphere
  readonly at: IsoTimestamp
  readonly elapsedSeconds: number
}): WeatherSurface => {
  const dtMinutes = Math.max(0, config.elapsedSeconds / 60)
  const targetGroundTemperature = config.atmosphere.airTemperatureC
  const groundTemperatureC =
    config.surface.groundTemperatureC +
    (targetGroundTemperature - config.surface.groundTemperatureC) * (1 - Math.exp(-dtMinutes / 20))
  const precipitation = config.atmosphere.precipitation
  const precipitationAmount = (precipitation.intensityMmPerHour * dtMinutes) / 60
  let wetness = config.surface.wetness
  let standingWater = config.surface.standingWater
  let snow = config.surface.snow
  let ice = config.surface.ice
  let frost = config.surface.frost

  if (precipitationAddsWetness(precipitation.type)) {
    wetness = clamp01(wetness + precipitationAmount / 4)
    standingWater = clamp01(standingWater + precipitationAmount / 12)
  }
  if (precipitationAddsSnow(precipitation.type)) {
    snow = clamp01(snow + precipitationAmount / 5)
  }

  if (groundTemperatureC < 0) {
    const freeze = clamp01((-groundTemperatureC / 8) * wetness * dtMinutes * 0.12)
    wetness = clamp01(wetness - freeze)
    standingWater = clamp01(standingWater - freeze * 0.6)
    ice = clamp01(ice + freeze)
    frost = clamp01(frost + (-groundTemperatureC / 12) * dtMinutes * 0.03)
  } else {
    const melt = clamp01((groundTemperatureC / 8) * dtMinutes * 0.08)
    const snowMelt = Math.min(snow, melt)
    const iceMelt = Math.min(ice, melt * 0.65)
    snow = clamp01(snow - snowMelt)
    ice = clamp01(ice - iceMelt)
    wetness = clamp01(wetness + snowMelt * 0.55 + iceMelt * 0.7)
    frost = clamp01(frost - melt)
  }

  if (precipitation.intensityMmPerHour === 0) {
    const drying = clamp01(
      (Math.max(0, groundTemperatureC) / 20 + Math.min(config.atmosphere.windSpeedMps, 12) / 30) * dtMinutes * 0.08,
    )
    wetness = clamp01(wetness - drying)
    standingWater = clamp01(standingWater - drying * 0.7)
  }

  return {
    groundTemperatureC,
    wetness,
    standingWater,
    snow,
    ice,
    frost,
  }
}

export type WeatherPresentationSeverity = 'normal' | 'notice' | 'adverse' | 'hazard'
/** The severity ladder: a quantity (weatherQuantities id) past its limit raises a state to the rule's severity; observation thresholds read these rules. */
export const weatherSeverityLadder: ReadonlyArray<{ readonly severity: Exclude<WeatherPresentationSeverity, 'normal'>; readonly quantity: string; readonly direction: 'low' | 'high'; readonly limit: number }> = [
  { severity: 'hazard', quantity: 'ice', direction: 'high', limit: 0.55 },
  { severity: 'hazard', quantity: 'visibilityM', direction: 'low', limit: 800 },
  { severity: 'hazard', quantity: 'windSpeedMps', direction: 'high', limit: 25 },
  { severity: 'adverse', quantity: 'snow', direction: 'high', limit: 0.45 },
  { severity: 'adverse', quantity: 'ice', direction: 'high', limit: 0.25 },
  { severity: 'adverse', quantity: 'visibilityM', direction: 'low', limit: 2000 },
  { severity: 'notice', quantity: 'wetness', direction: 'high', limit: 0.2 },
  { severity: 'notice', quantity: 'standingWater', direction: 'high', limit: 0.15 },
]
export const weatherRulePasses = (rule: (typeof weatherSeverityLadder)[number], value: number | string): boolean =>
  typeof value === 'number' && (rule.direction === 'high' ? value > rule.limit : value < rule.limit)
export const weatherPresentationSeverityForState = (state: WeatherState): WeatherPresentationSeverity => {
  const value = (id: string): number | string => weatherQuantities.find((quantity) => quantity.id === id)!.value(state)
  const reached = (severity: WeatherPresentationSeverity): boolean =>
    weatherSeverityLadder.some((rule) => rule.severity === severity && weatherRulePasses(rule, value(rule.quantity)))
  return reached('hazard') ? 'hazard' : reached('adverse') ? 'adverse' : state.atmosphere.precipitation.type !== 'none' || reached('notice') ? 'notice' : 'normal'
}

/**
 * The priority of a ladder level, the one table its advisory alert and its threshold tick read. A hazard (ice over
 * 0.55, visibility under 800 m, wind over 25 m/s) endangers outdoor work and traffic now and wants prompt attention: a
 * warning. Adverse ground or visibility wants awareness: a caution. Neither is an alarm, as no operator action
 * controls the weather; notice-level wetness is routine weather: its tick is a notice and it raises no advisory.
 */
export const weatherLevelPriority = { notice: 'notice', adverse: 'caution', hazard: 'warning' } as const

/**
 * One advisory alert per ladder condition that holds (R42, R43): it names the condition and the probe or area, never
 * a live value; it keeps the simulation time it was first raised at while it holds, and is gone when it clears.
 */
export const weatherAdvisories = (object: Pick<OperationalObject, 'id' | 'label' | 'alerts'>, state: WeatherState, at: IsoTimestamp): ReadonlyArray<AlertState> =>
  weatherSeverityLadder.flatMap((rule) => {
    const quantity = weatherQuantities.find((candidate) => candidate.id === rule.quantity)!
    if (rule.severity === 'notice' || !weatherRulePasses(rule, quantity.value(state))) return []
    const [id, condition] = [`${object.id}:advisory:${rule.severity}-${rule.quantity}`, `${rule.severity}-${rule.quantity}`]
    return [{
      id, kind: 'weather_advisory', severity: 'warning', priority: weatherLevelPriority[rule.severity], advisory: true, acknowledged: false,
      message: `${quantity.title} ${rule.direction} (${rule.severity}): ${object.label}`, clock: 'simulation',
      raisedAt: object.alerts.find((alert) => alert.id === id)?.raisedAt ?? at, observable: `${object.id}#${rule.quantity}`, threshold: condition,
    } as const]
  })
