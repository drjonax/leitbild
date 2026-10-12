import { describe, expect, test } from 'bun:test'
import {
  idlePanelKeys,
  isTextEntryElement,
  panelKeyDecision,
  panelKeyDown,
  panelKeyUp,
  type PanelKey,
  type PanelKeyEvent,
  type PanelKeySurface,
} from '../src/ui/keys/panel-key-router.ts'

const press = (patch: Partial<PanelKeyEvent> = {}): PanelKeyEvent => ({
  key: 'Enter',
  code: 'Enter',
  shift: false,
  repeat: false,
  modified: false,
  composing: false,
  defaultPrevented: false,
  ...patch,
})

const open: PanelKeySurface = { windowFocused: true, modalOpen: false, placementActive: false, textEntryFocused: false }

describe('World key router decision', () => {
  test('delivers a plain press exactly when nothing makes the router inert, for every combination', () => {
    const flags = [false, true]
    let cases = 0
    for (const windowFocused of flags) for (const modalOpen of flags) for (const placementActive of flags) for (const textEntryFocused of flags)
      for (const composing of flags) for (const defaultPrevented of flags) for (const modified of flags) for (const repeat of flags) for (const held of flags) {
        cases += 1
        const state = held ? { held: new Set(['Enter']) } : idlePanelKeys
        const decision = panelKeyDecision(state, press({ composing, defaultPrevented, modified, repeat }), { windowFocused, modalOpen, placementActive, textEntryFocused })
        const inert = !windowFocused || modalOpen || placementActive || textEntryFocused || composing || defaultPrevented || modified
        const expected = inert ? 'ignore' : repeat ? (held ? 'swallow' : 'ignore') : 'deliver'
        expect(decision.kind).toBe(expected)
      }
    expect(cases).toBe(512)
  })

  test('names the first reason the router stays inert', () => {
    const everything: PanelKeySurface = { windowFocused: false, modalOpen: true, placementActive: true, textEntryFocused: true }
    const reasons = [
      [everything, 'blurred'],
      [{ ...everything, windowFocused: true }, 'modal'],
      [{ ...open, placementActive: true, textEntryFocused: true }, 'placement'],
      [{ ...open, textEntryFocused: true }, 'text-entry'],
    ] as const
    for (const [surface, reason] of reasons) expect(panelKeyDecision(idlePanelKeys, press({ composing: true, defaultPrevented: true, modified: true, repeat: true }), surface)).toEqual({ kind: 'ignore', reason })
    expect(panelKeyDecision(idlePanelKeys, press({ composing: true, defaultPrevented: true, modified: true }), open)).toEqual({ kind: 'ignore', reason: 'composing' })
    expect(panelKeyDecision(idlePanelKeys, press({ defaultPrevented: true, modified: true }), open)).toEqual({ kind: 'ignore', reason: 'consumed' })
    expect(panelKeyDecision(idlePanelKeys, press({ modified: true }), open)).toEqual({ kind: 'ignore', reason: 'modified' })
    expect(panelKeyDecision(idlePanelKeys, press({ repeat: true }), open)).toEqual({ kind: 'ignore', reason: 'repeat' })
  })

  test('passes the key, its physical code and Shift to the panel', () => {
    expect(panelKeyDecision(idlePanelKeys, press({ key: 'E', code: 'KeyE', shift: true }), open)).toEqual({ kind: 'deliver', key: { key: 'E', code: 'KeyE', shift: true } })
  })
})

describe('World key router steps', () => {
  const recorder = (handles: (key: PanelKey) => boolean) => {
    const delivered: PanelKey[] = []
    return { delivered, deliver: (key: PanelKey) => { delivered.push(key); return handles(key) } }
  }

  test('a held key the panel handled reaches it once; every repeat is prevented, so a focused button never activates too', () => {
    const panel = recorder(() => true)
    let step = panelKeyDown(idlePanelKeys, press(), open, panel.deliver)
    expect(step.preventDefault).toBe(true)
    for (let index = 0; index < 5; index += 1) {
      step = panelKeyDown(step.state, press({ repeat: true }), open, panel.deliver)
      expect(step.preventDefault).toBe(true)
    }
    expect(panel.delivered).toHaveLength(1)
    const released = panelKeyUp(step.state, 'Enter')
    expect(released.held.size).toBe(0)
    expect(panelKeyDown(released, press({ repeat: true }), open, panel.deliver).preventDefault).toBe(false)
    expect(panel.delivered).toHaveLength(1)
  })

  test('a key the panel does not handle keeps its default action and its repeats are not swallowed', () => {
    const panel = recorder(() => false)
    const step = panelKeyDown(idlePanelKeys, press({ key: 'ArrowLeft', code: 'ArrowLeft' }), open, panel.deliver)
    expect(step.preventDefault).toBe(false)
    expect(step.state.held.size).toBe(0)
    expect(panelKeyDown(step.state, press({ key: 'ArrowLeft', code: 'ArrowLeft', repeat: true }), open, panel.deliver).preventDefault).toBe(false)
    expect(panel.delivered).toHaveLength(1)
  })

  test('an inert surface reaches no panel and prevents nothing', () => {
    const panel = recorder(() => true)
    for (const surface of [{ ...open, modalOpen: true }, { ...open, placementActive: true }, { ...open, textEntryFocused: true }, { ...open, windowFocused: false }]) {
      expect(panelKeyDown(idlePanelKeys, press(), surface, panel.deliver)).toEqual({ state: idlePanelKeys, preventDefault: false })
    }
    expect(panel.delivered).toHaveLength(0)
  })

  test('releasing a key that was never handled leaves the state as it is', () => {
    expect(panelKeyUp(idlePanelKeys, 'KeyN')).toBe(idlePanelKeys)
  })
})

describe('text entry focus', () => {
  test('text fields hold keys; buttons and choices do not', () => {
    for (const type of ['text', 'search', 'number', 'email', 'password', 'url', 'tel', 'date', undefined]) {
      expect(isTextEntryElement({ tagName: 'INPUT', isContentEditable: false, ...(type ? { type } : {}) })).toBe(true)
    }
    for (const type of ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']) {
      expect(isTextEntryElement({ tagName: 'input', isContentEditable: false, type })).toBe(false)
    }
    expect(isTextEntryElement({ tagName: 'TEXTAREA', isContentEditable: false })).toBe(true)
    expect(isTextEntryElement({ tagName: 'SELECT', isContentEditable: false })).toBe(true)
    expect(isTextEntryElement({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isTextEntryElement({ tagName: 'BUTTON', isContentEditable: false })).toBe(false)
    expect(isTextEntryElement({ tagName: 'CANVAS', isContentEditable: false })).toBe(false)
    expect(isTextEntryElement(null)).toBe(false)
  })
})
