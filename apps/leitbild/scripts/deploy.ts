#!/usr/bin/env bun

import { chmod, copyFile, lstat, mkdir, mkdtemp, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { validateKnowledgeSources } from '@leitbild/knowledge/publish'
import { publishPlatformKnowledge } from '../../../scripts/publish-platform-knowledge.ts'
import type { KnowledgeSnapshot } from '@leitbild/knowledge'

const APP_ID = 'leitbild-platform'
const SSH_HOST = process.env.LEITBILD_SSH_HOST ?? 'samsinn'
const WORKSPACE_ROOT = resolve(import.meta.dir, '../../..')
const HOST_ROOT = resolve(import.meta.dir, '..')
const WORLD_ROOT = resolve(WORKSPACE_ROOT, 'apps/world')
const AGENTS_ROOT = resolve(WORKSPACE_ROOT, 'apps/agents')
export const PRODUCTION_DEPENDENCY_WORKSPACE_PATHS = [
  'packages/contracts',
  'packages/module-runtime',
  'packages/procmd',
  'packages/knowledge',
] as const
export const INSTALL_MANIFEST_ONLY_WORKSPACE_PATHS = [
  'packages/integration-tests',
] as const
const PRODUCTION_DEPENDENCY_WORKSPACES = PRODUCTION_DEPENDENCY_WORKSPACE_PATHS.map(target => ({
  source: resolve(WORKSPACE_ROOT, target),
  target,
}))
const DEPLOY_ROOT = '/opt/leitbild'
const CURRENT_LINK = `${DEPLOY_ROOT}/current`
const RELEASES_DIR = `${DEPLOY_ROOT}/releases`
const DEPS_DIR = `${DEPLOY_ROOT}/deps`
const STATE_ROOT = '/var/lib/leitbild'
const SERVICES = ['leitbild-world.service', 'leitbild-agents.service', 'leitbild-host.service'] as const
const SERVICE_USER = 'leitbild'
const BUN_BIN = `${DEPLOY_ROOT}/runtime/bun`
const PUBLIC_HEALTH_URL = 'https://leitbild.app/health'
const REQUIRED_BUN_VERSION = '1.4.0'
/**
 * The public repository a release must be built from. World's browser bundle
 * contains AGPL-3.0-only OpenBridge code, whose licence notice names this
 * repository as its corresponding source (apps/world/src/ui/embed/openbridge-notice.ts).
 */
export const PUBLIC_CODE_REPOSITORY = 'https://github.com/michaelhil/leitbild'

interface Options {
  readonly dryRun: boolean
  readonly yes: boolean
  readonly install: boolean
}

interface ArtifactEntry {
  readonly source: string
  readonly target: string
}

interface DeploymentManifest {
  readonly schemaVersion: 1
  readonly app: typeof APP_ID
  readonly releaseId: string
  readonly createdAt: string
  readonly baseCommit: string
  readonly codeRepository: string
  readonly knowledgeRevision: string
  readonly branch: string
  readonly dirty: boolean
  readonly worktreeStatus: ReadonlyArray<string>
  readonly sourceDigest: string
  readonly dependencyPackagesDigest: string
  readonly fileCount: number
  readonly persistentRootsExcluded: ReadonlyArray<string>
}

const usage = (): string => `Usage: bun run deploy -- [--dry-run] [--yes] [--install]

  --dry-run  Validate and package without contacting production
  --yes      Skip the interactive production confirmation
  --install  Install the service, state directory, environment, and Caddy topology
`

export const parseDeployArgs = (args: ReadonlyArray<string>): Options => {
  let dryRun = false
  let yes = false
  let install = false
  for (const arg of args) {
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--yes') yes = true
    else if (arg === '--install') install = true
    else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    } else throw new Error(`Unknown argument: ${arg}\n\n${usage()}`)
  }
  return { dryRun, yes, install }
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`

const run = async (label: string, command: ReadonlyArray<string>, cwd = WORKSPACE_ROOT): Promise<void> => {
  console.log(`\n→ ${label}`)
  const child = Bun.spawn([...command], { cwd, stdout: 'inherit', stderr: 'inherit' })
  const code = await child.exited
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}`)
}

const capture = async (command: ReadonlyArray<string>, cwd = WORKSPACE_ROOT): Promise<string> => {
  const child = Bun.spawn([...command], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command.join(' ')} failed (${code}): ${stderr.trim()}`)
  return stdout
}

const trackedFiles = async (root: string): Promise<string[]> => {
  const raw = await capture(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], root)
  return raw.split('\0').filter(Boolean).sort()
}

const isDevelopmentOnlyPath = (path: string): boolean =>
  /(?:^|\/)(?:tests?|fixtures|__fixtures__|__tests__|__snapshots__)(?:\/|$)/.test(path)
  || /\.(?:test|spec)(?:-d)?\.[cm]?[jt]sx?$/.test(path)

export const isProductionSourcePath = (workspace: 'host' | 'world' | 'agents' | 'package', path: string): boolean => {
  if (isDevelopmentOnlyPath(path)) return false
  if (workspace === 'host') {
    return path === 'package.json'
      || path.startsWith('src/')
      || path.startsWith('scripts/')
      || path === 'deploy/Caddyfile'
      || path === 'deploy/sites/leitbild.caddy'
      || /^deploy\/leitbild-(?:host|world|agents)\.service$/.test(path)
      || path.startsWith('deploy/retired/')
  }
  if (workspace === 'world') return path === 'package.json' || path.startsWith('src/')
  if (workspace === 'agents') {
    return path === 'package.json'
      || path.startsWith('src/')
      || path.startsWith('examples/scripts/')
      || path.startsWith('skills/')
      || path.startsWith('tools/')
  }
  return path === 'package.json' || path.startsWith('src/')
}

export const isProductKnowledgePath = (path: string): boolean =>
  path === 'README.md'
  || path === 'CONTEXT-MAP.md'
  || path.startsWith('docs/')
  || path.startsWith('contexts/')
  || /^apps\/[^/]+\/README\.md$/.test(path)
  || /^packages\/[^/]+\/README\.md$/.test(path)

/** One entry of `git status --porcelain=v1 -z`: its two status letters and its path (the new path of a rename or copy). */
export interface WorktreeEntry {
  readonly status: string
  readonly path: string
}

export const parsePorcelainZ = (raw: string): ReadonlyArray<WorktreeEntry> => {
  const fields = raw.split('\0')
  const entries: WorktreeEntry[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!
    if (field === '') continue
    if (field.length < 4 || field[2] !== ' ') throw new Error(`Unreadable git status entry: ${JSON.stringify(field)}`)
    const status = field.slice(0, 2)
    entries.push({ status, path: field.slice(3) })
    // A rename or copy names its original path in the next field.
    if (status.includes('R') || status.includes('C')) index += 1
  }
  return entries
}

/**
 * What World's browser bundle is built from: World's source (its UI imports
 * pack display code from all of src), its build configuration and package
 * manifest, and the lockfile that pins OpenBridge. The bundle contains
 * AGPL-3.0-only OpenBridge, so it may be built only from committed, public
 * source: a change here that is not committed would ship without its
 * corresponding source.
 */
export const isWorldBundleInput = (path: string): boolean =>
  path === 'bun.lock'
  || path === 'apps/world/package.json'
  || path === 'apps/world/vite.config.ts'
  || (path.startsWith('apps/world/src/') && !isDevelopmentOnlyPath(path.slice('apps/world/'.length)))

/** Why World's bundle inputs cannot be deployed as they stand, or null: any of them dirty or untracked. */
export const worldBundleRefusal = (entries: ReadonlyArray<WorktreeEntry>): string | null => {
  const changed = entries.filter(entry => isWorldBundleInput(entry.path))
  if (changed.length === 0) return null
  return `Refusing to deploy: World's browser bundle contains AGPL-3.0-only OpenBridge and must be built from committed, public source, but these inputs are dirty or untracked: ${changed.map(entry => `${entry.status.trim()} ${entry.path}`).join(', ')}. Commit and push them first.`
}

/** A Git remote URL in one form, so an SSH and an HTTPS remote of the same repository compare equal. */
export const normalizedRepositoryUrl = (url: string): string => url.trim()
  .replace(/^git@([^:]+):/, 'https://$1/')
  .replace(/^ssh:\/\/git@([^/]+)\//, 'https://$1/')
  .replace(/\.git$/, '')
  .replace(/\/$/, '')

/** Why the base commit's source is not public, or null: origin is not the public repository, or no branch of it contains the commit. */
export const publicSourceRefusal = (input: {
  readonly publicRepository: string
  readonly codeRepository: string
  readonly baseCommit: string
  /** The branches of origin, as last fetched, that contain the base commit. */
  readonly containingRefs: ReadonlyArray<string>
}): string | null => {
  if (normalizedRepositoryUrl(input.codeRepository) !== normalizedRepositoryUrl(input.publicRepository)) {
    return `Refusing to deploy: origin is ${input.codeRepository}, not the public repository ${input.publicRepository} that World's AGPL notice names as the corresponding source.`
  }
  if (input.containingRefs.length === 0) {
    return `Refusing to deploy: base commit ${input.baseCommit} is on no branch of the public origin ${input.publicRepository}, so the AGPL corresponding source of World's bundle would not be public. Push it first.`
  }
  return null
}

/**
 * Refuses a release whose World bundle would ship without public
 * corresponding source: World bundle inputs dirty or untracked, or a base
 * commit no branch of the public origin contains (after fetching origin).
 */
export const assertPublicWorldSource = async (root: string, publicRepository: string): Promise<{ readonly baseCommit: string; readonly containingRefs: ReadonlyArray<string> }> => {
  const bundleRefusal = worldBundleRefusal(parsePorcelainZ(await capture(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], root)))
  if (bundleRefusal !== null) throw new Error(bundleRefusal)
  const baseCommit = (await capture(['git', 'rev-parse', 'HEAD'], root)).trim()
  const codeRepository = (await capture(['git', 'remote', 'get-url', 'origin'], root)).trim()
  await capture(['git', 'fetch', '--quiet', 'origin'], root)
  const containingRefs = (await capture(['git', 'for-each-ref', `--contains=${baseCommit}`, '--format=%(refname)', 'refs/remotes/origin/'], root))
    .split('\n').filter(ref => ref !== '' && ref !== 'refs/remotes/origin/HEAD')
  const sourceRefusal = publicSourceRefusal({ publicRepository, codeRepository, baseCommit, containingRefs })
  if (sourceRefusal !== null) throw new Error(sourceRefusal)
  return { baseCommit, containingRefs }
}

const directoryFiles = async (root: string, child: string): Promise<string[]> => {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else files.push(relative(root, path))
    }
  }
  await visit(join(root, child))
  return files
}

const entriesFor = async (
  root: string,
  targetRoot: string,
  workspace: 'host' | 'world' | 'agents' | 'package',
  extra: ReadonlyArray<string> = [],
): Promise<ArtifactEntry[]> => {
  const entries: ArtifactEntry[] = []
  for (const path of [...new Set([...await trackedFiles(root), ...extra])].sort()) {
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error(`Unsafe source path: ${path}`)
    if (!isProductionSourcePath(workspace, path)) continue
    const source = join(root, path)
    const stat = await lstat(source).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (stat === null) continue
    if (stat.isFile() || stat.isSymbolicLink()) entries.push({ source, target: join(targetRoot, path) })
  }
  return entries
}

const digestEntries = async (entries: ReadonlyArray<ArtifactEntry>): Promise<string> => {
  const hasher = new Bun.CryptoHasher('sha256')
  for (const entry of [...entries].sort((left, right) => left.target.localeCompare(right.target))) {
    const stat = await lstat(entry.source)
    hasher.update(entry.target)
    hasher.update('\0')
    if (stat.isSymbolicLink()) hasher.update(await readlink(entry.source))
    else hasher.update(await Bun.file(entry.source).arrayBuffer())
    hasher.update('\0')
  }
  return hasher.digest('hex')
}

const sha256File = async (path: string): Promise<string> => {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(await Bun.file(path).arrayBuffer())
  return hasher.digest('hex')
}

const copyEntries = async (entries: ReadonlyArray<ArtifactEntry>, stageRoot: string): Promise<void> => {
  for (const entry of entries) {
    const target = join(stageRoot, entry.target)
    const stat = await lstat(entry.source)
    await mkdir(dirname(target), { recursive: true })
    if (stat.isSymbolicLink()) await symlink(await readlink(entry.source), target)
    else {
      await copyFile(entry.source, target)
      await chmod(target, stat.mode & 0o777)
    }
  }
}

export const referencedInspectionEntries = async (
  root: string, knowledge: KnowledgeSnapshot, existing: ReadonlyArray<ArtifactEntry>,
): Promise<ReadonlyArray<ArtifactEntry>> => {
  const paths = await validateKnowledgeSources(knowledge, root)
  const tracked = new Set((await capture(['git', 'ls-files', '-z', '--cached'], root)).split('\0'))
  const byTarget = new Map(existing.map(entry => [entry.target, entry]))
  const additions: ArtifactEntry[] = []
  for (const path of paths) {
    if (!tracked.has(path)) throw new Error(`Wiki inspection source must be tracked in Git: ${path}`)
    const source = join(root, path), prior = byTarget.get(path)
    if (prior && resolve(prior.source) !== resolve(source)) throw new Error(`Conflicting inspection artifact target: ${path}`)
    if (!prior) additions.push({ source, target: path })
  }
  return additions
}

const createArtifact = async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'leitbild-release-'))
  const stageRoot = join(tempRoot, 'stage')
  const archivePath = join(tempRoot, 'release.tgz')
  await mkdir(stageRoot)
  const hostEntries = await entriesFor(HOST_ROOT, 'apps/leitbild', 'host', await directoryFiles(HOST_ROOT, 'src/ui/dist'))
  const worldEntries = await entriesFor(WORLD_ROOT, 'apps/world', 'world', await directoryFiles(WORLD_ROOT, 'src/ui/dist'))
  const agentsEntries = await entriesFor(AGENTS_ROOT, 'apps/agents', 'agents', [
    'src/ui/dist.css',
    ...await directoryFiles(AGENTS_ROOT, 'src/ui/dist'),
  ])
  const rootEntries: ArtifactEntry[] = ['package.json', 'bun.lock', 'LICENSE', 'NOTICE.md'].map(path => ({ source: join(WORKSPACE_ROOT, path), target: path }))
  const knowledgeRepository = process.env.LEITBILD_KNOWLEDGE_REPOSITORY ?? resolve(WORKSPACE_ROOT, '../Leitbild-wiki')
  const knowledge = await publishPlatformKnowledge(knowledgeRepository, WORKSPACE_ROOT)
  const knowledgeFile = join(tempRoot, 'knowledge-snapshot.json')
  await writeFile(knowledgeFile, JSON.stringify(knowledge))
  const knowledgeEntries: ArtifactEntry[] = [{ source: knowledgeFile, target: 'knowledge/snapshot.json' }]
  const productKnowledgeEntries: ArtifactEntry[] = (await trackedFiles(WORKSPACE_ROOT))
    .filter(path => isProductKnowledgePath(path) && !isDevelopmentOnlyPath(path))
    .map(path => ({ source: join(WORKSPACE_ROOT, path), target: path }))
  const installManifestEntries: ArtifactEntry[] = INSTALL_MANIFEST_ONLY_WORKSPACE_PATHS.map(path => ({
    source: join(WORKSPACE_ROOT, path, 'package.json'),
    target: join(path, 'package.json'),
  }))
  const dependencyPackageEntries = (await Promise.all(
    PRODUCTION_DEPENDENCY_WORKSPACES.map(workspace => entriesFor(workspace.source, workspace.target, 'package')),
  )).flat()
  const entries = [
    ...rootEntries,
    ...knowledgeEntries,
    ...productKnowledgeEntries,
    ...hostEntries,
    ...worldEntries,
    ...agentsEntries,
    ...dependencyPackageEntries,
    ...installManifestEntries,
  ]
  // A wiki may inspect a research/build script without making its directory a
  // production dependency. Ship exactly its allowed, validated code references.
  entries.push(...await referencedInspectionEntries(WORKSPACE_ROOT, knowledge, entries))
  const sourceDigest = await digestEntries(entries)
  const dependencyPackagesDigest = await digestEntries(dependencyPackageEntries)
  const createdAt = new Date().toISOString()
  // Checked again as packaged: the checks, tests and builds that ran since must not have changed a World bundle input.
  const { baseCommit } = await assertPublicWorldSource(WORKSPACE_ROOT, PUBLIC_CODE_REPOSITORY)
  const branch = (await capture(['git', 'branch', '--show-current'])).trim() || '(detached)'
  const worktreeStatus = (await capture(['git', 'status', '--porcelain=v1', '--untracked-files=all'])).split('\n').filter(Boolean)
  const manifest: DeploymentManifest = {
    schemaVersion: 1,
    app: APP_ID,
    releaseId: `${createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${baseCommit.slice(0, 10)}-${sourceDigest.slice(0, 10)}`,
    createdAt,
    baseCommit,
    codeRepository: (await capture(['git', 'remote', 'get-url', 'origin'])).trim().replace(/\.git$/, ''),
    knowledgeRevision: knowledge.revision,
    branch,
    dirty: worktreeStatus.length > 0,
    worktreeStatus,
    sourceDigest,
    dependencyPackagesDigest,
    fileCount: entries.length,
    persistentRootsExcluded: [STATE_ROOT],
  }
  await copyEntries(entries, stageRoot)
  await validateKnowledgeSources(knowledge, stageRoot)
  await writeFile(join(stageRoot, 'DEPLOYMENT.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  await run('Create immutable Leitbild artifact', ['tar', '--no-mac-metadata', '--no-xattrs', '-czf', archivePath, '-C', stageRoot, '.'])
  return {
    archivePath,
    archiveChecksum: await sha256File(archivePath),
    lockChecksum: await sha256File(join(WORKSPACE_ROOT, 'bun.lock')),
    manifest,
    cleanup: () => rm(tempRoot, { recursive: true, force: true }),
  }
}

export const moduleRoutingPreflight = (): string => `for module in world agents; do
  env_file="/etc/leitbild/$module.env"
  if test -f "$env_file" && grep -Eq '^[[:space:]]*WORKSPACE_HOST_URL[[:space:]]*=' "$env_file"; then
    echo "Remove WORKSPACE_HOST_URL from $env_file: production Module routing is owned by its service definition, not provider settings." >&2
    exit 1
  fi
done`

export const caddySnippetPreflight = (): string => `if ! grep -Fxq 'import /etc/caddy/managed-sites/*.caddy' /etc/caddy/Caddyfile || ! test -f /etc/caddy/managed-sites/leitbild.caddy; then
  echo "Provision the shared Caddy entry point and Leitbild site snippet before deploying. Existing host configuration will not be overwritten." >&2
  exit 1
fi`

/** Called inside the activation transaction; the shared lock stays held through rollback. */
export const caddySnippetDeployment = (): string => `exec 8>/run/lock/caddy-config.lock
flock -w 60 8 || { echo "Another Caddy configuration update is active" >&2; exit 1; }
${caddySnippetPreflight()}
caddy_site=/etc/caddy/managed-sites/leitbild.caddy
cp -a "$caddy_site" "$activation_backup/leitbild.caddy"
install -o root -g root -m 0644 "$release_dir/apps/leitbild/deploy/sites/leitbild.caddy" "/etc/caddy/leitbild.next-$release_id"
caddy_changed=1
mv -f "/etc/caddy/leitbild.next-$release_id" "$caddy_site"
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy.service`

/** One success boundary for release selection, services, install configuration and site routing.
 * The caller owns preparation and defines cleanup(); persistent application data is never restored.
 */
export const releaseActivation = (install: boolean, knowledgeRevision: string): string => `
activation_backup=""
activation_started=0
activation_committed=0
caddy_changed=0
install_changed=0
services_started=0
rollback_failed=0
rollback_step() {
  if "$@"; then return 0; fi
  echo "ROLLBACK FAILED: $*" >&2
  rollback_failed=1
}
restore_file() {
  if test -e "$activation_backup/$1" || test -L "$activation_backup/$1"; then
    rm -f -- "$2" && cp -a "$activation_backup/$1" "$2"
  else
    rm -f -- "$2"
  fi
}
finish_activation() {
  result=$?
  trap - EXIT INT TERM HUP
  set +e
  if test "$activation_started" -eq 1 && test "$activation_committed" -eq 0; then
    test "$result" -ne 0 || result=1
    echo "Release activation failed (exit $result); restoring previous activation" >&2
    if test "$caddy_changed" -eq 1; then
      rollback_step restore_file leitbild.caddy /etc/caddy/managed-sites/leitbild.caddy
      rollback_step caddy validate --config /etc/caddy/Caddyfile
      rollback_step systemctl reload caddy.service
    fi
    # Stop newly started services while their installed unit definitions still exist.
    if test "$services_started" -eq 1; then
      for service in ${SERVICES.join(' ')}; do
        if ! test -f "$activation_backup/$service.active"; then rollback_step systemctl stop "$service"; fi
      done
    fi
    if test "$install_changed" -eq 1; then
      for service in ${SERVICES.join(' ')}; do
        if test -f "$activation_backup/$service.enable-changed"; then rollback_step systemctl disable "$service"; fi
        rollback_step restore_file "$service" "/etc/systemd/system/$service"
      done
      rollback_step restore_file platform.env /etc/leitbild/platform.env
      rollback_step systemctl daemon-reload
    fi
    if test -n "$previous"; then
      rollback_step ln -sfn "$previous" "$next_link"
      rollback_step mv -Tf "$next_link" ${shellQuote(CURRENT_LINK)}
    else
      rollback_step rm -f -- ${shellQuote(CURRENT_LINK)}
    fi
    for service in ${SERVICES.join(' ')}; do
      if test -f "$activation_backup/$service.active"; then
        rollback_step systemctl restart "$service"
      fi
    done
    if test "$rollback_failed" -eq 0; then
      echo "Previous activation restored (selection/configuration restored; prior services restarted/stopped)" >&2
    else
      echo "Rollback incomplete; recovery files retained at $activation_backup" >&2
    fi
  fi
  rm -f -- "$next_link" "/etc/caddy/leitbild.next-$release_id" || echo "Activation temporary-file cleanup failed" >&2
  if test -n "$activation_backup" && test "$rollback_failed" -eq 0; then
    rm -rf -- "$activation_backup" || echo "Activation backup cleanup failed" >&2
  fi
  cleanup || echo "Deployment upload cleanup failed" >&2
  exit "$result"
}
next_link="${DEPLOY_ROOT}/.next-$release_id"
trap finish_activation EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
activation_backup="$(mktemp -d ${DEPLOY_ROOT}/.activation-XXXXXX)"
for service in ${SERVICES.join(' ')}; do
  state_status=0
  service_state="$(systemctl is-active "$service")" || state_status=$?
  case "$service_state:$state_status" in
    active:0) touch "$activation_backup/$service.active" ;;
    inactive:3|failed:3) ;;
    inactive:4|unknown:4)
      if test ${install ? '1' : '0'} -eq 1 && load_state="$(systemctl show "$service" --property=LoadState --value)" && test "$load_state" = not-found; then
        : # A first installation has no service to restart on rollback.
      else
        echo "Cannot confirm an absent service for --install: $service" >&2; exit 1
      fi ;;
    *) echo "Cannot snapshot running state for $service: $service_state (exit $state_status)" >&2; exit 1 ;;
  esac
done
if test ${install ? '1' : '0'} -eq 1; then
  # Replacing a linked file could mutate configuration outside this transaction.
  for config in /etc/leitbild/platform.env ${SERVICES.map(service => `/etc/systemd/system/${service}`).join(' ')}; do
    if test -L "$config" || { test -e "$config" && ! test -f "$config"; }; then
      echo "--install requires regular configuration files or absent paths: $config" >&2; exit 1
    fi
  done
  if test -e /etc/leitbild/platform.env; then cp -a /etc/leitbild/platform.env "$activation_backup/platform.env"; fi
  for service in ${SERVICES.join(' ')}; do
    if test -e "/etc/systemd/system/$service" || test -L "/etc/systemd/system/$service"; then cp -a "/etc/systemd/system/$service" "$activation_backup/$service"; fi
    enabled="$(systemctl is-enabled "$service" 2>/dev/null)" || true
    case "$enabled" in
      enabled) ;;
      disabled|not-found|static) touch "$activation_backup/$service.enable-needed" ;;
      *) echo "Cannot safely restore --install enablement state for $service: $enabled" >&2; exit 1 ;;
    esac
  done
fi
activation_started=1
if test ${install ? '1' : '0'} -eq 1; then
  install_changed=1
  cat > /etc/leitbild/platform.env <<'EOF'
WORKSPACE_HOST_URL=https://leitbild.app
WORKSPACE_MODULES=[{"moduleId":"world","internalBaseUrl":"http://127.0.0.1:4177","manifestPath":"/.well-known/workspace-module"},{"moduleId":"agents","internalBaseUrl":"http://127.0.0.1:3000","manifestPath":"/.well-known/workspace-module"}]
EOF
  chmod 0600 /etc/leitbild/platform.env
  for service in ${SERVICES.join(' ')}; do cp "$release_dir/apps/leitbild/deploy/$service" "/etc/systemd/system/$service"; done
  systemctl daemon-reload
  for service in ${SERVICES.join(' ')}; do
    if test -f "$activation_backup/$service.enable-needed"; then
      touch "$activation_backup/$service.enable-changed"
      systemctl enable "$service"
    fi
  done
fi
ln -s "$release_dir" "$next_link"
mv -Tf "$next_link" ${shellQuote(CURRENT_LINK)}
systemctl reset-failed ${SERVICES.join(' ')} || true
services_started=1
systemctl restart ${SERVICES.join(' ')}
for port in 3000 4177 3100; do for attempt in $(seq 1 60); do curl -fsS -o /dev/null "http://127.0.0.1:$port/health" && break; sleep 1; done; curl -fsS -o /dev/null "http://127.0.0.1:$port/health"; done
# Verify effective process routing, Workspace access and release-owned knowledge.
for module in world agents; do
  module_pid="$(systemctl show "leitbild-$module" --property=MainPID --value)"
  if ! tr '\\0' '\\n' < "/proc/$module_pid/environ" | grep -Fx 'WORKSPACE_HOST_URL=http://127.0.0.1:3100' > /dev/null; then
    echo "leitbild-$module is not routed to the internal Workspace Host" >&2
    exit 1
  fi
done
curl -fsS -o /dev/null http://127.0.0.1:3100/api/workspaces
if ! curl -fsS http://127.0.0.1:3100/api/knowledge/index | jq -e --arg revision ${shellQuote(knowledgeRevision)} '.revision == $revision and (.documents | length > 0)' > /dev/null; then
  echo "Knowledge publication does not match the release" >&2
  exit 1
fi
${caddySnippetDeployment()}
public_ready=0
for attempt in $(seq 1 60); do
  if curl -fsS -o /dev/null ${shellQuote(PUBLIC_HEALTH_URL)}; then public_ready=1; break; fi
  sleep 1
done
test "$public_ready" -eq 1
activation_committed=1
printf 'activated_release=%s previous=%s\n' "$release_id" "\${previous:-none}"
`

const remotePreflight = (install: boolean): string => `set -euo pipefail
${moduleRoutingPreflight()}
${caddySnippetPreflight()}
test "$(/opt/leitbild/runtime/bun --version)" = ${shellQuote(REQUIRED_BUN_VERSION)}
test "$(systemctl is-active caddy.service)" = active
test "$(systemctl is-active docker.service)" = active
test "$(df --output=avail /opt | tail -n 1 | tr -d ' ')" -gt 2097152
if test ${install ? '0' : '1'} -eq 1; then
  ${SERVICES.map(service => `test "$(systemctl is-active ${service})" = active`).join('\n  ')}
fi
`

export const remoteDeploy = (artifact: Pick<Awaited<ReturnType<typeof createArtifact>>, 'manifest' | 'lockChecksum' | 'archiveChecksum'>, remoteArchive: string, install: boolean): string => {
  const id = artifact.manifest.releaseId
  return `set -euo pipefail
exec 9>/run/lock/leitbild-deploy.lock
flock -n 9 || { echo "Another stack deployment is active" >&2; exit 1; }
${remotePreflight(install)}
release_id=${shellQuote(id)}
release_dir=${shellQuote(`${RELEASES_DIR}/${id}`)}
archive=${shellQuote(remoteArchive)}
incoming=${shellQuote(`${RELEASES_DIR}/.incoming-${id}`)}
dep_dir=${shellQuote(`${DEPS_DIR}/${artifact.lockChecksum}-${artifact.manifest.dependencyPackagesDigest}`)}
previous=""
test ! -e "$release_dir"
if test -e ${shellQuote(CURRENT_LINK)} && ! test -L ${shellQuote(CURRENT_LINK)}; then echo "current must be a release symlink" >&2; exit 1; fi
if test -L ${shellQuote(CURRENT_LINK)}; then previous="$(readlink -f ${shellQuote(CURRENT_LINK)})"; fi
cleanup() { rm -rf -- "$incoming"; rm -f -- "$archive"; }
trap cleanup EXIT
if test ${install ? '1' : '0'} -eq 1; then
  # Provisioning is retained on activation failure; never remove application data.
  id -u ${SERVICE_USER} >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin ${SERVICE_USER}
  install -d -o ${SERVICE_USER} -g ${SERVICE_USER} -m 0700 ${shellQuote(`${STATE_ROOT}/host`)} ${shellQuote(`${STATE_ROOT}/world`)} ${shellQuote(`${STATE_ROOT}/agents`)}
  install -d -o root -g root -m 0755 ${shellQuote(DEPLOY_ROOT)}
  install -d -o root -g root -m 0755 /etc/leitbild
fi
mkdir -p ${shellQuote(RELEASES_DIR)} ${shellQuote(DEPS_DIR)}
printf '%s  %s\n' ${shellQuote(artifact.archiveChecksum)} "$archive" | sha256sum --check --status
mkdir "$incoming"
tar -xzf "$archive" --no-same-owner -C "$incoming"
test "$(jq -r .app "$incoming/DEPLOYMENT.json")" = ${shellQuote(APP_ID)}
test "$(jq -r .releaseId "$incoming/DEPLOYMENT.json")" = "$release_id"
if test ! -d "$dep_dir/node_modules"; then
  dep_tmp="${DEPS_DIR}/.incoming-${artifact.lockChecksum}-$$"
  rm -rf -- "$dep_tmp"
  mkdir -p "$dep_tmp/apps/leitbild" "$dep_tmp/apps/world" "$dep_tmp/apps/agents" "$dep_tmp/packages"
  cp "$incoming/package.json" "$incoming/bun.lock" "$dep_tmp/"
  cp "$incoming/apps/leitbild/package.json" "$dep_tmp/apps/leitbild/"
  cp "$incoming/apps/world/package.json" "$dep_tmp/apps/world/"
  cp "$incoming/apps/agents/package.json" "$dep_tmp/apps/agents/"
  ${PRODUCTION_DEPENDENCY_WORKSPACES.map(workspace => `cp -a "$incoming/${workspace.target}" "$dep_tmp/packages/"`).join('\n  ')}
  ${INSTALL_MANIFEST_ONLY_WORKSPACE_PATHS.map(path => `mkdir -p "$dep_tmp/${path}"; cp "$incoming/${path}/package.json" "$dep_tmp/${path}/"`).join('\n  ')}
  chown -R ${SERVICE_USER}:${SERVICE_USER} "$dep_tmp"
  sudo -u ${SERVICE_USER} sh -c 'cd "$1" && exec "$2" install --frozen-lockfile --production' sh "$dep_tmp" ${shellQuote(BUN_BIN)}
  mv "$dep_tmp" "$dep_dir"
fi
ln -s "$dep_dir/node_modules" "$incoming/node_modules"
ln -s "$dep_dir/apps/leitbild/node_modules" "$incoming/apps/leitbild/node_modules"
ln -s "$dep_dir/apps/world/node_modules" "$incoming/apps/world/node_modules"
ln -s "$dep_dir/apps/agents/node_modules" "$incoming/apps/agents/node_modules"
mv "$incoming" "$release_dir"
${releaseActivation(install, artifact.manifest.knowledgeRevision)}
# Retention is maintenance after the activation commit, never a rollback trigger.
find ${shellQuote(RELEASES_DIR)} -mindepth 1 -maxdepth 1 -type d ! -path "$release_dir" -exec rm -rf -- {} + || echo "Release retention cleanup failed" >&2
find ${shellQuote(DEPS_DIR)} -mindepth 1 -maxdepth 1 -type d ! -path "$dep_dir" -exec rm -rf -- {} + || echo "Dependency retention cleanup failed" >&2
`
}

const confirmMutation = (id: string, yes: boolean): void => {
  if (yes) return
  if (!process.stdin.isTTY) throw new Error('Refusing production mutation without --yes')
  if (prompt(`Deploy Leitbild ${id} to production? Type "deploy" to continue:`) !== 'deploy') throw new Error('Deployment cancelled')
}

const main = async (): Promise<void> => {
  const options = parseDeployArgs(process.argv.slice(2))
  if (Bun.version !== REQUIRED_BUN_VERSION) throw new Error(`Bun ${REQUIRED_BUN_VERSION} required; found ${Bun.version}`)
  // Before anything is built: a release whose World bundle would lack public corresponding source is refused, a dry run too.
  await assertPublicWorldSource(WORKSPACE_ROOT, PUBLIC_CODE_REPOSITORY)
  await run('Platform checks', ['bun', 'run', 'check'])
  await run('Platform tests', ['bun', 'run', 'test'])
  await run('Build Leitbild host UI', ['bun', 'run', 'build:ui'], HOST_ROOT)
  await run('Build World UI', ['bun', 'run', 'build:ui'], WORLD_ROOT)
  await run('Build Agents UI', ['bun', 'run', 'build:ui'], AGENTS_ROOT)
  const artifact = await createArtifact()
  try {
    console.log(`\nRelease: ${artifact.manifest.releaseId}`)
    console.log(`Dirty worktree: ${artifact.manifest.dirty ? 'yes' : 'no'}`)
    console.log(`Files: ${artifact.manifest.fileCount}`)
    if (options.dryRun) return console.log('\n✓ Dry run complete; production was not changed')
    confirmMutation(artifact.manifest.releaseId, options.yes)
    await run('Production preflight', ['ssh', SSH_HOST, remotePreflight(options.install)])
    const remoteArchive = `/tmp/leitbild-${artifact.manifest.releaseId}.tgz`
    await run('Upload immutable Leitbild artifact', ['scp', artifact.archivePath, `${SSH_HOST}:${remoteArchive}`])
    await run('Activate Leitbild release', ['ssh', SSH_HOST, remoteDeploy(artifact, remoteArchive, options.install)])
    console.log(`✓ Release activation and ${PUBLIC_HEALTH_URL} verified on the host`)
  } finally {
    await artifact.cleanup()
  }
}

if (import.meta.main) await main()
