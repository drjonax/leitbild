// Norwegian public holidays on day numbers (days since 1970-01-01 of the proleptic Gregorian
// calendar), by integer arithmetic only: the demand sample asks once a minute without allocating.

/** Day number of a Gregorian date (month 1–12), by H. Hinnant's days_from_civil. */
export const dayOfDate = (year: number, month: number, day: number): number => {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yearOfEra = y - era * 400
  const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1
  return era * 146_097 + yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear - 719_468
}

/** Gregorian year of a day number (H. Hinnant's civil_from_days). */
export const yearOfDay = (dayNumber: number): number => {
  const shifted = dayNumber + 719_468
  const era = Math.floor(shifted / 146_097)
  const dayOfEra = shifted - era * 146_097
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1_460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365)
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100))
  // The shifted year starts on 1 March: its 306th day onwards is January or February of the next year.
  return era * 400 + yearOfEra + (dayOfYear >= 306 ? 1 : 0)
}

/** Day number of Easter Sunday of a Gregorian year, by the anonymous Gregorian algorithm (Meeus, Astronomical Algorithms, ch. 8). */
export const easterSunday = (year: number): number => {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const n = h + l - 7 * m + 114
  return dayOfDate(year, Math.floor(n / 31), (n % 31) + 1)
}

// Lov om helligdager og helligdagsfred § 2 (its helligdager besides Sundays); 1 and 17 May by lov om 1. og 17. mai som høgtidsdagar.
const fixedHolidays: ReadonlyArray<{ readonly month: number; readonly day: number; readonly name: string }> = [
  { month: 1, day: 1, name: 'nyttårsdag' },
  { month: 5, day: 1, name: '1. mai' },
  { month: 5, day: 17, name: '17. mai' },
  { month: 12, day: 25, name: 'første juledag' },
  { month: 12, day: 26, name: 'andre juledag' },
]
/** Moveable holidays, in days from Easter Sunday. */
const easterHolidays: ReadonlyArray<{ readonly offset: number; readonly name: string }> = [
  { offset: -3, name: 'skjærtorsdag' },
  { offset: -2, name: 'langfredag' },
  { offset: 0, name: 'første påskedag' },
  { offset: 1, name: 'andre påskedag' },
  { offset: 39, name: 'Kristi himmelfartsdag' },
  { offset: 49, name: 'første pinsedag' },
  { offset: 50, name: 'andre pinsedag' },
]

/** Whether a day number is a Norwegian public holiday. */
export const isNorwegianPublicHoliday = (dayNumber: number): boolean => {
  const year = yearOfDay(dayNumber)
  for (let index = 0; index < fixedHolidays.length; index += 1) {
    const holiday = fixedHolidays[index]!
    if (dayOfDate(year, holiday.month, holiday.day) === dayNumber) return true
  }
  const fromEaster = dayNumber - easterSunday(year)
  for (let index = 0; index < easterHolidays.length; index += 1) if (easterHolidays[index]!.offset === fromEaster) return true
  return false
}

/** The Norwegian public holidays of a year in date order, as ISO dates with their names. */
export const norwegianPublicHolidays = (year: number): ReadonlyArray<{ readonly date: string; readonly name: string }> => {
  const easter = easterSunday(year)
  return [
    ...fixedHolidays.map(holiday => ({ dayNumber: dayOfDate(year, holiday.month, holiday.day), name: holiday.name })),
    ...easterHolidays.map(holiday => ({ dayNumber: easter + holiday.offset, name: holiday.name })),
  ]
    .sort((left, right) => left.dayNumber - right.dayNumber)
    .map(holiday => ({ date: new Date(holiday.dayNumber * 86_400_000).toISOString().slice(0, 10), name: holiday.name }))
}
