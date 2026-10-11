import type { ProcessPlantIcFirstOutGroup } from '../runtime/index.ts'

// The reference PWR's first-out groups, declared once: what the automatic
// actions in each do, as operators name it and as a display names a limit
// acting through it ("LO-LO 20 · RX TRIP"). Each annunciator that is part of
// a group names it by id. The reactor trip's group leads a display's trip
// banner; the others are actuations listed apart from it.

export const referenceFirstOutGroups = [
  { id: 'reactor-trip', label: 'Reactor trip', shortLabel: 'RX TRIP', reactorTrip: true },
  { id: 'safety-injection', label: 'Safety injection', shortLabel: 'SI', reactorTrip: false },
  { id: 'containment-isolation', label: 'Containment isolation', shortLabel: 'CNMT ISOL', reactorTrip: false },
  { id: 'electrical-power-loss', label: 'Safety bus loss of power', shortLabel: 'BUS DEAD', reactorTrip: false },
  { id: 'electrical-degraded-voltage', label: 'Safety bus degraded voltage', shortLabel: 'BUS DEGR', reactorTrip: false },
] as const satisfies ReadonlyArray<ProcessPlantIcFirstOutGroup>

export type ReferenceFirstOutGroupId = (typeof referenceFirstOutGroups)[number]['id']
