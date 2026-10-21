import { describe, expect, test } from 'bun:test'
import { embeddedViewFragment, workspaceIdSchema } from '@leitbild/contracts'
import type { SimulationRunId } from '../src/core/model/index.ts'
import type { ProcedureTagValidation, ProcedureTagValue } from '../src/ui/procedures/procedure-client.ts'
import {
  procedureTagBindingLine,
  procedureTagDeclared,
  procedureTagDisplayEnvelope,
  procedureTagDisplayPlan,
  procedureTagDisplaySource,
  procedureTagReadingText,
} from '../src/ui/procedures/procedure-tag-display.ts'

const workspaceId = workspaceIdSchema.parse('11111111-1111-4111-8111-111111111111')
const runId = 'run-test' as SimulationRunId
const resolved: ProcedureTagValidation = {
  id: 'PT-455',
  status: 'resolved-with-warnings',
  signal: { path: 'pressurizer.pressureMPa', label: 'Pressurizer pressure' },
  measuredOn: 'pressurizer',
  warnings: ['Conversion from MPa to psig is unavailable'],
}

describe("a clicked procedure tag's display", () => {
  test('says a tag the unit model lacks, or one not yet checked, is not drawn', () => {
    expect(procedureTagDisplayPlan('plant:a', 'SI-SIG', { id: 'SI-SIG', status: 'missing', warnings: [] }))
      .toEqual({ kind: 'not-in-model', message: "Not in this unit's plant model" })
    expect(procedureTagDisplayPlan('plant:a', 'PT-455', undefined))
      .toEqual({ kind: 'unchecked', message: "Not checked against this unit's plant model" })
  })

  test("draws World's default display of the tag on its unit (P4)", () => {
    expect(procedureTagDisplayPlan('plant:a', 'PT-455', resolved)).toEqual({ kind: 'display', subject: 'plant:a#PT-455' })
  })

  test('frames the composed view as a read-only embedded view of the Run, at the height World gave it', () => {
    const view = { viewType: 'display.vignette', title: 'PT-455', height: 480, state: '{"title":"PT-455"}' }
    const envelope = procedureTagDisplayEnvelope({ workspaceId, simulationRunId: runId, view })
    expect(JSON.parse(JSON.stringify(envelope))).toEqual({
      moduleId: 'world',
      subject: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runId },
      viewType: 'display.vignette',
      title: 'PT-455',
      height: 480,
      state: view.state,
    })
    expect(procedureTagDisplaySource(envelope)).toBe(`/workspaces/${workspaceId}/world/embed/display.vignette${embeddedViewFragment(envelope)}`)
    expect(() => procedureTagDisplayEnvelope({ workspaceId, simulationRunId: runId, view: { ...view, title: 'x'.repeat(121) } })).toThrow()
  })

  test("writes the tag's binding and every warning on it in one line", () => {
    const value: ProcedureTagValue = {
      tagId: 'PT-455' as never,
      label: 'Pressurizer pressure',
      value: 15.5,
      formatted: '15.500 MPa',
      unit: 'MPa',
      quality: 'outside-hard-range',
      path: 'pressurizer.pressureMPa',
      conversionStatus: 'unavailable',
      warning: 'Conversion from MPa to psig is unavailable',
    }
    expect(procedureTagBindingLine(resolved, value))
      .toBe('Bound to pressurizer.pressureMPa · Conversion from MPa to psig is unavailable · quality outside-hard-range')
    expect(procedureTagBindingLine({ ...resolved, status: 'resolved', warnings: [] }, { ...value, quality: 'good', warning: 'another' }))
      .toBe('Bound to pressurizer.pressureMPa · another')
    expect(procedureTagBindingLine({ id: 'SI-SIG', status: 'missing', warnings: [] }, null)).toBe("No signal in this unit's plant model")
    expect(procedureTagBindingLine(undefined, null)).toBe("Binding not checked against this unit's plant model")
  })

  test('states what the procedure declares for the tag', () => {
    expect(procedureTagDeclared({ description: 'SI actuation signal', units: 'bool', equipment: 'si-system' }))
      .toBe('SI actuation signal · equipment si-system · in bool')
    expect(procedureTagDeclared({})).toBeNull()
  })
})

test('a two-state reading names what it says; a number keeps its value and unit', () => {
  expect(procedureTagReadingText({ label: 'Reactor trip breaker A closed', value: false, formatted: 'false boolean' })).toBe('Reactor trip breaker A closed: no')
  expect(procedureTagReadingText({ label: 'Pressurizer pressure', value: 15.5, formatted: '15.500 MPa' })).toBe('15.500 MPa')
})
