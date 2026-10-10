import type { GridAutomation } from '../../schemas/grid-automation.ts'
import { afrrCapacity, distributeAfrrRequest, runAgcCycle, type AgcState, type EnabledAfrr } from './agc.ts'
import { evaluateGeneratorProtection } from './generator-protection.ts'
import { fcrDDownActivation, fcrDUpActivation, fcrNActivation } from './governors.ts'
import type { ExternalFrequencyState, FrequencyAction, IslandFrequencyState, UnitFrequencyState } from './island-state.ts'
import { validateIslandInput } from './island-state.ts'
import { evaluateLfdd, lfddShedFractionByLoad, type LfddState } from './lfdd.ts'
import { distributeMfrrActivation, evaluateMfrr, idleMfrrRamp, mfrrOutputMw, mfrrRampInProgress, type MfrrState, type MfrrUnitRamp } from './mfrr.ts'
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

type WorkingUnitState = { -readonly [K in keyof UnitFrequencyState]: UnitFrequencyState[K] }

/** Exact integral of a linear mFRR ramp over [t0, t1]. */
const mfrrEnergyMws = (ramp: MfrrUnitRamp, t0: number, t1: number, fullActivationSeconds: number): number => {
  if (ramp.fromMw === ramp.toMw) return ramp.toMw * (t1 - t0)
  const rampEnd = ramp.startedAtSeconds + fullActivationSeconds
  let energy = 0
  let a = t0
  for (const point of [ramp.startedAtSeconds, rampEnd, t1]) {
    if (point <= a || point > t1) continue
    energy += (mfrrOutputMw(ramp, a, fullActivationSeconds) + mfrrOutputMw(ramp, point, fullActivationSeconds)) / 2 * (point - a)
    a = point
  }
  return energy
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
    automation.mfrr.enabled ? mfrrOutputMw(ramp, atSeconds, automation.mfrr.fullActivationSeconds) : 0
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
  const mfrrFullSeconds = automation.mfrr.enabled ? automation.mfrr.fullActivationSeconds : 1

  // Synchronised units and their working states, kept in step; rebuilt only after a protection trip.
  let active: FrequencyUnit[] = []
  let activeStates: WorkingUnitState[] = []
  const collectActive = (): void => {
    active = units.filter(unit => unit.synchronised)
    activeStates = active.map(unit => unitStates.get(unit.id)!)
  }
  collectActive()
  let kineticEnergyMws = islandKineticEnergyMws(units, input.externals)
  let servedNominalMw = servedAtNominalMw(input, lfddShedFractionByLoad(lfdd))
  // Per-unit scratch for one sub-step: scheduled end, FCR starting outputs and caps.
  let scheduledEnd = new Float64Array(active.length)
  let nStart = new Float64Array(active.length)
  let nUp = new Float64Array(active.length)
  let nDown = new Float64Array(active.length)
  let dUpStart = new Float64Array(active.length)
  let dUpCap = new Float64Array(active.length)
  let dDownStart = new Float64Array(active.length)
  let dDownCap = new Float64Array(active.length)
  const resizeScratch = (): void => {
    scheduledEnd = new Float64Array(active.length)
    nStart = new Float64Array(active.length)
    nUp = new Float64Array(active.length)
    nDown = new Float64Array(active.length)
    dUpStart = new Float64Array(active.length)
    dUpCap = new Float64Array(active.length)
    dDownStart = new Float64Array(active.length)
    dDownCap = new Float64Array(active.length)
  }
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
        const cycle = runRestorationCycle({ automation, afrr: automation.afrr, agc, mfrr, units, unitStates, storageStates, externalStates, input, lfdd, frequencyHz: f0, nowSeconds: t0, mfrrAt })
        agc = cycle.agc
        mfrr = cycle.mfrr
        if (cycle.action) actions.push(cycle.action)
      }
    }

    const elements: ResponseElement[] = []
    const applyElement: Array<(outputMw: number, energyMws: number) => void> = []
    let fixedEnergyMws = (input.fixedInjectionMw - input.lossesMw) * stepSeconds
    let nStartSum = 0
    let nUpSum = 0
    let nDownSum = 0
    let dUpStartSum = 0
    let dUpSum = 0
    let dDownStartSum = 0
    let dDownSum = 0
    for (let index = 0; index < active.length; index += 1) {
      const unit = active[index]!
      const current = activeStates[index]!
      // Set-point follows the target at the ramp rate; its energy is the exact integral of that ramp.
      const fromMw = current.scheduledMw
      const targetMw = unit.targetMw
      let endMw = targetMw
      let scheduledEnergyMws = targetMw * stepSeconds
      if (fromMw !== targetMw) {
        const reachSeconds = Math.abs(targetMw - fromMw) / unit.rampRateMwPerSecond
        if (reachSeconds >= stepSeconds) {
          endMw = fromMw + Math.sign(targetMw - fromMw) * unit.rampRateMwPerSecond * stepSeconds
          scheduledEnergyMws = (fromMw + endMw) / 2 * stepSeconds
        } else {
          scheduledEnergyMws = (fromMw + targetMw) / 2 * reachSeconds + targetMw * (stepSeconds - reachSeconds)
        }
      }
      scheduledEnd[index] = endMw
      const ramp = current.mfrr
      let mfrrStartMw = 0
      let mfrrEndMw = 0
      let mfrrEnergyMw = 0
      if (mfrrEnabled) {
        if (ramp.fromMw === ramp.toMw) {
          mfrrStartMw = ramp.toMw
          mfrrEndMw = ramp.toMw
          mfrrEnergyMw = ramp.toMw * stepSeconds
        } else {
          mfrrStartMw = mfrrOutputMw(ramp, t0, mfrrFullSeconds)
          mfrrEndMw = mfrrOutputMw(ramp, t1, mfrrFullSeconds)
          mfrrEnergyMw = mfrrEnergyMws(ramp, t0, t1, mfrrFullSeconds)
        }
      }
      fixedEnergyMws += scheduledEnergyMws + current.afrrMw * stepSeconds + mfrrEnergyMw
      const baseStartMw = fromMw + current.afrrMw + mfrrStartMw
      const baseEndMw = endMw + current.afrrMw + mfrrEndMw
      // Headroom split between FCR-N and FCR-D, FCR-N first (see unitFcrCaps).
      const upRoom = Math.max(0, unit.maximumMw - Math.max(baseStartMw, baseEndMw))
      const downRoom = Math.max(0, Math.min(baseStartMw, baseEndMw) - unit.minimumMw)
      const reserves = unit.reserves
      const capNUp = Math.min(reserves.fcrNMw, upRoom)
      const capNDown = Math.min(reserves.fcrNMw, downRoom)
      if (reserves.fcrNMw > 0) {
        nStart[index] = limited(current.fcrNMw, capNUp, capNDown)
        nUp[index] = capNUp
        nDown[index] = capNDown
        nStartSum += nStart[index]!
        nUpSum += capNUp
        nDownSum += capNDown
      }
      if (reserves.fcrDUpMw > 0) {
        const cap = Math.min(reserves.fcrDUpMw, upRoom - capNUp)
        dUpStart[index] = limited(current.fcrDUpMw, cap, 0)
        dUpCap[index] = cap
        dUpStartSum += dUpStart[index]!
        dUpSum += cap
      }
      if (reserves.fcrDDownMw > 0) {
        const cap = Math.min(reserves.fcrDDownMw, downRoom - capNDown)
        dDownStart[index] = limited(current.fcrDDownMw, 0, cap)
        dDownCap[index] = cap
        dDownStartSum += dDownStart[index]!
        dDownSum += cap
      }
    }
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
    for (let index = 0; index < active.length; index += 1) {
      const current = activeStates[index]!
      const reserves = active[index]!.reserves
      current.scheduledMw = scheduledEnd[index]!
      if (reserves.fcrNMw > 0) {
        const up = nUp[index]!
        const down = nDown[index]!
        current.fcrNMw = lagged(nStart[index]!, aN0 * (aN0 >= 0 ? up : down), aN1 * (aN1 >= 0 ? up : down), nLag)
      }
      if (reserves.fcrDUpMw > 0) current.fcrDUpMw = lagged(dUpStart[index]!, aDUp0 * dUpCap[index]!, aDUp1 * dUpCap[index]!, dUpLag)
      if (reserves.fcrDDownMw > 0) current.fcrDDownMw = lagged(dDownStart[index]!, aDDown0 * dDownCap[index]!, aDDown1 * dDownCap[index]!, dDownLag)
    }
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
      throw new Error(`island ${input.islandId} frequency ${frequencyHz.toFixed(3)} Hz left the swing model's validity range at ${t1.toFixed(1)} s`)
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
    for (let index = 0; index < active.length; index += 1) {
      const unit = active[index]!
      const current = activeStates[index]!
      if (quiet && protectionAtRest(current.protection)) continue
      const protection = evaluateGeneratorProtection(automation.generatorProtection, current.protection, {
        previousFrequencyHz: f0, frequencyHz, rocofHzPerSecond, stepSeconds, nowSeconds: t1,
      })
      current.protection = protection
      if (protection.trip) {
        tripped.add(unit.id)
        Object.assign(current, outOfService(current))
        actions.push({ kind: 'generator-trip', unitId: unit.id, atSeconds: t1, elementId: protection.trip.elementId, cause: protection.trip.cause })
      }
    }
    if (tripped.size > 0) {
      units = units.map(unit => tripped.has(unit.id) ? { ...unit, synchronised: false } : unit)
      collectActive()
      resizeScratch()
      kineticEnergyMws = islandKineticEnergyMws(units, input.externals)
    }

    const lfddStep = evaluateLfdd(automation.lfdd, lfdd, { previousFrequencyHz: f0, frequencyHz, stepSeconds, nowSeconds: t1, loads: input.loads })
    lfdd = lfddStep.state
    for (const operation of lfddStep.operations) actions.push({ kind: 'lfdd-stage-operated', ...operation })
    if (lfddStep.operations.length > 0) servedNominalMw = servedAtNominalMw(input, lfddShedFractionByLoad(lfdd))
  }

  const shedFractions = lfddShedFractionByLoad(lfdd)
  const finalFrequencyHz = collapsed ? null : frequencyHz
  const selfRegulation = finalFrequencyHz === null ? 0 : 1 + dampingPerHz * (finalFrequencyHz - nominalHz)
  const unitOutputs = units.map(unit => {
    const current = unitStates.get(unit.id)!
    const mfrrMw = unit.synchronised ? mfrrAt(current.mfrr, elapsedSeconds) : 0
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
      units: Object.fromEntries([...unitStates].map(([unitId, unit]) => [unitId, { ...unit }])),
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
    // A provider cannot follow its share beyond its own output limits.
    const baseMw = current.scheduledMw + mfrrAt(current.mfrr, t0)
    const upRoomMw = Math.max(0, unit.maximumMw - baseMw)
    const downRoomMw = Math.max(0, baseMw - unit.minimumMw)
    current.afrrMw = unit.synchronised ? Math.min(upRoomMw, Math.max(-downRoomMw, shares.get(unit.id)!)) : 0
  }
  const mfrrConfig = automation.mfrr
  if (!mfrrConfig.enabled || !context.mfrr) return { agc: cycle.state, mfrr: context.mfrr, action: null }
  const rampInProgress = units.some(unit => mfrrRampInProgress(unitStates.get(unit.id)!.mfrr, t0, mfrrConfig.fullActivationSeconds))
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
