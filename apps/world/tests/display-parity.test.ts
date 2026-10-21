import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Observable, Observation } from '../src/core/observation/model.ts'
import { scopeWithin } from '../src/features/displays/compose/topology.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { answerProcessPlantObservationQuery } from '../src/packs/process-plant/observation/query.ts'
import { servedPlantTopology } from '../src/packs/process-plant/observation/topology.ts'
import type { ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { observedInput, readingLook } from '../src/ui/embed/vignette/readout.ts'
import { observeListings } from './display-parity/listings.ts'
import { observeProposalFlow } from './display-parity/proposal-flow.ts'
import { askOf, CHIP_SIGNALS, PLANT_ID, plantIn, plantModel, REFERENCE_MIMICS, SIMULATION_TIME, STATES } from './display-parity/states.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// T39 (swap plan): the plant swap's parity, deterministic and at the data level. Each fact the old display path gave,
// as T01 recorded it (tests/fixtures/display-characterization/old-path.json) and the faceplates' rows were recorded
// before their deletion (tests/fixtures/display-parity/faceplate-rows.json), read on the new path: the Plant's
// topology, observations and declarations, its controls and proposals. A difference holds only where it is listed
// here with its reason. P4 (procedure tags) and P9 (overview and equipment defaults) read a World Run: P4 in
// procedure-tag-default.test.ts, P9 in compose-plant-parity.test.ts; P6 is process-plant-proposal-characterization.

const record = await Bun.file(join(import.meta.dir, 'fixtures/display-characterization/old-path.json')).json()
const faceplates = await Bun.file(join(import.meta.dir, 'fixtures/display-parity/faceplate-rows.json')).json() as {
  readonly ends: ReadonlyArray<{ readonly end: string; readonly values: ReadonlyArray<string>; readonly flows: ReadonlyArray<string>; readonly loops: ReadonlyArray<string>; readonly protection: ReadonlyArray<string>; readonly safetyFunctions: ReadonlyArray<string>; readonly programs: boolean }>
}
const declaration = plantDeclaration(PLANT_ID as never, plantModel(), null)
const declared = new Map(declaration.observables.map(observable => [observable.ref, observable]))
const ref = (path: string): string => `${PLANT_ID}#${path}`
const read = (instance: ProcessPlantRuntimeInstance, refs: ReadonlyArray<string>): ReadonlyMap<string, Observation> => new Map(((answerProcessPlantObservationQuery({
  request: { capabilityId: 'world.process-plant.observation.read', input: { refs } }, plants: new Map([[PLANT_ID, instance]]), simulationTime: SIMULATION_TIME, recording: null,
}) as { readonly observations: ReadonlyArray<Observation> }).observations).map(observation => [observation.ref, observation]))

/**
 * Listed differences in what an item's state reads (P1): the new path says the state in its controls' words (the
 * drawing's popover header said the aspect's word), and a valve between its ends reads "part open", its opening on
 * its position binding.
 */
const STATE_WORDS: Readonly<Record<string, string>> = { running: 'RUN', stopped: 'STOP' }
const stateWord = (old: string, labels: ReadonlyArray<string>): string => {
  const word = old.split(';')[0]!.trim()
  if (/^\d+ % open$/.test(word)) return 'part open'
  if (word === 'closed' && labels.includes('SHUT')) return 'SHUT'
  return STATE_WORDS[word] ?? word.toUpperCase()
}

/** controls.list's items as T01 recorded them. */
const listedFacts = (items: ReadonlyArray<any>) => items.map(item => ({
  id: item.id,
  offered: (item.offered as ReadonlyArray<any>).map(listed => ({
    tagId: listed.control?.tagId ?? null,
    form: listed.control?.form ?? null,
    now: listed.now ?? null,
    throttledUnder: (listed.throttledUnder ?? []).map((rule: { label: string }) => rule.label),
    options: ((listed.control?.options ?? []) as ReadonlyArray<any>).map((option, index) => ({
      word: option.word,
      consequences: (option.consequences ?? []).map((rule: { label: string }) => rule.label),
      heldBy: listed.standing?.[index]?.heldBy?.label ?? null,
    })),
  })),
  withheld: item.withheld ?? [],
}))

const topology = servedPlantTopology(PLANT_ID as never, plantModel())

describe('T39 plant swap parity', () => {
  for (const state of STATES) {
    describe(state.id, () => {
      const instance = plantIn(state)
      const ask = askOf(instance)
      const recorded = record.states[state.id]

      test('P1: each reference drawing draws the same equipment; each item offers the same actions; each operated item says its state', () => {
        REFERENCE_MIMICS.forEach((mimic, index) => {
          const old = recorded.elementActions[index] as { readonly drawn: ReadonlyArray<string>; readonly items: ReadonlyArray<unknown> }
          const scoped = scopeWithin(topology, { around: mimic.around, from: mimic.from, to: mimic.to, media: mimic.services })
          if (!scoped.ok) throw new Error(`${JSON.stringify(mimic)}: ${scoped.reason}`)
          const ids = old.drawn.map(entry => entry.slice(0, entry.indexOf(':')))
          expect([...scoped.scoped.nodes].sort()).toEqual([...ids].sort())
          // What the element pop-over's actions list for each drawn item (controls.list, by node id).
          expect(listedFacts(ask<{ readonly items: ReadonlyArray<any> }>('world.process-plant.controls.list', { plantId: PLANT_ID, items: ids }).items)).toEqual(old.items as never)
          // An operated item's state observable reads what the drawing's word said, in its controls' words, with the command it does not follow.
          const states = ids.filter(id => declared.has(ref(`${id}.state`)))
          const observed = read(instance, states.map(id => ref(`${id}.state`)))
          for (const entry of old.drawn) {
            const id = entry.slice(0, entry.indexOf(':'))
            if (!states.includes(id)) continue
            const observable = declared.get(ref(`${id}.state`))!
            const observation = observed.get(ref(`${id}.state`))!
            const labels = observable.states!.map(stated => stated.label)
            const word = entry.slice(entry.indexOf(':') + 1)
            expect([id, observable.states!.find(stated => stated.value === observation.value)?.label]).toEqual([id, stateWord(word, labels)])
            expect([id, observation.why ?? null]).toEqual([id, word.includes('commanded') ? `commanded ${word.match(/commanded (\w+)/)![1]!.toUpperCase()}` : null])
          }
        })
      })

      test('P2: the latched actuations and their resets read the same, each reached from an item it holds', () => {
        const listed = ask<{ readonly resets: ReadonlyArray<any> }>('world.process-plant.controls.list', { plantId: PLANT_ID }).resets
        expect(listed.map(reset => ({ ruleId: reset.ruleId, label: reset.label, offered: reset.offered, ...(reset.reason === undefined ? {} : { reason: reset.reason }) }))).toEqual(recorded.resets)
        // Listed difference: a reset is offered in the element panel of an item it holds; one that holds no item is offered on none.
        expect(listed.filter(reset => reset.items.length === 0).map(reset => reset.ruleId)).toEqual([...UNREACHED_RESETS[state.id] ?? []])
      })

      test('P3: each reference value names the same limit it is past, and what the I&C does there', () => {
        const graph = instance.plant.graph
        const paths = CHIP_SIGNALS.map(tag => String(graph.signalBindingByTagId.get(tag as never)!.path))
        const observed = read(instance, paths.map(ref))
        const chips = Object.fromEntries(CHIP_SIGNALS.map((tag, index) => {
          const observable: Observable = declared.get(ref(paths[index]!))!
          const observation = observed.get(ref(paths[index]!))
          const chip = readingLook(observable.label, observable.valueType, observable.states, observedInput(observable, observation)).chip
          const passed = observable.thresholds.find(threshold => threshold.id === observation?.past)
          return [tag, chip === null ? null : `${chip.word}${passed?.consequence === undefined ? '' : ` · ${passed.consequence}`}`]
        }))
        expect(chips).toEqual({ ...recorded.chips, ...CHIP_DIFFERENCES[state.id] })
      })
    })
  }

  test('P5: a proposal end to end at the Capability boundary, its cited reading with its margin', async () => {
    const { citedMargins, ...flow } = await observeProposalFlow()
    expect(flow).toEqual(record.proposalFlow)
    expect(citedMargins).toEqual(['N % above LO N % · ALM'])
  })

  test('P7: every faceplate row is declared: values and loops as observables, protection as limits with what the I&C does, functions as CSFs, programs as their values', () => {
    const missing = faceplates.ends.flatMap(end => [...end.values, ...end.flows, ...end.loops].filter(path => !declared.has(ref(path))).map(path => `${end.end}: ${path}`))
    expect(missing).toEqual([])
    const limited = new Set(declaration.observables.flatMap(observable => observable.thresholds.filter(threshold => threshold.consequence !== undefined).map(threshold => threshold.id.split('#')[0]!)))
    expect(faceplates.ends.flatMap(end => end.protection.filter(rule => !limited.has(rule)).map(rule => `${end.end}: ${rule}`))).toEqual([...UNLIMITED_RULES])
    expect(faceplates.ends.flatMap(end => end.safetyFunctions.filter(id => !declared.has(ref(`csf.${id}`))))).toEqual([])
    // A loop's readings group by their loop: each declared element of the loop's lines and equipment names its loop.
    const groups = new Map(declaration.elements.map(element => [element.id, element.group]))
    expect(faceplates.ends.flatMap(end => end.loops.filter(path => groups.get(declared.get(ref(path))!.element!) === undefined))).toEqual([])
    // The core's programs (Tavg to Tref): the program and its reading are declared values.
    const programs = plantModel().graph.components.flatMap(component => component.semantics.programs.flatMap(program => [program.reading, program.program, ...(program.deviation === undefined ? [] : [program.deviation])]))
    expect(faceplates.ends.some(end => end.programs)).toBe(true)
    expect(programs.filter(path => !declared.has(ref(String(path))))).toEqual([])
  })

  test('P8: the window opens a vignette listing, refuses one of another view type with its reason, and the rest as before', () => {
    expect(observeListings()).toEqual(LISTINGS)
  })
})

/** Resets that hold no item an element panel shows (P2): none in the recorded states. */
const UNREACHED_RESETS: Readonly<Record<string, ReadonlyArray<string>>> = {}

/** Listed chip differences (P3), by state: none. */
const CHIP_DIFFERENCES: Readonly<Record<string, Record<string, string | null>>> = {}

/**
 * Protection rules a faceplate listed that set no limit on a value (P7), listed: each acts on a state or a press, not
 * on a reading past a limit (a coolant pump's breaker opening, a manual trip, a turbine trip's cascade, the loss of
 * load). Each still shows as its alarm or trip in the unit's alert slot when it acts, and a manual trip or SI is a
 * pushbutton in the element panel of the equipment it acts on.
 */
const UNLIMITED_RULES: ReadonlyArray<string> = [
  'core: reactor-rcp-breaker-open-trip', 'core: reactor-manual-trip', 'core: safety-injection-manual', 'core: reactor-trip-turbine-trip',
  'turbine: reactor-trip-turbine-trip', 'turbine: turbine-trip-on-loss-of-load', 'turbine: turbine-manual-trip',
]

/** P8: the listings the window opens, as T01 recorded them (re-baselined when the window shows vignettes only). */
const LISTINGS = record.listings
