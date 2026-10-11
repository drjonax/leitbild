import type { FrequencyReserveAllocation } from './frequency/types.ts'

/** Upward reserve allocated to a unit across products (MW). */
export const upwardReserveMw = (reserves: FrequencyReserveAllocation): number =>
  reserves.fcrNMw + reserves.fcrDUpMw + reserves.afrrUpMw + reserves.mfrrUpMw
