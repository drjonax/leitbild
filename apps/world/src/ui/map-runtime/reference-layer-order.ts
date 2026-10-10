import { referenceLayerIdPrefix } from '../map/reference-layer-factory.ts'

// Reference datasets are context drawn directly above the base map's ground
// layers: below the first base-map label and below every runtime overlay (Pack
// features, live layers), whatever order those were registered in. A runtime
// overlay that later inserts itself before the first base-map symbol layer
// therefore lands above the reference layers.

interface StyleLayerForOrder {
  readonly id: string
  readonly type: string
  readonly source?: unknown
}

export interface StyleForOrder {
  readonly layers: ReadonlyArray<StyleLayerForOrder>
  readonly metadata?: unknown
}

const baseSourcesKey = 'leitbild:baseSources'

const baseSourceIdsOf = (style: StyleForOrder): ReadonlySet<string> => {
  const metadata = style.metadata as Record<string, unknown> | undefined
  const ids = metadata?.[baseSourcesKey]
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string')) {
    throw new Error(`base map style metadata "${baseSourcesKey}" is missing; reference layers cannot be ordered`)
  }
  return new Set(ids as ReadonlyArray<string>)
}

/** Layer id the reference layers are inserted before, or null to append them on top. */
export const referenceLayerAnchorId = (style: StyleForOrder): string | null => {
  const baseSourceIds = baseSourceIdsOf(style)
  const anchor = style.layers.find(layer => {
    if (layer.id.startsWith(referenceLayerIdPrefix)) return false
    if (layer.type === 'symbol') return true
    return typeof layer.source === 'string' && !baseSourceIds.has(layer.source)
  })
  return anchor?.id ?? null
}
