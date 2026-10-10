export const firstOrderLag = (config: {
  readonly current: number
  readonly target: number
  readonly dtSeconds: number
  readonly timeConstantSeconds: number
}): number => {
  const timeConstant = Math.max(1e-9, config.timeConstantSeconds)
  const fraction = Math.max(0, Math.min(1, config.dtSeconds / timeConstant))
  return config.current + (config.target - config.current) * fraction
}

export const boundedApproach = (config: {
  readonly current: number
  readonly target: number
  readonly maxDelta: number
}): number => {
  if (Math.abs(config.target - config.current) <= config.maxDelta) return config.target
  return config.current + Math.sign(config.target - config.current) * config.maxDelta
}

export const inventoryBalanceStep = (config: {
  readonly currentInventory: number
  readonly inflowKgPerS: number
  readonly outflowKgPerS: number
  readonly dtSeconds: number
  readonly minInventory: number
  readonly maxInventory: number
}): number => {
  const next = config.currentInventory + (config.inflowKgPerS - config.outflowKgPerS) * config.dtSeconds
  return Math.max(config.minInventory, Math.min(config.maxInventory, next))
}

export const pumpHeadResistanceFlowTarget = (config: {
  readonly developedHeadPa: number
  readonly nominalHeadPa: number
  readonly nominalFlowKgPerS: number
  readonly resistanceCoefficient: number
  readonly minimumFlowKgPerS: number
}): number => {
  const headRatio = Math.max(0, config.developedHeadPa) / Math.max(1, config.nominalHeadPa)
  const resistanceFactor = 1 + Math.max(0, config.resistanceCoefficient)
  const hydraulicFlow = config.nominalFlowKgPerS * Math.sqrt(headRatio / resistanceFactor)
  return Math.max(config.minimumFlowKgPerS, hydraulicFlow)
}

export const pressureDropMPaFromFlow = (config: {
  readonly flowKgPerS: number
  readonly nominalFlowKgPerS: number
  readonly nominalPressureDropMPa: number
  readonly resistanceMultiplier?: number
}): number => {
  const flowRatio = Math.max(0, config.flowKgPerS) / Math.max(1, config.nominalFlowKgPerS)
  const resistanceMultiplier = config.resistanceMultiplier ?? 1
  return Math.max(0, config.nominalPressureDropMPa) * Math.max(0, resistanceMultiplier) * flowRatio * flowRatio
}

export const pressureDrivenLeakFlowKgPerS = (config: {
  readonly areaFraction: number
  readonly pressureDeltaMPa: number
  readonly coefficientKgPerSPerSqrtMPa: number
}): number =>
  Math.max(0, Math.min(1, config.areaFraction))
  * Math.max(0, config.coefficientKgPerSPerSqrtMPa)
  * Math.sqrt(Math.max(0, config.pressureDeltaMPa))

export const reactorKineticsPowerStep = (config: {
  readonly currentPowerMw: number
  readonly ratedPowerMw: number
  readonly nominalCriticalPowerMw: number
  readonly effectiveReactivityPcm: number
  readonly dtSeconds: number
  readonly pcmPerEfoldPerSecond: number
  readonly maxPowerRampFractionPerS: number
  readonly maxPowerFraction: number
}): number => {
  const ratedPower = Math.max(1, config.ratedPowerMw)
  const pcmScale = Math.max(1, config.pcmPerEfoldPerSecond)
  const currentPower = Math.max(0, config.currentPowerMw)
  const maxDelta = ratedPower * Math.max(0, config.maxPowerRampFractionPerS) * config.dtSeconds
  const shutdownReactivityThresholdPcm = -500
  if (config.effectiveReactivityPcm <= shutdownReactivityThresholdPcm) {
    const shutdownRatePerS = Math.max(-8, config.effectiveReactivityPcm / pcmScale)
    const shutdownTarget = currentPower * Math.exp(shutdownRatePerS * config.dtSeconds)
    return boundedApproach({
      current: currentPower,
      target: Math.max(0, shutdownTarget),
      maxDelta,
    })
  }

  const exponent = Math.max(-1.5, Math.min(1.5, config.effectiveReactivityPcm / pcmScale))
  const unboundedTarget = Math.max(0, config.nominalCriticalPowerMw) * Math.exp(exponent)
  const boundedTarget = Math.max(0, Math.min(ratedPower * Math.max(0, config.maxPowerFraction), unboundedTarget))
  return boundedApproach({
    current: currentPower,
    target: boundedTarget,
    maxDelta,
  })
}
