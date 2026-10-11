import type { CompiledComponent } from '../../graph/index.ts'
import { componentVariablePath, type ComponentBehaviorDefinition } from '../behavior-contract.ts'
import {
  approach,
  clamp,
  optionalParameterNumber,
  parameterNumber,
  relaxToward,
} from '../component-helpers.ts'
import {
  averageIncomingComponentLinkValue as averageIncomingLinkValue,
  averageOutgoingComponentLinkValue as averageOutgoingLinkValue,
  incomingComponentLinks,
  sumOutgoingComponentLinkValue,
} from '../component-link-helpers.ts'
import { primaryLoopLegReversed } from '../primary-loop-hydraulics.ts'
import { inventoryBalanceStep } from '../physics.ts'
import { primarySystemReactorCore } from '../system-topology.ts'
import { steamGeneratorNarrowRange, steamGeneratorNarrowRangeLevelPercent, steamGeneratorOperatingLevel } from '../../steam-generator-operating-level.ts'
import {
  energyBalanceTemperatureStep,
  heatMwFromWaterFlowAndDeltaT,
  latentHeatSteamMjPerKg,
  saturationTemperatureCFromPressureMPa,
  steamFlowKgPerSFromHeatMw,
} from '../thermophysics.ts'
import { liquidEnthalpyKjPerKg, liquidTemperatureCFromEnthalpy } from '../water-properties.ts'

type SteamGeneratorBehaviorInput = Parameters<ComponentBehaviorDefinition['update']>[0]

const primaryCoolantPressureMPa = ({ system, component, context }: SteamGeneratorBehaviorInput): number =>
  averageIncomingLinkValue(system, component, 'pressureMPa', context, link => link.service === 'primaryCoolant')
  ?? parameterNumber(component, 'nominalPressureMPa')

/** The temperature of the reactor coolant entering a generator's tubes: from
 * its hot leg, or, while the other loops drive its loop backwards, from its
 * cold side, the downcomer's water coming back through its pump. */
const enteringPrimaryCoolantTemperatureC = ({ system, component, context }: SteamGeneratorBehaviorInput): number | null => {
  const reversed = incomingComponentLinks(system, component).some(link => link.service === 'primaryCoolant' && primaryLoopLegReversed(system, link, context))
  return reversed
    ? averageOutgoingLinkValue(system, component, 'temperatureC', context, link => link.service === 'primaryCoolant')
    : averageIncomingLinkValue(system, component, 'temperatureC', context, link => link.service === 'primaryCoolant')
}

/** Heat the reactor coolant gives up cooling from one temperature to another,
 * from its enthalpy at coolant pressure: hot coolant holds 5.2–6.4 kJ/kg K. */
const primaryCoolantHeatMw = (flowKgPerS: number, fromTemperatureC: number, toTemperatureC: number, pressureMPa: number): number =>
  fromTemperatureC <= toTemperatureC
    ? 0
    : flowKgPerS * (liquidEnthalpyKjPerKg(fromTemperatureC, pressureMPa) - liquidEnthalpyKjPerKg(toTemperatureC, pressureMPa)) / 1_000

/** The steam a generator's dome keeps however hard it is drawn on: its steam mass never falls below this. */
export const steamGeneratorMinimumSteamMassKg = (component: CompiledComponent): number =>
  optionalParameterNumber(component, 'nominalSteamMassKg', 12_000) * 0.15

export const steamGeneratorBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'steam-generator-heat-transfer',
    phase: 'solveThermalTransfer',
    componentKind: 'steamGenerator',
    reads: ['tubeMetalTemperatureC', 'secondaryTemperatureC', 'collapsedLevelPercent', 'swellLevelPercent', 'voidFraction', 'incoming:primaryCoolant.temperatureC', 'incoming:primaryCoolant.flowKgPerS'],
    writes: ['heatTransferMw', 'steamFlowKgPerS', 'boilingRateKgPerS', 'tubeCoverageFraction', 'tubeUncoveredFraction', 'availableHeatTransferFraction'],
    update: (input): void => {
      const { system, component, context } = input
      const primaryWaterTemperature = enteringPrimaryCoolantTemperatureC(input)
        ?? context.readNumber(componentVariablePath(component, 'primaryInletTemperatureC'))
      const primaryWaterFlow = averageIncomingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'primaryCoolant') ?? 0
      const secondaryTemperature = context.readNumber(componentVariablePath(component, 'secondaryTemperatureC'))
      const tubeMetalTemperature = context.readNumber(componentVariablePath(component, 'tubeMetalTemperatureC'))
      // The tubes are covered while the two-phase mixture (collapsed water and
      // its boiling swell, in fractions of the full-scale inventory) stands
      // above the bundle. The narrow range spans the region above it, so they
      // transfer heat in full at any narrow-range level, the low-low trip set
      // point included, and uncover only as the generator boils toward dry.
      // The mixture swells by the voids in the water there is, so a generator
      // boiled dry has no mixture left to cover them, however hard it boiled.
      const collapsedLevel = context.readNumber(componentVariablePath(component, 'collapsedLevelPercent'))
      const voidFraction = clamp(context.readNumber(componentVariablePath(component, 'voidFraction')), 0, 0.95)
      const mixtureSwell = Math.min(context.readNumber(componentVariablePath(component, 'swellLevelPercent')), collapsedLevel * voidFraction / (1 - voidFraction))
      const levelFraction = clamp((collapsedLevel + mixtureSwell) / 100, 0, 1)
      const tubeBottomLevel = optionalParameterNumber(component, 'tubeBundleBottomLevelPercent', 0.01)
      const tubeTopLevel = optionalParameterNumber(component, 'tubeBundleTopLevelPercent', tubeBottomLevel + 0.05)
      const tubeCoverage = clamp((levelFraction - tubeBottomLevel) / Math.max(0.01, tubeTopLevel - tubeBottomLevel), 0, 1)
      const tubeUncovered = 1 - tubeCoverage
      const minimumHeatTransferFraction = optionalParameterNumber(component, 'minimumUncoveredTubeHeatTransferFraction', 0.12)
      const availableHeatTransferFraction = clamp(minimumHeatTransferFraction + (1 - minimumHeatTransferFraction) * tubeCoverage, minimumHeatTransferFraction, 1)
      const recirculationRatio = optionalParameterNumber(component, 'recirculationRatio', 4)
      const recirculationHeatTransferFactor = clamp(0.65 + recirculationRatio * 0.09, 0.8, 1.35)
      const transferCapacity = parameterNumber(component, 'heatTransferCoefficientMwPerK')
        * recirculationHeatTransferFactor
        * Math.max(0, tubeMetalTemperature - secondaryTemperature)
      // The coolant cannot give more than cooling it to the secondary
      // temperature. Cold water's specific heat is the least any liquid water
      // has, so while the tubes take less than that bound, they limit and the
      // coolant's enthalpy need not be evaluated.
      const coldWaterFlowCapacity = heatMwFromWaterFlowAndDeltaT(primaryWaterFlow, Math.max(0, primaryWaterTemperature - secondaryTemperature))
      const flowCapacity = transferCapacity <= coldWaterFlowCapacity
        ? coldWaterFlowCapacity
        : primaryCoolantHeatMw(primaryWaterFlow, primaryWaterTemperature, secondaryTemperature, primaryCoolantPressureMPa(input))
      const heatTransfer = Math.max(0, Math.min(transferCapacity, flowCapacity) * availableHeatTransferFraction)
      const boilingRate = steamFlowKgPerSFromHeatMw(heatTransfer)
      context.write(componentVariablePath(component, 'heatTransferMw'), heatTransfer)
      context.write(componentVariablePath(component, 'boilingRateKgPerS'), boilingRate)
      context.write(componentVariablePath(component, 'steamFlowKgPerS'), Math.min(boilingRate, optionalParameterNumber(component, 'nominalSteamFlowKgPerS', 760) * 1.25))
      context.write(componentVariablePath(component, 'tubeCoverageFraction'), tubeCoverage)
      context.write(componentVariablePath(component, 'tubeUncoveredFraction'), tubeUncovered)
      context.write(componentVariablePath(component, 'availableHeatTransferFraction'), availableHeatTransferFraction)
    },
  },
  {
    id: 'steam-generator-tube-leak-transfer',
    phase: 'solveThermalTransfer',
    componentKind: 'steamGenerator',
    reads: ['tubeLeakFraction', 'pressureMPa', 'secondaryRadiationMSvPerH', 'primary pressure source', 'reactorCore.powerMw'],
    writes: ['primaryToSecondaryLeakKgPerS', 'secondaryRadiationMSvPerH'],
    update: ({ system, component, context }): void => {
      const leakFraction = clamp(context.readNumber(componentVariablePath(component, 'tubeLeakFraction')), 0, 1)
      const primaryPressure = averageIncomingLinkValue(system, component, 'pressureMPa', context, link => link.service === 'primaryCoolant') ?? 0
      const secondaryPressure = context.readNumber(componentVariablePath(component, 'pressureMPa'))
      const pressureDelta = Math.max(0, primaryPressure - secondaryPressure)
      const leakCoefficient = optionalParameterNumber(component, 'tubeLeakFlowCoefficientKgPerSPerSqrtMPa', 0)
      const leakFlow = leakFraction * leakCoefficient * Math.sqrt(pressureDelta)
      // The steam-line monitor reads N-16, which fast neutrons make from the
      // coolant's oxygen in the core and which decays with a 7 s half-life:
      // the leaking coolant carries it in proportion to fission power, so the
      // reading falls to background within seconds of a reactor trip. The
      // gain is the reading per kg/s of leak at rated power; with no core
      // there are no neutrons and no N-16.
      const core = primarySystemReactorCore(system)
      const powerFraction = core === null ? 0 : clamp(context.readNumber(componentVariablePath(core, 'powerMw')) / parameterNumber(core, 'ratedPowerMw'), 0, 1.2)
      const radiationTarget = 0.02 + leakFlow * optionalParameterNumber(component, 'tubeLeakRadiationGainMSvPerHPerKgS', 0.7) * powerFraction
      context.write(componentVariablePath(component, 'primaryToSecondaryLeakKgPerS'), leakFlow)
      context.write(
        componentVariablePath(component, 'secondaryRadiationMSvPerH'),
        relaxToward(
          context.readNumber(componentVariablePath(component, 'secondaryRadiationMSvPerH')),
          radiationTarget,
          context.dtSeconds,
          optionalParameterNumber(component, 'tubeLeakRadiationTimeConstantS', 5),
        ),
      )
    },
  },
  {
    id: 'steam-generator-inventory-pressure-state',
    phase: 'updateComponentState',
    componentKind: 'steamGenerator',
    reads: [
      'pressureMPa',
      'levelPercent',
      'collapsedLevelPercent',
      'voidFraction',
      'swellLevelPercent',
      'steamMassKg',
      'heatTransferMw',
      'steamFlowKgPerS',
      'boilingRateKgPerS',
      'feedwaterFlowKgPerS',
      'steamOutflowKgPerS',
      'steamQualityFraction',
      'primaryInletTemperatureC',
      'primaryOutletTemperatureC',
      'tubeMetalTemperatureC',
      'secondaryTemperatureC',
      'secondaryInventoryKg',
      'pressureTargetMPa',
      'steamMassPressureBiasMPa',
      'temperaturePressureBiasMPa',
      'inventoryPressureBiasMPa',
      'secondaryInventoryBalanceResidualKg',
      'steamMassBalanceResidualKg',
      'boilingEnergyResidualMw',
      'incoming:primaryCoolant.temperatureC',
      'incoming:primaryCoolant.flowKgPerS',
    ],
    writes: [
      'pressureMPa',
      'levelPercent',
      'collapsedLevelPercent',
      'voidFraction',
      'swellLevelPercent',
      'steamMassKg',
      'primaryInletTemperatureC',
      'primaryOutletTemperatureC',
      'tubeMetalTemperatureC',
      'secondaryTemperatureC',
      'secondaryInventoryKg',
      'feedwaterFlowKgPerS',
      'steamOutflowKgPerS',
      'steamQualityFraction',
      'pressureTargetMPa',
      'steamMassPressureBiasMPa',
      'temperaturePressureBiasMPa',
      'inventoryPressureBiasMPa',
      'secondaryInventoryBalanceResidualKg',
      'steamMassBalanceResidualKg',
      'boilingEnergyResidualMw',
    ],
    update: (input): void => {
      const { system, component, context } = input
      const feedwaterFlow = (averageIncomingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'feedwater') ?? 0)
        + (averageIncomingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'auxFeedwater') ?? 0)
      const tubeLeakFlow = context.readNumber(componentVariablePath(component, 'primaryToSecondaryLeakKgPerS'))
      context.write(componentVariablePath(component, 'feedwaterFlowKgPerS'), feedwaterFlow)
      // A generator's steam leaves by every main steam line: by its steam outlet to its isolation valve and by its
      // relief outlet to its atmospheric relief valve. Its steam outlet flow is what the outlet's line carries alone.
      const mainSteamOutflow = sumOutgoingComponentLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'mainSteam')
      context.write(componentVariablePath(component, 'steamOutflowKgPerS'), sumOutgoingComponentLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'mainSteam' && String(link.fromPortName) === 'steamOutlet'))
      const pressurePath = componentVariablePath(component, 'pressureMPa')
      const levelPath = componentVariablePath(component, 'levelPercent')
      const heatTransfer = context.readNumber(componentVariablePath(component, 'heatTransferMw'))
      const nominalPressure = parameterNumber(component, 'nominalPressureMPa')
      const primaryInletTemperature = enteringPrimaryCoolantTemperatureC(input)
        ?? context.readNumber(componentVariablePath(component, 'primaryInletTemperatureC'))
      const primaryFlow = Math.max(1, averageIncomingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'primaryCoolant') ?? 1)
      const primaryPressure = primaryCoolantPressureMPa(input)
      const primaryInletEnthalpy = liquidEnthalpyKjPerKg(primaryInletTemperature, primaryPressure)
      const primaryOutletTarget = clamp(liquidTemperatureCFromEnthalpy(primaryPressure, primaryInletEnthalpy - heatTransfer * 1_000 / primaryFlow), 180, primaryInletTemperature)
      const primaryTimeConstantSeconds = optionalParameterNumber(component, 'primaryThermalTimeConstantS', 10)
      context.write(componentVariablePath(component, 'primaryInletTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'primaryInletTemperatureC')), primaryInletTemperature, context.dtSeconds, primaryTimeConstantSeconds))
      context.write(componentVariablePath(component, 'primaryOutletTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'primaryOutletTemperatureC')), primaryOutletTarget, context.dtSeconds, primaryTimeConstantSeconds))
      const tubeMetalTemperature = context.readNumber(componentVariablePath(component, 'tubeMetalTemperatureC'))
      const primaryToTubeHeat = Math.min(
        tubeMetalTemperature >= primaryInletTemperature
          ? 0
          : primaryFlow * (primaryInletEnthalpy - liquidEnthalpyKjPerKg(tubeMetalTemperature, primaryPressure)) / 1_000,
        parameterNumber(component, 'heatTransferCoefficientMwPerK') * Math.max(0, primaryInletTemperature - tubeMetalTemperature),
      )
      context.write(componentVariablePath(component, 'tubeMetalTemperatureC'), energyBalanceTemperatureStep({
        currentTemperatureC: tubeMetalTemperature,
        heatInMw: primaryToTubeHeat,
        heatOutMw: heatTransfer,
        dtSeconds: context.dtSeconds,
        thermalCapacityMjPerK: optionalParameterNumber(component, 'tubeMetalThermalCapacityMjPerK', 8_000),
        minTemperatureC: 120,
        maxTemperatureC: 360,
      }))

      const secondaryTemperatureTarget = clamp(saturationTemperatureCFromPressureMPa(context.readNumber(pressurePath)), 160, 330)
      context.write(componentVariablePath(component, 'secondaryTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'secondaryTemperatureC')), secondaryTemperatureTarget, context.dtSeconds, optionalParameterNumber(component, 'secondaryThermalTimeConstantS', 25)))
      const currentPressure = context.readNumber(pressurePath)
      const boilingRate = context.readNumber(componentVariablePath(component, 'boilingRateKgPerS'))
      context.write(componentVariablePath(component, 'boilingEnergyResidualMw'), boilingRate * latentHeatSteamMjPerKg - heatTransfer)
      const secondaryTemperature = context.readNumber(componentVariablePath(component, 'secondaryTemperatureC'))
      const rawTemperaturePressureBias = (secondaryTemperature - saturationTemperatureCFromPressureMPa(nominalPressure)) / 100 * nominalPressure
      const temperaturePressureBias = rawTemperaturePressureBias * optionalParameterNumber(component, 'temperaturePressureGainFraction', 0)
      const nominalSteamMass = optionalParameterNumber(component, 'nominalSteamMassKg', 12_000)
      const currentSteamMass = context.readNumber(componentVariablePath(component, 'steamMassKg'))
      const steamMassTarget = inventoryBalanceStep({
        currentInventory: currentSteamMass,
        inflowKgPerS: boilingRate,
        outflowKgPerS: mainSteamOutflow,
        dtSeconds: context.dtSeconds,
        minInventory: steamGeneratorMinimumSteamMassKg(component),
        maxInventory: nominalSteamMass * 2.5,
      })
      const nextSteamMass = steamMassTarget
      context.write(componentVariablePath(component, 'steamMassKg'), nextSteamMass)
      context.write(
        componentVariablePath(component, 'steamMassBalanceResidualKg'),
        nextSteamMass - currentSteamMass - (boilingRate - mainSteamOutflow) * context.dtSeconds,
      )
      const steamQualityTarget = mainSteamOutflow <= 0
        ? 1
        : clamp(boilingRate / Math.max(1, mainSteamOutflow), 0.78, 1)
      context.write(
        componentVariablePath(component, 'steamQualityFraction'),
        relaxToward(
          context.readNumber(componentVariablePath(component, 'steamQualityFraction')),
          steamQualityTarget,
          context.dtSeconds,
          optionalParameterNumber(component, 'steamQualityTimeConstantS', 8),
        ),
      )
      const nominalInventory = optionalParameterNumber(component, 'nominalSecondaryInventoryKg', 56_000)
      const currentInventory = context.readNumber(componentVariablePath(component, 'secondaryInventoryKg'))
      const nextInventory = inventoryBalanceStep({
        currentInventory,
        inflowKgPerS: feedwaterFlow + tubeLeakFlow,
        outflowKgPerS: boilingRate,
        dtSeconds: context.dtSeconds,
        minInventory: 0,
        maxInventory: nominalInventory,
      })
      context.write(componentVariablePath(component, 'secondaryInventoryKg'), nextInventory)
      context.write(
        componentVariablePath(component, 'secondaryInventoryBalanceResidualKg'),
        nextInventory - currentInventory - (feedwaterFlow + tubeLeakFlow - boilingRate) * context.dtSeconds,
      )
      const collapsedLevel = clamp((nextInventory / nominalInventory) * 100, 0, 100)
      context.write(componentVariablePath(component, 'collapsedLevelPercent'), collapsedLevel)
      const recirculationRatio = optionalParameterNumber(component, 'recirculationRatio', 1)
      const nominalSteamFlow = optionalParameterNumber(component, 'nominalSteamFlowKgPerS', 760)
      const recirculationMultiplier = clamp(1 + (recirculationRatio - 1) * 0.06, 1, 1.35)
      const voidTarget = clamp(
        optionalParameterNumber(component, 'voidFractionAtNominalBoiling', 0.16)
        * recirculationMultiplier
        * boilingRate / Math.max(1, nominalSteamFlow),
        0,
        0.45,
      )
      const voidFraction = relaxToward(
        context.readNumber(componentVariablePath(component, 'voidFraction')),
        voidTarget,
        context.dtSeconds,
        optionalParameterNumber(component, 'voidFractionTimeConstantS', 6),
      )
      context.write(componentVariablePath(component, 'voidFraction'), voidFraction)
      const swellLevel = clamp(voidFraction * optionalParameterNumber(component, 'swellLevelGainPercent', 26), 0, 35)
      context.write(componentVariablePath(component, 'swellLevelPercent'), swellLevel)
      // The indicated narrow-range level reads the mixture over its span: a
      // sudden fall in steaming collapses the voids and the level shrinks.
      context.write(levelPath, steamGeneratorNarrowRangeLevelPercent(steamGeneratorNarrowRange(component.parameters as Record<string, unknown>), collapsedLevel + swellLevel))
      // Steam piling up in a generator with nowhere to go raises its pressure
      // over the whole range its steam mass may take, so the pressure climbs
      // until a dump, relief or safety valve opens rather than levelling off
      // while the steam is lost.
      const steamMassPressureBias = optionalParameterNumber(component, 'steamMassPressureGainFraction', 1)
        * nominalPressure
        * (clamp(nextSteamMass / nominalSteamMass, 0.15, 2.5) - 1)
      const nominalCollapsedLevel = steamGeneratorOperatingLevel(component.parameters as Record<string, unknown>).collapsed / 100
      const inventoryPressureBias = ((nextInventory / nominalInventory) - nominalCollapsedLevel) * optionalParameterNumber(component, 'pressureInventoryGainMPaPerFraction', 0.6)
      const demandPressureBias = (boilingRate - mainSteamOutflow) * optionalParameterNumber(component, 'steamPressureGainMPaPerKgS', 0.006)
      const pressureTarget = nominalPressure + steamMassPressureBias + demandPressureBias + temperaturePressureBias + inventoryPressureBias
      context.write(componentVariablePath(component, 'steamMassPressureBiasMPa'), steamMassPressureBias)
      context.write(componentVariablePath(component, 'temperaturePressureBiasMPa'), temperaturePressureBias)
      context.write(componentVariablePath(component, 'inventoryPressureBiasMPa'), inventoryPressureBias)
      context.write(componentVariablePath(component, 'pressureTargetMPa'), clamp(pressureTarget, nominalPressure * 0.2, nominalPressure * 1.4))
      context.write(pressurePath, approach(currentPressure, clamp(pressureTarget, nominalPressure * 0.2, nominalPressure * 1.4), 0.08 * context.dtSeconds))
    },
  },
]
