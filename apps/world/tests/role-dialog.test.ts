import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { geoPointFromLonLat, nowIso, runRolesOf, type ObjectId, type OperationalObject, type PackId, type RunRoles } from '../src/core/model/index.ts'
import { createActivePackViews } from '../src/core/packs/active-views.ts'
import { createPackPresentationComposer } from '../src/core/packs/presentation-composer.ts'
import { createWorldPackDescriptor, emptyPackScenarioConfigSchema, type PackObjectPresentationContext, type WorldPack } from '../src/core/packs/protocol.ts'
import { createMapFeatureStore } from '../src/ui/map-runtime/map-feature-store.ts'
import { roleBarChipLimit, roleBarModel } from '../src/ui/roles/role-controller.ts'
import {
  chooseSide,
  hiddenOnceHeld,
  openRoleDialog,
  roleDialogChange,
  roleDialogModel,
  roleDialogResult,
  seenRoleIdsFor,
  toggleControl,
  togglePreset,
  toggleSee,
  type RoleDialogDraft,
} from '../src/ui/roles/role-dialog.ts'
import { hiddenRolesStorageKey, readStoredHiddenRoles, writeStoredHiddenRoles, type RoleSetStorage } from '../src/ui/roles/role-session.ts'
import { compileWithRolePacks, openRunDefinition, roleAwareFixturePack } from './fixtures/role-runs.ts'

/**
 * The role dialog (owner amendment A9, item 4, generic over any Pack's
 * roles): a tree of category, then role, with See and Control boxes; presets
 * and roles without a category as one-tap rows; the roles of one chosen side.
 */

/** A test Pack deriving one category-bearing role per group, as a role-aware Pack derives roles at compile. */
const groupsPack = (groups: ReadonlyArray<{ readonly id: string; readonly label: string; readonly category: string; readonly side?: string }>): WorldPack => ({
  ...roleAwareFixturePack,
  scenarioRoles: (_config, context) => groups.map(group => ({
    id: `group:${group.id}`,
    label: group.label,
    class: 'operator' as const,
    category: group.category,
    ...(context.sides.length === 0 || group.side === undefined ? {} : { sees: [group.side] }),
  })),
})

/** The role declaration of a compiled Definition, whose presets bundle declared and derived roles. */
const compiledRoles = async (definition: Record<string, unknown>, pack: WorldPack): Promise<RunRoles> => {
  const declaration = runRolesOf(await compileWithRolePacks({ ...openRunDefinition, id: 'dialog-run', title: 'Dialog run', packs: [{ id: 'fixture', config: {}, items: [] }], ...definition }, [pack]))
  if (declaration === null) throw new Error('The dialog fixture declares roles')
  return declaration
}

const sided = await compiledRoles({
  sides: [
    { id: 'north', label: 'North', colour: '#1565c0' },
    { id: 'south', label: 'South', colour: '#c62828' },
  ],
  roles: [
    { id: 'north-desk', label: 'North desk', class: 'operator', sees: ['north'] },
    { id: 'south-desk', label: 'South desk', class: 'operator', sees: ['south'] },
    { id: 'control', label: 'Control', class: 'controller', sees: 'all' },
  ],
  rolePresets: [
    { id: 'north-solo', label: 'North solo', roles: ['north-desk', 'group:n-haul', 'group:n-guard'] },
    { id: 'south-solo', label: 'South solo', roles: ['south-desk', 'group:s-haul'] },
  ],
}, groupsPack([
  { id: 'n-haul', label: 'North haulers', category: 'Haulers', side: 'north' },
  { id: 'n-guard', label: 'North guards', category: 'Guards', side: 'north' },
  { id: 'n-haul-2', label: 'North haulers 2', category: 'Haulers', side: 'north' },
  { id: 's-haul', label: 'South haulers', category: 'Haulers', side: 'south' },
]))
const unsided = await compiledRoles({
  roles: [
    { id: 'desk', label: 'Desk', class: 'operator' },
    { id: 'control', label: 'Control', class: 'controller' },
  ],
}, groupsPack([
  { id: 'a', label: 'Crew A', category: 'Crews' },
  { id: 'b', label: 'Crew B', category: 'Crews' },
]))

const model = (declaration: RunRoles, draft: RoleDialogDraft, held: ReadonlyArray<string> = [], mode: 'join' | 'switch' = 'switch') =>
  roleDialogModel(declaration, draft, { mode, held, holders: { 'group:n-haul': 2 } })
const tree = (declaration: RunRoles, draft: RoleDialogDraft) =>
  model(declaration, draft).categories.map(category => [category.label, category.rows.map(row => `${row.id}:${row.see ? 'S' : '-'}${row.control ? 'C' : '-'}`)])

describe('the role dialog', () => {
  test('lists the chosen side\'s roles as a tree of category, then role, and presets and roles without a category as rows above it', () => {
    const draft = openRoleDialog(sided, ['group:n-haul'], [])
    expect(draft).toEqual({ side: 'north', control: ['group:n-haul'], hidden: [] })
    expect(tree(sided, draft)).toEqual([
      ['Haulers', ['group:n-haul:SC', 'group:n-haul-2:S-']],
      ['Guards', ['group:n-guard:S-']],
    ])
    const shown = model(sided, draft)
    expect(shown.presets.map(row => [row.kind, row.id, row.ticked, row.holders])).toEqual([
      ['preset', 'north-solo', false, null], ['role', 'north-desk', false, 0], ['role', 'control', false, 0],
    ])
    expect(shown.sides.map(side => [side.id, side.chosen])).toEqual([['north', true], ['south', false]])
    expect(shown.categories[0]!.rows[0]).toMatchObject({ label: 'North haulers', holders: 2, sides: [sided.sides![0]] })
    // Choosing the other side lists its roles; truth roles show on every side.
    const south = chooseSide(sided, draft, 'south')
    expect(tree(sided, south)).toEqual([['Haulers', ['group:s-haul:S-']]])
    expect(model(sided, south).presets.map(row => row.id)).toEqual(['south-solo', 'south-desk', 'control'])
    expect(() => chooseSide(sided, draft, 'east')).toThrow('Unknown side: east')
  })

  test('Control implies See: ticking Control ticks See, unticking See unticks Control, and unticking Control keeps See', () => {
    let draft = openRoleDialog(sided, ['north-desk'], ['group:n-guard'])
    expect(tree(sided, draft)).toEqual([['Haulers', ['group:n-haul:S-', 'group:n-haul-2:S-']], ['Guards', ['group:n-guard:--']]])
    draft = toggleControl(sided, draft, 'group:n-guard')
    expect(tree(sided, draft)[1]).toEqual(['Guards', ['group:n-guard:SC']])
    expect(draft.control).toEqual(['north-desk', 'group:n-guard'])
    draft = toggleSee(sided, draft, 'group:n-guard')
    expect(tree(sided, draft)[1]).toEqual(['Guards', ['group:n-guard:--']])
    expect(draft.control).toEqual(['north-desk'])
    draft = toggleSee(sided, toggleControl(sided, toggleSee(sided, draft, 'group:n-guard'), 'group:n-guard'), 'group:n-haul-2')
    draft = toggleControl(sided, draft, 'group:n-guard')
    expect(tree(sided, draft)).toEqual([['Haulers', ['group:n-haul:S-', 'group:n-haul-2:--']], ['Guards', ['group:n-guard:S-']]])
    expect(() => toggleControl(sided, draft, 'ghost')).toThrow('Unknown role: ghost')
  })

  test('a preset row ticks Control and See of all its roles, and unticks them all when all are held', () => {
    let draft = openRoleDialog(sided, ['control'], ['group:n-guard'])
    draft = togglePreset(sided, draft, 'north-solo')
    expect(draft).toEqual({ side: 'north', control: ['north-desk', 'control', 'group:n-haul', 'group:n-guard'], hidden: [] })
    expect(model(sided, draft).presets.find(row => row.id === 'north-solo')?.ticked).toBe(true)
    draft = togglePreset(sided, draft, 'north-solo')
    expect(draft.control).toEqual(['control'])
    // A role without a category is a row of its own.
    expect(togglePreset(sided, draft, 'north-desk').control).toEqual(['north-desk', 'control'])
    expect(togglePreset(sided, togglePreset(sided, draft, 'north-desk'), 'north-desk').control).toEqual(['control'])
  })

  test('holding roles of two sides is allowed with the warning; held roles another side lists stay named', () => {
    let draft = openRoleDialog(sided, ['group:n-haul'], [])
    draft = toggleControl(sided, chooseSide(sided, draft, 'south'), 'group:s-haul')
    const shown = model(sided, draft, ['group:n-haul'])
    expect(shown.warning).toBe('This screen sees North and South together: play fair')
    expect(shown.alsoHeld).toEqual(['North haulers'])
    expect(shown.applyText).toBe('Play North haulers + South haulers')
  })

  test('applies as the role set to hold and this tab\'s unseen roles, asking the Run only when the set changed', () => {
    const draft = toggleSee(sided, openRoleDialog(sided, ['group:n-haul'], []), 'group:n-guard')
    expect(roleDialogResult(draft)).toEqual({ roleIds: ['group:n-haul'], hidden: ['group:n-guard'] })
    expect(roleDialogChange(['group:n-haul'], roleDialogResult(draft))).toEqual({ kind: 'unchanged' })
    expect(model(sided, draft, ['group:n-haul']).applyText).toBe('Apply')
    const more = toggleControl(sided, draft, 'group:n-haul-2')
    expect(roleDialogChange(['group:n-haul'], roleDialogResult(more))).toEqual({ kind: 'set', roleIds: ['group:n-haul', 'group:n-haul-2'] })
    const none = toggleControl(sided, draft, 'group:n-haul')
    expect([model(sided, none, ['group:n-haul']).canApply, model(sided, none, ['group:n-haul']).applyText]).toEqual([false, 'Tick at least one role'])
    expect(model(sided, openRoleDialog(sided, [], []), [], 'join').applyText).toBe('Tick a role to join')
    expect(model(sided, more, [], 'join').applyText).toBe('Join as North haulers + North haulers 2')
  })

  test('a Run without sides lists every role, with no side to choose', () => {
    const draft = openRoleDialog(unsided, [], [])
    expect(draft.side).toBeNull()
    const shown = model(unsided, draft)
    expect([shown.sides, shown.presets.map(row => row.id), shown.categories.map(category => category.label)]).toEqual([[], ['desk', 'control'], ['Crews']])
  })

  test('the roles a screen shows Packs: every declared role but the unseen, and always the held ones', () => {
    expect(seenRoleIdsFor(unsided, ['group:a'], ['group:a', 'group:b'])).toEqual(['desk', 'control', 'group:a'])
    expect(seenRoleIds(unsided)).toEqual(['desk', 'control', 'group:a', 'group:b'])
    // Opening keeps no unseen role that is held or undeclared.
    expect(openRoleDialog(unsided, ['group:a'], ['group:a', 'ghost', 'group:b']).hidden).toEqual(['group:b'])
  })

  test('unseen roles live per tab in sessionStorage, and a malformed entry is an error', () => {
    const values = new Map<string, string>()
    const storage: RoleSetStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
    const key = hiddenRolesStorageKey('w1', 'run-1')
    expect(key).toBe('leitbild.world.hidden-roles:w1:run-1')
    expect(readStoredHiddenRoles(storage, key)).toEqual([])
    writeStoredHiddenRoles(storage, key, ['group:a'])
    expect(readStoredHiddenRoles(storage, key)).toEqual(['group:a'])
    writeStoredHiddenRoles(storage, key, [])
    expect(values.has(key)).toBe(false)
    values.set(key, '{"a":1}')
    expect(() => readStoredHiddenRoles(storage, key)).toThrow('Stored unseen roles are not a list of role ids')
  })

  test('a role the screen comes to hold is seen from then on, even after it is dropped again', () => {
    // Unticked earlier, then gained by P and a digit: holding it ticks See, so dropping it later leaves it seen.
    const hidden = hiddenOnceHeld(['group:a', 'group:b'], ['desk', 'group:a'])
    expect(hidden).toEqual(['group:b'])
    expect(seenRoleIdsFor(unsided, ['desk'], hidden)).toEqual(['desk', 'control', 'group:a'])
    expect(hiddenOnceHeld(['group:b'], ['desk'])).toEqual(['group:b'])
  })

  test('the role bar shows a few held roles and collapses the rest into one chip that opens the dialog', () => {
    const many = ['control', 'group:n-haul', 'group:n-guard', 'group:n-haul-2', 'group:s-haul', 'north-desk']
    const bar = roleBarModel(sided, many)
    expect(bar.chips.map(chip => chip.id)).toEqual(['north-desk', 'control'])
    expect([bar.more, bar.moreLabels]).toEqual([4, ['North haulers', 'North guards', 'North haulers 2', 'South haulers']])
    expect(roleBarModel(sided, many.slice(0, roleBarChipLimit))).toMatchObject({ more: 0, moreLabels: [] })
    expect(roleBarModel(sided, many.slice(0, roleBarChipLimit)).chips).toHaveLength(roleBarChipLimit)
  })

  test('the route offers the dialog when joining and from the role bar, and the role bar no longer has an add menu', () => {
    const route = readFileSync(join(import.meta.dir, '..', 'src', 'ui', 'routes', 'ControlSurfaceRoute.svelte'), 'utf8')
    const markup = route.slice(route.indexOf('</script>'))
    expect(markup).toMatch(/\{#if\s+rolePicker\s*\}\s*<RoleDialog\s+mode="join"/)
    expect(markup).toMatch(/\{#if\s+roleDialogOpen\s*&&\s*runRoles\s*&&\s*heldRoleIds\s*\}\s*<RoleDialog\s+mode="switch"/)
    expect(markup).toMatch(/<Panel\b[^>]*\{seenRoleIds\}/)
    const bar = readFileSync(join(import.meta.dir, '..', 'src', 'ui', 'roles', 'RoleBar.svelte'), 'utf8')
    expect(bar).not.toContain('role-add')
    // A tap on a role, on "+N" or on Roles opens the dialog; no tap plays one role alone, and only × drops one at once.
    expect(bar).toMatch(/class="role-chip__label"[^>]*onclick=\{openDialog\}/)
    expect(bar).toMatch(/class="role-bar__more"[^>]*onclick=\{openDialog\}/)
    expect(bar).toMatch(/class="role-bar__dialog"[^>]*onclick=\{openDialog\}/)
    expect(bar).not.toContain('switchToEntry')
    expect(bar.match(/onclick=\{\(\) => request\(/g)).toHaveLength(1)
    // Adopting a held set clears those roles from this tab's unseen roles.
    const adopt = route.slice(route.indexOf('const adoptPerspective'), route.indexOf('const failRoleSwitch'))
    expect(adopt).toMatch(/keepHiddenRoles\(hiddenOnceHeld\(hiddenRoleIds,\s*perspective\.roleIds\)\)/)
  })
})

const seenRoleIds = (declaration: RunRoles): ReadonlyArray<string> => seenRoleIdsFor(declaration, [], [])

describe('the See hook for Packs', () => {
  const object: OperationalObject = {
    id: 'unit:one' as ObjectId,
    kind: 'mobile_entity',
    packId: 'seeing' as PackId,
    label: 'Unit one',
    lifecycle: 'active',
    revision: 1,
    spatial: {
      frame: { kind: 'wgs84' },
      position: { point: geoPointFromLonLat(10.75, 59.91), observedAt: nowIso() },
      route: { planned: { type: 'LineString', coordinates: [geoPointFromLonLat(10.75, 59.91).coordinates, geoPointFromLonLat(10.8, 59.93).coordinates] }, source: 'simulator' },
    },
    operational: { status: 'normal', mode: 'simulated' },
    alerts: [],
    provenance: { source: 'simulator' },
    timestamps: { createdAt: nowIso(), updatedAt: nowIso() },
  }
  const packWith = (id: string, present: (context: PackObjectPresentationContext) => boolean): WorldPack => ({
    descriptor: createWorldPackDescriptor({ id, version: '1.0.0', name: id, description: 'Test Pack.', contributions: ['presentation'] }),
    scenarioConfigSchema: emptyPackScenarioConfigSchema,
    presentation: {
      categories: [{ id: 'units', label: 'Units', emptyLabel: 'No units', matches: () => true }],
      presentObject: (_candidate, context) => ({ categoryId: 'units', icon: 'square', color: '#16834f', summary: 'unit', fields: [], ...(present(context) ? {} : { mapIconVisible: false }) }),
    },
  })

  test('reaches a Pack\'s presentation through the composer, which presents again when it changes; a Pack ignoring it is unaffected', () => {
    let seen: ReadonlyArray<string> | undefined
    const contexts: Array<ReadonlyArray<string> | undefined> = []
    const pack = packWith('seeing', context => { contexts.push(context.seenRoleIds); return context.seenRoleIds?.includes('group:a') ?? true })
    const views = createActivePackViews([pack])
    const objects = [object]
    const composer = createPackPresentationComposer({
      getContext: () => ({ pack: views, objects, ...(seen === undefined ? {} : { seenRoleIds: seen }) }),
    })
    expect(composer.present(object).mapIconVisible).toBeUndefined()
    seen = ['group:b']
    expect(composer.present(object).mapIconVisible).toBe(false)
    seen = ['group:a', 'group:b']
    expect(composer.present(object).mapIconVisible).toBeUndefined()
    expect(composer.present(object).mapIconVisible).toBeUndefined()
    expect(contexts).toEqual([undefined, ['group:b'], ['group:a', 'group:b']])
    const ignoring = createPackPresentationComposer({ getContext: () => ({ pack: createActivePackViews([packWith('seeing', () => true)]), objects: [object], seenRoleIds: [] }) })
    expect(ignoring.present(object).mapIconVisible).toBeUndefined()
  })

  test('an object whose icon the Pack does not draw draws no route either', () => {
    const project = (visible: boolean) => createMapFeatureStore().update({
      objects: [object],
      selectedControllerId: null,
      highlightedObjectIds: [],
      hiddenObjectCategoryIds: [],
      placementPoints: [],
      packFeatures: [],
      hasNewInfo: () => false,
      presentationFor: () => ({ categoryId: 'units', icon: 'square', color: '#16834f', summary: 'unit', fields: [], ...(visible ? {} : { mapIconVisible: false }) }),
    })
    expect([project(true).points.length, project(true).paths.filter(path => path.kind === 'route').length]).toEqual([1, 1])
    expect([project(false).points.length, project(false).paths.length]).toEqual([0, 0])
  })
})
