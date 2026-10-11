import { expect, test } from 'bun:test'
import { simulationTimeLabel } from './simulation-time.ts'

test('simulation clocks remain UTC across local offsets, DST, paused copies and maximum pace', () => {
  const instant = { currentSimulationTime: '2026-10-25T02:30:00+02:00', updatedAt: '2026-10-25T00:30:00Z', playback: 'paused' as const, pace: 'realtime' as const }
  const wall = Date.parse(instant.updatedAt) + 120_000
  expect(simulationTimeLabel(instant, wall)).toBe('00:30:00 UTC')
  expect(simulationTimeLabel({ ...instant, currentSimulationTime: '2026-10-25T01:30:00+01:00' }, wall)).toBe('00:30:00 UTC')
  expect(simulationTimeLabel({ ...instant, playback: 'playing' }, wall)).toBe('00:32:00 UTC')
  expect(simulationTimeLabel({ ...instant, playback: 'playing', pace: 'maximum' }, wall)).toBe('00:30:00 UTC')
  expect(simulationTimeLabel({ ...instant, playback: 'playing' }, Date.parse(instant.updatedAt) - 100)).toBe('00:30:00 UTC')
  expect(simulationTimeLabel(null, wall)).toBe('--:--:-- UTC')
  expect(simulationTimeLabel({ ...instant, currentSimulationTime: 'invalid' }, wall)).toBe('--:--:-- UTC')
})
