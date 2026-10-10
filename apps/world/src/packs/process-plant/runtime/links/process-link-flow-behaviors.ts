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
import { saturatedWaterSteam } from '../water-properties.ts'

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
      const capacity = physicalFlowCapacityKgPerS(link)
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
    reads: ['pressureMPa', 'leak.areaFraction?', 'physical.leakCoefficientKgPerSPerSqrtMPa', 'reactorVessel.loopVoidFraction'],
    writes: ['leakFlowKgPerS'],
    appliesTo: (link): boolean =>
      link.kind === 'fluidFlow'
      && hasProcessLinkVariable(link, 'pressureMPa')
      && hasProcessLinkVariable(link, 'leakFlowKgPerS'),
    update: ({ system, link, context }): void => {
      const pressure = context.readNumber(processLinkVariablePath(link, 'pressureMPa'))
      const leakArea = context.readOptionalNumber(processLinkVariablePath(link, 'leak.areaFraction'), 0)
      const liquidLeak = pressureDrivenLeakFlowKgPerS({
        areaFraction: leakArea,
        pressureDeltaMPa: pressure - 0.101325,
        coefficientKgPerSPerSqrtMPa: physicalNumber(link, 'leakCoefficientKgPerSPerSqrtMPa', 0),
      })
      // A break in voided reactor coolant loops discharges steam too, whose
      // mass flux through the same opening is lower by the square root of
      // the steam-to-water density ratio.
      const vessel = link.service === 'primaryCoolant' && liquidLeak > 0 ? primarySystemReactorVessel(system) : null
      const voidFraction = vessel === null ? 0 : context.readNumber(componentVariablePath(vessel, 'loopVoidFraction'))
      const saturation = voidFraction > 0 ? saturatedWaterSteam(pressure) : null
      const steamShare = saturation === null ? 1 : Math.sqrt(saturation.vapourDensityKgPerM3 / saturation.liquidDensityKgPerM3)
      context.write(processLinkVariablePath(link, 'leakFlowKgPerS'), liquidLeak * (1 - voidFraction + voidFraction * steamShare))
    },
  },
]
