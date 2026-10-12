import { audienceVisibleTo, type CompiledScenario, type ScenarioExecutionState } from '../model/index.ts'
import type { SimulationRunStateSnapshot } from './state-store.ts'

/**
 * What a side view receives of a Run's state, built from an allow-list and
 * denied by default. Every key of the snapshot, the execution state and the
 * Compiled Scenario is classified here: passed as it is, built for the view,
 * or dropped. A key without a rule never reaches a side view, and a test
 * fails on any schema key that has none.
 */
type KeyRule<T, K extends keyof T> =
  | 'pass'
  | 'drop'
  /** Builds the view's value from the source's; called only when the source has one. */
  | { build(value: Exclude<T[K], undefined>, sees: ReadonlyArray<string>): T[K] }
  /** The view always carries this valid empty value, whatever the source holds. */
  | { empty(): T[K] }

export type SideViewRules<T> = { readonly [K in keyof T]-?: KeyRule<T, K> }

const buildSideView = <T extends object>(source: T, rules: SideViewRules<T>, sees: ReadonlyArray<string>): T => {
  const view: Partial<Record<keyof T, unknown>> = {}
  for (const key of Object.keys(rules) as Array<keyof T>) {
    const rule = rules[key] as KeyRule<T, keyof T>
    if (rule === 'drop') continue
    if (typeof rule === 'object' && 'empty' in rule) {
      view[key] = rule.empty()
      continue
    }
    const value = source[key]
    if (value === undefined) continue
    view[key] = rule === 'pass' ? value : rule.build(value as Exclude<T[keyof T], undefined>, sees)
  }
  return view as T
}

export const executionStateSideViewRules: SideViewRules<ScenarioExecutionState> = {
  scenarioId: 'pass',
  // A role Run carries no AI restrictions; the view states that as empty.
  agentRestrictions: { empty: () => ({ operationIds: [], objects: [], revision: 0 }) },
  roles: 'drop',
  // Compilation refuses guidance that names an object other than a public one.
  guidance: 'pass',
  highlightedObjectIds: { empty: () => [] },
  timeline: 'drop',
}

export const snapshotSideViewRules: SideViewRules<SimulationRunStateSnapshot> = {
  objects: { build: (objects, sees) => objects.filter(object => audienceVisibleTo(object.audience, sees)) },
  seq: 'pass',
  clock: 'pass',
  scenario: { build: (scenario, sees) => buildSideView(scenario, executionStateSideViewRules, sees) },
  procedures: 'drop',
}

export const compiledScenarioSideViewRules: SideViewRules<CompiledScenario> = {
  id: 'pass',
  schemaVersion: 'pass',
  title: 'pass',
  description: 'pass',
  objectives: 'pass',
  agentRestrictions: { empty: () => ({ operationIds: [], objects: [] }) },
  roles: 'pass',
  rolePresets: 'pass',
  sides: 'pass',
  packs: 'pass',
  packRuntimes: 'pass',
  // Pack configuration is authoring material: every side reads it whole.
  packConfigs: 'pass',
  // Connections name initial objects, which a side view does not receive.
  connections: { empty: () => [] },
  world: 'pass',
  initialObjects: { empty: () => [] },
  view: 'pass',
  recording: 'pass',
  timeline: 'drop',
}

/** A side view's Run snapshot: its objects by audience, the sequence and clock, and redacted scenario state. */
export const sideViewOfSnapshot = (snapshot: SimulationRunStateSnapshot, sees: ReadonlyArray<string>): SimulationRunStateSnapshot =>
  buildSideView(snapshot, snapshotSideViewRules, sees)

/** A side view's Compiled Scenario: declarations and authoring material, without initial objects, timeline or restrictions. */
export const sideViewOfCompiledScenario = (scenario: CompiledScenario, sees: ReadonlyArray<string>): CompiledScenario =>
  buildSideView(scenario, compiledScenarioSideViewRules, sees)
