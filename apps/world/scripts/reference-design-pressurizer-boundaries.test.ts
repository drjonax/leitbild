import { expect, test } from 'bun:test'
import { auditPressurizerBoundaries, integrateSignedSchedule, parsePressurizerBoundaries } from './reference-design-pressurizer-boundaries.ts'

const input: ReturnType<typeof parsePressurizerBoundaries> = {
  sourceSha256: 'ee74a7b5315bed710d4a89dfe43347613b8fb85349640de253aa4c4d8c981369',
  height_m: 8.8, innerRadius_m: .06985, outerRadius_m: .08415,
  cellCount: 30, cellLength_m: .2933333, cellVolume_m3: .00449618,
  liquidCellEquivalents: 11.25, statedLevel_m: 3.3,
  fluidTemperature_K: 547.64, wallTemperature_K: 547, ambientTemperature_K: 298,
  outerHeatTransfer_W_m2K: 3.44,
  surgeMassFlow_kg_s: [[0, 0], [119, 0], [120, .3666], [220, .3666], [221, -.215], [406, -.215], [407, 0]],
  heaterPower_W: [[0, 4000], [99, 4000], [100, 0]],
  heaterShape: {
    pages: 'A-7–A-8', powerComponent: 141, heatStructure: 131, axialCells: 30,
    axialShape: [0, 1, 1, 1, 1, 1, 1, 1, ...Array<number>(23).fill(0)],
    radialNodes_m: [.06985, .073425, .077, .080575, .08415], radialShape: [1, 1, 1, 1, 1],
  },
  surgeLine: {
    pages: 'A-3–A-4',
    fill: { component: 11, junction: 11, liquidTemperature_K: 547, vaporTemperature_K: 547, pressure_Pa: 5.9e6, voidFraction: 0 },
    pipes: [
      { component: 61, junctions: [11, 1], cellLength_m: [3.15, 3.15], cellVolume_m3: [1.84385e-3, 1.84385e-3],
        edgeFlowArea_m2: [5.85349e-4, 5.85349e-4, 5.85349e-4], edgeFriction: [0, 0, .1], edgeGrav: [-1, 0, 0], edgeHydraulicDiameter_m: [.0273, .0273, .0273] },
      { component: 71, junctions: [1, 12], cellLength_m: [1.47], cellVolume_m3: [8.60464e-4],
        edgeFlowArea_m2: [5.85349e-4, 5.85349e-4], edgeFriction: [.1, .1], edgeGrav: [0, 1], edgeHydraulicDiameter_m: [.0273, .0273] },
    ],
    initialCells: { voidFraction: 0, liquidTemperature_K: 547.64, vaporTemperature_K: 547.64, pressure_Pa: 5.9e6, noncondensablePressure_Pa: 0, edgeLiquidVelocity_m_s: 0, edgeVaporVelocity_m_s: 0 },
  },
}

test('recovered source geometry and heat/mass budgets are calculated independently', () => {
  const a = auditPressurizerBoundaries(input)
  expect(a.initialLevelFromDeck_m).toBeCloseTo(3.3, 5)
  expect(Math.abs(a.relativeVolumeRoundingDifference)).toBeLessThan(1e-6)
  expect(a.shellThickness_m).toBeCloseTo(.0143, 9)
  expect(a.initialLateralShellLoss_W).toBeGreaterThan(3900)
  expect(a.initialLateralShellLoss_W).toBeLessThan(4000)
  expect(a.heaterEnergy_J.net).toBe(398000)
  expect(a.surgeMass_kg.net).toBeCloseTo(-2.9634, 9)
  expect(a.surgeMass_kg.incoming).toBeGreaterThan(36.84)
  expect(a.surgeMass_kg.outgoing).toBeGreaterThan(39.88)
})

test('surge line totals, deck consistency and shared junction are reported as listed', () => {
  const line = auditPressurizerBoundaries(input).surgeLine
  expect(line.cells).toBe(3)
  expect(line.length_m).toBeCloseTo(7.77, 12)
  expect(line.volume_m3).toBeCloseTo(4.548164e-3, 12)
  expect(line.maxVolumeToAreaLengthRelativeDifference).toBeLessThan(2e-6)
  expect(line.maxHydraulicDiameterToCircularRelativeDifference).toBeLessThan(2e-3)
  expect(line.sharedJunctions).toHaveLength(1)
  expect(line.sharedJunctions[0]!.junction).toBe(1)
  expect(line.sharedJunctions[0]!.identical).toBe(true)
  expect(line.edgeGravAsStated).toEqual([{ component: 61, edgeGrav: [-1, 0, 0] }, { component: 71, edgeGrav: [0, 1] }])
  const shape = auditPressurizerBoundaries(input).heaterShape
  expect(shape.poweredAxialRows).toEqual([2, 8])
  expect(shape.poweredHeightBound_m).toBeCloseTo(2.3466664, 9)
})

test('surge line and heater shape are strict', () => {
  const line = input.surgeLine, [p61, p71] = line.pipes
  const withLine = (l: typeof line) => ({ ...input, surgeLine: l })
  expect(() => auditPressurizerBoundaries(withLine({ ...line, fill: { ...line.fill, junction: 12 } }))).toThrow()
  expect(() => auditPressurizerBoundaries(withLine({ ...line, pipes: [p61!, { ...p71!, junctions: [2, 12] }] }))).toThrow()
  expect(() => auditPressurizerBoundaries(withLine({ ...line, pipes: [{ ...p61!, edgeGrav: [-1, 0] }, p71!] }))).toThrow()
  expect(() => auditPressurizerBoundaries(withLine({ ...line, pipes: [{ ...p61!, edgeGrav: [-2, 0, 0] }, p71!] }))).toThrow()
  expect(() => auditPressurizerBoundaries(withLine({ ...line, initialCells: { ...line.initialCells, quality: 0 } } as never))).toThrow()
  expect(() => auditPressurizerBoundaries({ ...input, heaterShape: { ...input.heaterShape, axialShape: input.heaterShape.axialShape.slice(1) } })).toThrow()
  expect(() => auditPressurizerBoundaries({ ...input, heaterShape: { ...input.heaterShape, radialNodes_m: [.07, .073425, .077, .080575, .08415] } })).toThrow()
  const { surgeLine: _line, ...withoutLine } = input
  expect(() => auditPressurizerBoundaries(withoutLine)).toThrow()
})

test('zero-crossing split retains both gross directions and linear integral', () => {
  expect(integrateSignedSchedule([[0, 2], [3, -1]])).toEqual({ incoming: 2, outgoing: .5, net: 1.5, from_s: 0, through_s: 3 })
  expect(integrateSignedSchedule([[0, -2], [3, 1]]).net).toBe(-1.5)
  expect(integrateSignedSchedule([[2, 0], [5, 0]]).net).toBe(0)
  expect(() => integrateSignedSchedule([[0, 1], [0, 2]])).toThrow()
  expect(() => integrateSignedSchedule([[0, 1], [Infinity, 2]])).toThrow()
})

test('strict fixture, explicit times, finite geometry; altered assumptions change audit', () => {
  const doc = '```reference-pressurizer-boundaries\n' + JSON.stringify(input) + '\n```'
  expect(parsePressurizerBoundaries(doc)).toEqual(input)
  expect(() => parsePressurizerBoundaries(doc + '\n' + doc)).toThrow()
  expect(() => auditPressurizerBoundaries({ ...input, pressureValidated: true })).toThrow()
  expect(() => auditPressurizerBoundaries({ ...input, outerRadius_m: .06 })).toThrow()
  expect(() => auditPressurizerBoundaries({ ...input, liquidCellEquivalents: 31 })).toThrow()
  expect(() => auditPressurizerBoundaries({ ...input, heaterPower_W: [[0, -1], [2, 0]] })).toThrow()
  const altered = auditPressurizerBoundaries({ ...input, cellVolume_m3: .005 })
  expect(altered.relativeVolumeRoundingDifference).toBeGreaterThan(.1)
  expect(altered.inputHash).not.toBe(auditPressurizerBoundaries(input).inputHash)
})
