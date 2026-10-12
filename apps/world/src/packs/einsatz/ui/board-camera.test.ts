import { describe, expect, test } from 'bun:test'
import { startingZoomFor } from '../../../ui/map/map-camera.ts'
import { noMapCover } from '../../../ui/surface-panel-interaction.ts'
import border from '../fixtures/halden-border.scenario.json'
import borderHumanRed from '../fixtures/halden-border-human-red.scenario.json'
import civil from '../fixtures/halden-civil.scenario.json'
import civilRoles from '../fixtures/halden-civil-roles.scenario.json'
import supplyRun from '../fixtures/supply-run.scenario.json'
import { clearPart, screenPointOf, shownBesideBoard, type CameraView } from './board-camera.ts'
import { boardLayoutFor, boardMapCover } from './board-layout.ts'

/**
 * The map beside the Board: a call or asset selected from the lists that
 * lies under the Board, under the bars or off the map is brought into view,
 * and every Einsatz scenario's Starting View shows all its objects beside
 * the Board on an iPad (1024 × 768) and at 960 × 720. The border exercises
 * keep their close-up of the fighting: a receiving site far behind it, and
 * the units based there, may lie off that view, since they are picked from
 * the lists, which bring them into view.
 */

/** The World surface below the Host's 44 px header, for these windows. */
const surfaces = [{ width: 1024, height: 768 - 44 }, { width: 960, height: 720 - 44 }] as const
const coverAt = (width: number) => boardMapCover(boardLayoutFor(width, 'work-list').widthPx)

describe('the map beside the Board', () => {
  test('a point at the camera\'s centre lies in the middle of the part the Board leaves clear; east is right, north up, and a bearing turns it', () => {
    const size = surfaces[0]
    const cover = coverAt(size.width)
    const camera: CameraView = { center: [11.3, 59.2], zoom: 11, bearing: 0 }
    const centre = screenPointOf(camera, size, cover, [11.3, 59.2])
    expect(centre.x).toBeCloseTo((size.width - cover.right) / 2, 6)
    expect(centre.y).toBeCloseTo(size.height / 2, 6)
    const east = screenPointOf(camera, size, cover, [11.31, 59.2])
    const north = screenPointOf(camera, size, cover, [11.3, 59.21])
    expect([east.x > centre.x, Math.abs(east.y - centre.y) < 1e-6, north.y < centre.y]).toEqual([true, true, true])
    // Facing east, a point to the east lies above the centre.
    const turned = screenPointOf({ ...camera, bearing: 90 }, size, cover, [11.31, 59.2])
    expect([Math.abs(turned.x - centre.x) < 1e-6, turned.y < centre.y]).toEqual([true, true])
  })

  test('a point under the Board, under the bars or off the map is not shown beside the Board; one in the clear part is', () => {
    const size = surfaces[1]
    const cover = coverAt(size.width)
    const camera: CameraView = { center: [11.3, 59.2], zoom: 12, bearing: 0 }
    const clear = clearPart(size, cover)
    const at = (x: number, y: number): readonly [number, number] => {
      // Back from screen to a point by small steps east and north, as the projection is locally linear.
      const origin = screenPointOf(camera, size, cover, [11.3, 59.2])
      const perLon = screenPointOf(camera, size, cover, [11.301, 59.2]).x - origin.x
      const perLat = screenPointOf(camera, size, cover, [11.3, 59.201]).y - origin.y
      return [11.3 + (x - origin.x) / perLon * 0.001, 59.2 + (y - origin.y) / perLat * 0.001]
    }
    expect(shownBesideBoard(camera, size, cover, [11.3, 59.2])).toBe(true)
    expect(shownBesideBoard(camera, size, cover, at(clear.right + 20, size.height / 2))).toBe(false)
    expect(shownBesideBoard(camera, size, cover, at(size.width - cover.right / 2, size.height / 2))).toBe(false)
    expect(shownBesideBoard(camera, size, cover, at(clear.left + 10, clear.top - 10))).toBe(false)
    expect(shownBesideBoard(camera, size, cover, at(clear.left + 10, clear.bottom + 10))).toBe(false)
    expect(shownBesideBoard(camera, size, cover, [12.3, 59.2])).toBe(false)
    expect(shownBesideBoard(camera, size, cover, at(clear.left + 10, clear.top + 10))).toBe(true)
    // With no Board open the same point east of the clear part is in view.
    expect(shownBesideBoard(camera, size, noMapCover, at(clear.right + 20, size.height / 2))).toBe(true)
  })

  interface PlacedItem { readonly label: string; readonly unitType?: string; readonly position?: ReadonlyArray<number> }
  interface Scenario {
    readonly packs: ReadonlyArray<{ readonly items: ReadonlyArray<PlacedItem>; readonly config: { readonly unitTypes: ReadonlyArray<{ readonly id: string; readonly components: Readonly<Record<string, unknown>> }> } }>
    readonly view: { readonly map: { readonly center: ReadonlyArray<number>; readonly zoom: number } }
  }
  /** How near a receiving site a unit stands to be based there, in degrees (about 1 km). */
  const basedAtDeg = 0.01
  /** A receiving site, and the units standing at one: what a close-up of the fighting may leave off its view. */
  const atReceivingSite = (scenario: Scenario): ((item: PlacedItem) => boolean) => {
    const pack = scenario.packs[0]!
    const receiving = new Set(pack.config.unitTypes.filter(type => type.components['receiving'] !== undefined).map(type => type.id))
    const sites = pack.items.filter(item => item.unitType !== undefined && receiving.has(item.unitType) && item.position !== undefined)
    return item => item.position !== undefined && sites.some(site => Math.hypot(site.position![0]! - item.position![0]!, site.position![1]! - item.position![1]!) <= basedAtDeg)
  }
  const scenarios: ReadonlyArray<readonly [string, Scenario, ReadonlyArray<string>]> = [
    ['civil', civil, []],
    ['civilRoles', civilRoles, []],
    ['supplyRun', supplyRun, []],
    ['border', border, ['Kalnes receiving site — exercise', 'H1']],
    ['borderHumanRed', borderHumanRed, ['Kalnes receiving site — exercise', 'H1']],
  ]
  for (const [name, scenario, offView] of scenarios) {
    test(`the ${name} Starting View shows every starting object beside the Board at 1024 × 768 and 960 × 720${offView.length === 0 ? '' : ', but a distant receiving site and the units based there'}`, () => {
      const items = scenario.packs[0]!.items
      const placed = items.flatMap(item => item.position === undefined ? [] : [{ ...item, position: [item.position[0]!, item.position[1]!] as const }])
      expect(placed.length).toBeGreaterThan(0)
      // Only a receiving site and the units standing at it may be left off, and only where the scenario says so.
      const distant = atReceivingSite(scenario)
      expect(offView.every(label => placed.some(item => item.label === label && distant(item)))).toBe(true)
      for (const size of surfaces) {
        const cover = coverAt(size.width)
        const { center, zoom } = scenario.view.map
        const camera: CameraView = { center: [center[0]!, center[1]!], zoom: startingZoomFor(zoom, size, cover), bearing: 0 }
        const hidden = placed.filter(item => !shownBesideBoard(camera, size, cover, item.position)).map(item => item.label)
        expect(hidden).toEqual([...offView])
      }
    })
  }
})
