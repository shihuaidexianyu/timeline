import type { DaySummary } from '../api'
import type { ChartSegment } from './chart-model'

export const MAX_ZOOM_HOURS = 24
export const MIN_ZOOM_HOURS = 1 / 12

export type WeekBarDatum = {
  date: string
  dayLabel: string
  activeSeconds: number
  focusSeconds: number
  isSelected: boolean
}

export function defaultTimelineViewport(
  date: string,
  agentToday: string | null,
  timezone: string | null,
) {
  const zoomHours = 0.5

  if (agentToday !== null && date === agentToday) {
    const currentHour = currentHourInTimezone(timezone)
    return {
      zoomHours,
      viewStartHour: clampViewStart(currentHour - zoomHours, zoomHours),
    }
  }

  return {
    zoomHours,
    viewStartHour: 0,
  }
}

export function formatHourLabel(hours: number) {
  const totalMinutes = Math.round(hours * 60)
  const normalizedMinutes = Math.max(0, totalMinutes)
  const whole = Math.floor(normalizedMinutes / 60)
  const minutes = normalizedMinutes % 60
  return `${`${whole}`.padStart(2, '0')}:${`${minutes}`.padStart(2, '0')}`
}

export function clampViewStart(startHour: number, zoomHours: number) {
  return Math.max(0, Math.min(startHour, 24 - zoomHours))
}

export function normalizeZoomHours(hours: number) {
  return Math.round(hours * 60) / 60
}

export function clampZoomHours(hours: number) {
  return Math.max(MIN_ZOOM_HOURS, Math.min(hours, MAX_ZOOM_HOURS))
}

export function monthFromDate(date: string) {
  return date.slice(0, 7)
}

export function coerceDateIntoMonth(month: string, baseDate: string) {
  const [yearText, monthText] = month.split('-')
  const preferredDay = Number(baseDate.slice(8, 10)) || 1
  const clampedDay = Math.min(preferredDay, daysInMonth(Number(yearText), Number(monthText)))
  return `${yearText}-${monthText}-${String(clampedDay).padStart(2, '0')}`
}

export function buildWeekSeries(days: DaySummary[], selectedDate: string): WeekBarDatum[] {
  const dayMap = new Map(days.map((day) => [day.date, day]))
  const selected = parseDateString(selectedDate)
  if (Number.isNaN(selected.getTime())) {
    return []
  }
  const weekday = (selected.getUTCDay() + 6) % 7
  const monday = addDays(selected, -weekday)

  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(monday, index)
    const dateKey = formatDateKey(date)
    const summary = dayMap.get(dateKey)

    return {
      date: dateKey,
      dayLabel: `${formatWeekday(date)} ${String(date.getUTCDate()).padStart(2, '0')}`,
      activeSeconds: summary?.active_seconds ?? 0,
      focusSeconds: summary?.active_app_seconds ?? summary?.focus_seconds ?? 0,
      isSelected: dateKey === selectedDate,
    }
  })
}

export function isValidDateKey(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

export function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`
}

export function overlapDuration(segment: ChartSegment, viewStartSec: number, viewEndSec: number) {
  return Math.max(0, Math.min(segment.endSec, viewEndSec) - Math.max(segment.startSec, viewStartSec))
}

export function sumOverlappedDuration(
  segments: ChartSegment[],
  viewStartSec: number,
  viewEndSec: number,
) {
  return segments.reduce(
    (total, segment) => total + overlapDuration(segment, viewStartSec, viewEndSec),
    0,
  )
}

export function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

export function buildVisibleFocusItems(
  segments: ChartSegment[],
  viewStartSec: number,
  viewEndSec: number,
) {
  return segments
    .filter((segment) => segment.endSec > viewStartSec && segment.startSec < viewEndSec)
    .sort((left, right) => {
      if (left.startSec !== right.startSec) {
        return left.startSec - right.startSec
      }

      return right.durationSec - left.durationSec
    })
}

export function buildPrimaryBrowserDomainMap(
  focusSegments: ChartSegment[],
  browserSegments: ChartSegment[],
) {
  const domainBySegmentId = new Map<string, string>()
  const browserFocusSegments = focusSegments
    .filter((segment) => segment.isBrowser)
    .toSorted((left, right) => left.startSec - right.startSec || left.endSec - right.endSec)
  const sortedBrowserSegments = browserSegments
    .toSorted((left, right) => left.startSec - right.startSec || left.endSec - right.endSec)
  let browserStartIndex = 0

  for (const focusSegment of browserFocusSegments) {
    while (
      browserStartIndex < sortedBrowserSegments.length &&
      sortedBrowserSegments[browserStartIndex].endSec <= focusSegment.startSec
    ) {
      browserStartIndex += 1
    }

    const domainDurations = new Map<string, number>()
    for (
      let browserIndex = browserStartIndex;
      browserIndex < sortedBrowserSegments.length;
      browserIndex += 1
    ) {
      const browserSegment = sortedBrowserSegments[browserIndex]
      if (browserSegment.startSec >= focusSegment.endSec) break
      const overlapStart = Math.max(focusSegment.startSec, browserSegment.startSec)
      const overlapEnd = Math.min(focusSegment.endSec, browserSegment.endSec)

      if (overlapEnd <= overlapStart) {
        continue
      }

      domainDurations.set(
        browserSegment.label,
        (domainDurations.get(browserSegment.label) ?? 0) + (overlapEnd - overlapStart),
      )
    }

    const primaryDomain = Array.from(domainDurations.entries())
      .sort((left, right) => right[1] - left[1])[0]?.[0]

    if (primaryDomain) {
      domainBySegmentId.set(focusSegment.id, primaryDomain)
    }
  }

  return domainBySegmentId
}

export function parseConfigList(value: string) {
  const unique = new Set<string>()

  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .forEach((item) => {
      unique.add(item)
    })

  return Array.from(unique.values())
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function currentHourInTimezone(timezone: string | null) {
  const offsetMinutes = parseUtcOffsetMinutes(timezone)
  if (offsetMinutes === null) {
    const now = new Date()
    return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600
  }

  const shifted = new Date(Date.now() + offsetMinutes * 60_000)
  return shifted.getUTCHours() + shifted.getUTCMinutes() / 60 + shifted.getUTCSeconds() / 3600
}

function parseUtcOffsetMinutes(value: string | null) {
  if (!value || value === 'Z') {
    return value === 'Z' ? 0 : null
  }

  const match = value.match(/^([+-])(\d{2}):(\d{2})$/)
  if (!match) {
    return null
  }

  const [, sign, hours, minutes] = match
  const total = Number(hours) * 60 + Number(minutes)
  return sign === '-' ? -total : total
}

function parseDateString(value: string) {
  return new Date(`${value}T00:00:00Z`)
}

function addDays(date: Date, offset: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + offset)
  return next
}

function formatDateKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function formatWeekday(date: Date) {
  return ['一', '二', '三', '四', '五', '六', '日'][(date.getUTCDay() + 6) % 7]
}
