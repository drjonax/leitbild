import type { OperationalObject } from '../../core/model/index.ts'
import {
  emptyProcessPlantProjection,
  processPlantUnitPackDataSchema,
  type ProcessPlantUnitProjection,
} from '../../packs/process-plant/model.ts'
import type { ProcedureRunSummary, ProcedureRunSummaryGroup } from '../procedures/procedure-run-selectors.ts'
import { procedureRunSummaryTitle } from '../procedures/procedure-run-selectors.ts'

/**
 * What a Plant's card says: the unit at a glance, then what each of its
 * actions would open, in the projection's own words. The card is a launcher:
 * it reads the Plant's projection and procedure runs, which the surface holds
 * already, and nothing on it writes to the Plant. Every value comes from the
 * model (its energy sentence, its declared operating modes, its alarms); a
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

export interface PlantCardView {
  readonly name: string
  readonly tone: PlantCardTone
  readonly statusLabel: string
  /** "Tripped" while the reactor is tripped, "Pending" until the runtime runs; null otherwise. */
  readonly chip: 'Tripped' | 'Pending' | null
  /** The declared operating mode the Plant is in; null where it declares none or none holds. */
  readonly mode: string | null
  /** The model's energy in → out sentence; null until the runtime runs. */
  readonly energy: string | null
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
    energy: pending ? null : projection.summary,
    alarms: pending ? null : plantCardAlarms(projection),
    procedure: plantCardProcedure(summaries),
  }
}
