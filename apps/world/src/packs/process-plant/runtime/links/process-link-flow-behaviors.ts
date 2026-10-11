import { primaryLoopPumpForLink } from '../../graph/index.ts'
import { componentVariablePath, processLinkVariablePath, type ProcessLinkBehaviorDefinition } from '../behavior-contract.ts'
import { clamp } from '../component-helpers.ts'
import {
  componentValveCapacityForInboundLink,
  componentValveFactorForInboundLink,
  hasProcessLinkVariable,
} from './link-flow-helpers.ts'
import { processLinkFlowSourceFor } from './link-flow-source-strategy.ts'
import { pressureDrivenLeakFlowKgPerS } from '../physics.ts'
import { physicalFlowCapacityKgPerS, physicalNumber } from './process-link-physical.ts'
import { primarySystemReactorVessel } from '../system-topology.ts'
import { primaryBreakFlow } from './primary-break-flow.ts'

export const processLinkFlowBehaviorDefinitions: ReadonlyArray<ProcessLinkBehaviorDefinition> = [
  {
    id: 'process-link-fluid-flow',
    phase: 'solveFluidFlowLinks',
    reads: ['target component valve effective position?', 'leak.areaFraction?', 'source component flow demand'],
    writes: ['flowKgPerS'],
    appliesTo: (link): boolean => link.kind === 'fluidFlow' && hasProcessLinkVariable(link, 'flowKgPerS'),
    update: ({ system, link, context }): void => {
      const fromComponent = system.graph.components[link.fromComponentIndex]
      const toComponent = system.graph.components[link.toComponentIndex]
      if (!fromComponent || !toComponent) throw new Error(`process link ${link.id} references missing component`)
      const currentComponentValveFactor = componentValveFactorForInboundLink(system, link, context)
      const leakFraction = clamp(context.readOptionalNumber(processLinkVariablePath(link, 'leak.areaFraction'), 0), 0, 1)
      const source = processLinkFlowSourceFor({ system, link, context })
      let flowSource = source.flowKgPerS
      if (!source.bypassTargetPumpLimit && toComponent.kind === 'centrifugalPump') {
        flowSource = Math.min(flowSource, context.readNumber(componentVariablePath(toComponent, 'flowKgPerS')))
      }
      // A reactor coolant loop's legs carry what the loops' hydraulics solve,
      // above their rated flow as well when three pumps drive four loops.
      const capacity = primaryLoopPumpForLink(system.graph, link) === null ? physicalFlowCapacityKgPerS(link) : Number.POSITIVE_INFINITY
      const componentValveCapacity = componentValveCapacityForInboundLink(system, link, context)
      const effectiveValveFactor = source.alreadyIncludesPathAvailability
        ? 1
        : source.alreadyIncludesTargetValveDemand ? 1 : currentComponentValveFactor
      context.write(processLinkVariablePath(link, 'flowKgPerS'), Math.min(flowSource, capacity, componentValveCapacity) * effectiveValveFactor * (1 - leakFraction))
    },
  },
  {
    id: 'process-link-pressure-driven-leak',
    phase: 'solveFluidFlowLinks',
    reads: ['pressureMPa', 'temperatureC?', 'leak.areaFraction?', 'physical.leakCoefficientKgPerSPerSqrtMPa', 'physical.diameterM', 'reactorVessel.loopVoidFraction', 'containmentVolume.pressureMPa'],
    writes: ['leakFlowKgPerS'],
    appliesTo: (link): boolean =>
      link.kind === 'fluidFlow'
      && hasProcessLinkVariable(link, 'pressureMPa')
      && hasProcessLinkVariable(link, 'leakFlowKgPerS'),
    update: ({ system, link, context }): void => {
      // Reactor coolant breaks choke; other lines leak through an orifice.
      if (link.service === 'primaryCoolant' && primarySystemReactorVessel(system) !== null) {
        context.write(processLinkVariablePath(link, 'leakFlowKgPerS'), primaryBreakFlow(system, link, context).totalKgPerS)
        return
      }
      const pressure = context.readNumber(processLinkVariablePath(link, 'pressureMPa'))
      context.write(processLinkVariablePath(link, 'leakFlowKgPerS'), pressureDrivenLeakFlowKgPerS({
        areaFraction: context.readOptionalNumber(processLinkVariablePath(link, 'leak.areaFraction'), 0),
        pressureDeltaMPa: pressure - 0.101325,
        coefficientKgPerSPerSqrtMPa: physicalNumber(link, 'leakCoefficientKgPerSPerSqrtMPa', 0),
      }))
    },
  },
]
