import type { ProcessPlantIcFirstOutGroup } from '../runtime/index.ts'

// The reference PWR's first-out groups, declared once: what the automatic
// actions in each do, as operators name it and as a display names a limit
// acting through it ("LO-LO 20 · RX TRIP"). Each annunciator that is part of
// a group names it by id, and every trip names the group of what it does.
// The reactor trip's group leads a display's trip banner; the others are
// actuations listed apart from it. A rule whose action trips the reactor
// besides its own actuation (safety injection) annunciates two trips: its
// own, in its actuation's group, and the reactor trip, in the reactor trip's
// group, so the reactor trip's first-out ranks it among the trip's causes as
// a first-out panel does, and its actuation still stands apart. Opening the
// PORV on high pressure is pressure control, not an actuation.

export const referenceFirstOutGroups = [
  { id: 'reactor-trip', label: 'Reactor trip', shortLabel: 'RX TRIP', reactorTrip: true },
  { id: 'safety-injection', label: 'Safety injection', shortLabel: 'SI', reactorTrip: false },
  { id: 'auxiliary-feedwater', label: 'Auxiliary feedwater start', shortLabel: 'AFW START', reactorTrip: false },
  { id: 'feedwater-isolation', label: 'Feedwater isolation', shortLabel: 'FWI', reactorTrip: false },
  { id: 'turbine-trip', label: 'Turbine trip', shortLabel: 'TURB TRIP', reactorTrip: false },
  { id: 'steam-line-isolation', label: 'Steam line isolation', shortLabel: 'MSI', reactorTrip: false },
  { id: 'containment-spray', label: 'Containment spray', shortLabel: 'CS', reactorTrip: false },
  { id: 'electrical-power-loss', label: 'Safety bus loss of power', shortLabel: 'BUS DEAD', reactorTrip: false },
  { id: 'electrical-degraded-voltage', label: 'Safety bus degraded voltage', shortLabel: 'BUS DEGR', reactorTrip: false },
] as const satisfies ReadonlyArray<ProcessPlantIcFirstOutGroup>

export type ReferenceFirstOutGroupId = (typeof referenceFirstOutGroups)[number]['id']

/**
 * What a reactor trip brings in, as it is expected to, in its first
 * minutes: steam flow falls and the steam generators' levels shrink below
 * their low and low-low set points (starting auxiliary feedwater, and
 * tripping the already tripped reactor again), feed flow stops as feedwater
 * isolates, and Tavg falls to the feedwater isolation after a trip. Each
 * such alarm's annunciator declares it, so displays show these as expected
 * after the reactor trip's first-out, never hidden, while the first-out and
 * what came in before it stand out.
 */
export const expectedAfterReactorTrip = { firstOutGroup: 'reactor-trip', withinMs: 300_000 } as const satisfies { readonly firstOutGroup: ReferenceFirstOutGroupId; readonly withinMs: number }
