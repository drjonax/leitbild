/** One joined S2 packet: the compact spine packet with each S2 owner's strict
 * section under its own top-level key. This compiler only composes; every
 * value comes from its owner's strict wiki blocks through that owner's
 * section compiler, and Rust owns every law. The spine sections are
 * unchanged, so the network and the joined blocks read the same bytes.
 *
 * Sections: `secondary` (the SG secondary owner, prepareOperatingSecondary)
 * and `rods` (the rod owner, compileOperatingRods). The PZR metal and relief
 * section joins as its compiler lands; a missing section is never stood in
 * for.
 *
 * Usage: bun reference-design-operating-joined.ts <wiki root> <pinned IF97 directory> */
import { createHash } from 'node:crypto'
import { compileOperatingRods } from './reference-design-operating-rods'
import { prepareOperatingSecondary } from './reference-design-operating-sg'
import { prepareOperatingSpine } from './reference-design-operating-spine'

export async function prepareOperatingJoined(wiki: string, if97: string) {
  const spine = await prepareOperatingSpine(wiki, if97)
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
  return { ...spine, identity: 'LD01-JOINED-SPINE-1', secondary, rods,
    provenance: { ...spine.provenance, joinedSourceSha256: hash(await Bun.file(import.meta.path).text()) },
    scope: 'Joined S2 inputs: the compact spine packet unchanged, with the SG secondary and rod owners\' strict sections. The PZR metal and relief section is pending: absent, not stood in for. No trajectory admission.' }
}

if (import.meta.main) {
  const [wiki, if97] = Bun.argv.slice(2)
  if (!wiki || !if97 || Bun.argv.length !== 4) throw Error('Usage: operating-joined <wiki root> <pinned IF97 directory>')
  console.log(JSON.stringify(await prepareOperatingJoined(wiki, if97)))
}
