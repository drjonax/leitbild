import { describe, expect, test } from 'bun:test'
import { chevronSegment, pipeSegments, pipeValue, stubEndSegment } from '../src/ui/embed/vignette/pipe-segments.ts'

describe('pipes as OpenBridge connector-diagram segments', () => {
  test('a bend is a radius-8 corner between straights', () => {
    const segments = pipeSegments('p', [[0, 0], [0, 48], [48, 48]], [], 'open-flow', 'medium')
    expect(segments.map(segment => segment.kind)).toEqual(['straight', 'corner', 'straight'])
    expect(segments[0]).toMatchObject({ x1: 0, y1: 0, x2: 0, y2: 40 })
    expect(segments[1]).toMatchObject({ from: { x: 0, y: 40 }, to: { x: 8, y: 48 }, direction: 'BottomLeft' })
    expect(segments[2]).toMatchObject({ x1: 8, y1: 48, x2: 48, y2: 48 })
  })

  test('a crossing leaves a clean 10 px gap in the pipe that passes under', () => {
    const segments = pipeSegments('p', [[24, 96], [24, 0]], [[24, 48]], 'open-flow', 'medium')
    expect(segments).toEqual([
      expect.objectContaining({ kind: 'straight', y1: 96, y2: 53 }),
      expect.objectContaining({ kind: 'straight', y1: 43, y2: 0 }),
    ])
  })

  test('a chevron sits mid-run in flow direction, clear of gaps, and flips for reverse flow', () => {
    expect(chevronSegment('p', [[0, 0], [96, 0]], [], 'open-flow', 'medium', false)).toMatchObject({ kind: 'direction', x: 48, y: 0, direction: 'right' })
    expect(chevronSegment('p', [[0, 0], [96, 0]], [], 'open-flow', 'medium', true)).toMatchObject({ direction: 'left' })
    expect(chevronSegment('p', [[0, 0], [0, 16]], [], 'open-flow', 'medium', false)).toBeNull()
  })

  test('pipe values: hollow for no flow, dashed for unknown, never closed', () => {
    expect([pipeValue('forward'), pipeValue('flowing'), pipeValue('none'), pipeValue('unknown'), pipeValue('dead')]).toEqual(['open-flow', 'open-flow', 'empty', 'closed-dash', 'empty'])
  })

  test('where the drawing stops: an arrow when flow leaves there, a cap otherwise', () => {
    expect(stubEndSegment('p', [[0, 0], [0, -48]], 'out', 'open-flow', 'medium', true)).toMatchObject({ kind: 'arrow', x: 0, y: -48, direction: 'top', flow: 'going-to' })
    expect(stubEndSegment('p', [[96, 0], [0, 0]], 'in', 'empty', 'medium', false)).toMatchObject({ kind: 'endpoint', x: 96, y: 0, direction: 'right' })
  })
})
