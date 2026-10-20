import type { GridAlarmSettings } from './schemas/grid-protection-automation.ts'

// How the Grid's map, panel and asset status band a branch's loading (% of its derated continuous
// rating): attention from GRID_ATTENTION_LOADING_PERCENT, the corridors the summary lists before any
// alarm acts (grid overhaul audit C-17); high from the Automation's lowest continuous-rating loading
// alarm; overloaded from its highest. The alarm bands are read from the Automation the Grid runs, never
// copied into code: a copy at 85 % had drifted from the configured 90 %.

/** Closed branches loaded at or above this are constrained corridors; no Automation declares it. */
export const GRID_ATTENTION_LOADING_PERCENT = 70

export interface GridLoadingBands {
  readonly attentionPercent: number
  /** The lowest raise loading of the Automation's continuous-rating branch loading alarms. */
  readonly highPercent: number
  /** The highest raise loading of those alarms. */
  readonly overloadPercent: number
}

export const gridLoadingBands = (alarms: GridAlarmSettings): GridLoadingBands => {
  const raised = alarms.branchLoading.filter(band => band.basis === 'continuous-rating').map(band => band.raisePercent).sort((left, right) => left - right)
  if (raised.length === 0) throw new Error('the Grid Automation declares no continuous-rating branch loading alarm to band loading by')
  return { attentionPercent: GRID_ATTENTION_LOADING_PERCENT, highPercent: raised[0]!, overloadPercent: raised.at(-1)! }
}
