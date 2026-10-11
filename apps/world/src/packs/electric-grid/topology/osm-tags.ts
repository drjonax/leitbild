import type { TopologyLevelInput, TopologyLifecycle, TopologySystem } from './input.ts'
import type { TopologyLedgerReason } from './ledger.ts'

// Circuit levels of an OSM power way from its tags. OSM lists one `voltage`/`frequency` value per
// circuit (https://wiki.openstreetmap.org/wiki/Key:voltage, Key:frequency); voltage is in volts.

type OsmTags = Readonly<Record<string, string>>

export type LevelReading =
  | { readonly ok: true; readonly levels: ReadonlyArray<TopologyLevelInput> }
  | { readonly ok: false; readonly reason: TopologyLedgerReason; readonly detail: string }

const voltsPerKv = 1000
// Railway traction in Norway and Sweden runs at 16 2/3 Hz (tagged 16.7 or 16.67).
const tractionHz = 50 / 3
const tractionToleranceHz = 0.1
const plainNumber = /^\d+(?:\.\d+)?$/

const parts = (value: string | undefined): ReadonlyArray<string> =>
  value === undefined ? [] : value.split(';').map(part => part.trim()).filter(part => part.length > 0)

const systemOfHz = (hz: number): TopologySystem | null =>
  hz === 0 ? 'hvdc' : hz === 50 ? 'ac50' : Math.abs(hz - tractionHz) <= tractionToleranceHz ? 'traction' : null

export const positiveIntegerTag = (value: string | undefined): number | null => {
  const first = parts(value)[0]
  if (first === undefined || !/^\d+$/.test(first)) return null
  const parsed = Number(first)
  return parsed > 0 ? parsed : null
}

export const levelsFromOsmTags = (tags: OsmTags): LevelReading => {
  // A comma is a frequent mistyped separator in voltage lists.
  const voltageParts = parts(tags.voltage?.replaceAll(',', ';'))
  const badVoltage = voltageParts.filter(part => !plainNumber.test(part) || Number(part) <= 0)
  if (badVoltage.length > 0) return { ok: false, reason: 'voltage-unparseable', detail: `voltage parts ${badVoltage.join(', ')} are not volts` }
  const frequencyParts = parts(tags.frequency).map(part => part.replace(',', '.'))
  const badFrequency = frequencyParts.filter(part => !plainNumber.test(part) || systemOfHz(Number(part)) === null)
  if (badFrequency.length > 0) return { ok: false, reason: 'unsupported-frequency', detail: `frequency ${badFrequency.join(', ')} Hz is not 50 Hz, DC or 16.7 Hz traction` }
  const systems = frequencyParts.map(part => systemOfHz(Number(part))!)
  const distinctSystems = [...new Set(systems)]
  const circuitsTag = positiveIntegerTag(tags.circuits)

  const systemAt = (index: number): TopologySystem | null => {
    if (systems.length === 0) return 'ac50'
    if (distinctSystems.length === 1) return distinctSystems[0]!
    if (systems.length === voltageParts.length) return systems[index]!
    return null
  }
  if (voltageParts.length === 0) {
    const system = systemAt(0)
    if (!system) return { ok: false, reason: 'system-ambiguous', detail: `frequencies ${frequencyParts.join(';')} without a voltage list` }
    return { ok: true, levels: [{ voltageKv: null, system, circuits: circuitsTag, circuitsSource: circuitsTag === null ? null : 'circuits-tag' }] }
  }
  const counts = new Map<string, { voltageKv: number; system: TopologySystem; occurrences: number }>()
  for (let index = 0; index < voltageParts.length; index += 1) {
    const system = systemAt(index)
    if (!system) return { ok: false, reason: 'system-ambiguous', detail: `${voltageParts.length} voltages but ${frequencyParts.length} frequencies (${frequencyParts.join(';')})` }
    const voltageKv = Number(voltageParts[index]) / voltsPerKv
    const key = `${voltageKv}|${system}`
    const entry = counts.get(key) ?? { voltageKv, system, occurrences: 0 }
    entry.occurrences += 1
    counts.set(key, entry)
  }
  const perCircuitList = voltageParts.length > 1 && (circuitsTag === null || circuitsTag === voltageParts.length)
  return {
    ok: true,
    levels: [...counts.values()].map(entry => {
      const circuits = voltageParts.length === 1 ? circuitsTag : perCircuitList ? entry.occurrences : null
      const circuitsSource = circuits === null ? null : voltageParts.length === 1 ? 'circuits-tag' as const : 'voltage-list' as const
      return { voltageKv: entry.voltageKv, system: entry.system, circuits, circuitsSource }
    }),
  }
}

// Lifecycle prefixes and values (https://wiki.openstreetmap.org/wiki/Lifecycle_prefix); `planned` is the
// older spelling of `proposed`.
const lifecycleKeys: ReadonlyArray<readonly [string, Exclude<TopologyLifecycle, 'operational'>]> = [
  ['construction', 'construction'],
  ['proposed', 'proposed'],
  ['planned', 'proposed'],
  ['disused', 'disused'],
  ['abandoned', 'abandoned'],
]

export const lifecycleFromOsmTags = (tags: OsmTags): TopologyLifecycle => {
  for (const [key, state] of lifecycleKeys) {
    if (tags.power === key) return state
    const value = tags[key]
    if (value !== undefined && value !== 'no') return state
    if (tags[`${key}:power`] !== undefined) return state
  }
  return 'operational'
}

const ratingPattern = /^(\d+(?:[.,]\d+)?)\s*(MVA|kVA)$/i

// Transformer nameplate `rating` in MVA; null when absent or not in MVA/kVA.
export const ratingMvaFromOsmTags = (tags: OsmTags): number | null => {
  const match = tags.rating?.trim().match(ratingPattern)
  if (!match) return null
  const value = Number(match[1]!.replace(',', '.'))
  return match[2]!.toLowerCase() === 'kva' ? value / 1000 : value
}

export const voltagesKvFromOsmTags = (value: string | undefined): ReadonlyArray<number> =>
  parts(value?.replaceAll(',', ';')).flatMap(part => plainNumber.test(part) && Number(part) > 0 ? [Number(part) / voltsPerKv] : [])

export const systemsFromOsmTags = (tags: OsmTags): ReadonlyArray<TopologySystem> =>
  [...new Set(parts(tags.frequency).flatMap(part => {
    const normalised = part.replace(',', '.')
    const system = plainNumber.test(normalised) ? systemOfHz(Number(normalised)) : null
    return system ? [system] : []
  }))]

// power=transformer windings: voltage:primary/secondary/tertiary where mapped, else the voltage list.
export const transformerVoltagesKv = (tags: OsmTags): ReadonlyArray<number> => {
  const windings = ['voltage:primary', 'voltage:secondary', 'voltage:tertiary'].flatMap(key => voltagesKvFromOsmTags(tags[key]))
  return windings.length > 0 ? windings : voltagesKvFromOsmTags(tags.voltage)
}
