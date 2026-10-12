import { missingArtworkMessage } from '../../../ui/map-runtime/catalogue-symbol-atlas.ts'
import type { BoardView } from '../board/types.ts'

/**
 * The catalogue artwork the Board draws beside its rows: the same icons the
 * map draws for those objects, loaded on demand through the map symbol
 * Capability (`loadMapSymbols`). Each id is asked for once; one that does
 * not load is reported, with the ids it failed for, and never asked again.
 */

export interface BoardIcons {
  /** Asks for artwork of these ids; ids already loaded, loading or failed are not asked again. */
  readonly request: (ids: Iterable<string>) => void
  /** The artwork of a loaded icon: an SVG document drawn in white strokes. */
  readonly svg: (id: string) => string | undefined
  /** Why icons are missing: "No map artwork for icon: …", or null when none is. */
  readonly missing: () => string | null
}

export interface BoardIconPorts {
  readonly load: (ids: ReadonlyArray<string>) => Promise<ReadonlyMap<string, string>>
  readonly changed: () => void
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

export const createBoardIcons = (ports: BoardIconPorts): BoardIcons => {
  const artwork = new Map<string, string>()
  const loading = new Set<string>()
  const failed = new Map<string, string | undefined>()

  const load = async (ids: ReadonlyArray<string>): Promise<void> => {
    try {
      const loaded = await ports.load(ids)
      for (const id of ids) {
        const svg = loaded.get(id)
        if (svg === undefined) failed.set(id, undefined)
        else artwork.set(id, svg)
      }
    } catch (error) {
      for (const id of ids) failed.set(id, messageOf(error))
    } finally {
      for (const id of ids) loading.delete(id)
    }
    ports.changed()
  }

  return {
    request: ids => {
      const wanted = [...new Set(ids)].filter(id => !artwork.has(id) && !loading.has(id) && !failed.has(id))
      if (wanted.length === 0) return
      for (const id of wanted) loading.add(id)
      void load(wanted)
    },
    svg: id => artwork.get(id),
    missing: () => {
      if (failed.size === 0) return null
      const causes = [...new Set([...failed.values()].filter((cause): cause is string => cause !== undefined))]
      return missingArtworkMessage([...failed.keys()].sort(), causes.length === 0 ? undefined : causes.join('; '))
    },
  }
}

/** Every icon a Board view draws: its work rows', unit rows' and contacts'. */
export const boardIconIds = (view: BoardView): ReadonlyArray<string> => [...new Set([
  ...view.workList.rows.map(row => row.icon),
  ...view.unitBoard.rows.map(row => row.icon),
  ...(view.contacts === null ? [] : view.contacts.sides.flatMap(side => [...side.engageable.rows, ...side.other.rows]).map(row => row.icon)),
])]

/** An SVG document as an image source; an image never runs what it holds. */
export const svgImageSource = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
