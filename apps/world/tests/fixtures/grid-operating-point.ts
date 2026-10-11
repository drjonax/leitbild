import { norwaySummerLowOperatingPointRef } from '../../src/packs/electric-grid/definition-refs.ts'

/**
 * The Operating Point the Norway runtime tests start from: summer-night-low starts without an
 * alarm. winter-weekday-peak starts without a trip but with four branches above their continuous
 * rating in AC (Flesaker – Mjøndalen 113.5 %, Heifjellet – Middagseidklumpen 105.2 %, Håkøybotn –
 * Kvaløya 105.1 %, one at 100.9 %; electric-grid-ac-runtime.test.ts), which would add alarms to
 * every test that counts them.
 */
export const norwayRuntimeTestOperatingPointRef = norwaySummerLowOperatingPointRef
