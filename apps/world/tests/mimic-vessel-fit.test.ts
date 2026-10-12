import { describe, expect, test } from 'bun:test'
import { fitVessel, VESSEL_ASPECT } from '../src/packs/process-plant/displays/mimic/vessel-fit.ts'
import { openBridgeDevice } from '../src/packs/process-plant/displays/mimic/text-metrics.ts'
import { vesselGeometry } from '../src/ui/embed/composed-display/mimic/vessel-symbol.ts'

// A reactor vessel keeps a vessel's proportions in whatever box the layout
// gives it (HMI verify 44: a 264 x 96 saucer on the SG A detail).

const box = { x: 672, y: 24, width: 264, height: 96 }
const below = (x: number) => ({ x: box.x + x, y: box.y + box.height, face: 'bottom' as const })

describe('where a reactor vessel stands in its box', () => {
  test('a box taller than wide holds it whole, its pipes at its side', () => {
    const tall = { x: 1488, y: 624, width: 96, height: 264 }
    const ports = [168, 192].map(y => ({ x: tall.x, y: tall.y + y, face: 'left' as const }))
    expect(fitVessel(tall, ports, 'top')).toEqual({ span: { x: 0, width: 96 }, nozzles: ports, routes: [] })
  })

  test('in a wide, short box it stands beside its rows at most 0.6 of its height wide; the pipes beside it continue to its side, the farther above the nearer', () => {
    const fit = fitVessel(box, [below(24), below(36), below(240)], 'right')
    const width = 2 * Math.floor((96 * VESSEL_ASPECT) / 2)
    expect(fit.span).toEqual({ x: 264 - width, width })
    const left = box.x + 264 - width
    // The pipe it takes from below stays where the layout put it; the two left of it continue to its left side.
    expect(fit.nozzles.filter(nozzle => nozzle.face === 'bottom')).toEqual([below(240)])
    expect(fit.routes.map(route => route.from.x)).toEqual([box.x + 36, box.x + 24])
    const [near, far] = fit.routes
    expect(near!.points).toEqual([[box.x + 36, near!.points[0]![1]], [left, near!.points[0]![1]]])
    expect(far!.points[0]![1]).toBeLessThan(near!.points[0]![1])
    // Both turn inside its body, below its head and above its bottom dome.
    const bodyTop = box.y + openBridgeDevice.reactorVessel.dome - 2 + openBridgeDevice.reactorVessel.flange
    for (const route of fit.routes) {
      expect(route.points[0]![1]).toBeGreaterThan(bodyTop)
      expect(route.points[0]![1]).toBeLessThan(box.y + box.height - openBridgeDevice.reactorVessel.bottomDome)
    }
    expect(fit.nozzles.filter(nozzle => nozzle.face === 'left').map(nozzle => nozzle.x)).toEqual([left, left])
  })

  test('with its rows above or below it, it stands where it takes the most of its pipes', () => {
    expect(fitVessel(box, [below(150), below(170), below(190), below(20)], 'top').span.x).toBeGreaterThanOrEqual(150 - 56)
  })

  test('its head stays a half-ellipse no flatter than 2:1, and it stands taller than wide', () => {
    const shape = vesselGeometry({ height: 96, origin: box, drawing: { core: 'overlap', span: { x: 208, width: 56 }, nozzles: [] }, level: 100, groups: [] })
    const [, rx, ry] = shape.dome.match(/A ([\d.]+) ([\d.]+)/)!.map(Number)
    expect(rx! / ry!).toBeLessThanOrEqual(2)
    expect(shape.body.x).toBeGreaterThanOrEqual(208)
    expect(shape.body.x + shape.body.width).toBeLessThanOrEqual(264)
    expect(shape.flange.width).toBeLessThan(96)
  })
})
