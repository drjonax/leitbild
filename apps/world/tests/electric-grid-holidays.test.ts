import { describe, expect, test } from 'bun:test'
import { buildLoadProfiles } from '../src/packs/electric-grid/model-build/profiles.ts'
import type { WeekProfileSnapshot } from '../src/packs/electric-grid/model-build/inputs.ts'
import { dayOfDate, easterSunday, isNorwegianPublicHoliday, norwegianPublicHolidays, yearOfDay } from '../src/packs/electric-grid/runtime/norwegian-holidays.ts'
import { priceAreas } from '../src/packs/electric-grid/schemas/grid-ids.ts'

const isoDate = (dayNumber: number): string => new Date(dayNumber * 86_400_000).toISOString().slice(0, 10)

describe('Norwegian public holidays', () => {
  test('converts dates and day numbers as the Gregorian calendar does, 1583–2400', () => {
    const mismatches: string[] = []
    for (let dayNumber = dayOfDate(1583, 1, 1); dayNumber <= dayOfDate(2400, 12, 31); dayNumber += 1) {
      const date = new Date(dayNumber * 86_400_000)
      if (yearOfDay(dayNumber) !== date.getUTCFullYear() || dayOfDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()) !== dayNumber) mismatches.push(isoDate(dayNumber))
    }
    expect(mismatches).toEqual([])
    expect(dayOfDate(1970, 1, 1)).toBe(0)
  })

  test('finds Easter Sunday by the anonymous Gregorian algorithm', () => {
    const published: Readonly<Record<number, string>> = {
      1818: '1818-03-22', 1886: '1886-04-25', 1961: '1961-04-02', 2000: '2000-04-23', 2008: '2008-03-23', 2011: '2011-04-24',
      2019: '2019-04-21', 2024: '2024-03-31', 2025: '2025-04-20', 2026: '2026-04-05', 2027: '2027-03-28', 2038: '2038-04-25', 2285: '2285-03-22',
    }
    for (const [year, date] of Object.entries(published)) expect(isoDate(easterSunday(Number(year)))).toBe(date)
    // Always a Sunday between 22 March and 25 April.
    for (let year = 1583; year <= 2400; year += 1) {
      const easter = easterSunday(year)
      expect(new Date(easter * 86_400_000).getUTCDay()).toBe(0)
      expect(easter).toBeGreaterThanOrEqual(dayOfDate(year, 3, 22))
      expect(easter).toBeLessThanOrEqual(dayOfDate(year, 4, 25))
    }
  })

  test('lists the twelve holidays of a year, the moveable ones from Easter', () => {
    expect(norwegianPublicHolidays(2026)).toEqual([
      { date: '2026-01-01', name: 'nyttårsdag' },
      { date: '2026-04-02', name: 'skjærtorsdag' },
      { date: '2026-04-03', name: 'langfredag' },
      { date: '2026-04-05', name: 'første påskedag' },
      { date: '2026-04-06', name: 'andre påskedag' },
      { date: '2026-05-01', name: '1. mai' },
      { date: '2026-05-14', name: 'Kristi himmelfartsdag' },
      { date: '2026-05-17', name: '17. mai' },
      { date: '2026-05-24', name: 'første pinsedag' },
      { date: '2026-05-25', name: 'andre pinsedag' },
      { date: '2026-12-25', name: 'første juledag' },
      { date: '2026-12-26', name: 'andre juledag' },
    ])
    // In 2027 Whit Monday falls on 17 May.
    expect(norwegianPublicHolidays(2027).filter(holiday => holiday.date === '2027-05-17').map(holiday => holiday.name).sort()).toEqual(['17. mai', 'andre pinsedag'])
    expect(norwegianPublicHolidays(2025).map(holiday => holiday.date)).toContain('2025-05-29')
  })

  test('marks exactly the listed days as holidays, 1900–2100', () => {
    const mismatches: string[] = []
    for (let year = 1900; year <= 2100; year += 1) {
      const listed = new Set(norwegianPublicHolidays(year).map(holiday => holiday.date))
      for (let dayNumber = dayOfDate(year, 1, 1); dayNumber <= dayOfDate(year, 12, 31); dayNumber += 1) {
        if (isNorwegianPublicHoliday(dayNumber) !== listed.has(isoDate(dayNumber))) mismatches.push(isoDate(dayNumber))
      }
    }
    expect(mismatches).toEqual([])
    // Christmas Eve, Easter Saturday and New Year's Eve are customary half days, not public holidays.
    for (const [year, month, day] of [[2026, 12, 24], [2026, 4, 4], [2026, 12, 31]] as const) expect(isNorwegianPublicHoliday(dayOfDate(year, month, day))).toBe(false)
  })

  test('the profile build refuses an Elhub week that contains a public holiday', () => {
    // Monday 2026-03-30 to Sunday 2026-04-05: Maundy Thursday, Good Friday and Easter Sunday.
    const hoursUtc = Array.from({ length: 168 }, (_, hour) => new Date(Date.parse('2026-03-29T22:00:00.000Z') + hour * 3_600_000).toISOString())
    const week: WeekProfileSnapshot = {
      source: { sourceId: 'elhub:consumption-per-group-mba-hour', url: 'https://example.test/elhub', retrievedAt: '2026-10-11T00:00:00.000Z', sha256: '0'.repeat(64), licence: 'cc-by-4.0' },
      week: { startDate: '2026-03-30', endDate: '2026-04-06' },
      hoursUtc,
      series: priceAreas.flatMap(priceArea => (['household', 'cabin', 'primary', 'secondary', 'tertiary'] as const).map(group => ({ priceArea, group, mw: hoursUtc.map(() => 100) }))),
    }
    expect(() => buildLoadProfiles({ modelId: 'electric-grid.test', winter: week, summer: week, referenceStartUtc: hoursUtc[7]!, referenceHour: '2026-03-30T07:00:00+02:00' }))
      .toThrow('Elhub week 2026-03-30: its hour 2026-04-01T22:00:00.000Z falls on a Norwegian public holiday')
  })
})
