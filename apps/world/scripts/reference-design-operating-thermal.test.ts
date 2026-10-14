import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFuelConstruction } from './reference-design-fuel-construction'
import { parseFuelHandling } from './reference-design-fuel-handling'
import { parseControlAbsorber } from './reference-design-control-absorber'
import { parseTransferThermal } from './reference-design-fuel-transfer-thermal'
import { parseOperatingFuelGap } from './reference-design-fuel-cooling'
import { prepareOperatingHot } from './reference-design-operating-hot'
import { compileOperatingThermal, parseOperatingThermal } from './reference-design-operating-thermal'

test('thermal selection is explicit, singular and strict; no legacy coefficients', () => {
  const block = (value: unknown) => '```reference-operating-thermal\n' + JSON.stringify(value) + '\n```'
  const coefficients = { identity: 'LD01-HOT-THERMAL-1' as const, guideEmissivity: .7, sgThermalDiameter_m: .019 }
  expect(parseOperatingThermal(block(coefficients))).toEqual(coefficients)
  expect(() => parseOperatingThermal(block(coefficients) + '\n' + block(coefficients))).toThrow()
  expect(() => parseOperatingThermal(block({ ...coefficients, guideEmissivity: 2 }))).toThrow()
  expect(() => parseOperatingThermal(block({ ...coefficients, fuelEmissivity: .8 }))).toThrow()
  expect(() => parseOperatingThermal('')).toThrow()
})

const wiki = process.env.LD01_WIKI_ROOT, if97 = process.env.LD01_IF97_DIRECTORY
test.skipIf(!wiki || !if97)('actual thermal recipients/calorics compile once; corrupted joins fail', async () => {
  const base = join(wiki!, 'world/packs/process-plant/reference-designs/ld-01'),
    read = (name: string) => Bun.file(join(base, name)).text(),
    [hot, fuelDoc, handlingDoc, controlDoc, thermalDoc, gapDoc] = await Promise.all([
      prepareOperatingHot(wiki!, if97!, { kind: 'provisional' }), read('systems/reactor/fuel-construction.md'),
      read('systems/reactor/fuel-handling-and-pool.md'), read('systems/reactor/control-absorber-and-guide-water.md'),
      read('model/operating-thermal.md'), read('systems/reactor/phase-dependent-heat-transfer.md')]),
    fuel = parseFuelConstruction(fuelDoc), handling = parseFuelHandling(handlingDoc), control = parseControlAbsorber(controlDoc),
    thermal = parseOperatingThermal(thermalDoc), passive = parseTransferThermal(handlingDoc), gap = parseOperatingFuelGap(gapDoc),
    compile = (fluid = hot.fluid, energy = hot.energy) => compileOperatingThermal(fuel, handling, control, fluid, energy, thermal, passive, gap),
    packet = compile(), sum = (v: number[]) => v.reduce((a, b) => a + b, 0)
  expect(packet.fuel_bands).toHaveLength(386); expect(packet.helium).toHaveLength(193)
  expect(packet.passive_stores).toHaveLength(1351); expect(packet.sg_segments).toHaveLength(8)
  expect(packet.core_contacts).toHaveLength(448); expect(packet.plenum_contacts).toHaveLength(193)
  expect(packet.surface_algebraic_count).toBe(1158)
  expect(sum(packet.fuel_bands.flatMap(b => b.source_w)) + sum(packet.direct_water_source_w)).toBeCloseTo(hot.totalCurrentHeat_W, 3)
  expect(packet.passive_stores.every(s => s.mass_kg > 0)).toBe(true)
  expect(packet.passive_contacts.some(c => c.surface === 'fitting')).toBe(true)
  for (const change of [
    (v: typeof hot.fluid) => { v.geometry.materialContacts[0]!.cladArea_m2 = 0 },
    (v: typeof hot.fluid) => { v.materials.solidStores = v.materials.solidStores.filter(s => !s.id.endsWith('/helium')) },
    (v: typeof hot.fluid) => { v.materials.preparedCarriers[0]!.id = 'missing-event-owner' },
    (v: typeof hot.fluid) => { v.materials.solidStores[0]!.energy_J *= 2 },
  ]) { const value = structuredClone(hot.fluid); change(value); expect(() => compile(value)).toThrow() }
  const wrong = structuredClone(hot.energy); wrong.carriers[0]!.fuel_W *= 2
  expect(() => compile(hot.fluid, wrong)).toThrow()
  // Native opt-in test executable built explicitly with maintained properties.
  // Ordinary application tests never invoke Cargo or require property sources.
  const native = process.env.LD01_OPERATING_THERMAL_TEST
  if (native) {
    const temporary = await mkdtemp(join(tmpdir(), 'ld01-actual-thermal-'))
    try {
      const path = join(temporary, 'packet.json'); await Bun.write(path, JSON.stringify(packet))
      const child = Bun.spawn([native, '--ignored', '--nocapture'], {
        env: { ...process.env, LD01_OPERATING_THERMAL_PACKET: path }, stdout: 'pipe', stderr: 'pipe' }),
        [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      if (code !== 0) throw Error(error + output)
      expect(output).toContain('2 passed'); console.log(error.trim())
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }
}, 20000)
