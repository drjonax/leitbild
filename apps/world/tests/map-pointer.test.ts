import { describe, expect, test } from 'bun:test'
import type { OperationalObject } from '../src/core/model/index.ts'
import { hoverCardsFor, longPressObject, type MapPress } from '../src/ui/map/map-pointer.ts'

/** Only the identity matters to the press rules. */
const object = (id: string): OperationalObject => ({ id }) as OperationalObject
const assigning = object('ambulance-1')
const other = object('einsatz-unit-1')
const press = (fields: Partial<MapPress>): MapPress => ({
  pointerType: 'mouse',
  button: 0,
  hovered: assigning,
  busy: false,
  canLongPress: candidate => candidate === assigning,
  ...fields,
})

describe('map pointer gestures', () => {
  test('hover cards and target previews show for a mouse only, and for nothing before the first pointer', () => {
    expect(hoverCardsFor('mouse')).toBe(true)
    for (const type of ['touch', 'pen', '', null]) expect(hoverCardsFor(type)).toBe(false)
  })

  test('a primary mouse press on a hovered object whose Pack takes a long press arms it', () => {
    expect(longPressObject(press({}))).toBe(assigning)
  })

  test('a touch or pen press never arms a long press, even with an object left hovered by the previous tap', () => {
    for (const pointerType of ['touch', 'pen']) expect(longPressObject(press({ pointerType }))).toBeNull()
  })

  test('a press on an object whose Pack declares no map assignment stays a plain click, so a slow press is never swallowed', () => {
    expect(longPressObject(press({ hovered: other }))).toBeNull()
  })

  test('nothing hovered, another button, or a placement or assignment under way arms nothing', () => {
    expect(longPressObject(press({ hovered: null }))).toBeNull()
    expect(longPressObject(press({ button: 2 }))).toBeNull()
    expect(longPressObject(press({ busy: true }))).toBeNull()
  })
})
