import type { Quantity } from '../../core/observation/model.ts'
import type { WeatherState } from './model.ts'

/** Display text of a value in its unit code (World's codes: degC, deg from north, 1 for a fraction). */
export const formatWeatherQuantity = (value: number | string, unit: string): string => {
  if (typeof value === 'string') return value.replaceAll('_', ' ')
  if (unit === '1') return `${Math.round(value * 100)}%`
  return `${Number(value.toFixed(2))} ${unit === 'degC' ? '°C' : unit === 'deg' ? '° from north' : unit}`.trim()
}

/** One list feeds discovery, object inspection, observation declarations and optional probe recordings; units are core unit codes. */
export const weatherQuantities: ReadonlyArray<{
  id: string
  title: string
  quantity: Quantity
  unit: string
  value: (state: WeatherState) => number | string
}> = [
  { id: 'airTemperatureC', title: 'Air temperature', quantity: 'temperature', unit: 'degC', value: (s) => s.atmosphere.airTemperatureC },
  { id: 'humidity', title: 'Humidity', quantity: 'fraction', unit: '1', value: (s) => s.atmosphere.humidity },
  { id: 'windSpeedMps', title: 'Wind speed', quantity: 'speed', unit: 'm/s', value: (s) => s.atmosphere.windSpeedMps },
  { id: 'windDirectionDeg', title: 'Wind direction', quantity: 'direction-from', unit: 'deg', value: (s) => s.atmosphere.windDirectionDeg },
  { id: 'visibilityM', title: 'Visibility', quantity: 'length', unit: 'm', value: (s) => s.atmosphere.visibilityM },
  { id: 'cloudCover', title: 'Cloud cover', quantity: 'fraction', unit: '1', value: (s) => s.atmosphere.cloudCover },
  { id: 'precipitationType', title: 'Precipitation', quantity: 'state', unit: '', value: (s) => s.atmosphere.precipitation.type },
  { id: 'intensityMmPerHour', title: 'Precipitation rate', quantity: 'precipitation-rate', unit: 'mm/h', value: (s) => s.atmosphere.precipitation.intensityMmPerHour },
  { id: 'groundTemperatureC', title: 'Ground temperature', quantity: 'temperature', unit: 'degC', value: (s) => s.surface.groundTemperatureC },
  ...(['wetness', 'standingWater', 'snow', 'ice', 'frost'] as const).map((id) => ({
    id,
    title: id === 'standingWater' ? 'Standing water' : id[0]!.toUpperCase() + id.slice(1),
    quantity: 'fraction' as const,
    unit: '1',
    value: (s: WeatherState) => s.surface[id],
  })),
]
export const weatherRecordingProfiles = [
  {
    id: 'probes',
    title: 'Weather probes',
    description: 'Record atmospheric and ground quantities at explicit probes only; no whole-grid logging.',
    defaultIntervalMs: 5000,
    minimumIntervalMs: 1000,
  },
]
