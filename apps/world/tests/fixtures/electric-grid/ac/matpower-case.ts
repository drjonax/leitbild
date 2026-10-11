// MATPOWER case data (format version 2, columns as in MATPOWER's `idx_bus`, `idx_gen`,
// `idx_brch`) and its conversion to the AC load-flow inputs. Only the columns the load flow
// reads are transcribed. Bus numbers must be 1..n in order.
import { createAcNetwork, type AcNetwork } from '../../../../src/packs/electric-grid/runtime/network/ac-network.ts'
import type { AcPowerFlowSpecification } from '../../../../src/packs/electric-grid/runtime/network/fdlf.ts'

/** BUS_I, BUS_TYPE (1 PQ, 2 PV, 3 reference), PD MW, QD Mvar, GS MW, BS Mvar (at 1 pu), VM pu, VA degrees. */
export type MatpowerBusRow = readonly [number, 1 | 2 | 3, number, number, number, number, number, number]
/** GEN_BUS, PG MW, QG Mvar, QMAX Mvar, QMIN Mvar, VG pu, GEN_STATUS. */
export type MatpowerGeneratorRow = readonly [number, number, number, number, number, number, 0 | 1]
/** F_BUS, T_BUS, BR_R pu, BR_X pu, BR_B pu, TAP (0 = nominal), SHIFT degrees, BR_STATUS. */
export type MatpowerBranchRow = readonly [number, number, number, number, number, number, number, 0 | 1]

export interface MatpowerCase {
  readonly name: string
  readonly baseMva: number
  readonly bus: ReadonlyArray<MatpowerBusRow>
  readonly gen: ReadonlyArray<MatpowerGeneratorRow>
  readonly branch: ReadonlyArray<MatpowerBranchRow>
}

export interface MatpowerAcCase {
  readonly network: AcNetwork
  readonly specification: AcPowerFlowSpecification
  /** Network index of the type-3 bus. */
  readonly referenceBus: number
  /** Σ PD, MW. */
  readonly totalLoadMw: number
}

export interface MatpowerConversionOptions {
  /** Apply generator Q limits at PV buses; the reference bus is always unlimited (MATPOWER's default). */
  readonly reactiveLimits: 'none' | 'pv-buses'
}

export const matpowerAcCase = (data: MatpowerCase, options: MatpowerConversionOptions): MatpowerAcCase => {
  const busCount = data.bus.length
  data.bus.forEach((row, index) => {
    if (row[0] !== index + 1) throw new Error(`${data.name} bus row ${index} is bus ${row[0]}; expected consecutive numbering`)
  })
  const branches = data.branch.filter(row => row[7] === 1)
  for (const row of branches) if (row[6] !== 0) throw new Error(`${data.name} branch ${row[0]}-${row[1]} has a phase shift, which the load flow does not model`)
  const busIds = data.bus.map(row => `bus-${row[0]}`)
  const network = createAcNetwork({
    sBaseMva: data.baseMva,
    busCount,
    branchCount: branches.length,
    busIds,
    branchFrom: Int32Array.from(branches, row => row[0] - 1),
    branchTo: Int32Array.from(branches, row => row[1] - 1),
    branchResistancePu: Float64Array.from(branches, row => row[2]),
    branchReactancePu: Float64Array.from(branches, row => row[3]),
    branchChargingSusceptancePu: Float64Array.from(branches, row => row[4]),
    branchTapRatio: Float64Array.from(branches, row => (row[5] === 0 ? 1 : row[5])),
    busShuntConductancePu: Float64Array.from(data.bus, row => row[4] / data.baseMva),
    busShuntSusceptancePu: Float64Array.from(data.bus, row => row[5] / data.baseMva),
  })
  const activeInjectionMw = Float64Array.from(data.bus, row => -row[2])
  const reactiveInjectionMvar = Float64Array.from(data.bus, row => -row[3])
  const voltageControlled = new Uint8Array(busCount)
  const voltageSetpointPu = new Float64Array(busCount).fill(Number.NaN)
  const reactiveMinimumMvar = new Float64Array(busCount)
  const reactiveMaximumMvar = new Float64Array(busCount)
  for (const row of data.gen) {
    if (row[6] !== 1) continue
    const bus = row[0] - 1
    const type = data.bus[bus]![1]
    activeInjectionMw[bus] = activeInjectionMw[bus]! + row[1]
    if (type === 1) {
      reactiveInjectionMvar[bus] = reactiveInjectionMvar[bus]! + row[2]
      continue
    }
    if (voltageControlled[bus] === 1 && voltageSetpointPu[bus] !== row[5]) throw new Error(`${data.name} bus ${row[0]} has generators with different set-points`)
    voltageControlled[bus] = 1
    voltageSetpointPu[bus] = row[5]
    reactiveMinimumMvar[bus] = reactiveMinimumMvar[bus]! + row[4]
    reactiveMaximumMvar[bus] = reactiveMaximumMvar[bus]! + row[3]
  }
  let referenceBus = -1
  data.bus.forEach((row, bus) => {
    if (row[1] !== 1 && voltageControlled[bus] !== 1) throw new Error(`${data.name} bus ${row[0]} is type ${row[1]} without an in-service generator`)
    if (row[1] === 3) {
      if (referenceBus !== -1) throw new Error(`${data.name} has more than one reference bus`)
      referenceBus = bus
    }
    if (row[1] === 3 || options.reactiveLimits === 'none') {
      reactiveMinimumMvar[bus] = -Infinity
      reactiveMaximumMvar[bus] = Infinity
    }
  })
  if (referenceBus === -1) throw new Error(`${data.name} has no reference bus`)
  return {
    network,
    specification: { activeInjectionMw, reactiveInjectionMvar, voltageControlled, voltageSetpointPu, reactiveMinimumMvar, reactiveMaximumMvar },
    referenceBus,
    totalLoadMw: data.bus.reduce((sum, row) => sum + row[2], 0),
  }
}
