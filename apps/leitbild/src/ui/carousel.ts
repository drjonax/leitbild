// Rotation rules for every Host carousel (plan v2 §3, C10). Pure: the clock and
// timers are an injected port, so tests drive time without real timers.
//
// - Rotation advances every interval and wraps.
// - Holds (hover, hidden tab, carousel mostly off screen) pause with the
//   remaining time kept, and resume when the last hold is released.
// - Stopped is the user's state: keyboard focus inside, keyboard navigation,
//   Pause, reduced motion, or opening by keyboard/deep link. Only Play clears it.
// - Pointer or touch navigation restarts the full interval and keeps rotating.

export const CAROUSEL_INTERVAL_MS = 5000
export const SWIPE_MIN_PX = 60
/** A held slide never changes the instant the pointer leaves. */
export const RESUME_MIN_MS = 500
export const SWIPE_MAX_ANGLE_DEG = 30

export interface CarouselScheduler {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

export type CarouselHold = 'hover' | 'hidden' | 'offscreen'
/** How a navigation was made: pointer and touch restart the timer, keyboard stops rotation. */
export type CarouselInput = 'pointer' | 'keyboard'

export interface CarouselSnapshot {
  readonly index: number
  readonly count: number
  readonly stopped: boolean
  readonly held: boolean
  readonly rotating: boolean
  /** `aria-live` for the slide viewport: off while rotating, polite when stopped. */
  readonly live: 'off' | 'polite'
  /** Increments whenever a fresh full interval starts; key the progress animation on it. */
  readonly cycle: number
}

export interface CarouselOptions {
  readonly count: number
  readonly intervalMs?: number
  /** Reduced motion, or a carousel opened by keyboard or deep link. */
  readonly startStopped?: boolean
  readonly initialIndex?: number
  readonly scheduler?: CarouselScheduler
}

export interface CarouselController {
  snapshot(): CarouselSnapshot
  subscribe(listener: (snapshot: CarouselSnapshot) => void): () => void
  next(input: CarouselInput): void
  previous(input: CarouselInput): void
  goTo(index: number, input: CarouselInput): void
  play(): void
  stop(): void
  toggle(): void
  /** Keyboard focus entered the carousel (`:focus-visible`): stop until Play. */
  keyboardFocus(): void
  hold(reason: CarouselHold): void
  release(reason: CarouselHold): void
  destroy(): void
}

export const browserScheduler: CarouselScheduler = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  now: () => performance.now(),
}

const wrap = (index: number, count: number): number => count === 0 ? 0 : ((index % count) + count) % count

export const createCarousel = (options: CarouselOptions): CarouselController => {
  const count = Math.max(0, Math.floor(options.count))
  const interval = options.intervalMs ?? CAROUSEL_INTERVAL_MS
  const scheduler = options.scheduler ?? browserScheduler
  const holds = new Set<CarouselHold>()
  const listeners = new Set<(snapshot: CarouselSnapshot) => void>()
  let index = wrap(options.initialIndex ?? 0, count)
  let stopped = options.startStopped === true
  let cycle = 0
  let remaining = interval
  let startedAt = 0
  let timer: unknown = null
  let destroyed = false

  const rotating = (): boolean => !destroyed && !stopped && holds.size === 0 && count > 1
  const snapshot = (): CarouselSnapshot => ({
    index, count, stopped, held: holds.size > 0, rotating: rotating(), live: stopped ? 'polite' : 'off', cycle,
  })
  const emit = (): void => {
    const current = snapshot()
    for (const listener of listeners) listener(current)
  }
  const clear = (): void => {
    if (timer === null) return
    scheduler.clearTimeout(timer)
    timer = null
  }
  const schedule = (): void => {
    clear()
    if (!rotating()) return
    startedAt = scheduler.now()
    timer = scheduler.setTimeout(tick, remaining)
  }
  const restartInterval = (): void => {
    remaining = interval
    cycle += 1
  }
  function tick(): void {
    timer = null
    if (!rotating()) return
    index = wrap(index + 1, count)
    restartInterval()
    schedule()
    emit()
  }

  const goTo = (target: number, input: CarouselInput): void => {
    if (destroyed || count === 0) return
    index = wrap(target, count)
    if (input === 'keyboard') stopped = true
    restartInterval()
    schedule()
    emit()
  }
  const play = (): void => {
    if (destroyed) return
    stopped = false
    restartInterval()
    schedule()
    emit()
  }
  const stop = (): void => {
    if (destroyed) return
    clear()
    stopped = true
    restartInterval()
    emit()
  }

  schedule()
  return {
    snapshot,
    subscribe: listener => {
      listeners.add(listener)
      listener(snapshot())
      return () => { listeners.delete(listener) }
    },
    next: input => goTo(index + 1, input),
    previous: input => goTo(index - 1, input),
    goTo,
    play,
    stop,
    toggle: () => stopped ? play() : stop(),
    keyboardFocus: () => { if (!stopped) stop() },
    hold: reason => {
      if (destroyed || holds.has(reason)) return
      if (timer !== null) remaining = Math.max(RESUME_MIN_MS, remaining - (scheduler.now() - startedAt))
      clear()
      holds.add(reason)
      emit()
    },
    release: reason => {
      if (destroyed || !holds.delete(reason)) return
      schedule()
      emit()
    },
    destroy: () => {
      clear()
      destroyed = true
      listeners.clear()
    },
  }
}

export const slideLabel = (index: number, count: number, title: string): string => `${index + 1} of ${count}: ${title}`

export const pickerLabel = (index: number, count: number, title: string, noun = 'slide'): string =>
  `Show ${noun} ${index + 1} of ${count}: ${title}`

export const toggleLabel = (stopped: boolean): string => stopped ? 'Start automatic slide show' : 'Stop automatic slide show'

/** APG tabs keys on the slide pickers: arrows wrap, Home/End jump. */
export const pickerKeyTarget = (key: string, index: number, count: number): number | null => {
  if (count === 0) return null
  if (key === 'ArrowRight' || key === 'ArrowDown') return wrap(index + 1, count)
  if (key === 'ArrowLeft' || key === 'ArrowUp') return wrap(index - 1, count)
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

/** +1 = next (finger moved left), −1 = previous, 0 = not a swipe. Mouse drags never page. */
export const swipeDirection = (
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  pointerType: string,
): -1 | 0 | 1 => {
  if (pointerType === 'mouse') return 0
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (Math.abs(dx) < SWIPE_MIN_PX) return 0
  const angle = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI
  if (angle >= SWIPE_MAX_ANGLE_DEG) return 0
  return dx < 0 ? 1 : -1
}
