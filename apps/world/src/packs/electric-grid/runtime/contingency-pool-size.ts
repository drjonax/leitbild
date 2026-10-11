import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'

// How many N-1 worker threads a host can usefully run: one fewer than the CPUs the process may
// use, at most the configured cap. On Linux the CPUs come from the cgroup v2 CPU quota (systemd's
// CPUQuota= writes it as `cpu.max`) when one applies; a host without one — macOS, which has no
// cgroups, or Linux on cgroup v1 or without a cpu.max — is limited by its core count (platform
// detection, not a fallback). A cpu.max that does not parse fails the pool's creation.

/** A cgroup v2 `cpu.max`: `max <period>` (no quota) or `<quota> <period>` in µs per period. */
export type CgroupCpuMax =
  | { readonly kind: 'unlimited' }
  | { readonly kind: 'limited'; readonly quotaMicroseconds: number; readonly periodMicroseconds: number; readonly cpus: number }

/** Parses the contents of a cgroup v2 `cpu.max`; anything else throws naming `source`. */
export const parseCgroupCpuMax = (text: string, source: string): CgroupCpuMax => {
  const match = /^(max|\d+) (\d+)\n?$/.exec(text)
  if (match === null) throw new Error(`${source} is not a cgroup v2 cpu.max ("<quota> <period>" or "max <period>"): ${JSON.stringify(text)}`)
  const periodMicroseconds = Number(match[2])
  if (!Number.isSafeInteger(periodMicroseconds) || periodMicroseconds <= 0) throw new Error(`${source} has no positive period: ${JSON.stringify(text)}`)
  if (match[1] === 'max') return { kind: 'unlimited' }
  const quotaMicroseconds = Number(match[1])
  if (!Number.isSafeInteger(quotaMicroseconds) || quotaMicroseconds <= 0) throw new Error(`${source} has no positive quota: ${JSON.stringify(text)}`)
  return { kind: 'limited', quotaMicroseconds, periodMicroseconds, cpus: quotaMicroseconds / periodMicroseconds }
}

/**
 * The process's cgroup v2 path from /proc/self/cgroup: its `0::<path>` entry, or null when it
 * has none (cgroup v1 only). Lines are `<hierarchy id>:<controllers>:<path>`; others throw.
 */
export const parseCgroupV2Path = (text: string): string | null => {
  let path: string | null = null
  for (const line of text.split('\n')) {
    if (line === '') continue
    const match = /^(\d+):([^:]*):(\/.*)$/.exec(line)
    if (match === null) throw new Error(`/proc/self/cgroup has a malformed line: ${JSON.stringify(line)}`)
    if (match[1] === '0' && match[2] === '') path = match[3]!
  }
  return path
}

/** The CPU limit the pool is sized by. */
export type HostCpuLimit =
  | { readonly kind: 'cgroup-v2'; readonly cgroupPath: string; readonly cpuMax: CgroupCpuMax }
  | { readonly kind: 'cores'; readonly why: string }

/** Reads a file's text, or null when it does not exist; any other failure throws. */
export type TextFileReader = (path: string) => string | null

/** cgroup v2's unified hierarchy; the cgroup-v2 controller list sits at its root. */
const cgroupV2Root = '/sys/fs/cgroup'

/**
 * The cgroup v2 CPU limit of the process: the smallest quota of its cgroup and its ancestors (a
 * slice's quota limits every unit in it), unlimited when they all read `max`. Without a unified
 * hierarchy, or without any cpu.max on the path, the cores limit the pool.
 */
export const cgroupV2CpuLimit = (read: TextFileReader): HostCpuLimit => {
  const membership = read('/proc/self/cgroup')
  if (membership === null) throw new Error('/proc/self/cgroup does not exist on this Linux host; the N-1 worker pool cannot read its CPU quota')
  const cgroupPath = parseCgroupV2Path(membership)
  if (cgroupPath === null) return { kind: 'cores', why: 'Linux without cgroup v2 membership (cgroup v1)' }
  if (read(`${cgroupV2Root}/cgroup.controllers`) === null) return { kind: 'cores', why: `Linux without a cgroup v2 hierarchy at ${cgroupV2Root}` }
  let limit: CgroupCpuMax | null = null
  let limitPath = cgroupPath
  const segments = cgroupPath.split('/').filter(segment => segment !== '')
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const path = `/${segments.slice(0, depth).join('/')}`
    const file = `${cgroupV2Root}${path === '/' ? '' : path}/cpu.max`
    const text = read(file)
    if (text === null) continue
    const cpuMax = parseCgroupCpuMax(text, file)
    if (limit === null || (cpuMax.kind === 'limited' && (limit.kind === 'unlimited' || cpuMax.cpus < limit.cpus))) {
      limit = cpuMax
      limitPath = path
    }
  }
  if (limit === null) return { kind: 'cores', why: `Linux cgroup ${cgroupPath} without a cpu.max` }
  return { kind: 'cgroup-v2', cgroupPath: limitPath, cpuMax: limit }
}

const readExistingText: TextFileReader = path => {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null
    throw error
  }
}

/** The CPU limit of this process; only Linux has cgroups (platform detection). */
export const hostCpuLimit = (): HostCpuLimit =>
  process.platform === 'linux' ? cgroupV2CpuLimit(readExistingText) : { kind: 'cores', why: `${process.platform} has no cgroups` }

export interface ContingencyPoolSizing {
  readonly size: number
  /** How the size was chosen, for diagnostics. */
  readonly reason: string
}

/**
 * Workers = min(cores − 1, cap, quota workers), where a cgroup quota of q CPUs allows
 * max(1, floor(q) − 1): one CPU stays with the main thread (the Grid's ticks and the server), but
 * a quota below two CPUs still gets one worker so a long screening leaves the main thread.
 */
export const contingencyPoolSizing = (config: {
  readonly cores: number
  readonly cap: number
  readonly capSource: string
  readonly limit: HostCpuLimit
}): ContingencyPoolSizing => {
  const { cores, cap, limit } = config
  const byCores = Math.max(0, cores - 1)
  const terms = [`cores ${cores} − 1 = ${byCores}`, `cap ${cap} (${config.capSource})`]
  let size = Math.min(byCores, cap)
  if (limit.kind === 'cores') terms.push(`no CPU quota: ${limit.why}`)
  else if (limit.cpuMax.kind === 'unlimited') terms.push(`cgroup v2 ${limit.cgroupPath} cpu.max max (no quota)`)
  else {
    const byQuota = Math.max(1, Math.floor(limit.cpuMax.cpus) - 1)
    terms.push(`cgroup v2 ${limit.cgroupPath} cpu.max ${limit.cpuMax.quotaMicroseconds} ${limit.cpuMax.periodMicroseconds} = ${limit.cpuMax.cpus} CPUs → max(1, ${Math.floor(limit.cpuMax.cpus)} − 1) = ${byQuota}`)
    size = Math.min(size, byQuota)
  }
  return { size, reason: `${size} worker${size === 1 ? '' : 's'} = min of ${terms.join('; ')}` }
}

/** What a host offers the pool: its cores and its CPU limit. */
export interface HostCpus {
  readonly cores: number
  readonly limit: HostCpuLimit
}

/** This process's host, read when the pool is created. */
export const currentHostCpus = (): HostCpus => ({ cores: availableParallelism(), limit: hostCpuLimit() })
