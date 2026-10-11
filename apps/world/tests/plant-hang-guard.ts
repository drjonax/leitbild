import { setDefaultTimeout } from 'bun:test'

/**
 * Hang guard, not a cost budget, for tests that run the four-loop PWR Plant
 * through simulated time. They are single-threaded and CPU-bound, and a
 * runnable thread gets about 8/load of a core on the 8-core build machine:
 * a protection test needing 43 s at load 35 needs about three minutes at the
 * load of 150 a deploy gate has met. A guard must outlast that, so it catches
 * only a test that never ends; what a test costs is judged by the CPU budgets
 * in cpu-cost.ts.
 */
export const PLANT_HANG_GUARD_MS = 1_200_000

/** Every test in the calling file gets the hang guard unless it states its own. */
export const guardPlantTests = (): void => setDefaultTimeout(PLANT_HANG_GUARD_MS)
