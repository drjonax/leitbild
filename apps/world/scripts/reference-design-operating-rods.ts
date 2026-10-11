/** The S2 `rods` section of the spine packet: the 52 moving spider-and-bodies
 * (H7), their steady guide passages (F1 (a), H4), the network cells they sweep
 * and the declared holding-circuit boundary (H6). Values come only from the
 * owners' strict blocks; Rust owns every residual law. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { parseControlAbsorber, controlAbsorberGeometry } from './reference-design-control-absorber'
import { parseFuelConstruction } from './reference-design-fuel-construction'
import { parseFuelHandling, fuelAssemblyPositions } from './reference-design-fuel-handling'
import { parseOperatingHotReference } from './reference-design-operating-fluid'
import { parseColdControlRelease } from './reference-design-control-release'

const positive = z.number().finite().positive()
const rodSchema = z.object({ spiderDrag: z.enum(['pending', 'envelope-disk', 'omitted']),
  passageBlendSpeed_m_s: positive }).strict()
const holdingSchema = z.object({ turbineTripToOpening_s: positive }).strict()
function strictBlock(text: string, fence: string): unknown {
  const rows = [...text.matchAll(new RegExp('^```' + fence + '\\s*\\n([\\s\\S]*?)^```\\s*$', 'gm'))]
  if (rows.length !== 1) throw Error(`Expected one ${fence} block`)
  return JSON.parse(rows[0]![1]!)
}
export const parseS2Rods = (text: string) => rodSchema.parse(strictBlock(text, 'ld01-s2-rods'))
export const parseS2Holding = (text: string) => holdingSchema.parse(strictBlock(text, 'ld01-s2-holding-circuit'))
/** The page's one broad-body law (the cold release record's `broadDrag`):
 * the envelope-disk coefficient its label names, not a new number. */
export function envelopeDiskCoefficient(text: string) {
  const label = parseColdControlRelease(text).broadDrag
  const match = /^quiescent-UPPER-envelope-disk-(\d+(?:\.\d+)?)$/.exec(label)
  if (!match) throw Error(`Unselected broad-drag law ${label}`)
  return positive.parse(Number(match[1]))
}

/** Pages consumed, relative to the LD-01 design root. */
export const OPERATING_RODS_PAGES = [
  'systems/reactor/control-absorber-and-guide-water.md',
  'systems/reactor/fuel-construction.md',
  'systems/reactor/fuel-handling-and-pool.md',
  'model/operating-hot-reference.md',
  'safety/reactor-trip-and-hold.md',
] as const
const sectorNames = ['NE', 'NW', 'SW', 'SE'] as const

/** The selected seated axis-aligned sector split of one body circle, the
 * preparation's own (`operatingFluidGeometry`): a circle on an axis is halved. */
function sectorShares(x: number, y: number, r: number) {
  if ((x !== 0 && Math.abs(x) < r) || (y !== 0 && Math.abs(y) < r)) throw Error('Not the selected seated axis-aligned reference')
  const east = x === 0 ? .5 : x > 0 ? 1 : 0, north = y === 0 ? .5 : y > 0 ? 1 : 0
  return [east * north, (1 - east) * north, (1 - east) * (1 - north), east * (1 - north)]
}

/** Compile the `rods` section from page texts keyed as `OPERATING_RODS_PAGES`. */
export function compileOperatingRodsFrom(texts: Readonly<Record<(typeof OPERATING_RODS_PAGES)[number], string>>) {
  const control = parseControlAbsorber(texts['systems/reactor/control-absorber-and-guide-water.md'])
  const fuel = parseFuelConstruction(texts['systems/reactor/fuel-construction.md'])
  const handling = parseFuelHandling(texts['systems/reactor/fuel-handling-and-pool.md'])
  const hot = parseOperatingHotReference(texts['model/operating-hot-reference.md'])
  const s2 = parseS2Rods(texts['systems/reactor/control-absorber-and-guide-water.md'])
  const holding = parseS2Holding(texts['safety/reactor-trip-and-hold.md'])
  const geometry = controlAbsorberGeometry(control, fuel, handling)
  const assemblies = fuelAssemblyPositions(handling, fuel)
  const pitch = fuel.latticeSide * fuel.pitch_m
  // The source feedback's rod order: the footprint in assembly order.
  const clusters = geometry.sites.map((site, index) => {
    const fa = assemblies.find(a => Math.abs(a.x_m - site.x_m) < 1e-12 && Math.abs(a.y_m - site.y_m) < 1e-12)
    if (!fa) throw Error(`No fuel assembly at cluster site ${site.x},${site.y}`)
    const shares = [0, 0, 0, 0]
    for (const body of geometry.bodySites) {
      const q = sectorShares(site.x_m + body.x_m, site.y_m + body.y_m, control.bodyDiameter_m / 2)
      for (let k = 0; k < 4; k++) shares[k]! += q[k]!
    }
    // Whole and halved bodies, counted exactly, then divided once.
    if (shares.reduce((a, b) => a + b, 0) !== control.rodletsPerCluster) throw Error('Cluster sector shares do not close')
    return { id: 'LD01.CR.' + String(index + 1).padStart(3, '0'), fuel_assembly: fa.id,
      lattice: [Math.round(site.x_m / pitch), Math.round(site.y_m / pitch)],
      sector_shares: shares.map(n => n / control.rodletsPerCluster) }
  })
  if (clusters.length !== control.clusters || geometry.bodySites.length !== control.rodletsPerCluster) throw Error('Invalid 52-cluster footprint')
  const perCluster = (x: number) => x / control.clusters
  const faTop = handling.seatedBottom_m + handling.bottomFittingLength_m + fuel.activeLength_m + fuel.plenumLength_m + handling.topFittingLength_m
  const coreBottom = -fuel.activeLength_m / 2, coreTop = fuel.activeLength_m / 2
  if (control.insertedBodyBottom_m !== handling.seatedBottom_m || Math.abs(control.insertedBodyBottom_m + control.bodyLength_m - faTop) > 1e-12
    || control.spiderBottom_m !== faTop || control.headBottom_m <= coreTop || control.housingTop_m <= control.headBottom_m)
    throw Error('Seated bodies must span the guide from its lower mouth to the FA top below the head')
  return {
    identity: 'ld01-s2-rods',
    clusters,
    bodies: { count: control.rodletsPerCluster, radius_m: control.bodyDiameter_m / 2, length_m: control.bodyLength_m,
      seated_bottom_m: control.insertedBodyBottom_m, mass_kg: perCluster(geometry.moving.b4c_kg + geometry.moving.bodySteel_kg) },
    spider: { mass_kg: control.spiderMass_kg, volume_m3: control.spiderMass_kg / control.steelDensity_kg_m3,
      seated_bottom_m: control.spiderBottom_m, height_m: control.spiderHeight_m, radius_m: control.spiderRadius_m },
    guide: { bore_radius_m: handling.guideInnerDiameter_m / 2, lower_mouth_m: handling.seatedBottom_m, upper_mouth_m: faTop,
      roughness_m: control.guideRoughness_m, lower_mouth_loss: control.endLossEach, upper_mouth_loss: control.endLossEach,
      blend_speed_m_s: s2.passageBlendSpeed_m_s },
    // LOWER spans everything below the core a body can reach; UPPER runs to
    // the head, HOUSING.MAIN to the housing top (the preparation's spans).
    cells: {
      lower: { region: 'LOWER', bottom_m: control.insertedBodyBottom_m - control.bodyLength_m, top_m: coreBottom },
      core: sectorNames.map(name => [
        { region: `CORE.${name}.1`, bottom_m: coreBottom, top_m: 0 },
        { region: `CORE.${name}.2`, bottom_m: 0, top_m: coreTop },
      ]),
      upper: { region: 'UPPER', bottom_m: coreTop, top_m: control.headBottom_m },
      housing_main: { region: 'HOUSING.MAIN', bottom_m: control.headBottom_m, top_m: control.housingTop_m },
    },
    gravity_m_s2: control.gravity_m_s2,
    reference_travel_m: hot.achievedRodTravel_m,
    normal_travel_m: control.normalTravel_m,
    holding: { turbine_trip_to_opening_s: holding.turbineTripToOpening_s },
    spider_drag: s2.spiderDrag === 'envelope-disk'
      ? { selection: 'envelope-disk', coefficient: envelopeDiskCoefficient(texts['systems/reactor/control-absorber-and-guide-water.md']) }
      : { selection: s2.spiderDrag },
  }
}

/** The one strict section compiler: read the owners' pages from the wiki
 * root and return the `rods` section with its page provenance. */
export async function compileOperatingRods(wikiRoot: string) {
  const root = join(wikiRoot, 'world/packs/process-plant/reference-designs/ld-01')
  const texts = Object.fromEntries(await Promise.all(OPERATING_RODS_PAGES.map(async page =>
    [page, await Bun.file(join(root, page)).text()] as const))) as Record<(typeof OPERATING_RODS_PAGES)[number], string>
  return { ...compileOperatingRodsFrom(texts),
    provenance: OPERATING_RODS_PAGES.map(name => ({ name, sha256: createHash('sha256').update(texts[name]).digest('hex') })) }
}

if (import.meta.main) {
  const [wiki, ...rest] = Bun.argv.slice(2)
  if (!wiki || rest.length) throw Error('Usage: reference-design-operating-rods <wiki root>')
  console.log(JSON.stringify(await compileOperatingRods(wiki), null, 1))
}
