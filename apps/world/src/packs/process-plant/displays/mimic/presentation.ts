import type { CompiledComponent, CompiledEmbeddedDevice, ComponentKind, EquipmentFunction, StateAspect } from '../../graph/index.ts'
import { notEquipmentKindIds, notEquipmentReason } from '../../equipment/items.ts'

// How each component kind is drawn, with OpenBridge's own components and
// icons. This table is the only place the mimic knows component kinds; it
// names no Plant instance, and the Pack tests check it covers every kind in
// the component registry. A component that is no item of equipment
// (equipment/items.ts) is not drawn, for the reason the model gives; a kind
// the table cannot draw says why, and the mimic rejects drawing it rather
// than guessing.

/** OpenBridge icon families a device is drawn with; the state picks the variant (on, off, static, open, closed). */
export type MimicIconFamily =
  | 'pump'
  | 'valve-analog'
  | 'valve-digital'
  | 'valve-check'
  | 'source'
  | 'transformer'
  | 'breaker'
  | 'diesel-generator'
  | 'generator'
  | 'converter'
  | 'battery'

export type MimicPresentation =
  /** An `obc-automation-button` with an OpenBridge icon; its state comes from `aspect`. */
  | { readonly element: 'device'; readonly icon: MimicIconFamily; readonly aspect: StateAspect }
  /** An `obc-automation-tank`; its fill comes from the level aspect, or it is static when it has none. */
  | { readonly element: 'tank'; readonly tank: 'generic' | 'atmospheric' | 'pressurized'; readonly aspect: 'level' | null }
  /** An `obc-heat-exchanger`, with its level (if any) as a readout beside it. */
  | { readonly element: 'heat-exchanger'; readonly aspect: 'level' | null }
  /**
   * A reactor vessel drawn in OpenBridge's tokens (vessel-symbol.ts): head,
   * flange, nozzles where its pipes reach it, its level as the fill, and,
   * where it is the energy's source, its core region with what the equipment
   * declares it inserts (rod banks) hanging into it.
   */
  | { readonly element: 'vessel'; readonly aspect: 'level' | null }
  /** A header or bus: a manifold the branches tee into. */
  | { readonly element: 'bar'; readonly aspect: 'throughput' | 'energized' }
  | { readonly element: 'not-drawn'; readonly reason: string }

const valveIcons: Readonly<Record<EquipmentFunction, MimicIconFamily>> = {
  modulating: 'valve-analog',
  isolating: 'valve-digital',
  nonReturn: 'valve-check',
  relieving: 'valve-digital',
}

// A valve's icon says what it does: modulating valves show their opening, the others open or shut.
// A valve is equipment only where it declares its function (notEquipmentReason), which presentationFor checks first.
const valvePresentation = (component: CompiledComponent): MimicPresentation =>
  ({ element: 'device', icon: valveIcons[component.semantics.function!], aspect: 'position' })

const byKind: Readonly<Record<string, MimicPresentation | ((component: CompiledComponent) => MimicPresentation)>> = {
  centrifugalPump: { element: 'device', icon: 'pump', aspect: 'running' },
  processValve: valvePresentation,
  steamValve: valvePresentation,
  processTank: { element: 'tank', tank: 'atmospheric', aspect: 'level' },
  reliefTank: { element: 'tank', tank: 'pressurized', aspect: 'level' },
  pressurizer: { element: 'tank', tank: 'pressurized', aspect: 'level' },
  accumulator: { element: 'tank', tank: 'pressurized', aspect: null },
  // A core is drawn as the vessel it heats, filled by the level its kind declares it reads there; static where it declares none.
  reactorCore: { element: 'vessel', aspect: 'level' },
  reactorVessel: { element: 'tank', tank: 'pressurized', aspect: 'level' },
  containmentVolume: { element: 'tank', tank: 'generic', aspect: 'level' },
  steamGenerator: { element: 'heat-exchanger', aspect: 'level' },
  condenserSink: { element: 'heat-exchanger', aspect: 'level' },
  heatExchanger: { element: 'heat-exchanger', aspect: null },
  processHeader: { element: 'bar', aspect: 'throughput' },
  steamHeader: { element: 'bar', aspect: 'throughput' },
  electricalBus: { element: 'bar', aspect: 'energized' },
  electricalGridSource: { element: 'device', icon: 'source', aspect: 'energized' },
  electricalTransformer: { element: 'device', icon: 'transformer', aspect: 'energized' },
  electricalBreaker: { element: 'device', icon: 'breaker', aspect: 'position' },
  dieselGenerator: { element: 'device', icon: 'diesel-generator', aspect: 'running' },
  turbineLoadSink: { element: 'device', icon: 'generator', aspect: 'running' },
  inverter: { element: 'device', icon: 'converter', aspect: 'energized' },
  battery: { element: 'device', icon: 'battery', aspect: 'energized' },
}

/** Kinds the table draws or the model says are no equipment, for the completeness test against the component registry. */
export const presentedKinds: ReadonlySet<string> = new Set([...Object.keys(byKind), ...notEquipmentKindIds])

export const presentationFor = (component: CompiledComponent): MimicPresentation => {
  const notEquipment = notEquipmentReason(component)
  if (notEquipment !== undefined) return { element: 'not-drawn', reason: notEquipment }
  const entry = byKind[String(component.kind)]
  if (entry === undefined) return { element: 'not-drawn', reason: `the mimic has no symbol for kind ${component.kind}` }
  return typeof entry === 'function' ? entry(component) : entry
}

/** Devices a component bundles are drawn as valves on the pipe they sit on. */
export const embeddedPresentation = (device: CompiledEmbeddedDevice): MimicPresentation =>
  ({ element: 'device', icon: valveIcons[device.function], aspect: 'position' })

/** Kinds of the registry the table does not mention; must be empty. */
export const unpresentedKinds = (kinds: Iterable<ComponentKind>): ReadonlyArray<string> =>
  [...kinds].map(String).filter(kind => !presentedKinds.has(kind)).sort()
