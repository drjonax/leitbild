// The People Capabilities are for the humans in a Workspace, through the Host
// UI. Every id starts with this prefix, so the Agents Module can keep them out
// of its own AI Agents' capability discovery.
export const PEOPLE_CAPABILITY_PREFIX = 'agents.people.'

export const isPeopleCapabilityId = (capabilityId: string): boolean => capabilityId.startsWith(PEOPLE_CAPABILITY_PREFIX)
