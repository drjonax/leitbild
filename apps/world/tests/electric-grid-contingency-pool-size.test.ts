import { describe, expect, test } from 'bun:test'
import {
  cgroupV2CpuLimit,
  contingencyPoolSizing,
  parseCgroupCpuMax,
  parseCgroupV2Path,
  type HostCpuLimit,
  type TextFileReader,
} from '../src/packs/electric-grid/runtime/contingency-pool-size.ts'
import { contingencyPoolConfigFromEnv } from '../src/packs/electric-grid/runtime/contingency-pool.ts'

/** A Linux host's files as fixture strings; a missing path does not exist. */
const filesOf = (files: Readonly<Record<string, string>>): TextFileReader => path => files[path] ?? null

// /proc/self/cgroup of the World service under systemd on cgroup v2 (unified hierarchy).
const service = '0::/system.slice/leitbild-world.service\n'
const unified = { '/proc/self/cgroup': service, '/sys/fs/cgroup/cgroup.controllers': 'cpuset cpu io memory pids\n' }

const sized = (cores: number, cap: number, limit: HostCpuLimit) => contingencyPoolSizing({ cores, cap, capSource: 'default', limit })

describe('electric grid N-1 worker pool size', () => {
  test('parses cgroup v2 cpu.max: a quota in CPUs, or max for none; anything else is an error', () => {
    expect(parseCgroupCpuMax('180000 100000', 'cpu.max')).toEqual({ kind: 'limited', quotaMicroseconds: 180_000, periodMicroseconds: 100_000, cpus: 1.8 })
    expect(parseCgroupCpuMax('max 100000', 'cpu.max')).toEqual({ kind: 'unlimited' })
    expect(parseCgroupCpuMax('400000 100000\n', 'cpu.max')).toMatchObject({ cpus: 4 })
    for (const malformed of ['', 'max', '180000', '180000  100000', 'abc 100000', '1.5 100000', '-5 100000', '0 100000', '180000 0', '180000 100000 1', ' max 100000']) {
      expect(() => parseCgroupCpuMax(malformed, '/sys/fs/cgroup/x/cpu.max')).toThrow('/sys/fs/cgroup/x/cpu.max')
    }
  })

  test('finds the cgroup v2 path in /proc/self/cgroup, or none on cgroup v1', () => {
    expect(parseCgroupV2Path(service)).toBe('/system.slice/leitbild-world.service')
    expect(parseCgroupV2Path('0::/\n')).toBe('/')
    // Hybrid: v1 controllers beside the unified entry.
    expect(parseCgroupV2Path('12:cpu,cpuacct:/system.slice/a.service\n1:name=systemd:/system.slice/a.service\n0::/system.slice/a.service\n')).toBe('/system.slice/a.service')
    expect(parseCgroupV2Path('12:cpu,cpuacct:/system.slice/a.service\n1:name=systemd:/system.slice/a.service\n')).toBeNull()
    expect(() => parseCgroupV2Path('garbage\n')).toThrow('/proc/self/cgroup has a malformed line: "garbage"')
  })

  test('reads the smallest quota on the cgroup path; without a unified hierarchy or a cpu.max the cores limit the pool', () => {
    expect(cgroupV2CpuLimit(filesOf({ ...unified, '/sys/fs/cgroup/system.slice/leitbild-world.service/cpu.max': '180000 100000\n', '/sys/fs/cgroup/system.slice/cpu.max': 'max 100000\n' })))
      .toEqual({ kind: 'cgroup-v2', cgroupPath: '/system.slice/leitbild-world.service', cpuMax: { kind: 'limited', quotaMicroseconds: 180_000, periodMicroseconds: 100_000, cpus: 1.8 } })
    // A slice's quota limits every unit in it.
    expect(cgroupV2CpuLimit(filesOf({ ...unified, '/sys/fs/cgroup/system.slice/leitbild-world.service/cpu.max': '400000 100000', '/sys/fs/cgroup/system.slice/cpu.max': '200000 100000' })))
      .toMatchObject({ cgroupPath: '/system.slice', cpuMax: { cpus: 2 } })
    expect(cgroupV2CpuLimit(filesOf({ ...unified, '/sys/fs/cgroup/system.slice/leitbild-world.service/cpu.max': 'max 100000' })))
      .toEqual({ kind: 'cgroup-v2', cgroupPath: '/system.slice/leitbild-world.service', cpuMax: { kind: 'unlimited' } })
    // A container's cgroup namespace puts its own cgroup at the root of the mount.
    expect(cgroupV2CpuLimit(filesOf({ '/proc/self/cgroup': '0::/\n', '/sys/fs/cgroup/cgroup.controllers': 'cpu\n', '/sys/fs/cgroup/cpu.max': '250000 100000' })))
      .toMatchObject({ cgroupPath: '/', cpuMax: { cpus: 2.5 } })
    expect(cgroupV2CpuLimit(filesOf(unified))).toEqual({ kind: 'cores', why: 'Linux cgroup /system.slice/leitbild-world.service without a cpu.max' })
    expect(cgroupV2CpuLimit(filesOf({ '/proc/self/cgroup': service }))).toEqual({ kind: 'cores', why: 'Linux without a cgroup v2 hierarchy at /sys/fs/cgroup' })
    expect(cgroupV2CpuLimit(filesOf({ '/proc/self/cgroup': '4:cpu:/a\n' }))).toEqual({ kind: 'cores', why: 'Linux without cgroup v2 membership (cgroup v1)' })
    expect(() => cgroupV2CpuLimit(filesOf({ ...unified, '/sys/fs/cgroup/system.slice/leitbild-world.service/cpu.max': '180000\n' })))
      .toThrow('/sys/fs/cgroup/system.slice/leitbild-world.service/cpu.max is not a cgroup v2 cpu.max')
    expect(() => cgroupV2CpuLimit(filesOf({}))).toThrow('/proc/self/cgroup does not exist')
  })

  test('sizes the pool as min(cores − 1, cap, max(1, floor(quota) − 1)) and says why', () => {
    const quota = (cpuMax: string): HostCpuLimit => ({ kind: 'cgroup-v2', cgroupPath: '/system.slice/leitbild-world.service', cpuMax: parseCgroupCpuMax(cpuMax, 'cpu.max') })
    // Production: CPUQuota=180% on a multi-core host gives one worker.
    const production = sized(8, 4, quota('180000 100000'))
    expect(production.size).toBe(1)
    expect(production.reason).toBe('1 worker = min of cores 8 − 1 = 7; cap 4 (default); cgroup v2 /system.slice/leitbild-world.service cpu.max 180000 100000 = 1.8 CPUs → max(1, 1 − 1) = 1')
    expect(sized(8, 4, quota('max 100000'))).toEqual({ size: 4, reason: '4 workers = min of cores 8 − 1 = 7; cap 4 (default); cgroup v2 /system.slice/leitbild-world.service cpu.max max (no quota)' })
    expect(sized(8, 4, quota('350000 100000')).size).toBe(2)
    expect(sized(8, 4, quota('50000 100000')).size).toBe(1)
    expect(sized(16, 4, quota('1600000 100000')).size).toBe(4)
    expect(sized(8, 4, { kind: 'cores', why: 'darwin has no cgroups' })).toEqual({ size: 4, reason: '4 workers = min of cores 8 − 1 = 7; cap 4 (default); no CPU quota: darwin has no cgroups' })
    expect(sized(3, 4, { kind: 'cores', why: 'darwin has no cgroups' }).size).toBe(2)
    // No spare core, or a cap of 0, runs no worker whatever the quota.
    expect(sized(1, 4, quota('180000 100000')).size).toBe(0)
    expect(sized(8, 0, quota('180000 100000')).size).toBe(0)
    // The environment's cap still applies under a quota.
    const capped = contingencyPoolConfigFromEnv({ LEITBILD_GRID_N1_MAX_WORKERS: '2' }, { cores: 16, limit: quota('800000 100000') })
    expect(capped.size).toBe(2)
    expect(capped.sizeReason).toContain('cap 2 (LEITBILD_GRID_N1_MAX_WORKERS)')
  })
})
