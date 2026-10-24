/**
 * What a fleet or compare view of Plants draws from (multiunit plan §3.1): a Plant's cluster is its group, its fleet row
 * is read from its canonical projection (no physics read), and the quantities every Plant model measures under one
 * local ref are comparable across units. Declarations only; World's composer does the rest.
 */
import type { OperationalObject } from '../../core/model/index.ts'
import type { PackCategoryMembers, PackComparableRole } from '../../core/packs/protocol.ts'
import { processPlantUnitPackDataSchema } from './model.ts'

const STEADY_MODE = 'Power operation'
const SATISFIED = 'Satisfied'

const projectionOf = (object: OperationalObject) => {
  const parsed = processPlantUnitPackDataSchema.safeParse(object.packData)
  return parsed.success ? { data: parsed.data, projection: parsed.data.projection } : null
}

const rate = (object: OperationalObject, role: 'source' | 'sink'): number | null => {
  const value = projectionOf(object)?.projection?.energy.find(reading => reading.role === role)?.value
  return value === undefined ? null : value
}

/** A challenged function by its label and colour, and the procedure it sends operators to; a satisfied one in one word. */
const safetyWord = (object: OperationalObject): string | null => {
  const worst = projectionOf(object)?.projection?.worstSafetyFunction
  if (worst === undefined) return null
  if (worst.status === 'green') return SATISFIED
  return [`${worst.label} ${worst.status}`, ...worst.procedure === undefined ? [] : [worst.procedure]].join(' · ')
}

export const processPlantMembers: PackCategoryMembers = {
  group: { label: 'Cluster', of: object => projectionOf(object)?.data.clusterId },
  columns: [
    { key: 'mode', label: 'Mode', unit: '', tally: { except: [STEADY_MODE] } },
    { key: 'trip', label: 'Reactor', unit: '', tally: { except: [] } },
    { key: 'safety', label: 'Worst safety function', unit: '', tally: { except: [SATISFIED] } },
    { key: 'thermal', label: 'Thermal power', unit: 'MW' },
    { key: 'electric', label: 'Electrical output', unit: 'MW' },
    { key: 'alarms', label: 'Alarms', unit: '1' },
  ],
  row: object => {
    const projection = projectionOf(object)?.projection
    return {
      mode: projection?.modeLabel ?? null,
      trip: projection?.reactorTripped === true ? 'Tripped' : null,
      safety: safetyWord(object),
      thermal: rate(object, 'source'),
      electric: rate(object, 'sink'),
      alarms: projection === undefined || projection.statusTone === 'idle' ? null : projection.activeAlarmCount,
    }
  },
}

const role = (id: string, label: string, ref: string): PackComparableRole => ({ id, label, category: 'process-plants', ref })

/** Measured under the same local ref by every Plant of a model; a loop a smaller model lacks is refused per unit. */
export const processPlantComparableRoles: ReadonlyArray<PackComparableRole> = [
  role('reactor-power', 'Reactor power', 'core.powerRangePercent'),
  role('core-thermal-power', 'Core thermal power', 'core.totalThermalPowerMw'),
  role('electrical-output', 'Electrical output', 'turbine.electricMw'),
  role('pressurizer-pressure', 'Pressurizer pressure', 'pressurizer.pressureMPa'),
  role('pressurizer-level', 'Pressurizer level', 'pressurizer.levelPercent'),
  role('tavg', 'Average coolant temperature (Tavg)', 'vessel.meanPrimaryCoolantTemperatureC'),
  role('subcooling-margin', 'RCS subcooling margin', 'vessel.subcoolingMarginC'),
  role('core-exit-temperature', 'Core-exit temperature', 'core.coreExitTemperatureC'),
  role('rcs-level', 'RCS level (RVLIS)', 'vessel.collapsedLiquidLevelPercent'),
  ...['A', 'B', 'C', 'D'].flatMap(loop => [
    role(`sg-${loop.toLowerCase()}-level`, `SG ${loop} level`, `sg${loop}.levelPercent`),
    role(`sg-${loop.toLowerCase()}-pressure`, `SG ${loop} pressure`, `sg${loop}.pressureMPa`),
  ]),
]
