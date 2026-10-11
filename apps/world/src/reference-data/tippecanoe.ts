import { tileFeatureIdProperty } from './tile-projection.ts'
import type { TilebuildConfig } from './types.ts'

// Tippecanoe subprocess wrapper. The runner is injectable so tests stub it
// without invoking the binary; the default runner spawns the real process.

export interface TippecanoeRunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type TippecanoeRunner = (cmd: string, args: ReadonlyArray<string>) => Promise<TippecanoeRunResult>

export const defaultTippecanoeRunner: TippecanoeRunner = async (cmd, args) => {
  const proc = Bun.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr }
}

export interface BuildTilesArgs {
  readonly inputGeoJsonPath: string
  readonly outputPmtilesPath: string
  readonly config: TilebuildConfig
  readonly binary?: string
  readonly runner?: TippecanoeRunner
}

const flagArgs = (config: TilebuildConfig): string[] => {
  // Every input feature carries its own `tippecanoe.minzoom`/`maxzoom` from the
  // dataset's tile projection, and nothing may be dropped or degraded silently:
  //   --use-attribute-for-id: the projection's numeric `fid` becomes the MVT feature id.
  //   --drop-rate=1: keep every point at every zoom; the default thins points below the base zoom.
  //   --maximum-tile-bytes with --minimum-detail equal to the default full and low detail (12):
  //     an oversized tile fails the build instead of being re-encoded at lower resolution.
  //   --simplification 10 with --simplify-only-low-zooms: Douglas-Peucker within 10 tile units
  //     (4096 units per tile, so about 1.25 px of a 512 px tile) below the maximum zoom; the
  //     maximum zoom keeps exact geometry, and MapLibre overzooms it beyond.
  //   --no-tiny-polygon-reduction: small footprints stay polygons instead of becoming pixel squares.
  // No --drop-*-as-needed, --coalesce-*, --no-feature-limit or --no-tile-size-limit.
  const args: string[] = [
    '-o', '__placeholder__',
    '--layer', config.outputLayer,
    '--minimum-zoom', String(config.globalMinZoom),
    '--maximum-zoom', String(config.globalMaxZoom),
    `--use-attribute-for-id=${tileFeatureIdProperty}`,
    '--drop-rate=1',
    '--maximum-tile-bytes', String(config.maximumTileBytes),
    '--full-detail=12',
    '--low-detail=12',
    '--minimum-detail=12',
    '--simplification', '10',
    '--simplify-only-low-zooms',
    '--no-tiny-polygon-reduction',
    '--no-progress-indicator',
    '--force',
  ]
  return args
}

export const buildTiles = async (args: BuildTilesArgs): Promise<TippecanoeRunResult> => {
  const runner = args.runner ?? defaultTippecanoeRunner
  const binary = args.binary ?? 'tippecanoe'
  const cliArgs = flagArgs(args.config)
  // Replace the placeholder with the actual output path.
  const outIndex = cliArgs.indexOf('__placeholder__')
  cliArgs[outIndex] = args.outputPmtilesPath
  cliArgs.push(args.inputGeoJsonPath)
  const result = await runner(binary, cliArgs)
  if (result.exitCode !== 0) {
    throw new Error(`tippecanoe failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim() || '<no output>'}`)
  }
  return result
}
