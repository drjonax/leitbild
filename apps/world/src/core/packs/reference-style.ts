// Pack-owned presentation of reference datasets and map legends. Browser-safe
// data only: the generic map adds the vector source, the published layer ids,
// `source-layer`, stacking order and visibility; the Pack owns every filter,
// paint and layout decision.

export type PackMapTheme = 'light' | 'dark'

/** How the map is currently drawn. Styles derive their palette from it. */
export interface PackMapAppearance {
  readonly theme: PackMapTheme
}

export type PackReferenceLayerType = 'fill' | 'line' | 'circle' | 'symbol'

export interface PackReferenceLayerSpec {
  /** `<group>:<kind>`, unique within the dataset. Published as `reference:<datasetId>:<id>`. */
  readonly id: string
  readonly type: PackReferenceLayerType
  readonly minzoom?: number
  readonly filter: ReadonlyArray<unknown>
  readonly layout?: Readonly<Record<string, unknown>>
  readonly paint: Readonly<Record<string, unknown>>
}

export interface PackReferenceDatasetStyle {
  readonly datasetId: string
  /** Vector tile layer the dataset build writes; must match the published manifest. */
  readonly outputLayer: string
  /** Manifest categories the layers draw. Registration fails for a populated category outside this list. */
  readonly categories: ReadonlyArray<string>
  /** Layers in paint order, bottom first. */
  readonly layersFor: (appearance: PackMapAppearance) => ReadonlyArray<PackReferenceLayerSpec>
}

export interface PackMapThemedColor {
  readonly light: string
  readonly dark: string
}

export type PackMapLegendSymbol = 'line' | 'dashed-line' | 'circle' | 'ring'

export interface PackMapLegendSwatch {
  readonly symbol: PackMapLegendSymbol
  readonly color: PackMapThemedColor
  /** Line width or circle diameter in CSS pixels. */
  readonly sizePx: number
}

export interface PackMapLegendEntry extends PackMapLegendSwatch {
  readonly id: string
  readonly label: string
}

export interface PackMapLegend {
  readonly id: string
  readonly title: string
  readonly entries: ReadonlyArray<PackMapLegendEntry>
}
