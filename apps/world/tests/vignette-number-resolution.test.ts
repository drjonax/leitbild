import { describe, expect, test } from 'bun:test'
import type { ObjectId } from '../src/core/model/index.ts'
import { numberShown, numberText, observableSchema, type Observation } from '../src/core/observation/model.ts'
import { assembleCard, valueItem } from '../src/features/displays/compose/card.ts'
import type { VignetteSection } from '../src/features/displays/compose/model.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { flowDrawing } from '../src/ui/embed/vignette/flow-symbols.ts'
import { readingLook, valueLook } from '../src/ui/embed/vignette/readout.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// W0.7 (UX audit H9, #78): below the step its decimals show a value reads as a zero reads ("0 kg/s", never "-0"); a
// power of ten only where the Pack declares the quantity read over decades (`decades`: the intermediate-range current,
// whose span the Plant declares over eight decades). The card, the readout block and a drawing write it alike.

const at = '2026-10-22T12:00:00.000Z'
const observation = (ref: string, value: number): Observation => ({ ref, at, clock: 'simulation', value, quality: 'good', priority: 'none' })
const object = { id: 'unit:x', label: 'Unit X' } as never

describe('a value below its resolution reads 0; only a quantity read over decades as a power of ten', () => {
  test('the formatter: a value its decimals round to zero reads as a zero reads, unsigned; declared over decades, its power of ten', () => {
    // RCS leak rate and the steam header on the overview (H9): noise, no reading over decades.
    expect([numberText(2.3e-12, 'kg/s'), numberText(3.8e-8, 'kg/s'), numberText(-2.3e-12, 'kg/s'), numberText(4.4e-8, 'A')]).toEqual(['0', '0', '0', '0'])
    // Below the step, as its zero reads: fixed decimals, or three significant digits' zero for a code with none listed;
    // a startup rate in hundredths of a decade a minute (the live overview's "-0.000003 DPM" at power).
    expect([numberText(1e-9, 'MPa'), numberText(-0.04, '%'), numberText(-1e-9, 'pcm'), numberText(-3e-6, 'DPM'), numberText(-0.5, 'DPM')]).toEqual(['0.00', '0.0', '0.00', '0.00', '-0.50'])
    expect([numberShown(2.3e-12, 'kg/s'), numberShown(-1e-9, 'pcm'), numberShown(15.504, 'MPa')]).toEqual([{ value: 0, decimals: 0 }, { value: 0, decimals: 2 }, { value: 15.5, decimals: 2 }])
    expect(Object.is(numberShown(-2.3e-12, 'kg/s').value, -0)).toBe(false)
    // Declared over decades: below its step a power of ten, with the number the card carries; above it and at zero as any value.
    expect([numberText(4.4e-7, 'A', 'current', true), numberText(-2.26e-11, 'A', 'current', true), numberText(0.004, 'A', 'current', true), numberText(0, 'A', 'current', true), numberText(12, 'A', 'current', true)])
      .toEqual(['4.4×10⁻⁷', '-2.3×10⁻¹¹', '4.0×10⁻³', '0', '12'])
    expect(numberShown(4.4e-7, 'A', 'current', true)).toEqual({ value: 4.4e-7, decimals: 8 })
    expect(observableSchema.safeParse({ ref: 'unit:x#ir', label: 'IR current', quantity: 'current', unit: 'A', valueType: 'number', series: null, decades: true }).success).toBe(true)
    expect(observableSchema.safeParse({ ref: 'unit:x#ir', label: 'IR current', quantity: 'current', unit: 'A', valueType: 'number', series: null, decades: false }).success).toBe(false)
  })

  test('the readout block, the card and a drawing write it alike', () => {
    const leak = observableSchema.parse({ ref: 'unit:x#leak', label: 'RCS leak rate', quantity: 'flow', unit: 'kg/s', valueType: 'number', series: null })
    const current = observableSchema.parse({ ref: 'unit:x#ir', label: 'Intermediate range current', quantity: 'current', unit: 'A', valueType: 'number', series: null, decades: true })
    expect(valueLook(leak, [observation(leak.ref, 2.3e-12)], leak.ref)).toMatchObject({ text: '0', value: 0, decimals: 0, unit: 'kg/s' })
    expect(valueLook(leak, [observation(leak.ref, -2.3e-12)], leak.ref)).toMatchObject({ text: '0', value: 0 })
    expect(valueLook(current, [observation(current.ref, 4.4e-7)], current.ref)).toMatchObject({ text: '4.4×10⁻⁷', value: '4.4×10⁻⁷', unit: 'A' })
    // A code with no decimals listed: the block shows the zero's two decimals the card writes, never six.
    expect(readingLook('Reactivity', 'number', undefined, { value: -1e-9, unit: 'pcm', thresholds: [] })).toMatchObject({ text: '0.00', value: 0, decimals: 2 })
    expect(readingLook('Startup rate', 'number', undefined, { value: -3e-6, unit: 'DPM', thresholds: [] })).toMatchObject({ text: '0.00', value: 0, decimals: 2 })
    const card = assembleCard({ at, clock: 'simulation' }, [valueItem({ observable: leak, object }, observation(leak.ref, 2.3e-12)), valueItem({ observable: current, object }, observation(current.ref, 4.43e-7))], [])
    expect(card.items.map(item => [item.reading, item.numbers])).toEqual([['0 kg/s', [{ value: 0, decimals: 0 }]], ['4.4×10⁻⁷ A', [{ value: 4.4e-7, decimals: 8 }]]])
    // A drawn reading: the binding carries its observable's declaration.
    const drawn = (binding: { readonly quantity: 'flow' | 'current'; readonly unit: string; readonly decades?: true }, value: number) => {
      const section: Extract<VignetteSection, { kind: 'topology' }> = {
        kind: 'topology', rows: 6, objectId: 'unit:x', packId: 'fixture', family: 'flow',
        layout: { family: 'flow', unit: 'grid', width: 6, height: 6, crossings: 0, hash: 'h', edges: [],
          nodes: [{ id: 'header', x: 0, y: 1, width: 2, height: 2, ports: {}, text: { x: 0, y: 3, width: 4, height: 1, lines: 2, side: 'bottom' } }] },
        nodes: [{ id: 'header', class: 'junction', label: 'Header', bindings: [{ role: 'value', ref: 'unit:x#v', ...binding }] }],
        edges: [],
      }
      return flowDrawing(section, [observation('unit:x#v', value)], [], false).texts.flatMap(text => text.lines.map(line => line.text))
    }
    expect(drawn({ quantity: 'flow', unit: 'kg/s' }, 3.8e-8)).toEqual(['Header', '0 kg/s'])
    expect(drawn({ quantity: 'current', unit: 'A', decades: true }, 4.4e-7)).toEqual(['Header', '4.4×10⁻⁷ A'])
  })

  test('the Plant declares the intermediate-range current read over decades, by its span; no other reading', () => {
    const objectId = 'plant:resolution' as ObjectId
    const declaration = plantDeclaration(objectId, compileProcessPlant(createPwrReferencePlantDefinition({ id: objectId, loopCount: 4 })), null)
    expect(declaration.observables.filter(observable => observable.decades === true).map(observable => observable.ref)).toEqual([`${objectId}#core.intermediateRangeCurrentAmps`])
  })
})
