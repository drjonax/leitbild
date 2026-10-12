// Deep links for the landing page's modals (plan v2 §2): one namespace per
// parameter, `?guide=<page>&card=<card>` and `?demos` / `?demos=<moduleId>:<id>`.
// Opening pushes, paging replaces, Back or × removes. Modals never stack: the
// guide's "Try …" replaces `?guide` with `?demos=…`.

export type ModalRoute =
  | { readonly kind: 'none' }
  | { readonly kind: 'guide'; readonly page: string; readonly card: string | null }
  | { readonly kind: 'demos'; readonly demo: string | null }

/** Why Modal.svelte closed; 'programmatic' is `open = false` from the caller (e.g. Back). */
export type ModalCloseReason = 'escape' | 'close-button' | 'backdrop' | 'programmatic'

export const NO_MODAL: ModalRoute = { kind: 'none' }

const token = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/
const tokenOrNull = (value: string | null): string | null => value !== null && token.test(value) ? value : null

/** `world:halden-offsite-power-restoration`, the key a featured demo is linked by. */
export const demoKey = (definition: { readonly moduleId: string; readonly id: string }): string => `${definition.moduleId}:${definition.id}`

/**
 * Reads the modal from a query. `?guide` without a valid page opens the first
 * page (`start`); the guide validates the page id against its own content.
 * `?demos=<anything>` keeps the raw key so the Demos modal can say "That demo
 * is no longer featured." for an unknown or malformed one.
 */
export const readModalRoute = (search: string | URLSearchParams): ModalRoute => {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  if (params.has('guide')) {
    return { kind: 'guide', page: tokenOrNull(params.get('guide')) ?? 'start', card: tokenOrNull(params.get('card')) }
  }
  if (params.has('demos')) {
    const demo = params.get('demos')
    return { kind: 'demos', demo: demo === null || demo === '' ? null : demo }
  }
  return NO_MODAL
}

/** The URL with this modal's parameters; all other parameters and the hash are kept. */
export const modalRouteUrl = (route: ModalRoute, current: string | URL): string => {
  const url = new URL(current)
  url.searchParams.delete('guide')
  url.searchParams.delete('card')
  url.searchParams.delete('demos')
  if (route.kind === 'guide') {
    url.searchParams.set('guide', route.page)
    if (route.card !== null) url.searchParams.set('card', route.card)
  }
  if (route.kind === 'demos') url.searchParams.set('demos', route.demo ?? '')
  // `?demos=` reads better as `?demos`.
  const search = url.searchParams.toString().replace(/(^|&)demos=(?=&|$)/, '$1demos')
  return `${url.pathname}${search ? `?${search}` : ''}${url.hash}`
}

/** Links from other pages (the Workspace page's "Getting started"). */
export const guideHref = (page = 'start', card: string | null = null): string =>
  modalRouteUrl({ kind: 'guide', page, card }, 'https://leitbild.invalid/workspaces')

export const demosHref = (demo: string | null = null): string =>
  modalRouteUrl({ kind: 'demos', demo }, 'https://leitbild.invalid/workspaces')

export interface ModalUrlPort {
  readonly location: { readonly href: string }
  readonly history: Pick<History, 'pushState' | 'replaceState' | 'back' | 'state'>
  addEventListener(type: 'popstate', listener: () => void): void
  removeEventListener(type: 'popstate', listener: () => void): void
}

export interface ModalUrlController {
  route(): ModalRoute
  /** Opening a modal pushes its parameter. */
  open(route: ModalRoute): void
  /** Changing page or slide, or switching guide → Demos, replaces it. */
  replace(route: ModalRoute): void
  /** × or Esc: Back when this page pushed the entry, otherwise replace (deep link). */
  close(): void
  /** Back/Forward: the route now in the URL. */
  subscribe(listener: (route: ModalRoute) => void): () => void
  destroy(): void
}

const PUSHED = 'leitbildModal'
const pushedByUs = (state: unknown): boolean =>
  typeof state === 'object' && state !== null && (state as Record<string, unknown>)[PUSHED] === true

export const createModalUrl = (port: ModalUrlPort): ModalUrlController => {
  const listeners = new Set<(route: ModalRoute) => void>()
  const route = (): ModalRoute => readModalRoute(new URL(port.location.href).search)
  const onPop = (): void => {
    const current = route()
    for (const listener of listeners) listener(current)
  }
  port.addEventListener('popstate', onPop)
  return {
    route,
    open: next => {
      if (next.kind === 'none') return
      port.history.pushState({ [PUSHED]: true }, '', modalRouteUrl(next, port.location.href))
    },
    replace: next => {
      port.history.replaceState(port.history.state, '', modalRouteUrl(next, port.location.href))
    },
    close: () => {
      if (route().kind === 'none') return
      if (pushedByUs(port.history.state)) port.history.back()
      else port.history.replaceState(port.history.state, '', modalRouteUrl(NO_MODAL, port.location.href))
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    destroy: () => {
      port.removeEventListener('popstate', onPop)
      listeners.clear()
    },
  }
}
