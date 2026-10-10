import type { ExternalFrequencyEquivalent, FrequencyUnit } from './types.ts'

/**
 * A frequency-dependent power source with a first-order lag towards a static characteristic.
 * The characteristic must be non-increasing in frequency and bounded.
 */
export interface ResponseElement {
  /** Output at the start of the sub-step. */
  readonly outputMw: number
  readonly timeConstantSeconds: number
  readonly target: (frequencyHz: number) => number
}

export interface SwingSubStepInput {
  readonly nominalFrequencyHz: number
  readonly frequencyHz: number
  readonly kineticEnergyMws: number
  readonly stepSeconds: number
  /** Energy over the step from sources that do not depend on frequency within the step. */
  readonly fixedEnergyMws: number
  /** Served load at nominal frequency, constant over the step. */
  readonly loadMw: number
  /** Load self-regulation as a fraction of load per Hz. */
  readonly loadDampingPerHz: number
  readonly elements: ReadonlyArray<ResponseElement>
}

export interface SwingSubStepResult {
  readonly frequencyHz: number
  /** Mean rate of change of frequency over the step. */
  readonly rocofHzPerSecond: number
  readonly elementOutputsMw: ReadonlyArray<number>
  readonly elementEnergyMws: ReadonlyArray<number>
  readonly loadEnergyMws: number
}

/** Stored kinetic energy E_k = Σ H·S of synchronised machines plus external equivalents. */
export const islandKineticEnergyMws = (
  units: ReadonlyArray<FrequencyUnit>,
  externals: ReadonlyArray<ExternalFrequencyEquivalent>,
): number =>
  units.reduce((sum, unit) => sum + (unit.synchronised && unit.connection === 'synchronous' ? unit.inertiaConstantSeconds * unit.ratedMva : 0), 0)
  + externals.reduce((sum, external) => sum + external.kineticEnergyMws, 0)

/** y/2 − 1 + (1 − e^−y)/y, the energy weight of a lag's input change over a step of y time constants. */
const lagEnergyWeight = (y: number): number =>
  y < 0.01 ? y * y * (1 / 6 - y / 24 + y * y / 120) : y / 2 - 1 - Math.expm1(-y) / y

/** 1 − (1 − e^−y)/y, the share of a lag's input change that reaches its output within the step. */
const lagOutputWeight = (y: number): number =>
  y < 0.01 ? y * (0.5 - y / 6 + y * y / 24) : 1 + Math.expm1(-y) / y

interface PreparedElement {
  readonly element: ResponseElement
  readonly initialTargetMw: number
  readonly decay: number
  readonly baseEnergyMws: number
  readonly energyWeightSeconds: number
  readonly outputWeight: number
}

const derivativeStepHz = 1e-6
const toleranceHz = 1e-13
const maximumIterations = 100

/**
 * Integrates 2·E_k/f0 · df/dt = Σ P − P_load(f) over one sub-step. Each lag is integrated
 * exactly for an input that varies linearly between the targets at the start and end
 * frequency, and the end frequency is solved implicitly, so the step is unconditionally
 * stable and second-order accurate.
 */
export const integrateSwingSubStep = (input: SwingSubStepInput): SwingSubStepResult => {
  const h = input.stepSeconds
  if (!(h > 0) || !Number.isFinite(h)) throw new Error(`swing sub-step must be positive: ${h}`)
  if (!(input.kineticEnergyMws > 0)) throw new Error(`swing equation needs positive kinetic energy, got ${input.kineticEnergyMws} MWs`)
  const inertiaMwsPerHz = 2 * input.kineticEnergyMws / input.nominalFrequencyHz
  const f0 = input.frequencyHz
  const deviationHz = f0 - input.nominalFrequencyHz
  const dampingMwPerHz = input.loadMw * input.loadDampingPerHz
  const prepared: PreparedElement[] = input.elements.map(element => {
    const T = element.timeConstantSeconds
    if (!(T > 0)) throw new Error(`response time constant must be positive: ${T}`)
    const y = h / T
    const initialTargetMw = element.target(f0)
    return {
      element,
      initialTargetMw,
      decay: Math.exp(-y),
      baseEnergyMws: initialTargetMw * h - (element.outputMw - initialTargetMw) * T * Math.expm1(-y),
      energyWeightSeconds: T * lagEnergyWeight(y),
      outputWeight: lagOutputWeight(y),
    }
  })
  const fixedTermMws = input.loadMw * h * (1 + input.loadDampingPerHz * deviationHz) - input.fixedEnergyMws
    - prepared.reduce((sum, item) => sum + item.baseEnergyMws, 0)
  const ownSlope = inertiaMwsPerHz + dampingMwPerHz * h / 2
  const residual = (x: number): number => {
    let response = 0
    for (const item of prepared) response += item.energyWeightSeconds * (item.element.target(f0 + x) - item.initialTargetMw)
    return ownSlope * x + fixedTermMws - response
  }
  const slope = (x: number): number => {
    let response = 0
    for (const item of prepared) {
      response += item.energyWeightSeconds
        * (item.element.target(f0 + x + derivativeStepHz) - item.element.target(f0 + x - derivativeStepHz)) / (2 * derivativeStepHz)
    }
    return ownSlope - response
  }
  const x = solveIncreasing(residual, slope, ownSlope)
  const f1 = f0 + x
  const elementOutputsMw: number[] = []
  const elementEnergyMws: number[] = []
  for (const item of prepared) {
    const finalTargetMw = item.element.target(f1)
    elementOutputsMw.push(item.initialTargetMw + (item.element.outputMw - item.initialTargetMw) * item.decay
      + (finalTargetMw - item.initialTargetMw) * item.outputWeight)
    elementEnergyMws.push(item.baseEnergyMws + item.energyWeightSeconds * (finalTargetMw - item.initialTargetMw))
  }
  return {
    frequencyHz: f1,
    rocofHzPerSecond: x / h,
    elementOutputsMw,
    elementEnergyMws,
    loadEnergyMws: input.loadMw * h * (1 + input.loadDampingPerHz * (deviationHz + x / 2)),
  }
}

/** Root of a strictly increasing function whose slope is at least minimumSlope everywhere. */
const solveIncreasing = (residual: (x: number) => number, slope: (x: number) => number, minimumSlope: number): number => {
  const r0 = residual(0)
  if (r0 === 0) return 0
  let low = r0 < 0 ? 0 : -r0 / minimumSlope
  let high = r0 < 0 ? -r0 / minimumSlope : 0
  let x = 0
  let r = r0
  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    if (r < 0) low = x
    else high = x
    let next = x - r / slope(x)
    if (!(next >= low && next <= high)) next = (low + high) / 2
    if (Math.abs(next - x) <= toleranceHz) return next
    x = next
    r = residual(x)
    if (r === 0) return x
  }
  throw new Error(`swing sub-step did not converge (bracket ${low}..${high} Hz)`)
}
