// Bun drops a request idle for 10 s. A Capability may answer later than that
// (agents.people.sync waits up to 20 s for a change); the Host's gateway gives
// a Module 30 s, so an invocation may stay open a little longer than that.
export const CAPABILITY_INVOKE_IDLE_SECONDS = 35

const capabilityInvokePath = /^\/internal\/workspaces\/[^/]+\/capabilities\/[^/]+\/invoke$/

/** True for a Capability invocation, whose idle timeout is CAPABILITY_INVOKE_IDLE_SECONDS. */
export const isCapabilityInvokeRequest = (request: Request, url: URL): boolean =>
  request.method === 'POST' && capabilityInvokePath.test(url.pathname)
