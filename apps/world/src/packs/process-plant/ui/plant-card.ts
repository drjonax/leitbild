import type { OperationalObject } from '../../../core/model/index.ts'
import { procedureIdSchema, type ProcedureId } from '../../../core/model/procedures.ts'
import { formatQuantity } from '../quantity-text.ts'
import { safetyFunctionStatusWords } from '../safety-functions.ts'
import type { TrendPoint } from './plant-card-sparkline.ts'
import {
  emptyProcessPlantProjection,
  processPlantUnitPackDataSchema,
  type ProcessPlantUnitEnergyReading,
  type ProcessPlantUnitProjection,
  type ProcessPlantUnitSafetyFunction,
} from '../model.ts'
import type { ProcedureRunSummary, ProcedureRunSummaryGroup } from '../../../ui/procedures/procedure-run-selectors.ts'
import { procedureRunSummaryTitle } from '../../../ui/procedures/procedure-run-selectors.ts'

/**
 * What a Plant's card says: the unit at a glance, then what each of its
 * actions would open, in the projection's own words. The card is a launcher:
 * it reads the Plant's projection and procedure runs, which the surface holds
 * already, and nothing on it writes to the Plant. Every value comes from the
 * model (its declared energy rates, operating modes, alarms and critical
 * safety functions); a
 * Plant whose runtime is pending says only that, never a placeholder count.
 */

export type PlantCardTone = 'ready' | 'working' | 'error' | 'idle'
export type PlantCardSeverity = NonNullable<ProcessPlantUnitProjection['highestSeverity']>

export interface PlantCardAlarms {
  /** "1 trip · 7 alarms", "No alarms". */
  readonly text: string
  /** The highest active severity, for the dot before the text; null when nothing is active. */
  readonly severity: PlantCardSeverity | null
}

export interface PlantCardProcedure {
  /** "E-0 step 4", "E-0 step 4 +1", "None running". */
  readonly text: string
  /** The full procedure title and current step, for the row's tooltip; null when none runs. */
  readonly title: string | null
  /** The run the row opens at; null opens the procedure window at the Plant. */
  readonly summary: ProcedureRunSummary | null
  /** Whether an AI agent drives the shown run. */
  readonly drivenByAi: boolean
}

export interface PlantCardEnergy {
  /** Its variable, which also names the series the Run's historian records it in. */
  readonly path: string
  readonly label: string
  /** "3400 MW"; "—" where it reads no number. */
  readonly text: string
  /** Its native unit, which its line's points are in. */
  readonly unit: string
  /** The reading at its Run time, for the line; null where it reads no number. */
  readonly point: TrendPoint | null
}

export interface PlantCardSafetyFunction {
  readonly status: Exclude<ProcessPlantUnitSafetyFunction['status'], 'not-monitored'>
  /** "HEAT SINK · FR-H.1", "CORE COOL ?", or "CSF" where none is challenged. */
  readonly text: string
  /** Its name, status and what that means, for the tooltip. */
  readonly title: string
  /** The procedure its colour sends operators to, where no active run on the unit runs it; null otherwise. */
  readonly notRunning: ProcedureId | null
}

export interface PlantCardView {
  readonly name: string
  readonly tone: PlantCardTone
  readonly statusLabel: string
  /** "Tripped" while the reactor is tripped, "Pending" until the runtime runs; null otherwise. */
  readonly chip: 'Tripped' | 'Pending' | null
  /** The declared operating mode the Plant is in; null where it declares none or none holds. */
  readonly mode: string | null
  /** The rates of the energy sources and sinks the model declares; null until the runtime runs. */
  readonly energy: ReadonlyArray<PlantCardEnergy> | null
  /** The most challenged critical safety function; null where none is declared, none is judged now, or the runtime is pending. */
  readonly safetyFunction: PlantCardSafetyFunction | null
  /** Null until the runtime runs: the pending projection's zero counts are no fact. */
  readonly alarms: PlantCardAlarms | null
  readonly procedure: PlantCardProcedure
}

const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

export const plantCardAlarms = (projection: Pick<ProcessPlantUnitProjection, 'activeTripCount' | 'activeAlarmCount' | 'highestSeverity'>): PlantCardAlarms => {
  const parts = [
    ...(projection.activeTripCount > 0 ? [counted(projection.activeTripCount, 'trip', 'trips')] : []),
    ...(projection.activeAlarmCount > 0 ? [counted(projection.activeAlarmCount, 'alarm', 'alarms')] : []),
  ]
  return {
    text: parts.length === 0 ? 'No alarms' : parts.join(' · '),
    severity: parts.length === 0 ? null : projection.highestSeverity ?? null,
  }
}

export const plantCardProcedure = (summaries: ProcedureRunSummaryGroup): PlantCardProcedure => {
  const [shown, ...others] = summaries.active
  if (shown === undefined) return { text: 'None running', title: null, summary: null, drivenByAi: false }
  const step = shown.step === null ? shown.procedureId : `${shown.procedureId} step ${shown.step.label}`
  return {
    text: others.length === 0 ? step : `${step} +${others.length}`,
    title: [shown, ...others].map(procedureRunSummaryTitle).join('\n\n'),
    summary: shown,
    drivenByAi: shown.run.driver?.kind === 'ai',
  }
}

export const plantCardEnergy = (reading: ProcessPlantUnitEnergyReading): PlantCardEnergy => ({
  path: reading.path,
  label: reading.label,
  text: reading.value === null ? '—' : formatQuantity(reading.value, reading.unit),
  unit: reading.unit,
  point: reading.value === null ? null : { t: Date.parse(reading.simulationTime), v: reading.value },
})

export const plantCardSafetyFunction = (
  worst: ProcessPlantUnitSafetyFunction | undefined,
  summaries: ProcedureRunSummaryGroup,
): PlantCardSafetyFunction | null => {
  if (worst === undefined || worst.status === 'not-monitored') return null
  const status = worst.status
  if (status === 'green') return { status, text: 'CSF', title: 'Critical safety functions: none challenged', notRunning: null }
  const procedure = worst.procedure === undefined ? null : procedureIdSchema.safeParse(worst.procedure)
  const running = procedure?.success === true && summaries.active.some(summary => summary.procedureId === procedure.data)
  return {
    status,
    text: worst.procedure !== undefined ? `${worst.shortLabel} · ${worst.procedure}` : status === 'unknown' ? `${worst.shortLabel} ?` : worst.shortLabel,
    title: `${worst.label}: ${safetyFunctionStatusWords(status)}\n${worst.meaning}`,
    notRunning: procedure?.success === true && !running ? procedure.data : null,
  }
}

/** The card of a Plant object, or null for an object that is no Plant. */
export const plantCardView = (object: OperationalObject, summaries: ProcedureRunSummaryGroup): PlantCardView | null => {
  const parsed = processPlantUnitPackDataSchema.safeParse(object.packData)
  if (!parsed.success) return null
  const projection = parsed.data.projection ?? emptyProcessPlantProjection(object.timestamps.updatedAt)
  const pending = projection.statusTone === 'idle'
  return {
    name: object.label,
    tone: projection.statusTone,
    statusLabel: projection.statusLabel,
    chip: pending ? 'Pending' : projection.reactorTripped === true ? 'Tripped' : null,
    mode: projection.modeLabel ?? null,
    energy: pending ? null : projection.energy.map(plantCardEnergy),
    safetyFunction: pending ? null : plantCardSafetyFunction(projection.worstSafetyFunction, summaries),
    alarms: pending ? null : plantCardAlarms(projection),
    procedure: plantCardProcedure(summaries),
  }
}
