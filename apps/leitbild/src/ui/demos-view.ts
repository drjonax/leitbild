// The Demos modal's two views: its demos carousel and the More scenarios list
// (a scenario a Module lists beside its demos). The switch is a header button,
// not a disclosure; the carousel stays mounted while the list shows.
//
// - "More scenarios" stops the carousel for good (Play brings it back) and
//   replaces `?demos=<key>` with `?scenarios`.
// - "‹ Demos" shows the slide the carousel kept, stopped, and replaces
//   `?scenarios` with `?demos=<that demo>`.
// - Neither switches while a launch runs: its progress would be hidden.
// - Once the list has shown, the modal is anchored where its demos view is
//   centred, so the header never moves and each view keeps its own height.

import { demoKey, type ModalRoute } from './modal-url.ts'

export type DemosView = 'demos' | 'scenarios'

export const MORE_SCENARIOS_TITLE = 'More scenarios'
export const DEMOS_TITLE = 'Try a demo'

/** The carousel as the switch sees it (Carousel.svelte's `stop()` and `current()`). */
export interface ParkedCarousel {
  stop(): void
  current(): number
}

/** "More scenarios": stops the carousel and returns the route to replace, or null while a launch runs. */
export const showScenarios = (context: { readonly busy: boolean; readonly carousel: ParkedCarousel | null }): ModalRoute | null => {
  if (context.busy) return null
  context.carousel?.stop()
  return { kind: 'scenarios' }
}

/** "‹ Demos": the route for the slide the carousel kept, or null while a launch runs. */
export const showDemos = (context: {
  readonly busy: boolean
  readonly carousel: ParkedCarousel | null
  readonly demos: ReadonlyArray<{ readonly definition: { readonly moduleId: string; readonly id: string } }>
}): ModalRoute | null => {
  if (context.busy) return null
  const shown = context.carousel === null ? undefined : context.demos[context.carousel.current()]
  return { kind: 'demos', demo: shown === undefined ? null : demoKey(shown.definition) }
}

/**
 * The modal's top edge when anchored: where the demos view sits when centred
 * (`(viewport − its height) / 2`), and never closer to the viewport edge than
 * the modal's own 16 px margin. `chrome` is the modal's border and header.
 */
export const demosModalTop = (size: { readonly viewportHeight: number; readonly chrome: number; readonly demosBody: number }, margin = 16): number =>
  Math.max(margin, (size.viewportHeight - size.chrome - size.demosBody) / 2)
