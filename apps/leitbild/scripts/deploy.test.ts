import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  INSTALL_MANIFEST_ONLY_WORKSPACE_PATHS,
  isProductKnowledgePath,
  isProductionSourcePath,
  PRODUCTION_DEPENDENCY_WORKSPACE_PATHS,
  moduleRoutingPreflight,
  caddySnippetPreflight,
  referencedInspectionEntries,
} from './deploy.ts'

const workspaceRoot = resolve(import.meta.dir, '../../..')
const productionAppPaths = ['apps/leitbild', 'apps/world', 'apps/agents'] as const

test('wiki inspection supplements only tracked referenced files and never overwrites another artifact source', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'leitbild-inspection-artifact-'))
  try {
    const git = async (...args: string[]) => {
      const p = Bun.spawn(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' })
      expect(await p.exited).toBe(0)
    }
    await git('init')
    const path = 'apps/world/scripts/calculation.ts'
    await Bun.write(resolve(root, path), 'export const result = 1\n')
    await Bun.write(resolve(root, 'apps/world/scripts/unrelated.ts'), 'export const unrelated = true\n')
    const knowledge = { revision: 'a'.repeat(40), documents: [{ path: 'index.md', content: `[Calculation](source:${path})` }] }
    await expect(referencedInspectionEntries(root, knowledge, [])).rejects.toThrow('tracked in Git')
    await git('add', path)
    const expected = { source: resolve(root, path), target: path }
    expect(await referencedInspectionEntries(root, knowledge, [])).toEqual([expected])
    expect(await referencedInspectionEntries(root, knowledge, [expected])).toEqual([])
    await expect(referencedInspectionEntries(root, knowledge, [{ target: path, source: resolve(root, 'other.ts') }])).rejects.toThrow('Conflicting')
  } finally { await rm(root, { recursive: true, force: true }) }
})

interface PackageJson {
  readonly name: string
  readonly dependencies?: Readonly<Record<string, string>>
}

test('production artifact includes every local workspace dependency', async () => {
  const includedPaths = [...productionAppPaths, ...PRODUCTION_DEPENDENCY_WORKSPACE_PATHS]
  const packages = await Promise.all(includedPaths.map(async path =>
    await Bun.file(resolve(workspaceRoot, path, 'package.json')).json() as PackageJson))
  const includedNames = new Set(packages.map(packageJson => packageJson.name))

  for (const packageJson of packages) {
    for (const [dependency, version] of Object.entries(packageJson.dependencies ?? {})) {
      if (version.startsWith('workspace:')) expect(includedNames.has(dependency)).toBe(true)
    }
  }
})

test('production install includes manifests for development-only lockfile workspaces', () => {
  expect(INSTALL_MANIFEST_ONLY_WORKSPACE_PATHS).toEqual(['packages/integration-tests'])
})

test('Module routing has one production owner and cannot be overridden by provider environment files', async () => {
  for (const module of ['world', 'agents']) {
    const unit = await Bun.file(resolve(workspaceRoot, `apps/leitbild/deploy/leitbild-${module}.service`)).text()
    const example = await Bun.file(resolve(workspaceRoot, `apps/leitbild/deploy/${module}.env.example`)).text()
    expect(unit).toContain('Environment=WORKSPACE_HOST_URL=http://127.0.0.1:3100')
    expect(example).not.toMatch(/^WORKSPACE_HOST_URL=/m)
  }
  expect(moduleRoutingPreflight()).toContain('for module in world agents')
  expect(moduleRoutingPreflight()).toContain('exit 1')
  expect(moduleRoutingPreflight()).toContain('grep -Eq') // Never prints credential-file content.
  const directory = await mkdtemp(resolve(tmpdir(), 'leitbild-routing-test-'))
  try {
    const check = async () => {
      const proc = Bun.spawn(['bash', '-euc', moduleRoutingPreflight().replaceAll('/etc/leitbild', directory)], { stdout: 'pipe', stderr: 'pipe' })
      return { code: await proc.exited, error: await new Response(proc.stderr).text() }
    }
    await writeFile(resolve(directory, 'agents.env'), '# WORKSPACE_HOST_URL is service-owned\nOPENAI_API_KEY=test-secret-marker\n')
    expect((await check()).code).toBe(0)
    for (const module of ['world', 'agents']) {
      await writeFile(resolve(directory, `${module}.env`), 'WORKSPACE_HOST_URL=https://retired.invalid\nOPENAI_API_KEY=test-secret-marker\n')
      const result = await check()
      expect(result.code).toBe(1)
      expect(result.error).toContain('Remove WORKSPACE_HOST_URL')
      expect(result.error).not.toContain('test-secret-marker')
      expect(result.error).not.toContain('retired.invalid')
      await rm(resolve(directory, `${module}.env`))
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('production artifact excludes development-only files', () => {
  expect(isProductionSourcePath('agents', 'src/main.ts')).toBe(true)
  expect(isProductionSourcePath('agents', 'examples/scripts/demo.md')).toBe(true)
  expect(isProductionSourcePath('agents', 'src/api/server.test.ts')).toBe(false)
  expect(isProductionSourcePath('agents', 'src/packs/example/fixtures/input.json')).toBe(false)
  expect(isProductionSourcePath('agents', 'src/api/__fixtures__/stub-gateway.ts')).toBe(false)
  expect(isProductionSourcePath('agents', 'docs/packs.md')).toBe(false)
  expect(isProductionSourcePath('world', 'tests/api.test.ts')).toBe(false)
  expect(isProductionSourcePath('host', 'deploy/backup/backup-production.sh')).toBe(false)
  expect(isProductionSourcePath('host', 'deploy/Caddyfile')).toBe(true)
  expect(isProductionSourcePath('host', 'deploy/sites/leitbild.caddy')).toBe(true)
  expect(isProductionSourcePath('host', 'deploy/sites/optifuel.caddy')).toBe(false)
  expect(isProductKnowledgePath('docs/adr/0015-leitbild-assistant-uses-an-ordinary-room.md')).toBe(true)
  expect(isProductKnowledgePath('contexts/agents/CONTEXT.md')).toBe(true)
  expect(isProductKnowledgePath('apps/world/README.md')).toBe(true)
  expect(isProductKnowledgePath('.env')).toBe(false)
})

test('public routing exposes only the bundled Agents UI asset namespace', async () => {
  const caddyfile = await Bun.file(resolve(workspaceRoot, 'apps/leitbild/deploy/sites/leitbild.caddy')).text()
  expect(caddyfile).toContain('/assets/agents/.*')
  expect(caddyfile).not.toContain('/modules/.*')
  expect(caddyfile).not.toContain('/biometrics/.*')
  expect(caddyfile).not.toContain('/dist\\.css')
})

test('Caddy root delegates site ownership and refuses unprovisioned shared layout', async () => {
  const root = await Bun.file(resolve(workspaceRoot, 'apps/leitbild/deploy/Caddyfile')).text()
  expect(root).toContain('import /etc/caddy/managed-sites/*.caddy')
  expect(root).not.toContain('leitbild.app {')
  const directory = await mkdtemp(resolve(tmpdir(), 'leitbild-caddy-preflight-'))
  try {
    await writeFile(resolve(directory, 'Caddyfile'), 'another.example { respond "keep" }\n')
    const proc = Bun.spawn(['bash', '-euc', caddySnippetPreflight().replaceAll('/etc/caddy', directory)], { stdout: 'pipe', stderr: 'pipe' })
    expect(await proc.exited).toBe(1)
    expect(await new Response(proc.stderr).text()).toContain('Existing host configuration will not be overwritten')
    expect(await readFile(resolve(directory, 'Caddyfile'), 'utf8')).toBe('another.example { respond "keep" }\n')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
