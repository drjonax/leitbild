// A 132 kV radial feeder from a stiff source: source bus → 40 km → middle bus → 40 km → end
// bus. Per-unit parameters on 100 MVA from 0.40 Ω/km and 0.10 Ω/km (x = Ω·100/132²) and
// 2.8 µS/km charging. At 0.95 lagging power factor the end bus can draw at most about 167 MW
// (a Newton solve converges at 165 MW with |V| = 0.586 pu and fails from 170 MW), so a larger
// `endLoadMw` has no load-flow solution.
import { createAcNetwork, type AcNetwork } from '../../../../src/packs/electric-grid/runtime/network/ac-network.ts'
import type { AcPowerFlowSpecification } from '../../../../src/packs/electric-grid/runtime/network/fdlf.ts'

const kv = 132
const sBaseMva = 100
const segmentKm = 40
const reactancePu = 0.4 * segmentKm * sBaseMva / kv ** 2
const resistancePu = 0.1 * segmentKm * sBaseMva / kv ** 2
const chargingPu = 2.8e-6 * segmentKm * kv ** 2 / sBaseMva
// tan(acos 0.95): reactive share of a 0.95 lagging power factor load.
const tanPhi = Math.tan(Math.acos(0.95))

export const radialFeederNetwork = (): AcNetwork => createAcNetwork({
  sBaseMva,
  busCount: 3,
  branchCount: 2,
  busIds: ['bus:source', 'bus:middle', 'bus:end'],
  branchFrom: Int32Array.of(0, 1),
  branchTo: Int32Array.of(1, 2),
  branchResistancePu: Float64Array.of(resistancePu, resistancePu),
  branchReactancePu: Float64Array.of(reactancePu, reactancePu),
  branchChargingSusceptancePu: Float64Array.of(chargingPu, chargingPu),
  branchTapRatio: Float64Array.of(1, 1),
  busShuntConductancePu: new Float64Array(3),
  busShuntSusceptancePu: new Float64Array(3),
})

/** The source holds 1.02 pu without reactive limit; the middle bus serves 20 MW; both loads at 0.95 lagging. */
export const radialFeederSpecification = (endLoadMw: number): AcPowerFlowSpecification => ({
  activeInjectionMw: Float64Array.of(0, -20, -endLoadMw),
  reactiveInjectionMvar: Float64Array.of(0, -20 * tanPhi, -endLoadMw * tanPhi),
  voltageControlled: Uint8Array.of(1, 0, 0),
  voltageSetpointPu: Float64Array.of(1.02, Number.NaN, Number.NaN),
  reactiveMinimumMvar: Float64Array.of(-Infinity, 0, 0),
  reactiveMaximumMvar: Float64Array.of(Infinity, 0, 0),
})
