import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { customShapes, internals, surfaces, type CustomShape, type Internal, type Surface } from './openbridge-register.ts'

// The OpenBridge policy's register (§2, §5; apps/world/AGENTS.md): every SVG
// and drawing canvas an operator display draws, in the embed and in the main
// app's displays, is a registered custom shape or a surface OpenBridge paints;
// no entry names a shape that is no longer drawn; and the embed reaches into
// OpenBridge (shadow roots, CSS parts, its custom properties) only where the
// register lists it. Each rule is checked against a planted violation.

const src = join(import.meta.dir, '../src')
const openBridge = join(import.meta.dir, '../node_modules/@oicl/openbridge-webcomponents')

const filesUnder = (dir: string): ReadonlyArray<string> => !existsSync(dir) ? [] : readdirSync(dir).flatMap(name => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? filesUnder(path) : [path]
})

/** Source without comments, so a shape named in prose is not taken for one drawn; lines keep their numbers. */
const withoutComments = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, comment => comment.replace(/[^\n]/g, ''))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')

type Sources = ReadonlyMap<string, string>

/** The operator displays' sources, relative to src, without comments. */
const sourcesUnder = (...roots: ReadonlyArray<string>): Sources => new Map(roots.flatMap(root => filesUnder(join(src, root)))
  .filter(file => /\.(svelte|ts|css)$/.test(file) && !file.endsWith('.test.ts'))
  .map(file => [relative(src, file), withoutComments(readFileSync(file, 'utf8'))] as const))

interface DrawingSite { readonly file: string; readonly line: number; readonly text: string }

/** A start tag from its `<` to its closing `>`, braces and quotes respected. */
const startTag = (code: string, from: number): string => {
  let depth = 0
  let quote: string | null = null
  for (let at = from + 1; at < code.length; at += 1) {
    const char = code[at]!
    if (quote !== null) { if (char === quote) quote = null; continue }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    else if (char === '>' && depth === 0) return code.slice(from, at + 1)
  }
  return code.slice(from)
}

/** Every SVG and canvas a source draws on: an `<svg>` or `<canvas>` element, or a line of code that makes or paints one. */
const drawingSites = (sources: Sources): ReadonlyArray<DrawingSite> => [...sources].flatMap(([file, code]) => {
  const lineOf = (at: number) => code.slice(0, at).split('\n').length
  const elements = file.endsWith('.svelte')
    ? [...code.matchAll(/<(?:svg|canvas)[\s/>]/g)].map(match => ({ file, line: lineOf(match.index!), text: startTag(code, match.index!) }))
    : []
  const made = code.split('\n').flatMap((text, index) =>
    /createElementNS\(|createElement\(\s*['"`](?:canvas|svg)|\.getContext\(|new OffscreenCanvas\b|\bsvg`/.test(text) ? [{ file, line: index + 1, text: text.trim() }] : [])
  return [...elements, ...made]
})

interface Registered { readonly file: string; readonly mark: string; readonly drawn: string; readonly owner: string }

const registeredSites = (shapes: ReadonlyArray<CustomShape>, painted: ReadonlyArray<Surface>): ReadonlyArray<Registered> => [
  ...shapes.flatMap(shape => shape.sites.map(site => ({ ...site, owner: shape.id }))),
  ...painted.map(surface => ({ file: surface.file, mark: surface.mark, drawn: 'canvas', owner: `surface (${surface.paints})` })),
]

/** Drawing sites no registered site claims, or more than one does. */
const unregistered = (sites: ReadonlyArray<DrawingSite>, registered: ReadonlyArray<Registered>): ReadonlyArray<string> => sites.flatMap(site => {
  const claims = registered.filter(entry => entry.file === site.file && site.text.includes(entry.mark))
  if (claims.length === 1) return []
  return [`${site.file}:${site.line} ${site.text.slice(0, 60)} is ${claims.length === 0 ? 'in no register entry' : `claimed by ${claims.map(claim => claim.owner).join(', ')}`}`]
})

/** Registered sites whose file or mark is gone, or whose SVG or canvas is no longer drawn. */
const stale = (registered: ReadonlyArray<Registered>, sources: Sources, sites: ReadonlyArray<DrawingSite>): ReadonlyArray<string> => registered.flatMap(entry => {
  const code = sources.get(entry.file)
  if (code === undefined) return [`${entry.owner}: ${entry.file} is not an operator display source`]
  if (!code.includes(entry.mark)) return [`${entry.owner}: ${entry.file} no longer holds "${entry.mark}"`]
  if ((entry.drawn === 'svg' || entry.drawn === 'canvas') && !sites.some(site => site.file === entry.file && site.text.includes(entry.mark))) {
    return [`${entry.owner}: "${entry.mark}" in ${entry.file} no longer marks an SVG or canvas`]
  }
  return []
})

/** OpenBridge's elements as the installed package defines them: tags in its manifest, icons by file. */
const manifestTags = new Set((JSON.parse(readFileSync(join(openBridge, 'custom-elements.json'), 'utf8')) as { readonly modules: ReadonlyArray<{ readonly declarations?: ReadonlyArray<{ readonly tagName?: string }> }> })
  .modules.flatMap(module => (module.declarations ?? []).flatMap(declaration => declaration.tagName === undefined ? [] : [declaration.tagName])))
const isOpenBridgeElement = (tag: string): boolean => tag.startsWith('obi-') ? existsSync(join(openBridge, `dist/icons/icon-${tag.slice(4)}.js`)) : manifestTags.has(tag)

/** The register's own rules: a reasonless or removed shape is not kept; a twin lives in ui/displays; named components exist. */
const ruleBreaks = (shapes: ReadonlyArray<CustomShape>): ReadonlyArray<string> => [
  ...shapes.filter((shape, index) => shapes.findIndex(other => other.id === shape.id) !== index).map(shape => `${shape.id}: listed twice`),
  ...shapes.flatMap(shape => [
    ...(shape.reason === null && shape.ends === 'kept' ? [`${shape.id}: kept with no reason on record`] : []),
    ...(typeof shape.decision === 'object' && shape.decision.owner === 'removed' && shape.ends === 'kept' ? [`${shape.id}: kept although the owner removed it`] : []),
    ...(shape.reason === 'B' && shape.sites.some(site => !site.file.startsWith('ui/displays/')) ? [`${shape.id}: a licence twin outside ui/displays`] : []),
    ...(shape.sites.length === 0 || shape.evidence.trim() === '' ? [`${shape.id}: no site or no evidence`] : []),
    ...(shape.standsInFor === 'none' ? [] : shape.standsInFor.filter(tag => !isOpenBridgeElement(tag)).map(tag => `${shape.id}: ${tag} is not an OpenBridge element`)),
  ]),
]

/** Every custom property OpenBridge declares or reads: its tokens and its components' styles. */
const openBridgeProperties: ReadonlySet<string> = new Set([join(openBridge, 'dist/openbridge.css'), ...filesUnder(join(openBridge, 'dist')).filter(file => file.endsWith('.css.js'))]
  .flatMap(file => readFileSync(file, 'utf8').match(/--[A-Za-z0-9_-]+/g) ?? []))

/** Internals the embed uses that the register does not list: CSS parts, shadow-root reads, and OpenBridge custom properties it sets. */
const unlistedInternals = (sources: Sources, listed: ReadonlyArray<Internal>): ReadonlyArray<string> => [...sources].flatMap(([file, code]) => {
  const has = (kind: Internal['kind'], name: string) => listed.some(internal => internal.kind === kind && internal.name === name && internal.used.file === file)
  const parts = [...code.matchAll(/::part\(\s*([\w-]+)\s*\)/g)].map(match => match[1]!).filter(name => !has('part', name)).map(name => `${file}: ::part(${name})`)
  const shadowReads = [...code.matchAll(/shadowRoot\b(\??\.querySelector(?:All)?\(\s*'([^']+)'\s*\))?/g)]
    .filter(match => match[2] === undefined || !has('shadow root', match[2]))
    .map(match => `${file}: ${match[0]}`)
  const set = [
    ...[...code.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map(match => match[1]!),
    ...[...code.matchAll(/style:(--[A-Za-z0-9_-]+)/g)].map(match => match[1]!),
    ...[...code.matchAll(/setProperty\(\s*['"`](--[A-Za-z0-9_-]+)/g)].map(match => match[1]!),
  ]
  const properties = [...new Set(set)].filter(name => openBridgeProperties.has(name) && !has('property', name)).map(name => `${file}: sets ${name}`)
  return [...parts, ...shadowReads, ...properties]
})

const displays = sourcesUnder('ui/embed', 'ui/displays')
const embed = new Map([...displays].filter(([file]) => file.startsWith('ui/embed/')))
const sites = drawingSites(displays)
const registered = registeredSites(customShapes, surfaces)

describe('the OpenBridge custom-shape register', () => {
  test('every SVG and drawing canvas in the embed and ui/displays is one register entry\'s or one surface\'s', () => {
    expect(sites.length).toBeGreaterThan(15)
    expect(unregistered(sites, registered)).toEqual([])
  })

  test('no entry is stale: each site still holds its mark, and each svg or canvas mark still marks one', () => {
    expect(stale(registered, displays, sites)).toEqual([])
    expect(stale(internals.map(internal => ({ ...internal.used, drawn: 'code', owner: `${internal.kind} ${internal.name}` })), embed, sites)).toEqual([])
  })

  test('the register keeps its own rules', () => {
    expect(ruleBreaks(customShapes)).toEqual([])
  })

  test('the embed uses shadow roots, CSS parts and OpenBridge custom properties only where the register lists them', () => {
    expect(openBridgeProperties.has('--obc-can-hover')).toBe(true)
    expect(unlistedInternals(embed, internals)).toEqual([])
  })

  test('planted: a new SVG, a vanished shape, a reasonless keeper, a misplaced twin and an unlisted part are each caught', () => {
    const planted: Sources = new Map([
      ['ui/embed/vignette/Planted.svelte', '<div>\n  <svg class="gauge" width={w}><path d="M0 0" /></svg>\n  <canvas bind:this={c}></canvas>\n</div>\n<style>\n  .knob::part(handle) { color: red; }\n  .row { --ui-components-button-touch-target-size: 24px; }\n</style>'],
      ['ui/embed/vignette/painter.ts', "const context = canvas.getContext('2d')"],
    ])
    const plantedSites = drawingSites(planted)
    expect(unregistered(plantedSites, registered).map(problem => problem.split(' ')[0])).toEqual([
      'ui/embed/vignette/Planted.svelte:2', 'ui/embed/vignette/Planted.svelte:3', 'ui/embed/vignette/painter.ts:1',
    ])
    const gauge = { id: 'gauge', draws: 'a gauge', sites: [{ file: 'ui/embed/vignette/Planted.svelte', mark: 'class="dial"', drawn: 'svg' }], standsInFor: ['obc-not-an-element'], reason: null, evidence: 'none', decision: 'pending owner approval', ends: 'kept' } as const
    expect(stale(registeredSites([gauge], []), planted, plantedSites)).toEqual(['gauge: ui/embed/vignette/Planted.svelte no longer holds "class="dial""'])
    expect(stale(registeredSites([{ ...gauge, sites: [{ file: 'ui/embed/vignette/Planted.svelte', mark: '<div>', drawn: 'svg' }] }], []), planted, plantedSites))
      .toEqual(['gauge: "<div>" in ui/embed/vignette/Planted.svelte no longer marks an SVG or canvas'])
    expect(ruleBreaks([gauge, { ...gauge, id: 'twin', reason: 'B', ends: 'swap', standsInFor: 'none' }])).toEqual([
      'gauge: kept with no reason on record', 'gauge: obc-not-an-element is not an OpenBridge element', 'twin: a licence twin outside ui/displays',
    ])
    expect(unlistedInternals(planted, internals)).toEqual([
      'ui/embed/vignette/Planted.svelte: ::part(handle)', 'ui/embed/vignette/Planted.svelte: sets --ui-components-button-touch-target-size',
    ])
    expect(unlistedInternals(new Map([['ui/embed/x.ts', "host.shadowRoot?.querySelector('.label')"]]), internals)).toEqual(["ui/embed/x.ts: shadowRoot?.querySelector('.label')"])
  })
})
