// The browser behind the people session's ports (people-session.ts). The only
// file of the people client that touches window, document and navigator.

import type { PeopleEnvironmentEvent, PeopleLock, PeoplePorts } from './people-session.ts'

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
  randomId: () => crypto.randomUUID(),
  random: () => Math.random(),
  now: () => Date.now(),
  warn: (message, cause) => { if (cause === undefined) console.warn(message); else console.warn(message, cause) },
})
