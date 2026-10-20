/** Writes the old path's characterization record (T01) that display-characterization.test.ts compares with.
 * Run it only to re-baseline, deliberately, on the old path:
 *   bun tests/display-characterization/record.ts */
import { join } from 'node:path'
import { observeOldPath, STATES } from './old-path.ts'
import { observeProposalFlow } from './proposal-flow.ts'
import { observeListings } from './listings.ts'

const record = {
  about: 'T01 characterization of the old display path (plan v3.1 Appendix F), recorded at bacf7a115 on the 4-loop PWR reference Plant.',
  states: Object.fromEntries(STATES.map(state => [state.id, observeOldPath(state)])),
  proposalFlow: await observeProposalFlow(),
  listings: observeListings(),
}
const target = join(import.meta.dir, '../fixtures/display-characterization/old-path.json')
await Bun.write(target, JSON.stringify(record, null, 2) + '\n')
console.log(`Recorded ${target}`)
