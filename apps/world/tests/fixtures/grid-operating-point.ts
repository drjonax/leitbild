import { norwaySummerLowOperatingPointRef } from '../../src/packs/electric-grid/definition-refs.ts'

/**
 * The Operating Point the Norway runtime tests start from. Today's v2 winter-weekday-peak data
 * loads 13 branches above their continuous rating and 6 above their emergency rating in the DC
 * base case, so branch protection trips 26 of them at the first relay sample and the grid
 * cascades; summer-night-low starts with two branches just above their rating and no trip. The
 * data lane (DQ1) is removing the winter overloads; the tests move back to winter with it.
 */
export const norwayRuntimeTestOperatingPointRef = norwaySummerLowOperatingPointRef
