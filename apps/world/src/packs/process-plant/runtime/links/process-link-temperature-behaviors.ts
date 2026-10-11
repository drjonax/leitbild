import type { CompiledComponent } from '../../graph/index.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import { componentVariablePath, processLinkVariablePath, type ProcessLinkBehaviorDefinition } from '../behavior-contract.ts'
import { relaxToward, type ComponentNumericReadContext } from '../component-helpers.ts'
import { primaryLoopLegReversed, reactorCoreNetInflowKgPerS } from '../primary-loop-hydraulics.ts'
import { primarySystemReactorCore } from '../system-topology.ts'
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

export const processLinkTemperatureBehaviorDefinitions: ReadonlyArray<ProcessLinkBehaviorDefinition> = [
  {
    id: 'process-link-temperature',
    phase: 'updateProcessLinkState',
    reads: ['temperatureC', 'flowKgPerS', 'source component temperature state', 'reactor coolant loop leg flows and temperatures'],
    writes: ['temperatureC'],
    appliesTo: (link): boolean => hasProcessLinkVariable(link, 'temperatureC'),
    update: ({ system, link, context }): void => {
      const fromComponent = system.graph.components[link.fromComponentIndex]
      const toComponent = system.graph.components[link.toComponentIndex]
      if (!fromComponent || !toComponent) throw new Error(`process link ${link.id} references missing component`)
      let target: number
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
        target = context.readNumber(componentVariablePath(fromComponent, 'steamTemperatureC'))
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
          : relaxToward(context.readNumber(processLinkVariablePath(link, 'temperatureC')), target, context.dtSeconds, 10),
      )
    },
  },
]
