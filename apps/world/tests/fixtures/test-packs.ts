import { dronePack } from '../../src/packs/drone/pack.ts'
import { electricGridPack } from '../../src/packs/electric-grid/pack.ts'
import { processPlantPack } from '../../src/packs/process-plant/pack.ts'
import { weatherPack } from '../../src/packs/weather/pack.ts'
import { fixturePack } from './fixture-pack.ts'

/** The Packs every core test assembles: the test-only fixture Pack plus the
 * shipped Packs whose own behaviour core tests combine with it. */
export const testPacks = [fixturePack, weatherPack, dronePack, processPlantPack, electricGridPack] as const
