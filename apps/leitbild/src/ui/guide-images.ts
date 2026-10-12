// Vite-processed (hashed) URLs for the guide's images. The files are interim
// prototype captures under their final names (plan v2 §9); a recapture replaces
// the file and keeps the name. Imported only by GuideModal.svelte, so the images
// load with the guide's chunk and never with the landing page.

import type { GuideDiagramId, GuideShotId } from './guide-content.ts'
import guideWhat720 from './assets/guide/guide-what-720.webp'
import guideWhat1200 from './assets/guide/guide-what-1200.webp'
import guideMaps720 from './assets/guide/guide-maps-720.webp'
import guideMaps1200 from './assets/guide/guide-maps-1200.webp'
import guideGrid720 from './assets/guide/guide-grid-720.webp'
import guideGrid1200 from './assets/guide/guide-grid-1200.webp'
import guideEinsatz720 from './assets/guide/guide-einsatz-720.webp'
import guideEinsatz1200 from './assets/guide/guide-einsatz-1200.webp'
import guideTime720 from './assets/guide/guide-time-720.webp'
import guideTime1200 from './assets/guide/guide-time-1200.webp'
import guidePwr720 from './assets/guide/guide-pwr-720.webp'
import guidePwr1200 from './assets/guide/guide-pwr-1200.webp'
import guideGraphs720 from './assets/guide/guide-graphs-720.webp'
import guideGraphs1200 from './assets/guide/guide-graphs-1200.webp'
import guideDisplays720 from './assets/guide/guide-displays-720.webp'
import guideDisplays1200 from './assets/guide/guide-displays-1200.webp'
import guideAssistant720 from './assets/guide/guide-assistant-720.webp'
import guideAssistant1200 from './assets/guide/guide-assistant-1200.webp'
import guideAgents720 from './assets/guide/guide-agents-720.webp'
import guideAgents1200 from './assets/guide/guide-agents-1200.webp'
import guideProposals720 from './assets/guide/guide-proposals-720.webp'
import guideProposals1200 from './assets/guide/guide-proposals-1200.webp'
import guideInspect720 from './assets/guide/guide-inspect-720.webp'
import guideInspect1200 from './assets/guide/guide-inspect-1200.webp'
import guidePacks720 from './assets/guide/guide-packs-720.webp'
import guidePacks1200 from './assets/guide/guide-packs-1200.webp'
import guideWiki720 from './assets/guide/guide-wiki-720.webp'
import guideWiki1200 from './assets/guide/guide-wiki-1200.webp'
import discovery from './assets/guide/discovery.svg'
import workspaces from './assets/guide/workspaces.svg'

export interface GuideShotSources {
  /** 720 px wide, the `src`. */
  readonly small: string
  /** 1200 px wide. */
  readonly large: string
}

export const GUIDE_SHOTS: Readonly<Record<GuideShotId, GuideShotSources>> = {
  'guide-what': { small: guideWhat720, large: guideWhat1200 },
  'guide-maps': { small: guideMaps720, large: guideMaps1200 },
  'guide-grid': { small: guideGrid720, large: guideGrid1200 },
  'guide-einsatz': { small: guideEinsatz720, large: guideEinsatz1200 },
  'guide-time': { small: guideTime720, large: guideTime1200 },
  'guide-pwr': { small: guidePwr720, large: guidePwr1200 },
  'guide-graphs': { small: guideGraphs720, large: guideGraphs1200 },
  'guide-displays': { small: guideDisplays720, large: guideDisplays1200 },
  'guide-assistant': { small: guideAssistant720, large: guideAssistant1200 },
  'guide-agents': { small: guideAgents720, large: guideAgents1200 },
  'guide-proposals': { small: guideProposals720, large: guideProposals1200 },
  'guide-inspect': { small: guideInspect720, large: guideInspect1200 },
  'guide-packs': { small: guidePacks720, large: guidePacks1200 },
  'guide-wiki': { small: guideWiki720, large: guideWiki1200 },
}

export const GUIDE_DIAGRAMS: Readonly<Record<GuideDiagramId, string>> = { workspaces, discovery }

/** `srcset` for a shot: the browser picks 720 or 1200 px by the displayed width and density. */
export const guideShotSrcset = (shot: GuideShotId): string => `${GUIDE_SHOTS[shot].small} 720w, ${GUIDE_SHOTS[shot].large} 1200w`
