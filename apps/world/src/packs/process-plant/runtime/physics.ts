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

export interface DelayedNeutronGroup {
  /** The group's share of all delayed neutrons (beta_i / beta). */
  readonly relativeYield: number
  readonly decayConstantPerS: number
}

/** Below this effective reactivity the core is shut down and its power follows the delayed neutrons alone. */
export const shutdownReactivityThresholdPcm = -500

/**
 * One step of core fission power. Near critical, at power, power follows the
 * reactor's power-reactivity characteristic: the power at which the feedback
 * would hold this reactivity, approached no faster than the ramp limit. Shut
 * down, below -500 pcm, it follows point kinetics with delayed-neutron
 * precursor groups in the prompt-jump approximation: the prompt neutrons drop
 * at once to the share the precursors sustain, beta / (beta - rho), then the
 * precursors decay, the longest-lived group last, so the power settles on a
 * period of about -1 / lambda_1, some -80 s (-1/3 decade a minute).
 *
 * Each precursor group is carried as the fission power it sustains at
 * equilibrium. Every step it relaxes exponentially toward this step's power,
 * and the shut-down power is solved implicitly with it, so the step is stable
 * at any length for a subcritical core.
 */
export const reactorKineticsPowerStep = (config: {
  readonly currentPowerMw: number
  readonly ratedPowerMw: number
  readonly nominalCriticalPowerMw: number
  readonly effectiveReactivityPcm: number
  readonly dtSeconds: number
  readonly pcmPerEfoldPerSecond: number
  readonly maxPowerRampFractionPerS: number
  readonly maxPowerFraction: number
  readonly delayedNeutronFraction: number
  readonly delayedNeutronGroups: ReadonlyArray<DelayedNeutronGroup>
  readonly precursorPowerMw: ReadonlyArray<number>
}): { readonly powerMw: number; readonly precursorPowerMw: ReadonlyArray<number> } => {
  if (config.precursorPowerMw.length !== config.delayedNeutronGroups.length) {
    throw new Error(`reactor kinetics has ${config.precursorPowerMw.length} precursor states for ${config.delayedNeutronGroups.length} delayed-neutron groups`)
  }
  const retained = config.delayedNeutronGroups.map(group => Math.exp(-group.decayConstantPerS * config.dtSeconds))
  const powerMw = config.effectiveReactivityPcm <= shutdownReactivityThresholdPcm
    ? shutDownPower(config, retained)
    : atPowerPower(config)
  return {
    powerMw,
    precursorPowerMw: config.precursorPowerMw.map((precursor, index) => powerMw + (precursor - powerMw) * retained[index]!),
  }
}

const atPowerPower = (config: Parameters<typeof reactorKineticsPowerStep>[0]): number => {
  const ratedPower = Math.max(1, config.ratedPowerMw)
  const pcmScale = Math.max(1, config.pcmPerEfoldPerSecond)
  const exponent = Math.max(-1.5, Math.min(1.5, config.effectiveReactivityPcm / pcmScale))
  const unboundedTarget = Math.max(0, config.nominalCriticalPowerMw) * Math.exp(exponent)
  const boundedTarget = Math.max(0, Math.min(ratedPower * Math.max(0, config.maxPowerFraction), unboundedTarget))
  return boundedApproach({
    current: Math.max(0, config.currentPowerMw),
    target: boundedTarget,
    maxDelta: ratedPower * Math.max(0, config.maxPowerRampFractionPerS) * config.dtSeconds,
  })
}

// P (beta - rho) = sum beta_i s_i at the end of the step, with each s_i
// relaxed toward that P: P = sum a_i s_i e_i / (sum a_i e_i - rho / beta).
const shutDownPower = (config: Parameters<typeof reactorKineticsPowerStep>[0], retained: ReadonlyArray<number>): number => {
  const reactivityDollars = config.effectiveReactivityPcm * 1e-5 / config.delayedNeutronFraction
  let sustained = 0
  let retainedYield = 0
  config.delayedNeutronGroups.forEach((group, index) => {
    sustained += group.relativeYield * Math.max(0, config.precursorPowerMw[index]!) * retained[index]!
    retainedYield += group.relativeYield * retained[index]!
  })
  return sustained / (retainedYield - reactivityDollars)
}

/**
 * One step of a fission-product decay-heat group: the share of fission power
 * it holds at equilibrium, relaxed exponentially over the step toward this
 * step's fission power, so the step is exact for steady power at any length.
 */
export const decayHeatGroupStep = (config: {
  readonly currentMw: number
  readonly fissionPowerMw: number
  readonly fractionOfFissionPower: number
  readonly timeConstantS: number
  readonly dtSeconds: number
}): number => {
  const equilibrium = config.fissionPowerMw * config.fractionOfFissionPower
  return equilibrium + (config.currentMw - equilibrium) * Math.exp(-config.dtSeconds / config.timeConstantS)
}
