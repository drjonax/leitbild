import type { ProcessPlantIcActuation } from '../runtime/index.ts'

// The automatic actions the reference PWR's protection and control carry
// out, declared once. Each trip names what it actuates by id, its own
// function first, so a limit on a display reads "LO-LO 20 · AFW START" or
// "LO 12.7 · SI" from the model, not "TRIP".

export const referenceActuations = [
  { id: 'reactorTrip', label: 'Reactor trip', shortLabel: 'RX TRIP' },
  { id: 'turbineTrip', label: 'Turbine trip', shortLabel: 'TURB TRIP' },
  { id: 'safetyInjection', label: 'Safety injection', shortLabel: 'SI' },
  { id: 'auxiliaryFeedwaterStart', label: 'Auxiliary feedwater start', shortLabel: 'AFW START' },
  { id: 'feedwaterIsolation', label: 'Feedwater isolation', shortLabel: 'FWI' },
  { id: 'pressurizerReliefOpen', label: 'Pressurizer PORV open', shortLabel: 'PORV OPEN' },
] as const satisfies ReadonlyArray<ProcessPlantIcActuation>

export type ReferenceActuationId = (typeof referenceActuations)[number]['id']
