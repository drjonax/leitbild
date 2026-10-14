import { expect, test } from 'bun:test'
import { prepareOperatingHot } from './reference-design-operating-hot'

// Deliberately explicit: ordinary app tests have no Cargo/compiler/property
// dependency. The documented native check supplies all three acquired inputs.
const wiki = process.env.LD01_WIKI_ROOT, if97 = process.env.LD01_IF97_DIRECTORY,
  executable = process.env.LD01_OPERATING_PREPARATION

test.skipIf(!wiki || !if97 || !executable)('same current owner package passes native equations; corrupted joins fail', async () => {
  const data = await prepareOperatingHot(wiki!, if97!, { kind: 'provisional' }),
    run = async (value: unknown) => {
      const child = Bun.spawn([executable!], { stdin: new Blob([JSON.stringify(value)]), stdout: 'pipe', stderr: 'pipe' }),
        [out, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      return { status, error, result: out ? JSON.parse(out) : undefined }
    }, actual = await run(data.nativeInput)
  expect(actual.status).toBe(0)
  expect(actual.result.source_states).toBe(2340)
  expect(actual.result.material_energy_stores).toBe(9650)
  expect(actual.result.finite_solid_stores).toBe(2710)
  expect(Math.abs(actual.result.event_energy_balance_w) / data.totalCurrentHeat_W).toBeLessThan(1e-12)
  expect(Math.abs(actual.result.partial_pressure_constraint_defect_kg_s)).toBeLessThan(1e-8)
  expect(data.directCoolantPressurePreparation.donorBranchConsistent).toBe(true)
  const original = JSON.stringify(data.nativeInput)
  const corrupt = async (change: (value: typeof data.nativeInput) => void, error: string) => {
    const value = structuredClone(data.nativeInput)
    change(value)
    const result = await run(value)
    expect(result.status).not.toBe(0); expect(result.error).toContain(error)
    expect(JSON.stringify(data.nativeInput)).toBe(original)
  }
  await corrupt(d => { d.energy.carriers[0]!.spent_fissions = -1 }, 'fission donor')
  await corrupt(d => { d.energy.carriers[1]!.id = d.energy.carriers[0]!.id }, 'Duplicated material')
  await corrupt(d => { d.energy.carriers[0]!.expected_fuel_w *= 2 }, 'heat recipients')
  await corrupt(d => { d.energy.carriers[0]!.fuel_node_fractions = [1, 1] }, 'allocation')
  await corrupt(d => { d.fluid.regions[1]!.id = d.fluid.regions[0]!.id }, 'duplicate primary')
  await corrupt(d => { d.fluid.solid_stores = d.fluid.solid_stores.filter(s => s.id !== d.energy.carriers[0]!.fuel_store_ids[0]) }, 'finite fuel/clad')
  await corrupt(d => { d.fluid.direct_coolant_projection.heat_w[0]! += 1e6 }, 'actual direct coolant')
  await corrupt(d => { d.source.exposure_per_population_s_m2[0]! *= -1 }, 'exposure support')
  const unknown = await run({ ...data.nativeInput, legacyCaptureRatio: .8 })
  expect(unknown.status).not.toBe(0); expect(unknown.error).toContain('unknown field')
}, 20000)
