import { stat } from 'node:fs/promises'
import { PMTiles, TileType, type Source } from 'pmtiles'

// Zoom range and geographic bounds of an MVT PMTiles archive, read from its header.

export interface VectorTileArchiveSummary {
  readonly minZoom: number
  readonly maxZoom: number
  /** [west, south, east, north] in degrees. */
  readonly bounds: readonly [number, number, number, number]
}

const bunFileSource = (filePath: string, key: string): Source => ({
  getKey: (): string => key,
  getBytes: async (offset: number, length: number, signal?: AbortSignal): Promise<{ readonly data: ArrayBuffer }> => {
    signal?.throwIfAborted()
    const data = await Bun.file(filePath).slice(offset, offset + length).arrayBuffer()
    signal?.throwIfAborted()
    return { data }
  },
})

export const readVectorTileArchiveSummary = async (filePath: string): Promise<VectorTileArchiveSummary> => {
  const info = await stat(filePath)
  if (!info.isFile() || info.size <= 0) throw new Error(`vector tile archive is empty or not a file: ${filePath}`)
  const header = await new PMTiles(bunFileSource(filePath, `${filePath}:${info.mtimeMs}:${info.size}`)).getHeader()
  if (header.tileType !== TileType.Mvt) throw new Error(`${filePath} is not an MVT PMTiles archive (tileType ${header.tileType})`)
  if (!Number.isInteger(header.minZoom) || !Number.isInteger(header.maxZoom) || header.minZoom > header.maxZoom) {
    throw new Error(`${filePath} has an invalid zoom range ${header.minZoom}-${header.maxZoom}`)
  }
  const bounds = [header.minLon, header.minLat, header.maxLon, header.maxLat] as const
  const validBounds = bounds.every(Number.isFinite)
    && bounds[0] >= -180 && bounds[2] <= 180 && bounds[0] < bounds[2]
    && bounds[1] >= -90 && bounds[3] <= 90 && bounds[1] < bounds[3]
  if (!validBounds) throw new Error(`${filePath} has invalid bounds ${bounds.join(',')}`)
  return { minZoom: header.minZoom, maxZoom: header.maxZoom, bounds }
}
