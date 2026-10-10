import { describe, expect, test } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import {
  acceptsGzipEncoding,
  createCompressedTileCache,
  gzipTile,
  type CompressedTile,
} from '../src/map/tile-compression.ts'

const tileOf = (byteLength: number, fill = 1): CompressedTile => ({
  bytes: new Uint8Array(byteLength).fill(fill),
  cacheControl: 'public, max-age=3600',
})

const countingLoader = (tile: CompressedTile | null): { readonly load: () => Promise<CompressedTile | null>; readonly calls: () => number } => {
  let calls = 0
  return {
    load: async () => {
      calls += 1
      return tile
    },
    calls: () => calls,
  }
}

describe('Accept-Encoding negotiation', () => {
  test.each([
    ['gzip, deflate, br, zstd', true],
    ['GZIP', true],
    ['br;q=1.0, gzip;q=0.5', true],
    ['gzip ; q=0.001', true],
    ['br, *;q=0.1', true],
    ['*', true],
  ])('admits gzip for %p', (header, expected) => {
    expect(acceptsGzipEncoding(header)).toBe(expected)
  })

  test.each([
    [null],
    [''],
    ['identity'],
    ['br, deflate'],
    ['gzip;q=0'],
    ['gzip;q=0.000'],
    ['gzip;q=0, *'],
    ['*;q=0'],
    ['gzip;q=2'],
    ['gzip;q=high'],
  ])('refuses gzip for %p', header => {
    expect(acceptsGzipEncoding(header)).toBe(false)
  })
})

describe('compressed tile cache', () => {
  test('rejects a byte budget that cannot hold anything', () => {
    expect(() => createCompressedTileCache({ maxBytes: 0 })).toThrow('positive integer byte budget')
    expect(() => createCompressedTileCache({ maxBytes: 1.5 })).toThrow('positive integer byte budget')
  })

  test('loads a tile once and serves later requests from memory', async () => {
    const cache = createCompressedTileCache({ maxBytes: 1_000 })
    const tile = tileOf(100)
    const loader = countingLoader(tile)

    expect(await cache.get('archive#4/8/4', loader.load)).toBe(tile)
    expect(await cache.get('archive#4/8/4', loader.load)).toBe(tile)
    expect(loader.calls()).toBe(1)
  })

  test('shares one load between concurrent requests for the same tile', async () => {
    const cache = createCompressedTileCache({ maxBytes: 1_000 })
    const tile = tileOf(100)
    const loader = countingLoader(tile)

    const results = await Promise.all([1, 2, 3].map(() => cache.get('archive#4/8/4', loader.load)))
    expect(results).toEqual([tile, tile, tile])
    expect(loader.calls()).toBe(1)
  })

  test('does not retain missing tiles or failed loads', async () => {
    const cache = createCompressedTileCache({ maxBytes: 1_000 })
    const missing = countingLoader(null)
    expect(await cache.get('archive#0/0/0', missing.load)).toBeNull()
    expect(await cache.get('archive#0/0/0', missing.load)).toBeNull()
    expect(missing.calls()).toBe(2)

    let failures = 0
    const failing = async (): Promise<CompressedTile | null> => {
      failures += 1
      throw new Error('archive read failed')
    }
    const firstRequest = cache.get('archive#1/0/0', failing)
    const concurrentRequest = cache.get('archive#1/0/0', failing)
    await expect(firstRequest).rejects.toThrow('archive read failed')
    await expect(concurrentRequest).rejects.toThrow('archive read failed')
    expect(failures).toBe(1)
    await expect(cache.get('archive#1/0/0', failing)).rejects.toThrow('archive read failed')
    expect(failures).toBe(2)
  })

  test('evicts the least recently used tiles once the byte budget is exceeded', async () => {
    const cache = createCompressedTileCache({ maxBytes: 300 })
    const first = countingLoader(tileOf(100, 1))
    const second = countingLoader(tileOf(100, 2))
    const third = countingLoader(tileOf(100, 3))
    const fourth = countingLoader(tileOf(100, 4))

    await cache.get('first', first.load)
    await cache.get('second', second.load)
    await cache.get('third', third.load)
    await cache.get('first', first.load) // Now the most recently used.
    await cache.get('fourth', fourth.load) // 400 bytes: evicts `second`.

    await cache.get('first', first.load)
    await cache.get('third', third.load)
    await cache.get('fourth', fourth.load)
    expect([first.calls(), third.calls(), fourth.calls()]).toEqual([1, 1, 1])
    await cache.get('second', second.load)
    expect(second.calls()).toBe(2)
  })

  test('serves but does not retain a tile larger than the whole budget', async () => {
    const cache = createCompressedTileCache({ maxBytes: 300 })
    const small = countingLoader(tileOf(100))
    const huge = countingLoader(tileOf(301))

    await cache.get('small', small.load)
    expect((await cache.get('huge', huge.load))?.bytes.byteLength).toBe(301)
    await cache.get('huge', huge.load)
    await cache.get('small', small.load)
    expect(huge.calls()).toBe(2)
    expect(small.calls()).toBe(1)
  })
})

describe('tile gzip coding', () => {
  test('round-trips the original tile bytes', async () => {
    const original = new Uint8Array(4_096)
    for (let index = 0; index < original.length; index += 1) original[index] = (index * 31) % 251
    const compressed = await gzipTile(original)
    expect(compressed[0]).toBe(0x1f)
    expect(compressed[1]).toBe(0x8b)
    expect(new Uint8Array(gunzipSync(compressed))).toEqual(original)
  })
})
