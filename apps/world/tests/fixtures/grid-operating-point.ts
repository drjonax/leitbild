import { norwaySummerLowOperatingPointRef } from '../../src/packs/electric-grid/definition-refs.ts'

/**
 * The Operating Point the Norway runtime tests start from. At DQ1's winter-weekday-peak no branch
 * exceeds its emergency rating in AC, but the runtime's DC flows load Flesaker – Mjøndalen to 118 %
 * of its rating (AC 106 %), above its thermal element's steady trip level of 115.8 %: branch
 * protection trips it at the first relay sample and four more follow instantaneously.
 * summer-night-low starts without an alarm. The tests move back to winter once branch loading
 * agrees between the DC runtime and the AC gate.
 */
export const norwayRuntimeTestOperatingPointRef = norwaySummerLowOperatingPointRef
