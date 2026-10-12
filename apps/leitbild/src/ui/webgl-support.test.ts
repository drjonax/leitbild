import { describe, expect, test } from 'bun:test'
import { supportsWebgl2, WEBGL_MISSING_TEXT } from './webgl-support.ts'

describe('WebGL 2 check', () => {
  test('is true when a WebGL 2 context can be created, and releases it', () => {
    let released = false
    const context = { getExtension: (name: string) => name === 'WEBGL_lose_context' ? { loseContext: () => { released = true } } : null }
    expect(supportsWebgl2({ createCanvas: () => ({ getContext: () => context }) })).toBe(true)
    expect(released).toBe(true)
  })

  test('is false without a context, without a canvas, or when the browser throws', () => {
    expect(supportsWebgl2({ createCanvas: () => ({ getContext: () => null }) })).toBe(false)
    expect(supportsWebgl2({ createCanvas: () => null })).toBe(false)
    expect(supportsWebgl2({ createCanvas: () => { throw new Error('blocked') } })).toBe(false)
  })

  test('explains what to do', () => {
    expect(WEBGL_MISSING_TEXT).toBe('Your browser cannot draw the map (WebGL 2 is off). Try a current desktop browser or an iPad.')
  })
})
