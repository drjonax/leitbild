/** Fork-only (drjonax/leitbild, multiunit plan T7.3): the performance gate for displays over many units, against the
 * §3.3 budget. One fleet display and one 4-quantity comparison, each a view of the whole set, sampled at 1 Hz as two
 * open frames sample, must add less than 1 percentage point of one core to World and keep the median sample under
 * 10 ms. Tail latency is World's tick, recorded and not budgeted.
 *
 *   bun scripts/fork/multiunit-perf.ts --origin=http://127.0.0.1:<port> --world-pid=<pid> --units=<n> --out=<file.json>
 *       [--warmup-seconds=60] [--block-seconds=120] [--blocks=3] [--soak-minutes=0]
 *
 * It saves an N-unit Halden Scenario (the 12-unit fixture's unit repeated, operations recording on, as the featured
 * Scenario records) in a Workspace of its own, plays its Run at realtime with one viewer socket open, and alternates
 * blocks without and with the two displays sampling: off, on, off, …, off. Added CPU is the mean of the on blocks
 * less the mean of the off blocks, from World's /proc utime + stime. A soak then keeps the displays sampling and
 * records World's RSS every 30 s, to size MemoryMax. Loopback stacks only; no model is called. */
import { readlink } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { assertLocalOrigin } from './openai-spend.ts'

const option = (name: string): string | undefined => Bun.argv.slice(2).find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
const usage = 'Usage: bun scripts/fork/multiunit-perf.ts --origin=http://127.0.0.1:<port> --world-pid=<pid> --units=<n> --out=<file.json> [--warmup-seconds=60] [--block-seconds=120] [--blocks=3] [--soak-minutes=0]'
const whole = (name: string, fallback?: number): number => {
  const value = Number(option(name) ?? fallback)
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a whole number. ${usage}`)
  return value
}
const origin = assertLocalOrigin(option('origin') ?? (() => { throw new Error(usage) })())
const worldPid = whole('world-pid')
const units = whole('units')
const out = option('out')
if (out === undefined || !isAbsolute(out) || units < 4 || units > 60) throw new Error(usage)
const warmupSeconds = whole('warmup-seconds', 60)
const blockSeconds = whole('block-seconds', 120)
const blocks = whole('blocks', 3)
const soakMinutes = whole('soak-minutes', 0)

// ---------- World's process ----------

const CLOCK_TICKS = 100
const cpuSeconds = async (): Promise<number> => {
  const stat = await Bun.file(`/proc/${worldPid}/stat`).text()
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  // utime and stime are fields 14 and 15 of stat(5); fields here start at field 3.
  return (Number(fields[11]) + Number(fields[12])) / CLOCK_TICKS
}
const rssMb = async (): Promise<number> => {
  const status = await Bun.file(`/proc/${worldPid}/status`).text()
  return Number(/VmRSS:\s+(\d+) kB/.exec(status)![1]) / 1024
}
const cwd = await readlink(`/proc/${worldPid}/cwd`)
if (!cwd.endsWith('/apps/world')) throw new Error(`Process ${worldPid} runs in ${cwd}, not World`)

// ---------- the stack ----------

const request = async (path: string, body?: unknown): Promise<any> => {
  const response = await fetch(origin + path, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 400)}`)
  return JSON.parse(text)
}
const actor = { kind: 'human', id: 'multiunit-perf', displayName: 'Multiunit performance gate' }
const { workspace } = await request('/api/workspaces', { name: `Multiunit performance gate · ${units} units` })
const workspaceId = workspace.id as string
const invoke = (operationId: string, input: unknown, target: Record<string, unknown> = {}) =>
  request(`/api/workspaces/${workspaceId}/capabilities/${operationId}/invoke`, { ...target, input, actor })

/** The 12-unit fixture with its unit repeated to N, every unit in the one cluster; units 5 and up hold power off-grid. */
const scenarioOf = async (count: number) => {
  const fixture = await Bun.file(new URL('../../apps/world/tests/fixtures/scenarios/halden-fleet-12.scenario.json', import.meta.url).pathname).json()
  const plants = fixture.packs.find((pack: { id: string }) => pack.id === 'process-plant')
  const template = plants.items[0]
  plants.items = Array.from({ length: count }, (_, at) => ({
    ...template, id: `plant:halden-${at + 1}`, label: `Halden Unit ${at + 1}`,
    location: [Number((template.location[0] + (at % 6) * 0.007).toFixed(4)), Number((template.location[1] - Math.floor(at / 6) * 0.004).toFixed(4))],
  }))
  for (const pack of fixture.packs) pack.recording = { profileId: 'operations' }
  return { ...fixture, id: `halden-fleet-perf-${count}`, title: `Halden fleet: ${count} units (fork performance gate)` }
}

const source = await scenarioOf(units)
await invoke('world.scenario.create', { source })
const { definitions } = await request(`/api/workspaces/${workspaceId}/definitions`)
const definition = definitions.find((entry: { ref: { id: string } }) => entry.ref.id === source.id)
const launched = await invoke('world.scenario.start', {}, { definition: { ...definition.ref, revisionId: definition.currentRevisionId } })
const resource = launched.createdResources?.find((entry: { type: string }) => entry.type === 'world.simulation-run') ?? launched.result?.resource
if (!resource) throw new Error('The start returned no Simulation Run')
const runPath = `/api/workspaces/${workspaceId}/world/simulation-runs/${encodeURIComponent(resource.id)}`
await invoke('world.simulation-run.execution.set', { playback: 'playing', pace: 'realtime' }, { resource })

// One viewer, as an open Run page: it holds the lease and receives the realtime pushes.
const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/workspaces/${workspaceId}/world/ws?simulationRun=${encodeURIComponent(resource.id)}`)
let pushes = 0
let pushedBytes = 0
socket.addEventListener('message', event => { pushes += 1; pushedBytes += String(event.data).length })
await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve()); socket.addEventListener('error', () => reject(new Error('The viewer socket failed'))) })

// ---------- the displays ----------

const SET = { category: 'process-plants', group: 'halden-power-complex' }
const composeState = async (title: string, views: ReadonlyArray<unknown>): Promise<string> => {
  const composed = await invoke('world.simulation-run.display.compose', { title, question: title, subjects: [], views }, { resource })
  const state = composed.result?.view?.state ?? composed.result?.data?.view?.state
  if (typeof state !== 'string') throw new Error(`${title}: the compose returned no view state: ${JSON.stringify(composed).slice(0, 400)}`)
  await request(`${runPath}/displays/view`, { state })
  return state
}
const displays = [
  { name: 'fleet', state: await composeState('How are the units doing?', [{ kind: 'fleet', of: SET }]) },
  { name: 'compare', state: await composeState('Compare the units', [{ kind: 'compare', of: SET, signals: ['Pressurizer pressure', 'SG A level', 'Reactor power', 'Electrical output'] }]) },
]
const shapes = await Promise.all(displays.map(async display => {
  const { sample } = await request(`${runPath}/displays/sample`, { state: display.state })
  return { name: display.name, views: JSON.parse(display.state).views, sampleBytes: JSON.stringify(sample).length }
}))

/** Each display frame samples on its own 1 Hz timer, as the embed does; every sample's wall time is kept. */
const sampling = () => {
  const latencies: Record<string, number[]> = Object.fromEntries(displays.map(display => [display.name, []]))
  let failures = 0
  const timers = displays.map(display => setInterval(async () => {
    const started = performance.now()
    try {
      await request(`${runPath}/displays/sample`, { state: display.state })
      latencies[display.name]!.push(performance.now() - started)
    } catch { failures += 1 }
  }, 1_000))
  return { stop: () => { for (const timer of timers) clearInterval(timer) }, latencies, failures: () => failures }
}

// ---------- measuring ----------

const percent = (seconds: number, wallSeconds: number): number => Number((100 * seconds / wallSeconds).toFixed(2))
const quantile = (values: ReadonlyArray<number>, q: number): number => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted.length === 0 ? Number.NaN : Number(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(1))
}
const block = async (kind: 'off' | 'on') => {
  const sampler = kind === 'on' ? sampling() : null
  const cpuBefore = await cpuSeconds()
  const wallBefore = performance.now()
  await Bun.sleep(blockSeconds * 1_000)
  const cpu = percent(await cpuSeconds() - cpuBefore, (performance.now() - wallBefore) / 1_000)
  sampler?.stop()
  return { kind, cpu, rssMb: Math.round(await rssMb()), ...(sampler === null ? {} : { latencies: sampler.latencies, failures: sampler.failures() }) }
}

const simulationTime = async (): Promise<string> => (await request(`${runPath}/presence`)).execution.currentSimulationTime as string
console.log(JSON.stringify({ workspaceId, runId: resource.id, units, at: await simulationTime(), rssMb: Math.round(await rssMb()) }))
await Bun.sleep(warmupSeconds * 1_000)

const measured: Array<Awaited<ReturnType<typeof block>>> = []
for (let at = 0; at < 2 * blocks + 1; at += 1) {
  measured.push(await block(at % 2 === 0 ? 'off' : 'on'))
  console.log(JSON.stringify({ block: at, kind: measured.at(-1)!.kind, cpu: measured.at(-1)!.cpu, rssMb: measured.at(-1)!.rssMb }))
}
const mean = (values: ReadonlyArray<number>): number => Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
const off = measured.filter(entry => entry.kind === 'off')
const on = measured.filter(entry => entry.kind === 'on')
const all = (name: string) => on.flatMap(entry => entry.latencies?.[name] ?? [])
const latency = Object.fromEntries(displays.map(display => [display.name, { samples: all(display.name).length, p50: quantile(all(display.name), 0.5), p95: quantile(all(display.name), 0.95), max: quantile(all(display.name), 1) }]))
const both = displays.flatMap(display => all(display.name))
const gate = {
  cpuOff: mean(off.map(entry => entry.cpu)),
  cpuOn: mean(on.map(entry => entry.cpu)),
  addedCpuPoints: Number((mean(on.map(entry => entry.cpu)) - mean(off.map(entry => entry.cpu))).toFixed(2)),
  offSpread: [Math.min(...off.map(entry => entry.cpu)), Math.max(...off.map(entry => entry.cpu))],
  medianSampleMs: quantile(both, 0.5),
  p95SampleMs: quantile(both, 0.95),
  maxSampleMs: quantile(both, 1),
  failures: on.reduce((sum, entry) => sum + (entry.failures ?? 0), 0),
}
const budget = { addedCpuPoints: 1, medianSampleMs: 10 }
const result: Record<string, unknown> = {
  units, workspaceId, runId: resource.id, blockSeconds, blocks, warmupSeconds, displays: shapes,
  gate, budget, met: gate.addedCpuPoints < budget.addedCpuPoints && gate.medianSampleMs < budget.medianSampleMs && gate.failures === 0,
  latency, blocksMeasured: measured.map(entry => ({ kind: entry.kind, cpu: entry.cpu, rssMb: entry.rssMb })),
  pushesPerSecond: Number((pushes / ((2 * blocks + 1) * blockSeconds + warmupSeconds)).toFixed(2)),
}
await Bun.write(out, JSON.stringify(result, null, 2))
console.log(JSON.stringify({ gate, met: result.met, latency }))

if (soakMinutes > 0) {
  const sampler = sampling()
  const series: Array<{ wallMinutes: number; simulationTime: string; rssMb: number; cpu: number }> = []
  const started = performance.now()
  let cpuBefore = await cpuSeconds()
  let wallBefore = performance.now()
  while (performance.now() - started < soakMinutes * 60_000) {
    await Bun.sleep(30_000)
    const now = performance.now()
    const cpu = percent(await cpuSeconds() - cpuBefore, (now - wallBefore) / 1_000)
    cpuBefore = await cpuSeconds()
    wallBefore = now
    series.push({ wallMinutes: Number(((now - started) / 60_000).toFixed(2)), simulationTime: await simulationTime(), rssMb: Math.round(await rssMb()), cpu })
    console.log(JSON.stringify(series.at(-1)))
    result.soak = { minutes: soakMinutes, series }
    await Bun.write(out, JSON.stringify(result, null, 2))
  }
  sampler.stop()
  const rss = series.map(entry => entry.rssMb)
  const latencies = displays.flatMap(display => sampler.latencies[display.name]!)
  result.soak = {
    minutes: soakMinutes, peakRssMb: Math.max(...rss), firstRssMb: rss[0], lastRssMb: rss.at(-1),
    growthMbPerHour: Number(((rss.at(-1)! - rss[0]!) / ((series.at(-1)!.wallMinutes - series[0]!.wallMinutes) / 60)).toFixed(1)),
    meanCpu: mean(series.map(entry => entry.cpu)), medianSampleMs: quantile(latencies, 0.5), p95SampleMs: quantile(latencies, 0.95), maxSampleMs: quantile(latencies, 1),
    failures: sampler.failures(), series,
  }
  await Bun.write(out, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ...result.soak as object, series: undefined }))
}
socket.close()
await invoke('world.simulation-run.execution.set', { playback: 'paused' }, { resource })
