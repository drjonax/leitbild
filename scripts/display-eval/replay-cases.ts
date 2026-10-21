/** T09 frozen-context replay cases (plan v3.1 Appendix F; call paths, Appendix
 * C): five questions per frozen Run (frozen-runs.ts), decided before any
 * replay. Classes and the calls their path takes, the context costing none:
 * - K, vignette, subject known from the Run context: compose → answer (2);
 * - U, names unknown or cross-pack: search → compose → answer (3);
 * - N, a sentence answers: answer (1), no display.
 * `views` are the view kinds that answer the question; a composed display
 * matches when one of its views is one of them. */
export interface ReplayCase {
  readonly run: string
  readonly id: string
  readonly question: string
  readonly class: 'K' | 'U' | 'N'
  readonly views: ReadonlyArray<'trend' | 'values' | 'alerts' | 'events' | 'topology' | 'map'>
}

const c = (run: string, id: string, klass: ReplayCase['class'], views: ReplayCase['views'], question: string): ReplayCase => ({ run, id, question, class: klass, views })

export const REPLAY_CASES: ReadonlyArray<ReplayCase> = [
  c('halden-dispatch', 'units', 'K', ['values', 'map'], 'Show me the ambulance units and what each is doing.'),
  c('halden-dispatch', 'helicopter', 'U', ['values', 'map'], 'Where is the Østfold medical helicopter and what is it doing?'),
  c('halden-dispatch', 'count', 'N', [], 'How many incidents are open right now?'),
  c('halden-dispatch', 'drones', 'U', ['map', 'values'], 'Show me where the two drones are and what they are observing.'),
  c('halden-dispatch', 'events', 'K', ['events'], 'What has happened in the last half hour?'),

  c('halden-normal-operation', 'unit2-trend', 'K', ['trend'], 'Show me Unit 2\'s reactor power and pressurizer pressure over the last few minutes.'),
  c('halden-normal-operation', 'grid-freq', 'U', ['trend', 'values'], 'Show grid frequency next to the four units\' electrical output.'),
  c('halden-normal-operation', 'state', 'N', [], 'Is Unit 3 at full power?'),
  c('halden-normal-operation', 'grid-alarms', 'K', ['alerts'], 'Which grid alarms are active?'),
  c('halden-normal-operation', 'switchyard', 'U', ['topology', 'values'], 'Show me how the Halden switchyard connects to Hasle and Tegneby.'),

  c('halden-offsite-power-restoration', 'unit1-cooling', 'K', ['trend', 'values'], 'Is Unit 1 cooling down properly after the trip? Show me.'),
  c('halden-offsite-power-restoration', 'diesels', 'U', ['values'], 'Are the emergency diesels running on all four units? Show me.'),
  c('halden-offsite-power-restoration', 'loop', 'N', [], 'Did all four units lose offsite power?'),
  c('halden-offsite-power-restoration', 'grid-alarms', 'K', ['alerts'], 'What is the grid alarming about?'),
  c('halden-offsite-power-restoration', 'shedding', 'U', ['values', 'trend'], 'How much load was shed and what is the island frequency? Show me.'),

  c('halden-power-complex', 'unit4-sg', 'U', ['values', 'trend'], 'Compare the four steam generator levels on Unit 4.'),
  c('halden-power-complex', 'output', 'U', ['values', 'trend'], 'Show the electrical output of all four units side by side.'),
  c('halden-power-complex', 'stable', 'N', [], 'Is anything abnormal on Unit 1?'),
  c('halden-power-complex', 'weather', 'U', ['values'], 'Show me the weather at the power complex probe.'),
  c('halden-power-complex', 'unit2-lead', 'K', ['values', 'trend'], 'Give me a display of Unit 2\'s key values.'),

  c('halden-weather-response', 'front', 'K', ['values', 'map'], 'Show me the weather at the Halden probe.'),
  c('halden-weather-response', 'ambulance', 'U', ['values', 'map'], 'Where is the weather-response ambulance and how far is it from the incident?'),
  c('halden-weather-response', 'hazard', 'N', [], 'Is the weather at Halden hazardous right now?'),
  c('halden-weather-response', 'compare', 'U', ['values'], 'Compare the Halden probe with the northern probe.'),
  c('halden-weather-response', 'visibility', 'K', ['trend', 'values'], 'Show me how visibility at Halden has changed.'),

  c('nordic-frequency-event', 'frequency', 'K', ['trend'], 'Show me the frequency since the Kvilldal trip.'),
  c('nordic-frequency-event', 'reserves', 'U', ['values', 'trend'], 'Which reserves responded to the trip? Show me.'),
  c('nordic-frequency-event', 'nadir', 'N', [], 'Did the frequency go below 49.5 Hz?'),
  c('nordic-frequency-event', 'alarms', 'K', ['alerts'], 'What grid alarms are active?'),
  c('nordic-frequency-event', 'kvilldal', 'U', ['values'], 'Show me the Kvilldal units\' state and output.'),

  c('nordland-corridor-security', 'split', 'K', ['alerts', 'events'], 'What tripped after Svartisen – Rana went out?'),
  c('nordland-corridor-security', 'topology', 'U', ['topology'], 'Show me the Helgeland 132 kV network around Sjona.'),
  c('nordland-corridor-security', 'supply', 'N', [], 'Is any area without supply?'),
  c('nordland-corridor-security', 'loading', 'U', ['values'], 'Show me the loading on Smibelg – Sjona and its neighbours.'),
  c('nordland-corridor-security', 'events', 'K', ['events'], 'Give me the sequence of events since the trip.'),

  c('norway-situation-monitor', 'warnings', 'U', ['values', 'map'], 'Show me the active weather warnings near Halden.'),
  c('norway-situation-monitor', 'roads', 'U', ['values', 'map'], 'Are any roads around Oslo affected? Show me.'),
  c('norway-situation-monitor', 'count', 'N', [], 'How many warnings are active?'),
  c('norway-situation-monitor', 'overview', 'K', ['values'], 'Give me an overview display of what the feeds report.'),
  c('norway-situation-monitor', 'map', 'K', ['map'], 'Show the reports on a map.'),

  c('rogaland-black-start', 'blackout', 'K', ['alerts', 'values'], 'What is out after the transformers tripped?'),
  c('rogaland-black-start', 'island', 'U', ['values', 'trend'], 'Show me the frequency and voltage of the Sør-Rogaland island.'),
  c('rogaland-black-start', 'dead', 'N', [], 'Is Sør-Rogaland without power?'),
  c('rogaland-black-start', 'restore', 'U', ['topology', 'values'], 'Show me what we could close to restore supply to Sør-Rogaland.'),
  c('rogaland-black-start', 'events', 'K', ['events'], 'What happened in the last minute?'),

  c('supply-run', 'tasks', 'K', ['values'], 'Show me the open supply requests and who serves them.'),
  c('supply-run', 'trucks', 'K', ['values', 'map'], 'Show me where the trucks are.'),
  c('supply-run', 'open', 'N', [], 'How many requests are still open?'),
  c('supply-run', 'clinic', 'U', ['values', 'map'], 'Which truck is nearest to the clinic request?'),
  c('supply-run', 'events', 'K', ['events'], 'What has happened in the last ten minutes?'),

  c('integrated-all-packs', 'unit3', 'K', ['values', 'trend'], 'Show me Unit 3 after its loss of offsite power.'),
  c('integrated-all-packs', 'cross', 'U', ['values', 'trend'], 'Show the Hasle 420/300 kV transformer loading next to the four units\' output.'),
  c('integrated-all-packs', 'release', 'N', [], 'Is anyone assigned to the industrial release?'),
  c('integrated-all-packs', 'alarms', 'K', ['alerts'], 'Which alarms are active across the Run?'),
  c('integrated-all-packs', 'release-map', 'U', ['map', 'values'], 'Show me the industrial release with the nearest ambulances and the drone.'),
]
