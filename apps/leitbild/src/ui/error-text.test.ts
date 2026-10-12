import { describe, expect, test } from 'bun:test'
import {
  CAPACITY_TEXT, errorDiagnostic, GENERIC_ERROR_TEXT, HOST_UNREACHABLE_TEXT, MODULE_UNAVAILABLE_TEXT, OUTCOME_UNKNOWN_TEXT,
  plainError, plainErrorText, TRANSPORT_LOST_TEXT, WORKSPACE_GONE_TEXT,
} from './error-text.ts'

const failure = (code: string, message: string, status?: number) =>
  Object.assign(new Error(message), { code, ...(status === undefined ? {} : { status }) })

describe('plain error text', () => {
  test('replaces Bun\'s raw socket message with an explicit reload, keeping the code', () => {
    const raw = 'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()'
    expect(plainError(failure('module_outcome_unknown', raw, 504))).toEqual({
      text: TRANSPORT_LOST_TEXT, code: 'module_outcome_unknown', status: 504, action: 'reload',
    })
    expect(TRANSPORT_LOST_TEXT).toBe('Lost the connection to the simulation. Reload to reconnect.')
    expect(plainErrorText(new Error(raw))).toBe(TRANSPORT_LOST_TEXT)
  })

  test('maps the Host and Module failure codes to plain text', () => {
    expect(plainError(failure('module_outcome_unknown', 'Module did not answer', 504))).toMatchObject({ text: OUTCOME_UNKNOWN_TEXT, action: 'check' })
    expect(plainError(failure('module_unavailable', 'connect failed', 503))).toMatchObject({ text: MODULE_UNAVAILABLE_TEXT, action: 'try-again' })
    expect(plainError(failure('service_unavailable', 'Busy', 503))).toMatchObject({ text: CAPACITY_TEXT, action: 'wait' })
    expect(plainError(failure('module_unavailable', 'Module discovery returned HTTP 500'))).toMatchObject({ text: MODULE_UNAVAILABLE_TEXT, action: 'try-again' })
    expect(plainError(failure('workspace_capacity_exceeded', 'World Workspace runtime capacity (64) is occupied', 503)).text).toBe(CAPACITY_TEXT)
    expect(plainError(failure('workspace_not_found', 'Workspace not found', 404)).text).toBe(WORKSPACE_GONE_TEXT)
    expect(plainError(failure('module_contract_invalid', 'Invalid input: expected string, received undefined')).text).toBe(MODULE_UNAVAILABLE_TEXT)
  })

  test('tells a lost browser connection apart from a lost simulation', () => {
    expect(plainError(new TypeError('Failed to fetch'))).toMatchObject({ text: HOST_UNREACHABLE_TEXT, code: null, status: null })
    expect(plainErrorText(new TypeError('Load failed'))).toBe(HOST_UNREACHABLE_TEXT)
    expect(plainErrorText(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(HOST_UNREACHABLE_TEXT)
  })

  test('keeps a Module\'s own sentence, but never raw diagnostics', () => {
    expect(plainErrorText(failure('capability_refused', 'This Run is paused. Resume it first.', 409))).toBe('This Run is paused. Resume it first.')
    expect(plainErrorText(failure('capability_invocation_failed', 'Module Capability invocation returned HTTP 500', 500))).toBe(GENERIC_ERROR_TEXT)
    expect(plainErrorText(failure('invalid_request', '[{"code":"invalid_type"}]', 400))).toBe(GENERIC_ERROR_TEXT)
    expect(plainErrorText(new Error('TypeError: x is undefined'))).toBe(GENERIC_ERROR_TEXT)
    expect(plainErrorText(undefined)).toBe(GENERIC_ERROR_TEXT)
    expect(plainErrorText('Type a question first')).toBe('Type a question first')
  })

  test('the diagnostic keeps the code and the raw message for the console', () => {
    expect(errorDiagnostic(failure('module_outcome_unknown', 'socket closed', 504))).toBe('module_outcome_unknown · HTTP 504 · socket closed')
  })
})
