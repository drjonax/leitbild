import { beforeAll, describe, expect, test } from 'bun:test'
import {
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  processPlantOperatingMode,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance } from '../src/packs/process-plant/runtime-instance.ts'
import { compileDetailDisplay, type ComposedFaceplatePanel, type OverviewView } from '../src/packs/process-plant/displays/compose.ts'
import { composedDisplayLayout, PROCESS_DISPLAY_DETAIL_MAX_COMPONENTS } from '../src/packs/process-plant/displays/composition.ts'
import { faceplateEnds } from '../src/packs/process-plant/displays/faceplate.ts'
import { faceplateNow, type FaceplateRow } from '../src/packs/process-plant/displays/faceplate-live.ts'
import { safetyFunctionChip } from '../src/packs/process-plant/displays/safety-function-content.ts'
import { evaluateSafetyFunctions } from '../src/packs/process-plant/safety-functions.ts'
import { columnLineCount, faceplateLines, faceplateLive, fitParts, fitValuesRow, pairedTags, sharedTag, type FaceplateColumnLines, type FaceplateLine } from '../src/ui/embed/composed-display/faceplate-lines.ts'
import type { ComposedDisplaySample } from '../src/ui/embed/composed-display/composed-display-client.ts'

// The faceplate under the Reactor Core's and the Turbine Generator's drawings
// as its rows read at the five pinned C1 states (plan-v3 §5), from the
// detail World compiles at Full HD and a sample as display.sample returns it:
// one line per row World derives, in the display's words, every column
// within the lines World sized the panel for. How the browser sets them is
// proven by the F-panel render harness (no text cut at any pinned state).

const plantId = 'plant:faceplate-lines'
// A process display window as measured on production in a Full HD browser (process-plant-overview.test.ts).
const fullHd: OverviewView = { width: 1896, height: 972 }

const pinned = [
  { name: 'at power', seconds: 0, actionId: null },
  { name: 'turbine trip +2:30', seconds: 150, actionId: 'turbine-trip' },
  { name: 'turbine trip +15:00', seconds: 900, actionId: 'turbine-trip' },
  { name: 'no RCP +10:00', seconds: 600, actionId: 'trip-reactor-coolant-pumps' },
  { name: 'loss of offsite power +2:30', seconds: 150, actionId: 'loss-offsite-power' },
] as const

interface Shown {
  readonly end: 'source' | 'sink'
  readonly panel: ComposedFaceplatePanel
  readonly sample: ComposedDisplaySample
  readonly rows: ReadonlyArray<ReadonlyArray<FaceplateRow>>
  readonly columns: ReadonlyArray<FaceplateColumnLines>
}

/** A Plant one minute at power, then after a scenario action, its energy ends' details and the faceplates' lines as a sample reads them. */
const shownAt = (state: (typeof pinned)[number]): ReadonlyArray<Shown> => {
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: plantId, loopCount: 4 }))
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const system = { plant, runtime, ramps: createProcessPlantRampRunner({ runtime }), protection, performance: createProcessPlantRuntimePerformance() }
  const step = (): void => {
    runtime.tick(1000)
    protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run' as never, sourceRuntimeId: 'test' })
  }
  for (let second = 0; second < 60; second += 1) step()
  const commands = state.actionId === null ? [] : commandsForProcessPlantAction({ actionId: state.actionId, parameters: {}, graph: plant.graph })
  for (const command of commands) runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
  for (let second = 0; second < state.seconds; second += 1) step()
  const mode = processPlantOperatingMode({ system: plant, runtime, modes: plant.automation.operatingModes })
  const snapshot = protection.snapshot()
  // As display.sample carries them: the annunciated alarms and trips, each safety function's chip, every value asked for.
  const alarms = [...snapshot.alarms, ...snapshot.trips]
    .filter(lifecycle => !lifecycle.shelved && !lifecycle.suppressed && !lifecycle.outOfService && (lifecycle.active || lifecycle.phase === 'clearedUnacknowledged'))
    .map(lifecycle => ({ id: lifecycle.id, ruleId: lifecycle.ruleId, kind: lifecycle.kind, title: lifecycle.title, severity: lifecycle.severity, active: lifecycle.active, acknowledged: lifecycle.acknowledged, firstOut: lifecycle.firstOut, ...(lifecycle.firstActiveElapsedMs === undefined ? {} : { firstActiveElapsedMs: lifecycle.firstActiveElapsedMs }) }))
  return faceplateEnds(plant).map(end => {
    const result = compileDetailDisplay(system, new Set(), [String(plant.graph.components[end]!.id)], fullHd)
    if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
    const panel = result.display.panels.find(candidate => candidate.kind === 'faceplate')
    if (panel?.kind !== 'faceplate') throw new Error('expected a faceplate at Full HD')
    const paths = [...new Set([...panel.faceplate.paths, ...panel.pens.map(pen => String(pen.path))])]
    const sample: ComposedDisplaySample = {
      simulationTime: new Date(Date.UTC(2026, 9, 12, 12) + runtime.elapsedMs()).toISOString(),
      plantElapsedMs: runtime.elapsedMs(),
      mode: mode === null ? null : { id: mode.id, label: mode.label },
      safetyFunctions: evaluateSafetyFunctions(plant, runtime).map(evaluation => safetyFunctionChip(evaluation, plant.graph, PROCESS_DISPLAY_DETAIL_MAX_COMPONENTS)),
      alarms: alarms as NonNullable<ComposedDisplaySample['alarms']>,
      values: paths.map(path => ({ path, value: runtime.readVariable(path as VariablePath) as number | boolean, quality: 'good' as const })),
    }
    const now = faceplateNow(panel.faceplate, faceplateLive(sample))
    return {
      end: plant.graph.components[end]!.semantics.energy[0]!.role as 'source' | 'sink',
      panel,
      sample,
      rows: now.columns.map(column => column.rows),
      columns: faceplateLines(panel, sample, new Map()),
    }
  })
}

/** A line's words as a reader takes them in, one string per line. */
const words = (line: FaceplateLine): string => {
  if (line.kind === 'values') return [...line.cells.map(cell => cell.value.kind === 'state' ? cell.value.words : `${cell.name} ${cell.value.text}`), ...(line.note === null ? [] : [line.note.forms[0]!])].join(' · ')
  if (line.kind === 'rule') return [`${line.title}${line.firstOut ? ' · 1st' : ''}`, ...line.deciding].join(' · ')
  if (line.kind === 'consequence') return line.forms[0]!
  if (line.kind === 'flows') return line.parts.join(' · ')
  if (line.kind === 'loops') return line.table.columns.map(column => column.head).join(' ')
  if (line.kind === 'strip') return [line.groups.map(group => group.map(bar => `${bar.label}${bar.printed === null ? '' : ` ${bar.printed}`}`).join(' ')).join(' | '), ...(line.all === null ? [] : [line.all])].join(' · ')
  return line.text
}

const states = new Map<string, ReadonlyArray<Shown>>()
beforeAll(() => {
  for (const state of pinned) states.set(state.name, shownAt(state))
}, 300_000)
const at = (name: (typeof pinned)[number]['name'], end: 'source' | 'sink'): Shown => states.get(name)!.find(shown => shown.end === end)!
const allWords = (shown: Shown): ReadonlyArray<string> => shown.columns.flatMap(column => column.lines.map(words))

describe('each pinned state renders the rows World derives, one line each, within the panel', () => {
  test('one line per row, of the row\'s kind, every value row its values in order, every column within the lines its panel holds', () => {
    const kindOf = { values: 'values', rule: 'rule', acting: 'text', armed: 'text', consequence: 'consequence', check: 'text', checks: 'text', flows: 'flows', loops: 'loops' } as const
    // A strip is one line of bars; a value its controller holds, its line and the line naming its mode.
    const linesOf = (row: FaceplateRow): ReadonlyArray<FaceplateLine['kind']> => row.kind === 'values' && row.strip === true ? ['strip'] : row.kind === 'values' && row.held !== undefined ? ['values', 'text'] : [kindOf[row.kind]]
    for (const [name, shown] of states) {
      for (const { panel, rows, columns } of shown) {
        // What World sized the panel for: its heads, then as many rows as its longest column can take.
        const budget = (panel.height - composedDisplayLayout.faceplateHead - 2 * composedDisplayLayout.faceplatePad) / composedDisplayLayout.faceplateRow
        expect(columns.length, name).toBe(rows.length)
        columns.forEach((column, index) => {
          expect(column.lines.map(line => line.kind), name).toEqual(rows[index]!.flatMap(linesOf))
          const valueLines = column.lines.filter(line => line.kind === 'values')
          const valueRows = rows[index]!.filter(row => row.kind === 'values' && row.strip !== true)
          valueRows.forEach((row, at) => { if (row.kind === 'values') expect(valueLines[at]!.kind === 'values' ? valueLines[at]!.cells.map(cell => String(cell.pen.path)) : []).toEqual([...row.paths]) })
          const tables = column.lines.filter(line => line.kind === 'loops')
          rows[index]!.filter(row => row.kind === 'loops').forEach((row, at) => { if (row.kind === 'loops') expect(tables[at]!.kind === 'loops' ? tables[at]!.table.rows.map(entry => entry.loop) : []).toEqual([...row.loops]) })
          expect(columnLineCount(column), name).toBeLessThanOrEqual(budget)
        })
      }
    }
  })

  test('a number reads by its tag, never shortened; a state by its declared words, never "true" or "false"', () => {
    for (const shown of [...states.values()].flat()) {
      for (const line of shown.columns.flatMap(column => column.lines)) {
        if (line.kind !== 'values') continue
        for (const cell of line.cells) {
          // A tag whole; an untagged flow by its name, or by the valve whose controller positions it.
          if (cell.value.kind === 'number') expect(cell.pen.tagId === undefined ? cell.name.length > 0 : cell.name === cell.pen.tagId).toBe(true)
          else expect([cell.pen.states?.on, cell.pen.states?.off]).toContain(cell.value.words)
        }
      }
    }
  })

  test('no filler: no row says a value has no limit, and a value no I&C limit acts on carries no alarm chip', () => {
    for (const shown of [...states.values()].flat()) {
      const active = new Set((shown.sample.alarms ?? []).filter(alarm => alarm.active).map(alarm => alarm.ruleId))
      for (const text of allWords(shown)) expect(text).not.toMatch(/no I&C limit|limit in force|no limit acts/)
      for (const line of shown.columns.flatMap(column => column.lines)) {
        if (line.kind === 'values') for (const cell of line.cells) if (cell.inAlarm !== null) expect(active.has(cell.inAlarm.ruleId)).toBe(true)
      }
    }
  })
})

describe('the rows say what an operator verifies, in the display\'s words', () => {
  test('at power: the core\'s rods off bottom, its trips counted as armed and the turbine trip a reactor trip would cause; the turbine\'s reactor trip on turbine trip armed', () => {
    const core = allWords(at('at power', 'source'))
    expect(core).toContain('Rods off bottom')
    expect(core.some(text => /^\+\d+ armed$/.test(text))).toBe(true)
    expect(core).toContain('→ TURB TRIP · Turbine trip on reactor trip (P-4) · armed')
    // Where its room is short, a consequence keeps what decides it before its title (HF-17).
    const consequence = at('at power', 'sink').columns[0]!.lines.find(line => line.kind === 'consequence')!
    expect(consequence.kind === 'consequence' && consequence.forms.at(-1)).toBe('→ RX TRIP · Reactor trip on turbine trip · armed')
    const turbine = allWords(at('at power', 'sink'))
    expect(turbine.some(text => text.startsWith('→ RX TRIP · Reactor trip on turbine trip · armed'))).toBe(true)
    expect(turbine).toContain('TURB-STOP-POS OPEN')
    // At power no CSF chip but those judged heads a column with a colour: SUBCRIT is not judged before a trip.
    const subcrit = at('at power', 'source').columns[0]!.head.parts.find(part => part.kind === 'chip')
    expect(subcrit?.kind === 'chip' ? subcrit.chip.status : null).toBe('not-monitored')
  })

  test('after a turbine trip: the core leads with its trip breakers open, then rods on bottom (E-0 step 1), judges flux against SUBCRIT\'s criteria, counts nothing armed; the turbine names its first out', () => {
    for (const name of ['turbine trip +2:30', 'turbine trip +15:00'] as const) {
      const core = at(name, 'source')
      expect(words(core.columns[0]!.lines[0]!)).toBe('RTB A OPEN · RTB B OPEN')
      expect(words(core.columns[0]!.lines[1]!)).toBe('Rods on bottom')
      expect(allWords(core).some(text => /^NIS-PR-AVG .* · < 5 % SUBCRIT$/.test(text))).toBe(true)
      expect(allWords(core).some(text => /armed|acting/.test(text))).toBe(false)
      expect(core.columns[0]!.head.parts[0]).toMatchObject({ kind: 'words', text: 'RX TRIP' })
      expect(core.columns[0]!.head.parts[0]!.kind === 'words' && core.columns[0]!.head.parts[0]!.since?.endsWith(' ago')).toBe(true)
      const turbine = at(name, 'sink').columns[0]!.lines
      // The turbine-trip scenario presses the manual turbine trip (C1 T0): it is the first out, the P-4 trip after it.
      expect(turbine[0]).toMatchObject({ kind: 'rule', title: 'Manual turbine trip', firstOut: true, status: 'alarm' })
      expect(allWords(at(name, 'sink'))).toContain('TURB-STOP-POS SHUT')
    }
  })

  test('the loop table: hot and cold legs, ΔT with ΔT power ("—" without forced flow), loop flow and the OTΔT/OPΔT margins, idle once their rules no longer act; no validity flag is a column', () => {
    const tableOf = (shown: Shown) => shown.columns.flatMap(column => column.lines).find(line => line.kind === 'loops')!
    const power = tableOf(at('at power', 'source'))
    const tripped = tableOf(at('turbine trip +2:30', 'source'))
    const natural = tableOf(at('no RCP +10:00', 'source'))
    if (power.kind !== 'loops' || tripped.kind !== 'loops' || natural.kind !== 'loops') throw new Error('expected the loop table')
    expect(power.table.columns.map(column => `${column.head} ${column.unit}`.trim())).toEqual(['TE-4x1-HOT °C', 'TE-4x1-COLD °C', 'TDI-4x1 / TDI-4x1-PWR', 'FI-4x4 %', 'OTDT/OPDT-4x1-MARGIN °C'])
    expect(power.table.columns.map(column => column.idle)).toEqual([false, false, false, false, false])
    expect(tripped.table.columns.map(column => column.idle)).toEqual([false, false, false, false, true])
    expect(power.table.rows.map(row => row.loop)).toEqual(['A', 'B', 'C', 'D'])
    // With forced flow ΔT power reads beside ΔT; with no pump running it measures nothing, and reads "—".
    expect(power.table.rows.every(row => /^\S+ °C \/ \S+ %$/.test(row.cells[2]!.text))).toBe(true)
    expect(natural.table.rows.every(row => row.cells[2]!.text.endsWith(' / —'))).toBe(true)
  })

  test('with no reactor coolant pump running, natural circulation folds into one neutral line, ticked only while every check passes, naming those not met where the faceplate is compact', () => {
    for (const name of ['no RCP +10:00', 'loss of offsite power +2:30'] as const) {
      const folded = allWords(at(name, 'source')).filter(text => text.includes('Natural circulation'))
      expect(folded.length, name).toBe(1)
      expect(folded[0], name).toMatch(/^(✓ Natural circulation (\d+)\/\2|○ Natural circulation \d+\/\d+ · not yet met: .+)$/)
    }
    expect(allWords(at('turbine trip +2:30', 'source')).some(text => text.includes('Natural circulation'))).toBe(false)
  })

  test('the rod banks read as one strip, SA–SD | CA–CD, a value only where a bank differs, and no average rod beside them', () => {
    const strip = (shown: Shown) => shown.columns.flatMap(column => column.lines).find(line => line.kind === 'strip')
    const power = strip(at('at power', 'source'))
    const tripped = strip(at('turbine trip +2:30', 'source'))
    if (power?.kind !== 'strip' || tripped?.kind !== 'strip') throw new Error('expected the bank strip')
    expect(power.groups.map(group => group.map(bar => bar.label))).toEqual([['SA', 'SB', 'SC', 'SD'], ['CA', 'CB', 'CC', 'CD']])
    expect(words(power)).toBe('SA SB SC SD | CA CB CC CD 220')
    expect(words(tripped)).toBe('SA SB SC SD | CA CB CC CD · all 0')
    for (const shown of [...states.values()].flat()) expect(shown.panel.pens.some(pen => pen.tagId === 'ROD-STEPS')).toBe(false)
  })

  test('a header names each branch by its first equipment, and the steam dumps read their flow first, then their position and their only mode', () => {
    for (const name of ['at power', 'turbine trip +15:00'] as const) {
      const turbine = allWords(at(name, 'sink'))
      const flows = turbine.find(text => text.startsWith('Steam header to: '))
      expect(flows, name).toBeDefined()
      expect(flows, name).not.toMatch(/\bATM\b/)
      const lines = at(name, 'sink').columns.flatMap(column => column.lines)
      const dump = lines.findIndex(line => line.kind === 'values' && line.cells.some(cell => cell.pen.tagId === 'TURB-BYP-POS'))
      const dumps = lines[dump]
      expect(dumps?.kind === 'values' ? dumps.cells.map(cell => cell.pen.unit) : [], name).toEqual(['kg/s', 'fraction'])
      expect(words(lines[dump + 1]!), name).toBe('pressure mode only, 7.6 MPa')
    }
  })

  test('a reading outside the validity its equipment declares reads "—", never its value: off line no turbine speed, on a dead grid no frequency, without forced flow no ΔT power', () => {
    for (const [name, shown] of states) {
      for (const { sample, columns } of shown) {
        const read = (path: string) => sample.values.find(entry => entry.path === path)?.value
        for (const line of columns.flatMap(column => column.lines)) {
          if (line.kind !== 'values') continue
          for (const cell of line.cells) {
            if (cell.pen.validWhile === undefined || read(String(cell.pen.validWhile)) === true) continue
            expect(cell.value.kind === 'number' ? cell.value.text : cell.value.words, `${name} ${cell.pen.tagId}`).toBe('—')
          }
        }
      }
    }
    const lost = allWords(at('loss of offsite power +2:30', 'sink'))
    expect(lost.some(text => /TURB-SPEED \d|GRID-HZ \d/.test(text))).toBe(false)
  })

  test('a check not met reads "not yet met", never "expected": no declaration of the I&C config says it is', () => {
    for (const shown of [...states.values()].flat()) for (const text of allWords(shown)) expect(text).not.toMatch(/expected|not met(?!.*yet)/)
    expect(allWords(at('loss of offsite power +2:30', 'source')).some(text => text.includes('not yet met:'))).toBe(true)
  })

  test('after a loss of offsite power the turbine names its first out, loss of load, before the reactor trip it caused', () => {
    const rules = at('loss of offsite power +2:30', 'sink').columns[0]!.lines.filter(line => line.kind === 'rule')
    expect(rules.map(line => line.kind === 'rule' ? [line.title, line.firstOut] : [])).toEqual([['Turbine trip on loss of load', true], ['Turbine trip on reactor trip (P-4)', false]])
    expect(allWords(at('loss of offsite power +2:30', 'sink'))).toContain('Grid DEAD')
  })

  test('a state reads quiet where it is normal, as at the Plant\'s operating point, and emphasised where it is not', () => {
    // HMI review of run 26: "Grid LIVE" and "Grid available" were bold, the abnormal OFF LINE grey.
    const deviates = (shown: Shown): Readonly<Record<string, boolean>> => Object.fromEntries(shown.columns.flatMap(column => column.lines
      .flatMap(line => line.kind === 'values' ? line.cells.flatMap(cell => cell.value.kind === 'state' ? [[cell.value.words, cell.value.deviates] as const] : []) : [])))
    expect(deviates(at('turbine trip +2:30', 'sink'))).toMatchObject({ 'OFF LINE': true, 'Grid LIVE': false, 'Grid available': false })
    expect(Object.values(deviates(at('at power', 'sink'))).every(deviating => !deviating)).toBe(true)
    expect(deviates(at('loss of offsite power +2:30', 'sink'))).toMatchObject({ 'OFF LINE': true, 'Grid DEAD': true })
    expect(deviates(at('turbine trip +2:30', 'source'))).toMatchObject({ 'RTB A OPEN': true, 'RTB B OPEN': true, 'Rods on bottom': true })
  })

  test('a rule row names what decides it in the words of each reading its panel resolves', () => {
    for (const shown of [...states.values()].flat()) {
      const named = new Set(shown.panel.pens.flatMap(pen => [pen.states?.on, pen.states?.off, pen.tagId].filter((text): text is string => text !== undefined)))
      for (const line of shown.columns.flatMap(column => column.lines)) {
        if (line.kind !== 'rule') continue
        for (const reading of line.deciding) expect([...named].some(name => reading.startsWith(name))).toBe(true)
      }
    }
  })
})

describe('a row gives way to its room without cutting a word', () => {
  test('its sparkline goes first, then its bar, then its note shortens by whole parts; its values are never shortened', () => {
    const row = { cells: 200, gap: 6, note: [180, 120, 80], bar: 64, sparkline: 112 }
    expect(fitValuesRow({ ...row, room: 200 + 6 + 112 + 6 + 64 + 6 + 180 })).toEqual({ note: 0, bar: true, sparkline: true })
    expect(fitValuesRow({ ...row, room: 200 + 6 + 112 + 6 + 64 + 6 + 80 })).toEqual({ note: 2, bar: true, sparkline: true })
    expect(fitValuesRow({ ...row, room: 200 + 6 + 64 + 6 + 120 })).toEqual({ note: 1, bar: true, sparkline: false })
    expect(fitValuesRow({ ...row, room: 200 + 6 + 120 })).toEqual({ note: 1, bar: false, sparkline: false })
    expect(fitValuesRow({ ...row, room: 200 })).toEqual({ note: null, bar: false, sparkline: false })
    expect(fitValuesRow({ ...row, note: [], room: 200 + 6 + 112 })).toEqual({ note: null, bar: true, sparkline: false })
    expect(fitValuesRow({ ...row, note: [], bar: null, room: 200 + 6 + 112 })).toEqual({ note: null, bar: false, sparkline: true })
  })

  test('a rule\'s deciding readings drop from the last, whole', () => {
    const fits = (room: number) => (text: string) => text.length <= room
    expect(fitParts(['RTB A OPEN', 'RTB B OPEN'], fits(30))).toEqual(['RTB A OPEN', 'RTB B OPEN'])
    expect(fitParts(['RTB A OPEN', 'RTB B OPEN'], fits(15))).toEqual(['RTB A OPEN'])
    expect(fitParts(['RTB A OPEN', 'RTB B OPEN'], fits(5))).toEqual([])
  })

  test('a loop table\'s head writes the loop\'s place in its tags x, and two tags of one cell share their ending once', () => {
    expect(sharedTag(['TE-411-HOT', 'TE-421-HOT', 'TE-431-HOT', 'TE-441-HOT'])).toBe('TE-4x1-HOT')
    expect(sharedTag(['u7.a', 'u9.a'])).toBe('ux.a')
    expect(pairedTags(['OTDT-4x1-MARGIN', 'OPDT-4x1-MARGIN'])).toBe('OTDT/OPDT-4x1-MARGIN')
    expect(pairedTags(['TDI-4x1'])).toBe('TDI-4x1')
    expect(pairedTags(['A-1', 'B-2'])).toBe('A-1 / B-2')
  })
})
