const clampValue = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

export const specificHeatWaterKjPerKgK = 4.18
/** Water's latent heat at atmospheric pressure: the simplified condenser relation's energy per kilogram condensed. */
export const latentHeatSteamMjPerKg = 2.26

export const heatMwFromWaterFlowAndDeltaT = (
  flowKgPerS: number,
  deltaTemperatureC: number,
): number => Math.max(0, flowKgPerS * specificHeatWaterKjPerKgK * deltaTemperatureC / 1_000)

export const waterDeltaTFromHeatMw = (
  heatMw: number,
  flowKgPerS: number,
): number => heatMw * 1_000 / (Math.max(1, flowKgPerS) * specificHeatWaterKjPerKgK)

export const saturationTemperatureCFromPressureMPa = (pressureMPa: number): number => {
  // IAPWS-IF97, region 4, equation 31 / table 34 (R7-97, 2012).
  // https://iapws.org/public/documents/UWTF-/IF97-Rev.pdf
  // This helper describes saturation only, not a full water/steam property model.
  const pressure = clampValue(pressureMPa, 0.000611213, 22.064)
  const beta = pressure ** 0.25
  const e = beta * beta - 17.073846940092 * beta + 14.915108613530
  const f = 1167.0521452767 * beta * beta + 12020.824702470 * beta - 4823.2657361591
  const g = -724213.16703206 * beta * beta - 3232555.0322333 * beta + 405113.40542057
  const d = 2 * g / (-f - Math.sqrt(f * f - 4 * e * g))
  const n10 = 650.17534844798
  return (n10 + d - Math.sqrt((n10 + d) ** 2 - 4 * (-0.23855557567849 + n10 * d))) / 2 - 273.15
}

export const energyBalanceTemperatureStep = (config: {
  readonly currentTemperatureC: number
  readonly heatInMw: number
  readonly heatOutMw: number
  readonly dtSeconds: number
  readonly thermalCapacityMjPerK: number
  readonly minTemperatureC: number
  readonly maxTemperatureC: number
}): number => {
  const thermalCapacity = Math.max(1, config.thermalCapacityMjPerK)
  const deltaTemperature = (config.heatInMw - config.heatOutMw) * config.dtSeconds / thermalCapacity
  return clampValue(config.currentTemperatureC + deltaTemperature, config.minTemperatureC, config.maxTemperatureC)
}
