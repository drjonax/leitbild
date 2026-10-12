import { norwaySummerLowOperatingPointRef } from '../../src/packs/electric-grid/definition-refs.ts'

/**
 * The Operating Point the Norway runtime tests start from: summer-night-low starts without an
 * alarm. winter-weekday-peak starts at its hour without a trip but with branches near or above
 * their continuous rating in AC (electric-grid-ac-runtime.test.ts), which would add alarms to every
 * test that counts them.
 */
export const norwayRuntimeTestOperatingPointRef = norwaySummerLowOperatingPointRef
