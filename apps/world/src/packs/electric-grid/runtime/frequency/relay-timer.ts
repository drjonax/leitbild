/**
 * Time a measured value has continuously been beyond a threshold after one step, with the
 * crossing instant interpolated linearly inside the step. A relay drops off (timer 0) as
 * soon as the value is back on the healthy side at the end of the step.
 */
export const advanceRelayTimer = (config: {
  readonly timerSeconds: number
  readonly previousValue: number
  readonly value: number
  readonly thresholdValue: number
  readonly direction: 'below' | 'above'
  readonly stepSeconds: number
}): number => {
  const beyond = (value: number): boolean => config.direction === 'below' ? value < config.thresholdValue : value > config.thresholdValue
  if (!beyond(config.value)) return 0
  if (beyond(config.previousValue)) return config.timerSeconds + config.stepSeconds
  const share = (config.value - config.thresholdValue) / (config.value - config.previousValue)
  return config.stepSeconds * share
}
