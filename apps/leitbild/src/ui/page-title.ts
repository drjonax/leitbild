// Browser tab titles for the Workspace shell (plan v2 §13 H3): the brand is
// "Leitbild.ai" in marks and titles; prose keeps "Leitbild".

export const BRAND_TITLE = 'Leitbild.ai'

/** "<subject> · Leitbild.ai", or the brand alone while nothing is known yet. */
export const pageTitle = (subject?: string | null): string => {
  const text = subject?.trim()
  return text ? `${text} · ${BRAND_TITLE}` : BRAND_TITLE
}

export interface WorkspaceTitleParts {
  /** The Workspace's header label (never a raw id), or null while it loads. */
  readonly workspace: string | null
  /** The open Run's title, if a Run is shown. */
  readonly run?: string | null
  /** The open conversation's title, if one is shown without a Run. */
  readonly room?: string | null
}

/** The open Run, else the open conversation, else the Workspace names the tab. */
export const workspacePageTitle = (parts: WorkspaceTitleParts): string =>
  pageTitle(parts.run || parts.room || parts.workspace)
