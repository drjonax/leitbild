/**
 * Display lines of code (plan v3.1 §2.10, Appendix C, test T30): counts the
 * non-test lines in the display scope at a Git revision or in the working
 * tree and checks a phase ceiling. The scope below is the one definition; a
 * lane that adds a display file outside it adds the path here in the same
 * commit. Baseline: bacf7a115 = 32,908 lines (architect inventory 32,885 plus
 * core/model/alerts.ts 23).
 *
 *   bun scripts/display-loc.ts [--at <rev> | --worktree] [--phase <phase>] [--json]
 */
import { Glob } from 'bun'

export interface ScopeGroup {
  readonly name: string
  readonly include: ReadonlyArray<string>
}

/** Display-serving pack UI (encodings, window and proposal panels) lives in `packs/<pack>/ui/displays/`; other pack UI, such as PlantCard and the plant modals, leaves the count. */
export const displayScope: ReadonlyArray<ScopeGroup> = [
  { name: 'World plant displays', include: ['apps/world/src/packs/process-plant/displays/**'] },
  { name: 'World display query', include: ['apps/world/src/packs/process-plant/queries/composed-display-query.ts'] },
  { name: 'World pack observation', include: ['apps/world/src/packs/*/observation/**'] },
  { name: 'World display-serving pack UI', include: ['apps/world/src/packs/*/ui/displays/**'] },
  { name: 'World embed UI', include: ['apps/world/src/ui/embed/**'] },
  { name: 'World process-display UI', include: ['apps/world/src/ui/process-display/**'] },
  { name: 'World displays UI', include: ['apps/world/src/ui/displays/**'] },
  { name: 'World displays feature', include: ['apps/world/src/features/displays/**'] },
  { name: 'World observation core and alert record', include: ['apps/world/src/core/observation/**', 'apps/world/src/core/model/alerts.ts'] },
  {
    name: 'Agents display code',
    include: [
      'apps/agents/src/core/render-validators/view-fence.ts', 'apps/agents/src/core/render-validators/view-envelope.ts',
      'apps/agents/src/core/display-request.ts', 'apps/agents/src/agents/display-requests.ts', 'apps/agents/src/agents/answer-consistency.ts', 'apps/agents/src/agents/answer-reading.ts',
      'apps/agents/src/ui/modules/display-request.ts', 'apps/agents/src/ui/modules/live-view/**',
    ],
  },
  { name: 'Agents operator-displays skill', include: ['apps/agents/skills/operator-displays/**'] },
  { name: 'Host view relay', include: ['apps/leitbild/src/ui/view-relay.ts'] },
  { name: 'Display contracts', include: ['packages/contracts/src/embedded-views.ts', 'packages/contracts/src/embedded-view-route.ts'] },
  { name: 'Display probe script', include: ['scripts/agent-display-probe.ts', 'scripts/display-eval/probe.ts'] },
]

/** Phase ceilings in lines (§2.10). The peak is split by ADR: old code with its replacements, plus new code with no predecessor. */
export const ceilings = { p0: 30_000, p1: 30_000, peak: 38_000, swap: 23_000, end: 22_000, p3b: 22_500 } as const
export type Phase = keyof typeof ceilings
export const peakSplit = { withPredecessor: 36_000, noPredecessor: 2_000 } as const
/** Paths of P2 code with no predecessor (dashboard v0, entity floor, collections, events, as-caller, attribution), added by their lanes. */
export const noPredecessor: ReadonlyArray<string> = []

const countedExtension = /\.(ts|svelte|css|md)$/
export const isCountedPath = (path: string): boolean => countedExtension.test(path) && !path.includes('.test.')

export const countLines = (text: string): number => {
  if (text === '') return 0
  const newlines = text.split('\n').length - 1
  return text.endsWith('\n') ? newlines : newlines + 1
}

export interface SourceFile {
  readonly path: string
  readonly text: string
}

export interface DisplayLocReport {
  readonly revision: string
  readonly total: number
  readonly groups: ReadonlyArray<{ readonly name: string; readonly lines: number; readonly files: number; readonly emptyPatterns: ReadonlyArray<string> }>
  readonly noPredecessorLines: number
  readonly files: ReadonlyArray<{ readonly path: string; readonly lines: number; readonly group: string }>
}

/** The first group whose pattern matches a path owns it, so no file counts twice. */
export const measure = (revision: string, files: ReadonlyArray<SourceFile>, scope: ReadonlyArray<ScopeGroup> = displayScope): DisplayLocReport => {
  const matchers = scope.map(group => ({ group, globs: group.include.map(pattern => ({ pattern, glob: new Glob(pattern) })) }))
  const counted: Array<{ path: string; lines: number; group: string; pattern: string }> = []
  for (const file of files) {
    if (!isCountedPath(file.path)) continue
    for (const { group, globs } of matchers) {
      const hit = globs.find(({ glob }) => glob.match(file.path))
      if (!hit) continue
      counted.push({ path: file.path, lines: countLines(file.text), group: group.name, pattern: hit.pattern })
      break
    }
  }
  const noPredecessorGlobs = noPredecessor.map(pattern => new Glob(pattern))
  const groups = scope.map(group => {
    const members = counted.filter(file => file.group === group.name)
    return {
      name: group.name,
      lines: members.reduce((sum, file) => sum + file.lines, 0),
      files: members.length,
      emptyPatterns: group.include.filter(pattern => !members.some(file => file.pattern === pattern)),
    }
  })
  return {
    revision,
    total: groups.reduce((sum, group) => sum + group.lines, 0),
    groups,
    noPredecessorLines: counted.filter(file => noPredecessorGlobs.some(glob => glob.match(file.path))).reduce((sum, file) => sum + file.lines, 0),
    files: counted.map(({ path, lines, group }) => ({ path, lines, group })).sort((left, right) => right.lines - left.lines),
  }
}

export interface CeilingVerdict {
  readonly phase: Phase
  readonly limit: number
  readonly pass: boolean
  readonly reasons: ReadonlyArray<string>
}

export const checkCeiling = (report: DisplayLocReport, phase: Phase): CeilingVerdict => {
  const limit = ceilings[phase]
  const reasons: string[] = []
  if (report.total > limit) reasons.push(`${report.total} lines exceed the ${phase} ceiling of ${limit}`)
  if (phase === 'peak') {
    const withPredecessor = report.total - report.noPredecessorLines
    if (withPredecessor > peakSplit.withPredecessor) reasons.push(`${withPredecessor} lines of old code and replacements exceed ${peakSplit.withPredecessor}`)
    if (report.noPredecessorLines > peakSplit.noPredecessor) reasons.push(`${report.noPredecessorLines} lines with no predecessor exceed ${peakSplit.noPredecessor}`)
  }
  return { phase, limit, pass: reasons.length === 0, reasons }
}

const git = async (root: string, args: ReadonlyArray<string>, stdin?: string): Promise<string> => {
  const child = Bun.spawn(['git', '-C', root, ...args], { stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`)
  return stdout
}

const inScope = (path: string): boolean => isCountedPath(path) && displayScope.some(group => group.include.some(pattern => new Glob(pattern).match(path)))

/** Files of a committed revision, read from Git objects without a checkout. */
export const filesAtRevision = async (root: string, revision: string): Promise<{ readonly commit: string; readonly files: ReadonlyArray<SourceFile> }> => {
  const commit = (await git(root, ['rev-parse', '--verify', `${revision}^{commit}`])).trim()
  const paths = (await git(root, ['ls-tree', '-r', '--name-only', '-z', commit])).split('\0').filter(path => path !== '' && inScope(path))
  const files: SourceFile[] = []
  for (const path of paths) files.push({ path, text: await git(root, ['show', `${commit}:${path}`]) })
  return { commit, files }
}

/** Tracked and untracked, unignored files of the working tree as they are on disk. */
export const filesInWorktree = async (root: string): Promise<ReadonlyArray<SourceFile>> => {
  const paths = (await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(path => path !== '' && inScope(path))
  const files: SourceFile[] = []
  for (const path of paths) {
    const file = Bun.file(`${root}/${path}`)
    if (await file.exists()) files.push({ path, text: await file.text() })
  }
  return files
}

const parseArgs = (argv: ReadonlyArray<string>) => {
  const valueOf = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    if (index === -1) return undefined
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    return value
  }
  const known = new Set(['--at', '--worktree', '--phase', '--json'])
  const unknown = argv.filter((arg, index) => arg.startsWith('--') ? !known.has(arg) : !['--at', '--phase'].includes(argv[index - 1] ?? ''))
  if (unknown.length > 0) throw new Error(`Unknown arguments: ${unknown.join(' ')}`)
  const at = valueOf('--at')
  const worktree = argv.includes('--worktree')
  if (at !== undefined && worktree) throw new Error('Use --at <rev> or --worktree, not both')
  const phase = valueOf('--phase')
  if (phase !== undefined && !(phase in ceilings)) throw new Error(`--phase must be one of ${Object.keys(ceilings).join(', ')}`)
  return { at: at ?? 'HEAD', worktree, phase: phase as Phase | undefined, json: argv.includes('--json') }
}

if (import.meta.main) {
  const options = parseArgs(Bun.argv.slice(2))
  const root = (await git(import.meta.dir, ['rev-parse', '--show-toplevel'])).trim()
  const report = options.worktree
    ? measure('worktree', await filesInWorktree(root))
    : await (async () => { const { commit, files } = await filesAtRevision(root, options.at); return measure(commit, files) })()
  const verdict = options.phase === undefined ? undefined : checkCeiling(report, options.phase)
  if (options.json) {
    console.log(JSON.stringify({ ...report, verdict }, null, 2))
  } else {
    for (const group of report.groups) console.log(`${String(group.lines).padStart(6)}  ${String(group.files).padStart(3)} files  ${group.name}`)
    console.log(`${String(report.total).padStart(6)}  total display lines at ${report.revision}`)
    if (verdict) console.log(verdict.pass ? `PASS: within the ${verdict.phase} ceiling of ${verdict.limit}` : `FAIL: ${verdict.reasons.join('; ')}`)
  }
  if (verdict && !verdict.pass) process.exit(1)
}
