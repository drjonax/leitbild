import type { GridAutomation } from '../../schemas/grid-automation.ts'
import { runAgcCycle, type AgcState, type EnabledAfrr } from './agc.ts'
import { evaluateGeneratorProtection, type GeneratorProtectionState } from './generator-protection.ts'
import { fcrDDownActivation, fcrDUpActivation, fcrNActivation } from './governors.ts'
import type { ExternalFrequencyState, FrequencyAction } from './island-state.ts'
import { evaluateLfdd, type LfddState } from './lfdd.ts'
import { evaluateMfrr, idleMfrrRamp, mfrrOutputMw, mfrrRampInProgress, mfrrTiming, type MfrrState, type MfrrTiming, type MfrrUnitRamp } from './mfrr.ts'
import { completeStorageSubStep, planStorageSubStep, type StorageSubStepPlan } from './storage.ts'
import { integrateSwingSubStep, lagOutputWeight, type ResponseElement } from './swing.ts'
import type { ExternalFrequencyEquivalent, FrequencyLoad } from './types.ts'
import { eligibleAfrr, eligibleFcrD, eligibleFcrN, eligibleMfrr, type IslandFrequencyWorkspace, type UnitInputArrays } from './workspace.ts'

// One island's frequency control advanced in place on its workspace: fixed sub-steps of the swing
// equation with governors, storage, protection and LFDD, and aFRR and mFRR on their own cycle. The
// arithmetic and its order are those of the record-based advance this replaces, so results are
// identical; the per-unit loops run as small module-level kernels on typed arrays, which the JIT
// optimises where a large function stays slow (Norway: about 850 units over 20 sub-steps per tick).

const stepTolerance = 1e-9

const limited = (outputMw: number, upMw: number, downMw: number): number => Math.min(upMw, Math.max(-downMw, outputMw))

/**
 * Output band of a synchronised unit at a set-point: [minimum, maximum], widened only to hold a
 * set-point outside it. Governor, aFRR and mFRR output stay inside it; only the set-point (a stop)
 * takes a unit below its minimum.
 */
const bandLowMw = (units: UnitInputArrays, unit: number, scheduledMw: number): number => Math.min(units.minimumMw[unit]!, scheduledMw)
const bandHighMw = (units: UnitInputArrays, unit: number, scheduledMw: number): number => Math.max(units.maximumMw[unit]!, scheduledMw)

/** mFRR a unit delivers at a set-point: its activation, limited so set-point plus mFRR stays in the band. */
const deliveredMfrrMw = (units: UnitInputArrays, unit: number, scheduledMw: number, activationMw: number): number =>
  Math.min(bandHighMw(units, unit, scheduledMw) - scheduledMw, Math.max(bandLowMw(units, unit, scheduledMw) - scheduledMw, activationMw))

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
 * The synchronised units of an advance gathered into dense arrays for the sub-step kernels:
 * parameters, working state, the per-unit scratch of a sub-step and the sub-step's sums. `active`
 * maps a dense position to the workspace position. Kept per workspace and reused.
 */
interface UnitKernel {
  count: number
  readonly active: Int32Array
  /** Working synchronised flag of every workspace unit during an advance (trips clear it). */
  readonly synchronised: Uint8Array
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
  /** True while the dense arrays hold working state the workspace does not have yet. */
  ahead: boolean
  /** Storage scratch: schedule of the advance, limited flag, plans and responses of a sub-step. */
  readonly storageScheduledMw: Float64Array
  readonly storageLimited: Uint8Array
  readonly storagePlans: Array<StorageSubStepPlan | null>
  readonly storageResponseEndMw: Float64Array
  readonly storageResponseEnergyMws: Float64Array
  /** Loads as FrequencyLoad, built only when an LFDD stage evaluates its feeders. */
  loads: ReadonlyArray<FrequencyLoad> | null
}

const kernels = new WeakMap<IslandFrequencyWorkspace, UnitKernel>()

const kernelOf = (workspace: IslandFrequencyWorkspace): UnitKernel => {
  const cached = kernels.get(workspace)
  if (cached) return cached
  const count = workspace.unitIds.length
  const storageCount = workspace.storageIds.length
  const floats = (): Float64Array => new Float64Array(count)
  const kernel: UnitKernel = {
    count: 0,
    active: new Int32Array(count),
    synchronised: new Uint8Array(count),
    targetMw: floats(),
    rampMwPerSecond: floats(),
    minimumMw: floats(),
    maximumMw: floats(),
    fcrNReserveMw: floats(),
    fcrDUpReserveMw: floats(),
    fcrDDownReserveMw: floats(),
    scheduledMw: floats(),
    afrrMw: floats(),
    fcrNMw: floats(),
    fcrDUpMw: floats(),
    fcrDDownMw: floats(),
    scheduledEnd: floats(),
    nStart: floats(),
    nUp: floats(),
    nDown: floats(),
    dUpStart: floats(),
    dUpCap: floats(),
    dDownStart: floats(),
    dDownCap: floats(),
    sums: new Float64Array(8),
    ahead: false,
    storageScheduledMw: new Float64Array(storageCount),
    storageLimited: new Uint8Array(storageCount),
    storagePlans: new Array<StorageSubStepPlan | null>(storageCount).fill(null),
    storageResponseEndMw: new Float64Array(storageCount),
    storageResponseEnergyMws: new Float64Array(storageCount),
    loads: null,
  }
  kernels.set(workspace, kernel)
  return kernel
}

/** Collects the synchronised units into the dense arrays and reads their parameters and working state. */
const gatherActive = (kernel: UnitKernel, workspace: IslandFrequencyWorkspace): void => {
  const units = workspace.units
  let count = 0
  for (let unit = 0; unit < kernel.synchronised.length; unit += 1) if (kernel.synchronised[unit] === 1) kernel.active[count++] = unit
  kernel.count = count
  for (let index = 0; index < count; index += 1) {
    const unit = kernel.active[index]!
    kernel.targetMw[index] = units.targetMw[unit]!
    kernel.rampMwPerSecond[index] = units.rampRateMwPerSecond[unit]!
    kernel.minimumMw[index] = units.minimumMw[unit]!
    kernel.maximumMw[index] = units.maximumMw[unit]!
    kernel.fcrNReserveMw[index] = units.fcrNReserveMw[unit]!
    kernel.fcrDUpReserveMw[index] = units.fcrDUpReserveMw[unit]!
    kernel.fcrDDownReserveMw[index] = units.fcrDDownReserveMw[unit]!
  }
  loadActiveState(kernel, workspace)
}

/** Reads the active units' working state from the workspace into the dense arrays. */
const loadActiveState = (kernel: UnitKernel, workspace: IslandFrequencyWorkspace): void => {
  for (let index = 0; index < kernel.count; index += 1) {
    const unit = kernel.active[index]!
    kernel.scheduledMw[index] = workspace.scheduledMw[unit]!
    kernel.afrrMw[index] = workspace.afrrMw[unit]!
    kernel.fcrNMw[index] = workspace.fcrNMw[unit]!
    kernel.fcrDUpMw[index] = workspace.fcrDUpMw[unit]!
    kernel.fcrDDownMw[index] = workspace.fcrDDownMw[unit]!
  }
  kernel.ahead = false
}

/** Writes the dense arrays' working state back into the workspace. */
const flushActiveState = (kernel: UnitKernel, workspace: IslandFrequencyWorkspace): void => {
  if (!kernel.ahead) return
  for (let index = 0; index < kernel.count; index += 1) {
    const unit = kernel.active[index]!
    workspace.scheduledMw[unit] = kernel.scheduledMw[index]!
    workspace.afrrMw[unit] = kernel.afrrMw[index]!
    workspace.fcrNMw[unit] = kernel.fcrNMw[index]!
    workspace.fcrDUpMw[unit] = kernel.fcrDUpMw[index]!
    workspace.fcrDDownMw[unit] = kernel.fcrDDownMw[index]!
  }
  kernel.ahead = false
}

/**
 * First half of a sub-step for every synchronised unit: the set-point ramp and its exact energy,
 * delivered mFRR within the output band, aFRR held within the room both leave, and the FCR-N and
 * FCR-D caps from the remaining headroom. Accumulates onto `fixedEnergyMws` in unit order.
 */
const planUnitSubStep = (kernel: UnitKernel, ramps: ReadonlyArray<MfrrUnitRamp>, step: {
  readonly stepSeconds: number
  readonly t0: number
  readonly t1: number
  readonly mfrrEnabled: boolean
  readonly mfrrTimes: MfrrTiming
  readonly fixedEnergyMws: number
}): void => {
  const { stepSeconds, t0, t1, mfrrEnabled, mfrrTimes } = step
  const { scheduledEnd, nStart, nUp, nDown, dUpStart, dUpCap, dDownStart, dDownCap } = kernel
  let fixedEnergyMws = step.fixedEnergyMws
  let nStartSum = 0
  let nUpSum = 0
  let nDownSum = 0
  let dUpStartSum = 0
  let dUpSum = 0
  let dDownStartSum = 0
  let dDownSum = 0
  kernel.ahead = true
  for (let index = 0; index < kernel.count; index += 1) {
    const minimumMw = kernel.minimumMw[index]!
    const maximumMw = kernel.maximumMw[index]!
    // Set-point follows the target at the ramp rate; its energy is the exact integral of that ramp.
    const fromMw = kernel.scheduledMw[index]!
    const targetMw = kernel.targetMw[index]!
    let endMw = targetMw
    let scheduledEnergyMws = targetMw * stepSeconds
    if (fromMw !== targetMw) {
      const rampRateMwPerSecond = kernel.rampMwPerSecond[index]!
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
      const ramp = ramps[kernel.active[index]!]!
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
    let afrrMw = kernel.afrrMw[index]!
    if (afrrMw > afrrHighMw) afrrMw = afrrHighMw
    else if (afrrMw < afrrLowMw) afrrMw = afrrLowMw
    kernel.afrrMw[index] = afrrMw
    fixedEnergyMws += scheduledEnergyMws + afrrMw * stepSeconds + mfrrEnergyMw
    const baseStartMw = fromMw + afrrMw + mfrrStartMw
    const baseEndMw = endMw + afrrMw + mfrrEndMw
    // Headroom split between FCR-N and FCR-D, FCR-N first (see unitFcrCaps).
    const upRoom = Math.max(0, maximumMw - Math.max(baseStartMw, baseEndMw))
    const downRoom = Math.max(0, Math.min(baseStartMw, baseEndMw) - minimumMw)
    const fcrNReserveMw = kernel.fcrNReserveMw[index]!
    const capNUp = Math.min(fcrNReserveMw, upRoom)
    const capNDown = Math.min(fcrNReserveMw, downRoom)
    if (fcrNReserveMw > 0) {
      const startMw = limited(kernel.fcrNMw[index]!, capNUp, capNDown)
      nStart[index] = startMw
      nUp[index] = capNUp
      nDown[index] = capNDown
      nStartSum += startMw
      nUpSum += capNUp
      nDownSum += capNDown
    }
    const fcrDUpReserveMw = kernel.fcrDUpReserveMw[index]!
    if (fcrDUpReserveMw > 0) {
      const cap = Math.min(fcrDUpReserveMw, upRoom - capNUp)
      const startMw = limited(kernel.fcrDUpMw[index]!, cap, 0)
      dUpStart[index] = startMw
      dUpCap[index] = cap
      dUpStartSum += startMw
      dUpSum += cap
    }
    const fcrDDownReserveMw = kernel.fcrDDownReserveMw[index]!
    if (fcrDDownReserveMw > 0) {
      const cap = Math.min(fcrDDownReserveMw, downRoom - capNDown)
      const startMw = limited(kernel.fcrDDownMw[index]!, 0, cap)
      dDownStart[index] = startMw
      dDownCap[index] = cap
      dDownStartSum += startMw
      dDownSum += cap
    }
  }
  const sums = kernel.sums
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
const completeUnitSubStep = (kernel: UnitKernel, step: {
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
  const { scheduledEnd, nStart, nUp, nDown, dUpStart, dUpCap, dDownStart, dDownCap } = kernel
  kernel.ahead = true
  for (let index = 0; index < kernel.count; index += 1) {
    kernel.scheduledMw[index] = scheduledEnd[index]!
    if (kernel.fcrNReserveMw[index]! > 0) {
      const up = nUp[index]!
      const down = nDown[index]!
      kernel.fcrNMw[index] = laggedMw(nStart[index]!, aN0 * (aN0 >= 0 ? up : down), aN1 * (aN1 >= 0 ? up : down), nLag)
    }
    if (kernel.fcrDUpReserveMw[index]! > 0) kernel.fcrDUpMw[index] = laggedMw(dUpStart[index]!, aDUp0 * dUpCap[index]!, aDUp1 * dUpCap[index]!, dUpLag)
    if (kernel.fcrDDownReserveMw[index]! > 0) kernel.fcrDDownMw[index] = laggedMw(dDownStart[index]!, aDDown0 * dDownCap[index]!, aDDown1 * dDownCap[index]!, dDownLag)
  }
}

/** Takes unit `unit` out of service in the workspace: no set-point, reserves or mFRR (its protection stays). */
const outOfService = (workspace: IslandFrequencyWorkspace, unit: number): void => {
  workspace.scheduledMw[unit] = 0
  workspace.fcrNMw[unit] = 0
  workspace.fcrDUpMw[unit] = 0
  workspace.fcrDDownMw[unit] = 0
  workspace.afrrMw[unit] = 0
  workspace.mfrrRamp[unit] = idleMfrrRamp
}

/** E_k = Σ H·S of the synchronised synchronous units plus the external equivalents (MWs), as islandKineticEnergyMws. */
export const workspaceKineticEnergyMws = (workspace: IslandFrequencyWorkspace, synchronised: Uint8Array): number => {
  const units = workspace.units
  let unitsMws = 0
  for (let unit = 0; unit < synchronised.length; unit += 1) {
    unitsMws += synchronised[unit] === 1 && units.synchronous[unit] === 1 ? units.inertiaConstantSeconds[unit]! * units.ratedMva[unit]! : 0
  }
  let externalsMws = 0
  for (const external of workspace.externalEquivalents) externalsMws += external.kineticEnergyMws
  return unitsMws + externalsMws
}

const protectionAtRest = (state: GeneratorProtectionState): boolean => {
  if (state.trip) return false
  for (const id in state.timersSeconds) if (state.timersSeconds[id] !== 0) return false
  return true
}

const protectionQuiet = (config: GridAutomation['generatorProtection'], previousHz: number, frequencyHz: number, rocofHzPerSecond: number): boolean => {
  const low = Math.min(previousHz, frequencyHz)
  const high = Math.max(previousHz, frequencyHz)
  for (const element of config.underFrequency) if (!(low >= element.thresholdHz)) return false
  for (const element of config.overFrequency) if (!(high <= element.thresholdHz)) return false
  return Math.abs(rocofHzPerSecond) <= config.rocof.thresholdHzPerSecond
}

/** Each load's total LFDD shed fraction for the workspace's LFDD state, as lfddShedFractionByLoad sums it. */
const shedFractions = (workspace: IslandFrequencyWorkspace): Float64Array => {
  const fractions = workspace.loadShedFraction
  if (workspace.shedFractionsOf === workspace.lfdd) return fractions
  fractions.fill(0)
  for (const stage of Object.values(workspace.lfdd.stages)) {
    for (const loadId in stage.shedFractionByLoad) {
      if (!Object.hasOwn(stage.shedFractionByLoad, loadId)) continue
      const position = workspace.loadPositionById.get(loadId)
      if (position === undefined) throw new Error(`LFDD stage of island ${workspace.islandId} sheds load ${loadId}, which is not in the island`)
      fractions[position] = fractions[position]! + stage.shedFractionByLoad[loadId]!
    }
  }
  workspace.shedFractionsOf = workspace.lfdd
  return fractions
}

const servedAtNominalMw = (workspace: IslandFrequencyWorkspace): number => {
  const fractions = shedFractions(workspace)
  let servedMw = 0
  for (let load = 0; load < fractions.length; load += 1) servedMw += workspace.loadDemandMw[load]! * (1 - fractions[load]!)
  return servedMw
}

/** Whether evaluateLfdd would leave the state unchanged: every stage disarmed or operated, or armed with no timer above its threshold. */
const lfddQuiet = (config: GridAutomation['lfdd'], state: LfddState, low: number): boolean => {
  for (const stage of config.stages) {
    const current = state.stages[stage.id]
    if (!(current !== undefined && (current.status !== 'armed' || (current.belowThresholdSeconds === 0 && low >= stage.thresholdHz)))) return false
  }
  return true
}

/** The loads as FrequencyLoad for an LFDD evaluation, built once per advance and only when a stage evaluates. */
const frequencyLoads = (kernel: UnitKernel, workspace: IslandFrequencyWorkspace): ReadonlyArray<FrequencyLoad> => {
  kernel.loads ??= workspace.loadIds.map((id, load) => ({
    id, priority: workspace.loadPriority[load]!, demandMw: workspace.loadDemandMw[load]!, protectedMw: workspace.loadProtectedMw[load]!,
  }))
  return kernel.loads
}

const finiteAtLeast = (value: number, minimum: number): boolean => Number.isFinite(value) && value >= minimum

/**
 * The checks of validateIslandInput on the workspace's inputs; false sends the caller to the
 * detailed check, which throws the precise error. Member ids are aligned by construction.
 */
const inputsPlainlyValid = (automation: GridAutomation, workspace: IslandFrequencyWorkspace): boolean => {
  const units = workspace.units
  for (let unit = 0; unit < units.synchronised.length; unit += 1) {
    const eligibility = units.eligibility[unit]!
    const eligible = (units.fcrNReserveMw[unit] === 0 || (eligibility & eligibleFcrN) !== 0)
      && ((units.fcrDUpReserveMw[unit] === 0 && units.fcrDDownReserveMw[unit] === 0) || (eligibility & eligibleFcrD) !== 0)
      && ((units.afrrUpReserveMw[unit] === 0 && units.afrrDownReserveMw[unit] === 0) || (eligibility & eligibleAfrr) !== 0)
      && ((units.mfrrUpReserveMw[unit] === 0 && units.mfrrDownReserveMw[unit] === 0) || (eligibility & eligibleMfrr) !== 0)
    const synchronised = units.synchronised[unit] === 1
    const targetMw = units.targetMw[unit]!
    const plain = finiteAtLeast(units.ratedMva[unit]!, Number.MIN_VALUE) && finiteAtLeast(units.inertiaConstantSeconds[unit]!, 0)
      && (units.synchronous[unit] === 1 || units.inertiaConstantSeconds[unit] === 0)
      && finiteAtLeast(units.minimumMw[unit]!, 0) && finiteAtLeast(units.maximumMw[unit]!, units.minimumMw[unit]!)
      && finiteAtLeast(units.rampRateMwPerSecond[unit]!, Number.MIN_VALUE) && finiteAtLeast(targetMw, 0)
      && (!synchronised || (targetMw >= units.minimumMw[unit]! && targetMw <= units.maximumMw[unit]!))
      && finiteAtLeast(units.fcrNReserveMw[unit]!, 0) && finiteAtLeast(units.fcrDUpReserveMw[unit]!, 0) && finiteAtLeast(units.fcrDDownReserveMw[unit]!, 0)
      && finiteAtLeast(units.afrrUpReserveMw[unit]!, 0) && finiteAtLeast(units.afrrDownReserveMw[unit]!, 0)
      && finiteAtLeast(units.mfrrUpReserveMw[unit]!, 0) && finiteAtLeast(units.mfrrDownReserveMw[unit]!, 0)
    if (!eligible || !plain || (synchronised && workspace.protection[unit]!.trip)) return false
  }
  for (const unit of workspace.storageUnits) {
    if (!(finiteAtLeast(unit.maximumDischargeMw, 0) && finiteAtLeast(unit.maximumChargeMw, 0) && finiteAtLeast(unit.energyCapacityMwh, Number.MIN_VALUE)
      && unit.chargeEfficiency > 0 && unit.chargeEfficiency <= 1 && unit.dischargeEfficiency > 0 && unit.dischargeEfficiency <= 1
      && unit.scheduledMw <= unit.maximumDischargeMw && unit.scheduledMw >= -unit.maximumChargeMw)) return false
  }
  for (let load = 0; load < workspace.loadDemandMw.length; load += 1) {
    if (!finiteAtLeast(workspace.loadDemandMw[load]!, 0) || !finiteAtLeast(workspace.loadProtectedMw[load]!, 0)) return false
  }
  for (const external of workspace.externalEquivalents) {
    const reserves = external.reserves
    if (!(finiteAtLeast(external.kineticEnergyMws, Number.MIN_VALUE) && Number.isFinite(external.scheduledImportMw) && finiteAtLeast(external.loadMw, 0)
      && finiteAtLeast(reserves.fcrNMw, 0) && finiteAtLeast(reserves.fcrDUpMw, 0) && finiteAtLeast(reserves.fcrDDownMw, 0)
      && finiteAtLeast(reserves.afrrUpMw, 0) && finiteAtLeast(reserves.afrrDownMw, 0)
      && ((reserves.afrrUpMw === 0 && reserves.afrrDownMw === 0) || automation.afrr.enabled))) return false
  }
  return Number.isFinite(workspace.lossesMw) && workspace.lossesMw >= 0 && Number.isFinite(workspace.fixedInjectionMw)
    && (workspace.tieLineDeviationMw === undefined || Number.isFinite(workspace.tieLineDeviationMw))
}

/**
 * Advances the island by dtSeconds in fixed sub-steps of the Automation's subStepSeconds (a
 * shorter final step covers any remainder), in place: the workspace's state moves to the end of
 * the advance and its outputs, actions and extremes describe it. `validateInDetail` is called
 * when the inputs fail the common-case checks and throws the precise error (validateIslandInput);
 * `inputsValidated` skips the checks for inputs the caller has validated already. Storage and
 * external equivalents must be connected per the workspace inputs before the call.
 */
export const advanceFrequencyWorkspace = (
  automation: GridAutomation,
  workspace: IslandFrequencyWorkspace,
  dtSeconds: number,
  validation: { readonly inputsValidated: boolean; readonly validateInDetail: () => void },
): void => {
  if (!Number.isFinite(dtSeconds) || dtSeconds < 0) throw new Error(`frequency advance needs a finite non-negative step, got ${dtSeconds}`)
  if (dtSeconds > automation.simulation.maximumCatchUpSeconds) {
    throw new Error(`frequency advance of ${dtSeconds} s exceeds the maximum catch-up of ${automation.simulation.maximumCatchUpSeconds} s for island ${workspace.islandId}`)
  }
  if (workspace.frequencyHz === null) throw new Error(`island ${workspace.islandId} has collapsed; it must be re-energised with a new frequency state`)
  if (!validation.inputsValidated && !inputsPlainlyValid(automation, workspace)) validation.validateInDetail()
  const kernel = kernelOf(workspace)
  const units = workspace.units
  const unitCount = workspace.unitIds.length
  const nominalHz = automation.swing.nominalFrequencyHz
  const dampingPerHz = automation.swing.loadDampingPercentPerHz / 100
  const h = automation.simulation.subStepSeconds
  const actions = workspace.actions
  actions.length = 0
  kernel.loads = null
  // Working synchronised flags; an unsynchronised unit enters the advance out of service.
  const synchronised = kernel.synchronised
  for (let unit = 0; unit < unitCount; unit += 1) {
    synchronised[unit] = units.synchronised[unit]!
    if (synchronised[unit] !== 1) outOfService(workspace, unit)
  }
  const storageUnits = workspace.storageUnits
  const externals = workspace.externalEquivalents
  for (let item = 0; item < storageUnits.length; item += 1) {
    kernel.storageLimited[item] = 0
    kernel.storageScheduledMw[item] = storageUnits[item]!.connected ? storageUnits[item]!.scheduledMw : 0
  }
  let externalDampingMwPerHz = 0
  for (const external of externals) externalDampingMwPerHz += external.loadMw * dampingPerHz
  let agc = workspace.agc
  let mfrr = workspace.mfrr
  let frequencyHz = workspace.frequencyHz
  let rocofHzPerSecond = workspace.rocofHzPerSecond
  let elapsedSeconds = workspace.elapsedSeconds
  let collapsed = false
  const extremes = workspace.extremes
  workspace.hasExtremes = dtSeconds > 0
  if (workspace.hasExtremes) {
    extremes.minimumHz = frequencyHz
    extremes.minimumAtSeconds = elapsedSeconds
    extremes.maximumHz = frequencyHz
    extremes.maximumAtSeconds = elapsedSeconds
  }
  const mfrrEnabled = automation.mfrr.enabled
  const mfrrTimes: MfrrTiming = automation.mfrr.enabled ? mfrrTiming(automation.mfrr) : { preparationSeconds: 0, fullActivationSeconds: 1 }
  const mfrrAt = (ramp: MfrrUnitRamp, atSeconds: number): number => mfrrEnabled ? mfrrOutputMw(ramp, atSeconds, mfrrTimes) : 0
  for (let item = 0; item < storageUnits.length; item += 1) {
    const unit = storageUnits[item]!
    const current = workspace.storage[item]!
    if (unit.connected || current.operatingState === 'disconnected') continue
    workspace.storage[item] = { ...current, responseMw: 0, operatingState: 'disconnected' }
    actions.push({ kind: 'storage-state-changed', storageId: unit.id, atSeconds: elapsedSeconds, from: current.operatingState, to: 'disconnected' })
  }
  const fullSteps = Math.floor(dtSeconds / h + stepTolerance)
  const remainderSeconds = dtSeconds - fullSteps * h
  const stepCount = fullSteps + (remainderSeconds > stepTolerance ? 1 : 0)

  gatherActive(kernel, workspace)
  let kineticEnergyMws = workspaceKineticEnergyMws(workspace, synchronised)
  // True while every synchronised unit's protection relays sit at zero with no trip.
  let relaysAtRest = true
  for (let index = 0; index < kernel.count; index += 1) {
    if (!protectionAtRest(workspace.protection[kernel.active[index]!]!)) {
      relaysAtRest = false
      break
    }
  }
  let servedNominalMw = servedAtNominalMw(workspace)
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
        flushActiveState(kernel, workspace)
        const cycle = runRestorationCycle({ automation, afrr: automation.afrr, agc, mfrr, workspace, synchronised, frequencyHz: f0, nowSeconds: t0, mfrrAt })
        agc = cycle.agc
        mfrr = cycle.mfrr
        if (cycle.action) actions.push(cycle.action)
        loadActiveState(kernel, workspace)
      }
    }

    const elements: ResponseElement[] = []
    let fixedEnergyMws = (workspace.fixedInjectionMw - workspace.lossesMw) * stepSeconds
    planUnitSubStep(kernel, workspace.mfrrRamp, { stepSeconds, t0, t1, mfrrEnabled, mfrrTimes, fixedEnergyMws })
    const sums = kernel.sums
    fixedEnergyMws = sums[0]!
    let nStartSum = sums[1]!
    let nUpSum = sums[2]!
    let nDownSum = sums[3]!
    let dUpStartSum = sums[4]!
    let dUpSum = sums[5]!
    let dDownStartSum = sums[6]!
    let dDownSum = sums[7]!
    // Storage elements come first in the swing solve, in storage order (their outputs are read back by position).
    for (let item = 0; item < storageUnits.length; item += 1) {
      const unit = storageUnits[item]!
      if (!unit.connected) {
        kernel.storagePlans[item] = null
        continue
      }
      const plan = planStorageSubStep(automation.storage, automation.fcrD, unit, workspace.storage[item]!, {
        frequencyHz: f0, nominalFrequencyHz: nominalHz, nowSeconds: t0, stepSeconds,
      })
      fixedEnergyMws += plan.scheduledMw * stepSeconds
      kernel.storageScheduledMw[item] = plan.scheduledMw
      if (plan.limitedByStateOfCharge) kernel.storageLimited[item] = 1
      kernel.storagePlans[item] = plan
    }
    let storageElements = 0
    for (let item = 0; item < storageUnits.length; item += 1) {
      const plan = kernel.storagePlans[item]
      if (!plan) continue
      if (plan.element) {
        elements.push(plan.element)
        storageElements += 1
      } else if (plan.ffr) {
        const energyMws = (plan.ffr.startMw + plan.ffr.endMw) / 2 * stepSeconds
        fixedEnergyMws += energyMws
        kernel.storageResponseEndMw[item] = plan.ffr.endMw
        kernel.storageResponseEnergyMws[item] = energyMws
      } else {
        kernel.storageResponseEndMw[item] = 0
        kernel.storageResponseEnergyMws[item] = 0
      }
    }
    for (let position = 0; position < externals.length; position += 1) {
      const external = externals[position]!
      const current = workspace.externals[position]!
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
    if (nUpSum > 0 || nDownSum > 0) {
      elements.push({
        outputMw: nStartSum,
        timeConstantSeconds: fcrNConfig.timeConstantSeconds,
        target: (f: number): number => {
          const activation = fcrNActivation(f, nominalHz, fcrNConfig)
          return activation * (activation >= 0 ? nUpSum : nDownSum)
        },
      })
    }
    if (dUpSum > 0) elements.push({ outputMw: dUpStartSum, timeConstantSeconds: fcrDUpConfig.timeConstantSeconds, target: f => fcrDUpActivation(f, fcrDUpConfig) * dUpSum })
    if (dDownSum > 0) elements.push({ outputMw: dDownStartSum, timeConstantSeconds: fcrDDownConfig.timeConstantSeconds, target: f => -fcrDDownActivation(f, fcrDDownConfig) * dDownSum })

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
    // The storage elements' responses, in the order they entered the solve.
    for (let item = 0, element = 0; item < storageUnits.length && element < storageElements; item += 1) {
      const plan = kernel.storagePlans[item]
      if (!plan?.element) continue
      kernel.storageResponseEndMw[item] = step.elementOutputsMw[element]!
      kernel.storageResponseEnergyMws[item] = step.elementEnergyMws[element]!
      element += 1
    }
    const f1 = step.frequencyHz
    const lagUpdate = (timeConstantSeconds: number): LagUpdate => {
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
    completeUnitSubStep(kernel, { aN0, aN1, aDUp0, aDUp1, aDDown0, aDDown1, nLag, dUpLag, dDownLag })
    for (let position = 0; position < externals.length; position += 1) {
      const current = workspace.externals[position]!
      const reserves = externals[position]!.reserves
      const next = { ...current }
      if (reserves.fcrNMw > 0) {
        next.fcrNMw = laggedMw(limited(current.fcrNMw, reserves.fcrNMw, reserves.fcrNMw), aN0 * reserves.fcrNMw, aN1 * reserves.fcrNMw, nLag)
      }
      if (reserves.fcrDUpMw > 0) next.fcrDUpMw = laggedMw(limited(current.fcrDUpMw, reserves.fcrDUpMw, 0), aDUp0 * reserves.fcrDUpMw, aDUp1 * reserves.fcrDUpMw, dUpLag)
      if (reserves.fcrDDownMw > 0) next.fcrDDownMw = laggedMw(limited(current.fcrDDownMw, 0, reserves.fcrDDownMw), aDDown0 * reserves.fcrDDownMw, aDDown1 * reserves.fcrDDownMw, dDownLag)
      workspace.externals[position] = next
    }
    for (let item = 0; item < storageUnits.length; item += 1) {
      const plan = kernel.storagePlans[item]
      if (!plan) continue
      const unit = storageUnits[item]!
      const before = workspace.storage[item]!
      const after = completeStorageSubStep(automation.storage, unit, before, plan, {
        responseEndMw: kernel.storageResponseEndMw[item]!, responseEnergyMws: kernel.storageResponseEnergyMws[item]!, stepSeconds, nowSeconds: t1,
      })
      workspace.storage[item] = after
      if (after.operatingState !== before.operatingState) {
        actions.push({ kind: 'storage-state-changed', storageId: unit.id, atSeconds: t1, from: before.operatingState, to: after.operatingState })
      }
    }

    frequencyHz = f1
    rocofHzPerSecond = step.rocofHzPerSecond
    elapsedSeconds = t1
    if (!(frequencyHz > nominalHz * 0.9 && frequencyHz < nominalHz * 1.1)) {
      // Beyond ±10 % within one sub-step, past every relay threshold: each synchronised unit's fastest
      // under- or over-frequency element operates and the island collapses.
      const cause = frequencyHz <= nominalHz * 0.9 ? 'under-frequency' as const : 'over-frequency' as const
      const relayElements = cause === 'under-frequency' ? automation.generatorProtection.underFrequency : automation.generatorProtection.overFrequency
      const element = [...relayElements].sort((a, b) => a.delaySeconds - b.delaySeconds)[0]!
      flushActiveState(kernel, workspace)
      for (let index = 0; index < kernel.count; index += 1) {
        const unit = kernel.active[index]!
        outOfService(workspace, unit)
        workspace.protection[unit] = { ...workspace.protection[unit]!, trip: { atSeconds: t1, elementId: element.id, cause } }
        actions.push({ kind: 'generator-trip', unitId: workspace.unitIds[unit]!, atSeconds: t1, elementId: element.id, cause })
      }
      synchronised.fill(0)
      collapsed = true
      actions.push({ kind: 'island-collapsed', atSeconds: t1, cause: `${cause}-beyond-model-range` })
      break
    }
    if (workspace.hasExtremes) {
      if (frequencyHz < extremes.minimumHz) {
        extremes.minimumHz = frequencyHz
        extremes.minimumAtSeconds = t1
      }
      if (frequencyHz > extremes.maximumHz) {
        extremes.maximumHz = frequencyHz
        extremes.maximumAtSeconds = t1
      }
    }

    // Inside every pick-up band at both ends of the step, a relay whose timers are all zero stays so.
    const quiet = protectionQuiet(automation.generatorProtection, f0, frequencyHz, rocofHzPerSecond)
    const sweep = !(quiet && relaysAtRest)
    if (sweep) relaysAtRest = quiet
    let trippedCount = 0
    for (let index = 0; sweep && index < kernel.count; index += 1) {
      const unit = kernel.active[index]!
      if (quiet && protectionAtRest(workspace.protection[unit]!)) continue
      const protection = evaluateGeneratorProtection(automation.generatorProtection, workspace.protection[unit]!, {
        previousFrequencyHz: f0, frequencyHz, rocofHzPerSecond, stepSeconds, nowSeconds: t1,
      })
      workspace.protection[unit] = protection
      if (!protectionAtRest(protection)) relaysAtRest = false
      if (protection.trip) {
        trippedCount += 1
        synchronised[unit] = 0
        flushActiveState(kernel, workspace)
        outOfService(workspace, unit)
        actions.push({ kind: 'generator-trip', unitId: workspace.unitIds[unit]!, atSeconds: t1, elementId: protection.trip.elementId, cause: protection.trip.cause })
      }
    }
    if (trippedCount > 0) {
      gatherActive(kernel, workspace)
      kineticEnergyMws = workspaceKineticEnergyMws(workspace, synchronised)
    }

    const low = Math.min(f0, frequencyHz)
    if (!lfddQuiet(automation.lfdd, workspace.lfdd, low)) {
      const lfddStep = evaluateLfdd(automation.lfdd, workspace.lfdd, { previousFrequencyHz: f0, frequencyHz, stepSeconds, nowSeconds: t1, loads: frequencyLoads(kernel, workspace) })
      workspace.lfdd = lfddStep.state
      for (const operation of lfddStep.operations) actions.push({ kind: 'lfdd-stage-operated', ...operation })
      if (lfddStep.operations.length > 0) servedNominalMw = servedAtNominalMw(workspace)
    }
  }

  flushActiveState(kernel, workspace)
  const fractions = shedFractions(workspace)
  const finalFrequencyHz = collapsed ? null : frequencyHz
  const selfRegulation = finalFrequencyHz === null ? 0 : 1 + dampingPerHz * (finalFrequencyHz - nominalHz)
  for (let unit = 0; unit < unitCount; unit += 1) {
    const unitSynchronised = synchronised[unit] === 1
    const scheduledMw = workspace.scheduledMw[unit]!
    const mfrrMw = unitSynchronised ? deliveredMfrrMw(units, unit, scheduledMw, mfrrAt(workspace.mfrrRamp[unit]!, elapsedSeconds)) : 0
    const fcrDMw = workspace.fcrDUpMw[unit]! + workspace.fcrDDownMw[unit]!
    workspace.outputSynchronised[unit] = unitSynchronised && !collapsed ? 1 : 0
    workspace.outputMw[unit] = collapsed || !unitSynchronised ? 0 : scheduledMw + workspace.fcrNMw[unit]! + fcrDMw + workspace.afrrMw[unit]! + mfrrMw
    workspace.outputFcrNMw[unit] = workspace.fcrNMw[unit]!
    workspace.outputFcrDMw[unit] = fcrDMw
    workspace.outputMfrrMw[unit] = mfrrMw
  }
  workspace.storageOutputs.length = storageUnits.length
  for (let item = 0; item < storageUnits.length; item += 1) {
    const unit = storageUnits[item]!
    const current = workspace.storage[item]!
    workspace.storageOutputs[item] = {
      id: unit.id,
      powerMw: unit.connected && !collapsed ? kernel.storageScheduledMw[item]! + current.responseMw : 0,
      responseMw: current.responseMw,
      stateOfChargeFraction: current.stateOfChargeFraction,
      operatingState: current.operatingState,
      limitedByStateOfCharge: kernel.storageLimited[item] === 1,
    }
  }
  for (let load = 0; load < workspace.loadDemandMw.length; load += 1) {
    const fraction = fractions[load]!
    const demandMw = workspace.loadDemandMw[load]!
    workspace.loadServedMw[load] = demandMw * (1 - fraction) * selfRegulation
    workspace.loadLfddShedMw[load] = demandMw * fraction
  }
  workspace.externalOutputs.length = externals.length
  for (let position = 0; position < externals.length; position += 1) {
    workspace.externalOutputs[position] = externalOutput(externals[position]!, workspace.externals[position]!, finalFrequencyHz, nominalHz, dampingPerHz)
  }
  workspace.elapsedSeconds = elapsedSeconds
  workspace.frequencyHz = finalFrequencyHz
  workspace.rocofHzPerSecond = collapsed ? 0 : rocofHzPerSecond
  workspace.agc = agc
  workspace.mfrr = mfrr
  workspace.version += 1
}

const externalOutput = (
  external: ExternalFrequencyEquivalent,
  current: ExternalFrequencyState,
  frequencyHz: number | null,
  nominalHz: number,
  dampingPerHz: number,
) => {
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

/** Allocated aFRR of the synchronised providers in each direction, as afrrCapacity sums it. */
const afrrUpCapacityMw = (units: UnitInputArrays, synchronised: Uint8Array): number => {
  let capacityMw = 0
  for (let unit = 0; unit < synchronised.length; unit += 1) capacityMw += synchronised[unit] === 1 ? units.afrrUpReserveMw[unit]! : 0
  return capacityMw
}

const afrrDownCapacityMw = (units: UnitInputArrays, synchronised: Uint8Array): number => {
  let capacityMw = 0
  for (let unit = 0; unit < synchronised.length; unit += 1) capacityMw += synchronised[unit] === 1 ? units.afrrDownReserveMw[unit]! : 0
  return capacityMw
}

/** The island's aFRR request, the part providers deliver, and the request as a share of allocated aFRR (afrrStatus). */
export const workspaceAfrrStatus = (workspace: IslandFrequencyWorkspace, synchronised: Uint8Array, requestMw: number): { readonly requestMw: number; readonly deliveredMw: number; readonly utilisation: number } => {
  const units = workspace.units
  const externals = workspace.externalEquivalents
  let externalMw = 0
  for (const external of externals) externalMw += requestMw >= 0 ? external.reserves.afrrUpMw : external.reserves.afrrDownMw
  const directional = (requestMw >= 0 ? afrrUpCapacityMw(units, synchronised) : afrrDownCapacityMw(units, synchronised)) + externalMw
  let unitsDeliveredMw = 0
  for (let unit = 0; unit < synchronised.length; unit += 1) unitsDeliveredMw += synchronised[unit] === 1 ? workspace.afrrMw[unit]! : 0
  let externalsDeliveredMw = 0
  for (const state of workspace.externals) externalsDeliveredMw += state.afrrMw
  return { requestMw, deliveredMw: unitsDeliveredMw + externalsDeliveredMw, utilisation: directional > 0 ? requestMw / directional : 0 }
}

/** The working synchronised flags of the workspace's last advance (trips during it cleared them). */
export const advancedSynchronised = (workspace: IslandFrequencyWorkspace): Uint8Array => kernelOf(workspace).synchronised

/**
 * One aFRR controller cycle: updates the island request, distributes it to providers within
 * their output limits, then lets mFRR take over sustained aFRR utilisation.
 */
const runRestorationCycle = (context: {
  readonly automation: GridAutomation
  readonly afrr: EnabledAfrr
  readonly agc: AgcState
  readonly mfrr: MfrrState | null
  readonly workspace: IslandFrequencyWorkspace
  readonly synchronised: Uint8Array
  readonly frequencyHz: number
  readonly nowSeconds: number
  readonly mfrrAt: (ramp: MfrrUnitRamp, atSeconds: number) => number
}): { readonly agc: AgcState; readonly mfrr: MfrrState | null; readonly action: FrequencyAction | null } => {
  const { automation, workspace, synchronised, nowSeconds: t0, mfrrAt } = context
  const units = workspace.units
  const externals = workspace.externalEquivalents
  const unitCount = synchronised.length
  const unitUpMw = afrrUpCapacityMw(units, synchronised)
  const unitDownMw = afrrDownCapacityMw(units, synchronised)
  let externalUpMw = 0
  for (const external of externals) externalUpMw += external.reserves.afrrUpMw
  let externalDownMw = 0
  for (const external of externals) externalDownMw += external.reserves.afrrDownMw
  const capacityUpMw = unitUpMw + externalUpMw
  const capacityDownMw = unitDownMw + externalDownMw
  let unitsFcrNMw = 0
  for (let unit = 0; unit < unitCount; unit += 1) unitsFcrNMw += synchronised[unit] === 1 ? units.fcrNReserveMw[unit]! : 0
  let externalsFcrNMw = 0
  for (const external of externals) externalsFcrNMw += external.reserves.fcrNMw
  const fcrNStrengthMwPerHz = (unitsFcrNMw + externalsFcrNMw) / automation.fcrN.fullActivationDeviationHz
  let externalLoadMw = 0
  for (const external of externals) externalLoadMw += external.loadMw
  const dampingMwPerHz = (servedAtNominalMw(workspace) + externalLoadMw) * automation.swing.loadDampingPercentPerHz / 100
  const cycle = runAgcCycle(context.afrr, context.agc, {
    frequencyHz: context.frequencyHz,
    nominalFrequencyHz: automation.swing.nominalFrequencyHz,
    frequencyBiasMwPerHz: context.afrr.frequencyBiasFactor * (fcrNStrengthMwPerHz + dampingMwPerHz),
    ...(workspace.tieLineDeviationMw === undefined ? {} : { tieLineDeviationMw: workspace.tieLineDeviationMw }),
    upCapacityMw: capacityUpMw,
    downCapacityMw: capacityDownMw,
  })
  // Providers share the request by their allocation in its direction; external equivalents deliver their share in full.
  const requestMw = cycle.state.requestMw
  const allocated = requestMw >= 0 ? capacityUpMw : capacityDownMw
  // distributeAfrrRequest: the units' part of the request, by each unit's allocation in its direction.
  const unitsRequestMw = allocated > 0 ? requestMw * (requestMw >= 0 ? unitUpMw : unitDownMw) / allocated : 0
  const distributedAllocation = unitsRequestMw >= 0 ? units.afrrUpReserveMw : units.afrrDownReserveMw
  let totalAllocationMw = 0
  for (let unit = 0; unit < unitCount; unit += 1) totalAllocationMw += synchronised[unit] === 1 ? distributedAllocation[unit]! : 0
  for (let position = 0; position < externals.length; position += 1) {
    const external = externals[position]!
    const externalAllocation = requestMw >= 0 ? external.reserves.afrrUpMw : external.reserves.afrrDownMw
    workspace.externals[position] = { ...workspace.externals[position]!, afrrMw: allocated > 0 ? requestMw * externalAllocation / allocated : 0 }
  }
  for (let unit = 0; unit < unitCount; unit += 1) {
    const share = totalAllocationMw > 0 ? unitsRequestMw * (synchronised[unit] === 1 ? distributedAllocation[unit]! : 0) / totalAllocationMw : 0
    const scheduledMw = workspace.scheduledMw[unit]!
    // A provider cannot follow its share beyond its own output band.
    const baseMw = scheduledMw + deliveredMfrrMw(units, unit, scheduledMw, mfrrAt(workspace.mfrrRamp[unit]!, t0))
    const upRoomMw = Math.max(0, bandHighMw(units, unit, scheduledMw) - baseMw)
    const downRoomMw = Math.max(0, baseMw - bandLowMw(units, unit, scheduledMw))
    workspace.afrrMw[unit] = synchronised[unit] === 1 ? Math.min(upRoomMw, Math.max(-downRoomMw, share)) : 0
  }
  const mfrrConfig = automation.mfrr
  if (!mfrrConfig.enabled || !context.mfrr) return { agc: cycle.state, mfrr: context.mfrr, action: null }
  const timing = mfrrTiming(mfrrConfig)
  let rampInProgress = false
  for (let unit = 0; unit < unitCount && !rampInProgress; unit += 1) rampInProgress = mfrrRampInProgress(workspace.mfrrRamp[unit]!, t0, timing)
  let unitsActivatedMw = 0
  for (let unit = 0; unit < unitCount; unit += 1) {
    unitsActivatedMw += synchronised[unit] === 1 ? workspace.afrrMw[unit]! + workspace.fcrNMw[unit]! + workspace.fcrDUpMw[unit]! + workspace.fcrDDownMw[unit]! : 0
  }
  let storageActivatedMw = 0
  for (const storage of workspace.storage) storageActivatedMw += storage.responseMw
  let externalsActivatedMw = 0
  for (const external of workspace.externals) externalsActivatedMw += external.fcrNMw + external.fcrDUpMw + external.fcrDDownMw + external.afrrMw
  const decision = evaluateMfrr(mfrrConfig, context.mfrr, {
    activatedReservesMw: unitsActivatedMw + storageActivatedMw + externalsActivatedMw,
    afrrUtilisation: cycle.utilisation,
    cycleSeconds: context.afrr.cycleSeconds,
    rampInProgress,
  })
  if (decision.activationMw === 0) return { agc: cycle.state, mfrr: decision.state, action: null }
  // distributeMfrrActivation: the activation shared by the room each unit has left within its allocation.
  const activationMw = decision.activationMw
  const room = (unit: number): number => {
    if (synchronised[unit] !== 1) return 0
    const level = workspace.mfrrRamp[unit]!.toMw
    return activationMw >= 0
      ? Math.max(0, Math.min(units.mfrrUpReserveMw[unit]! - level, units.maximumMw[unit]! - units.targetMw[unit]! - level))
      : Math.max(0, Math.min(units.mfrrDownReserveMw[unit]! + level, units.targetMw[unit]! + level - units.minimumMw[unit]!))
  }
  let totalRoom = 0
  for (let unit = 0; unit < unitCount; unit += 1) totalRoom += room(unit)
  const magnitude = Math.min(Math.abs(activationMw), totalRoom)
  const sign = activationMw >= 0 ? 1 : -1
  if (totalRoom > 0) {
    for (let unit = 0; unit < unitCount; unit += 1) {
      const current = workspace.mfrrRamp[unit]!
      const toMw = current.toMw + sign * magnitude * room(unit) / totalRoom
      if (toMw !== current.toMw) workspace.mfrrRamp[unit] = { fromMw: mfrrAt(current, t0), toMw, startedAtSeconds: t0 }
    }
  }
  return {
    agc: cycle.state,
    mfrr: decision.state,
    action: { kind: 'mfrr-activated', atSeconds: t0, requestedMw: activationMw, activatedMw: sign * magnitude, shortfallMw: Math.abs(activationMw) - magnitude },
  }
}
