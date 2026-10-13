// Proposal resumes. An AI Agent working a procedure ends its turn on a
// proposal, which a person approves in World's display window. Once World
// reads the proposal approved, the Agent is asked for one ordinary turn in
// the same Room that continues the procedure (agents/proposal-resumes.ts).
// The reply is posted as a new message whose cause names the approval and
// whose inReplyTo starts with the answer that proposed it.
//
// Browser-safe: shared by the server and the chat UI.

/** MessageCause kind stamped on the reply of a turn an approved proposal resumed. */
export const PROPOSAL_RESUME_CAUSE = 'proposal-approved'

/** The Skill whose turns work a procedure Run; a proposal of such a turn resumes it. */
export const PROCEDURE_RUNNER_SKILL = 'procedure-runner'

/** Caption of a resumed turn's reply; the cause's name says who approved what. */
export const proposalResumeCaption = (causeName: string): string => `Continued after ${causeName}`
