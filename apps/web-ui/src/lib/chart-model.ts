/* Data shaping helpers for interactive timeline and donut charts. */

import type {
  BrowserSegment,
  FocusSegment,
  PresenceSegment,
  TimelineDayResponse,
} from '../api'

const DAY_SECONDS = 24 * 60 * 60
const APP_PRESET_COLORS: string[] = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#be123c',
  '#65a30d',
  '#ea580c',
  '#0f766e',
  '#9333ea',
  '#ca8a04',
]
const DOMAIN_PRESET_COLORS: string[] = [
  '#1d4ed8',
  '#b91c1c',
  '#15803d',
  '#c2410c',
  '#6d28d9',
  '#0f766e',
  '#a21caf',
  '#0369a1',
  '#4d7c0f',
  '#d97706',
  '#be185d',
  '#4338ca',
]

export type TooltipDatum = {
  x: number
  y: number
  color: string
  title: string
  lines: string[]
}

export type DashboardFilter = {
  kind: 'app' | 'domain'
  key: string
} | null

export type ChartSegment = {
  id: string
  key: string
  label: string
  detail: string
  tone: 'focus' | 'browser' | 'presence'
  startSec: number
  endSec: number
  durationSec: number
  color: string
  isBrowser?: boolean
}

export type DonutSlice = {
  id: string
  key: string
  label: string
  value: number
  percentage: number
  color: string
}

export type DashboardModel = {
  focusSegments: ChartSegment[]
  browserSegments: ChartSegment[]
  presenceSegments: ChartSegment[]
  appSlices: DonutSlice[]
  domainSlices: DonutSlice[]
  presenceSlices: DonutSlice[]
  summary: {
    focusSeconds: number
    activeSeconds: number
    longestFocusSeconds: number
    switchCount: number
  }
  meta: {
    focusCount: number
    browserCount: number
    presenceCount: number
  }
}

export type BrowserDetailModel = {
  segments: ChartSegment[]
  slices: DonutSlice[]
  totalSeconds: number
}

type Interval = {
  startSec: number
  endSec: number
}

type TimelineTimeContext = {
  date: string
  timezone: string
}

export function buildDashboardModel(
  timeline: TimelineDayResponse,
  activeOnly: boolean,
): DashboardModel {
  const timeContext = {
    date: timeline.date,
    timezone: timeline.timezone,
  }
  const activeIntervals = buildActiveIntervals(timeline.presence_segments, timeContext)
  const focusSegments = toFocusChartSegments(
    timeline.focus_segments,
    activeOnly ? activeIntervals : null,
    timeContext,
  )
  const focusSegmentsWithColor = assignDistinctColors(focusSegments, 'app')
  const browserSegments = toBrowserChartSegments(
    timeline.browser_segments,
    activeOnly ? activeIntervals : null,
    timeContext,
  )
  const browserSegmentsWithColor = assignDistinctColors(browserSegments, 'domain')
  const presenceSegments = toPresenceChartSegments(timeline.presence_segments, timeContext)

  return {
    focusSegments: focusSegmentsWithColor,
    browserSegments: browserSegmentsWithColor,
    presenceSegments,
    appSlices: buildDonutSlices(focusSegmentsWithColor, 6),
    domainSlices: buildDonutSlices(browserSegmentsWithColor, 6),
    presenceSlices: buildDonutSlices(presenceSegments, 3),
    summary: {
      focusSeconds: sumDurations(focusSegmentsWithColor),
      activeSeconds: sumDurations(
        presenceSegments.filter((segment) => segment.key === 'active'),
      ),
      longestFocusSeconds: focusSegmentsWithColor.reduce(
        (max, segment) => Math.max(max, segment.durationSec),
        0,
      ),
      switchCount: Math.max(focusSegmentsWithColor.length - 1, 0),
    },
    meta: {
      focusCount: focusSegmentsWithColor.length,
      browserCount: browserSegmentsWithColor.length,
      presenceCount: presenceSegments.length,
    },
  }
}

export function buildBrowserDetailModel(
  selectedFocusSegment: ChartSegment | null,
  browserSegments: ChartSegment[],
  selectedDomainKey: string | null,
): BrowserDetailModel {
  if (!selectedFocusSegment || !selectedFocusSegment.isBrowser) {
    return {
      segments: [],
      slices: [],
      totalSeconds: 0,
    }
  }

  const overlappingSegments = browserSegments
    .map((segment) => {
      const startSec = Math.max(segment.startSec, selectedFocusSegment.startSec)
      const endSec = Math.min(segment.endSec, selectedFocusSegment.endSec)

      if (endSec <= startSec) {
        return null
      }

      return {
        ...segment,
        id: `${segment.id}-detail-${startSec}`,
        startSec,
        endSec,
        durationSec: endSec - startSec,
      }
    })
    .filter((segment): segment is ChartSegment => segment !== null)

  const filteredSegments = selectedDomainKey
    ? overlappingSegments.filter((segment) => segment.key === selectedDomainKey)
    : overlappingSegments

  return {
    segments: filteredSegments,
    slices: buildDonutSlices(overlappingSegments, 6),
    totalSeconds: sumDurations(filteredSegments),
  }
}

export function formatDuration(seconds: number) {
  if (seconds <= 0) {
    return '0m'
  }

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  if (hours === 0) {
    return `${minutes}m`
  }

  if (minutes === 0) {
    return `${hours}h`
  }

  return `${hours}h ${minutes}m`
}

export function formatClockRange(startSec: number, endSec: number) {
  return `${formatClock(startSec)} - ${formatClock(endSec)}`
}

export function isFilterActive(
  filter: DashboardFilter,
  kind: 'app' | 'domain',
  key: string,
) {
  return filter?.kind === kind && filter.key === key
}

function toFocusChartSegments(
  segments: FocusSegment[],
  activeIntervals: Interval[] | null,
  timeContext: TimelineTimeContext,
) {
  const results: ChartSegment[] = []

  for (const segment of segments) {
    const ranges = clipSegment(
      toRange(segment.started_at, segment.ended_at, timeContext),
      activeIntervals,
    )

    ranges.forEach((range, index) => {
      results.push({
        id: `focus-${segment.id}-${index}`,
        key: segment.app.process_name,
        label: segment.app.display_name,
        detail: segment.app.window_title ?? segment.app.process_name,
        tone: 'focus',
        startSec: range.startSec,
        endSec: range.endSec,
        durationSec: range.endSec - range.startSec,
        color: '',
        isBrowser: segment.app.is_browser,
      })
    })
  }

  return results
}

function toBrowserChartSegments(
  segments: BrowserSegment[],
  activeIntervals: Interval[] | null,
  timeContext: TimelineTimeContext,
) {
  const results: ChartSegment[] = []

  for (const segment of segments) {
    const ranges = clipSegment(
      toRange(segment.started_at, segment.ended_at, timeContext),
      activeIntervals,
    )

    ranges.forEach((range, index) => {
      results.push({
        id: `browser-${segment.id}-${index}`,
        key: segment.domain,
        label: segment.domain,
        detail: segment.page_title ?? `标签页 ${segment.tab_id}`,
        tone: 'browser',
        startSec: range.startSec,
        endSec: range.endSec,
        durationSec: range.endSec - range.startSec,
        color: '',
      })
    })
  }

  return results
}

function toPresenceChartSegments(
  segments: PresenceSegment[],
  timeContext: TimelineTimeContext,
) {
  const results: ChartSegment[] = []

  for (const segment of segments) {
    const range = toRange(segment.started_at, segment.ended_at, timeContext)
    if (!range) {
      continue
    }

    results.push({
      id: `presence-${segment.id}`,
      key: segment.state,
      label: presenceLabel(segment.state),
      detail: `状态段 ${segment.id}`,
      tone: 'presence',
      startSec: range.startSec,
      endSec: range.endSec,
      durationSec: range.endSec - range.startSec,
      color: presenceColor(segment.state),
    })
  }

  return results
}

function buildActiveIntervals(
  segments: PresenceSegment[],
  timeContext: TimelineTimeContext,
) {
  return segments
    .filter((segment) => segment.state === 'active')
    .map((segment) => toRange(segment.started_at, segment.ended_at, timeContext))
    .filter((segment): segment is Interval => segment !== null)
}

function buildDonutSlices(segments: ChartSegment[], topN: number) {
  const grouped = new Map<string, { label: string; value: number; color: string }>()

  for (const segment of segments) {
    const current = grouped.get(segment.key)
    if (current) {
      current.value += segment.durationSec
      continue
    }

    grouped.set(segment.key, {
      label: segment.label,
      value: segment.durationSec,
      color: segment.color,
    })
  }

  const total = Array.from(grouped.values()).reduce((sum, item) => sum + item.value, 0)
  const sorted = Array.from(grouped.entries())
    .map(([key, item]) => ({ key, ...item }))
    .sort((left, right) => right.value - left.value)

  const slices = sorted.slice(0, topN).map((item) => ({
    id: `slice-${item.key}`,
    key: item.key,
    label: item.label,
    value: item.value,
    percentage: total === 0 ? 0 : (item.value / total) * 100,
    color: item.color,
  }))

  if (sorted.length > topN) {
    const otherValue = sorted.slice(topN).reduce((sum, item) => sum + item.value, 0)
    slices.push({
      id: 'slice-others',
      key: 'others',
      label: '其他',
      value: otherValue,
      percentage: total === 0 ? 0 : (otherValue / total) * 100,
      color: '#94a3b8',
    })
  }

  return slices
}

function clipSegment(range: Interval | null, activeIntervals: Interval[] | null) {
  if (!range) {
    return []
  }

  if (!activeIntervals) {
    return [range]
  }

  const clipped: Interval[] = []

  for (const interval of activeIntervals) {
    const startSec = Math.max(range.startSec, interval.startSec)
    const endSec = Math.min(range.endSec, interval.endSec)

    if (endSec > startSec) {
      clipped.push({ startSec, endSec })
    }
  }

  return clipped
}

function toRange(
  startedAt: string,
  endedAt: string | null,
  timeContext: TimelineTimeContext,
): Interval | null {
  if (!endedAt) {
    return null
  }

  const startSec = toSecondsSinceMidnight(startedAt, timeContext)
  const endSec = toSecondsSinceMidnight(endedAt, timeContext)
  if (endSec <= startSec) {
    return null
  }

  return { startSec, endSec }
}

/**
 * Converts a UTC ISO timestamp to seconds-since-local-midnight for chart positioning.
 *
 * Steps:
 *   1. Parse the UTC timestamp via `new Date()`.
 *   2. Shift it by the timeline's UTC offset to get local wall-clock time.
 *   3. If the shifted date falls before/after the query date, clamp to 0 or DAY_SECONDS.
 *   4. Otherwise extract HH:MM:SS as seconds since midnight.
 */
function toSecondsSinceMidnight(value: string, timeContext: TimelineTimeContext) {
  const date = new Date(value)
  const shifted = new Date(date.getTime() + parseUtcOffsetMillis(timeContext.timezone))
  const shiftedDate = shifted.toISOString().slice(0, 10)

  if (shiftedDate < timeContext.date) {
    return 0
  }

  if (shiftedDate > timeContext.date) {
    return DAY_SECONDS
  }

  const seconds =
    shifted.getUTCHours() * 3600 +
    shifted.getUTCMinutes() * 60 +
    shifted.getUTCSeconds()

  return Math.max(0, Math.min(seconds, DAY_SECONDS))
}

/** Parses a timezone string like "+08:00" or "-05:30" into milliseconds offset from UTC. */
function parseUtcOffsetMillis(value: string) {
  const match = value.match(/^([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) {
    return 0
  }

  const [, sign, hours, minutes, seconds = '0'] = match
  const totalSeconds =
    Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)

  return (sign === '-' ? -1 : 1) * totalSeconds * 1000
}

function formatClock(seconds: number) {
  const clamped = Math.max(0, Math.min(seconds, DAY_SECONDS))
  const hours = Math.floor(clamped / 3600)
  const minutes = Math.floor((clamped % 3600) / 60)
  return `${`${hours}`.padStart(2, '0')}:${`${minutes}`.padStart(2, '0')}`
}

function sumDurations(segments: ChartSegment[]) {
  return segments.reduce((sum, segment) => sum + segment.durationSec, 0)
}

function assignDistinctColors(
  segments: ChartSegment[],
  namespace: 'app' | 'domain',
) {
  if (segments.length === 0) {
    return segments
  }

  const totals = new Map<string, number>()
  for (const segment of segments) {
    totals.set(segment.key, (totals.get(segment.key) ?? 0) + segment.durationSec)
  }

  const orderedKeys = Array.from(totals.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1]
      }

      return left[0].localeCompare(right[0])
    })
    .map(([key]) => key)

  const palette = buildDistinctPalette(orderedKeys.length, namespace)
  const colorByKey = new Map(
    orderedKeys.map((key, index) => [key, palette[index] ?? palette[palette.length - 1]]),
  )

  return segments.map((segment) => ({
    ...segment,
    color: colorByKey.get(segment.key) ?? '#4f7cff',
  }))
}

function buildDistinctPalette(count: number, namespace: 'app' | 'domain') {
  const preset =
    namespace === 'app' ? [...APP_PRESET_COLORS] : [...DOMAIN_PRESET_COLORS]

  if (count <= preset.length) {
    return preset.slice(0, count)
  }

  const generated = Array.from({ length: count - preset.length }, (_, index) =>
    generatedDistinctColor(index, namespace),
  )
  return preset.concat(generated)
}

function generatedDistinctColor(index: number, namespace: 'app' | 'domain') {
  const hueOffset = namespace === 'app' ? 18 : 42
  const hue = Math.round((hueOffset + index * 137.508) % 360)
  const saturation = 72 - (index % 3) * 6
  const lightness = 46 + ((index + (namespace === 'app' ? 0 : 1)) % 2) * 8
  return `hsl(${hue} ${saturation}% ${lightness}%)`
}

function presenceLabel(state: PresenceSegment['state']) {
  if (state === 'active') {
    return '活跃'
  }
  if (state === 'idle') {
    return '空闲'
  }
  return '锁定'
}

function presenceColor(state: PresenceSegment['state']) {
  if (state === 'active') {
    return '#22c55e'
  }
  if (state === 'idle') {
    return '#64748b'
  }
  return '#334155'
}

export function todayString() {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}
