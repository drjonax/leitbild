/** Alert coverage on a Run (plan v5 §5.2, risk 3; for the R2 and R3 alerts organisation): of the alerts each unit
 * shows, how many resolve one of the annunciator systems the plant declares (the projection drops the system
 * today, projection.ts), how many count as expected after a first-out group's actuation (the Pack's own rule,
 * ic/alarm-philosophy.ts expectedAfterGroup), and how many name no observable.
 *
 *   bun scripts/display-eval/coverage.ts --origin=http://127.0.0.1:<port> --workspace=<id> --run=<Run id> [--out=<file.json>]
 *
 * Reads the Run's plant objects (their alerts, as displays read them) and each plant's I&C status (its alarm and
 * trip lifecycles, which carry the annunciator) through the published routes and Capabilities, and the reference
 * PWR's compiled I&C (its declared systems and first-out groups), which every Halden unit runs. Reads only. */
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../../apps/world/src/packs/process-plant/index.ts'
import { expectedAfterGroup } from '../../apps/world/src/packs/process-plant/ic/alarm-philosophy.ts'
import { loopbackOrigin, options } from './browser.ts'
import { createStackApi } from './stack-api.ts'

const argv = options(Bun.argv.slice(2))
const origin = loopbackOrigin(argv.get('origin'))
const workspaceId = argv.get('workspace'), runId = argv.get('run')
if (workspaceId === undefined || runId === undefined) throw new Error('usage: coverage.ts --origin=… --workspace=<id> --run=<Run id> [--out=<file.json>]')
const api = createStackApi(origin, workspaceId)
await api.load(runId)
const at = (await api.presence(runId)).execution.currentSimulationTime
const plants = (await api.objects(runId)).filter(object => object.packId === 'process-plant')

const share = (part: number, whole: number) => whole === 0 ? null : Math.round((part / whole) * 1000) / 10
const units: Array<Record<string, unknown>> = []
for (const plant of plants) {
  const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: plant.id, loopCount: 4 }))
  const automation = compiled.automation as any
  const systems = new Set<string>((automation.annunciatorSystems ?? []).map((system: { id: string }) => system.id))
  const status = (await api.onRun(runId, 'world.process-plant.ic.status', { plantId: plant.id })).result
  const ic = status?.ic ?? status
  const lifecycles: ReadonlyArray<any> = [...(ic?.alarms ?? []), ...(ic?.trips ?? [])]
  if (lifecycles.length === 0) throw new Error(`no I&C lifecycles for ${plant.id}: ${JSON.stringify(status).slice(0, 300)}`)
  const byId = new Map(lifecycles.map(lifecycle => [String(lifecycle.id), lifecycle]))
  const rows = (plant.alerts as ReadonlyArray<any>).map(alert => {
    const lifecycle = byId.get(String(alert.id))
    const system = lifecycle?.annunciator?.system as string | undefined
    const expected = lifecycle === undefined ? null : expectedAfterGroup(compiled, lifecycle, lifecycles)
    return {
      id: String(alert.id), message: String(alert.message), kind: String(alert.kind), priority: alert.priority ?? null,
      state: alert.returned === true ? 'returned' : alert.acknowledged === true ? 'active-ack' : 'active-unack',
      source: lifecycle !== undefined ? 'i&c' : String(alert.id).startsWith('csf:') ? 'safety-function' : 'other',
      system: system ?? null, systemResolves: system !== undefined && systems.has(system),
      firstOut: lifecycle?.firstOut === true ? lifecycle.annunciator?.firstOutGroup ?? true : false,
      expectedAfter: expected === null ? null : expected.id,
      declaresExpectedAfter: lifecycle?.annunciator?.expectedAfter?.firstOutGroup ?? null,
      observable: alert.observable ?? null,
    }
  })
  const ic_ = rows.filter(row => row.source === 'i&c')
  units.push({
    plant: plant.id, label: plant.label ?? plant.name ?? plant.id,
    alerts: rows.length, active: rows.filter(row => row.state !== 'returned').length,
    bySource: Object.fromEntries(['i&c', 'safety-function', 'other'].map(source => [source, rows.filter(row => row.source === source).length])),
    systemResolves: { count: rows.filter(row => row.systemResolves).length, share: share(rows.filter(row => row.systemResolves).length, rows.length), shareOfIc: share(ic_.filter(row => row.systemResolves).length, ic_.length) },
    expected: { count: rows.filter(row => row.expectedAfter !== null).length, share: share(rows.filter(row => row.expectedAfter !== null).length, rows.length), declaring: rows.filter(row => row.declaresExpectedAfter !== null).length },
    firstOut: rows.filter(row => row.firstOut !== false).length,
    noObservable: { count: rows.filter(row => row.observable === null).length, share: share(rows.filter(row => row.observable === null).length, rows.length) },
    declaredSystems: [...systems],
    rows,
  })
}
const all = units.flatMap(unit => unit.rows as ReadonlyArray<any>)
const result = {
  origin, runId, at,
  total: {
    alerts: all.length,
    systemResolves: { count: all.filter(row => row.systemResolves).length, share: share(all.filter(row => row.systemResolves).length, all.length) },
    expected: { count: all.filter(row => row.expectedAfter !== null).length, share: share(all.filter(row => row.expectedAfter !== null).length, all.length) },
    noObservable: { count: all.filter(row => row.observable === null).length, share: share(all.filter(row => row.observable === null).length, all.length) },
  },
  units,
}
const out = argv.get('out')
if (out !== undefined) await Bun.write(out, JSON.stringify(result, null, 2))
console.log(JSON.stringify({ ...result, units: units.map(({ rows: _rows, ...unit }) => unit) }, null, 1))
