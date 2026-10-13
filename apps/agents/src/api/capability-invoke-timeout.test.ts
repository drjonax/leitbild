import { describe, expect, test } from 'bun:test'
import { CAPABILITY_INVOKE_IDLE_SECONDS, isCapabilityInvokeRequest } from './capability-invoke-timeout.ts'

const check = (method: string, path: string): boolean => {
  const url = new URL(path, 'http://agents.test')
  return isCapabilityInvokeRequest(new Request(url.href, { method }), url)
}

describe('Capability invocation idle timeout', () => {
  test('applies to Capability invocations only', () => {
    const workspace = crypto.randomUUID()
    expect(check('POST', `/internal/workspaces/${workspace}/capabilities/agents.people.sync/invoke`)).toBe(true)
    expect(check('GET', `/internal/workspaces/${workspace}/capabilities/agents.people.sync/invoke`)).toBe(false)
    expect(check('POST', `/internal/workspaces/${workspace}/capabilities`)).toBe(false)
    expect(check('POST', `/api/workspaces/${workspace}/capabilities/agents.people.sync/invoke`)).toBe(false)
    expect(check('POST', `/internal/workspaces/${workspace}/capabilities/agents.people.sync/invoke/extra`)).toBe(false)
  })

  test('outlasts the longest sync hold and the Host gateway timeout', () => {
    expect(CAPABILITY_INVOKE_IDLE_SECONDS * 1_000).toBeGreaterThan(30_000)
  })
})
