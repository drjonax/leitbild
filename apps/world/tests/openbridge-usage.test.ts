import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Every OpenBridge element property and enum value Leitbild sets exists in the
// installed OpenBridge's Custom Elements Manifest: the Svelte templates (which
// no type check reads) and the mimic's element recipes. A renamed property or
// value fails here on an upgrade instead of silently drawing a default.

const root = join(import.meta.dir, '..')
const openBridge = join(root, 'node_modules/@oicl/openbridge-webcomponents')

interface ManifestField { readonly name: string; readonly type?: { readonly text: string }; readonly privacy?: string; readonly kind: string }
interface ManifestDeclaration { readonly name: string; readonly tagName?: string; readonly members?: ReadonlyArray<ManifestField>; readonly attributes?: ReadonlyArray<{ readonly name: string; readonly fieldName?: string }> }
const manifest = JSON.parse(readFileSync(join(openBridge, 'custom-elements.json'), 'utf8')) as { readonly modules: ReadonlyArray<{ readonly declarations?: ReadonlyArray<ManifestDeclaration> }> }

interface ElementApi {
  /** Public fields by property name, with their declared type text. */
  readonly fields: ReadonlyMap<string, string | undefined>
  readonly attributes: ReadonlySet<string>
}

const elements = new Map<string, ElementApi>()
const tagOfClass = new Map<string, string>()
for (const declaration of manifest.modules.flatMap(module => module.declarations ?? [])) {
  if (declaration.tagName === undefined) continue
  const fields = new Map((declaration.members ?? []).filter(member => member.kind === 'field' && (member.privacy === undefined || member.privacy === 'public')).map(member => [member.name, member.type?.text]))
  elements.set(declaration.tagName, { fields, attributes: new Set((declaration.attributes ?? []).map(attribute => attribute.name)) })
  tagOfClass.set(declaration.name, declaration.tagName)
}

const files = (directory: string, suffix: string): ReadonlyArray<string> => readdirSync(directory).flatMap(name => {
  const path = join(directory, name)
  return statSync(path).isDirectory() ? files(path, suffix) : name.endsWith(suffix) ? [path] : []
})

// OpenBridge's enums (the manifest leaves their names unresolved), read from its declarations.
const enums = new Map<string, ReadonlyMap<string, string>>()
for (const path of files(join(openBridge, 'dist'), '.d.ts')) {
  for (const match of readFileSync(path, 'utf8').matchAll(/export declare enum (\w+) \{([^}]*)\}/g)) {
    enums.set(match[1]!, new Map([...match[2]!.matchAll(/(\w+) = "([^"]*)"/g)].map(member => [member[1]!, member[2]!])))
  }
}

/** The values a field's declared type allows where it is one OpenBridge enum; null where it is not. */
const enumValues = (type: string | undefined): ReadonlySet<string> | null => {
  const values = type === undefined ? undefined : enums.get(type.trim())
  return values === undefined ? null : new Set(values.values())
}

/** Each `<obc-…>` start tag in a Svelte source, braces and quotes respected: `=>` inside a handler does not end it. */
const startTags = (source: string): ReadonlyArray<{ readonly tag: string; readonly body: string; readonly line: number }> => {
  const found: Array<{ tag: string; body: string; line: number }> = []
  for (const match of source.matchAll(/<(obc-[a-z0-9-]+)/g)) {
    let depth = 0
    let quote: string | null = null
    let at = match.index! + match[0].length
    for (; at < source.length; at += 1) {
      const char = source[at]!
      if (quote !== null) { if (char === quote) quote = null; continue }
      if (char === '"' || char === "'" || char === '`') quote = char
      else if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      else if (char === '>' && depth === 0) break
    }
    found.push({ tag: match[1]!, body: source.slice(match.index! + match[0].length, at), line: source.slice(0, match.index!).split('\n').length })
  }
  return found
}

/** A start tag's attributes: name and its literal text or `{expression}`. */
const attributesOf = (body: string): ReadonlyArray<{ readonly name: string; readonly literal?: string; readonly expression?: string }> => {
  const found: Array<{ name: string; literal?: string; expression?: string }> = []
  let at = 0
  const skipSpace = (): void => { while (at < body.length && /\s|\//.test(body[at]!)) at += 1 }
  while (at < body.length) {
    skipSpace()
    if (at >= body.length) break
    if (body[at] === '{') {
      // A shorthand or spread attribute: {value} or {...rest}.
      let depth = 0
      const start = at
      for (; at < body.length; at += 1) { if (body[at] === '{') depth += 1; else if (body[at] === '}' && --depth === 0) { at += 1; break } }
      found.push({ name: body.slice(start + 1, at - 1).replace(/^\.\.\./, '').trim() })
      continue
    }
    const name = body.slice(at).match(/^[A-Za-z_][\w:.|-]*/)?.[0]
    if (name === undefined) throw new Error(`cannot read attributes from: ${body.slice(at, at + 40)}`)
    at += name.length
    if (body[at] !== '=') { found.push({ name }); continue }
    at += 1
    const open = body[at]!
    if (open === '"' || open === "'") {
      const close = body.indexOf(open, at + 1)
      found.push({ name, literal: body.slice(at + 1, close) })
      at = close + 1
    } else if (open === '{') {
      let depth = 0
      const start = at
      for (; at < body.length; at += 1) { if (body[at] === '{') depth += 1; else if (body[at] === '}' && --depth === 0) { at += 1; break } }
      found.push({ name, expression: body.slice(start + 1, at - 1) })
    } else {
      const value = body.slice(at).match(/^[^\s>]+/)![0]
      found.push({ name, literal: value })
      at += value.length
    }
  }
  return found
}

// HTML and Svelte attributes every element takes; none is an OpenBridge property.
const GENERIC = new Set(['class', 'style', 'id', 'title', 'slot', 'role', 'tabindex', 'hidden', 'part'])
const generic = (name: string): boolean => GENERIC.has(name) || name.startsWith('aria-') || name.startsWith('data-') || name.startsWith('on') || name.includes(':')

describe('OpenBridge usage against its Custom Elements Manifest', () => {
  test('every OpenBridge element in a Svelte template is set only through properties and enum values it declares', () => {
    const problems: string[] = []
    let checked = 0
    for (const path of files(join(root, 'src/ui'), '.svelte')) {
      const file = relative(root, path)
      for (const start of startTags(readFileSync(path, 'utf8'))) {
        const api = elements.get(start.tag)
        if (api === undefined) { problems.push(`${file}:${start.line}: <${start.tag}> is not an OpenBridge element`); continue }
        for (const attribute of attributesOf(start.body)) {
          if (generic(attribute.name)) continue
          checked += 1
          if (!api.fields.has(attribute.name) && !api.attributes.has(attribute.name)) { problems.push(`${file}:${start.line}: <${start.tag}> has no property ${attribute.name}`); continue }
          const allowed = enumValues(api.fields.get(attribute.name))
          if (allowed === null) continue
          // The strings an expression can yield: its literals, less those it only compares against (typeof x === 'string').
          const yielded = (attribute.expression ?? '').replace(/(?:[!=]==?)\s*(?:'[^']*'|"[^"]*")|(?:'[^']*'|"[^"]*")\s*(?:[!=]==?)/g, '')
          const values = attribute.literal !== undefined ? [attribute.literal] : [...yielded.matchAll(/'([^']*)'|"([^"]*)"/g)].map(match => match[1] ?? match[2]!)
          for (const value of values) if (!allowed.has(value)) problems.push(`${file}:${start.line}: <${start.tag} ${attribute.name}> has no value "${value}" (${[...allowed].join(', ')})`)
        }
      }
    }
    expect(problems).toEqual([])
    expect(checked).toBeGreaterThan(40)
  })

  test("the mimic's element recipes set only properties and enum members OpenBridge declares", () => {
    const source = readFileSync(join(root, 'src/ui/embed/composed-display/mimic/openbridge-mimic.ts'), 'utf8')
    const constants = new Map([...source.matchAll(/const (\w+) = '(obc-[a-z0-9-]+)'/g)].map(match => [match[1]!, match[2]!]))
    // Which element each variable holds: created by tag, found by tag, or a parameter of an OpenBridge class type.
    const tagOf = new Map<string, string>([
      ...[...source.matchAll(/const (\w+) = document\.createElement\('(obc-[a-z0-9-]+)'\)/g)].map(match => [match[1]!, match[2]!] as const),
      ...[...source.matchAll(/const (\w+) = \w+\.querySelector\((\w+)\)/g)].flatMap(match => constants.has(match[2]!) ? [[match[1]!, constants.get(match[2]!)!] as const] : []),
      ...[...source.matchAll(/\b(\w+): (Obc\w+)\b/g)].flatMap(match => tagOfClass.has(match[2]!) ? [[match[1]!, tagOfClass.get(match[2]!)!] as const] : []),
    ])
    const problems: string[] = []
    let checked = 0
    for (const match of source.matchAll(/\b(\w+)\.(\w+) = ([^\n]+)/g)) {
      const tag = tagOf.get(match[1]!)
      if (tag === undefined) continue
      const [, variable, property, value] = match as unknown as [string, string, string, string]
      if (property === 'slot' || property === 'textContent' || property === 'dataset') continue
      checked += 1
      const api = elements.get(tag)!
      if (!api.fields.has(property)) { problems.push(`${variable} (<${tag}>).${property} is not a public OpenBridge property`); continue }
      for (const member of value.matchAll(/\b([A-Z]\w+)\.(\w+)\b/g)) {
        const declared = enums.get(member[1]!)
        if (declared === undefined) continue
        if (!declared.has(member[2]!)) problems.push(`${variable}.${property}: ${member[1]}.${member[2]} is not a member of OpenBridge's ${member[1]}`)
        if (api.fields.get(property)?.trim() !== member[1]) problems.push(`${variable}.${property} is declared ${api.fields.get(property)}, set from ${member[1]}`)
      }
    }
    expect(problems).toEqual([])
    expect(checked).toBeGreaterThan(40)
  })
})
