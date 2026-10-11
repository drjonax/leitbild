import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remoteDeploy } from './deploy.ts'

const services = ['leitbild-world.service', 'leitbild-agents.service', 'leitbild-host.service']
const shellFixtures = `
flock() {
  if test "$FAULT" = deploy-lock && test "\${@: -1}" = 9; then return 1; fi
  if test "$FAULT" = caddy-lock && test "\${@: -1}" = 8; then return 1; fi
  return 0
}
df() { printf 'Available\\n9999999\\n'; }
id() { return 0; }
install() {
  if test "$1" = -d; then mkdir -p "\${@:8}"; else cp "\${@: -2:1}" "\${@: -1}"; fi
}
sha256sum() { cat >/dev/null; test "$FAULT" != checksum; }
sleep() { :; }
find() { if test "$FAULT" = retention; then return 41; else command find "$@"; fi; }
mv() {
  if test "$1" = -Tf; then
    shift
    if test "$TEST_OS" = darwin; then command mv -fh "$@"; else command mv -Tf "$@"; fi
  else command mv "$@"; fi
}
cp() {
  if test "$FAULT" = unit-copy && test "\${@: -2:1}" = "$FIXTURE/deploy/releases/next/apps/leitbild/deploy/leitbild-agents.service"; then return 32; fi
  if test "$FAULT" = rollback-file && test "\${@: -1}" = "$FIXTURE/caddy/managed-sites/leitbild.caddy" && test "$1" = -a; then return 33; fi
  command cp "$@"
}
systemctl() {
  printf '%s\\n' "$*" >> "$FIXTURE/commands"
  action=$1; shift
  case "$action" in
    is-active)
      if test "$1" = --quiet; then test "$(cat "$FIXTURE/state/$2.active")" = active
      elif test "$1" = caddy.service || test "$1" = docker.service; then echo active
      else
        if test "$FAULT" = state-query; then echo 'bus unavailable' >&2; return 1; fi
        cat "$FIXTURE/state/$1.active"
        test "$(cat "$FIXTURE/state/$1.active")" != unknown || return 4
        test "$(cat "$FIXTURE/state/$1.active")" = active || return 3
      fi ;;
    is-enabled) cat "$FIXTURE/state/$1.enabled" ;;
    show)
      if test "$2" = --property=LoadState; then
        test "$FAULT" != load-query || return 1
        cat "$FIXTURE/state/$1.load"
      else echo "$1"; fi ;;
    reset-failed) return 0 ;;
    daemon-reload)
      if test "$FAULT" = daemon && ! test -f "$FIXTURE/daemon-failed"; then touch "$FIXTURE/daemon-failed"; return 34; fi ;;
    enable|disable)
      test "$action" = enable && state=enabled || state=disabled
      echo "$state" > "$FIXTURE/state/$1.enabled"
      if test "$action" = enable && test "$FAULT" = enable; then return 35; fi ;;
    restart|stop)
      for service in "$@"; do
        if test "$action" = stop; then
          test -f "$FIXTURE/systemd/$service" || return 5
          echo inactive > "$FIXTURE/state/$service.active"; continue
        fi
        selected=$(readlink "$FIXTURE/deploy/current")
        if test "$FAULT" = rollback-service && test "$selected" = "$FIXTURE/deploy/releases/previous"; then return 36; fi
        echo active > "$FIXTURE/state/$service.active"
        echo "$selected" > "$FIXTURE/state/$service.release"
        if test "$FAULT" = restart && test "$selected" = "$FIXTURE/deploy/releases/next"; then return 37; fi
      done ;;
    reload)
      if test "$FAULT" = reload && grep -q next "$FIXTURE/caddy/managed-sites/leitbild.caddy"; then return 38; fi
      if test "$FAULT" = rollback-caddy && grep -q previous "$FIXTURE/caddy/managed-sites/leitbild.caddy"; then return 39; fi ;;
    *) return 99 ;;
  esac
}
caddy() {
  if test "$FAULT" = validate && grep -q next "$FIXTURE/caddy/managed-sites/leitbild.caddy"; then return 40; fi
}
curl() {
  url="\${@: -1}"
  case "$url" in
    https:*) case "$FAULT" in public|rollback-*) return 22 ;; signal) kill -TERM $$; return 1 ;; esac ;;
    */health) test "$FAULT" != health || return 22 ;;
    */api/workspaces) test "$FAULT" != workspace || return 22 ;;
    */api/knowledge/index)
      if test "$FAULT" = knowledge; then echo '{"revision":"wrong","documents":[]}'
      else echo '{"revision":"wiki-next","documents":[{}]}' ; fi ;;
  esac
}
`

// Execute the complete generated remote shell. All absolute host paths are mapped
// into one disposable fixture; privileged/network commands are controlled functions.
// mv only adapts Linux's atomic -T replacement to BSD -h on macOS.
const fixture = async (fault: string, install = false, fresh = false) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'leitbild-activation-')))
  const put = async (path: string, text: string) => {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, text)
  }
  const oldRelease = join(root, 'deploy/releases/previous')
  const newRelease = join(root, 'deploy/releases/next')
  const sharedRoot = `# host configuration\nimport ${root}/caddy/managed-sites/*.caddy\n`
  await put('caddy/Caddyfile', sharedRoot)
  await put('caddy/managed-sites/other.caddy', 'foreign site\n')
  await put('caddy/managed-sites/leitbild.caddy', 'previous site\n')
  await put('deploy/runtime/bun', '#!/bin/sh\necho 1.4.0\n')
  await chmod(join(root, 'deploy/runtime/bun'), 0o755)
  await put('deploy/releases/previous/marker', 'prior release')
  await put('deploy/deps/previous/marker', 'prior dependencies')
  await put('state-data/marker', 'persistent data must survive')
  for (const path of ['locks', 'env', 'systemd', 'deploy/deps/lock-packages/node_modules', 'deploy/deps/lock-packages/apps/leitbild/node_modules', 'deploy/deps/lock-packages/apps/world/node_modules', 'deploy/deps/lock-packages/apps/agents/node_modules']) await mkdir(join(root, path), { recursive: true })
  if (!fresh) {
    await symlink(oldRelease, join(root, 'deploy/current'))
    await put('env/platform.env', 'previous env\n')
    await chmod(join(root, 'env/platform.env'), 0o640)
  }
  for (const [index, service] of services.entries()) {
    await put(`state/${service}.active`, fresh ? 'unknown\n' : (install && index === 1) ? 'inactive\n' : 'active\n')
    await put(`state/${service}.enabled`, fresh ? 'not-found\n' : index === 1 ? 'disabled\n' : 'enabled\n')
    await put(`state/${service}.load`, fresh ? 'not-found\n' : 'loaded\n')
    await put(`state/${service}.release`, `${oldRelease}\n`)
    if (!fresh) await put(`systemd/${service}`, `previous ${service}\n`)
    await put(`package/apps/leitbild/deploy/${service}`, `next ${service}\n`)
  }
  for (const module of ['world', 'agents']) await put(`proc/leitbild-${module}/environ`, `WORKSPACE_HOST_URL=${fault === 'routing' ? 'wrong' : 'http://127.0.0.1:3100'}\0`)
  await put('package/apps/leitbild/deploy/sites/leitbild.caddy', 'next site\n')
  await put('package/apps/world/package.json', '{}')
  await put('package/apps/agents/package.json', '{}')
  await put('package/DEPLOYMENT.json', JSON.stringify({ app: 'leitbild-platform', releaseId: 'next' }))
  const archive = join(root, 'archive.tgz')
  const tar = Bun.spawn(['tar', '-czf', archive, '-C', join(root, 'package'), '.'], { stdout: 'pipe', stderr: 'pipe' })
  expect(await tar.exited).toBe(0)
  const artifact: Parameters<typeof remoteDeploy>[0] = {
    archiveChecksum: 'fixture', lockChecksum: 'lock',
    manifest: { schemaVersion: 1, app: 'leitbild-platform', releaseId: 'next', createdAt: '', baseCommit: '', codeRepository: '', knowledgeRevision: 'wiki-next', branch: '', dirty: false, worktreeStatus: [], sourceDigest: '', dependencyPackagesDigest: 'packages', fileCount: 0, persistentRootsExcluded: [] },
  }
  const script = remoteDeploy(artifact, archive, install)
    .replaceAll('/opt/leitbild', `${root}/deploy`)
    .replaceAll('/etc/leitbild', `${root}/env`)
    .replaceAll('/etc/systemd/system', `${root}/systemd`)
    .replaceAll('/etc/caddy', `${root}/caddy`)
    .replaceAll('/run/lock', `${root}/locks`)
    .replaceAll('/var/lib/leitbild', `${root}/state-data`)
    .replaceAll('/proc/', `${root}/proc/`)
  const run = async (overrides = '') => {
    const proc = Bun.spawn(['bash', '-c', shellFixtures + overrides + script], { env: { ...process.env, FIXTURE: root, FAULT: fault, TEST_OS: process.platform }, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { code, stdout, stderr }
  }
  return { root, oldRelease, newRelease, sharedRoot, run, put, dispose: () => rm(root, { recursive: true, force: true }) }
}

for (const install of [false, true]) {
  for (const fault of ['success', 'restart', 'health', 'routing', 'workspace', 'knowledge', 'caddy-lock', 'validate', 'reload', 'public', ...(install ? ['unit-copy', 'daemon', 'enable'] : [])]) {
    test(`complete activation ${install ? '--install' : 'ordinary'}: ${fault}`, async () => {
      const f = await fixture(fault, install)
      try {
        const result = await f.run()
        const exitCodes: Record<string, number> = { success: 0, health: 22, workspace: 22, restart: 37, validate: 40, reload: 38, 'unit-copy': 32, daemon: 34, enable: 35 }
        expect(result.code, result.stderr).toBe(exitCodes[fault] ?? 1)
        expect(await readlink(join(f.root, 'deploy/current'))).toBe(fault === 'success' ? f.newRelease : f.oldRelease)
        expect(await readFile(join(f.root, 'caddy/Caddyfile'), 'utf8')).toBe(f.sharedRoot)
        expect(await readFile(join(f.root, 'caddy/managed-sites/other.caddy'), 'utf8')).toBe('foreign site\n')
        expect(await readFile(join(f.root, 'caddy/managed-sites/leitbild.caddy'), 'utf8')).toBe(fault === 'success' ? 'next site\n' : 'previous site\n')
        expect(await readFile(join(f.root, 'state-data/marker'), 'utf8')).toBe('persistent data must survive')
        if (fault !== 'success') {
          expect(result.stderr).toContain('Previous activation restored')
          expect(result.stdout).not.toContain('activated_release=')
          expect(await readFile(join(f.root, 'deploy/releases/previous/marker'), 'utf8')).toBe('prior release')
          expect(await readFile(join(f.root, 'deploy/deps/previous/marker'), 'utf8')).toBe('prior dependencies')
          expect(await readFile(join(f.root, 'env/platform.env'), 'utf8')).toBe('previous env\n')
          expect((await stat(join(f.root, 'env/platform.env'))).mode & 0o777).toBe(0o640)
          for (const [index, service] of services.entries()) {
            expect(await readFile(join(f.root, `systemd/${service}`), 'utf8')).toBe(`previous ${service}\n`)
            expect(await readFile(join(f.root, `state/${service}.enabled`), 'utf8')).toBe(index === 1 ? 'disabled\n' : 'enabled\n')
            expect(await readFile(join(f.root, `state/${service}.active`), 'utf8')).toBe(install && index === 1 ? 'inactive\n' : 'active\n')
            if (!(install && index === 1)) expect((await readFile(join(f.root, `state/${service}.release`), 'utf8')).trim()).toBe(f.oldRelease)
          }
        } else expect(result.stdout).toContain('activated_release=next')
      } finally { await f.dispose() }
    })
  }
}

test('failed first installation restores absent files, absent selection and inactive services', async () => {
  const f = await fixture('public', true, true)
  try {
    expect((await f.run()).code).toBe(1)
    expect(await Bun.file(join(f.root, 'env/platform.env')).exists()).toBe(false)
    await expect(readlink(join(f.root, 'deploy/current'))).rejects.toThrow()
    for (const service of services) {
      expect(await Bun.file(join(f.root, `systemd/${service}`)).exists()).toBe(false)
      expect(await readFile(join(f.root, `state/${service}.active`), 'utf8')).toBe('inactive\n')
      expect(await readFile(join(f.root, `state/${service}.enabled`), 'utf8')).toBe('disabled\n')
    }
  } finally { await f.dispose() }
})

for (const fault of ['rollback-file', 'rollback-service', 'rollback-caddy']) {
  test(`reports original failure and incomplete rollback: ${fault}`, async () => {
    const f = await fixture(fault, true)
    try {
      const result = await f.run()
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('Release activation failed (exit 1)')
      expect(result.stderr).toContain('ROLLBACK FAILED:')
      expect(result.stderr).toContain('Rollback incomplete; recovery files retained')
      expect(result.stderr).not.toContain('Previous activation restored')
      expect(result.stdout).not.toContain('activated_release=')
      expect((await readdir(join(f.root, 'deploy'))).some(name => name.startsWith('.activation-'))).toBe(true)
      expect(await readlink(join(f.root, 'deploy/current'))).toBe(f.oldRelease)
      expect(await readFile(join(f.root, 'caddy/managed-sites/other.caddy'), 'utf8')).toBe('foreign site\n')
    } finally { await f.dispose() }
  })
}

for (const fault of ['deploy-lock', 'checksum', 'unsupported-enablement', 'symlink-unit', 'state-query', 'unknown-loaded-unit', 'load-query']) {
  test(`preparation refuses safely before activation: ${fault}`, async () => {
    const f = await fixture(fault, true)
    try {
      if (fault === 'unsupported-enablement') await f.put(`state/${services[0]}.enabled`, 'masked\n')
      if (fault === 'unknown-loaded-unit' || fault === 'load-query') await f.put(`state/${services[0]}.active`, 'unknown\n')
      if (fault === 'symlink-unit') {
        await rm(join(f.root, `systemd/${services[0]}`))
        await symlink('absent-unit', join(f.root, `systemd/${services[0]}`))
      }
      const result = await f.run()
      expect(result.code).not.toBe(0)
      expect(result.stderr).not.toContain('restoring previous activation')
      expect(await readlink(join(f.root, 'deploy/current'))).toBe(f.oldRelease)
      expect(await readFile(join(f.root, 'env/platform.env'), 'utf8')).toBe('previous env\n')
      expect(await readFile(join(f.root, 'caddy/managed-sites/leitbild.caddy'), 'utf8')).toBe('previous site\n')
    } finally { await f.dispose() }
  })
}

test('TERM during public verification rolls back through the same owner', async () => {
  const f = await fixture('signal', true)
  try {
    const result = await f.run()
    expect(result.code).toBe(143)
    expect(result.stderr).toContain('Previous activation restored')
    expect(await readlink(join(f.root, 'deploy/current'))).toBe(f.oldRelease)
    expect(await readFile(join(f.root, 'caddy/managed-sites/leitbild.caddy'), 'utf8')).toBe('previous site\n')
  } finally { await f.dispose() }
})

test('retention failure after verified activation warns without rolling back or failing deployment', async () => {
  const f = await fixture('retention')
  try {
    const result = await f.run()
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('activated_release=next')
    expect(result.stderr).toContain('Release retention cleanup failed')
    expect(result.stderr).toContain('Dependency retention cleanup failed')
    expect(result.stderr).not.toContain('restoring previous activation')
    expect(await readlink(join(f.root, 'deploy/current'))).toBe(f.newRelease)
  } finally { await f.dispose() }
})

// macOS has no flock executable. This adapter acquires the same advisory flock
// on the shell's inherited descriptor; it does not substitute a fake lock.
const realFlock = `flock() { python3 -c 'import fcntl, sys; fcntl.flock(int(sys.argv[1]), fcntl.LOCK_EX | fcntl.LOCK_NB)' "\${@: -1}"; }\n`
test('concurrent activation is rejected and Caddy lock stays held until completion', async () => {
  const f = await fixture('success')
  const first = f.run(realFlock + `
curl() {
  case "\${@: -1}" in
    https:*) touch "$FIXTURE/public-wait"; while ! test -f "$FIXTURE/release-public"; do command sleep 0.02; done ;;
    */api/knowledge/index) echo '{"revision":"wiki-next","documents":[{}]}' ;;
  esac
}
`)
  try {
    const deadline = Date.now() + 4000
    while (!await Bun.file(join(f.root, 'public-wait')).exists() && Date.now() < deadline) await Bun.sleep(20)
    expect(await Bun.file(join(f.root, 'public-wait')).exists()).toBe(true)
    const second = await f.run(realFlock)
    expect(second.code).toBe(1)
    expect(second.stderr).toContain('Another stack deployment is active')
    expect(second.stderr).not.toContain('restoring previous activation')
    const caddyLock = () => Bun.spawn(['bash', '-c', `${realFlock}exec 8>"$FIXTURE/locks/caddy-config.lock"; flock -n 8`], { env: { ...process.env, FIXTURE: f.root }, stdout: 'pipe', stderr: 'pipe' })
    expect(await caddyLock().exited).not.toBe(0)
    await f.put('release-public', '')
    const result = await first
    expect(result.code, result.stderr).toBe(0)
    expect(await caddyLock().exited).toBe(0)
    expect(await readlink(join(f.root, 'deploy/current'))).toBe(f.newRelease)
  } finally {
    await f.put('release-public', '')
    await first
    await f.dispose()
  }
})
