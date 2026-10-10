/**
 * Branch and shunt parameters of an AC network in per unit on `sBaseMva`, indexed like the
 * compiled DC network (bus and branch position = integer index). Branches use the π model
 * with an ideal off-nominal transformer at the from end (MATPOWER convention): the series
 * admittance y = 1/(r + jx) sits between the to bus and the transformer's network side,
 * and the line charging B is split equally between the two ends.
 */
export interface AcNetwork {
  readonly sBaseMva: number
  readonly busCount: number
  readonly branchCount: number
  /** Bus ids in index order, used to name buses in failures. */
  readonly busIds: ReadonlyArray<string>
  readonly branchFrom: Int32Array
  readonly branchTo: Int32Array
  readonly branchResistancePu: Float64Array
  /** Series reactance, strictly positive: the fast-decoupled B′ matrix is built from 1/x. */
  readonly branchReactancePu: Float64Array
  /** Total charging susceptance of the branch (both ends together). */
  readonly branchChargingSusceptancePu: Float64Array
  /** Off-nominal turns ratio τ at the from end; 1 is nominal. The from-bus voltage is divided by τ. */
  readonly branchTapRatio: Float64Array
  /** Bus shunt admittance at 1 pu voltage: conductance (consumes P) and susceptance (positive is capacitive, injects Q). */
  readonly busShuntConductancePu: Float64Array
  readonly busShuntSusceptancePu: Float64Array
}

const requireLength = (name: string, actual: number, expected: number): void => {
  if (actual !== expected) throw new Error(`AC network ${name} has ${actual} entries for ${expected}`)
}

/** Validates an AC network's parameters; every value must be finite and physically admissible. */
export const createAcNetwork = (input: AcNetwork): AcNetwork => {
  const { busCount, branchCount, busIds } = input
  if (!(input.sBaseMva > 0) || !Number.isFinite(input.sBaseMva)) throw new Error(`AC network base power must be positive, got ${input.sBaseMva} MVA`)
  if (!Number.isInteger(busCount) || busCount < 1) throw new Error(`AC network needs at least one bus, got ${busCount}`)
  if (!Number.isInteger(branchCount) || branchCount < 0) throw new Error(`AC network branch count must be a non-negative integer, got ${branchCount}`)
  requireLength('bus ids', busIds.length, busCount)
  requireLength('branch from-buses', input.branchFrom.length, branchCount)
  requireLength('branch to-buses', input.branchTo.length, branchCount)
  requireLength('branch resistances', input.branchResistancePu.length, branchCount)
  requireLength('branch reactances', input.branchReactancePu.length, branchCount)
  requireLength('branch charging susceptances', input.branchChargingSusceptancePu.length, branchCount)
  requireLength('branch tap ratios', input.branchTapRatio.length, branchCount)
  requireLength('bus shunt conductances', input.busShuntConductancePu.length, busCount)
  requireLength('bus shunt susceptances', input.busShuntSusceptancePu.length, busCount)
  for (let branch = 0; branch < branchCount; branch += 1) {
    const from = input.branchFrom[branch]!
    const to = input.branchTo[branch]!
    const where = `AC network branch ${branch} (${busIds[from] ?? from} → ${busIds[to] ?? to})`
    if (from < 0 || from >= busCount || to < 0 || to >= busCount) throw new Error(`${where} references a bus outside 0..${busCount - 1}`)
    if (from === to) throw new Error(`${where} connects a bus to itself`)
    const r = input.branchResistancePu[branch]!
    const x = input.branchReactancePu[branch]!
    const b = input.branchChargingSusceptancePu[branch]!
    const tap = input.branchTapRatio[branch]!
    if (!(r >= 0) || !Number.isFinite(r)) throw new Error(`${where} needs a finite non-negative resistance, got ${r} pu`)
    if (!(x > 0) || !Number.isFinite(x)) throw new Error(`${where} needs a finite positive reactance, got ${x} pu`)
    if (!Number.isFinite(b)) throw new Error(`${where} needs a finite charging susceptance, got ${b} pu`)
    if (!(tap > 0) || !Number.isFinite(tap)) throw new Error(`${where} needs a finite positive tap ratio, got ${tap}`)
  }
  for (let bus = 0; bus < busCount; bus += 1) {
    const g = input.busShuntConductancePu[bus]!
    const b = input.busShuntSusceptancePu[bus]!
    if (!Number.isFinite(g) || !Number.isFinite(b)) throw new Error(`AC network bus ${busIds[bus]} needs a finite shunt admittance, got ${g} + j${b} pu`)
  }
  return {
    sBaseMva: input.sBaseMva,
    busCount,
    branchCount,
    busIds,
    branchFrom: input.branchFrom,
    branchTo: input.branchTo,
    branchResistancePu: input.branchResistancePu,
    branchReactancePu: input.branchReactancePu,
    branchChargingSusceptancePu: input.branchChargingSusceptancePu,
    branchTapRatio: input.branchTapRatio,
    busShuntConductancePu: input.busShuntConductancePu,
    busShuntSusceptancePu: input.busShuntSusceptancePu,
  }
}
