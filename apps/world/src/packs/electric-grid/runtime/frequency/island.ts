import type { GridAutomation } from '../../schemas/grid-automation.ts'
import { afrrCapacity, distributeAfrrRequest, runAgcCycle, type AgcState, type EnabledAfrr } from './agc.ts'
import { evaluateGeneratorProtection } from './generator-protection.ts'
import { fcrDDownElement, fcrDUpElement, fcrNElement, unitFcrCaps } from './governors.ts'
import type { FrequencyAction, IslandFrequencyState, UnitFrequencyState } from './island-state.ts'
import { validateIslandInput } from './island-state.ts'
import { evaluateLfdd, lfddShedFractionByLoad, type LfddState } from './lfdd.ts'
import { distributeMfrrActivation, evaluateMfrr, idleMfrrRamp, mfrrOutputMw, mfrrRampInProgress, type MfrrState, type MfrrUnitRamp } from './mfrr.ts'
import { completeStorageSubStep, planStorageSubStep, type StorageFrequencyState, type StorageOperatingState } from './storage.ts'
import { integrateSwingSubStep, islandKineticEnergyMws, type ResponseElement } from './swing.ts'
import type { FrequencyUnit, IslandFrequencyInput } from './types.ts'

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

export interface IslandFrequencyAdvance {
  readonly state: IslandFrequencyState
  readonly actions: ReadonlyArray<FrequencyAction>
  readonly units: ReadonlyArray<UnitFrequencyOutput>
  readonly storage: ReadonlyArray<StorageFrequencyOutput>
  readonly loads: ReadonlyArray<LoadFrequencyOutput>
  readonly kineticEnergyMws: number
  /** Lowest and highest frequency reached at any sub-step boundary of this advance. */
  readonly extremes: { readonly minimumHz: number; readonly minimumAtSeconds: number; readonly maximumHz: number; readonly maximumAtSeconds: number } | null
  /** Island aFRR request, the part providers deliver, and the request as a share of allocated aFRR. */
  readonly afrr: { readonly requestMw: number; readonly deliveredMw: number; readonly utilisation: number } | null
}

const stepTolerance = 1e-9

type WorkingUnitState = { -readonly [K in keyof UnitFrequencyState]: UnitFrequencyState[K] }

const rampScheduled = (fromMw: number, targetMw: number, rateMwPerSecond: number, seconds: number): { readonly endMw: number; readonly energyMws: number } => {
  const distanceMw = Math.abs(targetMw - fromMw)
  const reachSeconds = distanceMw / rateMwPerSecond
  if (reachSeconds >= seconds) {
    const endMw = fromMw + Math.sign(targetMw - fromMw) * rateMwPerSecond * seconds
    return { endMw, energyMws: (fromMw + endMw) / 2 * seconds }
  }
  return { endMw: targetMw, energyMws: (fromMw + targetMw) / 2 * reachSeconds + targetMw * (seconds - reachSeconds) }
}

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
  const externalStates = new Map(input.externals.map(external => [external.id, state.externals[external.id]!] as const))
  let agc = state.agc
  let mfrr = state.mfrr
  let lfdd = state.lfdd
  let frequencyHz = state.frequencyHz
  let rocofHzPerSecond = state.rocofHzPerSecond
  let elapsedSeconds = state.elapsedSeconds
  let collapsed = false
  let extremes: { minimumHz: number; minimumAtSeconds: number; maximumHz: number; maximumAtSeconds: number } | null =
    dtSeconds > 0 ? { minimumHz: frequencyHz, minimumAtSeconds: elapsedSeconds, maximumHz: frequencyHz, maximumAtSeconds: elapsedSeconds } : null
  const mfrrAt = (ramp: MfrrUnitRamp, atSeconds: number): number =>
    automation.mfrr.enabled ? mfrrOutputMw(ramp, atSeconds, automation.mfrr.fullActivationSeconds) : 0
  const mfrrEnergy = (ramp: MfrrUnitRamp, t0: number, t1: number): number =>
    automation.mfrr.enabled ? mfrrEnergyMws(ramp, t0, t1, automation.mfrr.fullActivationSeconds) : 0
  for (const unit of input.storage) {
    const current = storageStates.get(unit.id)!
    if (unit.connected || current.operatingState === 'disconnected') continue
    storageStates.set(unit.id, { ...current, responseMw: 0, operatingState: 'disconnected' })
    actions.push({ kind: 'storage-state-changed', storageId: unit.id, atSeconds: elapsedSeconds, from: current.operatingState, to: 'disconnected' })
  }
  const fullSteps = Math.floor(dtSeconds / h + stepTolerance)
  const remainderSeconds = dtSeconds - fullSteps * h
  const stepLengths = remainderSeconds > stepTolerance ? [...Array<number>(fullSteps).fill(h), remainderSeconds] : Array<number>(fullSteps).fill(h)

  for (const stepSeconds of stepLengths) {
    const t0 = elapsedSeconds
    const t1 = t0 + stepSeconds
    const kineticEnergyMws = islandKineticEnergyMws(units, input.externals)
    if (kineticEnergyMws <= 0) {
      collapsed = true
      actions.push({ kind: 'island-collapsed', atSeconds: t0, cause: 'no-synchronous-inertia' })
      break
    }
    const f0 = frequencyHz

    if (automation.afrr.enabled && agc) {
      while (t0 + stepTolerance >= agc.nextCycleAtSeconds) {
        const cycle = runRestorationCycle({ automation, afrr: automation.afrr, agc, mfrr, units, unitStates, storageStates, input, lfdd, frequencyHz: f0, nowSeconds: t0, mfrrAt })
        agc = cycle.agc
        mfrr = cycle.mfrr
        if (cycle.action) actions.push(cycle.action)
      }
    }

    const elements: ResponseElement[] = []
    const applyElement: Array<(outputMw: number, energyMws: number) => void> = []
    let fixedEnergyMws = -input.lossesMw * stepSeconds
    const scheduledEnd = new Map<string, number>()
    for (const unit of units) {
      if (!unit.synchronised) continue
      const current = unitStates.get(unit.id)!
      const scheduled = rampScheduled(current.scheduledMw, unit.targetMw, unit.rampRateMwPerSecond, stepSeconds)
      scheduledEnd.set(unit.id, scheduled.endMw)
      const mfrrStartMw = mfrrAt(current.mfrr, t0)
      const mfrrEndMw = mfrrAt(current.mfrr, t1)
      fixedEnergyMws += scheduled.energyMws + current.afrrMw * stepSeconds + mfrrEnergy(current.mfrr, t0, t1)
      const baseStartMw = current.scheduledMw + current.afrrMw + mfrrStartMw
      const baseEndMw = scheduled.endMw + current.afrrMw + mfrrEndMw
      const caps = unitFcrCaps(unit, Math.max(baseStartMw, baseEndMw), Math.min(baseStartMw, baseEndMw))
      const set = (field: 'fcrNMw' | 'fcrDUpMw' | 'fcrDDownMw') => (outputMw: number): void => {
        current[field] = outputMw
      }
      if (unit.reserves.fcrNMw > 0) {
        elements.push(fcrNElement({ outputMw: current.fcrNMw, caps, nominalHz, fcrN: automation.fcrN }))
        applyElement.push(set('fcrNMw'))
      }
      if (unit.reserves.fcrDUpMw > 0) {
        elements.push(fcrDUpElement({ outputMw: current.fcrDUpMw, caps, up: automation.fcrD.up }))
        applyElement.push(set('fcrDUpMw'))
      }
      if (unit.reserves.fcrDDownMw > 0) {
        elements.push(fcrDDownElement({ outputMw: current.fcrDDownMw, caps, down: automation.fcrD.down }))
        applyElement.push(set('fcrDDownMw'))
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
      fixedEnergyMws += external.scheduledImportMw * stepSeconds
      if (external.frequencyResponseMwPerHz <= 0) continue
      elements.push({
        outputMw: externalStates.get(external.id)!.responseMw,
        timeConstantSeconds: external.responseTimeConstantSeconds,
        target: f => Math.min(external.responseLimitMw, Math.max(-external.responseLimitMw, -external.frequencyResponseMwPerHz * (f - nominalHz))),
      })
      applyElement.push(outputMw => externalStates.set(external.id, { responseMw: outputMw }))
    }

    const step = integrateSwingSubStep({
      nominalFrequencyHz: nominalHz,
      frequencyHz: f0,
      kineticEnergyMws,
      stepSeconds,
      fixedEnergyMws,
      loadMw: servedAtNominalMw(input, lfddShedFractionByLoad(lfdd)),
      loadDampingPerHz: dampingPerHz,
      elements,
    })
    step.elementOutputsMw.forEach((outputMw, index) => applyElement[index]!(outputMw, step.elementEnergyMws[index]!))
    for (const [unitId, endMw] of scheduledEnd) unitStates.get(unitId)!.scheduledMw = endMw
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

    frequencyHz = step.frequencyHz
    rocofHzPerSecond = step.rocofHzPerSecond
    elapsedSeconds = t1
    if (!(frequencyHz > nominalHz * 0.9 && frequencyHz < nominalHz * 1.1)) {
      throw new Error(`island ${input.islandId} frequency ${frequencyHz.toFixed(3)} Hz left the swing model's validity range at ${t1.toFixed(1)} s`)
    }
    if (extremes) {
      if (frequencyHz < extremes.minimumHz) extremes = { ...extremes, minimumHz: frequencyHz, minimumAtSeconds: t1 }
      if (frequencyHz > extremes.maximumHz) extremes = { ...extremes, maximumHz: frequencyHz, maximumAtSeconds: t1 }
    }

    const tripped = new Set<string>()
    for (const unit of units) {
      if (!unit.synchronised) continue
      const current = unitStates.get(unit.id)!
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
    if (tripped.size > 0) units = units.map(unit => tripped.has(unit.id) ? { ...unit, synchronised: false } : unit)

    const lfddStep = evaluateLfdd(automation.lfdd, lfdd, { previousFrequencyHz: f0, frequencyHz, stepSeconds, nowSeconds: t1, loads: input.loads })
    lfdd = lfddStep.state
    for (const operation of lfddStep.operations) actions.push({ kind: 'lfdd-stage-operated', ...operation })
  }

  const shedFractions = lfddShedFractionByLoad(lfdd)
  const finalFrequencyHz = collapsed ? null : frequencyHz
  const selfRegulation = finalFrequencyHz === null ? 0 : 1 + dampingPerHz * (finalFrequencyHz - nominalHz)
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
    units: units.map(unit => {
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
    }),
    storage: input.storage.map(unit => {
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
    }),
    loads: input.loads.map(load => {
      const fraction = shedFractions.get(load.id) ?? 0
      return { id: load.id, servedMw: load.demandMw * (1 - fraction) * selfRegulation, lfddShedMw: load.demandMw * fraction }
    }),
    kineticEnergyMws: collapsed ? 0 : islandKineticEnergyMws(units, input.externals),
    extremes,
    afrr: agc ? afrrStatus(agc.requestMw, units, unitStates) : null,
  }
}

const servedAtNominalMw = (input: IslandFrequencyInput, shedFractions: ReadonlyMap<string, number>): number =>
  input.loads.reduce((sum, load) => sum + load.demandMw * (1 - (shedFractions.get(load.id) ?? 0)), 0)

const afrrStatus = (requestMw: number, units: ReadonlyArray<FrequencyUnit>, unitStates: ReadonlyMap<string, UnitFrequencyState>): {
  readonly requestMw: number
  readonly deliveredMw: number
  readonly utilisation: number
} => {
  const capacity = afrrCapacity(units)
  const directional = requestMw >= 0 ? capacity.upMw : capacity.downMw
  return {
    requestMw,
    deliveredMw: units.reduce((sum, unit) => sum + (unit.synchronised ? unitStates.get(unit.id)!.afrrMw : 0), 0),
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
  readonly input: IslandFrequencyInput
  readonly lfdd: LfddState
  readonly frequencyHz: number
  readonly nowSeconds: number
  readonly mfrrAt: (ramp: MfrrUnitRamp, atSeconds: number) => number
}): { readonly agc: AgcState; readonly mfrr: MfrrState | null; readonly action: FrequencyAction | null } => {
  const { automation, units, unitStates, nowSeconds: t0, mfrrAt } = context
  const capacity = afrrCapacity(units)
  const fcrNStrengthMwPerHz = units.reduce((sum, unit) => sum + (unit.synchronised ? unit.reserves.fcrNMw : 0), 0)
    / automation.fcrN.fullActivationDeviationHz
  const dampingMwPerHz = servedAtNominalMw(context.input, lfddShedFractionByLoad(context.lfdd)) * automation.swing.loadDampingPercentPerHz / 100
  const cycle = runAgcCycle(context.afrr, context.agc, {
    frequencyHz: context.frequencyHz,
    nominalFrequencyHz: automation.swing.nominalFrequencyHz,
    frequencyBiasMwPerHz: context.afrr.frequencyBiasFactor * (fcrNStrengthMwPerHz + dampingMwPerHz),
    ...(context.input.tieLineDeviationMw === undefined ? {} : { tieLineDeviationMw: context.input.tieLineDeviationMw }),
    upCapacityMw: capacity.upMw,
    downCapacityMw: capacity.downMw,
  })
  const shares = distributeAfrrRequest(cycle.state.requestMw, units)
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
