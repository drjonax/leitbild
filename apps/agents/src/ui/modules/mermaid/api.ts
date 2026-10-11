// Mermaid API loader — lazy import of the installed dependency, cached in module scope.
//
// Mermaid 11's ESM build does not auto-attach to globalThis.mermaid the way
// older UMD builds did. We hold the resolved API as `mermaidApi` for
// synchronous access (e.g. from reRenderAllMermaid).
//
// `suppressErrorRendering: true` makes render() throw on bad syntax instead
// of returning the bomb-icon SVG — callers substitute their own fallback UI.
//
// Failure policy: if a release chunk cannot load, ensureMermaid() resolves to
// `null` (not rejects). A rejected load stays null for the session — no
// auto-retry. The visible diagram fallback preserves the source; reloading
// the page obtains the current release entry point and its chunk names.

export type MermaidApi = {
  render: (id: string, source: string) => Promise<{ svg: string }>
  initialize: (config: Record<string, unknown>) => void
}

let mermaidReady: Promise<MermaidApi | null> | null = null
let mermaidApi: MermaidApi | null = null

export const mermaidThemeForCurrentMode = (): string =>
  document.documentElement.classList.contains('dark') ? 'dark' : 'neutral'

const initConfig = () => ({
  startOnLoad: false,
  securityLevel: 'strict' as const,
  theme: mermaidThemeForCurrentMode(),
  suppressErrorRendering: true,
})

export const ensureMermaid = (): Promise<MermaidApi | null> => {
  if (mermaidReady) return mermaidReady
  mermaidReady = import('mermaid')
    .then((m: { default: MermaidApi }) => {
      m.default.initialize(initConfig())
      mermaidApi = m.default
      return m.default
    })
    .catch((err: unknown) => {
      console.warn('[mermaid] load failed — diagram rendering unavailable:', err)
      mermaidApi = null
      return null
    })
  return mermaidReady
}

// Synchronous accessor — returns null before the first successful load and
// after a failed load. Used by reRenderAllMermaid which only makes sense
// when the api is already known to be available.
export const getMermaidApi = (): MermaidApi | null => mermaidApi

// Re-apply configuration (e.g. after a theme flip). No-op if api unavailable.
export const reinitMermaid = (): void => {
  if (mermaidApi) mermaidApi.initialize(initConfig())
}

// Mermaid 11's render() is NOT safe to call in parallel — it uses a shared
// internal DOM workspace per module instance, and concurrent invocations
// silently produce empty SVG strings for some calls (not errors — empty
// strings). Symptom: rendering N mermaid blocks at once leaves some
// wrappers with no SVG inside.
//
// leitbild renders every message's mermaid blocks via void-ed post-processors
// (render-message.ts), so N messages with diagrams arrive in parallel during
// room switch and a fraction silently lose. Bounded-memory serial queue:
// a busy flag plus a waiter array. Each concurrent caller either runs
// immediately (if idle) or awaits a slot. Memory is O(in-flight callers)
// rather than O(session render count).
let mermaidBusy = false
const mermaidWaiters: Array<() => void> = []

export const renderQueued = async (
  api: MermaidApi,
  id: string,
  source: string,
): Promise<{ svg: string }> => {
  if (mermaidBusy) await new Promise<void>((resolve) => mermaidWaiters.push(resolve))
  mermaidBusy = true
  try {
    return await api.render(id, source)
  } finally {
    mermaidBusy = false
    mermaidWaiters.shift()?.()
  }
}

// Module-level monotonic id for SVG roots. Date.now()-based ids can
// collide across rapid back-to-back renders (Date.now() resolution is 1ms
// but a serial queue can drain multiple renders per ms after the first
// one warms up). Mermaid uses the caller-supplied id as the SVG root
// element id; two SVGs with the same id is invalid HTML.
let mermaidIdCounter = 0
export const nextMermaidId = (prefix: string = 'mermaid'): string =>
  `${prefix}-${++mermaidIdCounter}`
