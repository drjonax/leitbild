// The browser behind the people session's ports (people-session.ts). The only
// file of the people client that touches window, document and navigator.

import type { PeopleEnvironmentEvent, PeopleLock, PeoplePorts } from './people-session.ts'

/**
 * A version 4 UUID (the screen id Agents validates). `crypto.randomUUID` exists
 * only in secure contexts, and a plain-http LAN origin is not one;
 * `getRandomValues` is available everywhere.
 */
export const uuidV4 = (fill: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>): string => {
  const bytes = fill(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 4122 variant
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const webLock = (): PeopleLock | null => {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (locks === undefined) return null
  return async <T>(name: string, task: () => Promise<T>): Promise<T> => await locks.request(name, async () => await task()) as T
}

const listen = (handler: (event: PeopleEnvironmentEvent) => void): (() => void) => {
  const visibility = (): void => handler({ type: 'visibility' })
  const online = (): void => handler({ type: 'online' })
  const pagehide = (): void => handler({ type: 'pagehide' })
  const pageshow = (event: PageTransitionEvent): void => handler({ type: 'pageshow', persisted: event.persisted })
  // Page Lifecycle: a frozen tab that comes back (Chromium).
  const resume = (): void => handler({ type: 'resume' })
  const storage = (event: StorageEvent): void => {
    if (event.storageArea !== null && event.storageArea !== attemptLocalStorage()) return
    handler({ type: 'storage', key: event.key, newValue: event.newValue })
  }
  document.addEventListener('visibilitychange', visibility)
  document.addEventListener('resume', resume)
  window.addEventListener('online', online)
  window.addEventListener('pagehide', pagehide)
  window.addEventListener('pageshow', pageshow)
  window.addEventListener('storage', storage)
  return () => {
    document.removeEventListener('visibilitychange', visibility)
    document.removeEventListener('resume', resume)
    window.removeEventListener('online', online)
    window.removeEventListener('pagehide', pagehide)
    window.removeEventListener('pageshow', pageshow)
    window.removeEventListener('storage', storage)
  }
}

/** Reading `localStorage` itself throws where site data is blocked. */
const attemptLocalStorage = (): Storage | null => {
  try { return globalThis.localStorage } catch { return null }
}

export const browserPeoplePorts = (): PeoplePorts => ({
  fetch: (input, init) => fetch(input, init),
  localStorage: () => globalThis.localStorage,
  sessionStorage: () => globalThis.sessionStorage,
  timers: {
    set: (callback, ms) => setTimeout(callback, ms),
    clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
  lock: webLock(),
  visible: () => document.visibilityState === 'visible',
  listen,
  randomId: () => uuidV4(bytes => crypto.getRandomValues(bytes)),
  random: () => Math.random(),
  now: () => Date.now(),
  warn: (message, cause) => { if (cause === undefined) console.warn(message); else console.warn(message, cause) },
})
