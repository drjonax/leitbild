import { componentVariablePath, processLinkVariablePath, type ProcessLinkBehaviorDefinition } from '../behavior-contract.ts'
import { averageIncomingLinkValue, flowWeightedIncomingLinkValue, hasProcessLinkVariable } from './link-flow-helpers.ts'
import { pressureDropMPaFromFlow } from '../physics.ts'
import { physicalNumber } from './process-link-physical.ts'
import { primarySystemPressurizer } from '../system-topology.ts'

export const processLinkPressureBehaviorDefinitions: ReadonlyArray<ProcessLinkBehaviorDefinition> = [
  {
    id: 'process-link-primary-pressure-drop',
    phase: 'solveFluidFlowLinks',
    reads: ['flowKgPerS', 'pressurizer.pressureMPa', 'physical.nominalResistance', 'physical.nominalFlowKgPerS'],
    writes: ['pressureDropMPa', 'pressureMPa'],
    appliesTo: (link): boolean =>
      link.service === 'primaryCoolant'
      && hasProcessLinkVariable(link, 'flowKgPerS')
      && hasProcessLinkVariable(link, 'pressureDropMPa')
      && hasProcessLinkVariable(link, 'pressureMPa'),
    update: ({ system, link, context }): void => {
      const pressurizer = primarySystemPressurizer(system)
      if (pressurizer === null || !context.has(componentVariablePath(pressurizer, 'pressureMPa'))) {
        throw new Error(`primary coolant pressure link ${link.id} requires a pressurizer pressure source`)
      }
      const flow = context.readNumber(processLinkVariablePath(link, 'flowKgPerS'))
      const pressureDrop = pressureDropMPaFromFlow({
        flowKgPerS: flow,
        nominalFlowKgPerS: physicalNumber(link, 'nominalFlowKgPerS', 4_250),
        nominalPressureDropMPa: physicalNumber(link, 'nominalResistance', 0),
      })
      const sourcePressure = context.readNumber(componentVariablePath(pressurizer, 'pressureMPa'))
      context.write(processLinkVariablePath(link, 'pressureDropMPa'), pressureDrop)
      context.write(processLinkVariablePath(link, 'pressureMPa'), Math.max(0.2, sourcePressure - pressureDrop))
    },
  },
  {
    id: 'process-link-steam-pressure',
    phase: 'updateProcessLinkState',
    reads: ['source pressureMPa'],
    writes: ['pressureMPa'],
    appliesTo: (link): boolean => hasProcessLinkVariable(link, 'pressureMPa'),
    update: ({ system, link, context }): void => {
      const fromComponent = system.graph.components[link.fromComponentIndex]
      const toComponent = system.graph.components[link.toComponentIndex]
      if (!fromComponent) throw new Error(`process link ${link.id} references missing source component`)
      // A release reads the pressure of the volume it discharges into: containment, or the atmosphere outside.
      const releasesIntoContainment = toComponent?.kind === 'containmentVolume' && (String(link.toPortName) === 'massEnergyIn' || String(link.toPortName) === 'steamIn')
      if (toComponent !== undefined && (releasesIntoContainment || toComponent.kind === 'atmosphereBoundary')) {
        context.write(processLinkVariablePath(link, 'pressureMPa'), context.readNumber(componentVariablePath(toComponent, 'pressureMPa')))
        return
      }
      if (link.service === 'primaryCoolant') {
        const pressurizer = primarySystemPressurizer(system)
        if (pressurizer !== null && context.has(componentVariablePath(pressurizer, 'pressureMPa'))) {
          const pressureDrop = context.readOptionalNumber(processLinkVariablePath(link, 'pressureDropMPa'), 0)
          context.write(processLinkVariablePath(link, 'pressureMPa'), Math.max(0.2, context.readNumber(componentVariablePath(pressurizer, 'pressureMPa')) - pressureDrop))
          return
        }
      }
      if (link.service === 'primaryInjection') {
        const pressurizer = primarySystemPressurizer(system)
        if (pressurizer !== null && context.has(componentVariablePath(pressurizer, 'pressureMPa'))) {
          context.write(processLinkVariablePath(link, 'pressureMPa'), context.readNumber(componentVariablePath(pressurizer, 'pressureMPa')))
          return
        }
      }
      if (fromComponent.kind === 'steamGenerator') {
        context.write(processLinkVariablePath(link, 'pressureMPa'), context.readNumber(componentVariablePath(fromComponent, 'pressureMPa')))
        return
      }
      const sourcePressure = flowWeightedIncomingLinkValue(
        system,
        link.fromComponentIndex,
        'pressureMPa',
        context,
        candidate => candidate.service === link.service,
      ) ?? averageIncomingLinkValue(
        system,
        link.fromComponentIndex,
        'pressureMPa',
        context,
        candidate => candidate.service === link.service,
      )
      if (sourcePressure !== null) context.write(processLinkVariablePath(link, 'pressureMPa'), sourcePressure)
    },
  },
]
