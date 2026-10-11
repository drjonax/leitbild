import type { GridDemandDayType, GridDemandProfileDay } from '../grid-model.ts'
import { isNorwegianPublicHoliday } from './norwegian-holidays.ts'

const hourMs = 3_600_000
const dayMs = 86_400_000
/** Hour values one profile holds: 24 weekday hours, then 24 weekend hours. */
export const demandProfileStride = 48

const osloOffset = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', timeZoneName: 'longOffset' })
const offsetByUtcHour = new Map<number, number>()

/** Europe/Oslo wall-clock time of an instant (with daylight saving time), as milliseconds since local 1970-01-01 00:00. */
export const osloLocalMs = (epochMs: number): number => {
  const utcHour = Math.floor(epochMs / hourMs)
  let offsetMs = offsetByUtcHour.get(utcHour)
  if (offsetMs === undefined) {
    // "GMT+01:00" or "GMT+02:00"; Norway has whole-hour offsets.
    const name = osloOffset.formatToParts(new Date(epochMs)).find(part => part.type === 'timeZoneName')?.value
    const match = name === undefined ? null : /^GMT([+-])(\d{2}):(\d{2})$/.exec(name)
    if (!match) throw new Error(`Europe/Oslo has no UTC offset for ${new Date(epochMs).toISOString()} (${String(name)})`)
    offsetMs = (match[1] === '-' ? -1 : 1) * (Number(match[2]) * hourMs + Number(match[3]) * 60_000)
    offsetByUtcHour.set(utcHour, offsetMs)
  }
  return epochMs + offsetMs
}

/** Local clock hour of a local wall-clock time, fractional (0 ≤ h < 24). */
export const localHourOfDay = (localMs: number): number => (((localMs % dayMs) + dayMs) % dayMs) / hourMs

/** HH:MM of a local wall-clock time. */
export const localClockText = (localMs: number): string => {
  const minutes = Math.floor((((localMs % dayMs) + dayMs) % dayMs) / 60_000)
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** Saturday and Sunday are weekend days; 1970-01-01, local day 0, was a Thursday. */
const weekendDay = (localDay: number): boolean => {
  const weekday = (((localDay + 4) % 7) + 7) % 7
  return weekday === 0 || weekday === 6
}

/** The day type of a local date: a Norwegian public holiday, else a weekend day or a weekday. */
const dayTypeOfLocalDay = (localDay: number): GridDemandDayType => isNorwegianPublicHoliday(localDay) ? 'holiday' : weekendDay(localDay) ? 'weekend' : 'weekday'

/** The day type of the local date of a local wall-clock time. */
export const localDayType = (localMs: number): GridDemandDayType => dayTypeOfLocalDay(Math.floor(localMs / dayMs))

/**
 * The profile day a day type follows. Elhub publishes weekday and weekend series only; a public
 * holiday follows the weekend series, the Saturday–Sunday mean, though its demand is closest to a
 * Sunday's, which lay 0.5–0.9 % below that mean in Elhub's two profile weeks (daily energy).
 */
export const profileDayOf = (dayType: GridDemandDayType): GridDemandProfileDay => dayType === 'weekday' ? 'weekday' : 'weekend'

/** Offset of a local date's profile day in a profile's 48 hour values. */
const profileDayOffset = (localDay: number): number => dayTypeOfLocalDay(localDay) === 'weekday' ? 0 : 24

/**
 * Writes the factor of each of `count` profiles at local wall-clock time `localMs` into `factors`:
 * the hour values of the local date's profile day, linear between h:00 and h+1:00, and from 23:00
 * towards 00:00 of the next date's profile day. Exactly the hour's value on the hour.
 */
export const evaluateDemandProfiles = (hours: Float64Array, count: number, localMs: number, factors: Float64Array): void => {
  const localDay = Math.floor(localMs / dayMs)
  const position = (localMs - localDay * dayMs) / hourMs
  const hour = Math.floor(position)
  const fraction = position - hour
  const offset = profileDayOffset(localDay) + hour
  const nextOffset = hour === 23 ? profileDayOffset(localDay + 1) : offset + 1
  for (let profile = 0; profile < count; profile += 1) {
    const base = profile * demandProfileStride
    const value = hours[base + offset]!
    factors[profile] = value + (hours[base + nextOffset]! - value) * fraction
  }
}
