import { describe, expect, test } from 'bun:test'
import { renderQueued, nextMermaidId } from './api.ts'
import type { MermaidApi } from './api.ts'

// Isolate loader state and browser globals from the rest of the UI suite.
const runLoader = async (source: string): Promise<unknown> => {
  const child = Bun.spawn([process.execPath, '--eval', source], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(stderr).toBe('')
  expect(exitCode).toBe(0)
  return JSON.parse(stdout)
}

describe('installed Mermaid loader', () => {
  test('shares one lazy initialization and retains strict rendering after theme changes', async () => {
    const result = await runLoader(`
      let dark = false
      globalThis.document = { documentElement: { classList: { contains: () => dark } } }
      globalThis.window = { addEventListener: () => {} }
      globalThis.fetch = async () => { throw new Error('Unexpected external dependency request') }
      const { default: mermaid } = await import('mermaid')
      const initialize = mermaid.initialize
      let initializations = 0
      mermaid.initialize = config => { initializations++; initialize(config) }
      const loader = await import('./api.ts')
      const before = loader.getMermaidApi()
      const first = loader.ensureMermaid(), second = loader.ensureMermaid()
      const api = await first
      const initial = mermaid.mermaidAPI.getConfig()
      const initialConfig = { securityLevel: initial.securityLevel, theme: initial.theme, startOnLoad: initial.startOnLoad, suppressErrorRendering: initial.suppressErrorRendering }
      dark = true
      loader.reinitMermaid()
      const updated = mermaid.mermaidAPI.getConfig()
      console.log(JSON.stringify({ before, samePromise: first === second, sameApi: api === mermaid && loader.getMermaidApi() === api, initializations, initialConfig, updatedTheme: updated.theme, updatedSecurity: updated.securityLevel }))
    `)
    expect(result).toEqual({
      before: null,
      samePromise: true,
      sameApi: true,
      initializations: 2,
      initialConfig: { securityLevel: 'strict', theme: 'neutral', startOnLoad: false, suppressErrorRendering: true },
      updatedTheme: 'dark',
      updatedSecurity: 'strict',
    })
  }, 120_000) // A watchdog: the child imports Mermaid, which a loaded machine stretches to seconds.

  test('exposes a failed load to the source-preserving fallback without retrying for every block', async () => {
    const result = await runLoader(`
      const { mock } = await import('bun:test')
      globalThis.document = { documentElement: { classList: { contains: () => false } } }
      let attempts = 0, warnings = 0
      console.warn = () => warnings++
      mock.module('mermaid', () => ({ default: { initialize: () => { attempts++; throw new Error('Initialization failed') }, render: async () => ({ svg: '' }) } }))
      const loader = await import('./api.ts')
      const first = await loader.ensureMermaid(), second = await loader.ensureMermaid()
      console.log(JSON.stringify({ first, second, current: loader.getMermaidApi(), attempts, warnings }))
    `)
    expect(result).toEqual({ first: null, second: null, current: null, attempts: 1, warnings: 1 })
  })
})

describe('renderQueued', () => {
  test('serializes concurrent renders — no re-entrant overlap', async () => {
    let active = 0
    let maxActive = 0
    const mockApi: MermaidApi = {
      initialize: () => {},
      render: async (id, _src) => {
        active += 1
        if (active > maxActive) maxActive = active
        // Simulate the real mermaid 11 bug: re-entry returns empty SVG.
        if (active > 1) {
          active -= 1
          return { svg: '' }
        }
        await new Promise(r => setTimeout(r, 5))
        active -= 1
        return { svg: `<svg id="${id}">ok</svg>` }
      },
    }
    const ids = ['a', 'b', 'c', 'd', 'e']
    const results = await Promise.all(ids.map(id =>
      renderQueued(mockApi, id, 'flowchart LR\nA-->B'),
    ))
    expect(maxActive).toBe(1)
    expect(results.every(r => r.svg.length > 0)).toBe(true)
    expect(results.map(r => r.svg)).toEqual(ids.map(id => `<svg id="${id}">ok</svg>`))
  })

  test('caller still sees rejection from its own render', async () => {
    const errMsg = 'parse error'
    const mockApi: MermaidApi = {
      initialize: () => {},
      render: async (id, _src) => {
        if (id === 'bad') throw new Error(errMsg)
        return { svg: `<svg id="${id}"/>` }
      },
    }
    const [r1, r2, r3] = await Promise.allSettled([
      renderQueued(mockApi, 'a', 's'),
      renderQueued(mockApi, 'bad', 's'),
      renderQueued(mockApi, 'c', 's'),
    ])
    expect(r1.status).toBe('fulfilled')
    expect(r2.status).toBe('rejected')
    expect((r2 as PromiseRejectedResult).reason.message).toBe(errMsg)
    // Critical: a failed render must not poison subsequent queue slots.
    expect(r3.status).toBe('fulfilled')
    if (r3.status === 'fulfilled') expect(r3.value.svg).toBe('<svg id="c"/>')
  })
})

describe('nextMermaidId', () => {
  test('monotonic across calls; respects optional prefix', () => {
    const a = nextMermaidId('mermaid')
    const b = nextMermaidId('mermaid')
    expect(a).not.toBe(b)
    const aNum = Number(a.split('-').pop())
    const bNum = Number(b.split('-').pop())
    expect(bNum).toBeGreaterThan(aNum)
    const retheme = nextMermaidId('mermaid-retheme')
    expect(retheme.startsWith('mermaid-retheme-')).toBe(true)
  })
})
