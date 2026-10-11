/** Header-only interpolation; canonical simulation timestamps remain absolute.
 * Maximum pace never extrapolates from wall time, and paused copies retain their
 * exact checkpoint time. All simulation clock surfaces use labelled UTC. */
export const simulationTimeLabel = (execution: {
  readonly currentSimulationTime: string
  readonly updatedAt: string
  readonly playback: 'playing' | 'paused'
  readonly pace: 'realtime' | 'maximum'
} | null, wallNow: number): string => {
  if (!execution) return '--:--:-- UTC'
  const base = Date.parse(execution.currentSimulationTime)
  const updated = Date.parse(execution.updatedAt)
  const value = execution.playback === 'paused' || execution.pace === 'maximum' || !Number.isFinite(updated)
    ? base : base + Math.max(0, wallNow - updated)
  return Number.isFinite(new Date(value).getTime()) ? `${new Date(value).toISOString().slice(11, 19)} UTC` : '--:--:-- UTC'
}
