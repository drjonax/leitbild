import type { PanelKey } from './panel-key.ts'

/**
 * The Pack-agnostic World key router. It owns no keymap: it decides only
 * whether a key may reach the open surface panel that declares one, and the
 * panel says whether it handled the key. A handled key has its default action
 * prevented, so a focused button never also activates natively; repeats of a
 * handled key are swallowed, never delivered again.
 */

export interface PanelKeyEvent extends PanelKey {
  readonly repeat: boolean
  /** Ctrl, Meta or Alt held: the key belongs to the browser or the system. */
  readonly modified: boolean
  /** An input method is composing text. */
  readonly composing: boolean
  /** Another handler already consumed the key. */
  readonly defaultPrevented: boolean
}

/** What the World surface looks like at the moment of a key press. */
export interface PanelKeySurface {
  readonly windowFocused: boolean
  /** Any modal dialog is open. */
  readonly modalOpen: boolean
  /** The operator is placing a new object on the map. */
  readonly placementActive: boolean
  /** Focus is in a field that takes typed text. */
  readonly textEntryFocused: boolean
}

export interface PanelKeyRouterState {
  /** Physical keys whose press the panel handled and which are still down. */
  readonly held: ReadonlySet<string>
}

export const idlePanelKeys: PanelKeyRouterState = { held: new Set() }

export type PanelKeyIgnoreReason =
  | 'blurred'
  | 'modal'
  | 'placement'
  | 'text-entry'
  | 'composing'
  | 'consumed'
  | 'modified'
  | 'repeat'

export type PanelKeyDecision =
  | { readonly kind: 'deliver'; readonly key: PanelKey }
  | { readonly kind: 'swallow' }
  | { readonly kind: 'ignore'; readonly reason: PanelKeyIgnoreReason }

export const panelKeyDecision = (
  state: PanelKeyRouterState,
  event: PanelKeyEvent,
  surface: PanelKeySurface,
): PanelKeyDecision => {
  if (!surface.windowFocused) return { kind: 'ignore', reason: 'blurred' }
  if (surface.modalOpen) return { kind: 'ignore', reason: 'modal' }
  if (surface.placementActive) return { kind: 'ignore', reason: 'placement' }
  if (surface.textEntryFocused) return { kind: 'ignore', reason: 'text-entry' }
  if (event.composing) return { kind: 'ignore', reason: 'composing' }
  if (event.defaultPrevented) return { kind: 'ignore', reason: 'consumed' }
  if (event.modified) return { kind: 'ignore', reason: 'modified' }
  if (event.repeat) return state.held.has(event.code) ? { kind: 'swallow' } : { kind: 'ignore', reason: 'repeat' }
  return { kind: 'deliver', key: { key: event.key, code: event.code, shift: event.shift } }
}

export interface PanelKeyStep {
  readonly state: PanelKeyRouterState
  /** Whether the browser's default action for this key must be prevented. */
  readonly preventDefault: boolean
}

/** One key press: decide, deliver to the panel when allowed, and remember a handled key until it is released. */
export const panelKeyDown = (
  state: PanelKeyRouterState,
  event: PanelKeyEvent,
  surface: PanelKeySurface,
  deliver: (key: PanelKey) => boolean,
): PanelKeyStep => {
  const decision = panelKeyDecision(state, event, surface)
  if (decision.kind === 'ignore') return { state, preventDefault: false }
  if (decision.kind === 'swallow') return { state, preventDefault: true }
  if (!deliver(decision.key)) return { state, preventDefault: false }
  return { state: { held: new Set([...state.held, event.code]) }, preventDefault: true }
}

export const panelKeyUp = (state: PanelKeyRouterState, code: string): PanelKeyRouterState => {
  if (!state.held.has(code)) return state
  const held = new Set(state.held)
  held.delete(code)
  return { held }
}

const nonTextInputTypes = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit'])

/** The focused element as the router sees it. */
export interface FocusedElement {
  readonly tagName: string
  readonly isContentEditable: boolean
  /** An input's `type`. */
  readonly type?: string
}

export const isTextEntryElement = (element: FocusedElement | null): boolean => {
  if (element === null) return false
  if (element.isContentEditable) return true
  const tag = element.tagName.toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  return tag === 'INPUT' && !nonTextInputTypes.has((element.type ?? 'text').toLowerCase())
}

export interface PanelKeyRouterConfig {
  /** Whether the operator is placing a new object on the map. */
  readonly placementActive: () => boolean
  /** The open keymap panel's handler; true when it handled the key. */
  readonly deliver: (key: PanelKey) => boolean
  /** Keys reach the panel only while the World window has focus; the panel can say so. */
  readonly onActiveChange: (active: boolean) => void
}

const focusedElementOf = (target: EventTarget | null): FocusedElement | null =>
  target instanceof HTMLElement
    ? { tagName: target.tagName, isContentEditable: target.isContentEditable, ...(target instanceof HTMLInputElement ? { type: target.type } : {}) }
    : null

/** Installs the one window key listener; returns its removal. */
export const installPanelKeyRouter = (config: PanelKeyRouterConfig): (() => void) => {
  let state = idlePanelKeys
  let focused = document.hasFocus()
  config.onActiveChange(focused)
  const onKeyDown = (event: KeyboardEvent): void => {
    const step = panelKeyDown(state, {
      key: event.key,
      code: event.code,
      shift: event.shiftKey,
      repeat: event.repeat,
      modified: event.ctrlKey || event.metaKey || event.altKey,
      composing: event.isComposing,
      defaultPrevented: event.defaultPrevented,
    }, {
      windowFocused: focused,
      modalOpen: document.querySelector('[aria-modal="true"]') !== null,
      placementActive: config.placementActive(),
      textEntryFocused: isTextEntryElement(focusedElementOf(event.target)),
    }, config.deliver)
    state = step.state
    if (step.preventDefault) event.preventDefault()
  }
  const onKeyUp = (event: KeyboardEvent): void => { state = panelKeyUp(state, event.code) }
  const onBlur = (): void => {
    state = idlePanelKeys
    focused = false
    config.onActiveChange(false)
  }
  const onFocus = (): void => {
    focused = true
    config.onActiveChange(true)
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  window.addEventListener('focus', onFocus)
  return () => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('focus', onFocus)
  }
}
