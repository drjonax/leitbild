import { gridVoltageStops, type GridVoltageClassId } from './grid-map-palette.ts'

// Tile zoom from which each kind of grid feature is drawn. The tile build gives
// every feature exactly this minimum zoom and the reference style draws it from
// the same zoom, so no tile carries a feature the style hides. Dependency-free:
// the browser style and the build-side tile projection both import it.

export type GridVoltageValues<T> = Readonly<Record<GridVoltageClassId, T>>

/** Voltage class of a tile's `maxVoltageKv`, the same `step` the style evaluates over `gridVoltageStops`. */
export const gridVoltageClassOf = (maxVoltageKv: number | null): GridVoltageClassId => {
  if (maxVoltageKv === null) return 'unknown'
  if (maxVoltageKv >= gridVoltageStops.kv420) return 'kv420'
  if (maxVoltageKv >= gridVoltageStops.kv300) return 'kv300'
  if (maxVoltageKv >= gridVoltageStops.kv220) return 'kv220'
  if (maxVoltageKv >= gridVoltageStops.kv132) return 'kv132'
  if (maxVoltageKv >= gridVoltageStops.kv110) return 'kv110'
  return 'kv66'
}

// ≥ 300 kV national, 220 kV from z5, 132 kV from z6, distribution from z8, untagged from z9.
export const gridLineMinZoom: GridVoltageValues<number> = { kv420: 4, kv300: 4, kv220: 5, kv132: 6, kv110: 8, kv66: 8, unknown: 9 }
export const gridSiteMinZoom: GridVoltageValues<number> = { kv420: 5, kv300: 5, kv220: 7, kv132: 7, kv110: 9, kv66: 9, unknown: 9 }

export type GridPlantSizeClass = 'small' | 'medium' | 'large'
/** Inclusive lower bounds of the plant size classes, in MW of nameplate output. */
export const gridPlantOutputStops = { medium: 100, large: 500 } as const
export const gridPlantMinZoom: Readonly<Record<GridPlantSizeClass, number>> = { small: 9, medium: 7, large: 5 }

/** Plant size class by nameplate output; plants without an output take the smallest class. */
export const gridPlantSizeClassOf = (outputMw: number | null): GridPlantSizeClass => {
  if (outputMw === null || outputMw < gridPlantOutputStops.medium) return 'small'
  return outputMw < gridPlantOutputStops.large ? 'medium' : 'large'
}

export const gridGeneratorMinZoom = 9
export const gridTransformerMinZoom = 10
/** Site, plant and generator footprints and busbars are drawn from this zoom; below it a site is one point. */
export const gridFootprintMinZoom = 12
/** Construction, proposed and disused assets are drawn from this zoom at the earliest. */
export const gridNonOperationalMinZoom = 8
/** Only transmission lines (≥ 200 kV class) carry along-line labels. */
export const gridLineLabelMinKv = gridVoltageStops.kv220
