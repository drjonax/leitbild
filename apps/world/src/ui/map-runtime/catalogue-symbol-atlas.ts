import type { LeitbildIconMapping } from './symbol-kit.ts'

/**
 * Artwork for catalogue icons beyond the compiled atlas, drawn natively by
 * the operational deck layers. Artwork loads on demand through the map
 * symbol Capability, is rasterized, and is packed into one atlas image that
 * is rebuilt whenever new artwork arrives. A load from an earlier generation
 * (before a reset) never lands. An icon whose artwork fails to load is
 * reported once and not drawn; an atlas that fails to compose is reported too.
 */

export interface CatalogueSymbolAtlasState {
  /** Increases with every rebuilt atlas. */
  readonly revision: number
  /** The packed atlas image; null until any artwork has arrived. */
  readonly url: string | null
  readonly mapping: LeitbildIconMapping
}

export interface CatalogueAtlasCell<Image> {
  readonly id: string
  readonly image: Image
  /** Top-left of the cell in the atlas, in pixels. */
  readonly x: number
  readonly y: number
}

export interface CatalogueSymbolAtlasPorts<Image> {
  readonly loadArtwork: (ids: ReadonlyArray<string>) => Promise<ReadonlyMap<string, string>>
  readonly rasterize: (svg: string) => Promise<Image>
  /** Packs rasterized artwork into one image of the given size; returns its URL. */
  readonly compose: (cells: ReadonlyArray<CatalogueAtlasCell<Image>>, size: { readonly width: number; readonly height: number }) => string
  readonly onChange: (state: CatalogueSymbolAtlasState) => void
  readonly onError: (message: string) => void
}

export interface CatalogueSymbolAtlas {
  /** Asks for artwork of these catalogue ids; ids already loaded, loading or failed are not asked again. */
  readonly request: (ids: Iterable<string>) => void
  readonly current: () => CatalogueSymbolAtlasState
  /** Drops all artwork; loads still under way are discarded. */
  readonly reset: () => void
}

/** Cells match the compiled atlas: 48 px artwork centred in 64 px cells, eight per row. */
export const catalogueAtlasCell = 64
export const catalogueAtlasColumns = 8
const artworkInset = 8

export const emptyCatalogueSymbolAtlas: CatalogueSymbolAtlasState = { revision: 0, url: null, mapping: {} }

export const missingArtworkMessage = (ids: ReadonlyArray<string>, cause?: string): string =>
  `No map artwork for icon: ${ids.join(', ')}${cause ? ` (${cause})` : ''}`

export const atlasFailureMessage = (cause: string): string => `Map icon atlas: ${cause}`

export const createCatalogueSymbolAtlas = <Image>(ports: CatalogueSymbolAtlasPorts<Image>): CatalogueSymbolAtlas => {
  let state = emptyCatalogueSymbolAtlas
  let generation = 0
  let loading = false
  const images = new Map<string, Image>()
  // Every id ever asked for in this generation, including failed ones: a failure is reported once, never retried in a loop.
  const asked = new Set<string>()
  let queued: ReadonlyArray<string> = []

  const rebuild = (): void => {
    const ids = [...images.keys()]
    const rows = Math.ceil(ids.length / catalogueAtlasColumns)
    const cells = ids.map((id, index) => ({ id, image: images.get(id)!, x: index % catalogueAtlasColumns * catalogueAtlasCell, y: Math.floor(index / catalogueAtlasColumns) * catalogueAtlasCell }))
    const url = ports.compose(cells.map(cell => ({ ...cell, x: cell.x + artworkInset, y: cell.y + artworkInset })), {
      width: catalogueAtlasColumns * catalogueAtlasCell,
      height: rows * catalogueAtlasCell,
    })
    const mapping: LeitbildIconMapping = Object.fromEntries(cells.map(cell => [cell.id, {
      x: cell.x, y: cell.y, width: catalogueAtlasCell, height: catalogueAtlasCell, anchorX: catalogueAtlasCell / 2, anchorY: catalogueAtlasCell / 2, mask: true,
    }]))
    state = { revision: state.revision + 1, url, mapping }
    ports.onChange(state)
  }

  const fail = (ids: ReadonlyArray<string>, cause?: string): void => {
    ports.onError(missingArtworkMessage(ids, cause))
  }

  const load = async (ids: ReadonlyArray<string>, ticket: number): Promise<void> => {
    let artwork: ReadonlyMap<string, string>
    try {
      artwork = await ports.loadArtwork(ids)
    } catch (error) {
      if (ticket === generation) fail(ids, error instanceof Error ? error.message : String(error))
      return
    }
    if (ticket !== generation) return
    let added = false
    for (const id of ids) {
      const svg = artwork.get(id)
      if (svg === undefined) {
        fail([id])
        continue
      }
      let image: Image
      try {
        image = await ports.rasterize(svg)
      } catch (error) {
        if (ticket === generation) fail([id], error instanceof Error ? error.message : String(error))
        continue
      }
      if (ticket !== generation) return
      images.set(id, image)
      added = true
    }
    if (!added) return
    try {
      rebuild()
    } catch (error) {
      // Composing or publishing the atlas failed: the map error path hears it; the artwork stays for the next rebuild.
      ports.onError(atlasFailureMessage(error instanceof Error ? error.message : String(error)))
    }
  }

  const pump = (): void => {
    if (loading || queued.length === 0) return
    const ids = queued
    queued = []
    loading = true
    const ticket = generation
    void (async () => {
      try {
        await load(ids, ticket)
      } finally {
        if (ticket === generation) {
          loading = false
          pump()
        }
      }
    })()
  }

  return {
    request: ids => {
      const fresh = [...new Set(ids)].filter(id => !asked.has(id))
      if (fresh.length === 0) return
      for (const id of fresh) asked.add(id)
      queued = [...queued, ...fresh]
      pump()
    },
    current: () => state,
    reset: () => {
      generation += 1
      loading = false
      queued = []
      images.clear()
      asked.clear()
      state = { ...emptyCatalogueSymbolAtlas, revision: state.revision + 1 }
    },
  }
}
