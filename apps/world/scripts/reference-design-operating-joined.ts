/** One joined S2 packet: the compact spine packet with each S2 owner's strict
 * section under its own top-level key. This compiler only composes; every
 * value comes from its owner's strict wiki blocks through that owner's
 * section compiler, and Rust owns every law. The spine sections are
 * unchanged but for the PZR cell's ports (G6), so the network and the
 * joined blocks read the same bytes.
 *
 * Sections: `secondary` (the SG secondary owner, prepareOperatingSecondary),
 * `rods` (the rod owner, compileOperatingRods) and `pzrMetal` (the PZR metal
 * and relief owner, G6, joinedPzrSections), whose cell gains the spray and
 * relief ports.
 *
 * The spine is compiled in two passes around the stock-IDA steady solids
 * settle (G18); `settle` produces that steady state.
 *
 * Usage: bun reference-design-operating-joined.ts <wiki root> <pinned IF97 directory> <prepare_steady_solids executable> */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ownedBlock } from './reference-design-operating-pzr'
import { caseSetSections, equipmentOwners, parsePzrHeaterBanks, parsePzrRelief, parsePzrSpray } from './reference-design-operating-pzr-cases'
import { compileOperatingRods } from './reference-design-operating-rods'
import { prepareOperatingSecondary } from './reference-design-operating-sg'
import { nativeSteadySolids, prepareOperatingSpine, type SteadySolidsSettle } from './reference-design-operating-spine'

/** The owners' pages G6 reads, under the LD-01 design root. */
export const pzrMetalPages = {
  equipment: equipmentOwners.heaterBanks.page,
  inventory: equipmentOwners.relief.page,
  thermal: 'systems/primary-coolant/pressurizer-thermal-state.md',
} as const
/** G6's PZR sections (lead plan S2-06): the spine's cell with the spray and
 * relief ports (`caseSetSections`, spray and relief taking no face), and the
 * PZR metal and relief owner's section: the heater banks, heater contact,
 * 304 caloric and shell blocks unchanged (Rust admits them strictly), and the
 * relief receiver at the relief device's calibration backpressure, the
 * containment, held constant as P2's cases hold it. */
export function joinedPzrSections<Cell extends Parameters<typeof caseSetSections>[0]>(
  cell: Cell, pages: Record<keyof typeof pzrMetalPages, string>) {
  const relief = parsePzrRelief(pages.inventory), spray = parsePzrSpray(pages.inventory), banks = parsePzrHeaterBanks(pages.equipment)
  const added = caseSetSections(cell, banks, relief, { relief: { elevation_m: relief.elevation_m }, spray: { elevation_m: spray.elevation_m, bore_m: spray.exitBore_m } })
    .cell.ports.slice(cell.ports.length)
  const ports = [...cell.ports as Cell['ports'][number][], ...added]
  return { cell: { ...cell, ports } as Omit<Cell, 'ports'> & { ports: typeof ports }, pzrMetal: {
    heaterBanks: { banks },
    heaterContact: ownedBlock(pages.equipment, 'Abnormal wall contact and finite heat receivers', 'ld01-pzr-heater-contact'),
    caloric304: ownedBlock(pages.equipment, 'Fixed metal and complementary contact', 'reference-304-caloric'),
    shell: ownedBlock(pages.thermal, 'Shell and head metal', 'ld01-pzr-shell'),
    reliefBackPressure_Pa: relief.calibration.backPressure_Pa } }
}

export async function prepareOperatingJoined(wiki: string, if97: string, settle: SteadySolidsSettle) {
  const spine = await prepareOperatingSpine(wiki, if97, settle)
  const secondary = await prepareOperatingSecondary(wiki)
  const rods = await compileOperatingRods(wiki)
  if (rods.clusters.length !== spine.feedback_reference.achievedRodTravel_m.length)
    throw Error('The rods section must list the source feedback\'s clusters')
  const ids = spine.thermal.secondaries.map(s => s.id)
  if (JSON.stringify(secondary.steamGenerators.map(g => g.id)) !== JSON.stringify(ids))
    throw Error('The secondary section must list the spine thermal secondaries in their order')
  for (const [i, g] of secondary.steamGenerators.entries())
    if (g.volume_m3 !== spine.thermal.secondaries[i]!.volume_m3) throw Error(`SG.${g.id} volume disagrees with its prepared stock`)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const base = join(wiki, 'world/packs/process-plant/reference-designs/ld-01'), names = Object.entries(pzrMetalPages)
  const pages = Object.fromEntries(await Promise.all(names.map(async ([k, p]) => [k, await Bun.file(join(base, p)).text()]))) as Record<keyof typeof pzrMetalPages, string>
  const consumed = names.map(([k, name]) => ({ name, sha256: hash(pages[k as keyof typeof pzrMetalPages]) }))
  const g6 = joinedPzrSections(spine.pzr.cell, pages)
  return { ...spine, identity: 'LD01-JOINED-SPINE-1', secondary, rods,
    pzr: { ...spine.pzr, cell: g6.cell, provenance: { ...spine.pzr.provenance, consumed: [...spine.pzr.provenance.consumed, ...consumed] } },
    pzrMetal: { ...g6.pzrMetal, provenance: { consumed } },
    provenance: { ...spine.provenance, joinedSourceSha256: hash(await Bun.file(import.meta.path).text()) },
    scope: 'Joined S2 inputs: the compact spine packet, its PZR cell with the spray and relief ports (G6), with the SG secondary, rod and PZR metal and relief owners\' strict sections. No trajectory admission.' }
}

if (import.meta.main) {
  const [wiki, if97, settle] = Bun.argv.slice(2)
  if (!wiki || !if97 || !settle || Bun.argv.length !== 5) throw Error('Usage: operating-joined <wiki root> <pinned IF97 directory> <prepare_steady_solids executable>')
  console.log(JSON.stringify(await prepareOperatingJoined(wiki, if97, nativeSteadySolids(settle, wiki))))
}
