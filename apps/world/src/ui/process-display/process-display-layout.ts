import type { SimulationRunId } from '../../core/model/index.ts'

// Where an operator left the process display window in a Run. There is one
// window per Run, whichever display it shows. The displays inside are drawn
// for their frame and are not the operator's to move, so only the window is
// remembered.

export interface ProcessDisplayWindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface StorageLike {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
}

const windowStoragePrefix = 'leitbild.processDisplayWindow.v2'

const browserStorage = (): StorageLike | null =>
  typeof localStorage === 'undefined' ? null : localStorage

interface WindowAddress {
  readonly simulationRunId: SimulationRunId
}

const windowStorageKeyFor = (address: WindowAddress): string =>
  `${windowStoragePrefix}:${address.simulationRunId}`

const isFiniteCoordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const parseWindowBounds = (value: unknown): ProcessDisplayWindowBounds => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('process display window bounds must be an object')
  }
  const record = value as Record<string, unknown>
  if (
    !isFiniteCoordinate(record.x)
    || !isFiniteCoordinate(record.y)
    || !isFiniteCoordinate(record.width)
    || !isFiniteCoordinate(record.height)
  ) {
    throw new Error('process display window bounds contains invalid coordinates')
  }
  return {
    x: record.x,
    y: record.y,
    width: record.width,
    height: record.height,
  }
}

export const readProcessDisplayWindowBounds = (
  address: WindowAddress,
  storage: StorageLike | null = browserStorage(),
): ProcessDisplayWindowBounds | null => {
  if (!storage) return null
  const raw = storage.getItem(windowStorageKeyFor(address))
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (err) {
    throw new Error(`process display window storage is invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  return parseWindowBounds(parsed)
}

export const storeProcessDisplayWindowBounds = (
  config: WindowAddress & { readonly bounds: ProcessDisplayWindowBounds },
  storage: StorageLike | null = browserStorage(),
): void => {
  if (!storage) return
  storage.setItem(windowStorageKeyFor(config), JSON.stringify(config.bounds))
}
