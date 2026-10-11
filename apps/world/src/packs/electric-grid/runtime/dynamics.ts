import type { GridLoadDefinition } from '../grid-model.ts'

// Daily demand shape per load kind, as relative factors over the Europe/Oslo clock hour. These are
// the Pack's existing shapes; they carry no measured source yet (Elhub hourly profiles replace them
// with the data lane's operating points).
export const loadKindDailyFactor = (kind: GridLoadDefinition['kind'], hour: number): number => {
  const phase = 2 * Math.PI * hour / 24
  if (kind === 'residential') return 1 + 0.055 * Math.sin(phase - 0.6) + 0.05 * Math.sin(2 * phase - 2.2)
  if (kind === 'commercial' || kind === 'airport') return 0.98 + 0.08 * Math.sin(phase - 1.35) + 0.025 * Math.sin(2 * phase - 1.8)
  if (kind === 'ev_charging') return 0.96 + 0.105 * Math.sin(phase - 2.35) + 0.035 * Math.sin(2 * phase - 2.9)
  if (kind === 'industry' || kind === 'data_center' || kind === 'process_plant') return 1 + 0.018 * Math.sin(phase - 0.9)
  if (kind === 'hospital') return 1 + 0.01 * Math.sin(phase - 0.4)
  return 1
}

const osloOffset = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', timeZoneName: 'longOffset' })
const offsetByUtcHour = new Map<number, number>()

/** Local clock hour in Norway (Europe/Oslo, with daylight saving time), fractional. */
export const osloHourOfDay = (epochMs: number): number => {
  const utcHour = Math.floor(epochMs / 3_600_000)
  let offsetMs = offsetByUtcHour.get(utcHour)
  if (offsetMs === undefined) {
    // "GMT+01:00" or "GMT+02:00"; Norway has whole-hour offsets.
    const name = osloOffset.formatToParts(new Date(epochMs)).find(part => part.type === 'timeZoneName')?.value
    const match = name === undefined ? null : /^GMT([+-])(\d{2}):(\d{2})$/.exec(name)
    if (!match) throw new Error(`Europe/Oslo has no UTC offset for ${new Date(epochMs).toISOString()} (${String(name)})`)
    offsetMs = (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 3_600_000 + Number(match[3]) * 60_000)
    offsetByUtcHour.set(utcHour, offsetMs)
  }
  const localMs = epochMs + offsetMs
  return (((localMs % 86_400_000) + 86_400_000) % 86_400_000) / 3_600_000
}

/** Profiled demand of one load whose kind's daily factor at the instant is `dailyFactor`. */
export const profiledGridDemand = (load: GridLoadDefinition, nominalDemandMw: number, dailyFactor: number): number =>
  Math.max(load.criticalMw, nominalDemandMw * dailyFactor)
