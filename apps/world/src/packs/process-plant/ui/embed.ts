// The Plant's UI the embedded view loads (ui/embed/pack-embed-loader.ts),
// never the World application: its panels draw OpenBridge, which only the
// embed bundle carries (D-03).

export const processPlantEmbed = {
  /** The actions on one element in a display's element pop-over: its proposal, CONTROL and RESETs. */
  elementActions: () => import('./displays/operation/ElementActions.svelte'),
}
