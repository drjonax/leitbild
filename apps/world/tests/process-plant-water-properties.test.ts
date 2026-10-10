import { describe, expect, test } from 'bun:test'
import {
  compressedWaterState,
  liquidEnthalpyKjPerKg,
  liquidTemperatureCFromEnthalpy,
  saturatedWaterSteam,
  saturationPressureMPaFromTemperatureC,
  saturationPressureMPaFromVapourDensity,
  steamState,
} from '../src/packs/process-plant/runtime/water-properties.ts'

// The IAPWS-IF97 computer-program verification values (R7-97, 2012).
const kelvin = (temperatureK: number): number => temperatureK - 273.15

describe('IAPWS-IF97 water and steam properties', () => {
  test('region 1 liquid matches table 5', () => {
    for (const [temperature, pressure, volume, enthalpy, heat] of [
      [300, 3, 0.100215168e-2, 0.115331273e3, 0.417301218e1],
      [300, 80, 0.971180894e-3, 0.184142828e3, 0.401008987e1],
      [500, 3, 0.120241800e-2, 0.975542239e3, 0.465580682e1],
    ] as const) {
      const state = compressedWaterState(kelvin(temperature), pressure)
      expect(1 / state.densityKgPerM3 / volume).toBeCloseTo(1, 8)
      expect(state.enthalpyKjPerKg / enthalpy).toBeCloseTo(1, 8)
      expect(state.specificHeatKjPerKgK / heat).toBeCloseTo(1, 8)
    }
  })

  test('liquid temperature inverts liquid enthalpy exactly and agrees with the backward equation of table 7', () => {
    // The backward equation is within 25 mK of region 1; the runtime refines it to the exact inverse.
    for (const [pressure, enthalpy, temperature] of [[3, 500, 0.391798509e3], [80, 500, 0.378108626e3], [80, 1500, 0.611041229e3]] as const) {
      expect(Math.abs(liquidTemperatureCFromEnthalpy(pressure, enthalpy) - kelvin(temperature))).toBeLessThan(0.025)
    }
    for (const [temperature, pressure] of [[50, 0.5], [288, 15.5], [323, 15.5], [344.8, 15.5]] as const) {
      expect(liquidTemperatureCFromEnthalpy(pressure, liquidEnthalpyKjPerKg(temperature, pressure))).toBeCloseTo(temperature, 6)
    }
    // Superheated liquid, about to flash, inverts along the saturation line.
    for (const [temperature, pressure] of [[300, 8], [323, 8], [352, 15.5]] as const) {
      expect(liquidTemperatureCFromEnthalpy(pressure, liquidEnthalpyKjPerKg(temperature, pressure))).toBeCloseTo(temperature, 4)
    }
  })

  test('region 2 steam matches table 15', () => {
    for (const [temperature, pressure, volume, enthalpy] of [
      [300, 0.0035, 0.394913866e2, 0.254991145e4],
      [700, 0.0035, 0.923015898e2, 0.333568375e4],
      [700, 30, 0.542946619e-2, 0.263149474e4],
    ] as const) {
      const state = steamState(kelvin(temperature), pressure)
      expect(1 / state.densityKgPerM3 / volume).toBeCloseTo(1, 8)
      expect(state.enthalpyKjPerKg / enthalpy).toBeCloseTo(1, 8)
    }
  })

  test('saturation pressure matches table 35 and the tabulated line inverts', () => {
    for (const [temperature, pressure] of [[300, 0.353658941e-2], [500, 0.263889776e1], [600, 0.123443146e2]] as const) {
      expect(saturationPressureMPaFromTemperatureC(kelvin(temperature)) / pressure).toBeCloseTo(1, 8)
    }
    // At the pressurizer's 15.5 MPa: 344.8 °C, liquid 594 and steam 102 kg/m³.
    const pressurizer = saturatedWaterSteam(15.5)
    expect(pressurizer.temperatureC).toBeCloseTo(344.79, 2)
    expect(pressurizer.liquidDensityKgPerM3).toBeCloseTo(594.4, 1)
    expect(pressurizer.vapourDensityKgPerM3).toBeCloseTo(101.92, 1)
    expect(pressurizer.vapourEnthalpyKjPerKg - pressurizer.liquidEnthalpyKjPerKg).toBeCloseTo(966.3, 0)
    for (const pressure of [0.1, 1, 7, 12.34, 15.5, 17.2]) {
      expect(saturationPressureMPaFromVapourDensity(saturatedWaterSteam(pressure).vapourDensityKgPerM3)).toBeCloseTo(pressure, 6)
    }
  })
})
