/** The signal names of the probe's Plant: the 4-loop PWR reference model
 * every Halden unit runs (plant:halden-2 in halden-power-complex). Keys name
 * signals by tag or path; this resolves both to one signal and the component
 * it is measured on, so a mimic that draws that component can carry the key. */
import { compileProcessPlant, createPwrReferencePlantDefinition, signalMeasuredOn } from '../../apps/world/src/packs/process-plant/index.ts'

export interface CatalogSignal {
  readonly path: string
  readonly tagId?: string
  /** The component the signal is measured on (signalMeasuredOn): what a mimic draws. */
  readonly component: string
}

export interface PlantCatalog {
  /** A signal by tag or by path. */
  readonly signal: (name: string) => CatalogSignal | undefined
  readonly hasComponent: (id: string) => boolean
  /** Every tag and path, longest first, for finding names inside free text. */
  readonly names: ReadonlyArray<string>
}

export const referencePlantCatalog = (loopCount = 4): PlantCatalog => {
  const { graph } = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:halden-2', loopCount }))
  const byName = new Map<string, CatalogSignal>()
  for (const binding of graph.signalBindingByPath.values()) {
    const component = signalMeasuredOn(graph, binding.owner).id
    const tagId = binding.tagId === undefined ? undefined : String(binding.tagId)
    const entry: CatalogSignal = { path: String(binding.path), ...(tagId === undefined ? {} : { tagId }), component }
    byName.set(entry.path, entry)
    if (tagId !== undefined) byName.set(tagId, entry)
  }
  const components = new Set(graph.components.map(component => String(component.id)))
  return {
    signal: name => byName.get(name),
    hasComponent: id => components.has(id),
    names: [...byName.keys()].sort((left, right) => right.length - left.length),
  }
}
