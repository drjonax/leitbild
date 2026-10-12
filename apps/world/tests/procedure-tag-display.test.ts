import { describe, expect, test } from 'bun:test'
import { embeddedViewFragment, workspaceIdSchema } from '@leitbild/contracts'
import type { SimulationRunId } from '../src/core/model/index.ts'
import type { PackProcedureContribution, PackProcedureTagDisplay } from '../src/core/packs/protocol.ts'
import { processPlantPackView } from '../src/packs/process-plant/ui-pack.ts'
import type { ProcedureTagValidation, ProcedureTagValue } from '../src/ui/procedures/procedure-client.ts'
import {
  procedureTagBindingLine,
  procedureTagDeclared,
  procedureTagDisplayEnvelope,
  procedureTagDisplayPlan,
  procedureTagDisplaySource,
} from '../src/ui/procedures/procedure-tag-display.ts'

const workspaceId = workspaceIdSchema.parse('11111111-1111-4111-8111-111111111111')
const runId = 'run-test' as SimulationRunId
const provider = processPlantPackView.procedures
const resolved: ProcedureTagValidation = {
  id: 'PT-455',
  status: 'resolved-with-warnings',
  signal: { path: 'pressurizer.pressureMPa', label: 'Pressurizer pressure' },
  measuredOn: 'pressurizer',
  warnings: ['Conversion from MPa to psig is unavailable'],
}

describe("a clicked procedure tag's display", () => {
  test('says a tag the unit model lacks, or one not yet checked, is not drawn', () => {
    expect(procedureTagDisplayPlan('plant:a', { id: 'SI-SIG', status: 'missing', warnings: [] }, provider))
      .toEqual({ kind: 'not-in-model', message: "Not in this unit's plant model" })
    expect(procedureTagDisplayPlan('plant:a', undefined, provider))
      .toEqual({ kind: 'unchecked', message: "Not checked against this unit's plant model" })
  })

  test('says why no display can be drawn where the Pack names none', () => {
    const { tagDisplay: _drawn, ...drawsNone } = provider
    expect(procedureTagDisplayPlan('plant:a', resolved, drawsNone as PackProcedureContribution))
      .toEqual({ kind: 'no-display', message: 'No process display can be drawn for this tag', reason: "this unit's Pack draws no process displays" })
    const { measuredOn: _equipment, ...unplaced } = resolved
    expect(procedureTagDisplayPlan('plant:a', unplaced, provider))
      .toEqual({ kind: 'no-display', message: 'No process display can be drawn for this tag', reason: 'the model names no equipment it is measured on' })
  })

  test("draws the Pack's display of the equipment the tag is measured on", () => {
    const plan = procedureTagDisplayPlan('plant:a', resolved, provider)
    if (plan.kind !== 'display') throw new Error(`expected a display, not ${plan.kind}`)
    expect(plan.display.title).toBe('PT-455: Pressurizer pressure')
    expect(JSON.parse(plan.display.state)).toEqual({ detail: { plantId: 'plant:a', components: ['pressurizer'] } })
  })

  test('frames the display as a read-only embedded view of the Run, at the tallest height a view takes', () => {
    const display: PackProcedureTagDisplay = {
      viewType: 'process-plant.display',
      title: 'PT-455: Pressurizer pressure',
      state: '{"detail":{"plantId":"plant:a","components":["pressurizer"]}}',
      drawQuery: () => { throw new Error('not drawn here') },
    }
    const envelope = procedureTagDisplayEnvelope({ workspaceId, simulationRunId: runId, display })
    expect(JSON.parse(JSON.stringify(envelope))).toEqual({
      moduleId: 'world',
      subject: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runId },
      viewType: 'process-plant.display',
      title: 'PT-455: Pressurizer pressure',
      height: 960,
      state: display.state,
    })
    expect(procedureTagDisplaySource(envelope)).toBe(`/workspaces/${workspaceId}/world/embed/process-plant.display${embeddedViewFragment(envelope)}`)
    expect(() => procedureTagDisplayEnvelope({ workspaceId, simulationRunId: runId, display: { ...display, title: 'x'.repeat(121) } })).toThrow()
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
