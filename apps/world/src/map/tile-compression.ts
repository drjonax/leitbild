import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

export interface CompressedTile {
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly cacheControl: string
}

export interface CompressedTileCacheConfig {
  readonly maxBytes: number
}

export interface CompressedTileCache {
  /**
   * Returns the retained tile for `key`, or runs `load` once for all concurrent callers of the
   * same key and retains a non-null result. A `null` result (no tile at these coordinates) is
   * returned but never retained.
   */
  readonly get: (key: string, load: () => Promise<CompressedTile | null>) => Promise<CompressedTile | null>
}

const gzipAsync = promisify(gzip)

// Level 6 is zlib's default. Level 9 makes the largest grid tile (1.1 MB raw) only 1.5 % smaller
// for twice the compression time; node:zlib's async gzip runs off the event loop either way.
const tileGzipLevel = 6

export const gzipTile = async (bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await gzipAsync(bytes, { level: tileGzipLevel }))

const qualityValuePattern = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/

// RFC 9110 §12.4.2: a missing weight is 1; a malformed weight is treated as a refusal so the
// client still receives the identity bytes it can always read.
const codingWeight = (parameters: ReadonlyArray<string>): number => {
  for (const parameter of parameters) {
    const separator = parameter.indexOf('=')
    if (separator < 0) continue
    if (parameter.slice(0, separator).trim().toLowerCase() !== 'q') continue
    const value = parameter.slice(separator + 1).trim()
    return qualityValuePattern.test(value) ? Number(value) : 0
  }
  return 1
}

/**
 * Whether an `Accept-Encoding` request header admits gzip (RFC 9110 §12.5.3). An explicit
 * `gzip` member decides; otherwise a `*` member does. A request without the header gets
 * identity bytes: clients that omit it (scripts, probes) rarely expect a coded body.
 */
export const acceptsGzipEncoding = (acceptEncoding: string | null): boolean => {
  if (acceptEncoding === null) return false
  let gzipWeight: number | null = null
  let wildcardWeight: number | null = null
  for (const member of acceptEncoding.split(',')) {
    const [rawCoding = '', ...parameters] = member.split(';')
    const coding = rawCoding.trim().toLowerCase()
    if (coding === 'gzip') gzipWeight = codingWeight(parameters)
    else if (coding === '*') wildcardWeight = codingWeight(parameters)
  }
  if (gzipWeight !== null) return gzipWeight > 0
  return wildcardWeight !== null && wildcardWeight > 0
}

/**
 * A least-recently-used cache of compressed tiles bounded by their total byte size. Keys must
 * carry the archive identity (path, modification time and size) so a replaced archive is never
 * served from stale entries; those entries simply age out.
 */
export const createCompressedTileCache = (config: CompressedTileCacheConfig): CompressedTileCache => {
  if (!Number.isSafeInteger(config.maxBytes) || config.maxBytes <= 0) {
    throw new Error('compressed tile cache needs a positive integer byte budget')
  }
  // Map iteration order is insertion order; a hit re-inserts its entry as the most recent.
  const entries = new Map<string, CompressedTile>()
  const pending = new Map<string, Promise<CompressedTile | null>>()
  let retainedBytes = 0

  const retain = (key: string, tile: CompressedTile): void => {
    // A tile larger than the whole budget is served but cannot be retained.
    if (tile.bytes.byteLength > config.maxBytes) return
    entries.set(key, tile)
    retainedBytes += tile.bytes.byteLength
    for (const [oldestKey, oldest] of entries) {
      if (retainedBytes <= config.maxBytes) break
      entries.delete(oldestKey)
      retainedBytes -= oldest.bytes.byteLength
    }
  }

  const settle = async (key: string, loading: Promise<CompressedTile | null>): Promise<CompressedTile | null> => {
    try {
      const tile = await loading
      if (tile) retain(key, tile)
      return tile
    } finally {
      pending.delete(key)
    }
  }

  return {
    get: (key, load) => {
      const cached = entries.get(key)
      if (cached) {
        entries.delete(key)
        entries.set(key, cached)
        return Promise.resolve(cached)
      }
      const inFlight = pending.get(key)
      if (inFlight) return inFlight
      const loading = settle(key, load())
      pending.set(key, loading)
      return loading
    },
  }
}
