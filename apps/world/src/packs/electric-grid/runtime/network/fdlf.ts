import { islandAdmittance, type IslandAdmittance } from './ac-admittance.ts'
import type { AcNetwork } from './ac-network.ts'
import { solveSparseCholesky, type SparseCholeskyFactor } from './sparse-cholesky.ts'
import { factorSymmetricMatrix, symmetricFactorStructure, type SymmetricCouplings } from './symmetric-factor.ts'

/**
 * Fast-decoupled AC load flow, XB variant (Van Amerongen; MATPOWER `fdpf` alg 2). B′ is
 * built from 1/x only (no resistance, charging, shunts or taps), so it equals the island's
 * DC susceptance matrix. B″ is −Im of the series admittances 1/(r + jx) with taps over the
 * PQ buses; unlike MATPOWER it leaves out line charging and bus shunts, which keeps B″
 * positive definite whenever the island has a PV bus (heavily charged networks otherwise
 * make it indefinite) at the same iteration counts on the IEEE cases. Both matrices are
 * constant, so each is factorised once per island structure (B″ once per PQ set) and every
 * iteration is two sparse triangular solves plus two mismatch evaluations. Mismatches always
 * come from the full AC equations with charging and shunts, so the matrices shape only the
 * convergence path, never the solution.
 */

/** Per-bus voltage control of a solution: PQ, PV, or a PV bus held at its reactive limit (then PQ). */
export const acBusControl = { pq: 0, pv: 1, atReactiveMaximum: 2, atReactiveMinimum: 3 } as const
export type AcBusControl = (typeof acBusControl)[keyof typeof acBusControl]

/** Scheduled operating point, indexed by network bus; only the island's buses are read. */
export interface AcPowerFlowSpecification {
  /** Scheduled net active injection (generation − load), MW. */
  readonly activeInjectionMw: Float64Array
  /** Net reactive injection not controlled by a voltage regulator (fixed sources − load), Mvar. At a PV bus this excludes the regulating units. */
  readonly reactiveInjectionMvar: Float64Array
  /** 1 where regulating units hold the bus voltage (PV bus), 0 for a PQ bus. */
  readonly voltageControlled: Uint8Array
  /** Voltage set-point of PV buses, pu. */
  readonly voltageSetpointPu: Float64Array
  /** Combined reactive range of the regulating units at PV buses, Mvar; ±Infinity for an unlimited source. */
  readonly reactiveMinimumMvar: Float64Array
  readonly reactiveMaximumMvar: Float64Array
}

/**
 * Who closes the island's active-power balance (scheduled imbalance plus losses).
 * `single`: one bus takes it all and is the angle reference. `distributed`: buses share it
 * in proportion to their participation factors (any non-negative weights, normalised over
 * the island), and `angleReferenceBus` only fixes θ = 0.
 */
export type AcSlack =
  | { readonly kind: 'single'; readonly bus: number }
  | { readonly kind: 'distributed'; readonly angleReferenceBus: number; readonly participation: Float64Array }

export interface AcPowerFlowOptions {
  readonly slack: AcSlack
  /** Largest admissible |ΔP| over the island and |ΔQ| over PQ buses, pu on sBase (1e-6 pu = 0.1 kW at 100 MVA). */
  readonly tolerancePu: number
  /** Full (P then Q) iterations allowed per inner solve; each reactive-limit pass starts a new inner solve. */
  readonly maximumIterations: number
  /** Switch PV buses to PQ at a violated reactive limit and back when the voltage crosses the set-point. */
  readonly enforceReactiveLimits: boolean
  /**
   * `flat`: |V| = set-point at PV buses and 1 pu elsewhere, θ = 0. `warm`: start from the
   * values in the state arrays (they must be finite with |V| > 0), keeping buses the previous
   * solve left at a reactive limit at that limit.
   */
  readonly start: 'flat' | 'warm'
}

/** Solution arrays indexed by network bus or branch; a solve writes only its island's entries. */
export interface AcPowerFlowState {
  readonly voltagePu: Float64Array
  /** Angle relative to the slack's angle reference, radians. */
  readonly angleRad: Float64Array
  /** Computed net injections; at PV buses the reactive one includes the regulating units. */
  readonly activeInjectionMw: Float64Array
  readonly reactiveInjectionMvar: Float64Array
  /** `acBusControl` code of each bus in the solution. */
  readonly busControl: Uint8Array
  /** Power entering the branch at its from and to ends. */
  readonly branchFromActiveMw: Float64Array
  readonly branchFromReactiveMvar: Float64Array
  readonly branchToActiveMw: Float64Array
  readonly branchToReactiveMvar: Float64Array
}

export const createAcPowerFlowState = (network: AcNetwork): AcPowerFlowState => ({
  voltagePu: new Float64Array(network.busCount).fill(Number.NaN),
  angleRad: new Float64Array(network.busCount).fill(Number.NaN),
  activeInjectionMw: new Float64Array(network.busCount).fill(Number.NaN),
  reactiveInjectionMvar: new Float64Array(network.busCount).fill(Number.NaN),
  busControl: new Uint8Array(network.busCount),
  branchFromActiveMw: new Float64Array(network.branchCount).fill(Number.NaN),
  branchFromReactiveMvar: new Float64Array(network.branchCount).fill(Number.NaN),
  branchToActiveMw: new Float64Array(network.branchCount).fill(Number.NaN),
  branchToReactiveMvar: new Float64Array(network.branchCount).fill(Number.NaN),
})

export interface AcBusMismatch {
  readonly bus: number
  readonly busId: string
  readonly activeMismatchMw: number
  readonly reactiveMismatchMvar: number
}

export interface AcIslandSolution {
  readonly converged: true
  readonly islandId: string
  /** Full iterations summed over all reactive-limit passes. */
  readonly iterations: number
  /** Inner solves after the first, each caused by PV↔PQ switching. */
  readonly reactiveLimitPasses: number
  readonly maximumActiveMismatchMw: number
  readonly maximumReactiveMismatchMvar: number
  /** Σ over branches of the power entering both ends: I²R losses, and I²X minus line charging. */
  readonly activeLossesMw: number
  readonly reactiveLossesMvar: number
  /** MW the slack added to the scheduled injections to close the balance (losses plus scheduled imbalance). */
  readonly slackActiveMw: number
  readonly reactiveLimitedBusCount: number
}

export type AcFailureReason = 'iteration-limit' | 'diverged' | 'no-voltage-control'

/** A failed solve. The island's entries in the state arrays are NaN afterwards. */
export interface AcIslandFailure {
  readonly converged: false
  readonly islandId: string
  readonly reason: AcFailureReason
  readonly detail: string
  readonly iterations: number
  readonly maximumActiveMismatchMw: number
  readonly maximumReactiveMismatchMvar: number
  /** Up to five buses with the largest mismatch, largest first. */
  readonly worstBuses: ReadonlyArray<AcBusMismatch>
}

export type AcIslandOutcome = AcIslandSolution | AcIslandFailure

interface ReactiveFactor {
  readonly hash: number
  /** Island-local PQ buses in ascending order; reduced index q is `pqLocal[q]`. */
  readonly pqLocal: Int32Array
  readonly factor: SparseCholeskyFactor
  readonly rhs: Float64Array
  readonly solution: Float64Array
}

interface IslandWork {
  readonly vm: Float64Array
  readonly va: Float64Array
  readonly vr: Float64Array
  readonly vi: Float64Array
  readonly pCalc: Float64Array
  readonly qCalc: Float64Array
  readonly pSpec: Float64Array
  readonly qSpec: Float64Array
  readonly qFixed: Float64Array
  readonly qMinimum: Float64Array
  readonly qMaximum: Float64Array
  readonly vSetpoint: Float64Array
  readonly participation: Float64Array
  readonly dP: Float64Array
  readonly dQ: Float64Array
  readonly control: Uint8Array
  readonly reEnabled: Uint8Array
  /** The local indices of the PQ buses, in its first entries (scratch of reactiveFactorFor). */
  readonly pqScratch: Int32Array
  readonly activeRhs: Float64Array
  readonly activeSolution: Float64Array
  /** Latest evaluation, per unit: max |ΔP| over the island, max |ΔQ| over PQ buses, and the slack amount λ = Σ (P − P_scheduled). */
  maximumP: number
  maximumQ: number
  slack: number
}

/** One island's AC system: admittances and B′ per island structure, B″ per PQ set, and solve scratch. */
export interface AcIslandSystem {
  readonly islandId: string
  /** Network bus indices, ascending; `buses[0]` is the gauge bus dropped from B′. */
  readonly buses: Int32Array
  /** Closed network branch indices inside the island. */
  readonly branches: Int32Array
  readonly admittance: IslandAdmittance
  readonly activeFactor: SparseCholeskyFactor
  /** Most recently used last. */
  readonly reactiveFactors: ReactiveFactor[]
  readonly work: IslandWork
}

/** B″ factors kept per island; a solve needs one per PQ set it visits, a tick usually reuses the last. */
const reactiveFactorCacheSize = 8

// 32-bit FNV-1a offset basis and prime.
const fnvOffsetBasis = 2166136261
const fnvPrime = 16777619

const busName = (network: AcNetwork, bus: number): string => network.busIds[bus]!

const islandWork = (size: number): IslandWork => ({
  vm: new Float64Array(size),
  va: new Float64Array(size),
  vr: new Float64Array(size),
  vi: new Float64Array(size),
  pCalc: new Float64Array(size),
  qCalc: new Float64Array(size),
  pSpec: new Float64Array(size),
  qSpec: new Float64Array(size),
  qFixed: new Float64Array(size),
  qMinimum: new Float64Array(size),
  qMaximum: new Float64Array(size),
  vSetpoint: new Float64Array(size),
  participation: new Float64Array(size),
  dP: new Float64Array(size),
  dQ: new Float64Array(size),
  control: new Uint8Array(size),
  reEnabled: new Uint8Array(size),
  pqScratch: new Int32Array(size),
  activeRhs: new Float64Array(Math.max(0, size - 1)),
  activeSolution: new Float64Array(Math.max(0, size - 1)),
  maximumP: 0,
  maximumQ: 0,
  slack: 0,
})

/** B′ over buses[1..]: branch susceptances 1/x, parallel circuits summed. */
const activeFactor = (network: AcNetwork, islandId: string, buses: Int32Array, admittance: IslandAdmittance, branches: Int32Array): SparseCholeskyFactor => {
  const size = buses.length - 1
  const diagonal = new Float64Array(size)
  let couplings = 0
  for (let entry = 0; entry < branches.length; entry += 1) {
    if (admittance.branchFromLocal[entry]! > 0 && admittance.branchToLocal[entry]! > 0) couplings += 1
  }
  const entryA = new Int32Array(couplings)
  const entryB = new Int32Array(couplings)
  const entryValue = new Float64Array(couplings)
  let at = 0
  for (let entry = 0; entry < branches.length; entry += 1) {
    const susceptance = 1 / network.branchReactancePu[branches[entry]!]!
    const a = admittance.branchFromLocal[entry]! - 1
    const b = admittance.branchToLocal[entry]! - 1
    if (a >= 0) diagonal[a] = diagonal[a]! + susceptance
    if (b >= 0) diagonal[b] = diagonal[b]! + susceptance
    if (a < 0 || b < 0) continue
    entryA[at] = a
    entryB[at] = b
    entryValue[at] = -susceptance
    at += 1
  }
  const matrix = { size, diagonal, entryA, entryB, entryValue }
  return factorSymmetricMatrix(symmetricFactorStructure(matrix), matrix, `AC island ${islandId} B′ matrix`, vertex => busName(network, buses[vertex + 1]!))
}

/**
 * Builds one island's AC system. `buses` (ascending) and `branches` are network indices of a
 * connected island, as produced by `findGridIslands`; `localOfBus` is scratch of length
 * `network.busCount` whose contents on return are unspecified. B′ (1/x per closed branch, buses[0]
 * dropped) is the DC power flow's susceptance matrix of the same buses and branches: a caller
 * holding that factor (the island's GridIslandSystem.factor) passes it as `activeFactor`; without
 * it B′ is factorised here.
 */
export const createAcIslandSystem = (config: {
  readonly network: AcNetwork
  readonly islandId: string
  readonly buses: Int32Array
  readonly branches: Int32Array
  readonly localOfBus: Int32Array
  readonly activeFactor?: SparseCholeskyFactor
}): AcIslandSystem => {
  const { network, islandId, buses, branches } = config
  if (buses.length === 0) throw new Error(`AC island ${islandId} has no buses`)
  for (let local = 1; local < buses.length; local += 1) {
    if (!(buses[local]! > buses[local - 1]!)) throw new Error(`AC island ${islandId} buses must be strictly ascending network indices`)
  }
  if (config.activeFactor !== undefined && config.activeFactor.structure.size !== buses.length - 1) {
    throw new Error(`AC island ${islandId}: the given B′ factor has ${config.activeFactor.structure.size} rows, not ${buses.length - 1}`)
  }
  const admittance = islandAdmittance(network, buses, branches, config.localOfBus)
  return {
    islandId,
    buses,
    branches,
    admittance,
    activeFactor: config.activeFactor ?? activeFactor(network, islandId, buses, admittance, branches),
    reactiveFactors: [],
    work: islandWork(buses.length),
  }
}

/** FNV-1a over the first `count` indices. */
const pqHash = (pqLocal: Int32Array, count: number): number => {
  let hash = fnvOffsetBasis
  for (let index = 0; index < count; index += 1) hash = Math.imul(hash ^ pqLocal[index]!, fnvPrime)
  return hash >>> 0
}

/** Whether `a` holds exactly the first `count` indices of `b`. */
const sameIndices = (a: Int32Array, b: Int32Array, count: number): boolean => {
  if (a.length !== count) return false
  for (let index = 0; index < count; index += 1) if (a[index] !== b[index]) return false
  return true
}

/** B″ over the PQ buses (PV buses hold V, so their rows and columns drop out); the off-diagonals of Y are series terms only. */
const reactiveMatrix = (system: AcIslandSystem, pqLocal: Int32Array): SymmetricCouplings => {
  const { admittance } = system
  const size = pqLocal.length
  const reducedOf = new Int32Array(admittance.size).fill(-1)
  for (let q = 0; q < size; q += 1) reducedOf[pqLocal[q]!] = q
  const diagonal = new Float64Array(size)
  let couplings = 0
  for (let q = 0; q < size; q += 1) {
    const row = pqLocal[q]!
    for (let entry = admittance.rowStart[row]!; entry < admittance.rowStart[row + 1]!; entry += 1) {
      const other = reducedOf[admittance.column[entry]!]!
      if (other > q) couplings += 1
    }
  }
  const entryA = new Int32Array(couplings)
  const entryB = new Int32Array(couplings)
  const entryValue = new Float64Array(couplings)
  let at = 0
  for (let q = 0; q < size; q += 1) {
    const row = pqLocal[q]!
    diagonal[q] = -admittance.seriesSusceptanceDiagonal[row]!
    for (let entry = admittance.rowStart[row]!; entry < admittance.rowStart[row + 1]!; entry += 1) {
      const other = reducedOf[admittance.column[entry]!]!
      if (other <= q) continue
      entryA[at] = q
      entryB[at] = other
      entryValue[at] = -admittance.susceptance[entry]!
      at += 1
    }
  }
  return { size, diagonal, entryA, entryB, entryValue }
}

const reactiveFactorFor = (network: AcNetwork, system: AcIslandSystem): ReactiveFactor => {
  const { control, pqScratch } = system.work
  let count = 0
  for (let local = 0; local < control.length; local += 1) {
    if (control[local] === acBusControl.pv) continue
    pqScratch[count] = local
    count += 1
  }
  const hash = pqHash(pqScratch, count)
  const cache = system.reactiveFactors
  for (let hit = 0; hit < cache.length; hit += 1) {
    const entry = cache[hit]!
    if (entry.hash !== hash || !sameIndices(entry.pqLocal, pqScratch, count)) continue
    // Most recently used last.
    cache.copyWithin(hit, hit + 1)
    cache[cache.length - 1] = entry
    return entry
  }
  const pqLocal = pqScratch.slice(0, count)
  const matrix = reactiveMatrix(system, pqLocal)
  const numeric = factorSymmetricMatrix(
    symmetricFactorStructure(matrix),
    matrix,
    `AC island ${system.islandId} B″ matrix`,
    vertex => busName(network, system.buses[pqLocal[vertex]!]!),
  )
  const factor: ReactiveFactor = { hash, pqLocal, factor: numeric, rhs: new Float64Array(pqLocal.length), solution: new Float64Array(pqLocal.length) }
  if (cache.length >= reactiveFactorCacheSize) cache.shift()
  cache.push(factor)
  return factor
}

/** S = V·conj(Y·V) at every island bus, the slack amount closing the active balance, and the mismatches. */
const evaluateMismatch = (system: AcIslandSystem): void => {
  const { admittance, work } = system
  const { vm, va, vr, vi, pCalc, qCalc, pSpec, qSpec, participation, dP, dQ, control } = work
  const { rowStart, column, conductance, susceptance } = admittance
  const size = vm.length
  for (let local = 0; local < size; local += 1) {
    vr[local] = vm[local]! * Math.cos(va[local]!)
    vi[local] = vm[local]! * Math.sin(va[local]!)
  }
  let slack = 0
  for (let local = 0; local < size; local += 1) {
    let currentReal = 0
    let currentImaginary = 0
    for (let entry = rowStart[local]!; entry < rowStart[local + 1]!; entry += 1) {
      const other = column[entry]!
      const g = conductance[entry]!
      const b = susceptance[entry]!
      currentReal += g * vr[other]! - b * vi[other]!
      currentImaginary += g * vi[other]! + b * vr[other]!
    }
    const p = vr[local]! * currentReal + vi[local]! * currentImaginary
    pCalc[local] = p
    qCalc[local] = vi[local]! * currentReal - vr[local]! * currentImaginary
    slack += p - pSpec[local]!
  }
  let maximumP = 0
  let maximumQ = 0
  for (let local = 0; local < size; local += 1) {
    const mismatchP = pSpec[local]! + participation[local]! * slack - pCalc[local]!
    dP[local] = mismatchP
    maximumP = Math.max(maximumP, Math.abs(mismatchP))
    if (control[local] === acBusControl.pv) {
      dQ[local] = 0
      continue
    }
    const mismatchQ = qSpec[local]! - qCalc[local]!
    dQ[local] = mismatchQ
    maximumQ = Math.max(maximumQ, Math.abs(mismatchQ))
  }
  work.slack = slack
  work.maximumP = maximumP
  work.maximumQ = maximumQ
}

type InnerStatus = 'converged' | 'iteration-limit' | 'diverged'

/** The first PQ bus whose |V| left (0, ∞), or -1. */
const collapsedBus = (vm: Float64Array, pqLocal: Int32Array): number => {
  for (let q = 0; q < pqLocal.length; q += 1) {
    const value = vm[pqLocal[q]!]!
    if (!(value > 0) || !Number.isFinite(value)) return pqLocal[q]!
  }
  return -1
}

const isConverged = (work: IslandWork, tolerance: number): boolean => work.maximumP < tolerance && work.maximumQ < tolerance
const isFiniteMismatch = (work: IslandWork): boolean => Number.isFinite(work.maximumP) && Number.isFinite(work.maximumQ)

interface InnerResult {
  readonly status: InnerStatus
  readonly iterations: number
  /** Island-local bus whose |V| left (0, ∞) when the status is `diverged` by voltage collapse, else -1. */
  readonly collapsedLocal: number
}

/** FDLF iterations on a fixed PQ set from the current work voltages. */
const innerSolve = (system: AcIslandSystem, reactive: ReactiveFactor, tolerance: number, maximumIterations: number): InnerResult => {
  const { work, activeFactor: factorP } = system
  const { vm, va, dP, dQ, activeRhs, activeSolution } = work
  const { pqLocal, factor: factorQ, rhs: reactiveRhs, solution: reactiveSolution } = reactive
  evaluateMismatch(system)
  if (!isFiniteMismatch(work)) return { status: 'diverged', iterations: 0, collapsedLocal: -1 }
  if (isConverged(work, tolerance)) return { status: 'converged', iterations: 0, collapsedLocal: -1 }
  for (let iteration = 1; iteration <= maximumIterations; iteration += 1) {
    if (activeRhs.length > 0) {
      for (let reduced = 0; reduced < activeRhs.length; reduced += 1) activeRhs[reduced] = dP[reduced + 1]! / vm[reduced + 1]!
      solveSparseCholesky(factorP, activeRhs, activeSolution)
      for (let reduced = 0; reduced < activeSolution.length; reduced += 1) va[reduced + 1] = va[reduced + 1]! + activeSolution[reduced]!
    }
    evaluateMismatch(system)
    if (!isFiniteMismatch(work)) return { status: 'diverged', iterations: iteration, collapsedLocal: -1 }
    if (isConverged(work, tolerance)) return { status: 'converged', iterations: iteration, collapsedLocal: -1 }
    if (pqLocal.length > 0) {
      for (let q = 0; q < pqLocal.length; q += 1) reactiveRhs[q] = dQ[pqLocal[q]!]! / vm[pqLocal[q]!]!
      solveSparseCholesky(factorQ, reactiveRhs, reactiveSolution)
      for (let q = 0; q < pqLocal.length; q += 1) vm[pqLocal[q]!] = vm[pqLocal[q]!]! + reactiveSolution[q]!
      const collapsed = collapsedBus(vm, pqLocal)
      if (collapsed !== -1) return { status: 'diverged', iterations: iteration, collapsedLocal: collapsed }
    }
    evaluateMismatch(system)
    if (!isFiniteMismatch(work)) return { status: 'diverged', iterations: iteration, collapsedLocal: -1 }
    if (isConverged(work, tolerance)) return { status: 'converged', iterations: iteration, collapsedLocal: -1 }
  }
  return { status: 'iteration-limit', iterations: maximumIterations, collapsedLocal: -1 }
}

/** Island-local position of a network bus, by binary search over the ascending bus list. */
const localOf = (system: AcIslandSystem, bus: number, role: string): number => {
  const { buses } = system
  let low = 0
  let high = buses.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const value = buses[middle]!
    if (value === bus) return middle
    if (value < bus) low = middle + 1
    else high = middle - 1
  }
  throw new Error(`AC island ${system.islandId} does not contain its ${role} bus ${bus}`)
}

const requireArrayLength = (name: string, actual: number, expected: number): void => {
  if (actual !== expected) throw new Error(`AC power flow ${name} has ${actual} entries for ${expected}`)
}

/** Loads the island's slice of the specification into per-unit work arrays, validating every value. */
const loadSpecification = (
  network: AcNetwork,
  system: AcIslandSystem,
  specification: AcPowerFlowSpecification,
  options: AcPowerFlowOptions,
): number => {
  const { busCount, sBaseMva } = network
  requireArrayLength('active injections', specification.activeInjectionMw.length, busCount)
  requireArrayLength('reactive injections', specification.reactiveInjectionMvar.length, busCount)
  requireArrayLength('voltage-control flags', specification.voltageControlled.length, busCount)
  requireArrayLength('voltage set-points', specification.voltageSetpointPu.length, busCount)
  requireArrayLength('reactive minima', specification.reactiveMinimumMvar.length, busCount)
  requireArrayLength('reactive maxima', specification.reactiveMaximumMvar.length, busCount)
  const { work, buses } = system
  for (let local = 0; local < buses.length; local += 1) {
    const bus = buses[local]!
    const where = `AC power flow ${busName(network, bus)}`
    const activeMw = specification.activeInjectionMw[bus]!
    const reactiveMvar = specification.reactiveInjectionMvar[bus]!
    if (!Number.isFinite(activeMw) || !Number.isFinite(reactiveMvar)) throw new Error(`${where} needs finite scheduled injections, got ${activeMw} MW, ${reactiveMvar} Mvar`)
    work.pSpec[local] = activeMw / sBaseMva
    work.qFixed[local] = reactiveMvar / sBaseMva
    const controlled = specification.voltageControlled[bus]!
    if (controlled !== 0 && controlled !== 1) throw new Error(`${where} has voltage-control flag ${controlled}; expected 0 or 1`)
    if (controlled === 0) continue
    const setpoint = specification.voltageSetpointPu[bus]!
    const minimum = specification.reactiveMinimumMvar[bus]!
    const maximum = specification.reactiveMaximumMvar[bus]!
    if (!(setpoint > 0) || !Number.isFinite(setpoint)) throw new Error(`${where} needs a finite positive voltage set-point, got ${setpoint} pu`)
    if (Number.isNaN(minimum) || Number.isNaN(maximum) || minimum > maximum || minimum === Infinity || maximum === -Infinity) {
      throw new Error(`${where} has an invalid reactive range ${minimum}..${maximum} Mvar`)
    }
    work.vSetpoint[local] = setpoint
    work.qMinimum[local] = minimum / sBaseMva
    work.qMaximum[local] = maximum / sBaseMva
  }
  work.participation.fill(0)
  const { slack } = options
  if (slack.kind === 'single') {
    const local = localOf(system, slack.bus, 'slack')
    work.participation[local] = 1
    return local
  }
  requireArrayLength('participation factors', slack.participation.length, busCount)
  let total = 0
  for (let local = 0; local < buses.length; local += 1) {
    const factor = slack.participation[buses[local]!]!
    if (!(factor >= 0) || !Number.isFinite(factor)) throw new Error(`AC power flow ${busName(network, buses[local]!)} needs a finite non-negative participation factor, got ${factor}`)
    total += factor
  }
  if (!(total > 0)) throw new Error(`AC island ${system.islandId} has no positive slack participation`)
  for (let local = 0; local < buses.length; local += 1) work.participation[local] = slack.participation[buses[local]!]! / total
  return localOf(system, slack.angleReferenceBus, 'angle reference')
}

const reactiveSpecification = (work: IslandWork, local: number): number => {
  const control = work.control[local]!
  if (control === acBusControl.atReactiveMaximum) return work.qFixed[local]! + work.qMaximum[local]!
  if (control === acBusControl.atReactiveMinimum) return work.qFixed[local]! + work.qMinimum[local]!
  return work.qFixed[local]!
}

const initialiseStart = (
  network: AcNetwork,
  system: AcIslandSystem,
  specification: AcPowerFlowSpecification,
  options: AcPowerFlowOptions,
  state: AcPowerFlowState,
): void => {
  const { work, buses } = system
  for (let local = 0; local < buses.length; local += 1) {
    const bus = buses[local]!
    const controlled = specification.voltageControlled[bus] === 1
    if (options.start === 'flat') {
      work.control[local] = controlled ? acBusControl.pv : acBusControl.pq
      work.vm[local] = controlled ? work.vSetpoint[local]! : 1
      work.va[local] = 0
    } else {
      const voltage = state.voltagePu[bus]!
      const angle = state.angleRad[bus]!
      if (!(voltage > 0) || !Number.isFinite(voltage) || !Number.isFinite(angle)) {
        throw new Error(`AC power flow warm start at ${busName(network, bus)} needs a previous finite solution, got ${voltage} pu, ${angle} rad`)
      }
      const previous = state.busControl[bus]!
      const atLimit = previous === acBusControl.atReactiveMaximum || previous === acBusControl.atReactiveMinimum
      work.control[local] = !controlled ? acBusControl.pq : atLimit && options.enforceReactiveLimits ? previous as AcBusControl : acBusControl.pv
      work.vm[local] = work.control[local] === acBusControl.pv ? work.vSetpoint[local]! : voltage
      work.va[local] = angle
    }
    work.qSpec[local] = reactiveSpecification(work, local)
  }
  work.reEnabled.fill(0)
}

/** Switches violating PV buses to their limit; otherwise re-enables limit buses whose voltage crossed the set-point (once each per solve). */
const switchReactiveLimits = (work: IslandWork, tolerance: number): boolean => {
  const { control, qCalc, qFixed, qMinimum, qMaximum, vm, vSetpoint, reEnabled } = work
  let switched = false
  for (let local = 0; local < control.length; local += 1) {
    if (control[local] !== acBusControl.pv) continue
    const regulated = qCalc[local]! - qFixed[local]!
    if (regulated > qMaximum[local]! + tolerance) control[local] = acBusControl.atReactiveMaximum
    else if (regulated < qMinimum[local]! - tolerance) control[local] = acBusControl.atReactiveMinimum
    else continue
    work.qSpec[local] = reactiveSpecification(work, local)
    switched = true
  }
  if (switched) return true
  for (let local = 0; local < control.length; local += 1) {
    if (reEnabled[local] === 1) continue
    const wantsLess = control[local] === acBusControl.atReactiveMaximum && vm[local]! > vSetpoint[local]! + tolerance
    const wantsMore = control[local] === acBusControl.atReactiveMinimum && vm[local]! < vSetpoint[local]! - tolerance
    if (!wantsLess && !wantsMore) continue
    control[local] = acBusControl.pv
    vm[local] = vSetpoint[local]!
    reEnabled[local] = 1
    switched = true
  }
  return switched
}

const worstBuses = (network: AcNetwork, system: AcIslandSystem): ReadonlyArray<AcBusMismatch> => {
  const { dP, dQ } = system.work
  const score = (local: number): number => {
    const value = Math.max(Math.abs(dP[local]!), Math.abs(dQ[local]!))
    return Number.isNaN(value) ? Infinity : value
  }
  return Array.from(system.buses.keys())
    .sort((a, b) => score(b) - score(a) || a - b)
    .slice(0, 5)
    .map(local => ({
      bus: system.buses[local]!,
      busId: network.busIds[system.buses[local]!]!,
      activeMismatchMw: dP[local]! * network.sBaseMva,
      reactiveMismatchMvar: dQ[local]! * network.sBaseMva,
    }))
}

const clearIsland = (system: AcIslandSystem, state: AcPowerFlowState): void => {
  for (const bus of system.buses) {
    state.voltagePu[bus] = Number.NaN
    state.angleRad[bus] = Number.NaN
    state.activeInjectionMw[bus] = Number.NaN
    state.reactiveInjectionMvar[bus] = Number.NaN
  }
  for (const branch of system.branches) {
    state.branchFromActiveMw[branch] = Number.NaN
    state.branchFromReactiveMvar[branch] = Number.NaN
    state.branchToActiveMw[branch] = Number.NaN
    state.branchToReactiveMvar[branch] = Number.NaN
  }
}

const failure = (
  network: AcNetwork,
  system: AcIslandSystem,
  state: AcPowerFlowState,
  reason: AcFailureReason,
  detail: string,
  iterations: number,
): AcIslandFailure => {
  const outcome: AcIslandFailure = {
    converged: false,
    islandId: system.islandId,
    reason,
    detail,
    iterations,
    maximumActiveMismatchMw: system.work.maximumP * network.sBaseMva,
    maximumReactiveMismatchMvar: system.work.maximumQ * network.sBaseMva,
    worstBuses: worstBuses(network, system),
  }
  clearIsland(system, state)
  return outcome
}

/** Writes the converged island into the state arrays; returns its losses and the number of buses held at a reactive limit. */
const writeSolution = (network: AcNetwork, system: AcIslandSystem, state: AcPowerFlowState, referenceLocal: number) => {
  const { work, buses, branches, admittance } = system
  const { sBaseMva } = network
  const reference = work.va[referenceLocal]!
  let reactiveLimited = 0
  for (let local = 0; local < buses.length; local += 1) {
    const bus = buses[local]!
    state.voltagePu[bus] = work.vm[local]!
    state.angleRad[bus] = work.va[local]! - reference
    state.activeInjectionMw[bus] = work.pCalc[local]! * sBaseMva
    state.reactiveInjectionMvar[bus] = work.qCalc[local]! * sBaseMva
    state.busControl[bus] = work.control[local]!
    if (work.control[local] === acBusControl.atReactiveMaximum || work.control[local] === acBusControl.atReactiveMinimum) reactiveLimited += 1
  }
  const { vr, vi } = work
  const { branchG: g, branchB: b } = admittance
  let activeLosses = 0
  let reactiveLosses = 0
  for (let entry = 0; entry < branches.length; entry += 1) {
    const from = admittance.branchFromLocal[entry]!
    const to = admittance.branchToLocal[entry]!
    const at = 4 * entry
    const fr = vr[from]!
    const fi = vi[from]!
    const tr = vr[to]!
    const ti = vi[to]!
    const fromCurrentReal = g[at]! * fr - b[at]! * fi + g[at + 1]! * tr - b[at + 1]! * ti
    const fromCurrentImaginary = g[at]! * fi + b[at]! * fr + g[at + 1]! * ti + b[at + 1]! * tr
    const toCurrentReal = g[at + 2]! * fr - b[at + 2]! * fi + g[at + 3]! * tr - b[at + 3]! * ti
    const toCurrentImaginary = g[at + 2]! * fi + b[at + 2]! * fr + g[at + 3]! * ti + b[at + 3]! * tr
    const fromP = fr * fromCurrentReal + fi * fromCurrentImaginary
    const fromQ = fi * fromCurrentReal - fr * fromCurrentImaginary
    const toP = tr * toCurrentReal + ti * toCurrentImaginary
    const toQ = ti * toCurrentReal - tr * toCurrentImaginary
    const branch = branches[entry]!
    state.branchFromActiveMw[branch] = fromP * sBaseMva
    state.branchFromReactiveMvar[branch] = fromQ * sBaseMva
    state.branchToActiveMw[branch] = toP * sBaseMva
    state.branchToReactiveMvar[branch] = toQ * sBaseMva
    activeLosses += fromP + toP
    reactiveLosses += fromQ + toQ
  }
  return { activeLossesMw: activeLosses * sBaseMva, reactiveLossesMvar: reactiveLosses * sBaseMva, reactiveLimited }
}

/**
 * Solves one island's AC power flow into `state`. Invalid input throws; a physical failure
 * (no convergence, divergence, no voltage-controlled bus left) returns an
 * `AcIslandFailure` with residuals and the worst buses, and leaves the island's state NaN.
 * There is no fallback to a DC or flat-voltage answer.
 */
export const solveAcIsland = (
  network: AcNetwork,
  system: AcIslandSystem,
  specification: AcPowerFlowSpecification,
  options: AcPowerFlowOptions,
  state: AcPowerFlowState,
): AcIslandOutcome => {
  if (!(options.tolerancePu > 0) || !Number.isFinite(options.tolerancePu)) throw new Error(`AC power flow tolerance must be positive, got ${options.tolerancePu} pu`)
  if (!Number.isInteger(options.maximumIterations) || options.maximumIterations < 1) throw new Error(`AC power flow needs at least one iteration, got ${options.maximumIterations}`)
  requireArrayLength('state bus arrays', state.voltagePu.length, network.busCount)
  requireArrayLength('state branch arrays', state.branchFromActiveMw.length, network.branchCount)
  const referenceLocal = loadSpecification(network, system, specification, options)
  initialiseStart(network, system, specification, options, state)
  const { work } = system
  work.maximumP = Number.NaN
  work.maximumQ = Number.NaN
  let iterations = 0
  let passes = 0
  for (;;) {
    if (!work.control.includes(acBusControl.pv)) {
      evaluateMismatch(system)
      return failure(network, system, state, 'no-voltage-control', `no bus in AC island ${system.islandId} holds its voltage within its reactive range`, iterations)
    }
    const inner = innerSolve(system, reactiveFactorFor(network, system), options.tolerancePu, options.maximumIterations)
    iterations += inner.iterations
    if (inner.status !== 'converged') {
      const detail = inner.status === 'iteration-limit'
        ? `AC island ${system.islandId} did not converge to ${options.tolerancePu} pu within ${options.maximumIterations} iterations`
        : inner.collapsedLocal !== -1
          ? `AC island ${system.islandId} diverged after ${inner.iterations} iterations: |V| at ${busName(network, system.buses[inner.collapsedLocal]!)} reached ${work.vm[inner.collapsedLocal]!} pu`
          : `AC island ${system.islandId} diverged after ${inner.iterations} iterations: mismatch is no longer finite`
      return failure(network, system, state, inner.status, detail, iterations)
    }
    if (!options.enforceReactiveLimits || !switchReactiveLimits(work, options.tolerancePu)) break
    passes += 1
  }
  const losses = writeSolution(network, system, state, referenceLocal)
  return {
    converged: true,
    islandId: system.islandId,
    iterations,
    reactiveLimitPasses: passes,
    maximumActiveMismatchMw: work.maximumP * network.sBaseMva,
    maximumReactiveMismatchMvar: work.maximumQ * network.sBaseMva,
    activeLossesMw: losses.activeLossesMw,
    reactiveLossesMvar: losses.reactiveLossesMvar,
    slackActiveMw: work.slack * network.sBaseMva,
    reactiveLimitedBusCount: losses.reactiveLimited,
  }
}
