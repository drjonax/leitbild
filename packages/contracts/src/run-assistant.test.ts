import { describe, expect, test } from 'bun:test'
import { runAssistantOfferMessageSchema, runAssistantOpenMessageSchema } from './run-assistant.ts'

const workspaceId = '1e828b43-37fc-4437-aa70-302d7f442ceb'
const run = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }

describe('Run Assistant messages', () => {
  test('an offer says whether the World page may offer the Run\'s Assistant, and nothing else', () => {
    expect(runAssistantOfferMessageSchema.parse({ type: 'leitbild:run-assistant-offer', available: true }).available).toBe(true)
    expect(runAssistantOfferMessageSchema.parse({ type: 'leitbild:run-assistant-offer', available: false }).available).toBe(false)
    expect(runAssistantOfferMessageSchema.safeParse({ type: 'leitbild:run-assistant-offer' }).success).toBe(false)
    expect(runAssistantOfferMessageSchema.safeParse({ type: 'leitbild:run-assistant-offer', available: 'yes' }).success).toBe(false)
    expect(runAssistantOfferMessageSchema.safeParse({ type: 'leitbild:run-assistant-offer', available: true, open: true }).success).toBe(false)
  })

  test('an open names the Run as a checked Workspace Resource', () => {
    expect(runAssistantOpenMessageSchema.safeParse({ type: 'leitbild:run-assistant-open', run }).success).toBe(true)
    expect(runAssistantOpenMessageSchema.safeParse({ type: 'leitbild:run-assistant-open' }).success).toBe(false)
    expect(runAssistantOpenMessageSchema.safeParse({ type: 'leitbild:run-assistant-open', run: { ...run, workspaceId: 'not-a-workspace' } }).success).toBe(false)
    expect(runAssistantOpenMessageSchema.safeParse({ type: 'leitbild:run-assistant-open', run: { ...run, type: 'agents.room' } }).success).toBe(false)
    expect(runAssistantOpenMessageSchema.safeParse({ type: 'leitbild:run-assistant-open', run, room: 'room-1' }).success).toBe(false)
  })

  test('stay outside the embedded view window\'s message prefix', () => {
    expect(runAssistantOfferMessageSchema.shape.type.value.startsWith('leitbild:view')).toBe(false)
    expect(runAssistantOpenMessageSchema.shape.type.value.startsWith('leitbild:view')).toBe(false)
  })
})
