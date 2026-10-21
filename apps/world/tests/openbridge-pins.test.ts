import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The OpenBridge policy's versions (§4; apps/world/AGENTS.md): both packages
// are pinned exactly in World's package.json and in bun.lock, installed at
// that version from the registry, with no patch, alias, override or fork,
// declared by no other workspace, and NOTICE.md names each at that version.
// An upgrade that misses one of them fails here. Each rule is checked against
// a planted violation.

const repository = join(import.meta.dir, '../../..')
const world = join(repository, 'apps/world')
const PACKAGES = ['@oicl/openbridge-webcomponents', '@oicl/connector-diagram'] as const

interface Manifest { readonly dependencies?: Record<string, string>; readonly devDependencies?: Record<string, string>; readonly [key: string]: unknown }
const manifest = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf8')) as Manifest
const declared = (pkg: Manifest, name: string): string | undefined => pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]

/** Why World's pins of the packages are not exact, one line each. */
const inexactPins = (pkg: Manifest): ReadonlyArray<string> => PACKAGES.flatMap(name => {
  const spec = declared(pkg, name)
  return spec === undefined ? [`${name} is not declared`] : /^\d+\.\d+\.\d+$/.test(spec) ? [] : [`${name} is "${spec}", not an exact version`]
})

/** Why bun.lock does not hold each package at its pin, from the registry, once. */
const lockProblems = (lock: string, pins: ReadonlyMap<string, string>): ReadonlyArray<string> => [...pins].flatMap(([name, version]) => {
  const quoted = name.replace(/[/@.-]/g, '\\$&')
  const workspace = lock.match(new RegExp(`"apps/world": \\{[\\s\\S]*?\\n    \\},`))?.[0] ?? ''
  const entries = [...lock.matchAll(new RegExp(`\\n    "((?:[^"]*/)?${quoted})": \\["([^"]+)", "([^"]*)"`, 'g'))]
  return [
    ...(workspace.includes(`"${name}": "${version}"`) ? [] : [`${name}: the apps/world workspace does not pin ${version}`]),
    ...(entries.length === 1 ? [] : [`${name}: ${entries.length} lock entries, not one`]),
    ...entries.flatMap(entry => entry[1] === name && entry[2] === `${name}@${version}` && entry[3] === '' ? [] : [`${name}: locked as ${entry[1]} → ${entry[2]} from "${entry[3]}"`]),
  ]
})

/** Why NOTICE.md does not name each package at its pin. */
const noticeProblems = (notice: string, pins: ReadonlyMap<string, string>): ReadonlyArray<string> => [...pins].flatMap(([name, version]) => {
  const named = [...notice.matchAll(new RegExp(`\`${name.replace(/[/@.-]/g, '\\$&')}\` (\\S+?)[\\s,)]`, 'g'))].map(match => match[1]!)
  return named.length > 0 && named.every(text => text === version) ? [] : [`NOTICE.md names ${name} as ${named.length === 0 ? 'nothing' : named.join(', ')}, not ${version}`]
})

const worldManifest = manifest(join(world, 'package.json'))
const pins = new Map(PACKAGES.map(name => [name, declared(worldManifest, name) ?? ''] as const))
const lock = readFileSync(join(repository, 'bun.lock'), 'utf8')

describe('OpenBridge versions', () => {
  test('World pins both packages to an exact version, and no other workspace declares them', () => {
    expect(inexactPins(worldManifest)).toEqual([])
    const workspaces = ['', ...['apps', 'packages'].flatMap(dir => readdirSync(join(repository, dir)).map(name => `${dir}/${name}`))]
      .filter(dir => dir !== 'apps/world' && existsSync(join(repository, dir, 'package.json')))
    expect(workspaces.length).toBeGreaterThan(3)
    expect(workspaces.flatMap(dir => PACKAGES.filter(name => declared(manifest(join(repository, dir, 'package.json')), name) !== undefined).map(name => `${dir || '.'}: ${name}`))).toEqual([])
  })

  test('bun.lock holds each at its pin from the registry, and nothing patches, aliases or overrides them', () => {
    expect(lockProblems(lock, pins)).toEqual([])
    const root = manifest(join(repository, 'package.json'))
    for (const field of ['patchedDependencies', 'overrides', 'resolutions'] as const) expect(JSON.stringify(root[field] ?? {})).not.toContain('@oicl/')
    expect(lock.match(/"(?:patchedDependencies|overrides)": \{[^}]*@oicl\//)).toBeNull()
  })

  test('the installed packages are the pinned versions', () => {
    expect(PACKAGES.map(name => [name, manifest(join(world, 'node_modules', name, 'package.json')).version])).toEqual(PACKAGES.map(name => [name, pins.get(name)]))
  })

  test('NOTICE.md names each package at its pinned version', () => {
    expect(noticeProblems(readFileSync(join(repository, 'NOTICE.md'), 'utf8'), pins)).toEqual([])
  })

  test('planted: a caret range, a tarball lock entry and a notice naming the old version are each caught', () => {
    expect(inexactPins({ devDependencies: { '@oicl/openbridge-webcomponents': '^2.0.0', '@oicl/connector-diagram': '1.0.0' } }))
      .toEqual(['@oicl/openbridge-webcomponents is "^2.0.0", not an exact version'])
    const tarball = lock.replace(`["@oicl/connector-diagram@${pins.get('@oicl/connector-diagram')}", ""`, '["@oicl/connector-diagram@1.0.0", "https://example.invalid/connector-diagram.tgz"')
    expect(lockProblems(tarball, pins)).toEqual(['@oicl/connector-diagram: locked as @oicl/connector-diagram → @oicl/connector-diagram@1.0.0 from "https://example.invalid/connector-diagram.tgz"'])
    expect(lockProblems(lock, new Map([['@oicl/connector-diagram', '1.0.1']]))).toEqual([
      '@oicl/connector-diagram: the apps/world workspace does not pin 1.0.1',
      `@oicl/connector-diagram: locked as @oicl/connector-diagram → @oicl/connector-diagram@${pins.get('@oicl/connector-diagram')} from ""`,
    ])
    expect(noticeProblems('(`@oicl/openbridge-webcomponents` 1.0.1 and `@oicl/connector-diagram` 1.0.0, ©', pins))
      .toEqual([`NOTICE.md names @oicl/openbridge-webcomponents as 1.0.1, not ${pins.get('@oicl/openbridge-webcomponents')}`])
  })
})
