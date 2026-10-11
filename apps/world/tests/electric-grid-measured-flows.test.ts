import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { norwayGridModelRef } from '../src/packs/electric-grid/definition-refs.ts'
import { gridOperatingPointDemand } from '../src/packs/electric-grid/definitions.ts'
import { compileGridModelV2 } from '../src/packs/electric-grid/models/compile-v2.ts'
import { validateGridModel } from '../src/packs/electric-grid/schemas/grid-model.ts'
import { gridOperatingPointTargetsForModel, validateGridOperatingPoint } from '../src/packs/electric-grid/schemas/grid-operating-point.ts'
import { solveV2PowerFlow } from './fixtures/electric-grid/v2-power-flow.ts'

// Realism gate: the Norway model's AC load flow at each Operating Point against what was measured in
// that hour (tests/fixtures/electric-grid/norway-measured-exchange.json: Svenska kraftnät, Energy-Charts,
// Elhub and Statnett's ENTSO-E flows, each with URL, retrieval time and SHA-256):
// - HVDC transfer per neighbour, AC flow on each Norway–Sweden/Finland border and, where published, on
//   each internal price-area border;
// - each price area's net position (its exports, HVDC included);
// - each price area's hydro and wind production and the national production.
// A model value passes within its tolerance. A value outside it must be a known gap below, with the
// reason; the gap's bound ratchets: it fails when the gap grows beyond it, and when the gap closes
// (then delete the entry). Never widen a tolerance or a bound to pass a model.

const exportFlowSchema = z.object({
  mw: z.number(),
  quarterHoursMw: z.array(z.number()).length(4),
  source: z.string(),
}).strict()
const areaIds = ['NO1', 'NO2', 'NO3', 'NO4', 'NO5'] as const
type AreaId = (typeof areaIds)[number]
const hourSchema = z.object({
  operatingPointId: z.string(),
  startUtc: z.string(),
  acBorders: z.array(exportFlowSchema.extend({ from: z.enum(areaIds), to: z.string() }).strict()),
  swedenTotal: exportFlowSchema,
  hvdc: z.array(exportFlowSchema.extend({ to: z.enum(['DK1', 'DE', 'NL', 'GB']) }).strict()),
  areas: z.record(z.enum(areaIds), z.object({
    productionMw: z.object({ hydro: z.number(), wind: z.number(), thermal: z.number(), solar: z.number(), other: z.number() }).strict(),
    consumptionMw: z.number(),
  }).strict()),
}).strict()
const measuredSchema = z.object({
  schema: z.literal('leitbild.electric-grid.norway-measured-exchange'),
  curatedAt: z.string(),
  note: z.string(),
  sources: z.array(z.object({
    id: z.string(),
    title: z.string(),
    publisher: z.string(),
    url: z.string().url(),
    licence: z.enum(['cc-by-4.0', 'not-stated']),
    licenceNote: z.string().optional(),
    attribution: z.string(),
    retrievals: z.array(z.object({ url: z.string().url(), retrievedAt: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).min(1),
  }).strict()),
  hours: z.object({ winterPeak: hourSchema, summerLow: hourSchema }).strict(),
}).strict()

/** HVDC: 25 MW or 3 %. Energy-Charts and Statnett report NordLink at 1,404 and 1,447 MW in the winter hour (3 %); the Operating Point caps NordLink at its 1,400 MW rating. */
const hvdcTolerance = (measuredMw: number): number => Math.max(25, 0.03 * Math.abs(measuredMw))
/**
 * AC border flows and measured net positions: 75 MW or 10 %. 75 MW lies below the standard deviation
 * of the hour's four quarter-hours on the largest AC border (NO1→SE3: 120 MW winter, 78 MW summer), so
 * a quasi-steady model of the hourly mean is held to it; 10 % covers the sub-132 kV losses (5–7 % of
 * demand) that move every area balance and that the model does not carry.
 */
const flowTolerance = (measuredMw: number): number => Math.max(75, 0.1 * Math.abs(measuredMw))
/**
 * Winter net positions are estimated, not measured: Elhub production less consumption less the hour's
 * unmetered losses shared by consumption (no internal flow is published for the winter hour). The
 * same estimate reproduces summer's flow-derived net positions within 50 MW (asserted below); winter's
 * unmetered losses are 2.8 times summer's, so 125 MW is added to the flow tolerance.
 */
const estimatedNetTolerance = (measuredMw: number): number => flowTolerance(measuredMw) + 125
/** Production per area and kind: 100 MW or 10 %, as for flows; Elhub meters plants the model aggregates or dropped (76 MW nationally). */
const productionTolerance = (measuredMw: number): number => Math.max(100, 0.1 * Math.abs(measuredMw))
/** National production: 2 %. Elhub's and Energy-Charts' national totals differ by 0.5 % in the winter hour (26,604 and 26,477 MW) and by 2.6 % on the summer night, for which Energy-Charts publishes no pumped storage. */
const nationalTolerance = (measuredMw: number): number => 0.02 * Math.abs(measuredMw)

interface KnownGap {
  /** Largest |model − measured| this gap may reach, MW: the measured gap rounded up to 25 MW. */
  readonly boundMw: number
  readonly reason: string
}
const exchangeByParticipation = 'the Operating Point gives the Nordic exchange as one national schedule that the model splits over the ties by the inertia participation shares (SE3 88.1 %, SE2 5.4 %, SE1 5.2 %, FI 1.3 %), not by the measured border flows'
const uniformStorageHydro = 'the Operating Point dispatches storage hydro at one national loading (run-of-river and wind by national capacity share), not at the measured production of each price area (Elhub PRODUCTION_PER_GROUP_MBA_HOUR)'
const unmodelledLosses = 'the model\'s demand is Elhub\'s metered consumption without the losses of the networks below 132 kV, so national production falls short of the measured by those losses less the model\'s own branch losses'
const knownGaps: Readonly<Record<string, KnownGap>> = {
  // Cross-border AC ties.
  'winterPeak border NO1→SE3': { boundMw: 250, reason: exchangeByParticipation },
  'winterPeak border NO3→SE2': { boundMw: 100, reason: exchangeByParticipation },
  'winterPeak border NO4→SE1': { boundMw: 100, reason: exchangeByParticipation },
  'summerLow border NO1→SE3': { boundMw: 300, reason: exchangeByParticipation },
  'summerLow border NO4→SE1': { boundMw: 300, reason: `${exchangeByParticipation}: the measured 255 MW export to SE1 becomes a 42 MW import` },
  // Internal borders (summer, the only hour with published internal flows).
  'summerLow border NO1→NO2': { boundMw: 500, reason: `${uniformStorageHydro}: NO2 generates about 900 MW too much and NO4 about 800 MW too little` },
  'summerLow border NO1→NO3': { boundMw: 100, reason: `${uniformStorageHydro}; with per-area dispatch and per-border exchange the remaining 110 MW is a loop flow around NO1–NO3–NO5` },
  'summerLow border NO2→NO5': { boundMw: 400, reason: `${uniformStorageHydro}; with per-area dispatch and per-border exchange about 250 MW of NO5's export still takes NO5→NO1→NO2 instead of NO5→NO2` },
  'summerLow border NO3→NO4': { boundMw: 475, reason: `${uniformStorageHydro}: NO4 exports 457 MW south instead of the measured 926 MW` },
  'summerLow border NO3→NO5': { boundMw: 375, reason: `${uniformStorageHydro}: the flow runs NO5→NO3 instead of the measured NO3→NO5` },
  // Net positions.
  'winterPeak net NO2': { boundMw: 850, reason: uniformStorageHydro },
  'winterPeak net NO3': { boundMw: 500, reason: uniformStorageHydro },
  'summerLow net NO1': { boundMw: 175, reason: uniformStorageHydro },
  'summerLow net NO2': { boundMw: 900, reason: uniformStorageHydro },
  'summerLow net NO3': { boundMw: 100, reason: uniformStorageHydro },
  'summerLow net NO4': { boundMw: 825, reason: uniformStorageHydro },
  // Production by area and kind.
  'winterPeak hydro NO1': { boundMw: 325, reason: `${uniformStorageHydro}; ${unmodelledLosses}` },
  'winterPeak hydro NO2': { boundMw: 925, reason: `${uniformStorageHydro}; ${unmodelledLosses}` },
  'winterPeak hydro NO3': { boundMw: 375, reason: uniformStorageHydro },
  'winterPeak wind NO1': { boundMw: 175, reason: 'wind is shared by national capacity; NO1\'s farms produced 93 MW where their share gives 252 MW' },
  'winterPeak wind NO4': { boundMw: 150, reason: 'wind is shared by national capacity; NO4\'s farms produced 894 MW where their share gives 760 MW' },
  'summerLow hydro NO2': { boundMw: 725, reason: uniformStorageHydro },
  'summerLow hydro NO4': { boundMw: 850, reason: uniformStorageHydro },
  'summerLow wind NO1': { boundMw: 175, reason: 'wind is shared by national capacity; NO1\'s farms produced 197 MW where their share gives 33 MW' },
  'winterPeak national production': { boundMw: 900, reason: unmodelledLosses },
  'summerLow national production': { boundMw: 450, reason: unmodelledLosses },
}

interface Comparison {
  readonly key: string
  readonly modelMw: number
  readonly measuredMw: number
  readonly toleranceMw: number
}

const models = join(import.meta.dir, '../src/packs/electric-grid/models')
const loadJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8')) as unknown
const model = validateGridModel(await loadJson(join(models, 'norway-transmission.grid-model.json')), 'norway-transmission.grid-model.json')
const measured = measuredSchema.parse(await loadJson(join(import.meta.dir, 'fixtures/electric-grid/norway-measured-exchange.json')))
const targets = gridOperatingPointTargetsForModel(model)
const busArea = new Map(model.buses.map(bus => [bus.id, bus.priceArea ?? bus.externalArea]))
const areaOfBus = (busId: string): string => {
  const area = busArea.get(busId)
  if (area === undefined) throw new Error(`${busId} has neither a price area nor an external area`)
  return area
}
const isNorwegian = (area: string): area is AreaId => (areaIds as ReadonlyArray<string>).includes(area)
const operatingPointFiles: Readonly<Record<string, string>> = {
  'electric-grid.norway.winter-weekday-peak': 'norway-winter-weekday-peak.operating-point.json',
  'electric-grid.norway.summer-night-low': 'norway-summer-night-low.operating-point.json',
}

/** The model's hour: AC flow between each pair of areas (mean of the two branch ends), HVDC export per neighbour, and per area net position, load, losses and wind. */
const modelHour = async (operatingPointId: string) => {
  const file = operatingPointFiles[operatingPointId]
  if (file === undefined) throw new Error(`no Operating Point file for ${operatingPointId}`)
  const operatingPoint = validateGridOperatingPoint(await loadJson(join(models, file)), file, targets)
  const demand = gridOperatingPointDemand(operatingPoint.id, norwayGridModelRef)
  const flow = solveV2PowerFlow(model, operatingPoint, demand, { tolerancePu: 1e-6, maximumIterations: 100 })
  const unconverged = flow.islands.filter(island => !island.outcome.converged)
  if (unconverged.length > 0) throw new Error(`${operatingPoint.id}: ${unconverged.length} islands did not converge`)
  const between = new Map<string, number>()
  const net = new Map<string, number>(areaIds.map(area => [area, 0]))
  const losses = new Map<string, number>(areaIds.map(area => [area, 0]))
  flow.branches.forEach((branch, index) => {
    const fromMw = flow.state.branchFromActiveMw[index]!
    const toMw = flow.state.branchToActiveMw[index]!
    const from = areaOfBus(branch.fromBusId)
    const to = areaOfBus(branch.toBusId)
    for (const area of [from, to]) if (isNorwegian(area)) losses.set(area, losses.get(area)! + (fromMw + toMw) / 2)
    if (from === to) return
    const mw = (fromMw - toMw) / 2
    between.set(`${from}>${to}`, (between.get(`${from}>${to}`) ?? 0) + mw)
    between.set(`${to}>${from}`, (between.get(`${to}>${from}`) ?? 0) - mw)
    if (isNorwegian(from)) net.set(from, net.get(from)! + mw)
    if (isNorwegian(to)) net.set(to, net.get(to)! - mw)
  })
  const hvdcExport = new Map<string, number>()
  for (const schedule of operatingPoint.hvdcSchedules ?? []) {
    const link = model.hvdcLinks.find(candidate => candidate.id === schedule.assetId)
    if (link === undefined || schedule.points.length !== 1) throw new Error(`${operatingPoint.id}: ${schedule.assetId} is not a constant schedule of a model link`)
    const transferMw = schedule.points[0]!.transferMw
    const neighbour = areaOfBus(link.toBusId)
    hvdcExport.set(neighbour, (hvdcExport.get(neighbour) ?? 0) + transferMw)
    const area = areaOfBus(link.fromBusId)
    net.set(area, net.get(area)! + transferMw)
  }
  const load = new Map<string, number>(areaIds.map(area => [area, 0]))
  for (const entry of compileGridModelV2(model, operatingPoint, demand).model.loads) {
    const area = areaOfBus(entry.busId)
    load.set(area, load.get(area)! + entry.demandMw)
  }
  const states = new Map((operatingPoint.generatorStates ?? []).map(state => [state.assetId, state]))
  const fixedByKind = new Map<string, number>()
  for (const generator of model.generators) {
    const state = states.get(generator.id)
    if (state?.state !== 'online' || state.targetMw === undefined) continue
    // Only storage hydro takes the slack (v2-power-flow.ts); every other unit holds its target.
    if (generator.kind === 'hydro-reservoir' || generator.kind === 'hydro-pumped') continue
    const kind = generator.kind === 'wind' ? 'wind' : generator.kind === 'thermal' ? 'thermal' : 'hydro'
    const key = `${generator.priceArea} ${kind}`
    fixedByKind.set(key, (fixedByKind.get(key) ?? 0) + state.targetMw)
  }
  /** Area production: net position plus load plus the area's share of branch losses; hydro is what wind and thermal leave. */
  const production = (area: AreaId): number => net.get(area)! + load.get(area)! + losses.get(area)!
  const kindProduction = (area: AreaId, kind: 'hydro' | 'wind'): number => {
    const wind = fixedByKind.get(`${area} wind`) ?? 0
    return kind === 'wind' ? wind : production(area) - wind - (fixedByKind.get(`${area} thermal`) ?? 0)
  }
  return { between, net, hvdcExport, production, kindProduction }
}

type MeasuredHour = z.infer<typeof hourSchema>
const measuredNationalExportMw = (hour: MeasuredHour): number => hour.acBorders.filter(border => border.to === 'FI').reduce((sum, border) => sum + border.mw, 0)
  + hour.swedenTotal.mw + hour.hvdc.reduce((sum, link) => sum + link.mw, 0)
/** Net positions estimated from Elhub: production − consumption − the hour's unmetered losses shared by consumption. */
const estimatedNetPositions = (hour: MeasuredHour): Map<AreaId, number> => {
  const produced = (area: AreaId): number => Object.values(hour.areas[area]!.productionMw).reduce((sum, value) => sum + value, 0)
  const totalProduction = areaIds.reduce((sum, area) => sum + produced(area), 0)
  const totalConsumption = areaIds.reduce((sum, area) => sum + hour.areas[area]!.consumptionMw, 0)
  const lossesMw = totalProduction - totalConsumption - measuredNationalExportMw(hour)
  return new Map(areaIds.map(area => [area, produced(area) - hour.areas[area]!.consumptionMw - lossesMw * hour.areas[area]!.consumptionMw / totalConsumption]))
}
/** Net positions from the measured flows, where every border of the area is published. */
const flowNetPositions = (hour: MeasuredHour): Map<AreaId, number> | null => {
  const net = new Map<AreaId, number>(areaIds.map(area => [area, 0]))
  for (const border of hour.acBorders) {
    net.set(border.from, net.get(border.from)! + border.mw)
    if (isNorwegian(border.to)) net.set(border.to, net.get(border.to)! - border.mw)
  }
  const internal = hour.acBorders.filter(border => isNorwegian(border.to)).length
  // NO1–NO2, NO1–NO3, NO1–NO5, NO2–NO5, NO3–NO4 and NO3–NO5: Norway's six internal borders.
  if (internal === 0) return null
  if (internal !== 6) throw new Error(`expected all six internal borders or none, got ${internal}`)
  net.set('NO2', net.get('NO2')! + hour.hvdc.reduce((sum, link) => sum + link.mw, 0))
  return net
}

const comparisonsFor = async (name: 'winterPeak' | 'summerLow'): Promise<ReadonlyArray<Comparison>> => {
  const hour = measured.hours[name]
  const modelled = await modelHour(hour.operatingPointId)
  const rows: Comparison[] = []
  for (const link of hour.hvdc) rows.push({ key: `${name} hvdc NO2→${link.to}`, modelMw: modelled.hvdcExport.get(link.to) ?? 0, measuredMw: link.mw, toleranceMw: hvdcTolerance(link.mw) })
  for (const border of hour.acBorders) {
    const modelMw = modelled.between.get(`${border.from}>${border.to}`)
    if (modelMw === undefined) throw new Error(`the model has no branch between ${border.from} and ${border.to}`)
    rows.push({ key: `${name} border ${border.from}→${border.to}`, modelMw, measuredMw: border.mw, toleranceMw: flowTolerance(border.mw) })
  }
  const measuredNet = flowNetPositions(hour)
  const estimatedNet = estimatedNetPositions(hour)
  for (const area of areaIds) {
    const measuredMw = measuredNet?.get(area) ?? estimatedNet.get(area)!
    rows.push({ key: `${name} net ${area}`, modelMw: modelled.net.get(area)!, measuredMw, toleranceMw: measuredNet === null ? estimatedNetTolerance(measuredMw) : flowTolerance(measuredMw) })
  }
  for (const area of areaIds) {
    for (const kind of ['hydro', 'wind'] as const) {
      const measuredMw = hour.areas[area]!.productionMw[kind]
      rows.push({ key: `${name} ${kind} ${area}`, modelMw: modelled.kindProduction(area, kind), measuredMw, toleranceMw: productionTolerance(measuredMw) })
    }
  }
  const nationalMw = areaIds.reduce((sum, area) => sum + Object.values(hour.areas[area]!.productionMw).reduce((total, value) => total + value, 0), 0)
  rows.push({ key: `${name} national production`, modelMw: areaIds.reduce((sum, area) => sum + modelled.production(area), 0), measuredMw: nationalMw, toleranceMw: nationalTolerance(nationalMw) })
  return rows
}

const verdict = (row: Comparison): string | null => {
  const gapMw = Math.abs(row.modelMw - row.measuredMw)
  const known = knownGaps[row.key]
  const within = gapMw <= row.toleranceMw
  const values = `model ${row.modelMw.toFixed(1)} MW, measured ${row.measuredMw.toFixed(1)} MW, tolerance ${row.toleranceMw.toFixed(0)} MW`
  if (known === undefined) return within ? null : `${row.key}: ${values}`
  if (within) return `${row.key} is a known gap but now within tolerance (${values}): delete its knownGaps entry`
  return gapMw <= known.boundMw ? null : `${row.key}: the known gap grew to ${gapMw.toFixed(0)} MW beyond its ${known.boundMw} MW bound (${values})`
}

describe('the Norway model against the measured exchange of its Operating Point hours', () => {
  test('cites every measured value to a recorded source', () => {
    const sources = new Set(measured.sources.map(source => source.id))
    const cited = Object.values(measured.hours).flatMap(hour => [...hour.acBorders, ...hour.hvdc, hour.swedenTotal].map(entry => entry.source))
    expect(cited.filter(source => !sources.has(source))).toEqual([])
    for (const source of measured.sources) expect(source.licence === 'not-stated' ? source.licenceNote !== undefined : true).toBe(true)
  })

  test('the measured hours close: the Swedish borders sum to the Swedish total, and the Elhub estimate of net positions matches the summer flows', () => {
    for (const hour of Object.values(measured.hours)) {
      const borders = hour.acBorders.filter(border => border.to.startsWith('SE')).reduce((sum, border) => sum + border.mw, 0)
      // Svenska kraftnät and Energy-Charts (ENTSO-E) meter the same ties: they agree within 3 MW.
      expect(Math.abs(borders - hour.swedenTotal.mw)).toBeLessThan(3)
    }
    const flowNet = flowNetPositions(measured.hours.summerLow)!
    const estimated = estimatedNetPositions(measured.hours.summerLow)
    expect(areaIds.filter(area => Math.abs(flowNet.get(area)! - estimated.get(area)!) > 50)).toEqual([])
  })

  for (const name of ['winterPeak', 'summerLow'] as const) {
    test(`${name}: flows, net positions and production are within tolerance or a bounded known gap`, async () => {
      const rows = await comparisonsFor(name)
      console.info(`${name} model vs measured:\n${rows.map(row => `  ${row.key.padEnd(36)} model ${row.modelMw.toFixed(0).padStart(6)}  measured ${row.measuredMw.toFixed(0).padStart(6)}  Δ ${(row.modelMw - row.measuredMw).toFixed(0).padStart(6)}  tol ${row.toleranceMw.toFixed(0)}${knownGaps[row.key] === undefined ? '' : '  known gap'}`).join('\n')}`)
      expect(rows.flatMap(row => verdict(row) ?? [])).toEqual([])
      const keys = new Set(rows.map(row => row.key))
      expect(Object.keys(knownGaps).filter(key => key.startsWith(`${name} `) && !keys.has(key))).toEqual([])
    })
  }
})
