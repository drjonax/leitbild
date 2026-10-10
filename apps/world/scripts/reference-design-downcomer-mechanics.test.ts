import { describe, expect, test } from 'bun:test';
import { comparison, fluids, forces, geometry, settled, shear } from './reference-design-downcomer-mechanics';

describe('offline authored downcomer mechanical selection', () => {
  test('physical geometry and laminar shear use one actual annulus', () => {
    expect(Math.PI * (geometry.ro ** 2 - geometry.ri ** 2) * geometry.length).toBeCloseTo(20, 12);
    expect(geometry.dh).toBeCloseTo(2 * (geometry.ro - geometry.ri), 12);
    for (const f of fluids) {
      expect(shear(0, f.rhoL, f.muL, geometry.dh)).toBe(0);
      const u = f.muL / (f.rhoL * geometry.dh); // Re=1: original laminar convention, not a source-string test.
      expect(shear(u, f.rhoL, f.muL, geometry.dh) / (12 * f.muL * u / geometry.dh)).toBeCloseTo(1, 12);
      expect(shear(-u, f.rhoL, f.muL, geometry.dh)).toBe(-shear(u, f.rhoL, f.muL, geometry.dh));
    }
    expect(() => forces(-.1, 0, 0, 0, fluids[0]!)).toThrow();
    expect(() => shear(1, 1, 1, 0)).toThrow();
  });

  test('all velocity signs retain equal/opposite interface work and positive dissipation', () => {
    for (const f of fluids) for (const alpha of [.01, .2, .7, .95, .999]) for (const [ul, uv] of [[0, 0], [1, 2], [-1, 2], [1, -2], [-1, -2]]) {
      const x = forces(alpha, ul!, uv!, 3000, f);
      expect(x.liquidInterfaceWork + x.vaporInterfaceWork).toBe(0);
      expect(x.liquidHeat).toBeGreaterThanOrEqual(0);
      expect(x.vaporHeat).toBeGreaterThanOrEqual(0);
      const kineticPower = x.forceL * ul! + x.forceV * uv!;
      const externalPower = x.externalL * ul! + x.externalV * uv!;
      expect(Math.abs(kineticPower + x.liquidHeat + x.vaporHeat - externalPower)).toBeLessThan(1e-8);
    }
  });

  test('phase disappearance approaches the same sole-phase mechanics without void floors', () => {
    for (const f of fluids) {
      const liquid = settled(0, 2000, f), vapor = settled(1, 2000, f);
      for (const scale of [.5, 1, 2]) {
        const nearL = settled(1e-8, 2000, f, scale), nearV = settled(1 - 1e-8, 2000, f, scale);
        expect(Math.abs(nearL.massL / liquid.massL - 1)).toBeLessThan(3e-8);
        expect(Math.abs(nearV.massV / vapor.massV - 1)).toBeLessThan(2e-6);
        expect(Math.abs(nearL.massV)).toBeLessThan(1e-5);
        expect(Math.abs(nearV.massL)).toBeLessThan(1e-8);
        expect(Math.abs(nearL.uv - nearL.ul)).toBeLessThan(1e-10);
      }
      expect(forces(0, liquid.ul, 0, 2000, f).inter).toBe(0);
      expect(forces(1, 0, vapor.uv, 2000, f).inter).toBe(0);
    }
  });

  test('bounded mechanical pulse closes work and retains finite momentum history', () => {
    const r = comparison();
    expect(r.assemblyClearance.count).toBe(193);
    expect(r.assemblyClearance.radialClearance).toBeGreaterThan(.076);
    expect(Math.abs(r.laminarCurvature.relativeError)).toBeLessThan(.0003);
    for (const s of r.steady) { expect(s.forceResidual).toBeLessThan(1e-7); expect(s.dissipation).toBeGreaterThanOrEqual(0); }
    for (const p of r.pulses) {
      expect(Math.abs(p.energyResidual)).toBeLessThan(1e-6);
      expect(p.heatL).toBeGreaterThan(0); expect(p.heatV).toBeGreaterThan(0);
      expect(p.samples[0]!.ul).toBeLessThan(0); expect(p.samples[0]!.quasiUl).toBeGreaterThan(0);
    }
    for (const f of fluids) {
      const coarse = r.pulses.find(p => p.p === f.p && p.dt === .002)!;
      const fine = r.pulses.find(p => p.p === f.p && p.dt === .001)!;
      expect(Math.abs(coarse.samples.at(-1)!.ul - fine.samples.at(-1)!.ul)).toBeLessThan(.0001);
      expect(Math.abs(coarse.samples.at(-1)!.uv - fine.samples.at(-1)!.uv)).toBeLessThan(.001);
    }
  });
});
