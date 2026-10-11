import { ratedFlowForLink, type CompiledComponent, type CompiledProcessLink } from '../../graph/index.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import { componentVariablePath, processLinkVariablePath, type ProcessLinkBehaviorDefinition } from '../behavior-contract.ts'
import { relaxToward, type ComponentNumericReadContext } from '../component-helpers.ts'
import { primaryLoopLegReversed, reactorCoreNetInflowKgPerS } from '../primary-loop-hydraulics.ts'
import { primarySystemContainment, primarySystemReactorCore } from '../system-topology.ts'
import { saturationTemperatureCFromPressureMPa } from '../thermophysics.ts'
import { averageIncomingLinkValue, flowWeightedIncomingLinkValue, hasProcessLinkVariable, serviceMatches } from './link-flow-helpers.ts'

/** The upper plenum's water, which the forward-running hot legs carry: the
 * core's outlet flow mixed with what loops driven backwards bring into it. */
const upperPlenumTemperatureC = (system: CompiledProcessPlant, core: CompiledComponent, context: ComponentNumericReadContext): number => {
  const coreOutlet = context.readNumber(componentVariablePath(core, 'coolantOutletTemperatureC'))
  let flow = Math.max(0, reactorCoreNetInflowKgPerS(system, core, context))
  let heat = flow * coreOutlet
  for (const linkIndex of system.graph.outgoingLinksByComponent[core.index] ?? []) {
    const link = system.graph.links[linkIndex]!
    if (!primaryLoopLegReversed(system, link, context)) continue
    const returning = context.readNumber(processLinkVariablePath(link, 'flowKgPerS'))
    flow += returning
    heat += returning * context.readNumber(processLinkVariablePath(link, 'temperatureC'))
  }
  return flow <= 0 ? coreOutlet : heat / flow
}

// A relief line from the pressurizer reads what the thermocouple on its
// tailpipe, just past its valve, reads. While the valve passes steam, the
// steam throttles to the pressure the line backs up to, the relief tank's
// plus what the flow builds along the line (0.6 MPa at the valve's rated
// flow, in proportion below it), and the tailpipe reads that pressure's
// saturation temperature: about 140 °C with a third of the PORV's rated
// flow, as Three Mile Island's stuck-open PORV read. Shut, the pipe cools to
// the containment air around it. It heats in some 10 s and cools over minutes.
const reliefLineBackPressureAtRatedFlowMPa = 0.6
const reliefLineHeatupTimeConstantS = 10
const reliefLineCooldownTimeConstantS = 300
const linkTemperatureTimeConstantS = 10

const reliefTankByLink = new WeakMap<CompiledProcessLink, CompiledComponent>()

/** The relief tank a relief line discharges to, through any header on its way. */
const reliefTankDownstream = (system: CompiledProcessPlant, link: CompiledProcessLink): CompiledComponent => {
  const cached = reliefTankByLink.get(link)
  if (cached !== undefined) return cached
  const visit = (componentIndex: number): CompiledComponent | null => {
    const component = system.graph.components[componentIndex]
    if (component?.kind === 'reliefTank') return component
    for (const index of system.graph.outgoingLinksByComponent[componentIndex] ?? []) {
      const next = system.graph.links[index]
      if (next === undefined || next.kind !== 'fluidFlow' || next.service !== link.service) continue
      const found = visit(next.toComponentIndex)
      if (found !== null) return found
    }
    return null
  }
  const tank = visit(link.toComponentIndex)
  if (tank === null) throw new Error(`relief line ${link.id} discharges to no relief tank`)
  reliefTankByLink.set(link, tank)
  return tank
}

const reliefTailpipe = (system: CompiledProcessPlant, link: CompiledProcessLink, context: ComponentNumericReadContext): { readonly temperatureC: number; readonly timeConstantS: number } => {
  const flow = Math.max(0, context.readNumber(processLinkVariablePath(link, 'flowKgPerS')))
  const current = context.readNumber(processLinkVariablePath(link, 'temperatureC'))
  if (flow > 0) {
    const rated = ratedFlowForLink(system.graph, link)
    if (rated === null) throw new Error(`relief line ${link.id} has no rated flow to scale its back pressure by`)
    const tank = reliefTankDownstream(system, link)
    const backPressure = context.readNumber(componentVariablePath(tank, 'pressureMPa')) + reliefLineBackPressureAtRatedFlowMPa * flow / rated
    const target = saturationTemperatureCFromPressureMPa(backPressure)
    return { temperatureC: target, timeConstantS: target > current ? reliefLineHeatupTimeConstantS : reliefLineCooldownTimeConstantS }
  }
  const containment = primarySystemContainment(system)
  if (containment === null) throw new Error(`relief line ${link.id} runs in a Plant with no containment for its pipe to cool in`)
  return { temperatureC: context.readNumber(componentVariablePath(containment, 'temperatureC')), timeConstantS: reliefLineCooldownTimeConstantS }
}

export const processLinkTemperatureBehaviorDefinitions: ReadonlyArray<ProcessLinkBehaviorDefinition> = [
  {
    id: 'process-link-temperature',
    phase: 'updateProcessLinkState',
    reads: ['temperatureC', 'flowKgPerS', 'source component temperature state', 'reactor coolant loop leg flows and temperatures', 'relief tank pressureMPa', 'containment temperatureC'],
    writes: ['temperatureC'],
    appliesTo: (link): boolean => hasProcessLinkVariable(link, 'temperatureC'),
    update: ({ system, link, context }): void => {
      const fromComponent = system.graph.components[link.fromComponentIndex]
      const toComponent = system.graph.components[link.toComponentIndex]
      if (!fromComponent || !toComponent) throw new Error(`process link ${link.id} references missing component`)
      let target: number
      let timeConstantS = linkTemperatureTimeConstantS
      const core = primarySystemReactorCore(system)
      if (core !== null && primaryLoopLegReversed(system, link, context)) {
        // A loop the others drive backwards carries the downcomer's water back
        // through its pump to its idle steam generator, and what leaves that
        // generator's tubes back along its hot leg to the upper plenum.
        target = toComponent.kind === 'steamGenerator'
          ? context.readNumber(componentVariablePath(toComponent, 'primaryOutletTemperatureC'))
          : context.readNumber(componentVariablePath(core, 'coolantInletTemperatureC'))
      } else if (fromComponent.kind === 'reactorCore') {
        target = upperPlenumTemperatureC(system, fromComponent, context)
      } else if (fromComponent.kind === 'steamGenerator' && link.service === 'primaryCoolant') {
        target = context.readNumber(componentVariablePath(fromComponent, 'primaryOutletTemperatureC'))
      } else if (fromComponent.kind === 'pressurizer' && link.service === 'primaryRelief') {
        const tailpipe = reliefTailpipe(system, link, context)
        target = tailpipe.temperatureC
        timeConstantS = tailpipe.timeConstantS
      } else if (fromComponent.kind === 'reactorVessel' && link.service === 'letdown') {
        // Letdown leaves from a cold leg. Its regenerative and letdown heat
        // exchangers are not modelled, so it carries cold-leg temperature to
        // the volume control tank and charging returns it.
        const core = primarySystemReactorCore(system)
        target = core === null
          ? context.readNumber(componentVariablePath(fromComponent, 'meanPrimaryCoolantTemperatureC'))
          : context.readNumber(componentVariablePath(core, 'coolantInletTemperatureC'))
      } else if (fromComponent.kind === 'reactorVessel' && link.service === 'primaryRelease') {
        target = context.readNumber(componentVariablePath(fromComponent, 'meanPrimaryCoolantTemperatureC'))
      } else if (fromComponent.kind === 'processTank') {
        target = context.readNumber(componentVariablePath(fromComponent, 'temperatureC'))
      } else if (fromComponent.kind === 'condenserSink' && link.service === 'condensate') {
        target = context.readNumber(componentVariablePath(fromComponent, 'condensateTemperatureC'))
      } else if (fromComponent.kind === 'condenserSink' && link.service === 'coolingWater') {
        target = context.readNumber(componentVariablePath(fromComponent, 'coolingWaterOutletTemperatureC'))
      } else if (fromComponent.kind === 'steamGenerator' && link.service === 'mainSteam') {
        target = context.readNumber(componentVariablePath(fromComponent, 'secondaryTemperatureC'))
      } else if (fromComponent.kind === 'turbineLoadSink') {
        target = context.readNumber(componentVariablePath(fromComponent, 'exhaustTemperatureC'))
      } else if (fromComponent.kind === 'heatExchanger' && String(link.fromPortName) === 'hotOut') {
        target = context.readNumber(componentVariablePath(fromComponent, 'hotOutletTemperatureC'))
      } else if (fromComponent.kind === 'heatExchanger' && String(link.fromPortName) === 'coldOut') {
        target = context.readNumber(componentVariablePath(fromComponent, 'coldOutletTemperatureC'))
      } else if (fromComponent.kind === 'containmentVolume' && String(link.fromPortName) === 'sumpOut') {
        target = context.readNumber(componentVariablePath(fromComponent, 'temperatureC'))
      } else if (fromComponent.kind === 'containmentVolume' && String(link.fromPortName) === 'ventOut') {
        target = context.readNumber(componentVariablePath(fromComponent, 'temperatureC'))
      } else if (fromComponent.kind === 'accumulator' && String(link.fromPortName) === 'outlet') {
        target = context.readNumber(componentVariablePath(fromComponent, 'temperatureC'))
      } else {
        target = flowWeightedIncomingLinkValue(system, link.fromComponentIndex, 'temperatureC', context, candidate => serviceMatches(candidate, link.service))
          ?? averageIncomingLinkValue(system, link.fromComponentIndex, 'temperatureC', context, candidate => serviceMatches(candidate, link.service))
          ?? context.readNumber(processLinkVariablePath(link, 'temperatureC'))
      }
      context.write(
        processLinkVariablePath(link, 'temperatureC'),
        context.dtSeconds === 0
          ? target
          : relaxToward(context.readNumber(processLinkVariablePath(link, 'temperatureC')), target, context.dtSeconds, timeConstantS),
      )
    },
  },
]
