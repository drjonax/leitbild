import type { IsoTimestamp, ObjectId, OperationalObject } from '../../../core/model/index.ts'
import type { PackMapTarget, PackTargetPreview } from '../../../core/packs/protocol.ts'
import type { PanelKey } from '../../../ui/keys/panel-key-router.ts'
import type { EinsatzCommandId } from '../capabilities.ts'
import type { EinsatzConfig } from '../config-schema.ts'
import type { SideLabel } from '../board/contacts.ts'
import { createBoardController } from '../board/controller.ts'
import type { BoardEffect, BoardEventBody, BoardView, CallResult } from '../board/types.ts'
import type { PictureViewer } from '../picture.ts'
import type { DeclaredRole } from '../board/rules.ts'

/**
 * One Board controller wired to the World, as the Board panel runs it. The
 * panel hands it the screen's inputs; it stamps each event with wall time,
 * performs the effects the controller returns, in order, and feeds every
 * result and answer back. A session belongs to one perspective: once
 * disposed it drops every late result, answer and event, so nothing meant
 * for an earlier role set reaches the next one.
 *
 * - A command's refusal arrives as a result; a transport failure becomes a
 *   refusal with its message.
 * - A recommendation answer is fed back raw: the controller validates it. A
 *   failed query is fed back as such.
 * - A fault in the Board's own logic is reported to `failed`, never mistaken
 *   for a refusal.
 * - Ticks: the panel's timer ticks a few times a second, so guards and
 *   flashes expire. The Run publishes objects only when something changes,
 *   so while it runs with nothing moving a tick also feeds the objects again
 *   once the Run clock is a second past the last snapshot: ages, phase
 *   timers and re-ranks follow the clock. A paused clock stands still and
 *   feeds nothing.
 */

/** How far the Run clock runs past the last snapshot before a tick feeds the objects again. */
export const refeedAfterMs = 1_000

export interface BoardPorts {
  /** Invokes an Einsatz command through the run-scoped World invoke as the screen's role set. A refusal resolves; a transport failure rejects. */
  readonly invoke: (capabilityId: EinsatzCommandId, input: unknown) => Promise<CallResult>
  /** Queries `world.einsatz.recommend` for a task as the screen's role set and resolves with the answer as received. */
  readonly recommend: (taskId: string) => Promise<unknown>
  /** Mirrors the Board's selection on the map. */
  readonly select: (objectId: ObjectId | null) => void
  readonly sound: (tone: 'new-work') => void
  readonly wallMs: () => number
  /** The view changed. */
  readonly changed: () => void
  readonly failed: (error: unknown) => void
}

export interface BoardSession {
  /** Hands the Board one event, stamped with wall time, and performs what it asks for. */
  readonly dispatch: (body: BoardEventBody) => void
  /** The screen's objects changed: a snapshot at the Run time read now, or nothing before the Run clock is known. */
  readonly observe: (objects: ReadonlyArray<OperationalObject>, currentTime: IsoTimestamp | undefined) => void
  /** The panel's timer: a tick, and a snapshot of the screen's objects when the Run clock ran on since the last one. */
  readonly tick: (objects: ReadonlyArray<OperationalObject>, currentTime: IsoTimestamp | undefined) => void
  readonly view: () => BoardView
  /** What the panel lends the World surface: its keymap, its map targets and their hover previews. */
  readonly onKey: (key: PanelKey) => boolean
  readonly onMapTarget: (controllerId: ObjectId, target: PackMapTarget) => void
  readonly previewMapTarget: (controllerId: ObjectId, target: PackMapTarget) => PackTargetPreview | null
  readonly dispose: () => void
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

export const createBoardSession = (options: {
  readonly config: EinsatzConfig
  readonly viewer: PictureViewer
  /** The roles the Run declares, with their labels; none in a Run without roles. */
  readonly declaredRoles: ReadonlyArray<DeclaredRole>
  /** The sides the Run declares; none in a Run that declares none. */
  readonly sides: ReadonlyArray<SideLabel>
  readonly ports: BoardPorts
}): BoardSession => {
  const { ports } = options
  const controller = createBoardController({ config: options.config, viewer: options.viewer, declaredRoles: options.declaredRoles, sides: options.sides })
  let disposed = false
  /** The Run time of the last snapshot fed, in ms. */
  let fedMs: number | null = null

  const dispatch = (body: BoardEventBody): void => {
    if (disposed) return
    try {
      const effects = controller.dispatch({ ...body, wallMs: ports.wallMs() })
      ports.changed()
      for (const effect of effects) perform(effect)
    } catch (error) {
      ports.failed(error)
    }
  }

  const call = async (effect: Extract<BoardEffect, { kind: 'invoke' }>): Promise<void> => {
    let result: CallResult
    try {
      result = await ports.invoke(effect.capabilityId, effect.input)
    } catch (error) {
      result = { ok: false, reason: messageOf(error) }
    }
    dispatch({ kind: 'result', callId: effect.callId, result })
  }

  const ask = async (effect: Extract<BoardEffect, { kind: 'recommend' }>): Promise<void> => {
    let answer: unknown
    try {
      answer = await ports.recommend(effect.taskId)
    } catch (error) {
      dispatch({ kind: 'recommendation-failed', taskId: effect.taskId, key: effect.key, reason: messageOf(error) })
      return
    }
    dispatch({ kind: 'recommendation', taskId: effect.taskId, key: effect.key, answer })
  }

  const perform = (effect: BoardEffect): void => {
    switch (effect.kind) {
      case 'invoke': void call(effect); return
      case 'recommend': void ask(effect); return
      case 'select': ports.select(effect.objectId); return
      case 'sound': ports.sound(effect.tone); return
    }
  }

  return {
    dispatch,
    observe: (objects, currentTime) => {
      if (currentTime === undefined) return
      fedMs = Date.parse(currentTime)
      dispatch({ kind: 'snapshot', objects, currentTime })
    },
    tick: (objects, currentTime) => {
      dispatch({ kind: 'tick' })
      if (disposed || currentTime === undefined || fedMs === null || Date.parse(currentTime) - fedMs < refeedAfterMs) return
      fedMs = Date.parse(currentTime)
      dispatch({ kind: 'snapshot', objects, currentTime })
    },
    view: () => controller.view(),
    onKey: key => {
      if (disposed || !controller.handlesKey(key)) return false
      dispatch({ kind: 'key', ...key })
      return true
    },
    onMapTarget: (controllerId, target) => dispatch({ kind: 'map-target', controllerId, target }),
    previewMapTarget: (controllerId, target) => disposed ? null : controller.preview(controllerId, target),
    dispose: () => { disposed = true },
  }
}
