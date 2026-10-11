import type { GridAutomation } from '../../schemas/grid-automation.ts'
import { afrrCapacity, distributeAfrrRequest, runAgcCycle, type AgcState, type EnabledAfrr } from './agc.ts'
import { evaluateGeneratorProtection } from './generator-protection.ts'
import { fcrDDownActivation, fcrDUpActivation, fcrNActivation } from './governors.ts'
import type { ExternalFrequencyState, FrequencyAction, IslandFrequencyState, UnitFrequencyState } from './island-state.ts'
import { validateIslandInput } from './island-state.ts'
import { evaluateLfdd, lfddShedFractionByLoad, type LfddState } from './lfdd.ts'
import { distributeMfrrActivation, evaluateMfrr, idleMfrrRamp, mfrrOutputMw, mfrrRampInProgress, mfrrTiming, type MfrrState, type MfrrTiming, type MfrrUnitRamp } from './mfrr.ts'
import { completeStorageSubStep, planStorageSubStep, type StorageFrequencyState, type StorageOperatingState } from './storage.ts'
import { integrateSwingSubStep, islandKineticEnergyMws, lagOutputWeight, type ResponseElement } from './swing.ts'
import type { ExternalFrequencyEquivalent, FrequencyUnit, IslandFrequencyInput } from './types.ts'

export interface UnitFrequencyOutput {
  readonly id: string
  readonly synchronised: boolean
  readonly outputMw: number
  readonly scheduledMw: number
  readonly fcrNMw: number
  readonly fcrDMw: number
  /** aFRR and mFRR act as adjustments on top of the unit's targetMw. */
  readonly afrrMw: number
  readonly mfrrMw: number
}

export interface StorageFrequencyOutput {
  readonly id: string
  readonly powerMw: number
  readonly responseMw: number
  readonly stateOfChargeFraction: number
  readonly operatingState: StorageOperatingState
  readonly limitedByStateOfCharge: boolean
}

export interface LoadFrequencyOutput {
  readonly id: string
  /** Served demand at the island frequency, after LFDD and load self-regulation. */
  readonly servedMw: number
  readonly lfddShedMw: number
}

export interface ExternalFrequencyOutput {
  readonly id: string
  /** Net power the external system releases towards the island before inertial sharing: schedule, reserves and demand self-regulation. */
  readonly mechanicalMw: number
  readonly fcrNMw: number
  readonly fcrDMw: number
  readonly afrrMw: number
}

export interface IslandFrequencyAdvance {
  readonly state: IslandFrequencyState
  readonly actions: ReadonlyArray<FrequencyAction>
  readonly units: ReadonlyArray<UnitFrequencyOutput>
  readonly storage: ReadonlyArray<StorageFrequencyOutput>
  readonly loads: ReadonlyArray<LoadFrequencyOutput>
  readonly externals: ReadonlyArray<ExternalFrequencyOutput>
  readonly kineticEnergyMws: number
  /**
   * Σ mechanical power − served load − losses at the end of the advance (MW): the power the
   * synchronous machines' kinetic energy supplies (negative) or absorbs at that instant.
   */
  readonly acceleratingPowerMw: number
  /** Lowest and highest frequency reached at any sub-step boundary of this advance. */
  readonly extremes: { readonly minimumHz: number; readonly minimumAtSeconds: number; readonly maximumHz: number; readonly maximumAtSeconds: number } | null
  /** Island aFRR request, the part providers deliver, and the request as a share of allocated aFRR. */
  readonly afrr: { readonly requestMw: number; readonly deliveredMw: number; readonly utilisation: number } | null
}

const stepTolerance = 1e-9

const limited = (outputMw: number, upMw: number, downMw: number): number => Math.min(upMw, Math.max(-downMw, outputMw))

/**
 * Output band of a synchronised unit at a set-point: [minimum, maximum], widened only to hold a
 * set-point outside it. Governor, aFRR and mFRR output stay inside it; only the set-point (a stop)
 * takes a unit below its minimum.
 */
const bandLowMw = (unit: FrequencyUnit, scheduledMw: number): number => Math.min(unit.minimumMw, scheduledMw)
const bandHighMw = (unit: FrequencyUnit, scheduledMw: number): number => Math.max(unit.maximumMw, scheduledMw)

/** mFRR a unit delivers at a set-point: its activation, limited so set-point plus mFRR stays in the band. */
const deliveredMfrrMw = (unit: FrequencyUnit, scheduledMw: number, activationMw: number): number =>
  Math.min(bandHighMw(unit, scheduledMw) - scheduledMw, Math.max(bandLowMw(unit, scheduledMw) - scheduledMw, activationMw))

type WorkingUnitState = { -readonly [K in keyof UnitFrequencyState]: UnitFrequencyState[K] }

/** Exact integral of an mFRR activation over [t0, t1]: held through preparation, linear during the ramp, held after. */
const mfrrEnergyMws = (ramp: MfrrUnitRamp, t0: number, t1: number, timing: MfrrTiming): number => {
  if (ramp.fromMw === ramp.toMw) return ramp.toMw * (t1 - t0)
  const rampStart = ramp.startedAtSeconds + timing.preparationSeconds
  const rampSeconds = timing.fullActivationSeconds - timing.preparationSeconds
  const rampEnd = rampStart + rampSeconds
  const a = Math.min(rampEnd, Math.max(rampStart, t0))
  const b = Math.min(rampEnd, Math.max(rampStart, t1))
  const before = Math.max(0, Math.min(t1, rampStart) - t0) * ramp.fromMw
  const after = Math.max(0, t1 - Math.max(t0, rampEnd)) * ramp.toMw
  const during = (b - a) * (ramp.fromMw + (ramp.toMw - ramp.fromMw) * ((a + b) / 2 - rampStart) / rampSeconds)
  return before + during + after
}

/**
 * The synchronised units of one advance as typed arrays: parameters, working state, the per-unit
 * scratch of a sub-step, and the sub-step's sums. The sub-step kernels below run on them as small
 * module-level functions, which the JIT optimises where the large advance function stays slow
 * (Norway: about 850 units over 20 sub-steps per 2 s tick).
 */
interface UnitArrays {
  readonly count: number
  readonly targetMw: Float64Array
  readonly rampMwPerSecond: Float64Array
  readonly minimumMw: Float64Array
  readonly maximumMw: Float64Array
  readonly fcrNReserveMw: Float64Array
  readonly fcrDUpReserveMw: Float64Array
  readonly fcrDDownReserveMw: Float64Array
  readonly scheduledMw: Float64Array
  readonly afrrMw: Float64Array
  readonly fcrNMw: Float64Array
  readonly fcrDUpMw: Float64Array
  readonly fcrDDownMw: Float64Array
  /** Scratch of one sub-step: scheduled end, FCR starting outputs and caps. */
  readonly scheduledEnd: Float64Array
  readonly nStart: Float64Array
  readonly nUp: Float64Array
  readonly nDown: Float64Array
  readonly dUpStart: Float64Array
  readonly dUpCap: Float64Array
  readonly dDownStart: Float64Array
  readonly dDownCap: Float64Array
  /** Fixed energy (MWs) and the FCR-N, FCR-D up and FCR-D down starting outputs and caps summed over the units. */
  readonly sums: Float64Array
  /** True while the arrays hold working state the objects do not have yet. */
  ahead: boolean
}

const createUnitArrays = (count: number): UnitArrays => ({
  count,
  targetMw: new Float64Array(count),
  rampMwPerSecond: new Float64Array(count),
  minimumMw: new Float64Array(count),
  maximumMw: new Float64Array(count),
  fcrNReserveMw: new Float64Array(count),
  fcrDUpReserveMw: new Float64Array(count),
  fcrDDownReserveMw: new Float64Array(count),
  scheduledMw: new Float64Array(count),
  afrrMw: new Float64Array(count),
  fcrNMw: new Float64Array(count),
  fcrDUpMw: new Float64Array(count),
  fcrDDownMw: new Float64Array(count),
  scheduledEnd: new Float64Array(count),
  nStart: new Float64Array(count),
  nUp: new Float64Array(count),
  nDown: new Float64Array(count),
  dUpStart: new Float64Array(count),
  dUpCap: new Float64Array(count),
  dDownStart: new Float64Array(count),
  dDownCap: new Float64Array(count),
  sums: new Float64Array(8),
  ahead: false,
})

/** Reads the synchronised units and their working states into the arrays. */
const loadUnitArraysFrom = (arrays: UnitArrays, units: ReadonlyArray<FrequencyUnit>, states: ReadonlyArray<WorkingUnitState>): void => {
  for (let index = 0; index < arrays.count; index += 1) {
    const unit = units[index]!
    const current = states[index]!
    arrays.targetMw[index] = unit.targetMw
    arrays.rampMwPerSecond[index] = unit.rampRateMwPerSecond
    arrays.minimumMw[index] = unit.minimumMw
    arrays.maximumMw[index] = unit.maximumMw
    arrays.fcrNReserveMw[index] = unit.reserves.fcrNMw
    arrays.fcrDUpReserveMw[index] = unit.reserves.fcrDUpMw
    arrays.fcrDDownReserveMw[index] = unit.reserves.fcrDDownMw
    arrays.scheduledMw[index] = current.scheduledMw
    arrays.afrrMw[index] = current.afrrMw
    arrays.fcrNMw[index] = current.fcrNMw
    arrays.fcrDUpMw[index] = current.fcrDUpMw
    arrays.fcrDDownMw[index] = current.fcrDDownMw
  }
  arrays.ahead = false
}

/** Writes the arrays' working state back into the working state objects. */
const flushUnitArraysInto = (arrays: UnitArrays, states: ReadonlyArray<WorkingUnitState>): void => {
  if (!arrays.ahead) return
  for (let index = 0; index < arrays.count; index += 1) {
    const current = states[index]!
    current.scheduledMw = arrays.scheduledMw[index]!
    current.afrrMw = arrays.afrrMw[index]!
    current.fcrNMw = arrays.fcrNMw[index]!
    current.fcrDUpMw = arrays.fcrDUpMw[index]!
    current.fcrDDownMw = arrays.fcrDDownMw[index]!
  }
  arrays.ahead = false
}

/**
 * First half of a sub-step for every synchronised unit: the set-point ramp and its exact energy,
 * delivered mFRR within the output band, aFRR held within the room both leave, and the FCR-N and
 * FCR-D caps from the remaining headroom. Accumulates onto `fixedEnergyMws` in unit order.
 */
const planUnitSubStep = (arrays: UnitArrays, states: ReadonlyArray<WorkingUnitState>, step: {
  readonly stepSeconds: number
  readonly t0: number
  readonly t1: number
  readonly mfrrEnabled: boolean
  readonly mfrrTimes: MfrrTiming
  readonly fixedEnergyMws: number
}): void => {
  const { stepSeconds, t0, t1, mfrrEnabled, mfrrTimes } = step
  const { scheduledEnd, nStart, nUp, nDown, dUpStart, dUpCap, dDownStart, dDownCap } = arrays
  let fixedEnergyMws = step.fixedEnergyMws
  let nStartSum = 0
  let nUpSum = 0
  let nDownSum = 0
  let dUpStartSum = 0
  let dUpSum = 0
  let dDownStartSum = 0
  let dDownSum = 0
  arrays.ahead = true
  for (let index = 0; index < arrays.count; index += 1) {
    const minimumMw = arrays.minimumMw[index]!
    const maximumMw = arrays.maximumMw[index]!
    // Set-point follows the target at the ramp rate; its energy is the exact integral of that ramp.
    const fromMw = arrays.scheduledMw[index]!
    const targetMw = arrays.targetMw[index]!
    let endMw = targetMw
    let scheduledEnergyMws = targetMw * stepSeconds
    if (fromMw !== targetMw) {
      const rampRateMwPerSecond = arrays.rampMwPerSecond[index]!
      const reachSeconds = Math.abs(targetMw - fromMw) / rampRateMwPerSecond
      if (reachSeconds >= stepSeconds) {
        endMw = fromMw + Math.sign(targetMw - fromMw) * rampRateMwPerSecond * stepSeconds
        scheduledEnergyMws = (fromMw + endMw) / 2 * stepSeconds
      } else {
        scheduledEnergyMws = (fromMw + targetMw) / 2 * reachSeconds + targetMw * (stepSeconds - reachSeconds)
      }
    }
    scheduledEnd[index] = endMw
    // Output band at both ends of the sub-step (bandLowMw, bandHighMw).
    const lowStartMw = Math.min(minimumMw, fromMw)
    const highStartMw = Math.max(maximumMw, fromMw)
    const lowEndMw = Math.min(minimumMw, endMw)
    const highEndMw = Math.max(maximumMw, endMw)
    let mfrrStartMw = 0
    let mfrrEndMw = 0
    let mfrrEnergyMw = 0
    if (mfrrEnabled) {
      const ramp = states[index]!.mfrr
      if (ramp.fromMw === ramp.toMw) {
        mfrrStartMw = ramp.toMw
        mfrrEndMw = ramp.toMw
        mfrrEnergyMw = ramp.toMw * stepSeconds
      } else {
        mfrrStartMw = mfrrOutputMw(ramp, t0, mfrrTimes)
        mfrrEndMw = mfrrOutputMw(ramp, t1, mfrrTimes)
        mfrrEnergyMw = mfrrEnergyMws(ramp, t0, t1, mfrrTimes)
      }
      // deliveredMfrrMw at each end.
      const deliveredStartMw = Math.min(highStartMw - fromMw, Math.max(lowStartMw - fromMw, mfrrStartMw))
      const deliveredEndMw = Math.min(highEndMw - endMw, Math.max(lowEndMw - endMw, mfrrEndMw))
      if (deliveredStartMw !== mfrrStartMw || deliveredEndMw !== mfrrEndMw) {
        // Where the band binds, delivered mFRR is taken linear across the sub-step.
        mfrrStartMw = deliveredStartMw
        mfrrEndMw = deliveredEndMw
        mfrrEnergyMw = (deliveredStartMw + deliveredEndMw) / 2 * stepSeconds
      }
    }
    // aFRR follows its share only within the room set-point and mFRR leave in the band at both
    // ends of the sub-step; 0 always fits, since set-point plus mFRR lies in the band.
    const afrrLowMw = Math.max(lowStartMw - fromMw - mfrrStartMw, lowEndMw - endMw - mfrrEndMw)
    const afrrHighMw = Math.min(highStartMw - fromMw - mfrrStartMw, highEndMw - endMw - mfrrEndMw)
    let afrrMw = arrays.afrrMw[index]!
    if (afrrMw > afrrHighMw) afrrMw = afrrHighMw
    else if (afrrMw < afrrLowMw) afrrMw = afrrLowMw
    arrays.afrrMw[index] = afrrMw
    fixedEnergyMws += scheduledEnergyMws + afrrMw * stepSeconds + mfrrEnergyMw
    const baseStartMw = fromMw + afrrMw + mfrrStartMw
    const baseEndMw = endMw + afrrMw + mfrrEndMw
    // Headroom split between FCR-N and FCR-D, FCR-N first (see unitFcrCaps).
    const upRoom = Math.max(0, maximumMw - Math.max(baseStartMw, baseEndMw))
    const downRoom = Math.max(0, Math.min(baseStartMw, baseEndMw) - minimumMw)
    const fcrNReserveMw = arrays.fcrNReserveMw[index]!
    const capNUp = Math.min(fcrNReserveMw, upRoom)
    const capNDown = Math.min(fcrNReserveMw, downRoom)
    if (fcrNReserveMw > 0) {
      const startMw = limited(arrays.fcrNMw[index]!, capNUp, capNDown)
      nStart[index] = startMw
      nUp[index] = capNUp
      nDown[index] = capNDown
      nStartSum += startMw
      nUpSum += capNUp
      nDownSum += capNDown
    }
    const fcrDUpReserveMw = arrays.fcrDUpReserveMw[index]!
    if (fcrDUpReserveMw > 0) {
      const cap = Math.min(fcrDUpReserveMw, upRoom - capNUp)
      const startMw = limited(arrays.fcrDUpMw[index]!, cap, 0)
      dUpStart[index] = startMw
      dUpCap[index] = cap
      dUpStartSum += startMw
      dUpSum += cap
    }
    const fcrDDownReserveMw = arrays.fcrDDownReserveMw[index]!
    if (fcrDDownReserveMw > 0) {
      const cap = Math.min(fcrDDownReserveMw, downRoom - capNDown)
      const startMw = limited(arrays.fcrDDownMw[index]!, 0, cap)
      dDownStart[index] = startMw
      dDownCap[index] = cap
      dDownStartSum += startMw
      dDownSum += cap
    }
  }
  const sums = arrays.sums
  sums[0] = fixedEnergyMws
  sums[1] = nStartSum
  sums[2] = nUpSum
  sums[3] = nDownSum
  sums[4] = dUpStartSum
  sums[5] = dUpSum
  sums[6] = dDownStartSum
  sums[7] = dDownSum
}

interface LagUpdate { readonly decay: number; readonly weight: number }

/** A first-order lag's exact output after a sub-step whose target moves linearly from target0 to target1. */
const laggedMw = (startMw: number, target0: number, target1: number, lag: LagUpdate): number =>
  target0 + (startMw - target0) * lag.decay + (target1 - target0) * lag.weight

/** Second half of a sub-step: set-points at their ramp end, FCR outputs after their lags towards the activation at both ends. */
const completeUnitSubStep = (arrays: UnitArrays, step: {
  readonly aN0: number
  readonly aN1: number
  readonly aDUp0: number
  readonly aDUp1: number
  readonly aDDown0: number
  readonly aDDown1: number
  readonly nLag: LagUpdate
  readonly dUpLag: LagUpdate
  readonly dDownLag: LagUpdate
}): void => {
  const { aN0, aN1, aDUp0, aDUp1, aDDown0, aDDown1, nLag, dUpLag, dDownLag } = step
  const { scheduledEnd, nStart, nUp, nDown, dUpStart, dUpCap, dDownStart, dDownCap } = arrays
  arrays.ahead = true
  for (let index = 0; index < arrays.count; index += 1) {
    arrays.scheduledMw[index] = scheduledEnd[index]!
    if (arrays.fcrNReserveMw[index]! > 0) {
      const up = nUp[index]!
      const down = nDown[index]!
      arrays.fcrNMw[index] = laggedMw(nStart[index]!, aN0 * (aN0 >= 0 ? up : down), aN1 * (aN1 >= 0 ? up : down), nLag)
    }
    if (arrays.fcrDUpReserveMw[index]! > 0) arrays.fcrDUpMw[index] = laggedMw(dUpStart[index]!, aDUp0 * dUpCap[index]!, aDUp1 * dUpCap[index]!, dUpLag)
    if (arrays.fcrDDownReserveMw[index]! > 0) arrays.fcrDDownMw[index] = laggedMw(dDownStart[index]!, aDDown0 * dDownCap[index]!, aDDown1 * dDownCap[index]!, dDownLag)
  }
}

const outOfService = (unit: UnitFrequencyState): UnitFrequencyState =>
  ({ ...unit, scheduledMw: 0, fcrNMw: 0, fcrDUpMw: 0, fcrDDownMw: 0, afrrMw: 0, mfrr: idleMfrrRamp })

/**
 * Advances one synchronous island by dtSeconds in fixed sub-steps of the automation's
 * subStepSeconds (a shorter final step covers any remainder). Within each sub-step the swing
 * equation, governors, storage, protection and LFDD are evaluated; aFRR and mFRR run on their
 * own cycle. Returns new state, per-asset outputs and the discrete actions taken.
 */
export const advanceIslandFrequency = (
  automation: GridAutomation,
  state: IslandFrequencyState,
  input: IslandFrequencyInput,
  dtSeconds: number,
): IslandFrequencyAdvance => {
  if (!Number.isFinite(dtSeconds) || dtSeconds < 0) throw new Error(`frequency advance needs a finite non-negative step, got ${dtSeconds}`)
  if (dtSeconds > automation.simulation.maximumCatchUpSeconds) {
    throw new Error(`frequency advance of ${dtSeconds} s exceeds the maximum catch-up of ${automation.simulation.maximumCatchUpSeconds} s for island ${input.islandId}`)
  }
  if (state.frequencyHz === null) throw new Error(`island ${state.islandId} has collapsed; it must be re-energised with a new frequency state`)
  validateIslandInput(automation, state, input)
  const nominalHz = automation.swing.nominalFrequencyHz
  const dampingPerHz = automation.swing.loadDampingPercentPerHz / 100
  const h = automation.simulation.subStepSeconds
  const actions: FrequencyAction[] = []
  let units: FrequencyUnit[] = [...input.units]
  // Working copies local to this advance; the input state is never mutated.
  const unitStates = new Map<string, WorkingUnitState>(input.units.map(unit => {
    const current = state.units[unit.id]!
    return [unit.id, { ...(unit.synchronised ? current : outOfService(current)) }]
  }))
  const storageStates = new Map(input.storage.map(unit => [unit.id, state.storage[unit.id]!] as const))
  const storageLimited = new Map<string, boolean>(input.storage.map(unit => [unit.id, false]))
  const storageScheduled = new Map(input.storage.map(unit => [unit.id, unit.connected ? unit.scheduledMw : 0] as const))
  const externalStates = new Map<string, ExternalFrequencyState>(input.externals.map(external => [external.id, state.externals[external.id]!] as const))
  const externalDampingMwPerHz = input.externals.reduce((sum, external) => sum + external.loadMw * dampingPerHz, 0)
  let agc = state.agc
  let mfrr = state.mfrr
  let lfdd = state.lfdd
  let frequencyHz = state.frequencyHz
  let rocofHzPerSecond = state.rocofHzPerSecond
  let elapsedSeconds = state.elapsedSeconds
  let collapsed = false
  const extremes: { minimumHz: number; minimumAtSeconds: number; maximumHz: number; maximumAtSeconds: number } | null =
    dtSeconds > 0 ? { minimumHz: frequencyHz, minimumAtSeconds: elapsedSeconds, maximumHz: frequencyHz, maximumAtSeconds: elapsedSeconds } : null
  const mfrrAt = (ramp: MfrrUnitRamp, atSeconds: number): number =>
    automation.mfrr.enabled ? mfrrOutputMw(ramp, atSeconds, mfrrTiming(automation.mfrr)) : 0
  for (const unit of input.storage) {
    const current = storageStates.get(unit.id)!
    if (unit.connected || current.operatingState === 'disconnected') continue
    storageStates.set(unit.id, { ...current, responseMw: 0, operatingState: 'disconnected' })
    actions.push({ kind: 'storage-state-changed', storageId: unit.id, atSeconds: elapsedSeconds, from: current.operatingState, to: 'disconnected' })
  }
  const fullSteps = Math.floor(dtSeconds / h + stepTolerance)
  const remainderSeconds = dtSeconds - fullSteps * h
  const stepCount = fullSteps + (remainderSeconds > stepTolerance ? 1 : 0)
  const mfrrEnabled = automation.mfrr.enabled
  const mfrrTimes: MfrrTiming = automation.mfrr.enabled ? mfrrTiming(automation.mfrr) : { preparationSeconds: 0, fullActivationSeconds: 1 }

  // Synchronised units and their working states, kept in step; rebuilt only after a protection trip.
  let active: FrequencyUnit[] = []
  let activeStates: WorkingUnitState[] = []
  const collectActive = (): void => {
    active = units.filter(unit => unit.synchronised)
    activeStates = active.map(unit => unitStates.get(unit.id)!)
  }
  collectActive()
  let kineticEnergyMws = islandKineticEnergyMws(units, input.externals)
  // True while every synchronised unit's protection relays sit at zero with no trip.
  let relaysAtRest = activeStates.every(state => protectionAtRest(state.protection))
  let servedNominalMw = servedAtNominalMw(input, lfddShedFractionByLoad(lfdd))
  // The synchronised units as typed arrays for the sub-step kernels; the working state objects
  // are brought up to date (flush) before anything else reads them and reloaded after anything writes them.
  let arrays = createUnitArrays(active.length)
  const resizeScratch = (): void => { arrays = createUnitArrays(active.length) }
  const loadUnitArrays = (): void => loadUnitArraysFrom(arrays, active, activeStates)
  const flushUnitArrays = (): void => flushUnitArraysInto(arrays, activeStates)
  loadUnitArrays()
  const fcrNConfig = automation.fcrN
  const fcrDUpConfig = automation.fcrD.up
  const fcrDDownConfig = automation.fcrD.down

  for (let stepIndex = 0; stepIndex < stepCount; stepIndex += 1) {
    const stepSeconds = stepIndex < fullSteps ? h : remainderSeconds
    const t0 = elapsedSeconds
    const t1 = t0 + stepSeconds
    if (kineticEnergyMws <= 0) {
      collapsed = true
      actions.push({ kind: 'island-collapsed', atSeconds: t0, cause: 'no-synchronous-inertia' })
      break
    }
    const f0 = frequencyHz

    if (automation.afrr.enabled && agc) {
      while (t0 + stepTolerance >= agc.nextCycleAtSeconds) {
        flushUnitArrays()
        const cycle = runRestorationCycle({ automation, afrr: automation.afrr, agc, mfrr, units, unitStates, storageStates, externalStates, input, lfdd, frequencyHz: f0, nowSeconds: t0, mfrrAt })
        agc = cycle.agc
        mfrr = cycle.mfrr
        if (cycle.action) actions.push(cycle.action)
        loadUnitArrays()
      }
    }

    const elements: ResponseElement[] = []
    const applyElement: Array<(outputMw: number, energyMws: number) => void> = []
    let fixedEnergyMws = (input.fixedInjectionMw - input.lossesMw) * stepSeconds
    planUnitSubStep(arrays, activeStates, { stepSeconds, t0, t1, mfrrEnabled, mfrrTimes, fixedEnergyMws })
    const sums = arrays.sums
    fixedEnergyMws = sums[0]!
    let nStartSum = sums[1]!
    let nUpSum = sums[2]!
    let nDownSum = sums[3]!
    let dUpStartSum = sums[4]!
    let dUpSum = sums[5]!
    let dDownStartSum = sums[6]!
    let dDownSum = sums[7]!
    const storagePlans = input.storage.map(unit => {
      if (!unit.connected) return null
      const plan = planStorageSubStep(automation.storage, automation.fcrD, unit, storageStates.get(unit.id)!, {
        frequencyHz: f0, nominalFrequencyHz: nominalHz, nowSeconds: t0, stepSeconds,
      })
      fixedEnergyMws += plan.scheduledMw * stepSeconds
      storageScheduled.set(unit.id, plan.scheduledMw)
      if (plan.limitedByStateOfCharge) storageLimited.set(unit.id, true)
      return plan
    })
    const storageResponse = new Map<string, { endMw: number; energyMws: number }>()
    input.storage.forEach((unit, index) => {
      const plan = storagePlans[index]
      if (!plan) return
      if (plan.element) {
        elements.push(plan.element)
        applyElement.push((outputMw, energyMws) => storageResponse.set(unit.id, { endMw: outputMw, energyMws }))
      } else if (plan.ffr) {
        const energyMws = (plan.ffr.startMw + plan.ffr.endMw) / 2 * stepSeconds
        fixedEnergyMws += energyMws
        storageResponse.set(unit.id, { endMw: plan.ffr.endMw, energyMws })
      } else {
        storageResponse.set(unit.id, { endMw: 0, energyMws: 0 })
      }
    })
    for (const external of input.externals) {
      const current = externalStates.get(external.id)!
      fixedEnergyMws += (external.scheduledImportMw + current.afrrMw) * stepSeconds
      const reserves = external.reserves
      if (reserves.fcrNMw > 0) {
        nStartSum += limited(current.fcrNMw, reserves.fcrNMw, reserves.fcrNMw)
        nUpSum += reserves.fcrNMw
        nDownSum += reserves.fcrNMw
      }
      if (reserves.fcrDUpMw > 0) {
        dUpStartSum += limited(current.fcrDUpMw, reserves.fcrDUpMw, 0)
        dUpSum += reserves.fcrDUpMw
      }
      if (reserves.fcrDDownMw > 0) {
        dDownStartSum += limited(current.fcrDDownMw, 0, reserves.fcrDDownMw)
        dDownSum += reserves.fcrDDownMw
      }
    }
    // FCR targets are linear in each provider's caps, so each product is one aggregate lag in the
    // implicit solve; providers then follow the same closed-form lag update individually.
    const fcrNTarget = (f: number): number => {
      const activation = fcrNActivation(f, nominalHz, fcrNConfig)
      return activation * (activation >= 0 ? nUpSum : nDownSum)
    }
    if (nUpSum > 0 || nDownSum > 0) {
      elements.push({ outputMw: nStartSum, timeConstantSeconds: fcrNConfig.timeConstantSeconds, target: fcrNTarget })
      applyElement.push(() => undefined)
    }
    if (dUpSum > 0) {
      elements.push({ outputMw: dUpStartSum, timeConstantSeconds: fcrDUpConfig.timeConstantSeconds, target: f => fcrDUpActivation(f, fcrDUpConfig) * dUpSum })
      applyElement.push(() => undefined)
    }
    if (dDownSum > 0) {
      elements.push({ outputMw: dDownStartSum, timeConstantSeconds: fcrDDownConfig.timeConstantSeconds, target: f => -fcrDDownActivation(f, fcrDDownConfig) * dDownSum })
      applyElement.push(() => undefined)
    }

    const step = integrateSwingSubStep({
      nominalFrequencyHz: nominalHz,
      frequencyHz: f0,
      kineticEnergyMws,
      stepSeconds,
      fixedEnergyMws,
      loadMw: servedNominalMw,
      loadDampingPerHz: dampingPerHz,
      externalDampingMwPerHz,
      elements,
    })
    step.elementOutputsMw.forEach((outputMw, index) => applyElement[index]!(outputMw, step.elementEnergyMws[index]!))
    const f1 = step.frequencyHz
    const lagUpdate = (timeConstantSeconds: number) => {
      const y = stepSeconds / timeConstantSeconds
      return { decay: Math.exp(-y), weight: lagOutputWeight(y) }
    }
    const nLag = lagUpdate(fcrNConfig.timeConstantSeconds)
    const dUpLag = lagUpdate(fcrDUpConfig.timeConstantSeconds)
    const dDownLag = lagUpdate(fcrDDownConfig.timeConstantSeconds)
    const aN0 = fcrNActivation(f0, nominalHz, fcrNConfig)
    const aN1 = fcrNActivation(f1, nominalHz, fcrNConfig)
    const aDUp0 = fcrDUpActivation(f0, fcrDUpConfig)
    const aDUp1 = fcrDUpActivation(f1, fcrDUpConfig)
    const aDDown0 = -fcrDDownActivation(f0, fcrDDownConfig)
    const aDDown1 = -fcrDDownActivation(f1, fcrDDownConfig)
    const lagged = (startMw: number, target0: number, target1: number, lag: { readonly decay: number; readonly weight: number }): number =>
      target0 + (startMw - target0) * lag.decay + (target1 - target0) * lag.weight
    completeUnitSubStep(arrays, { aN0, aN1, aDUp0, aDUp1, aDDown0, aDDown1, nLag, dUpLag, dDownLag })
    for (const external of input.externals) {
      const current = externalStates.get(external.id)!
      const reserves = external.reserves
      const next = { ...current }
      if (reserves.fcrNMw > 0) {
        next.fcrNMw = lagged(limited(current.fcrNMw, reserves.fcrNMw, reserves.fcrNMw), aN0 * reserves.fcrNMw, aN1 * reserves.fcrNMw, nLag)
      }
      if (reserves.fcrDUpMw > 0) next.fcrDUpMw = lagged(limited(current.fcrDUpMw, reserves.fcrDUpMw, 0), aDUp0 * reserves.fcrDUpMw, aDUp1 * reserves.fcrDUpMw, dUpLag)
      if (reserves.fcrDDownMw > 0) next.fcrDDownMw = lagged(limited(current.fcrDDownMw, 0, reserves.fcrDDownMw), aDDown0 * reserves.fcrDDownMw, aDDown1 * reserves.fcrDDownMw, dDownLag)
      externalStates.set(external.id, next)
    }
    input.storage.forEach((unit, index) => {
      const plan = storagePlans[index]
      if (!plan) return
      const before = storageStates.get(unit.id)!
      const response = storageResponse.get(unit.id)!
      const after: StorageFrequencyState = completeStorageSubStep(automation.storage, unit, before, plan, {
        responseEndMw: response.endMw, responseEnergyMws: response.energyMws, stepSeconds, nowSeconds: t1,
      })
      storageStates.set(unit.id, after)
      if (after.operatingState !== before.operatingState) {
        actions.push({ kind: 'storage-state-changed', storageId: unit.id, atSeconds: t1, from: before.operatingState, to: after.operatingState })
      }
    })

    frequencyHz = f1
    rocofHzPerSecond = step.rocofHzPerSecond
    elapsedSeconds = t1
    if (!(frequencyHz > nominalHz * 0.9 && frequencyHz < nominalHz * 1.1)) {
      // Beyond ±10 % within one sub-step, past every relay threshold: each synchronised unit's fastest
      // under- or over-frequency element operates and the island collapses.
      const cause = frequencyHz <= nominalHz * 0.9 ? 'under-frequency' as const : 'over-frequency' as const
      const elements = cause === 'under-frequency' ? automation.generatorProtection.underFrequency : automation.generatorProtection.overFrequency
      const element = [...elements].sort((a, b) => a.delaySeconds - b.delaySeconds)[0]!
      flushUnitArrays()
      for (const unit of active) {
        const current = unitStates.get(unit.id)!
        Object.assign(current, outOfService(current))
        current.protection = { ...current.protection, trip: { atSeconds: t1, elementId: element.id, cause } }
        actions.push({ kind: 'generator-trip', unitId: unit.id, atSeconds: t1, elementId: element.id, cause })
      }
      units = units.map(unit => ({ ...unit, synchronised: false }))
      collapsed = true
      actions.push({ kind: 'island-collapsed', atSeconds: t1, cause: `${cause}-beyond-model-range` })
      break
    }
    if (extremes) {
      if (frequencyHz < extremes.minimumHz) {
        extremes.minimumHz = frequencyHz
        extremes.minimumAtSeconds = t1
      }
      if (frequencyHz > extremes.maximumHz) {
        extremes.maximumHz = frequencyHz
        extremes.maximumAtSeconds = t1
      }
    }

    const tripped = new Set<string>()
    // Inside every pick-up band at both ends of the step, a relay whose timers are all zero stays so.
    const quiet = protectionQuiet(automation.generatorProtection, f0, frequencyHz, rocofHzPerSecond)
    const sweep = !(quiet && relaysAtRest)
    if (sweep) relaysAtRest = quiet
    for (let index = 0; sweep && index < active.length; index += 1) {
      const unit = active[index]!
      const current = activeStates[index]!
      if (quiet && protectionAtRest(current.protection)) continue
      const protection = evaluateGeneratorProtection(automation.generatorProtection, current.protection, {
        previousFrequencyHz: f0, frequencyHz, rocofHzPerSecond, stepSeconds, nowSeconds: t1,
      })
      current.protection = protection
      if (!protectionAtRest(protection)) relaysAtRest = false
      if (protection.trip) {
        tripped.add(unit.id)
        flushUnitArrays()
        Object.assign(current, outOfService(current))
        actions.push({ kind: 'generator-trip', unitId: unit.id, atSeconds: t1, elementId: protection.trip.elementId, cause: protection.trip.cause })
      }
    }
    if (tripped.size > 0) {
      units = units.map(unit => tripped.has(unit.id) ? { ...unit, synchronised: false } : unit)
      collectActive()
      resizeScratch()
      loadUnitArrays()
      kineticEnergyMws = islandKineticEnergyMws(units, input.externals)
    }

    const lfddStep = evaluateLfdd(automation.lfdd, lfdd, { previousFrequencyHz: f0, frequencyHz, stepSeconds, nowSeconds: t1, loads: input.loads })
    lfdd = lfddStep.state
    for (const operation of lfddStep.operations) actions.push({ kind: 'lfdd-stage-operated', ...operation })
    if (lfddStep.operations.length > 0) servedNominalMw = servedAtNominalMw(input, lfddShedFractionByLoad(lfdd))
  }

  flushUnitArrays()
  const shedFractions = lfddShedFractionByLoad(lfdd)
  const finalFrequencyHz = collapsed ? null : frequencyHz
  const selfRegulation = finalFrequencyHz === null ? 0 : 1 + dampingPerHz * (finalFrequencyHz - nominalHz)
  const unitOutputs = units.map(unit => {
    const current = unitStates.get(unit.id)!
    const mfrrMw = unit.synchronised ? deliveredMfrrMw(unit, current.scheduledMw, mfrrAt(current.mfrr, elapsedSeconds)) : 0
    const fcrDMw = current.fcrDUpMw + current.fcrDDownMw
    return {
      id: unit.id,
      synchronised: unit.synchronised && !collapsed,
      outputMw: collapsed || !unit.synchronised ? 0 : current.scheduledMw + current.fcrNMw + fcrDMw + current.afrrMw + mfrrMw,
      scheduledMw: current.scheduledMw,
      fcrNMw: current.fcrNMw,
      fcrDMw,
      afrrMw: current.afrrMw,
      mfrrMw,
    }
  })
  const storageOutputs = input.storage.map(unit => {
    const current = storageStates.get(unit.id)!
    const powerMw = unit.connected && !collapsed ? storageScheduled.get(unit.id)! + current.responseMw : 0
    return {
      id: unit.id,
      powerMw,
      responseMw: current.responseMw,
      stateOfChargeFraction: current.stateOfChargeFraction,
      operatingState: current.operatingState,
      limitedByStateOfCharge: storageLimited.get(unit.id)!,
    }
  })
  const loadOutputs = input.loads.map(load => {
    const fraction = shedFractions.get(load.id) ?? 0
    return { id: load.id, servedMw: load.demandMw * (1 - fraction) * selfRegulation, lfddShedMw: load.demandMw * fraction }
  })
  const externalOutputs = input.externals.map(external => externalOutput(external, externalStates.get(external.id)!, finalFrequencyHz, nominalHz, dampingPerHz))
  const acceleratingPowerMw = collapsed ? 0
    : unitOutputs.reduce((sum, unit) => sum + unit.outputMw, 0)
      + storageOutputs.reduce((sum, unit) => sum + unit.powerMw, 0)
      + externalOutputs.reduce((sum, external) => sum + external.mechanicalMw, 0)
      + input.fixedInjectionMw - input.lossesMw
      - loadOutputs.reduce((sum, load) => sum + load.servedMw, 0)
  return {
    state: {
      islandId: state.islandId,
      automationId: state.automationId,
      elapsedSeconds,
      frequencyHz: finalFrequencyHz,
      rocofHzPerSecond: collapsed ? 0 : rocofHzPerSecond,
      // The working states are this advance's own copies: they become the new state as they are.
      units: Object.fromEntries(unitStates),
      storage: Object.fromEntries(storageStates),
      externals: Object.fromEntries(externalStates),
      agc,
      mfrr,
      lfdd,
    },
    actions,
    units: unitOutputs,
    storage: storageOutputs,
    loads: loadOutputs,
    externals: externalOutputs,
    acceleratingPowerMw,
    kineticEnergyMws: collapsed ? 0 : islandKineticEnergyMws(units, input.externals),
    extremes,
    afrr: agc ? afrrStatus(agc.requestMw, units, unitStates, input.externals, externalStates) : null,
  }
}

const externalOutput = (
  external: ExternalFrequencyEquivalent,
  current: ExternalFrequencyState,
  frequencyHz: number | null,
  nominalHz: number,
  dampingPerHz: number,
): ExternalFrequencyOutput => {
  const fcrDMw = current.fcrDUpMw + current.fcrDDownMw
  const selfRegulationMw = frequencyHz === null ? 0 : -external.loadMw * dampingPerHz * (frequencyHz - nominalHz)
  return {
    id: external.id,
    mechanicalMw: external.scheduledImportMw + current.fcrNMw + fcrDMw + current.afrrMw + selfRegulationMw,
    fcrNMw: current.fcrNMw,
    fcrDMw,
    afrrMw: current.afrrMw,
  }
}

const protectionQuiet = (config: GridAutomation['generatorProtection'], previousHz: number, frequencyHz: number, rocofHzPerSecond: number): boolean => {
  const low = Math.min(previousHz, frequencyHz)
  const high = Math.max(previousHz, frequencyHz)
  return config.underFrequency.every(element => low >= element.thresholdHz)
    && config.overFrequency.every(element => high <= element.thresholdHz)
    && Math.abs(rocofHzPerSecond) <= config.rocof.thresholdHzPerSecond
}

const protectionAtRest = (state: UnitFrequencyState['protection']): boolean => {
  if (state.trip) return false
  for (const id in state.timersSeconds) if (state.timersSeconds[id] !== 0) return false
  return true
}

const servedAtNominalMw = (input: IslandFrequencyInput, shedFractions: ReadonlyMap<string, number>): number =>
  input.loads.reduce((sum, load) => sum + load.demandMw * (1 - (shedFractions.get(load.id) ?? 0)), 0)

const afrrStatus = (
  requestMw: number,
  units: ReadonlyArray<FrequencyUnit>,
  unitStates: ReadonlyMap<string, UnitFrequencyState>,
  externals: ReadonlyArray<ExternalFrequencyEquivalent>,
  externalStates: ReadonlyMap<string, ExternalFrequencyState>,
): {
  readonly requestMw: number
  readonly deliveredMw: number
  readonly utilisation: number
} => {
  const capacity = afrrCapacity(units)
  const directional = (requestMw >= 0 ? capacity.upMw : capacity.downMw)
    + externals.reduce((sum, external) => sum + (requestMw >= 0 ? external.reserves.afrrUpMw : external.reserves.afrrDownMw), 0)
  return {
    requestMw,
    deliveredMw: units.reduce((sum, unit) => sum + (unit.synchronised ? unitStates.get(unit.id)!.afrrMw : 0), 0)
      + externals.reduce((sum, external) => sum + externalStates.get(external.id)!.afrrMw, 0),
    utilisation: directional > 0 ? requestMw / directional : 0,
  }
}

/**
 * One aFRR controller cycle: updates the island request, distributes it to providers within
 * their output limits, then lets mFRR take over sustained aFRR utilisation.
 */
const runRestorationCycle = (context: {
  readonly automation: GridAutomation
  readonly afrr: EnabledAfrr
  readonly agc: AgcState
  readonly mfrr: MfrrState | null
  readonly units: ReadonlyArray<FrequencyUnit>
  readonly unitStates: ReadonlyMap<string, WorkingUnitState>
  readonly storageStates: ReadonlyMap<string, StorageFrequencyState>
  readonly externalStates: Map<string, ExternalFrequencyState>
  readonly input: IslandFrequencyInput
  readonly lfdd: LfddState
  readonly frequencyHz: number
  readonly nowSeconds: number
  readonly mfrrAt: (ramp: MfrrUnitRamp, atSeconds: number) => number
}): { readonly agc: AgcState; readonly mfrr: MfrrState | null; readonly action: FrequencyAction | null } => {
  const { automation, units, unitStates, externalStates, nowSeconds: t0, mfrrAt } = context
  const externals = context.input.externals
  const unitCapacity = afrrCapacity(units)
  const capacity = {
    upMw: unitCapacity.upMw + externals.reduce((sum, external) => sum + external.reserves.afrrUpMw, 0),
    downMw: unitCapacity.downMw + externals.reduce((sum, external) => sum + external.reserves.afrrDownMw, 0),
  }
  const fcrNStrengthMwPerHz = (units.reduce((sum, unit) => sum + (unit.synchronised ? unit.reserves.fcrNMw : 0), 0)
    + externals.reduce((sum, external) => sum + external.reserves.fcrNMw, 0)) / automation.fcrN.fullActivationDeviationHz
  const dampingMwPerHz = (servedAtNominalMw(context.input, lfddShedFractionByLoad(context.lfdd))
    + externals.reduce((sum, external) => sum + external.loadMw, 0)) * automation.swing.loadDampingPercentPerHz / 100
  const cycle = runAgcCycle(context.afrr, context.agc, {
    frequencyHz: context.frequencyHz,
    nominalFrequencyHz: automation.swing.nominalFrequencyHz,
    frequencyBiasMwPerHz: context.afrr.frequencyBiasFactor * (fcrNStrengthMwPerHz + dampingMwPerHz),
    ...(context.input.tieLineDeviationMw === undefined ? {} : { tieLineDeviationMw: context.input.tieLineDeviationMw }),
    upCapacityMw: capacity.upMw,
    downCapacityMw: capacity.downMw,
  })
  // Providers share the request by their allocation in its direction; external equivalents deliver their share in full.
  const requestMw = cycle.state.requestMw
  const allocated = requestMw >= 0 ? capacity.upMw : capacity.downMw
  const shares = distributeAfrrRequest(allocated > 0 ? requestMw * (requestMw >= 0 ? unitCapacity.upMw : unitCapacity.downMw) / allocated : 0, units)
  for (const external of externals) {
    const externalAllocation = requestMw >= 0 ? external.reserves.afrrUpMw : external.reserves.afrrDownMw
    externalStates.set(external.id, { ...externalStates.get(external.id)!, afrrMw: allocated > 0 ? requestMw * externalAllocation / allocated : 0 })
  }
  for (const unit of units) {
    const current = unitStates.get(unit.id)!
    // A provider cannot follow its share beyond its own output band.
    const baseMw = current.scheduledMw + deliveredMfrrMw(unit, current.scheduledMw, mfrrAt(current.mfrr, t0))
    const upRoomMw = Math.max(0, bandHighMw(unit, current.scheduledMw) - baseMw)
    const downRoomMw = Math.max(0, baseMw - bandLowMw(unit, current.scheduledMw))
    current.afrrMw = unit.synchronised ? Math.min(upRoomMw, Math.max(-downRoomMw, shares.get(unit.id)!)) : 0
  }
  const mfrrConfig = automation.mfrr
  if (!mfrrConfig.enabled || !context.mfrr) return { agc: cycle.state, mfrr: context.mfrr, action: null }
  const rampInProgress = units.some(unit => mfrrRampInProgress(unitStates.get(unit.id)!.mfrr, t0, mfrrTiming(mfrrConfig)))
  const activatedReservesMw = units.reduce((sum, unit) => {
    const current = unitStates.get(unit.id)!
    return sum + (unit.synchronised ? current.afrrMw + current.fcrNMw + current.fcrDUpMw + current.fcrDDownMw : 0)
  }, 0) + [...context.storageStates.values()].reduce((sum, storage) => sum + storage.responseMw, 0)
    + [...externalStates.values()].reduce((sum, external) => sum + external.fcrNMw + external.fcrDUpMw + external.fcrDDownMw + external.afrrMw, 0)
  const decision = evaluateMfrr(mfrrConfig, context.mfrr, {
    activatedReservesMw,
    afrrUtilisation: cycle.utilisation,
    cycleSeconds: context.afrr.cycleSeconds,
    rampInProgress,
  })
  if (decision.activationMw === 0) return { agc: cycle.state, mfrr: decision.state, action: null }
  const levels = new Map(units.map(unit => [unit.id, unitStates.get(unit.id)!.mfrr.toMw]))
  const activation = distributeMfrrActivation(decision.activationMw, units, levels)
  for (const unit of units) {
    const current = unitStates.get(unit.id)!
    const toMw = activation.levels.get(unit.id)!
    if (toMw !== current.mfrr.toMw) current.mfrr = { fromMw: mfrrAt(current.mfrr, t0), toMw, startedAtSeconds: t0 }
  }
  return {
    agc: cycle.state,
    mfrr: decision.state,
    action: { kind: 'mfrr-activated', atSeconds: t0, requestedMw: decision.activationMw, activatedMw: activation.activatedMw, shortfallMw: activation.shortfallMw },
  }
}
