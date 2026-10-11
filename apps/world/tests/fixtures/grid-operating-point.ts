import { norwaySummerLowOperatingPointRef } from '../../src/packs/electric-grid/definition-refs.ts'

/**
 * The Operating Point the Norway runtime tests start from: summer-night-low starts without an
 * alarm. winter-weekday-peak starts at its hour without a trip but with two branches above their
 * continuous rating in AC (Heifjellet – Middagseidklumpen 105.1 %, Flesaker – Mjøndalen 103.4 %;
 * electric-grid-ac-runtime.test.ts), which would add alarms to every test that counts them.
 */
export const norwayRuntimeTestOperatingPointRef = norwaySummerLowOperatingPointRef
