/** Spec/code traceability for the native operating kernel, projected from existing material.
 *
 * A module names the engineering section(s) owning the equations it implements in leading
 * `//! spec: <wiki path>#<heading slug>` lines; each named section links back with an ordinary
 * wiki `source:` link. Heading slugs and the published page set are the knowledge index's own
 * (`headingsFor`, `safeDocumentPath`), and every `source:apps/world/native/...` link is resolved by
 * the publication's `validateKnowledgeSources`. Packet provenance entries `{ name: '<page>.md',
 * sha256? }` must name exactly one current page; a differing hash marks the packet stale.
 * This is a check over authored links, not a requirement store, ID scheme or Markdown dialect.
 *
 * Usage: bun apps/world/scripts/reference-design-traceability.ts <app root> <wiki root>
 *          [--packet <packet.json>]... [--strict]
 * Prints a summary on stderr and the JSON report on stdout. Exits 1 on a broken spec line or wiki
 * native source link, a module without a spec line, or an unresolved provenance page; stale
 * provenance is reported and fails only with --strict.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { headingsFor, safeDocumentPath, type KnowledgeHeading } from '@leitbild/knowledge'
import { validateKnowledgeSources } from '@leitbild/knowledge/publish'

/** Every `.rs` file directly in these directories must carry at least one spec line. */
export const MODULE_DIRECTORIES = [
  'apps/world/native/process-plant/operating/src',
  'apps/world/native/process-plant/operating/water-ffi/src',
] as const

// The publication's link pattern (packages/knowledge/src/publish.ts), used here only to locate
// links and their lines; validation is the publication's own. A parity test keeps them equal.
const SOURCE_LINK = /(?<!!)\[[^\]]*\]\((source:[^\s)]+)(?:\s+"[^"]*")?\)/g
const NATIVE_LINK = 'source:apps/world/native/'
const SPEC_LIKE = /^\s*\/\/!\s*spec\s*:/i
const SPEC = /^\/\/! spec: ([^\s#]+)#(\S+)$/

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const lineCount = (content: string): number => content.split(/\r?\n/).length

export interface SourceLink {
  readonly page: string
  readonly line: number
  /** `page#slug` of the innermost enclosing heading, or the bare page before any heading. */
  readonly section: string
  readonly href: string
  readonly target?: string
  readonly problem?: string
}

const sectionAt = (page: string, headings: ReadonlyArray<KnowledgeHeading>, line: number): string => {
  const heading = headings.filter(candidate => candidate.line <= line).at(-1)
  return heading ? `${page}#${heading.anchor}` : page
}

/** Native source links of one page. Each link is validated alone so that every failure is
 * reported, not only the first one the publication would stop at. */
export const nativeSourceLinks = async (page: string, content: string, appRoot: string): Promise<ReadonlyArray<SourceLink>> => {
  if (!content.includes(`](${NATIVE_LINK}`)) return []
  const headings = headingsFor(content)
  const links: SourceLink[] = []
  for (const match of content.matchAll(SOURCE_LINK)) {
    const href = match[1]!
    if (!href.startsWith(NATIVE_LINK)) continue
    const line = lineCount(content.slice(0, match.index))
    // validateKnowledgeSources reads only `documents`; a working tree has no publication revision.
    const outcome = await validateKnowledgeSources({ revision: 'working-tree', documents: [{ path: page, content: match[0] }] }, appRoot)
      .then(([target]) => target === undefined ? { problem: 'not a publication source link' } : { target },
        (error: unknown) => ({ problem: message(error) }))
    links.push({ page, line, section: sectionAt(page, headings, line), href, ...outcome })
  }
  return links
}

export interface ProvenanceEntry { readonly at: string; readonly name: string; readonly sha256: unknown }

/** Packet objects naming a wiki page (`name` ending in `.md`), addressed by JSON Pointer. */
export const provenanceEntries = (value: unknown, at = ''): ReadonlyArray<ProvenanceEntry> => {
  if (Array.isArray(value)) return value.flatMap((item, index) => provenanceEntries(item, `${at}/${index}`))
  if (value === null || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const own = typeof record.name === 'string' && record.name.endsWith('.md') ? [{ at, name: record.name, sha256: record.sha256 }] : []
  return [...own, ...Object.entries(record).flatMap(([key, item]) =>
    provenanceEntries(item, `${at}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`))]
}

interface Declared { readonly line: number; readonly page: string; readonly slug: string }
export interface BrokenSpecLine { readonly module: string; readonly line: number; readonly text: string; readonly problem: string }

const specLines = (module: string, content: string) => {
  const declared: Declared[] = []
  const broken: BrokenSpecLine[] = []
  let leading = true
  content.split(/\r?\n/).forEach((text, index) => {
    if (!SPEC_LIKE.test(text)) { leading = false; return }
    const match = SPEC.exec(text)
    const line = index + 1
    if (!leading) broken.push({ module, line, text, problem: 'spec line outside the leading block' })
    else if (!match) broken.push({ module, line, text, problem: 'expected `//! spec: <wiki path>#<heading slug>`' })
    else declared.push({ line, page: match[1]!, slug: match[2]! })
  })
  return { declared, broken }
}

export interface TraceabilityOptions {
  readonly appRoot: string
  readonly wikiRoot: string
  readonly packets?: ReadonlyArray<string>
  readonly strict?: boolean
}

export const checkTraceability = async ({ appRoot, wikiRoot, packets = [], strict = false }: TraceabilityOptions) => {
  // The page set publishKnowledge publishes: safe Markdown paths except the root AGENTS.md.
  const paths = [...new Bun.Glob('**/*.md').scanSync({ cwd: wikiRoot })]
    .map(path => path.replaceAll('\\', '/')).filter(path => safeDocumentPath(path) && path !== 'AGENTS.md').sort()
  const pages = new Map(await Promise.all(paths.map(async path => [path, await readFile(join(wikiRoot, path), 'utf8')] as const)))
  const links = (await Promise.all([...pages].map(([page, content]) => nativeSourceLinks(page, content, appRoot)))).flat()
  const modules = (await Promise.all(MODULE_DIRECTORIES.map(async directory =>
    (await readdir(join(appRoot, directory), { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.rs')).map(entry => `${directory}/${entry.name}`)))).flat().sort()

  const headingCache = new Map<string, ReadonlyArray<KnowledgeHeading>>()
  const headingsOf = (page: string, content: string) => {
    const cached = headingCache.get(page) ?? headingsFor(content)
    headingCache.set(page, cached)
    return cached
  }
  const specProblem = (module: string, { page, slug }: Declared): string | undefined => {
    const content = pages.get(page)
    if (content === undefined) return `no published wiki page ${page}`
    const headings = headingsOf(page, content)
    const heading = headings.find(candidate => candidate.anchor === slug)
    if (!heading) return `no heading #${slug} in ${page}`
    // The section extent knowledge.read({ section }) selects: up to the next heading of the same or higher level.
    const next = headings.find(candidate => candidate.line > heading.line && candidate.level <= heading.level)
    const end = next ? next.line - 1 : lineCount(content)
    const linked = links.some(link => link.page === page && link.target === module && link.line >= heading.line && link.line <= end)
    return linked ? undefined : `${page}#${slug} has no source: link back to ${module}`
  }

  const moduleReport: Record<string, { spec: ReadonlyArray<string>; linkedFrom: ReadonlyArray<string> }> = {}
  const specPages = new Map<string, Set<string>>()
  const brokenSpecLines: BrokenSpecLine[] = []
  const missingSpecLines: string[] = []
  for (const module of modules) {
    const { declared, broken } = specLines(module, await readFile(join(appRoot, module), 'utf8'))
    brokenSpecLines.push(...broken)
    for (const spec of declared) {
      const problem = specProblem(module, spec)
      if (problem) brokenSpecLines.push({ module, line: spec.line, text: `${spec.page}#${spec.slug}`, problem })
      specPages.set(spec.page, (specPages.get(spec.page) ?? new Set()).add(module))
    }
    if (declared.length === 0) missingSpecLines.push(module)
    moduleReport[module] = {
      spec: declared.map(spec => `${spec.page}#${spec.slug}`),
      linkedFrom: [...new Set(links.filter(link => link.target === module).map(link => link.section))].sort(),
    }
  }

  const hashes = new Map<string, string>()
  const currentHash = async (page: string): Promise<string> => {
    const hash = hashes.get(page) ?? sha256(await readFile(join(wikiRoot, page)))
    hashes.set(page, hash)
    return hash
  }
  const packetReports = await Promise.all(packets.map(async packet => {
    const text = await readFile(packet, 'utf8')
    let json: unknown
    try { json = JSON.parse(text) } catch (error) { throw new Error(`Packet ${packet} is not JSON: ${message(error)}`) }
    const entries = provenanceEntries(json)
    const missing: { at: string; name: string }[] = []
    const ambiguous: { at: string; name: string; candidates: ReadonlyArray<string> }[] = []
    const stale: { at: string; name: string; page: string; recorded: string; current: string }[] = []
    for (const { at, name, sha256: recorded } of entries) {
      // A recorded name is the one page it equals or ends with on a path boundary.
      const candidates = paths.filter(path => path === name || path.endsWith(`/${name}`))
      const page = candidates[0]
      if (page === undefined) missing.push({ at, name })
      else if (candidates.length > 1) ambiguous.push({ at, name, candidates })
      else if (typeof recorded === 'string') {
        const current = await currentHash(page)
        if (current !== recorded) stale.push({ at, name, page, recorded, current })
      }
    }
    return { packet, entries: entries.length, missing, ambiguous, stale }
  }))

  const brokenSourceLinks = links.flatMap(({ page, line, href, problem }) => problem === undefined ? [] : [{ page, line, href, problem }])
  brokenSpecLines.sort((left, right) => left.module.localeCompare(right.module) || left.line - right.line)
  const failures = missingSpecLines.length + brokenSpecLines.length + brokenSourceLinks.length
    + packetReports.reduce((sum, report) => sum + report.missing.length + report.ambiguous.length + (strict ? report.stale.length : 0), 0)
  return {
    ok: failures === 0,
    strict,
    modules: moduleReport,
    specPages: Object.fromEntries([...specPages].sort(([left], [right]) => left.localeCompare(right))
      .map(([page, users]) => [page, [...users].sort()])),
    sourceLinksChecked: links.length,
    missingSpecLines,
    brokenSpecLines,
    brokenSourceLinks,
    packets: packetReports,
  }
}
export type TraceabilityReport = Awaited<ReturnType<typeof checkTraceability>>

export const summarize = (report: TraceabilityReport): string => {
  const modules = Object.values(report.modules)
  const lines = [`Native spec traceability: ${modules.length} modules, ${modules.filter(module => module.spec.length > 0).length} with `
    + `${modules.reduce((sum, module) => sum + module.spec.length, 0)} spec lines; ${report.sourceLinksChecked} wiki native source links.`]
  const list = (title: string, items: ReadonlyArray<string>) => lines.push(`${title}: ${items.length}`, ...items.map(item => `  ${item}`))
  list('Modules without a spec line', report.missingSpecLines.map(module => {
    const linkedFrom = report.modules[module]?.linkedFrom ?? []
    return `${module} (${linkedFrom.length > 0 ? `linked from ${linkedFrom.join(', ')}` : 'no wiki source link'})`
  }))
  list('Broken spec lines', report.brokenSpecLines.map(broken => `${broken.module}:${broken.line} ${broken.problem}`))
  list('Broken wiki native source links', report.brokenSourceLinks.map(broken => `${broken.page}:${broken.line} ${broken.problem}`))
  for (const packet of report.packets) {
    lines.push(`Packet ${packet.packet}: ${packet.entries} wiki provenance entries; ${packet.missing.length} missing, `
      + `${packet.ambiguous.length} ambiguous, ${packet.stale.length} stale${report.strict || packet.stale.length === 0 ? '' : ' (fails only with --strict)'}`,
    ...packet.missing.map(entry => `  missing ${entry.at} ${entry.name}`),
    ...packet.ambiguous.map(entry => `  ambiguous ${entry.at} ${entry.name}: ${entry.candidates.join(', ')}`),
    ...packet.stale.map(entry => `  stale ${entry.at} ${entry.page}`))
  }
  lines.push(report.ok ? 'PASS' : 'FAIL')
  return lines.join('\n')
}

if (import.meta.main) {
  const usage = 'Usage: reference-design-traceability <app root> <wiki root> [--packet <packet.json>]... [--strict]'
  const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, strict: true,
    options: { packet: { type: 'string', multiple: true }, strict: { type: 'boolean' } } })
  const [appRoot, wikiRoot, ...extra] = positionals
  if (!appRoot || !wikiRoot || extra.length > 0) throw Error(usage)
  const report = await checkTraceability({ appRoot: resolve(appRoot), wikiRoot: resolve(wikiRoot),
    packets: values.packet ?? [], strict: values.strict ?? false })
  console.error(summarize(report))
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.ok ? 0 : 1
}
