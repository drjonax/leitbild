import { describe, expect, test } from 'bun:test'
import { embeddedViewFragment, workspaceIdSchema } from '@leitbild/contracts'
import type { SimulationRunId } from '../src/core/model/index.ts'
import type { ProcedureTagValidation, ProcedureTagValue } from '../src/ui/procedures/procedure-client.ts'
import {
  createTagFrameHost,
  procedureTagBindingLine,
  procedureTagDeclared,
  procedureTagDisplayPlan,
  procedureTagDisplaySource,
  procedureTagReadingText,
} from '../src/ui/procedures/procedure-tag-display.ts'
import { defaultDisplayEnvelope } from '../src/ui/process-display/default-display.ts'

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

  test("draws World's default display of the signal the tag names on its unit (P4)", () => {
    expect(procedureTagDisplayPlan('plant:a', 'PT-455', resolved)).toEqual({ kind: 'display', subject: 'plant:a#pressurizer.pressureMPa' })
    const { signal: _signal, ...unbound } = resolved
    expect(procedureTagDisplayPlan('plant:a', 'PT-455', unbound)).toEqual({ kind: 'display', subject: 'plant:a#PT-455' })
  })

  test('frames the composed view as a read-only embedded view of the Run, at the height World gave it', () => {
    const view = { viewType: 'display.vignette', title: 'PT-455', height: 480, state: '{"title":"PT-455"}' }
    const envelope = defaultDisplayEnvelope({ workspaceId, simulationRunId: runId, view })
    expect(JSON.parse(JSON.stringify(envelope))).toEqual({
      moduleId: 'world',
      subject: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runId },
      viewType: 'display.vignette',
      title: 'PT-455',
      height: 480,
      state: view.state,
    })
    expect(procedureTagDisplaySource(envelope)).toBe(`/workspaces/${workspaceId}/world/embed/display.vignette${embeddedViewFragment(envelope)}`)
    expect(() => defaultDisplayEnvelope({ workspaceId, simulationRunId: runId, view: { ...view, title: 'x'.repeat(121) } })).toThrow()
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

describe('the tag dialog hosts its frame as the chat page does', () => {
  const frame = { name: 'tag frame' }
  const origin = 'https://leitbild.test'
  const view = {
    key: 'tag/PT-455/opened', caption: 'From PT-455',
    envelope: { moduleId: 'world', subject: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runId }, viewType: 'display.vignette', title: 'Pressurizer', height: 480, state: '{"title":"Pressurizer"}' },
  }
  const host = () => {
    const posted: Array<{ readonly to: unknown; readonly message: unknown }> = []
    const opened: unknown[] = []
    const frameHost = createTagFrameHost({ origin, frame: () => frame, post: (to, message) => { posted.push({ to, message }) }, open: listing => { opened.push(listing) } })
    return { frameHost, posted, opened }
  }

  test('answers its frame\'s ready with the Host announcement alone, never a display window\'s presentation', () => {
    const { frameHost, posted } = host()
    frameHost.receive({ origin, source: frame, data: { type: 'world:display-frame-ready' } })
    expect(posted).toEqual([{ to: frame, message: { type: 'leitbild:view-host' } }])
    expect(posted.some(entry => (entry.message as { type: string }).type === 'world:display-frame')).toBe(false)
  })

  test('opens a view its frame asks for, as given', () => {
    const { frameHost, opened } = host()
    frameHost.receive({ origin, source: frame, data: { type: 'leitbild:view-open', view } })
    expect(opened).toEqual([view])
    frameHost.receive({ origin, source: frame, data: { type: 'leitbild:view-open', view: { ...view, envelope: { ...view.envelope, height: 9_999 } } } })
    expect(opened).toHaveLength(1)
  })

  test('ignores every other window and origin', () => {
    const { frameHost, posted, opened } = host()
    for (const event of [
      { origin, source: { name: 'another frame' }, data: { type: 'leitbild:view-open', view } },
      { origin: 'https://elsewhere.test', source: frame, data: { type: 'leitbild:view-open', view } },
      { origin, source: { name: 'another frame' }, data: { type: 'world:display-frame-ready' } },
    ]) frameHost.receive(event)
    expect([posted, opened]).toEqual([[], []])
    const unloaded = createTagFrameHost({ origin, frame: () => null, post: () => { throw new Error('posted') }, open: () => { throw new Error('opened') } })
    unloaded.receive({ origin, source: null, data: { type: 'world:display-frame-ready' } })
  })
})
