// POST /rooms/:room/messages/:message/display-request — a reader asks the
// author of an answer to show it as a live display (see
// core/display-request.ts). A refusal answers with its rule's code and status,
// and a closing Workspace with 409 workspace_closing as the module API answers
// it; any other error propagates like every other route's.
// GET /rooms/:room/agents/:agent/display-request — whether that Agent's answers
// in the Room offer the request at all.
import { z } from 'zod'
import type { RouteEntry } from './types.ts'
import { errorResponse, json } from './helpers.ts'
import {
  DISPLAY_REQUEST_REFUSAL_STATUS,
  isDisplayRequestRefusal,
  type DisplayRequestAccepted,
  type DisplayRequestOffer,
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
        const { queued } = await system.requestDisplay(roomId, messageId, body.data.requesterId)
        return json({ queued } satisfies DisplayRequestAccepted, 202)
      } catch (error) {
        // A request admitted before removal or shutdown closed the author.
        if (error instanceof Error && 'code' in error && error.code === 'workspace_closing') return json({ error: error.message, code: 'workspace_closing' }, 409)
        if (!isDisplayRequestRefusal(error)) throw error
        return json({ error: error.message, code: error.code } satisfies DisplayRequestRefused, DISPLAY_REQUEST_REFUSAL_STATUS[error.code])
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/agents\/([^/]+)\/display-request$/,
    handler: async (_req, match, { system }) => {
      let roomId: string
      let agentId: string
      try {
        roomId = decodeURIComponent(match[1]!)
        agentId = decodeURIComponent(match[2]!)
      } catch (error) {
        if (error instanceof URIError) return errorResponse('Malformed Room or Agent id in the path', 400)
        throw error
      }
      return json({ offered: await system.displayRequestOffered(roomId, agentId) } satisfies DisplayRequestOffer)
    },
  },
]
