import { liquidEnthalpyKjPerKg, liquidTemperatureCFromEnthalpy } from './runtime/water-properties.ts'

/** Shared initial thermal state and neutral-feedback reference. Keep these
 * consistent when an operating point changes initial power or temperature.
 *
 * Temperatures follow from enthalpy at reactor coolant pressure, because hot
 * coolant holds 5.2–6.4 kJ/kg K, not cold water's 4.18. The core inlet is the
 * cold leg after the reactor coolant pumps, whose heat the steam generator
 * outlet lies below; the core-exit thermocouples sit above the mixed vessel
 * outlet because the core bypass flow carries no core heat. */
export const reactorInitialThermalState = (parameters: Readonly<Record<string, unknown>>) => {
  const pressure = Number(parameters.nominalCoolantPressureMPa)
  const flow = Number(parameters.nominalPrimaryFlowKgPerS ?? 17_000)
  const inlet = Number(parameters.initialCoolantInletTemperatureC ?? 290)
  const thermalFraction = Number(parameters.initialPowerFraction)
  const coreHeatMw = Number(parameters.ratedPowerMw) * thermalFraction
  const pumpHeatMw = Number(parameters.reactorCoolantPumpHeatMw ?? 0)
  const bypassFraction = Number(parameters.coreBypassFlowFraction ?? 0)
  const inletEnthalpy = liquidEnthalpyKjPerKg(inlet, pressure)
  const outlet = liquidTemperatureCFromEnthalpy(pressure, inletEnthalpy + coreHeatMw * 1_000 / flow)
  const coreExit = liquidTemperatureCFromEnthalpy(pressure, inletEnthalpy + coreHeatMw * 1_000 / (flow * (1 - bypassFraction)))
  const steamGeneratorOutlet = liquidTemperatureCFromEnthalpy(pressure, inletEnthalpy - pumpHeatMw * 1_000 / flow)
  const rise = Number(parameters.fuelTemperatureRiseAtRatedPowerC ?? 140) * thermalFraction
  const lower = outlet + rise * 0.88
  const mid = outlet + rise * 1.08
  const upper = outlet + rise
  return { inlet, outlet, coreExit, steamGeneratorOutlet, coreHeatMw, pumpHeatMw, lower, mid, upper, average: (lower + mid + upper) / 3 }
}
