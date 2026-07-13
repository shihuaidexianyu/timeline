import type { ChartSegment } from '../../lib/chart-model'

export type TimelineSegmentKind = 'all' | 'app' | 'browser'

export type TimelineFilterState = {
  activeOnly: boolean
  searchQuery: string
  segmentKind: TimelineSegmentKind
}

export type TimelineSelectionState = {
  focusedSegmentId: string | null
  hoveredSegmentId: string | null
}

export function filterTimelineFocusSegments(
  segments: ChartSegment[],
  browserDomainBySegmentId: ReadonlyMap<string, string>,
  normalizedSearchQuery: string,
  segmentKind: TimelineSegmentKind,
  searchTextBySegmentId?: ReadonlyMap<string, string>,
) {
  return segments.filter((segment) =>
    matchesTimelineFilter(
      segment,
      browserDomainBySegmentId.get(segment.id) ?? null,
      normalizedSearchQuery,
      segmentKind,
      searchTextBySegmentId?.get(segment.id),
    ),
  )
}

export function matchesTimelineFilter(
  segment: ChartSegment,
  domain: string | null,
  normalizedSearchQuery: string,
  segmentKind: TimelineSegmentKind,
  precomputedSearchText?: string,
) {
  if (segmentKind === 'app' && segment.isBrowser) {
    return false
  }

  if (segmentKind === 'browser' && !segment.isBrowser) {
    return false
  }

  if (!normalizedSearchQuery) {
    return true
  }

  return (precomputedSearchText ?? buildTimelineSearchText(segment, domain)).includes(
    normalizedSearchQuery,
  )
}

export function buildTimelineSearchText(segment: ChartSegment, domain: string | null) {
  return [segment.label, segment.key, segment.detail, domain]
    .map(normalizeTimelineSearchQuery)
    .join('\n')
}

export function normalizeTimelineSearchQuery(value: string | null | undefined) {
  return (value ?? '').trim().toLocaleLowerCase()
}

export function sortSegmentsByStart(segments: ChartSegment[]) {
  return [...segments].sort((left, right) => {
    if (left.startSec !== right.startSec) {
      return left.startSec - right.startSec
    }

    return right.durationSec - left.durationSec
  })
}
