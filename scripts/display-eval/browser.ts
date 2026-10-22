/** A headless Chrome over CDP for the display acceptance and performance scripts (perf.ts, live-trip.ts,
 * containment.ts). Each caller runs its own Chrome on its own port and profile; nothing here touches a shared
 * browser. Finders search through open shadow roots and same-origin iframes and report page coordinates, so the
 * Host page, the World Run page and the display embed inside it are one search space.
 *
 * The viewport is set with Emulation.setDeviceMetricsOverride, which holds while this session lives: keep one
 * `Page` open for a whole measurement. */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export interface ChromeOptions {
  readonly port: number
  /** A profile directory of this caller's own (never a person's). */
  readonly profile: string
}

const answers = (port: number): Promise<boolean> =>
  fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) }).then(response => response.ok, () => false)

/** Starts headless Chrome on the port unless one answers there already; WebGL stays on (the map needs it). */
export const ensureChrome = async ({ port, profile }: ChromeOptions): Promise<{ readonly started: boolean; readonly stop: () => Promise<void> }> => {
  const stop = async (): Promise<void> => {
    const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.json() as Promise<{ webSocketDebuggerUrl: string }>, () => null)
    if (version === null) return
    const socket = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise(resolve => { socket.addEventListener('open', resolve); socket.addEventListener('error', resolve) })
    socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
    for (let i = 0; i < 50 && await answers(port); i += 1) await sleep(200)
  }
  if (await answers(port)) return { started: false, stop }
  mkdirSync(profile, { recursive: true })
  const child = spawn(CHROME, ['--headless=new', '--hide-scrollbars', '--window-size=1920,1167', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', 'about:blank'],
  { detached: true, stdio: 'ignore' })
  child.unref()
  for (let i = 0; i < 100; i += 1) { if (await answers(port)) return { started: true, stop }; await sleep(200) }
  throw new Error(`headless Chrome did not answer on ${port}`)
}

export interface Target {
  /** A CSS selector the element matches. */
  readonly sel?: string
  /** Text in its aria-label, title or visible text (innermost match). */
  readonly text?: string
  readonly exact?: boolean
  readonly nth?: number
  /** Only inside an element matching this selector. */
  readonly within?: string
}
export interface Hit { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly count: number; readonly tag: string; readonly label: string }

/** In-page helpers, defined once per document as `window.__lb`: a walk over every element across open shadow roots
 * and same-origin iframes with each element's page offset, and the finder over it. */
export const PRELUDE = `(() => {
  if (window.__lb) return window.__lb
  const walk = (root, ox, oy, out, frames) => {
    for (const el of root.querySelectorAll('*')) {
      out.push([el, ox, oy])
      if (el.shadowRoot) walk(el.shadowRoot, ox, oy, out, frames)
      if (el.tagName === 'IFRAME') {
        try {
          const doc = el.contentDocument
          if (doc) { const r = el.getBoundingClientRect(); frames.push(el); walk(doc, ox + r.left + el.clientLeft, oy + r.top + el.clientTop, out, frames) }
        } catch {}
      }
    }
    return out
  }
  const everything = () => walk(document, 0, 0, [], [])
  const shown = el => { const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const s = el.ownerDocument.defaultView.getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' }
  const textOf = el => ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '') + ' ' + (el.innerText ?? el.textContent ?? '')
  const inside = (el, sel) => { let n = el; while (n) { if (n.matches && n.matches(sel)) return true; n = n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentNode } return false }
  const find = t => {
    let hits = everything()
    if (t.within) hits = hits.filter(([el]) => inside(el, t.within))
    if (t.sel) hits = hits.filter(([el]) => el.matches(t.sel))
    if (t.text) {
      const want = t.text.toLowerCase()
      hits = hits.filter(([el]) => { const s = textOf(el).trim().toLowerCase(); return t.exact ? s === want || (el.innerText ?? '').trim().toLowerCase() === want : s.includes(want) })
      hits = hits.filter(([el]) => !hits.some(([o]) => o !== el && el.contains(o)))
    }
    hits = hits.filter(([el]) => shown(el))
    const hit = hits[t.nth ?? 0]
    if (!hit) return null
    const [el, ox, oy] = hit
    const r = el.getBoundingClientRect()
    return { x: ox + r.left, y: oy + r.top, w: r.width, h: r.height, count: hits.length, tag: el.tagName.toLowerCase(), label: textOf(el).trim().slice(0, 120) }
  }
  /** Every same-origin document: the page's and each iframe's, with the iframe's src. */
  const documents = () => { const frames = []; walk(document, 0, 0, [], frames); return [{ doc: document, frame: null }, ...frames.map(frame => ({ doc: frame.contentDocument, frame }))] }
  window.__lb = { walk, everything, shown, textOf, inside, find, documents }
  return window.__lb
})()`

export interface Page {
  readonly send: (method: string, params?: Record<string, unknown>) => Promise<any>
  /** Evaluates in the top document, with `window.__lb` defined. */
  readonly eval: <T = unknown>(expression: string) => Promise<T>
  readonly goto: (url: string) => Promise<void>
  readonly find: (target: Target) => Promise<Hit | null>
  readonly waitFor: (target: Target, timeoutMs?: number) => Promise<Hit>
  readonly until: (expression: string, timeoutMs?: number, everyMs?: number) => Promise<number>
  readonly click: (target: Target | Hit) => Promise<Hit>
  readonly key: (key: string) => Promise<void>
  readonly size: (width: number, height: number) => Promise<void>
  readonly shot: (path: string) => Promise<void>
  readonly on: (method: string, listener: (params: any) => void) => () => void
  readonly console: string[]
  readonly close: () => Promise<void>
}

/** Opens a fresh tab and holds a CDP session on it. */
export const openPage = async (port: number, width = 1920, height = 1080): Promise<Page> => {
  const created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json() as { id: string; webSocketDebuggerUrl: string }
  const socket = new WebSocket(created.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject) })
  let id = 0
  const pending = new Map<number, (value: any) => void>()
  const listeners = new Map<string, Set<(params: any) => void>>()
  const consoleLines: string[] = []
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id) }
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) consoleLines.push(`${message.params.type}: ${message.params.args.map((arg: any) => arg.value ?? arg.description ?? '').join(' ').slice(0, 300)}`)
    if (message.method === 'Runtime.exceptionThrown') consoleLines.push(`exception: ${String(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text).slice(0, 300)}`)
    if (message.method !== undefined) for (const listener of listeners.get(message.method) ?? []) listener(message.params)
  })
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
    id += 1
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)) }, 120_000)
    pending.set(id, message => { clearTimeout(timer); if (message.error) reject(new Error(`CDP ${method}: ${message.error.message}`)); else resolve(message.result) })
    socket.send(JSON.stringify({ id, method, params }))
  })
  await send('Page.enable'); await send('Runtime.enable'); await send('Page.bringToFront')
  const size = async (w: number, h: number): Promise<void> => { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }) }
  await size(width, height)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = await send('Runtime.evaluate', { expression: `(() => { const lb = ${PRELUDE}; return (${expression}) })()`, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(`eval: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    return result.result?.value as T
  }
  const find = (target: Target): Promise<Hit | null> => evaluate<Hit | null>(`lb.find(${JSON.stringify(target)})`)
  const waitFor = async (target: Target, timeoutMs = 30_000): Promise<Hit> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = await find(target)
      if (hit) return hit
      if (Date.now() > deadline) throw new Error(`not found within ${timeoutMs} ms: ${JSON.stringify(target)}`)
      await sleep(100)
    }
  }
  /** Polls until the expression is truthy; resolves with the ms it took. */
  const until = async (expression: string, timeoutMs = 30_000, everyMs = 50): Promise<number> => {
    const started = Date.now()
    for (;;) {
      if (await evaluate<boolean>(`Boolean(${expression})`)) return Date.now() - started
      if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms: ${expression.slice(0, 200)}`)
      await sleep(everyMs)
    }
  }
  const click = async (target: Target | Hit): Promise<Hit> => {
    const hit = 'x' in target ? target : await waitFor(target)
    const x = hit.x + hit.w / 2, y = hit.y + hit.h / 2
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    return hit
  }
  const key = async (name: string): Promise<void> => {
    const code = ({ Escape: 27, Enter: 13, ArrowRight: 39, ArrowLeft: 37 } as Record<string, number>)[name] ?? 0
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code })
  }
  return {
    send, eval: evaluate, find, waitFor, until, click, key, size, console: consoleLines,
    goto: async url => { await send('Page.navigate', { url }) },
    shot: async path => {
      mkdirSync(dirname(path), { recursive: true })
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(path, Buffer.from(shot.data, 'base64'))
    },
    on: (method, listener) => {
      const set = listeners.get(method) ?? new Set()
      set.add(listener)
      listeners.set(method, set)
      return () => { set.delete(listener) }
    },
    close: async () => {
      socket.close()
      await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`).catch(() => undefined)
    },
  }
}

/** A loopback origin only: these scripts never drive production. */
export const loopbackOrigin = (value: string | undefined): string => {
  if (value === undefined) throw new Error('--origin=http://127.0.0.1:<port> is required')
  const url = new URL(value)
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(`--origin must be a loopback stack, not ${url.hostname}`)
  return url.origin
}

/** `--name=value` options and bare flags. */
export const options = (argv: ReadonlyArray<string>): { readonly get: (name: string) => string | undefined; readonly has: (name: string) => boolean; readonly rest: ReadonlyArray<string> } => ({
  get: name => argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3),
  has: name => argv.includes(`--${name}`),
  rest: argv.filter(argument => !argument.startsWith('--')),
})
