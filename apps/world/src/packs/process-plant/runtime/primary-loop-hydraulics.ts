import { primaryLoopIdForLink, primaryLoopIdForPump, primaryLoopPumpForLink, primaryLoopPumps, type CompiledComponent, type CompiledProcessLink } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { reactorInitialThermalState } from '../reactor-initial-conditions.ts'
import { componentVariablePath, processLinkVariablePath } from './behavior-contract.ts'
import { optionalParameterNumber, parameterNumber, type ComponentNumericReadContext } from './component-helpers.ts'
import { primarySystemPressurizer, primarySystemReactorCore } from './system-topology.ts'
import { primaryLoopLinkResistanceCoefficient } from './topology-cache.ts'
import { compressedWaterState } from './water-properties.ts'

// The reactor coolant loops run in parallel between the reactor vessel's
// cold-leg and hot-leg nozzles, so every loop works against the one pressure
// drop across the vessel. Each loop's water is driven by its pump's head and
// by buoyancy, the cold leg's water being denser than the hot leg's over the
// height between the core's and the steam generator's thermal centres. A
// loop's pump and piping resist its flow in proportion to its square.
//
// Pump head follows a parabola in flow at each speed n:
//   H(n, W) = H0 (1 + s) n^2 - s H0 W|W| / W0^2,
// through the rated point (n = 1, W0, H0) and the shutoff head H0 (1 + s).
// At standstill, its anti-reverse device holding the impeller, a pump is a
// resistance s H0 / W0^2 to flow either way. Moving that term to the loop's
// resistance R, each loop solves
//   R W|W| = H0 (1 + s) n^2 + B - D,
// with B its buoyancy head and D the vessel's pressure drop K (sum W)^2.
// The vessel's drop falls as the loops' flow does, so a pump that stops while
// the others run has its loop driven backwards; and with every pump stopped,
// buoyancy alone drives the loops: natural circulation.

const gravityMPerS2 = 9.80665

export interface PrimaryLoopHydraulics {
  readonly pump: CompiledComponent
  /** The loop's flow at rated head with every loop running at the design point. */
  readonly ratedFlowKgPerS: number
  readonly ratedHeadPa: number
  readonly shutoffHeadPa: number
  /** The loop's resistance, its standing impeller included, in Pa per (kg/s)^2. */
  readonly resistance: number
  readonly heightM: number
  readonly hotLeg: CompiledProcessLink
  readonly coldLeg: CompiledProcessLink
}

export interface PrimaryCircuitHydraulics {
  readonly core: CompiledComponent
  readonly loops: ReadonlyArray<PrimaryLoopHydraulics>
  /** The reactor vessel's resistance to the loops' summed flow, in Pa per (kg/s)^2. */
  readonly vesselResistance: number
}

const coolantDensityKgPerM3 = (temperatureC: number, pressureMPa: number): number =>
  compressedWaterState(temperatureC, pressureMPa).densityKgPerM3

const loopLegs = (system: CompiledProcessPlant, pump: CompiledComponent): { readonly hotLeg: CompiledProcessLink; readonly coldLeg: CompiledProcessLink } => {
  const loopId = primaryLoopIdForPump(pump)
  const graph = system.graph
  const hotLeg = graph.links.find(link =>
    primaryLoopIdForLink(graph, link) === loopId
    && graph.components[link.fromComponentIndex]?.kind === 'reactorCore'
    && graph.components[link.toComponentIndex]?.kind === 'steamGenerator')
  const coldLeg = graph.links.find(link =>
    link.fromComponentIndex === pump.index
    && link.service === 'primaryCoolant'
    && graph.components[link.toComponentIndex]?.kind === 'reactorCore')
  if (hotLeg === undefined || coldLeg === undefined) throw new Error(`primary loop ${loopId} of pump ${pump.id} has no hot leg from the core or no cold leg to it`)
  return { hotLeg, coldLeg }
}

const circuitCache = new WeakMap<CompiledProcessPlant, PrimaryCircuitHydraulics | null>()

/** The reactor coolant circuit's hydraulics, sized once from the Plant's
 * declared design point: at it, every loop carries its rated flow. */
export const primaryCircuitHydraulics = (system: CompiledProcessPlant): PrimaryCircuitHydraulics | null => {
  const cached = circuitCache.get(system)
  if (cached !== undefined) return cached
  const pumps = primaryLoopPumps(system.graph)
  const core = primarySystemReactorCore(system)
  if (pumps.length === 0 || core === null) {
    circuitCache.set(system, null)
    return null
  }
  const design = reactorInitialThermalState(core.parameters as Readonly<Record<string, unknown>>)
  const designPressure = parameterNumber(core, 'nominalCoolantPressureMPa')
  // The design point's hot leg carries the core outlet; its cold leg the
  // steam generator outlet, the pumps' heat reaching the coolant in the core.
  const designDensityDifference = coolantDensityKgPerM3(design.steamGeneratorOutlet, designPressure) - coolantDensityKgPerM3(design.outlet, designPressure)
  // A loop pump's nominal flow is what it would pass with no loop to push
  // through; its loop's links and declared resistance take it down to the
  // rated flow, the core's share, as the operating point sizes it.
  const rated = pumps.map(pump => ({
    pump,
    ratedHeadPa: parameterNumber(pump, 'nominalHeadPa'),
    ratedFlowKgPerS: parameterNumber(pump, 'nominalFlowKgPerS')
      / Math.sqrt(1 + optionalParameterNumber(pump, 'loopResistanceCoefficient', 0) + primaryLoopLinkResistanceCoefficient(pump, system.graph)),
  }))
  const vesselFlow = rated.reduce((sum, loop) => sum + loop.ratedFlowKgPerS, 0)
  const vesselPressureDropPa = parameterNumber(core, 'nominalPressureDropMPa') * 1_000_000
  const loops = rated.map(({ pump, ratedHeadPa, ratedFlowKgPerS }) => {
    const shutoffHeadPa = parameterNumber(pump, 'shutoffHeadPa')
    if (shutoffHeadPa < ratedHeadPa) throw new Error(`pump ${pump.id} shutoff head ${shutoffHeadPa} Pa is below its rated head ${ratedHeadPa} Pa`)
    const heightM = parameterNumber(pump, 'naturalCirculationHeightM')
    // At the design point the rated head and the design buoyancy carry the
    // rated flow through the loop and the vessel.
    const loopPressureDropPa = ratedHeadPa + gravityMPerS2 * heightM * designDensityDifference - vesselPressureDropPa
    if (loopPressureDropPa <= 0) throw new Error(`pump ${pump.id} rated head does not exceed the reactor vessel's pressure drop`)
    const impellerResistance = (shutoffHeadPa - ratedHeadPa) / (ratedFlowKgPerS * ratedFlowKgPerS)
    return {
      pump,
      ratedFlowKgPerS,
      ratedHeadPa,
      shutoffHeadPa,
      resistance: loopPressureDropPa / (ratedFlowKgPerS * ratedFlowKgPerS) + impellerResistance,
      heightM,
      ...loopLegs(system, pump),
    }
  })
  const circuit = { core, loops, vesselResistance: vesselPressureDropPa / (vesselFlow * vesselFlow) }
  circuitCache.set(system, circuit)
  return circuit
}

/** The head a loop's pump develops at a rotor speed and loop flow: none at
 * standstill, nor once the forward flow outruns the impeller, which then only
 * resists it, as a standing impeller resists the flow driven back through it. */
export const primaryLoopPumpHeadPa = (loop: PrimaryLoopHydraulics, speedFraction: number, flowKgPerS: number): number => {
  const forward = Math.max(0, flowKgPerS) / loop.ratedFlowKgPerS
  return Math.max(0, loop.shutoffHeadPa * speedFraction * speedFraction - (loop.shutoffHeadPa - loop.ratedHeadPa) * forward * forward)
}

const coolantPressureMPa = (system: CompiledProcessPlant, circuit: PrimaryCircuitHydraulics, context: ComponentNumericReadContext): number => {
  const pressurizer = primarySystemPressurizer(system)
  return pressurizer === null
    ? parameterNumber(circuit.core, 'nominalCoolantPressureMPa')
    : context.readNumber(componentVariablePath(pressurizer, 'pressureMPa'))
}

/** A loop's buoyancy head: its cold leg's water outweighing its hot leg's over the thermal centres' height. */
const buoyancyHeadPa = (loop: PrimaryLoopHydraulics, coldLegTemperatureC: number, hotLegTemperatureC: number, pressureMPa: number): number =>
  gravityMPerS2 * loop.heightM * (coolantDensityKgPerM3(coldLegTemperatureC, pressureMPa) - coolantDensityKgPerM3(hotLegTemperatureC, pressureMPa))

const loopFlowAt = (loop: PrimaryLoopHydraulics, drivingHeadPa: number, vesselPressureDropPa: number): number => {
  const net = drivingHeadPa - vesselPressureDropPa
  return Math.sign(net) * Math.sqrt(Math.abs(net) / loop.resistance)
}

// Every loop's pump solves the same circuit in a step; the last solution
// stands while its inputs (rotor speeds, leg temperatures, pressure) do.
const lastSolution = new WeakMap<PrimaryCircuitHydraulics, { readonly inputs: ReadonlyArray<number>; readonly flows: ReadonlyArray<number> }>()

/**
 * Each loop's flow, positive from the hot leg through its steam generator
 * and pump to the cold leg, at the pumps' rotor speeds (by loop, as
 * `circuit.loops`) and the loops' present temperatures. The vessel's pressure
 * drop less the drop the loops' summed flow makes across it falls as that
 * drop rises, so bisection finds the one drop that balances.
 */
export const solvePrimaryLoopFlows = (
  system: CompiledProcessPlant,
  circuit: PrimaryCircuitHydraulics,
  rotorSpeedFractions: ReadonlyArray<number>,
  context: ComponentNumericReadContext,
): ReadonlyArray<number> => {
  const pressure = coolantPressureMPa(system, circuit, context)
  const inputs = [pressure, ...rotorSpeedFractions, ...circuit.loops.flatMap(loop => [
    context.readNumber(processLinkVariablePath(loop.coldLeg, 'temperatureC')),
    context.readNumber(processLinkVariablePath(loop.hotLeg, 'temperatureC')),
  ])]
  const last = lastSolution.get(circuit)
  if (last !== undefined && last.inputs.every((value, index) => value === inputs[index])) return last.flows
  const drivingHeads = circuit.loops.map((loop, index) =>
    loop.shutoffHeadPa * rotorSpeedFractions[index]! * rotorSpeedFractions[index]!
    + buoyancyHeadPa(loop, inputs[1 + circuit.loops.length + 2 * index]!, inputs[2 + circuit.loops.length + 2 * index]!, pressure))
  const flowsAt = (vesselPressureDropPa: number): ReadonlyArray<number> =>
    circuit.loops.map((loop, index) => loopFlowAt(loop, drivingHeads[index]!, vesselPressureDropPa))
  const imbalance = (vesselPressureDropPa: number): number => {
    const vesselFlow = flowsAt(vesselPressureDropPa).reduce((sum, flow) => sum + flow, 0)
    return circuit.vesselResistance * vesselFlow * Math.abs(vesselFlow) - vesselPressureDropPa
  }
  let low = Math.min(0, ...drivingHeads)
  let high = Math.max(0, ...drivingHeads)
  for (let iteration = 0; iteration < 60 && high - low > 1e-6; iteration += 1) {
    const middle = (low + high) / 2
    if (imbalance(middle) > 0) low = middle
    else high = middle
  }
  const flows = flowsAt((low + high) / 2)
  lastSolution.set(circuit, { inputs, flows })
  return flows
}

/** A loop's flow, positive from hot leg to cold leg, negative while the other loops drive it backwards. */
export const primaryLoopSignedFlowKgPerS = (pump: CompiledComponent, context: ComponentNumericReadContext): number =>
  context.readNumber(componentVariablePath(pump, 'loopFlowKgPerS')) - context.readNumber(componentVariablePath(pump, 'loopReverseFlowKgPerS'))

/** Whether a link is a leg of a loop the other loops drive backwards; its flow then runs against its direction. */
export const primaryLoopLegReversed = (system: CompiledProcessPlant, link: CompiledProcessLink, context: ComponentNumericReadContext): boolean => {
  const pump = primaryLoopPumpForLink(system.graph, link)
  return pump !== null && context.readNumber(componentVariablePath(pump, 'loopReverseFlowKgPerS')) > 0
}

/** The flow through the core: what the loops' cold legs bring it, less what
 * leaves by the cold legs of loops driven backwards. */
export const reactorCoreNetInflowKgPerS = (system: CompiledProcessPlant, core: CompiledComponent, context: ComponentNumericReadContext): number => {
  let flow = 0
  for (const linkIndex of system.graph.incomingLinksByComponent[core.index] ?? []) {
    const link = system.graph.links[linkIndex]!
    if (link.service !== 'primaryCoolant') continue
    const path = processLinkVariablePath(link, 'flowKgPerS')
    if (!context.has(path)) continue
    flow += primaryLoopLegReversed(system, link, context) ? -context.readNumber(path) : context.readNumber(path)
  }
  return flow
}
