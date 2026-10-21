import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { observeOldPath, STATES } from './display-characterization/old-path.ts'
import { observeProposalFlow } from './display-characterization/proposal-flow.ts'
import { observeListings } from './display-characterization/listings.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// T01 (plan v3.1 Appendix F): today's display path, characterised at the Capability boundary in deterministic Plant
// states. The record is what the new display path is held to (T39 action parity); re-baseline it only on purpose
// with tests/display-characterization/record.ts.
const record = await Bun.file(join(import.meta.dir, 'fixtures/display-characterization/old-path.json')).json()

describe('T01 old display path: element actions, resets, chips and procedure tag displays', () => {
  for (const state of STATES) {
    test(state.id, () => {
      expect(observeOldPath(state)).toEqual(record.states[state.id])
    })
  }
})

describe('T01 old display path: an operation proposal end to end', () => {
  test('propose, shown on the display, agent may not decide, extend, reject, approve and execute, withdraw', async () => {
    const { citedMargins, ...flow } = await observeProposalFlow()
    expect(flow).toEqual(record.proposalFlow)
    // The cited reading shows its margin to its nearest protection limit (D3 ruling 1).
    expect(citedMargins).toEqual(['N % above LO N % · ALM'])
  })
})

describe('T01 old display path: listings the display window opens', () => {
  test('one listing at a time, with the reason for each it refuses', () => {
    expect(observeListings()).toEqual(record.listings)
  })
})
