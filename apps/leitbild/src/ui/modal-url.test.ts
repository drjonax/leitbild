import { describe, expect, test } from 'bun:test'
import { createModalUrl, demoKey, demosHref, guideHref, modalRouteUrl, readModalRoute, type ModalUrlPort } from './modal-url.ts'

/** A tiny in-memory history with popstate, like the browser's. */
const fakeWindow = (href: string) => {
  const entries: Array<{ href: string; state: unknown }> = [{ href, state: null }]
  let index = 0
  const listeners = new Set<() => void>()
  const absolute = (url: string | URL | null | undefined): string => new URL(String(url), entries[index]!.href).href
  const port: ModalUrlPort & { entries: typeof entries; forward(): void } = {
    location: { get href() { return entries[index]!.href } },
    history: {
      get state() { return entries[index]!.state },
      pushState(state, _title, url) {
        entries.splice(index + 1)
        entries.push({ href: absolute(url), state })
        index += 1
      },
      replaceState(state, _title, url) { entries[index] = { href: absolute(url), state } },
      back() {
        if (index === 0) return
        index -= 1
        for (const listener of listeners) listener()
      },
    },
    addEventListener: (_type, listener) => { listeners.add(listener) },
    removeEventListener: (_type, listener) => { listeners.delete(listener) },
    entries,
    forward() {
      if (index >= entries.length - 1) return
      index += 1
      for (const listener of listeners) listener()
    },
  }
  return port
}

describe('modal deep links', () => {
  test('reads the guide page and card, and the Demos key', () => {
    expect(readModalRoute('?guide=plant&card=graphs')).toEqual({ kind: 'guide', page: 'plant', card: 'graphs' })
    expect(readModalRoute('?guide')).toEqual({ kind: 'guide', page: 'start', card: null })
    expect(readModalRoute('?guide=<script>&card=a b')).toEqual({ kind: 'guide', page: 'start', card: null })
    expect(readModalRoute('?demos')).toEqual({ kind: 'demos', demo: null })
    expect(readModalRoute('?demos=world:halden-emergency')).toEqual({ kind: 'demos', demo: 'world:halden-emergency' })
    expect(readModalRoute('?demos=gone')).toEqual({ kind: 'demos', demo: 'gone' })
    expect(readModalRoute('?world=run')).toEqual({ kind: 'none' })
  })

  test('writes one namespace per parameter and keeps other parameters', () => {
    const base = 'https://leitbild.app/workspaces?x=1&guide=start&card=what#top'
    expect(modalRouteUrl({ kind: 'demos', demo: null }, base)).toBe('/workspaces?x=1&demos#top')
    expect(modalRouteUrl({ kind: 'demos', demo: demoKey({ moduleId: 'world', id: 'nordland-corridor-security' }) }, base))
      .toBe('/workspaces?x=1&demos=world%3Anordland-corridor-security#top')
    expect(modalRouteUrl({ kind: 'none' }, base)).toBe('/workspaces?x=1#top')
    expect(guideHref()).toBe('/workspaces?guide=start')
    expect(guideHref('more', 'inspect')).toBe('/workspaces?guide=more&card=inspect')
    expect(demosHref()).toBe('/workspaces?demos')
  })
})

describe('modal history', () => {
  test('opening pushes, paging replaces, × goes back to the landing entry', () => {
    const port = fakeWindow('https://leitbild.app/workspaces')
    const modals = createModalUrl(port)
    modals.open({ kind: 'guide', page: 'start', card: null })
    modals.replace({ kind: 'guide', page: 'world', card: null })
    expect(port.entries.map(entry => new URL(entry.href).search)).toEqual(['', '?guide=world'])
    modals.close()
    expect(port.location.href).toBe('https://leitbild.app/workspaces')
    expect(modals.route()).toEqual({ kind: 'none' })
  })

  test('guide "Try …" replaces ?guide with ?demos, so modals never stack', () => {
    const port = fakeWindow('https://leitbild.app/workspaces')
    const modals = createModalUrl(port)
    modals.open({ kind: 'guide', page: 'world', card: null })
    modals.replace({ kind: 'demos', demo: 'world:nordland-corridor-security' })
    expect(port.entries).toHaveLength(2)
    modals.close()
    expect(port.location.href).toBe('https://leitbild.app/workspaces')
  })

  test('a deep-linked modal closes by replacing, never leaving the site', () => {
    const port = fakeWindow('https://leitbild.app/workspaces?demos=world:halden-emergency')
    const modals = createModalUrl(port)
    modals.close()
    expect(port.entries).toHaveLength(1)
    expect(port.location.href).toBe('https://leitbild.app/workspaces')
  })

  test('Back and Forward report the route so the page can close and reopen the modal', () => {
    const port = fakeWindow('https://leitbild.app/workspaces')
    const modals = createModalUrl(port)
    const seen: string[] = []
    const unsubscribe = modals.subscribe(route => seen.push(route.kind))
    modals.open({ kind: 'demos', demo: null })
    port.history.back()
    port.forward()
    expect(seen).toEqual(['none', 'demos'])
    unsubscribe()
    modals.destroy()
    port.history.back()
    expect(seen).toEqual(['none', 'demos'])
  })
})
