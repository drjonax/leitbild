import type { VariablePath } from '../../graph/index.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import type { ComposedDisplayPen } from '../compose.ts'
import { equipmentKeyValues, type PlantNow } from '../../ic/key-values.ts'
import type { CompiledMimic } from './mimic-model.ts'

// What an interactive drawing's quick looks show: for each drawn item the
// first lead values of its detail, ranked as the detail ranks them for the
// Plant's mode now (equipmentKeyValues). They are chosen when the display is
// compiled, with its drawing, so opening a quick look compiles nothing; its
// popover reads their history and samples them while open. A display gets
// its quick looks again whenever it is compiled again (a new mode, a new
// window), as its own lead values do.

/** At most this many lead values in a quick look; the detail shows the rest. */
export const QUICK_LOOK_LEADS = 6

export interface MimicQuickLooks {
  /** The window of their sparklines, as the display's lead values have it. */
  readonly sparklineMs: number
  /** Every quick look's lead values, each once. */
  readonly pens: ReadonlyArray<ComposedDisplayPen>
  /** Per drawn item, by its id: its quick look's lead values in rank order, by path; an item without any has none. */
  readonly items: Readonly<Record<string, ReadonlyArray<VariablePath>>>
}

/** Each drawn item's quick-look lead values, by item id: the first of what its detail would lead with now. */
export const mimicQuickLookPaths = (plant: CompiledProcessPlant, mimic: CompiledMimic, now: PlantNow): Readonly<Record<string, ReadonlyArray<VariablePath>>> => {
  const graph = plant.graph
  return Object.fromEntries(mimic.items.flatMap(item => {
    const components = item.components.map(id => graph.componentIndexById.get(id as never)!)
    const leads = equipmentKeyValues(plant, components, now).slice(0, QUICK_LOOK_LEADS)
    return leads.length === 0 ? [] : [[item.id, leads]]
  }))
}
