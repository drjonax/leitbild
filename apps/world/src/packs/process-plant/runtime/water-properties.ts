import { saturationTemperatureCFromPressureMPa } from './thermophysics.ts'

// IAPWS-IF97 water and steam properties for the reactor coolant system
// (R7-97, 2012: https://iapws.org/public/documents/UWTF-/IF97-Rev.pdf).
// Reactor coolant is compressed liquid (region 1). The pressurizer steam
// and any steam that flashes in the loops is saturated, so the saturation
// line is tabulated once from regions 1 and 2 and interpolated. Region 1 is
// evaluated by a single pass over precomputed integer powers, because the
// runtime calls it several times in every solver step.

const kelvinOffset = 273.15
const specificGasConstantKjPerKgK = 0.461526
const criticalPressureMPa = 22.064
const criticalDensityKgPerM3 = 322
const criticalEnthalpyKjPerKg = 2087.546845

// Region 1, table 2: I, J, n.
const region1I = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 8, 8, 21, 23, 29, 30, 31, 32]
const region1J = [-2, -1, 0, 1, 2, 3, 4, 5, -9, -7, -1, 0, 1, 3, -3, 0, 1, 3, 17, -4, 0, 6, -5, -2, 10, -8, -11, -6, -29, -31, -38, -39, -40, -41]
const region1N = [
  0.14632971213167, -0.84548187169114, -0.37563603672040e1, 0.33855169168385e1, -0.95791963387872, 0.15772038513228,
  -0.16616417199501e-1, 0.81214629983568e-3, 0.28319080123804e-3, -0.60706301565874e-3, -0.18990068218419e-1,
  -0.32529748770505e-1, -0.21841717175414e-1, -0.52838357969930e-4, -0.47184321073267e-3, -0.30001780793026e-3,
  0.47661393906987e-4, -0.44141845330846e-5, -0.72694996297594e-15, -0.31679644845054e-4, -0.28270797985312e-5,
  -0.85205128120103e-9, -0.22425281908000e-5, -0.65171222895601e-6, -0.14341729937924e-12, -0.40516996860117e-6,
  -0.12734301741641e-8, -0.17424871230634e-9, -0.68762131295531e-18, 0.14478307828521e-19, 0.26335781662795e-22,
  -0.11947622640071e-22, 0.18228094581404e-23, -0.93537087292458e-25,
]
const region1MaxI = 32
const region1MinJ = -41
const region1MaxJ = 17

// Powers (7.1 - pi)^k for k = 0..32 and (tau - 1.222)^j for j = -43..17,
// reused by every evaluation.
const piPowers = new Float64Array(region1MaxI + 1)
const tauPowerOffset = -region1MinJ + 2
const tauPowers = new Float64Array(tauPowerOffset + region1MaxJ + 1)

const fillRegion1Powers = (a: number, b: number): void => {
  piPowers[0] = 1
  for (let k = 1; k <= region1MaxI; k++) piPowers[k] = piPowers[k - 1]! * a
  tauPowers[tauPowerOffset] = 1
  for (let j = 1; j <= region1MaxJ; j++) tauPowers[tauPowerOffset + j] = tauPowers[tauPowerOffset + j - 1]! * b
  const inverse = 1 / b
  for (let j = -1; j >= -tauPowerOffset; j--) tauPowers[tauPowerOffset + j] = tauPowers[tauPowerOffset + j + 1]! * inverse
}

export interface CompressedWaterState {
  readonly densityKgPerM3: number
  readonly enthalpyKjPerKg: number
  readonly specificHeatKjPerKgK: number
}

const region1 = (temperatureK: number, pressureMPa: number): CompressedWaterState => {
  const pi = pressureMPa / 16.53
  const tau = 1386 / temperatureK
  fillRegion1Powers(7.1 - pi, tau - 1.222)
  let gammaPi = 0
  let gammaTau = 0
  let gammaTauTau = 0
  for (let i = 0; i < region1N.length; i++) {
    const n = region1N[i]!
    const I = region1I[i]!
    const J = region1J[i]!
    if (I > 0) gammaPi -= n * I * piPowers[I - 1]! * tauPowers[tauPowerOffset + J]!
    gammaTau += n * piPowers[I]! * J * tauPowers[tauPowerOffset + J - 1]!
    gammaTauTau += n * piPowers[I]! * J * (J - 1) * tauPowers[tauPowerOffset + J - 2]!
  }
  const rt = specificGasConstantKjPerKgK * temperatureK
  return {
    densityKgPerM3: pressureMPa * 1_000 / (rt * pi * gammaPi),
    enthalpyKjPerKg: rt * tau * gammaTau,
    specificHeatKjPerKgK: -specificGasConstantKjPerKgK * tau * tau * gammaTauTau,
  }
}

/** Region 1 holds up to 350 °C; reactor coolant above that is held at it, and
 * pressure is kept at or above saturation, where the liquid formulation applies. */
export const compressedWaterState = (temperatureC: number, pressureMPa: number): CompressedWaterState => {
  const temperature = Math.min(350, Math.max(0, temperatureC))
  return region1(temperature + kelvinOffset, Math.max(pressureMPa, saturationPressureMPaFromTemperatureC(temperature)))
}

/** Liquid enthalpy. A liquid's enthalpy hardly depends on pressure, so liquid
 * hotter than saturation at this pressure (superheated, about to flash) is
 * given its enthalpy at its own saturation pressure; it stays defined to
 * 370 °C, beyond region 1's 350 °C, along the saturation line. */
export const liquidEnthalpyKjPerKg = (temperatureC: number, pressureMPa: number): number => {
  const temperature = Math.min(370, Math.max(0, temperatureC))
  return region1(temperature + kelvinOffset, Math.min(100, Math.max(pressureMPa, saturationPressureMPaFromTemperatureC(temperature)))).enthalpyKjPerKg
}

// Region 1 backward equation T(p, h), table 6.
const backwardI = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 3, 4, 5, 6]
const backwardJ = [0, 1, 2, 6, 22, 32, 0, 1, 2, 3, 4, 10, 32, 10, 32, 10, 32, 32, 32, 32]
const backwardN = [
  -0.23872489924521e3, 0.40421188637945e3, 0.11349746881718e3, -0.58457616048039e1, -0.15285482413140e-3,
  -0.10866707695377e-5, -0.13391744872602e2, 0.43211039183559e2, -0.54010067170506e2, 0.30535892203916e2,
  -0.65964749423638e1, 0.93965400878363e-2, 0.11573647505340e-6, -0.25858641282073e-4, -0.40644363084799e-8,
  0.66456186191635e-7, 0.80670734103027e-10, -0.93477771213947e-12, 0.58265442020601e-14, -0.15020185953503e-16,
]

/** Liquid temperature from pressure and enthalpy (IF97 eq. 11). Liquid with
 * more enthalpy than saturated liquid at this pressure is superheated liquid
 * about to flash: its temperature is that of saturated liquid with the same
 * enthalpy, up to 370 °C. */
export const liquidTemperatureCFromEnthalpy = (pressureMPa: number, enthalpyKjPerKg: number): number => {
  const pressure = Math.max(tableFirstMPa, Math.min(100, pressureMPa))
  if (pressure < criticalPressureMPa && enthalpyKjPerKg > saturatedWaterSteam(pressure).liquidEnthalpyKjPerKg) {
    return Math.min(370, saturationTemperatureCFromLiquidEnthalpy(enthalpyKjPerKg))
  }
  const eta1 = Math.max(0, enthalpyKjPerKg) / 2_500 + 1
  let theta = 0
  for (let i = 0; i < backwardN.length; i++) theta += backwardN[i]! * pressure ** backwardI[i]! * eta1 ** backwardJ[i]!
  return Math.min(370, theta - kelvinOffset)
}

/** Saturation pressure (IF97 region 4, eq. 30). */
export const saturationPressureMPaFromTemperatureC = (temperatureC: number): number => {
  const temperature = Math.min(373.946, Math.max(0.01, temperatureC)) + kelvinOffset
  const theta = temperature - 0.23855557567849 / (temperature - 650.17534844798)
  const a = theta * theta + 1167.0521452767 * theta - 724213.16703206
  const b = -17.073846940092 * theta * theta + 12020.824702470 * theta - 3232555.0322333
  const c = 14.915108613530 * theta * theta - 4823.2657361591 * theta + 405113.40542057
  return (2 * c / (-b + Math.sqrt(b * b - 4 * a * c))) ** 4
}

// Region 2, tables 10 and 11: ideal-gas and residual parts.
const region2IdealJ = [0, 1, -5, -4, -3, -2, -1, 2, 3]
const region2IdealN = [
  -0.96927686500217e1, 0.10086655968018e2, -0.56087911283020e-2, 0.71452738081455e-1, -0.40710498223928,
  0.14240819171444e1, -0.43839511319450e1, -0.28408632460772, 0.21268463753307e-1,
]
const region2I = [1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 5, 6, 6, 6, 7, 7, 7, 8, 8, 9, 10, 10, 10, 16, 16, 18, 20, 20, 20, 21, 22, 23, 24, 24, 24]
const region2J = [0, 1, 2, 3, 6, 1, 2, 4, 7, 36, 0, 1, 3, 6, 35, 1, 2, 3, 7, 3, 16, 35, 0, 11, 25, 8, 36, 13, 4, 10, 14, 29, 50, 57, 20, 35, 48, 21, 53, 39, 26, 40, 58]
const region2N = [
  -0.17731742473213e-2, -0.17834862292358e-1, -0.45996013696365e-1, -0.57581259083432e-1, -0.50325278727930e-1,
  -0.33032641670203e-4, -0.18948987516315e-3, -0.39392777243355e-2, -0.43797295650573e-1, -0.26674547914087e-4,
  0.20481737692309e-7, 0.43870667284435e-6, -0.32277677238570e-4, -0.15033924542148e-2, -0.40668253562649e-1,
  -0.78847309559367e-9, 0.12790717852285e-7, 0.48225372718507e-6, 0.22922076337661e-5, -0.16714766451061e-10,
  -0.21171472321355e-2, -0.23895741934104e2, -0.59059564324270e-17, -0.12621808899101e-5, -0.38946842435739e-1,
  0.11256211360459e-10, -0.82311340897998e1, 0.19809712802088e-7, 0.10406965210174e-18, -0.10234747095929e-12,
  -0.10018179379511e-8, -0.80882908646985e-10, 0.10693031879409, -0.33662250574171, 0.89185845355421e-24,
  0.30629316876232e-12, -0.42002467698208e-5, -0.59056029685639e-25, 0.37826947613457e-5, -0.12768608934681e-14,
  0.73087610595061e-28, 0.55414715350778e-16, -0.94369707241210e-6,
]

/** Steam (IF97 region 2): density and enthalpy. Used to build the saturation table. */
export const steamState = (temperatureC: number, pressureMPa: number): { readonly densityKgPerM3: number; readonly enthalpyKjPerKg: number } => {
  const temperatureK = temperatureC + kelvinOffset
  const pi = pressureMPa
  const tau = 540 / temperatureK
  let idealTau = 0
  for (let i = 0; i < region2IdealN.length; i++) idealTau += region2IdealN[i]! * region2IdealJ[i]! * tau ** (region2IdealJ[i]! - 1)
  let residualPi = 0
  let residualTau = 0
  for (let i = 0; i < region2N.length; i++) {
    const n = region2N[i]!
    const I = region2I[i]!
    const J = region2J[i]!
    residualPi += n * I * pi ** (I - 1) * (tau - 0.5) ** J
    residualTau += n * pi ** I * J * (tau - 0.5) ** (J - 1)
  }
  const rt = specificGasConstantKjPerKgK * temperatureK
  return {
    densityKgPerM3: pressureMPa * 1_000 / (rt * pi * (1 / pi + residualPi)),
    enthalpyKjPerKg: rt * tau * (idealTau + residualTau),
  }
}

export interface SaturatedWaterSteam {
  readonly temperatureC: number
  readonly liquidDensityKgPerM3: number
  readonly vapourDensityKgPerM3: number
  readonly liquidEnthalpyKjPerKg: number
  readonly vapourEnthalpyKjPerKg: number
}

// The saturation line in 0.05 MPa steps from 0.05 MPa. Regions 1 and 2 meet
// it up to 16.53 MPa, and continued past it into region 3 they stay within a
// few tenths of a percent of the IAPWS saturation tables up to 18.5 MPa.
// Beyond that both phases are joined straight to the critical point, which
// the reactor coolant system never approaches: its safety valves lift at
// 17.2 MPa.
const tableStepMPa = 0.05
const tableFirstMPa = 0.05
const regionTwoLimitMPa = 18.5
const saturationTable = (() => {
  const rows: SaturatedWaterSteam[] = []
  const pressureAt = (index: number): number => tableFirstMPa + index * tableStepMPa
  const lastFormulationIndex = Math.round((regionTwoLimitMPa - tableFirstMPa) / tableStepMPa)
  for (let index = 0; index <= lastFormulationIndex; index++) {
    const pressure = pressureAt(index)
    const temperature = saturationTemperatureCFromPressureMPa(pressure)
    const liquid = region1(temperature + kelvinOffset, pressure)
    const vapour = steamState(temperature, pressure)
    rows.push({
      temperatureC: temperature,
      liquidDensityKgPerM3: liquid.densityKgPerM3,
      vapourDensityKgPerM3: vapour.densityKgPerM3,
      liquidEnthalpyKjPerKg: liquid.enthalpyKjPerKg,
      vapourEnthalpyKjPerKg: vapour.enthalpyKjPerKg,
    })
  }
  const last = rows[lastFormulationIndex]!
  const lastPressure = pressureAt(lastFormulationIndex)
  for (let index = lastFormulationIndex + 1; pressureAt(index - 1) < criticalPressureMPa; index++) {
    const pressure = Math.min(criticalPressureMPa, pressureAt(index))
    const fraction = (pressure - lastPressure) / (criticalPressureMPa - lastPressure)
    const blend = (from: number, to: number): number => from + (to - from) * fraction
    rows.push({
      temperatureC: saturationTemperatureCFromPressureMPa(pressure),
      liquidDensityKgPerM3: blend(last.liquidDensityKgPerM3, criticalDensityKgPerM3),
      vapourDensityKgPerM3: blend(last.vapourDensityKgPerM3, criticalDensityKgPerM3),
      liquidEnthalpyKjPerKg: blend(last.liquidEnthalpyKjPerKg, criticalEnthalpyKjPerKg),
      vapourEnthalpyKjPerKg: blend(last.vapourEnthalpyKjPerKg, criticalEnthalpyKjPerKg),
    })
  }
  return rows
})()

/** Saturated liquid and vapour at a pressure, interpolated from the table. */
export const saturatedWaterSteam = (pressureMPa: number): SaturatedWaterSteam => {
  const position = (Math.min(criticalPressureMPa, Math.max(tableFirstMPa, pressureMPa)) - tableFirstMPa) / tableStepMPa
  const index = Math.min(saturationTable.length - 2, Math.floor(position))
  const fraction = position - index
  const low = saturationTable[index]!
  const high = saturationTable[index + 1]!
  const blend = (from: number, to: number): number => from + (to - from) * fraction
  return {
    temperatureC: blend(low.temperatureC, high.temperatureC),
    liquidDensityKgPerM3: blend(low.liquidDensityKgPerM3, high.liquidDensityKgPerM3),
    vapourDensityKgPerM3: blend(low.vapourDensityKgPerM3, high.vapourDensityKgPerM3),
    liquidEnthalpyKjPerKg: blend(low.liquidEnthalpyKjPerKg, high.liquidEnthalpyKjPerKg),
    vapourEnthalpyKjPerKg: blend(low.vapourEnthalpyKjPerKg, high.vapourEnthalpyKjPerKg),
  }
}

const saturationRowIndexBelow = (value: number, field: 'vapourDensityKgPerM3' | 'liquidEnthalpyKjPerKg'): number => {
  let low = 0
  let high = saturationTable.length - 1
  while (high - low > 1) {
    const middle = (low + high) >> 1
    if (saturationTable[middle]![field] <= value) low = middle
    else high = middle
  }
  return low
}

/** The saturation temperature of liquid with this enthalpy. */
const saturationTemperatureCFromLiquidEnthalpy = (enthalpyKjPerKg: number): number => {
  const last = saturationTable[saturationTable.length - 1]!
  if (enthalpyKjPerKg >= last.liquidEnthalpyKjPerKg) return last.temperatureC
  const low = saturationRowIndexBelow(enthalpyKjPerKg, 'liquidEnthalpyKjPerKg')
  const from = saturationTable[low]!
  const to = saturationTable[low + 1]!
  const fraction = Math.max(0, (enthalpyKjPerKg - from.liquidEnthalpyKjPerKg) / (to.liquidEnthalpyKjPerKg - from.liquidEnthalpyKjPerKg))
  return from.temperatureC + (to.temperatureC - from.temperatureC) * fraction
}

/** The pressure at which saturated steam has this density: the pressure of a
 * steam space in contact with boiling water. */
export const saturationPressureMPaFromVapourDensity = (densityKgPerM3: number): number => {
  if (densityKgPerM3 <= saturationTable[0]!.vapourDensityKgPerM3) {
    return tableFirstMPa * Math.max(0, densityKgPerM3) / saturationTable[0]!.vapourDensityKgPerM3
  }
  const last = saturationTable.length - 1
  if (densityKgPerM3 >= saturationTable[last]!.vapourDensityKgPerM3) return criticalPressureMPa
  const low = saturationRowIndexBelow(densityKgPerM3, 'vapourDensityKgPerM3')
  const lowDensity = saturationTable[low]!.vapourDensityKgPerM3
  const fraction = (densityKgPerM3 - lowDensity) / (saturationTable[low + 1]!.vapourDensityKgPerM3 - lowDensity)
  return Math.min(criticalPressureMPa, tableFirstMPa + (low + fraction) * tableStepMPa)
}
