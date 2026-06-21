import type { ChartSegment } from './chart-model'

const DAY_SECONDS = 24 * 60 * 60
const BUCKET_SECONDS = 10 * 60
const DAY_BUCKETS = DAY_SECONDS / BUCKET_SECONDS

export type DayUsageTrendSeries = {
  key: string
  label: string
  color: string
  totalSeconds: number
  bucketSeconds: number[]
}

export type DayUsageTrendModel = {
  labels: string[]
  series: DayUsageTrendSeries[]
}

export function buildDayUsageTrendModel(input: {
  appSegments: ChartSegment[]
  limit?: number
}): DayUsageTrendModel {
  const labels = Array.from({ length: DAY_BUCKETS }, (_, bucketIndex) =>
    formatClock(bucketIndex * BUCKET_SECONDS),
  )
  const seriesByKey = new Map<string, DayUsageTrendSeries>()

  for (const segment of input.appSegments) {
    addSegmentToSeries(seriesByKey, segment)
  }

  const limit = input.limit ?? 6
  const series = Array.from(seriesByKey.values())
    .filter((item) => item.totalSeconds > 0)
    .sort((left, right) => {
      if (right.totalSeconds !== left.totalSeconds) {
        return right.totalSeconds - left.totalSeconds
      }

      return left.label.localeCompare(right.label)
    })
    .slice(0, limit)

  return { labels, series }
}

function addSegmentToSeries(
  seriesByKey: Map<string, DayUsageTrendSeries>,
  segment: ChartSegment,
) {
  const startSec = clamp(segment.startSec, 0, DAY_SECONDS)
  const endSec = clamp(segment.endSec, 0, DAY_SECONDS)
  if (endSec <= startSec) {
    return
  }

  let series = seriesByKey.get(segment.key)
  if (!series) {
    series = {
      key: segment.key,
      label: segment.label,
      color: segment.color,
      totalSeconds: 0,
      bucketSeconds: Array.from({ length: DAY_BUCKETS }, () => 0),
    }
    seriesByKey.set(segment.key, series)
  }

  const startBucket = Math.floor(startSec / BUCKET_SECONDS)
  const endBucket = Math.ceil(endSec / BUCKET_SECONDS)

  for (let bucketIndex = startBucket; bucketIndex < endBucket; bucketIndex += 1) {
    const bucketStart = bucketIndex * BUCKET_SECONDS
    const bucketEnd = bucketStart + BUCKET_SECONDS
    const seconds = Math.max(
      0,
      Math.min(endSec, bucketEnd) - Math.max(startSec, bucketStart),
    )
    if (seconds > 0) {
      series.bucketSeconds[bucketIndex] += seconds
      series.totalSeconds += seconds
    }
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

function formatClock(seconds: number) {
  if (seconds >= DAY_SECONDS) {
    return '24:00'
  }

  const hour = Math.floor(seconds / 3600)
  const minute = Math.floor((seconds % 3600) / 60)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}
