// POST /rooms/:room/messages/:message/display-request — a reader asks the
// author of an answer to show it as a live display (see
// core/display-request.ts). A refusal answers with its rule's code and status;
// any other error propagates like every other route's.
import { z } from 'zod'
import type { RouteEntry } from './types.ts'
import { errorResponse, json } from './helpers.ts'
import {
  DISPLAY_REQUEST_REFUSAL_STATUS,
  isDisplayRequestRefusal,
  type DisplayRequestAccepted,
  type DisplayRequestRefused,
} from '../../core/display-request.ts'

const bodySchema = z.object({ requesterId: z.string().min(1) }).strict()

export const displayRequestRoutes: RouteEntry[] = [
  {
    method: 'POST',
    pattern: /^\/rooms\/([^/]+)\/messages\/([^/]+)\/display-request$/,
    handler: async (req, match, { system }) => {
      let roomId: string
      let messageId: string
      try {
        roomId = decodeURIComponent(match[1]!)
        messageId = decodeURIComponent(match[2]!)
      } catch (error) {
        if (error instanceof URIError) return errorResponse('Malformed Room or message id in the path', 400)
        throw error
      }
      let raw: unknown
      try {
        raw = await req.json()
      } catch {
        return errorResponse('Request body must be JSON', 400)
      }
      const body = bodySchema.safeParse(raw)
      if (!body.success) return errorResponse(z.prettifyError(body.error), 400)
      try {
        const { queued } = system.requestDisplay(roomId, messageId, body.data.requesterId)
        return json({ queued } satisfies DisplayRequestAccepted, 202)
      } catch (error) {
        if (!isDisplayRequestRefusal(error)) throw error
        return json({ error: error.message, code: error.code } satisfies DisplayRequestRefused, DISPLAY_REQUEST_REFUSAL_STATUS[error.code])
      }
    },
  },
]
