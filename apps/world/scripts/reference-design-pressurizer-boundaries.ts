/** Offline audit of a published analysis prescription, not a transient solver or measured-state reconstruction. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const finite = z.number().finite()
const positive = finite.positive()
const series = z.array(z.tuple([finite.nonnegative(), finite])).min(2).superRefine((rows, ctx) => {
  for (let i = 1; i < rows.length; i++) if (rows[i]![0] <= rows[i - 1]![0])
    ctx.addIssue({ code: 'custom', message: 'Times must strictly increase' })
})
const fraction = finite.min(0).max(1)
/** The heater's spatial placement as the deck states it: power component on its heat structure. */
const heaterShape = z.object({
  pages: z.string().min(1),
  powerComponent: positive.int(),
  heatStructure: positive.int(),
  axialCells: positive.int(),
  axialShape: z.array(finite.nonnegative()).min(2),
  radialNodes_m: z.array(positive).min(2),
  radialShape: z.array(finite.nonnegative()).min(2),
}).strict()
/** One TRACE PIPE as listed: cell arrays and edge arrays (one more edge than cells). */
const pipe = z.object({
  component: positive.int(),
  junctions: z.tuple([positive.int(), positive.int()]),
  cellLength_m: z.array(positive).min(1),
  cellVolume_m3: z.array(positive).min(1),
  edgeFlowArea_m2: z.array(positive).min(2),
  edgeFriction: z.array(finite.nonnegative()).min(2),
  edgeGrav: z.array(finite.min(-1).max(1)).min(2),
  edgeHydraulicDiameter_m: z.array(positive).min(2),
}).strict()
const surgeLine = z.object({
  pages: z.string().min(1),
  fill: z.object({
    component: positive.int(),
    junction: positive.int(),
    liquidTemperature_K: positive,
    vaporTemperature_K: positive,
    pressure_Pa: positive,
    voidFraction: fraction,
  }).strict(),
  pipes: z.array(pipe).min(1),
  initialCells: z.object({
    voidFraction: fraction,
    liquidTemperature_K: positive,
    vaporTemperature_K: positive,
    pressure_Pa: positive,
    noncondensablePressure_Pa: finite.nonnegative(),
    edgeLiquidVelocity_m_s: finite,
    edgeVaporVelocity_m_s: finite,
  }).strict(),
}).strict()
const schema = z.object({
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  height_m: positive,
  innerRadius_m: positive,
  outerRadius_m: positive,
  cellCount: positive.int(),
  cellLength_m: positive,
  cellVolume_m3: positive,
  liquidCellEquivalents: positive,
  statedLevel_m: positive,
  fluidTemperature_K: positive,
  wallTemperature_K: positive,
  ambientTemperature_K: positive,
  outerHeatTransfer_W_m2K: positive,
  surgeMassFlow_kg_s: series,
  heaterPower_W: series,
  heaterShape,
  surgeLine,
}).strict().superRefine((x, ctx) => {
  if (x.outerRadius_m <= x.innerRadius_m || x.liquidCellEquivalents >= x.cellCount)
    ctx.addIssue({ code: 'custom', message: 'Invalid shell or partially filled vessel geometry' })
  if (x.heaterPower_W.some(([, power]) => power < 0))
    ctx.addIssue({ code: 'custom', message: 'Heater power cannot be negative' })
  const h = x.heaterShape, nodes = h.radialNodes_m
  if (h.axialCells !== x.cellCount || h.axialShape.length !== h.axialCells + 1 || !h.axialShape.some(v => v > 0))
    ctx.addIssue({ code: 'custom', message: 'The axial power shape must list cellCount + 1 values, some nonzero, as the deck does' })
  if (nodes[0] !== x.innerRadius_m || nodes.at(-1) !== x.outerRadius_m || nodes.some((r, i) => i > 0 && r <= nodes[i - 1]!)
    || h.radialShape.length !== nodes.length)
    ctx.addIssue({ code: 'custom', message: 'Radial power nodes must rise from the inner to the outer shell radius, one shape value each' })
  const line = x.surgeLine
  if (line.fill.junction !== line.pipes[0]!.junctions[0])
    ctx.addIssue({ code: 'custom', message: 'The FILL junction must open the first pipe' })
  line.pipes.forEach((p, i) => {
    const cells = p.cellLength_m.length
    if (p.cellVolume_m3.length !== cells || [p.edgeFlowArea_m2, p.edgeFriction, p.edgeGrav, p.edgeHydraulicDiameter_m].some(e => e.length !== cells + 1))
      ctx.addIssue({ code: 'custom', message: `Pipe ${p.component}: cell arrays need one entry per cell and edge arrays one more` })
    const next = line.pipes[i + 1]
    if (next && p.junctions[1] !== next.junctions[0])
      ctx.addIssue({ code: 'custom', message: `Pipe ${p.component} must end at the junction where pipe ${next.component} begins` })
  })
})

export function parsePressurizerBoundaries(document: string) {
  const blocks = [...document.matchAll(/^```reference-pressurizer-boundaries\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-pressurizer-boundaries block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

/** Integrate linear segments, splitting at zero so opposing amounts never cancel prematurely. */
export function integrateSignedSchedule(value: unknown) {
  const rows = series.parse(value)
  let incoming = 0, outgoing = 0
  for (let i = 1; i < rows.length; i++) {
    const [t0, a] = rows[i - 1]!, [t1, b] = rows[i]!, dt = t1 - t0
    if (a * b < 0) {
      const firstDuration = dt * Math.abs(a) / (Math.abs(a) + Math.abs(b))
      const first = a * firstDuration / 2, second = b * (dt - firstDuration) / 2
      incoming += Math.max(first, 0) + Math.max(second, 0)
      outgoing += Math.max(-first, 0) + Math.max(-second, 0)
    } else {
      const amount = (a + b) * dt / 2
      incoming += Math.max(amount, 0)
      outgoing += Math.max(-amount, 0)
    }
  }
  return { incoming, outgoing, net: incoming - outgoing, from_s: rows[0]![0], through_s: rows.at(-1)![0] }
}

/** Line totals and the deck's internal consistency; GRAV signs and shared-junction precedence are reported, not interpreted. */
function auditSurgeLine(line: z.infer<typeof surgeLine>) {
  const cells = line.pipes.flatMap(p => p.cellLength_m.map((dx, j) => ({ component: p.component, dx, vol: p.cellVolume_m3[j]!, edges: [p.edgeFlowArea_m2[j]!, p.edgeFlowArea_m2[j + 1]!] })))
  const edges = line.pipes.flatMap(p => p.edgeFlowArea_m2.map((fa, j) => ({ fa, hd: p.edgeHydraulicDiameter_m[j]! })))
  const sharedJunctions = line.pipes.slice(1).map((next, i) => {
    const before = line.pipes[i]!, k = before.edgeFlowArea_m2.length - 1
    const listed = (p: typeof before, j: number) => ({ component: p.component, flowArea_m2: p.edgeFlowArea_m2[j]!, friction: p.edgeFriction[j]!, grav: p.edgeGrav[j]!, hydraulicDiameter_m: p.edgeHydraulicDiameter_m[j]! })
    const a = listed(before, k), b = listed(next, 0)
    return { junction: next.junctions[0], entries: [a, b], identical: a.flowArea_m2 === b.flowArea_m2 && a.friction === b.friction && a.grav === b.grav && a.hydraulicDiameter_m === b.hydraulicDiameter_m }
  })
  return {
    cells: cells.length,
    length_m: cells.reduce((s, c) => s + c.dx, 0),
    volume_m3: cells.reduce((s, c) => s + c.vol, 0),
    maxVolumeToAreaLengthRelativeDifference: Math.max(...cells.flatMap(c => c.edges.map(fa => Math.abs(c.vol - fa * c.dx) / c.vol))),
    maxHydraulicDiameterToCircularRelativeDifference: Math.max(...edges.map(e => Math.abs(e.hd - Math.sqrt(4 * e.fa / Math.PI)) / e.hd)),
    sharedJunctions,
    edgeGravAsStated: line.pipes.map(p => ({ component: p.component, edgeGrav: p.edgeGrav })),
  }
}

export function auditPressurizerBoundaries(value: unknown) {
  const x = schema.parse(value)
  const powered = x.heaterShape.axialShape.flatMap((v, i) => v > 0 ? [i + 1] : [])
  const area = Math.PI * x.innerRadius_m ** 2
  const outerArea = 2 * Math.PI * x.outerRadius_m * x.height_m
  const cylinderVolume = area * x.height_m
  const initialShellLoss = outerArea * x.outerHeatTransfer_W_m2K * (x.wallTemperature_K - x.ambientTemperature_K)
  return {
    scope: 'Published prescribed analysis inputs; no claim of measured initial field or qualified transient',
    input: x,
    inputHash: createHash('sha256').update(JSON.stringify(x)).digest('hex'),
    cylinderVolume_m3: cylinderVolume,
    deckVolume_m3: x.cellCount * x.cellVolume_m3,
    relativeVolumeRoundingDifference: (x.cellCount * x.cellVolume_m3 - cylinderVolume) / cylinderVolume,
    heightRoundingDifference_m: x.cellCount * x.cellLength_m - x.height_m,
    initialLevelFromDeck_m: x.liquidCellEquivalents * x.cellLength_m,
    levelRoundingDifference_m: x.liquidCellEquivalents * x.cellLength_m - x.statedLevel_m,
    shellThickness_m: x.outerRadius_m - x.innerRadius_m,
    outerLateralArea_m2: outerArea,
    initialLateralShellLoss_W: initialShellLoss,
    initialHeaterMinusLateralLoss_W: x.heaterPower_W[0]![1] - initialShellLoss,
    surgeMass_kg: integrateSignedSchedule(x.surgeMassFlow_kg_s),
    heaterEnergy_J: integrateSignedSchedule(x.heaterPower_W),
    heaterShape: {
      poweredAxialRows: [powered[0]!, powered.at(-1)!],
      // Whether the deck's values sit on cell edges or cells, the power lies
      // in the lowest cells up to the last powered row.
      poweredHeightBound_m: powered.at(-1)! * x.cellLength_m,
    },
    surgeLine: auditSurgeLine(x.surgeLine),
  }
}

if (import.meta.main) {
  const [page] = process.argv.slice(2)
  if (!page) throw new Error('Usage: reference-design-pressurizer-boundaries.ts <wiki-source-page>')
  console.log(JSON.stringify(auditPressurizerBoundaries(parsePressurizerBoundaries(await Bun.file(page).text())), null, 2))
}
