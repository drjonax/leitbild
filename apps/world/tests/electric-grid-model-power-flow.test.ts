import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { norwayGridModelRef } from '../src/packs/electric-grid/definition-refs.ts'
import { gridOperatingPointDemand } from '../src/packs/electric-grid/definitions.ts'
import { gridGoldenSchema } from '../src/packs/electric-grid/schemas/grid-golden.ts'
import { validateGridModel } from '../src/packs/electric-grid/schemas/grid-model.ts'
import { gridOperatingPointTargetsForModel, validateGridOperatingPoint } from '../src/packs/electric-grid/schemas/grid-operating-point.ts'
import { branchLoadingMva, solveV2PowerFlow } from './fixtures/electric-grid/v2-power-flow.ts'

// Gate for the committed generated Norway model: at each committed Operating Point the AC load flow
// of every energised island converges, every bus voltage stays within the golden band, no branch
// exceeds its emergency rating, and a branch above its continuous rating is one the golden list
// explains (powerFlowOverloads) and still overloads. Ratings are the model's at the Operating
// Point's branch availability.

const models = join(import.meta.dir, '../src/packs/electric-grid/models')
const load = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(models, name), 'utf8')) as unknown
const model = validateGridModel(await load('norway-transmission.grid-model.json'), 'norway-transmission.grid-model.json')
const golden = gridGoldenSchema.parse(await load('norway-grid-golden.json'))
const targets = gridOperatingPointTargetsForModel(model)
const { minBusVoltagePu, maxBusVoltagePu } = golden.thresholds

/** Largest admissible |ΔP| and |ΔQ|, pu on 100 MVA (0.1 kW), and full iterations per inner solve. */
const solveOptions = { tolerancePu: 1e-6, maximumIterations: 100 }

for (const file of ['norway-winter-weekday-peak.operating-point.json', 'norway-summer-night-low.operating-point.json']) {
  const operatingPoint = validateGridOperatingPoint(await load(file), file, targets)
  const flow = solveV2PowerFlow(model, operatingPoint, gridOperatingPointDemand(operatingPoint.id, norwayGridModelRef), solveOptions)
  const rows = flow.branches.map((branch, index) => ({ branch, mva: branchLoadingMva(flow, index), ...flow.ratings[index]! }))
  const explained = new Map(golden.powerFlowOverloads.filter(entry => entry.operatingPointId === operatingPoint.id).map(entry => [entry.branchId, entry]))

  describe(`AC load flow of the Norway model at ${operatingPoint.id}`, () => {
    test('converges in every energised island and solves the runtime mapping\'s demand', () => {
      expect(flow.islands.length).toBeGreaterThan(0)
      expect(flow.islands.filter(island => !island.outcome.converged).map(island => island.outcome.converged ? '' : `${island.islandId}: ${island.outcome.reason} ${island.outcome.detail}`)).toEqual([])
      expect(Math.abs(flow.solvedDemandMw - flow.compiledDemandMw)).toBeLessThan(1e-6)
    })

    test(`holds every bus within ${minBusVoltagePu}–${maxBusVoltagePu} pu`, () => {
      const energised = new Set(flow.islands.flatMap(island => island.busIds))
      const outside = model.buses.flatMap(bus => {
        if (!energised.has(bus.id)) return []
        const voltage = flow.state.voltagePu[flow.busIndex.get(bus.id)!]!
        return voltage >= minBusVoltagePu && voltage <= maxBusVoltagePu ? [] : [`${bus.label} ${voltage.toFixed(3)} pu`]
      })
      expect(outside).toEqual([])
    })

    test('loads no branch above its emergency rating', () => {
      expect(rows.filter(row => row.mva > row.emergencyMva).map(row => `${row.branch.label} ${Math.round(row.mva)}/${Math.round(row.emergencyMva)} MVA`)).toEqual([])
    })

    test('overloads a branch above its continuous rating only where the golden list explains it', () => {
      const overloaded = rows.filter(row => row.mva > row.continuousMva)
      expect(overloaded.flatMap(row => {
        const entry = explained.get(row.branch.id)
        const loading = row.mva / row.continuousMva
        return entry !== undefined && loading <= entry.maxLoading ? [] : [`${row.branch.id} ${row.branch.label} at ${loading.toFixed(3)} of ${Math.round(row.continuousMva)} MVA`]
      })).toEqual([])
      const stale = [...explained.keys()].filter(branchId => !overloaded.some(row => row.branch.id === branchId))
      expect(stale).toEqual([])
    })
  })
}
