// Which OpenBridge elements the embedded view draws, which OpenBridge module
// defines each, and which modules each surface imports bare, read from the
// sources and the installed package (openbridge-usage.test.ts checks the
// sources, built-ui-scan.test.ts the built bundle).
//
// Importing an OpenBridge module defines its elements. An `import type` is
// erased, so the element stays an empty unknown tag and draws nothing: that is
// how the steam generators' and the condenser's vessels (obc-heat-exchanger)
// vanished from every mimic on 20 Oct 2026 (08305f825) while every server-side
// record stayed identical. An import of a module's enums defines its element
// too, but only by accident (trading an enum for its string drops the
// element), so only a bare import (`import '…/x.js'`) counts as defining one.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export const worldRoot = join(import.meta.dir, '..')
export const openBridgeRoot = join(worldRoot, 'node_modules/@oicl/openbridge-webcomponents')
const PACKAGE = '@oicl/openbridge-webcomponents/'
/** The view World embeds in other Modules: the only page that draws OpenBridge elements. */
export const EMBED_ENTRY = join(worldRoot, 'src/ui/embed/main.ts')

const files = (directory: string, suffix: string): ReadonlyArray<string> => readdirSync(directory).flatMap(name => {
  const path = join(directory, name)
  return statSync(path).isDirectory() ? files(path, suffix) : name.endsWith(suffix) ? [path] : []
})

/** The OpenBridge module defining each tag, from its `customElement("…")` call in the package's dist. */
export const definedIn: ReadonlyMap<string, string> = new Map(files(join(openBridgeRoot, 'dist'), '.js')
  .flatMap(path => [...readFileSync(path, 'utf8').matchAll(/customElement\("((?:obc|obi)-[a-z0-9-]+)"\)/g)].map(match => [match[1]!, path] as const)))

/** The modules an OpenBridge module loads in turn: every import in its built JS runs. */
const openBridgeImports = (path: string): ReadonlyArray<string> => [...readFileSync(path, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)\s*(?:[^'"]*?\sfrom\s*)?["']([^"']+)["']/g)]
  .flatMap(match => {
    const spec = match[1]!
    if (spec.startsWith('.')) return [resolve(dirname(path), spec)]
    if (spec.startsWith(PACKAGE)) return [join(openBridgeRoot, spec.slice(PACKAGE.length))]
    return []
  })

/** Source without comments, so a tag named in prose is not taken for one drawn. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')

/** Bare imports, `import '…'`: a module loaded for what it defines. */
const bareImports = (source: string): ReadonlyArray<string> => [...source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)].map(match => match[1]!)

/** Static imports that run: bare, value and re-exports, not `import type` nor an import whose every name is a type. */
const staticImports = (source: string): ReadonlyArray<string> => [
  ...[...source.matchAll(/(?:^|\n)\s*import\s+(type\s+)?([^'";]*?)\s+from\s+['"]([^'"]+)['"]/g)]
    .filter(match => match[1] === undefined && (!/^\{[^}]*\}$/.test(match[2]!.trim()) || match[2]!.trim().slice(1, -1).split(',').map(name => name.trim()).some(name => name !== '' && !/^type\s/.test(name))))
    .map(match => match[3]!),
  ...bareImports(source),
  ...[...source.matchAll(/(?:^|\n)\s*export\s+(?!type\b)[^'";]*?\s+from\s+['"]([^'"]+)['"]/g)].map(match => match[1]!),
]

const dynamicImports = (source: string): ReadonlyArray<string> => [...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]!)

/** The OpenBridge tags a source draws or reaches for: a start tag, or a whole string (createElement, querySelector, a glyph's tag). */
const tagsIn = (source: string): ReadonlySet<string> => new Set([
  ...[...source.matchAll(/<((?:obc|obi)-[a-z0-9-]+)[\s/>]/g)].map(match => match[1]!),
  ...[...source.matchAll(/(['"`])((?:obc|obi)-[a-z0-9-]+)\1/g)].map(match => match[2]!),
])

const sourceFile = (from: string, spec: string): string | null => {
  const base = resolve(dirname(from), spec)
  const found = [base, `${base}.ts`, join(base, 'index.ts')].find(candidate => existsSync(candidate) && statSync(candidate).isFile())
  return found !== undefined && (found.endsWith('.ts') || found.endsWith('.svelte')) ? found : null
}

interface SourceNode {
  readonly static: ReadonlyArray<string>
  readonly dynamic: ReadonlyArray<string>
  /** OpenBridge modules it imports bare. */
  readonly bare: ReadonlyArray<string>
  /** OpenBridge modules it loads at run time, bare or for values. */
  readonly loads: ReadonlyArray<string>
  readonly draws: ReadonlySet<string>
}

/** Every source file the embedded view reaches at run time. */
const graph = (): ReadonlyMap<string, SourceNode> => {
  const nodes = new Map<string, SourceNode>()
  const pending = [EMBED_ENTRY]
  while (pending.length > 0) {
    const path = pending.pop()!
    if (nodes.has(path)) continue
    const source = code(readFileSync(path, 'utf8'))
    const local = (specs: ReadonlyArray<string>) => specs.flatMap(spec => (spec.startsWith('.') ? [sourceFile(path, spec)].filter((next): next is string => next !== null) : []))
    const openBridgeOf = (specs: ReadonlyArray<string>) => specs.filter(spec => spec.startsWith(PACKAGE)).map(spec => join(openBridgeRoot, spec.slice(PACKAGE.length)))
    const node: SourceNode = {
      static: local(staticImports(source)),
      dynamic: local(dynamicImports(source)),
      bare: openBridgeOf(bareImports(source)),
      loads: openBridgeOf([...staticImports(source), ...dynamicImports(source)]),
      draws: tagsIn(source),
    }
    nodes.set(path, node)
    pending.push(...node.static, ...node.dynamic)
  }
  return nodes
}

const embed = graph()

const staticClosure = (from: ReadonlyArray<string>): ReadonlySet<string> => {
  const seen = new Set<string>()
  const pending = [...from]
  while (pending.length > 0) {
    const path = pending.pop()!
    if (seen.has(path)) continue
    seen.add(path)
    pending.push(...(embed.get(path)?.static ?? []))
  }
  return seen
}

/**
 * The OpenBridge modules imported bare by a drawing file's surface: the file
 * and what it imports, what it loads lazily, and the same for the files that
 * import it directly (a panel's loader serves the rows it renders, a mimic's
 * lazily loaded recipes the popover it opens).
 */
const surfaceBare = (path: string): ReadonlySet<string> => {
  const importers = [...embed].filter(([, node]) => node.static.includes(path)).map(([importer]) => importer)
  const around = [path, ...importers].flatMap(file => [file, ...(embed.get(file)?.dynamic ?? [])])
  return new Set([...staticClosure(around)].flatMap(file => embed.get(file)?.bare ?? []))
}

/** Every OpenBridge module the embedded view runs: what its sources load, and what those load in turn. */
export const embedRunning: ReadonlySet<string> = (() => {
  const running = new Set<string>()
  const pending = [...embed.values()].flatMap(node => node.loads)
  while (pending.length > 0) {
    const path = pending.pop()!
    if (running.has(path) || !existsSync(path)) continue
    running.add(path)
    pending.push(...openBridgeImports(path))
  }
  return running
})()

export interface DrawnTag {
  readonly tag: string
  /** The source drawing it, relative to apps/world. */
  readonly file: string
  /** The OpenBridge module defining it; null where none does. */
  readonly module: string | null
  /** Whether its surface imports that module bare. */
  readonly definedBySurface: boolean
}

/** Each OpenBridge tag the embedded view draws, per drawing file. */
export const embedDrawnTags: ReadonlyArray<DrawnTag> = [...embed].flatMap(([path, node]) => {
  const bare = surfaceBare(path)
  return [...node.draws].map(tag => {
    const module = definedIn.get(tag) ?? null
    return { tag, file: relative(worldRoot, path), module, definedBySurface: module !== null && bare.has(module) }
  })
})
