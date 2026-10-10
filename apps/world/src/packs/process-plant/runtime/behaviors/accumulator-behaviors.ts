import { componentVariablePath, processLinkVariablePath, type ComponentBehaviorDefinition } from '../behavior-contract.ts'
import { clamp, optionalParameterBoolean, optionalParameterNumber, parameterNumber } from '../component-helpers.ts'
import { inventoryBalanceStep } from '../physics.ts'
import { averageIncomingLinkValue, sumIncomingLinkValue } from '../links/link-flow-helpers.ts'

const averageOutletPressureMPa = (
  input: Parameters<ComponentBehaviorDefinition['update']>[0],
): number | null => {
  let total = 0
  let count = 0
  for (const linkIndex of input.system.graph.outgoingLinksByComponent[input.component.index] ?? []) {
    const link = input.system.graph.links[linkIndex]
    if (!link || String(link.fromPortName) !== 'outlet') continue
    const path = processLinkVariablePath(link, 'pressureMPa')
    if (!input.context.has(path)) continue
    total += input.context.readNumber(path)
    count += 1
  }
  return count === 0 ? null : total / count
}

export const accumulatorBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'accumulator-pressure-driven-discharge',
    phase: 'solveFluidFlowComponents',
    componentKind: 'accumulator',
    reads: ['incoming:flowKgPerS', 'incoming:pressureMPa', 'dischargeIsolationOpen', 'liquidInventoryKg', 'gasPressureMPa', 'gasVolumeM3'],
    writes: [
      'liquidInventoryKg',
      'gasVolumeM3',
      'gasPressureMPa',
      'outletFlowKgPerS',
      'fillFlowKgPerS',
      'availableInjectionHeadMPa',
      'depletedFraction',
      'checkValveOpenFraction',
      'temperatureC',
    ],
    update: ({ system, component, context }): void => {
      const liquidDensity = optionalParameterNumber(component, 'liquidDensityKgPerM3', 950)
      const totalVolume = parameterNumber(component, 'totalVolumeM3')
      const minimumInventory = optionalParameterNumber(component, 'minimumUsableInventoryKg', 0)
      const currentInventory = context.readNumber(componentVariablePath(component, 'liquidInventoryKg'))
      const liquidVolume = currentInventory / liquidDensity
      const gasVolume = Math.max(0.001, totalVolume - liquidVolume)
      const initialInventory = parameterNumber(component, 'initialLiquidInventoryKg')
      const initialGasVolume = Math.max(0.001, totalVolume - initialInventory / liquidDensity)
      const exponent = optionalParameterNumber(component, 'gasPolytropicExponent', 1.2)
      const gasPressure = parameterNumber(component, 'initialGasPressureMPa') * Math.pow(initialGasVolume / gasVolume, exponent)
      // The check valve opens once the pressure it injects into falls below the
      // gas pressure, and the accumulator then injects until the expanding gas
      // no longer exceeds that pressure or only its unusable water is left.
      const downstreamPressure = averageOutletPressureMPa({ system, component, context })
      if (downstreamPressure === null) throw new Error(`accumulator ${component.id} outlet carries no pressure, so its check valve cannot be judged`)
      const availableHead = gasPressure - downstreamPressure
      const dischargeIsolationOpen = context.readBoolean(componentVariablePath(component, 'dischargeIsolationOpen'))
      const checkValveOpen = optionalParameterBoolean(component, 'checkValveEnabled', true)
        ? dischargeIsolationOpen && availableHead > 0 && currentInventory > minimumInventory
        : dischargeIsolationOpen && currentInventory > minimumInventory
      const outletFlow = checkValveOpen
        ? parameterNumber(component, 'outletCvKgPerSPerSqrtMPa') * Math.sqrt(Math.max(0, availableHead))
        : 0
      const fillFlow = sumIncomingLinkValue(system, component.index, 'flowKgPerS', context, link => String(link.toPortName) === 'fill')
      const boundedOutletFlow = Math.min(outletFlow, Math.max(0, currentInventory - minimumInventory) / Math.max(context.dtSeconds, 1e-9))
      const nextInventory = inventoryBalanceStep({
        currentInventory,
        inflowKgPerS: fillFlow,
        outflowKgPerS: boundedOutletFlow,
        dtSeconds: context.dtSeconds,
        minInventory: 0,
        maxInventory: totalVolume * liquidDensity,
      })
      const nextGasVolume = Math.max(0.001, totalVolume - nextInventory / liquidDensity)
      const nextGasPressure = parameterNumber(component, 'initialGasPressureMPa') * Math.pow(initialGasVolume / nextGasVolume, exponent)
      const fillTemperature = averageIncomingLinkValue(system, component.index, 'temperatureC', context, link => String(link.toPortName) === 'fill')
      const currentTemperature = context.readNumber(componentVariablePath(component, 'temperatureC'))
      const nextTemperature = fillTemperature === null || fillFlow <= 0
        ? currentTemperature
        : (currentTemperature * currentInventory + fillTemperature * fillFlow * context.dtSeconds) / Math.max(1, currentInventory + fillFlow * context.dtSeconds)
      context.write(componentVariablePath(component, 'liquidInventoryKg'), nextInventory)
      context.write(componentVariablePath(component, 'gasVolumeM3'), nextGasVolume)
      context.write(componentVariablePath(component, 'gasPressureMPa'), nextGasPressure)
      context.write(componentVariablePath(component, 'outletFlowKgPerS'), boundedOutletFlow)
      context.write(componentVariablePath(component, 'fillFlowKgPerS'), fillFlow)
      context.write(componentVariablePath(component, 'availableInjectionHeadMPa'), Math.max(0, nextGasPressure - downstreamPressure))
      context.write(componentVariablePath(component, 'depletedFraction'), clamp(1 - nextInventory / Math.max(1, initialInventory - minimumInventory), 0, 1))
      context.write(componentVariablePath(component, 'checkValveOpenFraction'), checkValveOpen ? 1 : 0)
      context.write(componentVariablePath(component, 'temperatureC'), nextTemperature)
    },
  },
]
