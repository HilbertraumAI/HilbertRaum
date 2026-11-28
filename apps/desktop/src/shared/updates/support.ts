// The support-end and age notices (app-update W-17, F-12, G-13 (b), G-29 (a); docs/app-updates.md §8.4 "The support
// computation"; the owner's rule A1, 2026-11-27): which one notice, if any, this build shows on a given local date.
// Frozen in release 1: every later version that runs on a sold Kit keeps these answers (the golden
// tests/fixtures/updates/import/f12-support-dates.json holds them).
//
// The rule: support runs through the last day of the month stamped in config/kit-support.txt, judged by the computer's
// local date; the age is counted in whole calendar months from the build day; the age reminder comes 6 months after the
// build date; past the later of the build day and the support end plus 36 months the end notice is reworded, never
// suppressed; a dismissal hides only the notice dismissed, for 6 months.
//
// Pure: it imports nothing and takes everything as arguments. It reads no clock, no file and no storage, so the renderer
// and main may both call it. What does not read counts as null, never as an error, and it never throws. It parses no
// stamp file itself: the caller hands it readKitSupport's month (CF-37).

/** The three notice codes (record §5.8). */
export type SupportNoticeCode = 'UPD-AGE-REMINDER' | 'UPD-SUPPORT-ENDED' | 'UPD-SUPPORT-ENDED-LONG-AGO'

/** A calendar date as the computer's local clock has it: `getFullYear()`, `getMonth() + 1`, `getDate()`. */
export interface CalendarDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** What the caller hands in (record §8.4, row "Inputs"). */
export interface SupportInput {
  /** The build-date reader's text (§5.10), `YYYY-MM-DDTHH:MM:SSZ`, or null. */
  readonly buildDate: string | null
  /** readKitSupport's `month` (`YYYY-MM`), or null for `absent`, `unreadable` and `damaged`. */
  readonly supportMonth: string | null
  /** The computer's local date, taken by the caller from one `new Date()`. */
  readonly today: CalendarDate
  /** At most one date per notice code: the local date that notice was last dismissed on. */
  readonly dismissed: Readonly<Partial<Record<SupportNoticeCode, CalendarDate>>> | null
}

/** The notice and its parameters (record §8.4, row "Parameters"). */
export type SupportNotice =
  | { readonly code: 'UPD-AGE-REMINDER'; readonly params: { readonly ageMonths: number } }
  | { readonly code: 'UPD-SUPPORT-ENDED'; readonly params: { readonly supportEnd: string } }
  | { readonly code: 'UPD-SUPPORT-ENDED-LONG-AGO'; readonly params: { readonly supportEnd: string; readonly ageMonths: number } }

/** The age at which the reminder shows (G-29 (a)). */
const AGE_REMINDER_MONTHS = 6
/** How long a dismissal hides its notice (G-29 (a)). */
const DISMISSAL_MONTHS = 6
/** Past the later of the build day and the support end by this much, the end notice is reworded (W-17: 3 years). */
const LONG_AGO_MONTHS = 36

/** A day of the Gregorian calendar; within this file only, so it is always a real date or a month count's result. */
interface Day {
  readonly y: number
  readonly m: number
  readonly d: number
}

/** The build date's text: §2.4's `issued` grammar (four-digit year, upper-case T and Z, no fraction, no offset). */
const BUILD_DATE_TEXT = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/
/** The stamp: `YYYY-MM`, four digits, a hyphen, a month from 01 to 12 (§8.4, as kit-support.ts reads it). */
const SUPPORT_MONTH_TEXT = /^([0-9]{4})-(0[1-9]|1[0-2])$/

/** A plain object: never null, never an array. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An own key's value; a key reached through the prototype is none. */
function own(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined
}

/** The last day of a month: 31, 30, or in February 29 in a leap year (divisible by 4 and not by 100, or by 400), else 28. */
function lastDay(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31
}

/** A real date: three integers, a year from 1 to 9999, a month from 1 to 12 and a day that month has; else null. */
function realDate(value: unknown): Day | null {
  if (!isObject(value)) return null
  const y = own(value, 'year')
  const m = own(value, 'month')
  const d = own(value, 'day')
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null
  const [year, month, day] = [y, m, d] as [number, number, number]
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > lastDay(year, month)) return null
  return { y: year, m: month, d: day }
}

/**
 * The build day: the date part of a build date in the `issued` grammar (a real time from the year 2000 to 9999, hour
 * 00-23, minute and second 00-59), a UTC date; else null.
 */
function buildDay(value: unknown): Day | null {
  if (typeof value !== 'string') return null
  const match = BUILD_DATE_TEXT.exec(value)
  if (match === null) return null
  const [y, m, d, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number]
  if (y < 2000 || m < 1 || m > 12 || d < 1 || d > lastDay(y, m) || hour > 23 || minute > 59 || second > 59) return null
  return { y, m, d }
}

/** The support end: the last day of the stamped month; null for a stamp that does not read. */
function supportEndDay(value: unknown): Day | null {
  if (typeof value !== 'string') return null
  const match = SUPPORT_MONTH_TEXT.exec(value)
  if (match === null) return null
  const y = Number(match[1])
  const m = Number(match[2])
  return { y, m, d: lastDay(y, m) }
}

/** Dates compare by year, then month, then day: negative, zero or positive. */
function compare(a: Day, b: Day): number {
  return a.y !== b.y ? a.y - b.y : a.m !== b.m ? a.m - b.m : a.d - b.d
}

/** N months after a date: the same day N months later, or that month's last day when it has fewer days. */
function monthsAfter(date: Day, n: number): Day {
  const total = date.y * 12 + (date.m - 1) + n
  const y = Math.floor(total / 12)
  const m = total - y * 12 + 1
  return { y, m, d: Math.min(date.d, lastDay(y, m)) }
}

/** The age in whole months: the largest N >= 0 for which N months after the build day is not after today. */
function ageMonths(build: Day, today: Day): number {
  const n = (today.y - build.y) * 12 + (today.m - build.m)
  return compare(monthsAfter(build, n), today) > 0 ? n - 1 : n
}

/** Hidden by its own dismissal: a real date, not after today, and today before 6 months after it. */
function hiddenByDismissal(code: SupportNoticeCode, dismissed: unknown, today: Day): boolean {
  if (!isObject(dismissed)) return false
  const on = realDate(own(dismissed, code))
  return on !== null && compare(on, today) <= 0 && compare(today, monthsAfter(on, DISMISSAL_MONTHS)) < 0
}

/** The notice before dismissals (record §8.4, row "The answer", steps (1) to (5)). */
function noticeFor(input: Record<string, unknown>, today: Day): SupportNotice | null {
  const build = buildDay(own(input, 'buildDate'))
  if (build === null || compare(today, build) < 0) return null
  const stamp = own(input, 'supportMonth')
  const end = supportEndDay(stamp)
  if (end !== null && compare(today, end) > 0) {
    const supportEnd = stamp as string
    const later = compare(build, end) > 0 ? build : end
    if (compare(today, monthsAfter(later, LONG_AGO_MONTHS)) > 0) {
      return { code: 'UPD-SUPPORT-ENDED-LONG-AGO', params: { supportEnd, ageMonths: ageMonths(build, today) } }
    }
    return { code: 'UPD-SUPPORT-ENDED', params: { supportEnd } }
  }
  const age = ageMonths(build, today)
  return age >= AGE_REMINDER_MONTHS ? { code: 'UPD-AGE-REMINDER', params: { ageMonths: age } } : null
}

/**
 * The one notice this build shows today, or null (record §8.4 "The support computation"), the first that applies:
 * (1) no build date that reads: none; (2) today before the build day: none; (3) a stamp that reads and today after its
 * support end: `UPD-SUPPORT-ENDED-LONG-AGO` when today is after 36 months after the later of the build day and the
 * support end, else `UPD-SUPPORT-ENDED` (it replaces the age reminder); (4) an age of 6 months or more:
 * `UPD-AGE-REMINDER`; (5) none. Then the notice found is hidden while its own code's dismissal date is not after today
 * and today is before 6 months after it; another code's dismissal hides nothing, and a dismissal dated after today
 * hides nothing. A today that is no real date gives none; a dismissal that is no real date, or a `dismissed` that is no
 * plain object, counts as none. Never throws.
 */
export function supportNotice(input: SupportInput): SupportNotice | null {
  if (!isObject(input)) return null
  const today = realDate(own(input, 'today'))
  if (today === null) return null
  const notice = noticeFor(input, today)
  if (notice === null || hiddenByDismissal(notice.code, own(input, 'dismissed'), today)) return null
  return notice
}
