// Test-only reference: a dense full Newton–Raphson AC power flow in polar coordinates with
// its own admittance assembly, a finite-difference Jacobian and the same slack semantics as
// the fast-decoupled solver. It is independent of the runtime's sparse code paths, so the
// FDLF fixed point can be checked against it to solver precision on small cases.
import type { AcNetwork } from '../../../../src/packs/electric-grid/runtime/network/ac-network.ts'
import { acBusControl, type AcPowerFlowSpecification, type AcSlack } from '../../../../src/packs/electric-grid/runtime/network/fdlf.ts'

export interface NewtonReferenceSolution {
  readonly voltagePu: Float64Array
  readonly angleRad: Float64Array
  readonly activeInjectionMw: Float64Array
  readonly reactiveInjectionMvar: Float64Array
  readonly slackActiveMw: number
  readonly iterations: number
}

const denseAdmittance = (network: AcNetwork) => {
  const n = network.busCount
  const g = Array.from({ length: n }, () => new Float64Array(n))
  const b = Array.from({ length: n }, () => new Float64Array(n))
  for (let bus = 0; bus < n; bus += 1) {
    g[bus]![bus] = network.busShuntConductancePu[bus]!
    b[bus]![bus] = network.busShuntSusceptancePu[bus]!
  }
  for (let branch = 0; branch < network.branchCount; branch += 1) {
    const f = network.branchFrom[branch]!
    const t = network.branchTo[branch]!
    const r = network.branchResistancePu[branch]!
    const x = network.branchReactancePu[branch]!
    const charging = network.branchChargingSusceptancePu[branch]!
    const tap = network.branchTapRatio[branch]!
    const ys = { re: r / (r * r + x * x), im: -x / (r * r + x * x) }
    g[f]![f] = g[f]![f]! + ys.re / tap ** 2
    b[f]![f] = b[f]![f]! + (ys.im + charging / 2) / tap ** 2
    g[t]![t] = g[t]![t]! + ys.re
    b[t]![t] = b[t]![t]! + ys.im + charging / 2
    g[f]![t] = g[f]![t]! - ys.re / tap
    b[f]![t] = b[f]![t]! - ys.im / tap
    g[t]![f] = g[t]![f]! - ys.re / tap
    b[t]![f] = b[t]![f]! - ys.im / tap
  }
  return { g, b }
}

const solveDense = (matrix: Float64Array[], rhs: Float64Array): Float64Array => {
  const n = rhs.length
  const a = matrix.map(row => row.slice())
  const x = rhs.slice()
  for (let column = 0; column < n; column += 1) {
    let pivot = column
    for (let row = column + 1; row < n; row += 1) if (Math.abs(a[row]![column]!) > Math.abs(a[pivot]![column]!)) pivot = row
    if (Math.abs(a[pivot]![column]!) < 1e-14) throw new Error(`Newton reference Jacobian is singular at column ${column}`)
    ;[a[column], a[pivot]] = [a[pivot]!, a[column]!]
    ;[x[column], x[pivot]] = [x[pivot]!, x[column]!]
    for (let row = column + 1; row < n; row += 1) {
      const factor = a[row]![column]! / a[column]![column]!
      if (factor === 0) continue
      for (let k = column; k < n; k += 1) a[row]![k] = a[row]![k]! - factor * a[column]![k]!
      x[row] = x[row]! - factor * x[column]!
    }
  }
  for (let row = n - 1; row >= 0; row -= 1) {
    let value = x[row]!
    for (let k = row + 1; k < n; k += 1) value -= a[row]![k]! * x[k]!
    x[row] = value / a[row]![row]!
  }
  return x
}

/**
 * Solves the whole network as one island with a fixed bus-control assignment (PQ, PV, or PQ
 * held at a reactive limit, as `acBusControl`), to max |mismatch| < 1e-11 pu.
 */
export const solveNewtonReference = (
  network: AcNetwork,
  specification: AcPowerFlowSpecification,
  slack: AcSlack,
  control: Uint8Array,
): NewtonReferenceSolution => {
  const n = network.busCount
  const s = network.sBaseMva
  const { g, b } = denseAdmittance(network)
  const reference = slack.kind === 'single' ? slack.bus : slack.angleReferenceBus
  const participation = new Float64Array(n)
  if (slack.kind === 'single') participation[slack.bus] = 1
  else {
    const total = slack.participation.reduce((sum, value) => sum + value, 0)
    for (let bus = 0; bus < n; bus += 1) participation[bus] = slack.participation[bus]! / total
  }
  const pSpec = Float64Array.from(specification.activeInjectionMw, value => value / s)
  const qSpec = new Float64Array(n)
  for (let bus = 0; bus < n; bus += 1) {
    const fixed = specification.reactiveInjectionMvar[bus]! / s
    qSpec[bus] = control[bus] === acBusControl.atReactiveMaximum
      ? fixed + specification.reactiveMaximumMvar[bus]! / s
      : control[bus] === acBusControl.atReactiveMinimum ? fixed + specification.reactiveMinimumMvar[bus]! / s : fixed
  }
  const vm = new Float64Array(n)
  const va = new Float64Array(n)
  for (let bus = 0; bus < n; bus += 1) vm[bus] = control[bus] === acBusControl.pv ? specification.voltageSetpointPu[bus]! : 1
  const angleUnknowns = Array.from({ length: n }, (_, bus) => bus).filter(bus => bus !== reference)
  const voltageUnknowns = Array.from({ length: n }, (_, bus) => bus).filter(bus => control[bus] !== acBusControl.pv)
  const size = angleUnknowns.length + voltageUnknowns.length + 1
  const unknowns = new Float64Array(size)
  angleUnknowns.forEach((bus, k) => { unknowns[k] = va[bus]! })
  voltageUnknowns.forEach((bus, k) => { unknowns[angleUnknowns.length + k] = vm[bus]! })
  const injections = (x: Float64Array) => {
    angleUnknowns.forEach((bus, k) => { va[bus] = x[k]! })
    voltageUnknowns.forEach((bus, k) => { vm[bus] = x[angleUnknowns.length + k]! })
    const p = new Float64Array(n)
    const q = new Float64Array(n)
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (g[i]![j] === 0 && b[i]![j] === 0) continue
        const d = va[i]! - va[j]!
        p[i] = p[i]! + vm[i]! * vm[j]! * (g[i]![j]! * Math.cos(d) + b[i]![j]! * Math.sin(d))
        q[i] = q[i]! + vm[i]! * vm[j]! * (g[i]![j]! * Math.sin(d) - b[i]![j]! * Math.cos(d))
      }
    }
    return { p, q }
  }
  const residual = (x: Float64Array): Float64Array => {
    const { p, q } = injections(x)
    const lambda = x[size - 1]!
    const out = new Float64Array(size)
    for (let bus = 0; bus < n; bus += 1) out[bus] = p[bus]! - pSpec[bus]! - participation[bus]! * lambda
    voltageUnknowns.forEach((bus, k) => { out[n + k] = q[bus]! - qSpec[bus]! })
    return out
  }
  let iterations = 0
  for (; iterations < 40; iterations += 1) {
    const f = residual(unknowns)
    if (Math.max(...f.map(Math.abs)) < 1e-11) break
    const jacobian = Array.from({ length: size }, () => new Float64Array(size))
    for (let k = 0; k < size; k += 1) {
      const step = 1e-6
      const plus = unknowns.slice()
      const minus = unknowns.slice()
      plus[k] = plus[k]! + step
      minus[k] = minus[k]! - step
      const fPlus = residual(plus)
      const fMinus = residual(minus)
      for (let row = 0; row < size; row += 1) jacobian[row]![k] = (fPlus[row]! - fMinus[row]!) / (2 * step)
    }
    const delta = solveDense(jacobian, f)
    for (let k = 0; k < size; k += 1) unknowns[k] = unknowns[k]! - delta[k]!
  }
  if (iterations === 40) throw new Error('Newton reference did not converge in 40 iterations')
  const { p, q } = injections(unknowns)
  return {
    voltagePu: vm.slice(),
    angleRad: va.slice(),
    activeInjectionMw: p.map(value => value * s),
    reactiveInjectionMvar: q.map(value => value * s),
    slackActiveMw: unknowns[size - 1]! * s,
    iterations,
  }
}
